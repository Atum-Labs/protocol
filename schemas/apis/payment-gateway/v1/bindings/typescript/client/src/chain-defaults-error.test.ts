import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { PaymentGatewayClient, getErrorResponse, isApiError } from './index';

// The gateway answers a bad chain id with a typed error body. The HTTP status text reduces every
// cause to "Bad Request", so what the caller is told has to come from the body.
//
// A real loopback server rather than a `globalThis.fetch` stub: /v1/defaults goes through the
// generated axios transport, which never touches `fetch`. This is also the more faithful test —
// the body crosses the wire and is parsed by the generated client, so what is asserted is what a
// caller actually sees, including the status text the transport reads off the response.
let next: { status: number; body: string; contentType: string };

describe('fetchChainDefaults failure reporting', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll((done) => {
    server = createServer((_req, res) => {
      res.writeHead(next.status, { 'content-type': next.contentType });
      res.end(next.body);
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  /** Arms the next response and returns a client pointed at it. */
  function respondWith(
    status: number,
    body: unknown,
    contentType = 'application/json',
  ): PaymentGatewayClient {
    next = {
      status,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      contentType,
    };
    return new PaymentGatewayClient({ BASE: baseUrl, timeoutMs: 5_000 });
  }

  it("reports the gateway's code, message and request id rather than the status text", async () => {
    // What /v1/defaults answers for a chain it does not serve, as the error catalog renders it.
    const client = respondWith(404, {
      code: 'NOT_FOUND',
      message: 'The requested resource was not found.',
      request_id: 'req_123',
    });

    const error = await client.fetchChainDefaults('eip155:99').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'Failed to fetch defaults for chain eip155:99: NOT_FOUND: The requested resource was not found. (request_id=req_123)',
    );
  });

  it('reports the code alone when the body carries no message', async () => {
    const client = respondWith(400, { code: 'INVALID_REQUEST' });

    await expect(client.fetchChainDefaults('eip155:99')).rejects.toThrow(
      'Failed to fetch defaults for chain eip155:99: INVALID_REQUEST',
    );
  });

  it('reports the message alone when the body carries no code', async () => {
    const client = respondWith(503, { message: 'The service is temporarily busy.' });

    await expect(client.fetchChainDefaults('eip155:42161')).rejects.toThrow(
      'Failed to fetch defaults for chain eip155:42161: The service is temporarily busy.',
    );
  });

  it('falls back to the status when the body is not the typed error shape', async () => {
    // A proxy's HTML error page, which must not be pasted into the message.
    const client = respondWith(502, '<html><body>502 Bad Gateway</body></html>', 'text/html');

    const error = await client.fetchChainDefaults('eip155:42161').catch((e: Error) => e);
    expect((error as Error).message).toBe(
      'Failed to fetch defaults for chain eip155:42161: Bad Gateway',
    );
    // The proxy's markup must not reach the caller.
    expect((error as Error).message).not.toContain('<html>');
  });

  // The original error stays reachable through `cause`, so a caller can read the gateway's
  // public code and decide whether to retry: 503 is transient, 404 never is. Flattening it
  // to a string would leave them regex-matching a message.
  it('keeps the gateway error reachable through cause', async () => {
    const client = respondWith(503, {
      code: 'SERVICE_BUSY',
      message: 'The service is temporarily busy.',
    });

    const error = await client.fetchChainDefaults('eip155:42161').catch((e: Error) => e);
    expect(isApiError((error as Error).cause)).toBe(true);
    expect(getErrorResponse((error as Error).cause)?.code).toBe('SERVICE_BUSY');
  });

  // A base URL pointing somewhere other than the gateway answers 200 with markup. Reporting
  // that as the keyed-map case sent the reader looking in the wrong place entirely.
  it('names a non-JSON 200 rather than blaming the response shape', async () => {
    const client = respondWith(200, '<html><body>hello</body></html>', 'text/html');

    await expect(client.fetchChainDefaults('eip155:42161')).rejects.toThrow(
      'the gateway did not return a JSON object',
    );
  });

  // A literal null body used to throw a TypeError out of the SDK.
  it('names a null body rather than throwing a TypeError', async () => {
    const client = respondWith(200, null);

    const error = await client.fetchChainDefaults('eip155:42161').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).not.toBe('TypeError');
    expect((error as Error).message).toContain('the gateway did not return a JSON object');
  });

  // Every address in this response is signed into a deposit authorization, so defaults for
  // the wrong chain would produce a valid signature authorizing the wrong thing.
  it('refuses defaults for a chain other than the one requested', async () => {
    const client = respondWith(200, {
      chain_id: 'eip155:1',
      quote_selector: '0xq',
      escrow_contract: '0xe',
      fulfillment_proxy: '0xp',
      fulfillment_verifier: { account: '0xa', endpoint: 'https://v.example' },
    });

    await expect(client.fetchChainDefaults('eip155:42161')).rejects.toThrow(
      'Failed to fetch defaults for chain eip155:42161: the gateway answered with defaults for eip155:1',
    );
  });

  // An empty chain id reaches the gateway as `?chain_id=`, which means "every chain" — so the
  // caller would be told the gateway ignored the parameter, rather than that they passed none.
  it("names an empty chain id as the caller's mistake", async () => {
    const client = respondWith(200, {});

    await expect(client.fetchChainDefaults('')).rejects.toThrow(
      'fetchChainDefaults requires a CAIP-2 chain id',
    );
  });

  it('attaches no defaults listing to the error', async () => {
    const client = respondWith(400, { code: 'X', message: 'nope' });

    const error = await client.fetchChainDefaults('eip155:99').catch((e) => e);
    expect((error as Record<string, unknown>).availableDefaults).toBeUndefined();
  });

  // A 200 carrying the keyed map means the gateway ignored `chain_id`. The SDK always sends it,
  // so guessing which entry was meant would be inventing a corridor; it is reported instead.
  it('refuses a keyed map when one chain was requested', async () => {
    const client = respondWith(200, {
      'eip155:42161': { chain_id: 'eip155:42161', escrow_contract: '0x01' },
    });

    await expect(client.fetchChainDefaults('eip155:42161')).rejects.toThrow(
      'the gateway answered with defaults for every chain rather than the one requested',
    );
  });
});

// Replaces the coverage lost when the bespoke fetch helper was removed: that had a
// "rethrows a non-timeout failure unchanged" case, and the behaviour here genuinely
// changed — a transport failure is now wrapped, so `cause` is what carries the original
// code and stack. Untested, that would drift again silently.
describe('fetchChainDefaults transport failures', () => {
  let deadUrl: string;

  beforeAll(async () => {
    // Bind a port, learn it, then release it — so nothing is listening on a port we know.
    const { createServer } = await import('http');
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as { port: number };
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    deadUrl = `http://127.0.0.1:${port}`;
  });

  it('names the chain and keeps the underlying network error as cause', async () => {
    const client = new PaymentGatewayClient({ BASE: deadUrl, timeoutMs: 5_000 });

    const error = await client.fetchChainDefaults('eip155:8453').catch((e: Error) => e);
    expect((error as Error).message).toContain('Failed to fetch defaults for chain eip155:8453');
    // Not an ApiError — there was no response — so callers fall through to the original,
    // which still carries its own code.
    expect((error as Error).cause).toBeDefined();
    expect(String(((error as Error).cause as { code?: string })?.code ?? '')).toMatch(
      /ECONNREFUSED|ECONNRESET/,
    );
  });
});
