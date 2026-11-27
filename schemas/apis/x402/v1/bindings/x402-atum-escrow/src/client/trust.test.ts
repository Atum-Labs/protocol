/**
 * The gateway-backed trust source: which escrow, reserver, releaser and fulfillment proxy the
 * operator behind the configured gateways runs on a chain. Atum's production gateways are only the
 * default; a payer may point the resolver at any operator it trusts.
 *
 * A 402 is unauthenticated input from the merchant, so the role addresses it names cannot vouch
 * for themselves. The resolver asks the trusted operator's gateways what they run on the chain
 * instead,
 * and the client compares the 402 against that answer before signing anything.
 *
 * The outcomes are deliberately three-way rather than pass/fail:
 *   - a usable answer from any gateway is trusted, since an operator's gateways may each serve
 *     only their own chains (the default mainnet and testnet gateways do) and the others 404;
 *   - every gateway answering 404 is an authoritative "this operator does not serve the chain";
 *   - anything else is "could not find out", which must never be reported as the authoritative
 *     refusal — an outage would otherwise read to the payer as a merchant on an unsupported chain.
 *
 * `fetch` and the clock are injected so every case is deterministic and offline.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  atumGatewayTrust,
  AtumEscrowTrustError,
  ATUM_DEFAULT_TRUST_GATEWAYS,
  type TrustedRoles,
} from './index';
import {
  paymentGatewayMainnet as MAINNET_GW,
  paymentGatewayTestnet as TESTNET_GW,
} from '../hosts.generated';

const BASE = 'eip155:8453';
const ARBITRUM = 'eip155:42161';

/** The gateway's `/v1/defaults` answer for Base, extra fields included as the live API sends. */
const baseDefaults = {
  chain_id: BASE,
  quote_selector: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  escrow_contract: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
  fulfillment_proxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  fulfillment_verifier: {
    account: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    endpoint: 'https://veri-fill.production-mainnet.atum.xyz',
  },
  tokens: [
    { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  ],
  unrelated_future_field: { anything: true },
};

const baseRoles: TrustedRoles = {
  escrowContract: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
  quoteSelector: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  fulfillmentVerifierAccount: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  tokens: [
    { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  ],
};

const arbitrumDefaults = {
  chain_id: ARBITRUM,
  quote_selector: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  escrow_contract: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  fulfillment_proxy: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  fulfillment_verifier: {
    account: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
    endpoint: 'https://veri-fill.production-mainnet.atum.xyz',
  },
  tokens: [],
};

const arbitrumRoles: TrustedRoles = {
  escrowContract: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  quoteSelector: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  fulfillmentVerifierAccount: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
  fulfillmentProxy: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  tokens: [],
};

/** The exact URL the resolver must ask a gateway for one network's defaults. */
const defaultsUrl = (gateway: string, network: string): string =>
  `${gateway}/v1/defaults?chain_id=${encodeURIComponent(network)}`;

type Reply = Response | Error | 'hang';
type Router = (gateway: string, network: string) => Reply | Promise<Reply>;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const notFound = (): Response => new Response('not found', { status: 404 });
const unavailable = (): Response => new Response('upstream down', { status: 503 });

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * A fake `fetch` that routes on (gateway, chain_id) and records every request. A `'hang'` reply
 * never answers on its own but honours the request's AbortSignal, so a resolver that aborts on
 * timeout and one that races a timer are both exercised.
 */
function fakeFetch(route: Router) {
  const requests: { url: string; method: string }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    requests.push({ url, method: (init?.method ?? 'GET').toUpperCase() });
    const parsed = new URL(url);
    const gateway = parsed.origin;
    const network = parsed.searchParams.get('chain_id') ?? '';
    const reply = await route(gateway, network);
    if (reply === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    }
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { fetch: fn as unknown as typeof fetch, requests, spy: fn };
}

/** Mainnet serves Base and Arbitrum; testnet serves neither — the ordinary production split. */
const mainnetServes: Router = (gateway, network) => {
  if (gateway !== MAINNET_GW) return notFound();
  if (network === BASE) return json(baseDefaults);
  if (network === ARBITRUM) return json(arbitrumDefaults);
  return notFound();
};

/** Await a rejection and hand back the error, failing the test if the promise resolved. */
async function trustFailure(p: Promise<unknown>): Promise<AtumEscrowTrustError> {
  const err = await p.then(
    (value) => {
      throw new Error(`expected a trust failure, resolved with ${JSON.stringify(value)}`);
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AtumEscrowTrustError);
  expect(err).toBeInstanceOf(Error);
  return err as AtumEscrowTrustError;
}

const fixedNow = () => 1_000_000;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ATUM_DEFAULT_TRUST_GATEWAYS', () => {
  it('is exactly the production mainnet and testnet payment gateways', () => {
    expect(ATUM_DEFAULT_TRUST_GATEWAYS).toEqual([MAINNET_GW, TESTNET_GW]);
  });
});

describe('atumGatewayTrust — the request', () => {
  it('asks every default gateway for the network with a GET to /v1/defaults', async () => {
    const { fetch, requests } = fakeFetch((gateway, network) =>
      gateway === TESTNET_GW && network === BASE ? json(baseDefaults) : notFound(),
    );
    await atumGatewayTrust({ fetch, now: fixedNow })(BASE);

    expect(requests.map((r) => r.url).sort()).toEqual(
      [defaultsUrl(MAINNET_GW, BASE), defaultsUrl(TESTNET_GW, BASE)].sort(),
    );
    expect(requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('URL-encodes the CAIP-2 id into chain_id', async () => {
    // The colon in a CAIP-2 id is reserved in a query string; it must reach the gateway encoded.
    const { fetch, requests } = fakeFetch(() => notFound());
    await trustFailure(atumGatewayTrust({ fetch, now: fixedNow })(BASE));
    expect(requests.map((r) => r.url)).toContain(
      `${MAINNET_GW}/v1/defaults?chain_id=eip155%3A8453`,
    );
  });

  it('asks only the configured gateways when they are overridden', async () => {
    const custom = 'https://gw.example.test';
    const { fetch, requests } = fakeFetch(() => json(baseDefaults));
    await atumGatewayTrust({ gateways: [custom], fetch, now: fixedNow })(BASE);
    expect(requests.map((r) => r.url)).toEqual([defaultsUrl(custom, BASE)]);
  });

  for (const [label, suffix] of [
    ['one trailing slash', '/'],
    ['several trailing slashes', '//'],
  ] as const) {
    it(`strips ${label} from a configured gateway before building the URL`, async () => {
      // The fake routes by origin, which ignores the path, so only the recorded URL shows a
      // doubled slash; a gateway or proxy that does not collapse it can answer 404 for every
      // chain and turn a supported chain into an authoritative refusal.
      const { fetch, requests } = fakeFetch(mainnetServes);
      const resolve = atumGatewayTrust({
        gateways: [`${MAINNET_GW}${suffix}`],
        fetch,
        now: fixedNow,
      });
      await expect(resolve(BASE)).resolves.toEqual(baseRoles);
      expect(requests.map((r) => r.url)).toEqual([defaultsUrl(MAINNET_GW, BASE)]);
    });
  }

  it('uses the global fetch when none is injected', async () => {
    const { fetch, requests } = fakeFetch(mainnetServes);
    vi.stubGlobal('fetch', fetch);
    await expect(atumGatewayTrust({ now: fixedNow })(BASE)).resolves.toEqual(baseRoles);
    expect(requests.map((r) => r.url)).toContain(defaultsUrl(MAINNET_GW, BASE));
  });
});

describe('atumGatewayTrust — a trusted answer', () => {
  it('maps a mainnet 200 (testnet 404) onto the trusted roles, ignoring extra fields', async () => {
    const { fetch } = fakeFetch(mainnetServes);
    await expect(atumGatewayTrust({ fetch, now: fixedNow })(BASE)).resolves.toEqual(baseRoles);
  });

  it('trusts a testnet 200 when mainnet answers 404', async () => {
    const { fetch } = fakeFetch((gateway, network) =>
      gateway === TESTNET_GW && network === ARBITRUM ? json(arbitrumDefaults) : notFound(),
    );
    await expect(atumGatewayTrust({ fetch, now: fixedNow })(ARBITRUM)).resolves.toEqual(
      arbitrumRoles,
    );
  });

  it('trusts a usable 200 even when the other gateway is failing', async () => {
    // One gateway being down must not block a chain the other one vouches for.
    const { fetch } = fakeFetch((gateway) =>
      gateway === MAINNET_GW ? json(baseDefaults) : unavailable(),
    );
    await expect(atumGatewayTrust({ fetch, now: fixedNow })(BASE)).resolves.toEqual(baseRoles);
  });

  it('trusts a usable 200 when the other gateway answered 200 for a different chain', async () => {
    const { fetch } = fakeFetch((gateway) =>
      gateway === MAINNET_GW ? json({ ...baseDefaults, chain_id: ARBITRUM }) : json(baseDefaults),
    );
    await expect(atumGatewayTrust({ fetch, now: fixedNow })(BASE)).resolves.toEqual(baseRoles);
  });
});

describe('atumGatewayTrust — vouched tokens', () => {
  it("passes a 200 body's tokens through exactly", async () => {
    // The tokens are what the payer's markup bound prices against, so symbol, address and
    // decimals must arrive untouched: a dropped or altered decimals value mis-scales the bound by
    // orders of magnitude.
    const { fetch } = fakeFetch(mainnetServes);
    const roles = await atumGatewayTrust({ fetch, now: fixedNow })(BASE);
    expect(roles.tokens).toEqual(baseDefaults.tokens);
  });

  it('resolves with no tokens, still trusted, when the body carries no tokens field', async () => {
    // An operator that lists no tokens has still vouched for its role addresses; the absence is
    // handled where tokens are needed, not by declaring the trust source unavailable.
    const withoutTokens: Record<string, unknown> = { ...baseDefaults };
    delete withoutTokens.tokens;
    const { fetch } = fakeFetch((gateway) =>
      gateway === MAINNET_GW ? json(withoutTokens) : notFound(),
    );
    await expect(atumGatewayTrust({ fetch, now: fixedNow })(BASE)).resolves.toEqual({
      ...baseRoles,
      tokens: [],
    });
  });
});

describe('atumGatewayTrust — the escrow message scheme', () => {
  const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  const ESCROW = baseDefaults.escrow_contract;
  const on = (network: string, entries: unknown) => ({
    ...baseDefaults,
    chain_id: network,
    escrows: entries,
  });
  const answer = (body: unknown) =>
    fakeFetch((gateway) => (gateway === MAINNET_GW ? json(body) : notFound())).fetch;
  const resolve = (network: string, body: unknown) =>
    atumGatewayTrust({ fetch: answer(body), now: fixedNow })(network);

  it('carries the svm_message of the escrows entry for the trusted escrow on Solana', async () => {
    const body = on(SOLANA, [
      { escrow_contract: 'OtherEscrow', svm_message: '' },
      { escrow_contract: ESCROW, svm_message: 'escrow-text-v1' },
    ]);
    await expect(resolve(SOLANA, body)).resolves.toEqual({
      ...baseRoles,
      svmMessageScheme: 'escrow-text-v1',
    });
  });

  it('carries no scheme when escrows is absent, names another escrow, or omits svm_message', async () => {
    const withoutEscrows: Record<string, unknown> = { ...baseDefaults, chain_id: SOLANA };
    for (const body of [
      withoutEscrows,
      on(SOLANA, [{ escrow_contract: 'OtherEscrow', svm_message: 'escrow-text-v1' }]),
      on(SOLANA, [{ escrow_contract: ESCROW }]),
    ]) {
      await expect(resolve(SOLANA, body)).resolves.toEqual(baseRoles);
    }
  });

  for (const [label, entries] of [
    ['escrows is an object', { a: 1 }],
    ['an entry is null', [null]],
    ['svm_message is a number', [{ escrow_contract: ESCROW, svm_message: 5 }]],
    ['escrow_contract is missing', [{ svm_message: '' }]],
    [
      'a malformed entry follows the match',
      [{ escrow_contract: ESCROW, svm_message: '' }, { escrow_contract: 7 }],
    ],
  ] as Array<[string, unknown]>) {
    it(`rejects TRUST_SOURCE_UNAVAILABLE on Solana when ${label}`, async () => {
      const err = await trustFailure(resolve(SOLANA, on(SOLANA, entries)));
      expect(err.code).toBe('TRUST_SOURCE_UNAVAILABLE');
    });
  }

  it('ignores escrows on a non Solana network, malformed or not', async () => {
    await expect(resolve(BASE, on(BASE, [null]))).resolves.toEqual(baseRoles);
    await expect(
      resolve(BASE, on(BASE, [{ escrow_contract: ESCROW, svm_message: 'escrow-text-v1' }])),
    ).resolves.toEqual(baseRoles);
  });
});

describe('atumGatewayTrust — an authoritative refusal', () => {
  it('rejects CHAIN_NOT_TRUSTED when every gateway answers 404', async () => {
    const { fetch } = fakeFetch(() => notFound());
    const err = await trustFailure(atumGatewayTrust({ fetch, now: fixedNow })('eip155:999999'));
    expect(err.code).toBe('CHAIN_NOT_TRUSTED');
    expect(err.network).toBe('eip155:999999');
  });

  it('rejects CHAIN_NOT_TRUSTED without any request when no gateway is configured', async () => {
    // An empty gateway list is a payer that trusts no operator at all: there is nobody to ask,
    // so the answer is an authoritative refusal rather than an outage.
    const { fetch, spy } = fakeFetch(mainnetServes);
    const err = await trustFailure(atumGatewayTrust({ gateways: [], fetch, now: fixedNow })(BASE));
    expect(err.code).toBe('CHAIN_NOT_TRUSTED');
    expect(err.network).toBe(BASE);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('atumGatewayTrust — malformed tokens', () => {
  // The tokens' decimals scale the payer's markup bound, so an entry that cannot be trusted to
  // price correctly makes the whole answer unusable rather than silently dropping the entry.
  const usdc = {
    symbol: 'USDC',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
  };
  const malformed: Array<[string, unknown]> = [
    ['tokens is an object', { usdc }],
    ['tokens is a string', 'USDC'],
    ['an entry is null', [usdc, null]],
    ['an entry has an empty symbol', [{ ...usdc, symbol: '' }]],
    ['an entry has an empty address', [{ ...usdc, address: '' }]],
    ['an entry has no decimals', [{ symbol: usdc.symbol, address: usdc.address }]],
    ['an entry has fractional decimals', [{ ...usdc, decimals: 6.5 }]],
    ['an entry has negative decimals', [{ ...usdc, decimals: -1 }]],
    ['an entry has string decimals', [{ ...usdc, decimals: '6' }]],
    ['an entry has decimals above 77', [{ ...usdc, decimals: 78 }]],
  ];

  for (const [label, tokens] of malformed) {
    it(`rejects TRUST_SOURCE_UNAVAILABLE when ${label}`, async () => {
      const { fetch } = fakeFetch((gateway) =>
        gateway === MAINNET_GW ? json({ ...baseDefaults, tokens }) : notFound(),
      );
      const err = await trustFailure(atumGatewayTrust({ fetch, now: fixedNow })(BASE));
      expect(err.code).toBe('TRUST_SOURCE_UNAVAILABLE');
      expect(err.network).toBe(BASE);
    });
  }

  for (const decimals of [0, 77]) {
    it(`trusts an entry with decimals ${decimals}`, async () => {
      const tokens = [{ ...usdc, decimals }];
      const { fetch } = fakeFetch((gateway) =>
        gateway === MAINNET_GW ? json({ ...baseDefaults, tokens }) : notFound(),
      );
      await expect(atumGatewayTrust({ fetch, now: fixedNow })(BASE)).resolves.toEqual({
        ...baseRoles,
        tokens,
      });
    });
  }
});

describe('atumGatewayTrust — could not find out', () => {
  // Each case pairs the broken gateway with a 404 from the other. A 404 alone would be the
  // authoritative refusal, so these prove that one inconclusive answer downgrades the verdict to
  // "unavailable" instead of letting the 404 speak for both.
  const brokenWith404: Array<[string, Reply]> = [
    ['a 5xx', unavailable()],
    ['a rejected fetch (network error)', new TypeError('fetch failed')],
    ['a 200 that is not JSON', new Response('<html>oops</html>', { status: 200 })],
    ['a 200 missing escrow_contract', json({ ...baseDefaults, escrow_contract: undefined })],
    ['a 200 missing quote_selector', json({ ...baseDefaults, quote_selector: undefined })],
    ['a 200 missing fulfillment_proxy', json({ ...baseDefaults, fulfillment_proxy: undefined })],
    [
      'a 200 missing fulfillment_verifier.account',
      json({ ...baseDefaults, fulfillment_verifier: { endpoint: 'https://v.example' } }),
    ],
    [
      'a 200 missing fulfillment_verifier',
      json({ ...baseDefaults, fulfillment_verifier: undefined }),
    ],
    ['a 200 whose chain_id is a different chain', json({ ...baseDefaults, chain_id: ARBITRUM })],
    ['a 200 missing chain_id', json({ ...baseDefaults, chain_id: undefined })],
  ];

  for (const [label, reply] of brokenWith404) {
    it(`rejects TRUST_SOURCE_UNAVAILABLE on ${label} alongside a 404`, async () => {
      const { fetch } = fakeFetch((gateway) => (gateway === MAINNET_GW ? reply : notFound()));
      const err = await trustFailure(atumGatewayTrust({ fetch, now: fixedNow })(BASE));
      expect(err.code).toBe('TRUST_SOURCE_UNAVAILABLE');
      expect(err.network).toBe(BASE);
    });
  }

  it('rejects TRUST_SOURCE_UNAVAILABLE, not CHAIN_NOT_TRUSTED, on one 503 and one 404', async () => {
    const { fetch } = fakeFetch((gateway) => (gateway === TESTNET_GW ? unavailable() : notFound()));
    const err = await trustFailure(atumGatewayTrust({ fetch, now: fixedNow })(BASE));
    expect(err.code).toBe('TRUST_SOURCE_UNAVAILABLE');
    expect(err.code).not.toBe('CHAIN_NOT_TRUSTED');
  });

  it('rejects TRUST_SOURCE_UNAVAILABLE when every gateway is failing', async () => {
    const { fetch } = fakeFetch(() => unavailable());
    const err = await trustFailure(atumGatewayTrust({ fetch, now: fixedNow })(BASE));
    expect(err.code).toBe('TRUST_SOURCE_UNAVAILABLE');
  });
});

describe('atumGatewayTrust — an empty role address', () => {
  // An empty string is present but names no contract, so it is as unusable as a missing field.
  // Each case pairs it with a 404 from the other gateway: the verdict must be "could not find
  // out", never trusted roles carrying an empty address and never the authoritative refusal.
  const emptyRoleWith404: Array<[string, Record<string, unknown>]> = [
    ['escrow_contract', { ...baseDefaults, escrow_contract: '' }],
    ['quote_selector', { ...baseDefaults, quote_selector: '' }],
    ['fulfillment_proxy', { ...baseDefaults, fulfillment_proxy: '' }],
    [
      'fulfillment_verifier.account',
      {
        ...baseDefaults,
        fulfillment_verifier: { ...baseDefaults.fulfillment_verifier, account: '' },
      },
    ],
  ];

  for (const [field, body] of emptyRoleWith404) {
    it(`rejects TRUST_SOURCE_UNAVAILABLE on a 200 whose ${field} is empty alongside a 404`, async () => {
      const { fetch } = fakeFetch((gateway) => (gateway === MAINNET_GW ? json(body) : notFound()));
      const err = await trustFailure(atumGatewayTrust({ fetch, now: fixedNow })(BASE));
      expect(err.code).toBe('TRUST_SOURCE_UNAVAILABLE');
      expect(err.network).toBe(BASE);
    });
  }
});

describe('atumGatewayTrust — timeout', () => {
  it('treats a gateway silent past the default 5000ms as a failure, and not before', async () => {
    vi.useFakeTimers();
    const { fetch } = fakeFetch((gateway) => (gateway === MAINNET_GW ? 'hang' : notFound()));
    const outcome = atumGatewayTrust({ fetch, now: fixedNow })(BASE).then(
      () => 'resolved' as const,
      (e: unknown) => e,
    );
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const err = await outcome;
    expect(err).toBeInstanceOf(AtumEscrowTrustError);
    expect((err as AtumEscrowTrustError).code).toBe('TRUST_SOURCE_UNAVAILABLE');
  });

  it('honours a configured timeoutMs', async () => {
    vi.useFakeTimers();
    const { fetch } = fakeFetch((gateway) => (gateway === MAINNET_GW ? 'hang' : notFound()));
    const outcome = atumGatewayTrust({ fetch, now: fixedNow, timeoutMs: 1_000 })(BASE).then(
      () => 'resolved' as const,
      (e: unknown) => e,
    );
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const err = await outcome;
    expect(err).toBeInstanceOf(AtumEscrowTrustError);
    expect((err as AtumEscrowTrustError).code).toBe('TRUST_SOURCE_UNAVAILABLE');
  });

  it('still trusts the other gateway when one times out', async () => {
    vi.useFakeTimers();
    const { fetch } = fakeFetch((gateway) =>
      gateway === MAINNET_GW ? 'hang' : json(baseDefaults),
    );
    const outcome = atumGatewayTrust({ fetch, now: fixedNow })(BASE);
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(outcome).resolves.toEqual(baseRoles);
  });
});

describe('atumGatewayTrust — a usable answer does not wait on a silent gateway', () => {
  /** The AbortSignal handed to the request sent to `gateway`, failing if there is not exactly one. */
  function signalSentTo(spy: ReturnType<typeof fakeFetch>['spy'], gateway: string): AbortSignal {
    const calls = spy.mock.calls.filter(([input]) => new URL(urlOf(input)).origin === gateway);
    expect(calls).toHaveLength(1);
    const signal = calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    return signal as AbortSignal;
  }

  describe.each([
    ['mainnet hangs, testnet answers', MAINNET_GW, TESTNET_GW],
    ['testnet hangs, mainnet answers', TESTNET_GW, MAINNET_GW],
  ])('%s', (_label, silent, answering) => {
    // Zero fake-clock advance throughout: a resolver that only settles once the per-gateway
    // timeout fires would leave the outcome pending here, so settling at all proves it did not
    // wait for the silent gateway.
    it('resolves to the trusted roles without the clock moving', async () => {
      vi.useFakeTimers();
      const { fetch } = fakeFetch((gateway) =>
        gateway === silent ? 'hang' : gateway === answering ? json(baseDefaults) : notFound(),
      );
      const pending = Symbol('pending');
      const outcome = atumGatewayTrust({ fetch, now: fixedNow })(BASE).then(
        (roles) => ({ roles }),
        (error: unknown) => ({ error }),
      );
      let settled: typeof pending | { roles: TrustedRoles } | { error: unknown } = pending;
      void outcome.then((o) => {
        settled = o;
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(settled).not.toBe(pending);
      expect(settled).toEqual({ roles: baseRoles });
    });

    it('aborts the still-hanging request and leaves no timer behind once resolved', async () => {
      vi.useFakeTimers();
      const { fetch, spy } = fakeFetch((gateway) =>
        gateway === silent ? 'hang' : gateway === answering ? json(baseDefaults) : notFound(),
      );
      let settled = false;
      const outcome = atumGatewayTrust({ fetch, now: fixedNow })(BASE).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(settled).toBe(true);
      await expect(outcome).resolves.toEqual(baseRoles);
      // An un-aborted request keeps a socket open, and a live timer keeps the process (and the
      // abandoned request) alive until the timeout, long after the answer was already used.
      expect(signalSentTo(spy, silent).aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('atumGatewayTrust — caching', () => {
  /** A clock the test moves by hand. */
  function manualClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it('reuses a trusted answer for the default 300000ms, then asks again', async () => {
    const clock = manualClock();
    const { fetch, spy } = fakeFetch(mainnetServes);
    const resolve = atumGatewayTrust({ fetch, now: clock.now });

    await expect(resolve(BASE)).resolves.toEqual(baseRoles);
    const afterFirst = spy.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    clock.advance(299_999);
    await expect(resolve(BASE)).resolves.toEqual(baseRoles);
    expect(spy.mock.calls.length).toBe(afterFirst);

    clock.advance(2);
    await expect(resolve(BASE)).resolves.toEqual(baseRoles);
    expect(spy.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('honours a configured ttlMs', async () => {
    const clock = manualClock();
    const { fetch, spy } = fakeFetch(mainnetServes);
    const resolve = atumGatewayTrust({ fetch, now: clock.now, ttlMs: 10_000 });

    await resolve(BASE);
    const afterFirst = spy.mock.calls.length;

    clock.advance(9_999);
    await resolve(BASE);
    expect(spy.mock.calls.length).toBe(afterFirst);

    clock.advance(2);
    await resolve(BASE);
    expect(spy.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('serves a refreshed answer after expiry rather than the stale one', async () => {
    // Expiry exists so a rotated contract is picked up; re-fetching and then returning the old
    // value would defeat it.
    const clock = manualClock();
    let current = baseDefaults;
    const { fetch } = fakeFetch((gateway) => (gateway === MAINNET_GW ? json(current) : notFound()));
    const resolve = atumGatewayTrust({ fetch, now: clock.now });

    await expect(resolve(BASE)).resolves.toEqual(baseRoles);
    const rotatedEscrow = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720';
    current = { ...baseDefaults, escrow_contract: rotatedEscrow };
    clock.advance(300_001);
    await expect(resolve(BASE)).resolves.toEqual({ ...baseRoles, escrowContract: rotatedEscrow });
  });

  it('caches per network: a different chain is still looked up', async () => {
    const { fetch, requests } = fakeFetch(mainnetServes);
    const resolve = atumGatewayTrust({ fetch, now: fixedNow });

    await expect(resolve(BASE)).resolves.toEqual(baseRoles);
    await expect(resolve(ARBITRUM)).resolves.toEqual(arbitrumRoles);
    expect(requests.map((r) => r.url)).toContain(defaultsUrl(MAINNET_GW, ARBITRUM));
  });

  it('does not cache an unavailable answer: the next call asks again', async () => {
    let down = true;
    const { fetch, spy } = fakeFetch((gateway, network) =>
      down ? unavailable() : mainnetServes(gateway, network),
    );
    const resolve = atumGatewayTrust({ fetch, now: fixedNow });

    expect((await trustFailure(resolve(BASE))).code).toBe('TRUST_SOURCE_UNAVAILABLE');
    const afterFailure = spy.mock.calls.length;

    down = false;
    await expect(resolve(BASE)).resolves.toEqual(baseRoles);
    expect(spy.mock.calls.length).toBeGreaterThan(afterFailure);
  });

  it('does not cache a CHAIN_NOT_TRUSTED answer: a newly supported chain is picked up', async () => {
    let supported = false;
    const { fetch } = fakeFetch((gateway, network) =>
      supported ? mainnetServes(gateway, network) : notFound(),
    );
    const resolve = atumGatewayTrust({ fetch, now: fixedNow });

    expect((await trustFailure(resolve(BASE))).code).toBe('CHAIN_NOT_TRUSTED');
    supported = true;
    await expect(resolve(BASE)).resolves.toEqual(baseRoles);
  });

  it('uses Date.now as the default clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-08T12:00:00Z'));
    const { fetch, spy } = fakeFetch(mainnetServes);
    const resolve = atumGatewayTrust({ fetch });

    await resolve(BASE);
    const afterFirst = spy.mock.calls.length;

    vi.setSystemTime(new Date(Date.parse('2026-07-08T12:00:00Z') + 299_999));
    await resolve(BASE);
    expect(spy.mock.calls.length).toBe(afterFirst);

    vi.setSystemTime(new Date(Date.parse('2026-07-08T12:00:00Z') + 300_001));
    await resolve(BASE);
    expect(spy.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

describe('atumGatewayTrust — concurrent lookups', () => {
  it('shares one in-flight lookup: N parallel calls make one request per gateway', async () => {
    // Without sharing, a burst of payments for one chain fans out into a burst of gateway calls
    // — the exact load the cache exists to prevent, arriving before the cache has anything in it.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { fetch, requests } = fakeFetch(async (gateway, network) => {
      await gate;
      return gateway === TESTNET_GW && network === BASE ? json(baseDefaults) : notFound();
    });
    const resolve = atumGatewayTrust({ fetch, now: fixedNow });

    const calls = [resolve(BASE), resolve(BASE), resolve(BASE), resolve(BASE)];
    release();
    const results = await Promise.all(calls);

    expect(results).toEqual([baseRoles, baseRoles, baseRoles, baseRoles]);
    const urls = requests.map((r) => r.url);
    expect(urls.filter((u) => u === defaultsUrl(MAINNET_GW, BASE))).toHaveLength(1);
    expect(urls.filter((u) => u === defaultsUrl(TESTNET_GW, BASE))).toHaveLength(1);
    expect(urls).toHaveLength(2);
  });

  it('shares a failed in-flight lookup, then retries on the next call', async () => {
    // A shared lookup that failed must fail every caller waiting on it, and must not leave the
    // failure behind: the next call starts a fresh round rather than replaying the outage.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let down = true;
    const { fetch, requests } = fakeFetch(async (gateway, network) => {
      await gate;
      if (down) return gateway === MAINNET_GW ? unavailable() : notFound();
      return mainnetServes(gateway, network);
    });
    const resolve = atumGatewayTrust({ fetch, now: fixedNow });

    const calls = [resolve(BASE), resolve(BASE), resolve(BASE)];
    release();
    const errors = await Promise.all(calls.map((c) => trustFailure(c)));

    expect(errors.map((e) => e.code)).toEqual([
      'TRUST_SOURCE_UNAVAILABLE',
      'TRUST_SOURCE_UNAVAILABLE',
      'TRUST_SOURCE_UNAVAILABLE',
    ]);
    const firstRound = requests.map((r) => r.url);
    expect(firstRound.filter((u) => u === defaultsUrl(MAINNET_GW, BASE))).toHaveLength(1);
    expect(firstRound.filter((u) => u === defaultsUrl(TESTNET_GW, BASE))).toHaveLength(1);
    expect(firstRound).toHaveLength(2);

    down = false;
    await expect(resolve(BASE)).resolves.toEqual(baseRoles);
    const secondRound = requests.slice(firstRound.length).map((r) => r.url);
    expect(secondRound).toContain(defaultsUrl(MAINNET_GW, BASE));
  });
});
