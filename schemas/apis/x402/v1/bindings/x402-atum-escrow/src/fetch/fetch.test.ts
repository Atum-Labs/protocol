/**
 * The payment-enabled `fetch` and its per-call purchase identifier.
 *
 * The property under test is that the identifier belongs to the *call* and not to the client: one
 * long-lived client must serve any number of distinct payments, and two calls in flight together
 * must not pick up each other's identifier. Holding the identifier on the client instead would make
 * every purchase share one identity and collapse onto a single payment, which is the failure this
 * wrapper exists to prevent.
 *
 * `fetch` is faked rather than mocked at the module level: the first request answers `402` with a
 * real `PaymentRequired` built by the resource server, and the second captures the payment header the
 * wrapper attached, so the assertions read the payment a payer would actually have sent.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import { x402Client } from '@x402/core/client';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { AtumEscrowServerScheme, type AtumEscrowServerConfig } from '../server';
import { AtumEscrowClientScheme, type TrustResolver, type TrustedRoles } from '../client';
import { atumEscrowRequestId } from '../request-id';
import { httpRequest } from '../server/test-support';
import { PAYMENT_IDENTIFIER, toPaymentIdentifier } from '../payment-identifier';
import { wrapFetchWithAtumPayment } from './index';

const SOURCE_NETWORK = 'eip155:8453';
const SOURCE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const serverConfig: AtumEscrowServerConfig = {
  destination: {
    network: 'eip155:42161',
    asset: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    symbol: 'USDC',
    decimals: 6,
  },
  fulfillmentAmount: '10000000',
  markupBps: 300,
  fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  reserver: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  releaser: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
  quoteDeadlineSeconds: 20,
  fulfillmentDeadlineSeconds: 300,
  sources: {
    [SOURCE_NETWORK]: {
      asset: SOURCE_ASSET,
      escrow: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
      symbol: 'USDC',
      decimals: 6,
    },
  },
};

/**
 * The roles this file's fixtures advertise, declared per chain as what the payer trusts. The
 * client refuses a 402 whose roles differ from its trust source, so each fixture states what it
 * expects to be trusted rather than reaching a live gateway. A source chain is checked on its
 * escrow, reserver and releaser and a destination chain only on its fulfillment proxy; every
 * field repeats the fixture's own value for that chain, and `tokens` lists the asset the
 * fixture moves there, so the payer's markup bound can price the corridor.
 */
