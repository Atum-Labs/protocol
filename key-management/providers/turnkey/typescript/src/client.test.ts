import { describe, expect, it, vi } from 'vitest';

import { TurnkeyClient } from './client';
import type { TurnkeyClientOpts } from './client';
import type { Counter, Histogram, Meter } from './meter';

interface RecordedPoint {
  value: number;
  attributes: Record<string, unknown>;
}

// In-memory recording meter — captures every add()/record() by instrument name.
function makeRecordingMeter(): { meter: Meter; points: Map<string, RecordedPoint[]> } {
  const points = new Map<string, RecordedPoint[]>();
  const push = (name: string, value: number, attributes?: Record<string, unknown>): void => {
    const list = points.get(name) ?? [];
    list.push({ value, attributes: attributes ?? {} });
    points.set(name, list);
  };
  const meter: Meter = {
    createCounter(name): Counter {
      return { add: (value, attributes) => push(name, value, attributes) };
    },
    createHistogram(name): Histogram {
      return { record: (value, attributes) => push(name, value, attributes) };
    },
  };
  return { meter, points };
}

// Test fixture: matched P-256 keypair used for the stamper. Stamping uses real Web Crypto;
// only the HTTP layer is mocked.
const TEST_PRIV = '46a9d0f5ea716b8c0d1c1e9a396615404ab6879e517eb6d00c01363aafa4f080';
const TEST_PUB = '032b01510e9c021a628b035ca480b51a4bc174a5fc670364cdc09810ffa785991e';
const TEST_ORG = '88fb69b2-17b9-4e02-bf50-5e88be2c7797';

