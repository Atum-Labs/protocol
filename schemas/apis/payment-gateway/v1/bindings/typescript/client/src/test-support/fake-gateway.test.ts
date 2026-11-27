import { readFileSync } from 'fs';
import { join } from 'path';
import {
  startFakeGateway,
  contractValidator,
  ROUTES,
  CONTRACT_SCHEMA_NAMES,
  type FakeGateway,
} from './fake-gateway';

/**
 * The fake gateway is a guard, and a guard that has only ever been seen to pass has not been
 * verified. These cases confirm it refuses the things it exists to refuse, and that its route table
 * still describes the contract the generated client was built from.
 */
describe('fake gateway', () => {
  let gateway: FakeGateway;

  afterEach(async () => {
    await gateway?.close();
  });

  async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${gateway.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('serves a contract-valid response on the happy path', async () => {
    gateway = await startFakeGateway();
    const res = await fetch(`${gateway.url}/v1/defaults?chain_id=eip155:42161`);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ chain_id: 'eip155:42161' });
    expect(gateway.received('GET', '/v1/defaults')).toHaveLength(1);
  });

  it('refuses a request body the contract does not allow, and says which field', async () => {
    // The whole point: a command that drifts from the spec is stopped here. One required field is
    // removed from an otherwise valid request, rather than sending an empty object, so the reported
    // violation can only be about that field — which is what makes this an assertion about naming
    // the problem rather than about rejecting obvious rubbish.
    gateway = await startFakeGateway();
    const { request_id: _omitted, ...missingRequestId } = validPaymentRequest();

    const { status, body } = await post('/v1/payments', missingRequestId);

    expect(status).toBe(400);
    expect(body.message).toContain('off-contract request body');
    expect(body.message).toContain('request_id');
    expect(gateway.received('POST', '/v1/payments')[0].violation).toContain('PaymentRequest');
  });

  it('refuses a body that is not JSON at all', async () => {
    gateway = await startFakeGateway();
    const res = await fetch(`${gateway.url}/v1/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    expect(res.status).toBe(400);
    expect(gateway.requests[0].violation).toBe('body is not valid JSON');
  });

  it('refuses to serve a response the contract does not allow', async () => {
    // A canned response is as capable of drifting from the spec as a command is. PaymentResponse
    // requires payment_id, status and idempotent_replay.
    gateway = await startFakeGateway({
      responders: { 'POST /v1/payments': () => ({ body: { nope: true } }) },
    });

    const res = await fetch(`${gateway.url}/v1/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validPaymentRequest()),
    });

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({ code: 'FAKE_GATEWAY_INVALID_RESPONSE' });
    expect(gateway.requests[0].violation).toContain('PaymentResponse');
  });

  it('serves an off-contract response only when a case asks for it', async () => {
    gateway = await startFakeGateway({
      allowInvalidResponses: true,
      responders: { 'POST /v1/payments': () => ({ body: { nope: true } }) },
    });

    const { status, body } = await post('/v1/payments', validPaymentRequest());

    expect(status).toBe(200);
    expect(body).toEqual({ nope: true });
  });

  it('404s a path that is not a contract operation, rather than pretending to serve it', async () => {
    gateway = await startFakeGateway();
    const res = await fetch(`${gateway.url}/v1/not-a-real-operation`);

    expect(res.status).toBe(404);
    expect(gateway.requests[0].route).toBeUndefined();
  });

  it('matches templated paths by segment', async () => {
    gateway = await startFakeGateway();
    await fetch(`${gateway.url}/v1/payments/0xabc/status`);

    expect(gateway.received('GET', '/v1/payments/{paymentId}/status')).toHaveLength(1);
  });
});

describe('fake gateway route table', () => {
  /**
   * The generated client is emitted from the same spec and is diff-guarded in CI, so it is the
   * cheapest available statement of what the contract's paths are. Comparing against its source
   * text rather than importing it keeps this from depending on the client's internals.
   */
  const generated = readFileSync(join(__dirname, '..', 'generated', 'services.gen.ts'), 'utf8');
  const operations = [...generated.matchAll(/method: '(\w+)',\s*\n\s*url: '([^']+)'/g)].map(
    ([, method, url]) => `${method} ${url}`,
  );

  it('reads the operations out of the generated client', () => {
    // Guards the regex above: a change to the generator's output shape would otherwise leave this
    // matching nothing and the comparison below vacuously true.
    expect(operations.length).toBeGreaterThan(5);
  });

  it.each(ROUTES.map((r) => `${r.method} ${r.path}`))(
    '%s is still an operation the contract publishes',
    (operation) => {
      expect(operations).toContain(operation);
    },
  );

  it.each(
    ROUTES.flatMap((r) => [r.requestSchema, r.responseSchema].filter((n): n is string => !!n)),
  )('%s is still a schema the contract publishes', (schema) => {
    expect(CONTRACT_SCHEMA_NAMES).toContain(schema);
    expect(() => contractValidator(schema)).not.toThrow();
  });

  it('names a missing schema clearly rather than failing obscurely later', () => {
    expect(() => contractValidator('SchemaThatWasRenamed')).toThrow(
      /has no schema named "SchemaThatWasRenamed"/,
    );
  });
});

/** The minimum PaymentRequest the contract accepts. Built from the schema's own required list. */
function validPaymentRequest() {
  return {
    version: '1.0',
    request_id: 'req-1',
    source: {
      asset_identifier: 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      account: '0xF0D0',
    },
    destination: [
      {
        asset_identifier: 'eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
        account: '0xRecv',
      },
    ],
    fulfillment_amount: '100000',
    quote_deadline: '2030-01-01T00:00:00Z',
    fulfillment_deadline: '2030-01-01T01:00:00Z',
    escrow_contract_address: '0xEscrow',
    quote_selector: '0xSelector',
    fulfillment_verifier: { account: '0xVerifier', endpoint: 'https://veri-fill.test' },
    fulfillment_proxy: '0xProxy',
    sender_auth: {
      message_scheme: 'EVM_PERMIT2',
      signed_messages: [{ message: '0xmsg', signature: '0xsig' }],
    },
  };
}