const EVM_ROLES: Omit<TrustedRoles, 'tokens'> = {
  escrowContract: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
  quoteSelector: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  fulfillmentVerifierAccount: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
};
const TRUSTED_ROLES: Record<string, TrustedRoles> = {
  'eip155:8453': {
    ...EVM_ROLES,
    tokens: [
      { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    ],
  },
  'eip155:42161': {
    ...EVM_ROLES,
    tokens: [
      { symbol: 'USDC', address: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3', decimals: 6 },
    ],
  },
};
const trust: TrustResolver = async (network) => {
  const roles = TRUSTED_ROLES[network];
  if (roles === undefined) throw new Error(`no trusted roles declared for ${network}`);
  return roles;
};

// Well-known anvil account #0 — a throwaway dev key, safe to commit.
const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

const RESOURCE = 'https://api.example.com/report';
/** The page the 402 binds the payment to: the request's method, path and query. */
const PAGE = 'GET /report';

/** Build a `402` the resource server would send, optionally with extensions it declares itself. */
async function paymentRequired(
  declaredExtensions?: Record<string, unknown>,
): Promise<PaymentRequired> {
  const scheme = new AtumEscrowServerScheme(serverConfig);
  const server = new x402ResourceServer();
  server.register(SOURCE_NETWORK, scheme);
  // The scheme shapes each accept first, as x402's middleware would, so the 402 carries the
  // corridor data a payer needs.
  const accept = await scheme.enhancePaymentRequirements({
    scheme: 'atum-escrow',
    network: SOURCE_NETWORK,
    asset: SOURCE_ASSET,
    amount: '10300000',
    payTo: '',
    maxTimeoutSeconds: 60,
    extra: {},
  } as PaymentRequirements);
  return server.createPaymentRequiredResponse(
    [accept],
    { url: RESOURCE, method: 'GET' } as never,
    undefined,
    declaredExtensions,
    httpRequest(RESOURCE),
  );
}

/** One long-lived client, exactly as an application would build it. */
function longLivedClient(): x402Client {
  const client = new x402Client();
  client.register(
    SOURCE_NETWORK,
    new AtumEscrowClientScheme({
      signer: wallet,
      trust,
      // A moving clock, because two attempts happen seconds apart in production and the permit
      // deadline follows the wall clock. Only `request_id` is stable across attempts.
      now: (() => {
        let t = Date.parse('2026-07-08T12:00:00Z');
        return () => (t += 1_500);
      })(),
    }),
  );
  return client;
}

/**
 * A `fetch` that answers `402` once per URL and then captures the payment.
 *
 * Every payment the wrapper produced is recorded in `paid`, in the order the requests were made.
 */
function fakeFetch(offer: PaymentRequired): {
  fetch: typeof globalThis.fetch;
  paid: PaymentPayload[];
} {
  const paid: PaymentPayload[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as never, init);
    const header = request.headers.get('PAYMENT-SIGNATURE');
    if (header === null) {
      // A v2 resource server carries the requirements in the PAYMENT-REQUIRED header; the body is
      // only consulted for the v1 protocol.
      return new Response('{}', {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'PAYMENT-REQUIRED': encodePaymentRequiredHeader(offer),
        },
      });
    }
    paid.push(JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentPayload);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, paid };
}

/** The `request_id` of a captured payment. */
function requestIdOf(payload: PaymentPayload): string {
  return (payload.payload as { paymentRequest: { request_id: string } }).paymentRequest.request_id;
}

describe('wrapFetchWithAtumPayment — the identifier belongs to the call', () => {
  it('gives two purchases distinct identities through ONE long-lived client', async () => {
    // The property the whole wrapper exists for. If the identifier were held on the client or the
    // scheme, these two would collapse onto one payment: the payer would be charged once and the
    // resource served twice.
    const { fetch, paid } = fakeFetch(await paymentRequired());
    const pay = wrapFetchWithAtumPayment(fetch, longLivedClient());

    await pay(RESOURCE, {}, { paymentIdentifier: 'order-4711' });
    await pay(RESOURCE, {}, { paymentIdentifier: 'order-4712' });

    expect(paid).toHaveLength(2);
    expect(requestIdOf(paid[0]!)).not.toBe(requestIdOf(paid[1]!));
  });

  it('reproduces one identity when the same purchase is re-attempted', async () => {
    // A re-attempt re-requests the resource and receives a FRESH 402. Same purchase identifier
    // therefore has to yield the same `request_id`, which is what lets the network resolve the
    // re-attempt to the original payment instead of taking a second one.
    const { fetch, paid } = fakeFetch(await paymentRequired());
    const pay = wrapFetchWithAtumPayment(fetch, longLivedClient());

    await pay(RESOURCE, {}, { paymentIdentifier: 'order-4711' });
    await pay(RESOURCE, {}, { paymentIdentifier: 'order-4711' });

    expect(requestIdOf(paid[0]!)).toBe(requestIdOf(paid[1]!));
  });

  it('keeps concurrent purchases apart', async () => {
    // Concurrency is where a client-held identifier would be silently wrong: two calls in flight
    // together would race over one field. Each call gets its own view of the client instead, so
    // there is no shared field to race over.
    const { fetch, paid } = fakeFetch(await paymentRequired());
    const pay = wrapFetchWithAtumPayment(fetch, longLivedClient());

    const references = ['order-A', 'order-B', 'order-C', 'order-D'];
    await Promise.all(references.map((r) => pay(RESOURCE, {}, { paymentIdentifier: r })));

    const expected = new Set(
      references.map((r) => atumEscrowRequestId(toPaymentIdentifier(r), wallet.address, PAGE)),
    );
    const observed = new Set(paid.map(requestIdOf));
    expect(observed.size).toBe(references.length);
    expect(observed).toEqual(expected);
  });

  it("derives the identity from the caller's reference, through the documented mapping", async () => {
    // Pins that the wrapper does not invent an identifier of its own: the payment's identity is a
    // function of the reference the caller gave and nothing else.
    const { fetch, paid } = fakeFetch(await paymentRequired());
    const pay = wrapFetchWithAtumPayment(fetch, longLivedClient());

    await pay(RESOURCE, {}, { paymentIdentifier: 'order-4711' });

    expect(requestIdOf(paid[0]!)).toBe(
      atumEscrowRequestId(toPaymentIdentifier('order-4711'), wallet.address, PAGE),
    );
  });

  it("publishes a conforming identifier even when the caller's reference is not one", async () => {
    // "order-4711" is a plausible reference and an invalid extension value (too short), so what
    // reaches the wire must be the mapped form — otherwise a conforming third party would reject it.
    const { fetch, paid } = fakeFetch(await paymentRequired());
    const pay = wrapFetchWithAtumPayment(fetch, longLivedClient());

    await pay(RESOURCE, {}, { paymentIdentifier: 'order-4711' });

    const entry = paid[0]!.extensions?.[PAYMENT_IDENTIFIER] as { info: { id: string } };
    expect(entry.info.id).toBe(toPaymentIdentifier('order-4711'));
    expect(entry.info.id).not.toBe('order-4711');
  });
});

