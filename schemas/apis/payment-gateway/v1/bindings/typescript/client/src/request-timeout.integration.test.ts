import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import type { Socket } from 'net';
import type { AxiosRequestConfig } from 'axios';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SYNC_WAIT_TIMEOUT_MS,
  GatewayTimeoutError,
  Interceptors,
  PaymentGatewayClient,
  isGatewayTimeoutError,
  type OpenAPIConfig,
} from './index';

/** Runs a client's assembled interceptor chain, the only way to read a budget without waiting for it. */
async function budgetFor(
  client: PaymentGatewayClient,
  config: AxiosRequestConfig,
): Promise<number | undefined> {
  const { interceptors } = (client.request as unknown as { config: OpenAPIConfig }).config;
  let resolved = config;
  for (const fn of interceptors.request._fns) resolved = await fn(resolved);
  return resolved.timeout;
}

describe('an unresponsive gateway', () => {
  let server: Server;
  let baseUrl: string;
  const sockets = new Set<Socket>();

  beforeAll((done) => {
    // Accept, hold, never reply.
    server = createServer(() => {});
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  afterAll((done) => {
    for (const socket of sockets) socket.destroy();
    server.close(done);
  });

  it('fails the chain-defaults fetch instead of hanging', async () => {
    const client = new PaymentGatewayClient({ BASE: baseUrl, timeoutMs: 150 });

    await expect(client.fetchChainDefaults('eip155:42161')).rejects.toThrow(GatewayTimeoutError);
  });

  it('fails a service call with the same clear error', async () => {
    const client = new PaymentGatewayClient({ BASE: baseUrl, timeoutMs: 150 });

    const error = await client.payments.getPaymentStatus({ paymentId: '0xabc' }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(isGatewayTimeoutError(error)).toBe(true);
    expect((error as Error).message).toMatch(/did not respond within/);
  });

  it('reports the gateway it actually tried', async () => {
    const client = new PaymentGatewayClient({ BASE: baseUrl, timeoutMs: 150 });

    await expect(client.fetchChainDefaults('eip155:42161')).rejects.toThrow(baseUrl);
  });

  it('settles in bounded wall-clock time rather than hanging', async () => {
    const client = new PaymentGatewayClient({ BASE: baseUrl, timeoutMs: 150 });
    const hung = Symbol('hung');
    let timer: NodeJS.Timeout;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve(hung), 3_000);
    });

    const outcome = await Promise.race([
      client.fetchChainDefaults('eip155:42161').catch((e) => e),
      deadline,
    ]);
    clearTimeout(timer!);

    expect(outcome).toBeInstanceOf(GatewayTimeoutError);
  });

  // Asserted on the socket, not the rejection: the wrapper rejects on cancel
  // either way, so only the closed connection proves it reached the real request.
  it('cancelling a request closes its connection', async () => {
    const client = new PaymentGatewayClient({ BASE: baseUrl, timeoutMs: 10_000 });

    const pending = client.payments.getPaymentStatus({ paymentId: '0xabc' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const open = sockets.size;
    pending.cancel();
    await pending.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(open).toBeGreaterThan(0);
    expect(sockets.size).toBe(open - 1);
  });

  // The regression that would break payments: the gateway holds these open on
  // purpose, so they have to outlive the ordinary budget.
  it.each([
    [
      'POST /v1/payments',
      (c: PaymentGatewayClient) => c.payments.submitPayment({ requestBody: {} as never }),
    ],
    [
      'quote-requests?wait=true',
      (c: PaymentGatewayClient) =>
        c.quoteRequests.createQuoteRequest({ wait: true, requestBody: {} as never }),
    ],
  ])(
    '%s outlives the ordinary budget and ends on the long-poll one',
    async (_name, call) => {
      const client = new PaymentGatewayClient({
        BASE: baseUrl,
        timeoutMs: 100,
        syncWaitTimeoutMs: 900,
      });
      const started = Date.now();

      await expect(call(client)).rejects.toThrow(GatewayTimeoutError);

      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    },
    10_000,
  );
});

describe('a responsive gateway', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll((done) => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        req.url?.startsWith('/v1/defaults')
          ? JSON.stringify({
              // chain_id is what distinguishes the single-chain answer from the keyed
              // map, so a stub without it is not a response the gateway can produce.
              chain_id: 'eip155:42161',
              escrow_contract: '0x01',
              fulfillment_proxy: '0x02',
              quote_selector: '0x03',
              fulfillment_verifier: { account: '0x04', endpoint: 'https://verifier.example' },
            })
          : JSON.stringify({ payment_id: '0xabc', status: 'completed' }),
      );
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  it('still resolves the chain-defaults fetch', async () => {
    const client = new PaymentGatewayClient({ BASE: baseUrl, timeoutMs: 2_000 });

    await expect(client.fetchChainDefaults('eip155:42161')).resolves.toMatchObject({
      escrowContract: '0x01',
    });
  });

  it('still resolves a service call through the timeout transport', async () => {
    const client = new PaymentGatewayClient({ BASE: baseUrl, timeoutMs: 2_000 });

    await expect(client.payments.getPaymentStatus({ paymentId: '0xabc' })).resolves.toMatchObject({
      payment_id: '0xabc',
    });
  });
});

describe('a gateway that answers a chain-defaults failure and then stalls its body', () => {
  let server: Server;
  let baseUrl: string;
  const sockets = new Set<Socket>();

  beforeAll((done) => {
    // Status and headers arrive, so `fetch` resolves. The typed error body never does, which is
    // what the message is read from.
    server = createServer((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.write('{"code":"INVALID_REQUEST"');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  afterAll((done) => {
    for (const socket of sockets) socket.destroy();
    server.close(done);
  });

  it('times out rather than waiting on the error body', async () => {
    const client = new PaymentGatewayClient({ BASE: baseUrl, timeoutMs: 150 });

    await expect(client.fetchChainDefaults('eip155:42161')).rejects.toThrow(GatewayTimeoutError);
  });
});

describe('the assembled interceptor chain', () => {
  it('applies the default budgets when the caller sets none', async () => {
    const client = new PaymentGatewayClient({ BASE: 'https://gw.example' });

    await expect(
      budgetFor(client, { method: 'GET', url: 'https://gw.example/v1/health' }),
    ).resolves.toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    await expect(
      budgetFor(client, { method: 'POST', url: 'https://gw.example/v1/payments' }),
    ).resolves.toBe(DEFAULT_SYNC_WAIT_TIMEOUT_MS);
  });

  it('keeps a caller-supplied interceptor, lets its timeout win, and does not register on it', async () => {
    const seen: string[] = [];
    const request = new Interceptors<AxiosRequestConfig>();
    request.use((config) => {
      seen.push('caller');
      return { ...config, timeout: 7 };
    });
    const client = new PaymentGatewayClient({
      BASE: 'https://gw.example',
      interceptors: { request, response: new Interceptors() },
    });

    await expect(
      budgetFor(client, { method: 'GET', url: 'https://gw.example/v1/health' }),
    ).resolves.toBe(7);
    expect(seen).toEqual(['caller']);
    expect(request._fns).toHaveLength(1);
  });
});