function makeClient(overrides: Partial<TurnkeyClientOpts> = {}): {
  client: TurnkeyClient;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const fetchMock = vi.fn();
  const opts: TurnkeyClientOpts = {
    organizationId: TEST_ORG,
    apiUrl: 'https://api.turnkey.test',
    apiPublicKey: TEST_PUB,
    apiPrivateKey: TEST_PRIV,
    concurrencyLimit: 10,
    requestTimeoutMs: 5000,
    fetchImpl: fetchMock as unknown as typeof fetch,
    ...overrides,
  };
  return { client: new TurnkeyClient(opts), fetchMock };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('TurnkeyClient.whoami', () => {
  it('attaches X-Stamp + content-type and posts the body JSON', async () => {
    const { client, fetchMock } = makeClient();
    fetchMock.mockResolvedValue(jsonResponse(200, { organizationId: TEST_ORG }));
    const r = await client.whoami();
    expect(r.organizationId).toBe(TEST_ORG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.turnkey.test/public/v1/query/whoami');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(typeof init.headers['X-Stamp']).toBe('string');
    expect(JSON.parse(init.body)).toEqual({ organizationId: TEST_ORG });
  });

  it('surfaces 401 as a terminal TURNKEY_AUTH error', async () => {
    const { client, fetchMock } = makeClient();
    fetchMock.mockResolvedValue(jsonResponse(401, { message: 'PUBLIC_KEY_NOT_FOUND' }));
    await expect(client.whoami()).rejects.toThrow(/TURNKEY_AUTH/);
  });
});

describe('TurnkeyClient retry/backoff', () => {
  it('retries on HTTP 429 honoring Retry-After header', async () => {
    const { client, fetchMock } = makeClient();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(429, { message: 'rate limited' }, { 'retry-after': '0.01' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { organizationId: TEST_ORG }));
    const r = await client.whoami();
    expect(r.organizationId).toBe(TEST_ORG);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on 5xx and eventually surfaces TURNKEY_NETWORK after backoff exhaustion', async () => {
    const { client, fetchMock } = makeClient();
    // mockImplementation gives each call a fresh Response; mockResolvedValue would reuse a
    // single response whose body can only be read once.
    fetchMock.mockImplementation(async () => jsonResponse(503, { message: 'down' }));
    await expect(client.whoami()).rejects.toThrow(/TURNKEY_NETWORK/);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

describe('TurnkeyClient.signRawPayload', () => {
  it('forwards the parameters and unwraps signRawPayloadResult', async () => {
    const { client, fetchMock } = makeClient();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        activity: {
          id: 'act_1',
          status: 'ACTIVITY_STATUS_COMPLETED',
          result: {
            signRawPayloadResult: { r: 'aabb', s: 'ccdd', v: '01' },
          },
        },
      }),
    );
    const out = await client.signRawPayload({
      signWith: '0xabc',
      payload: 'deadbeef',
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NO_OP',
    });
    expect(out).toEqual({ r: 'aabb', s: 'ccdd', v: '01' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.turnkey.test/public/v1/submit/sign_raw_payload');
    const body = JSON.parse(init.body);
    expect(body.type).toBe('ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2');
    expect(body.organizationId).toBe(TEST_ORG);
    expect(body.parameters).toEqual({
      signWith: '0xabc',
      payload: 'deadbeef',
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NO_OP',
    });
  });

  it('surfaces a failed activity as TURNKEY_ACTIVITY_FAILED', async () => {
    const { client, fetchMock } = makeClient();
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        activity: {
          id: 'act_x',
          status: 'ACTIVITY_STATUS_FAILED',
          failure: { code: 5, message: 'policy denied' },
        },
      }),
    );
    await expect(
      client.signRawPayload({
        signWith: '0xabc',
        payload: 'deadbeef',
        encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
        hashFunction: 'HASH_FUNCTION_NO_OP',
      }),
    ).rejects.toThrow(/TURNKEY_ACTIVITY_FAILED/);
  });
});

describe('TurnkeyClient concurrency semaphore', () => {
  it('caps in-flight requests at concurrencyLimit', async () => {
    const concurrent = { peak: 0, current: 0 };
    const { client, fetchMock } = makeClient({ concurrencyLimit: 2 });
    fetchMock.mockImplementation(async () => {
      concurrent.current++;
      concurrent.peak = Math.max(concurrent.peak, concurrent.current);
      await new Promise((r) => setTimeout(r, 20));
      concurrent.current--;
      return jsonResponse(200, { organizationId: TEST_ORG });
    });
    await Promise.all(Array.from({ length: 8 }, () => client.whoami()));
    expect(concurrent.peak).toBeLessThanOrEqual(2);
  });
});

const SIGN_INPUT = {
  signWith: '0x1111111111111111111111111111111111111111',
  payload: 'ab'.repeat(32),
  encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
  hashFunction: 'HASH_FUNCTION_NO_OP',
} as const;

describe('TurnkeyClient injectable metrics', () => {
  it('emits turnkey.retry_total + backoff_duration_ms on 429', async () => {
    const { meter, points } = makeRecordingMeter();
    const { client, fetchMock } = makeClient({ meter });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { message: 'rate limited' }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(200, { organizationId: TEST_ORG }));
    await client.whoami();

    const retries = points.get('turnkey.retry_total') ?? [];
    expect(retries).toHaveLength(1);
    expect(retries[0]!.value).toBe(1);
    expect(retries[0]!.attributes).toMatchObject({
      reason: 'http-429',
      path: '/public/v1/query/whoami',
    });

    const backoffs = points.get('turnkey.backoff_duration_ms') ?? [];
    expect(backoffs).toHaveLength(1);
    expect(backoffs[0]!.attributes).toMatchObject({ reason: 'http-429' });
  });

  it('emits turnkey.activity_pending_total once per async activity', async () => {
    const { meter, points } = makeRecordingMeter();
    const { client, fetchMock } = makeClient({ meter });
    // First call: submit returns PENDING. Polling call: returns COMPLETED.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          activity: { id: 'a1', status: 'ACTIVITY_STATUS_PENDING' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          activity: {
            id: 'a1',
            status: 'ACTIVITY_STATUS_COMPLETED',
            result: { signRawPayloadResult: { r: '0x00', s: '0x00', v: '00' } },
          },
        }),
      );
    await client.signRawPayload({
      signWith: '0x1111111111111111111111111111111111111111',
      payload: 'ab'.repeat(32),
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NO_OP',
    });

    const pending = points.get('turnkey.activity_pending_total') ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.value).toBe(1);
    expect(pending[0]!.attributes).toMatchObject({
      activity_type: 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2',
    });

    // One timing per submitActivity call, spanning the poll loop rather than per poll.
    const durations = points.get('turnkey.sign_duration_ms') ?? [];
    expect(durations).toHaveLength(1);
    expect(durations[0]!.attributes).toMatchObject({
      activity_type: 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2',
      outcome: 'success',
    });
  });

  it('emits turnkey.sign_duration_ms with outcome=success on a synchronous COMPLETED activity', async () => {
    const { meter, points } = makeRecordingMeter();
    const { client, fetchMock } = makeClient({ meter });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        activity: {
          id: 'a_sync',
          status: 'ACTIVITY_STATUS_COMPLETED',
          result: { signRawPayloadResult: { r: '0x00', s: '0x00', v: '00' } },
        },
      }),
    );
    await client.signRawPayload(SIGN_INPUT);

    const durations = points.get('turnkey.sign_duration_ms') ?? [];
    expect(durations).toHaveLength(1);
    expect(durations[0]!.attributes).toMatchObject({
      activity_type: 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2',
      outcome: 'success',
    });
    // The sync path must not report an async poll.
    expect(points.get('turnkey.activity_pending_total') ?? []).toHaveLength(0);
  });

  it('emits turnkey.sign_duration_ms with outcome=error when the activity fails', async () => {
    const { meter, points } = makeRecordingMeter();
    const { client, fetchMock } = makeClient({ meter });
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        activity: {
          id: 'a_fail',
          status: 'ACTIVITY_STATUS_FAILED',
          failure: { message: 'denied' },
        },
      }),
    );
    await expect(client.signRawPayload(SIGN_INPUT)).rejects.toThrow(/TURNKEY_ACTIVITY_FAILED/);

    const durations = points.get('turnkey.sign_duration_ms') ?? [];
    expect(durations).toHaveLength(1);
    expect(durations[0]!.attributes).toMatchObject({
      activity_type: 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2',
      outcome: 'error',
    });
  });
});