describe('wrapFetchWithAtumPayment — when the resource server names the purchase', () => {
  it("uses the resource server's identifier when the call supplies none", async () => {
    const declared = 'pay_server_declared_0001';
    const { fetch, paid } = fakeFetch(
      await paymentRequired({ [PAYMENT_IDENTIFIER]: { info: { required: true, id: declared } } }),
    );
    const pay = wrapFetchWithAtumPayment(fetch, longLivedClient());

    await pay(RESOURCE, {});

    expect(requestIdOf(paid[0]!)).toBe(atumEscrowRequestId(declared, wallet.address, PAGE));
  });

  it('accepts a call that names the same purchase the resource server did', async () => {
    const declared = 'pay_server_declared_0001';
    const { fetch, paid } = fakeFetch(
      await paymentRequired({ [PAYMENT_IDENTIFIER]: { info: { required: true, id: declared } } }),
    );
    const pay = wrapFetchWithAtumPayment(fetch, longLivedClient());

    await pay(RESOURCE, {}, { paymentIdentifier: declared });

    expect(requestIdOf(paid[0]!)).toBe(atumEscrowRequestId(declared, wallet.address, PAGE));
  });

  it('refuses when the call and the resource server name DIFFERENT purchases', async () => {
    // Both cannot be honoured: a payer may not overwrite a declared value. Silently dropping the
    // caller's would leave it believing it had paid under an identity it chose.
    const { fetch, paid } = fakeFetch(
      await paymentRequired({
        [PAYMENT_IDENTIFIER]: { info: { required: true, id: 'pay_server_declared_0001' } },
      }),
    );
    const pay = wrapFetchWithAtumPayment(fetch, longLivedClient());

    await expect(pay(RESOURCE, {}, { paymentIdentifier: 'order-4711' })).rejects.toThrow(
      /already named it/i,
    );
    expect(paid).toHaveLength(0);
  });
});

describe('wrapFetchWithAtumPayment — misuse is refused, not guessed at', () => {
  it('refuses a call that names no purchase when the resource server names none either', async () => {
    // Fail-closed. There is deliberately no generated fallback: an invented identifier looks like an
    // idempotency key while letting every re-attempt become a second payment.
    const { fetch, paid } = fakeFetch(await paymentRequired());
    const pay = wrapFetchWithAtumPayment(fetch, longLivedClient());

    await expect(pay(RESOURCE, {})).rejects.toThrow(/was not told which purchase/i);
    expect(paid).toHaveLength(0);
  });

  it('names the wrapper and its third argument when called as a plain fetch', async () => {
    // The wrapped fetch stays assignable to `fetch`, so a library that accepts a fetch
    // implementation can call it as `fetch(url, init)` and silently drop the options. That is
    // fail-closed, but the error has to say what was missing and where it goes, or it reads as a
    // broken SDK rather than a misuse.
    const { fetch, paid } = fakeFetch(await paymentRequired());
    const pay = wrapFetchWithAtumPayment(fetch, longLivedClient());
    const asPlainFetch: typeof globalThis.fetch = pay;

    const error = await asPlainFetch(RESOURCE).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(/wrapFetchWithAtumPayment/);
    expect(error?.message).toMatch(/paymentIdentifier/);
    expect(paid).toHaveLength(0);
  });

  it('refuses an empty reference rather than treating it as absent', async () => {
    const { fetch } = fakeFetch(await paymentRequired());
    const pay = wrapFetchWithAtumPayment(fetch, longLivedClient());
    await expect(pay(RESOURCE, {}, { paymentIdentifier: '' })).rejects.toThrow(/non-empty string/i);
  });
});

describe('wrapFetchWithAtumPayment — the client it wraps is left intact', () => {
  it("preserves the client's identity and its other methods", async () => {
    // The per-call view is a stand-in for the client, so anything the framework asks of a client
    // must still work — including the `instanceof` check the transport performs.
    const { fetch } = fakeFetch(await paymentRequired());
    const client = longLivedClient();
    const pay = wrapFetchWithAtumPayment(fetch, client);

    // Paying exercises the view end to end: the transport wraps it, queries its extensions and
    // hooks, and calls through to the real client.
    await pay(RESOURCE, {}, { paymentIdentifier: 'order-4711' });

    expect(client).toBeInstanceOf(x402Client);
    expect(client.getExtensions()).toEqual([]);
  });

  it('leaves the client reusable for a different purchase afterwards', async () => {
    const { fetch, paid } = fakeFetch(await paymentRequired());
    const client = longLivedClient();

    await wrapFetchWithAtumPayment(fetch, client)(RESOURCE, {}, { paymentIdentifier: 'order-A' });
    await wrapFetchWithAtumPayment(fetch, client)(RESOURCE, {}, { paymentIdentifier: 'order-B' });

    expect(requestIdOf(paid[0]!)).not.toBe(requestIdOf(paid[1]!));
  });
});

describe("toPaymentIdentifier — mapping a caller's reference", () => {
  it('passes through a reference that already conforms', () => {
    const conforming = 'pay_order_4711_a1b2c3d4';
    expect(toPaymentIdentifier(conforming)).toBe(conforming);
  });

  it('maps a non-conforming reference onto a conforming identifier', () => {
    for (const reference of ['order-4711', 'visa/order:88213', 'cart #7', 'ünïcodé-order']) {
      const identifier = toPaymentIdentifier(reference);
      expect(identifier).toMatch(/^pay_[0-9a-f]{64}$/);
      expect(identifier.length).toBe(68);
    }
  });

  it('is stable, so a re-attempt reproduces the same identifier', () => {
    expect(toPaymentIdentifier('order-4711')).toBe(toPaymentIdentifier('order-4711'));
  });

  it('separates references that differ, so distinct purchases stay distinct', () => {
    expect(toPaymentIdentifier('order-4711')).not.toBe(toPaymentIdentifier('order-4712'));
  });

  it('refuses a reference that names nothing', () => {
    expect(() => toPaymentIdentifier('')).toThrow(/non-empty string/i);
    expect(() => toPaymentIdentifier(undefined as unknown as string)).toThrow(/non-empty string/i);
  });
});
