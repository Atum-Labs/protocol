// preparePaymentRequest is the single entrypoint: it fetches corridor addresses
// from the gateway, but skips the fetch for anything the caller supplies via
// `resolvedDefaults`. Supplying both sides (+ an injected `now`) builds entirely
// OFFLINE (no network), and an explicit Permit2 nonce makes a re-issued
// authorization byte-identical (idempotency). Exercises the REAL chain adapters.
import {
  DEFAULT_PAYMENT_QUOTE_DEADLINE_SECONDS,
  PaymentGatewayClient,
  PAYMENT_REQUEST_VERSION,
  DEFAULT_FULFILLMENT_DEADLINE_SECONDS,
  REPLAY_HORIZON_SECS,
} from './index';
import type { ChainDefaults } from './chain-adapters';
import type { PaymentRequest } from './index';
import { readDepositRequest } from '@atum-labs/payment-request-sender-auth';

const evmDefaults: ChainDefaults = {
  escrowContract: '0x0000000000000000000000000000000000000001',
  fulfillmentProxy: '0x0000000000000000000000000000000000000002',
  quoteSelector: '0x0000000000000000000000000000000000000003',
  fulfillmentVerifierAccount: '0x0000000000000000000000000000000000000004',
  fulfillmentVerifierEndpoint: 'https://verifier.example',
};

const SOLANA_SOURCE_DEFAULTS: ChainDefaults = {
  escrowContract: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
  quoteSelector: '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',
  fulfillmentVerifierAccount: 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8',
  fulfillmentVerifierEndpoint: 'https://verifier.example',
  fulfillmentProxy: '0x0000000000000000000000000000000000000002',
  svmSignatureClusterId: 'devnet',
  svmSignatureDomainVersion: 5,
};

const NOW_MS = Date.parse('2035-01-01T00:00:00.000Z');
const QUOTE_S = 20;
const FULFILL_S = 3600;

/** A client whose fetch throws — proves the offline path makes NO gateway call. */
class NoFetchClient extends PaymentGatewayClient {
  async fetchChainDefaults(): Promise<ChainDefaults> {
    throw new Error('fetchChainDefaults must not be called on the offline path');
  }
}

function offlineParams(nonce?: bigint | string) {
  return {
    depositor: '0x0000000000000000000000000000000000000005',
    fulfillmentAmount: '100000',
    sourceAsset: 'eip155:1/erc20:0x0000000000000000000000000000000000000006',
    destinationAccount: '0x0000000000000000000000000000000000000007',
    destinationAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008',
    maxSourceAmount: '103000',
    requestId: 'req-build',
    quoteDeadlineSeconds: QUOTE_S,
    fulfillmentDeadlineSeconds: FULFILL_S,
    now: () => NOW_MS,
    // Supplying both sides is what makes the build fully offline.
    resolvedDefaults: {
      source: evmDefaults,
      destination: { fulfillmentProxy: evmDefaults.fulfillmentProxy },
    },
    nonce,
  };
}

/**
 * offlineParams() with a Solana source. An explicit RPC URL makes the builder call the injected
 * clock reader, which returns `issuedAt` with no network call, instead of falling back to the wall
 * clock.
 */
function solanaOfflineParams(issuedAt = BigInt(NOW_MS / 1000)) {
  return {
    ...offlineParams(),
    depositor: 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse',
    sourceAsset: 'solana:mainnet/spl:cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN',
    solanaRpcUrl: 'http://localhost:8899',
    solanaClockReader: async () => issuedAt,
    resolvedDefaults: {
      source: SOLANA_SOURCE_DEFAULTS,
      destination: { fulfillmentProxy: SOLANA_SOURCE_DEFAULTS.fulfillmentProxy },
    },
  };
}

/** The signed deposit message's typed-data prehash, parsed. */
function prehashOf(pr: PaymentRequest) {
  return JSON.parse(pr.sender_auth!.signed_messages![0]!.message_prehash!);
}

function prepareOffline(nonce?: bigint | string) {
  return new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest(
    offlineParams(nonce),
  );
}

describe('preparePaymentRequest offline mode (no gateway fetch)', () => {
  it('assembles a signable request from caller-supplied defaults, no network access', async () => {
    const pr = await prepareOffline(1n);

    expect(pr.version).toBe(PAYMENT_REQUEST_VERSION);
    expect(pr.request_id).toBe('req-build');
    expect(pr.max_source_amount).toBe('103000');
    // Deadlines are stamped from the relative budgets against the injected `now`.
    expect(pr.quote_deadline).toBe(new Date(NOW_MS + QUOTE_S * 1000).toISOString());
    expect(pr.fulfillment_deadline).toBe(new Date(NOW_MS + FULFILL_S * 1000).toISOString());
    expect(pr.escrow_contract_address).toBe(evmDefaults.escrowContract);
    expect(pr.fulfillment_proxy).toBe(evmDefaults.fulfillmentProxy);
    expect(pr.executor).toBeUndefined();

    // sender_auth is populated and ready for signPaymentRequest (empty signature).
    const signed = pr.sender_auth!.signed_messages![0]!;
    expect(signed.message).toMatch(/^0x[0-9a-f]+$/i);
    expect(signed.signature).toBe('');
    // The signed Permit2 deposit authorizes the cap, not the fulfillment amount.
    const prehash = JSON.parse(signed.message_prehash!);
    expect(prehash.message.permitted.amount).toBe('103000');
  });

  it('commits the SAME payee in the signed witness as in the request body', async () => {
    // The type system forces destinationAsset/destinationAccount to be passed, but both are
    // strings — it cannot tell the right pair from any other. This is the property that
    // matters: what the depositor SIGNS and what the request body ADVERTISES must name one
    // payee. If they diverge, the escrow cannot tell — it stores only
    // keccak256(bytes(destination)) — so the deposit is neither releasable nor refundable,
    // and there is no rescue function.
    const pr = await prepareOffline(7n);
    const prehash = prehashOf(pr);

    const dest = pr.destination[0]!;
    // eip155 destinations are lowercased by the shared composer (explicitly NOT EIP-55).
    const expected = `${dest.asset_identifier}@${dest.account}`.toLowerCase();
    expect(prehash.message.witness.destination).toBe(expected);

    // And the request-id commitment is present and non-zero: keccak256("") is a perfectly
    // valid bytes32, so an all-zero value would be a well-formed commitment to nothing.
    expect(prehash.message.witness.depositRequestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(prehash.message.witness.depositRequestHash).not.toBe(`0x${'0'.repeat(64)}`);
  });

  it('an explicit nonce makes the authorization byte-identical (idempotency)', async () => {
    const a = await prepareOffline(42n);
    const b = await prepareOffline(42n);

    expect(a.sender_auth!.signed_messages![0]!.message).toBe(
      b.sender_auth!.signed_messages![0]!.message,
    );
    expect(a.sender_auth!.signed_messages![0]!.message_prehash).toBe(
      b.sender_auth!.signed_messages![0]!.message_prehash,
    );
  });

  it('a decimal-string nonce normalizes to the same value as its bigint', async () => {
    const fromBigInt = await prepareOffline(42n);
    const fromString = await prepareOffline('42');

    expect(fromString.sender_auth!.signed_messages![0]!.message).toBe(
      fromBigInt.sender_auth!.signed_messages![0]!.message,
    );
  });

  it('a different nonce yields a different authorization', async () => {
    const a = await prepareOffline(42n);
    const b = await prepareOffline(43n);

    expect(a.sender_auth!.signed_messages![0]!.message).not.toBe(
      b.sender_auth!.signed_messages![0]!.message,
    );
  });
});

// The source chain's defaults pick the depositRequestHash the deposit commits: absent is v1,
// keccak256(request_id); 2 is v2, the hash of the request's terms, so the body is built first and
// the deposit signs exactly that body.
describe('preparePaymentRequest depositRequestHash version', () => {
  async function prepareWith(source: ChainDefaults) {
    const params = offlineParams(1n);
    return new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest({
      ...params,
      resolvedDefaults: { ...params.resolvedDefaults, source },
    });
  }
  const committed = (pr: PaymentRequest) =>
    prehashOf(pr).message.witness.depositRequestHash as string;
  const unsigned = (pr: PaymentRequest) => {
    const { sender_auth: _signed, ...body } = pr;
    return JSON.stringify(body);
  };

  // The strict reader every depositRequestHash version goes through takes only this pattern, and
  // the gateway will too, so a request id outside it is refused before anything is built.
  it.each(['order#1', 'a'.repeat(129), 'req id', 'r\u00e9q'])(
    'refuses the request id %j, naming the pattern',
    async (requestId) => {
      const params = offlineParams(1n);
      await expect(
        new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest({
          ...params,
          requestId,
        }),
      ).rejects.toThrow(
        `requestId ${JSON.stringify(requestId)} does not match ^[A-Za-z0-9._-]{1,128}$`,
      );
    },
  );

  it('refuses a request id outside the pattern before fetching the defaults', async () => {
    const { resolvedDefaults: _offline, ...params } = offlineParams(1n);
    await expect(
      new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest({
        ...params,
        requestId: 'order#1',
      }),
    ).rejects.toThrow('requestId "order#1" does not match ^[A-Za-z0-9._-]{1,128}$');
  });

  it('accepts a 128-character request id, the longest the pattern allows', async () => {
    const params = offlineParams(1n);
    const pr = await new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest({
      ...params,
      requestId: 'a'.repeat(128),
    });
    expect(pr.request_id).toBe('a'.repeat(128));
  });

  it('commits v1, keccak256 of the request_id, when the defaults publish no version', async () => {
    const pr = await prepareWith(evmDefaults);
    expect(committed(pr)).toBe(readDepositRequest(unsigned(pr)).depositRequestHashV1);
  });

  it("commits the request body's v2 when the defaults ask for version 2", async () => {
    const pr = await prepareWith({ ...evmDefaults, depositRequestHashVersion: 2 });
    expect(committed(pr)).toBe(readDepositRequest(unsigned(pr)).depositRequestHashV2);
  });

  // The gateway may publish a version this build does not know; v1 stays accepted, so it signs v1
  // rather than failing every payment from that chain.
  it.each([1, 3])('commits v1 when the defaults publish version %d', async (version) => {
    const pr = await prepareWith({ ...evmDefaults, depositRequestHashVersion: version });
    expect(committed(pr)).toBe(readDepositRequest(unsigned(pr)).depositRequestHashV1);
  });
});

// When defaults are NOT supplied, prepare still fetches from the gateway and
// forwards the nonce down to the deposit build (idempotency through the entrypoint).
class StubDefaultsClient extends PaymentGatewayClient {
  async fetchChainDefaults(): Promise<ChainDefaults> {
    return evmDefaults;
  }
}

describe('preparePaymentRequest fetch mode forwards the nonce', () => {
  function prepare(nonce: bigint | string) {
    return new StubDefaultsClient({ BASE: 'https://gateway.example' }).preparePaymentRequest({
      depositor: '0x0000000000000000000000000000000000000005',
      fulfillmentAmount: '100000',
      maxSourceAmount: '103000',
      sourceAsset: 'eip155:1/erc20:0x0000000000000000000000000000000000000006',
      destinationAccount: '0x0000000000000000000000000000000000000007',
      destinationAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008',
      requestId: 'req-prepare-nonce',
      // Frozen, as everywhere else in this file. The deposit hash binds issued_at, so two builds
      // that straddle a second boundary differ and this determinism check becomes a clock race.
      now: () => NOW_MS,
      nonce,
    });
  }

  it('same nonce → byte-identical deposit; different nonce → different', async () => {
    const a = await prepare(7n);
    const b = await prepare(7n);
    const c = await prepare(8n);

    expect(a.sender_auth!.signed_messages![0]!.message).toBe(
      b.sender_auth!.signed_messages![0]!.message,
    );
    expect(a.sender_auth!.signed_messages![0]!.message).not.toBe(
      c.sender_auth!.signed_messages![0]!.message,
    );
  });
});

// Bidding closes at quote_deadline, so the builder's own network reads must not come out of the
// window: the deadlines (and the permit deadline derived from them) are stamped from one clock
// read taken after the corridor fetch and, for Solana, after the cluster-clock read.
describe('preparePaymentRequest stamps the deadlines after its network reads', () => {
  const evmParams = (now: () => number) => ({
    depositor: '0x0000000000000000000000000000000000000005',
    fulfillmentAmount: '100000',
    maxSourceAmount: '103000',
    sourceAsset: 'eip155:1/erc20:0x0000000000000000000000000000000000000006',
    destinationAccount: '0x0000000000000000000000000000000000000007',
    destinationAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008',
    requestId: 'req-stamp-after-fetch',
    quoteDeadlineSeconds: QUOTE_S,
    fulfillmentDeadlineSeconds: FULFILL_S,
    now,
  });

  it('a slow chain-defaults fetch does not shorten the quote window', async () => {
    let clock = NOW_MS;
    class SlowDefaultsClient extends PaymentGatewayClient {
      async fetchChainDefaults(): Promise<ChainDefaults> {
        clock += 5_000;
        return evmDefaults;
      }
    }

    const pr = await new SlowDefaultsClient({
      BASE: 'https://gateway.example',
    }).preparePaymentRequest(evmParams(() => clock));

    expect(pr.quote_deadline).toBe(new Date(clock + QUOTE_S * 1000).toISOString());
    expect(pr.fulfillment_deadline).toBe(new Date(clock + FULFILL_S * 1000).toISOString());
    // The permit is derived from the same clock read, so it still outlives settlement.
    const permit = prehashOf(pr).message;
    expect(Number(permit.deadline) * 1000).toBeGreaterThan(Date.parse(pr.fulfillment_deadline));
  });

  it('Solana: a slow cluster-clock read does not shorten the quote window', async () => {
    let clock = NOW_MS;
    const pr = await new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest({
      ...solanaOfflineParams(),
      requestId: 'req-stamp-after-solana-clock',
      now: () => clock,
      solanaClockReader: async () => {
        clock += 1_500;
        return BigInt(NOW_MS / 1000);
      },
    });

    expect(pr.quote_deadline).toBe(new Date(clock + QUOTE_S * 1000).toISOString());
  });

  it('refuses invalid deadline budgets before any network read', async () => {
    let fetches = 0;
    class CountingClient extends PaymentGatewayClient {
      async fetchChainDefaults(): Promise<ChainDefaults> {
        fetches += 1;
        return evmDefaults;
      }
    }

    await expect(
      new CountingClient({ BASE: 'https://gateway.example' }).preparePaymentRequest({
        ...evmParams(() => NOW_MS),
        quoteDeadlineSeconds: FULFILL_S,
      }),
    ).rejects.toThrow(/strictly less than/);
    expect(fetches).toBe(0);
  });
});

// pgc builds through the shared sender_auth SDK — request_id is the required idempotency key,
// the deposit nonce is derived deterministically from it (no random default), and the EVM/Tron
// permit deadline tracks the settlement horizon (not a far-future constant).
describe('required request_id + deterministic nonce + settlement-based deadline', () => {
  const permitOf = (pr: PaymentRequest) => prehashOf(pr).message;

  it('rejects a build with no request_id (no silent auto-generated id)', async () => {
    // requestId is required by the type; cast to simulate an untyped/JS caller omitting it,
    // proving the runtime guard also fires (defense in depth).
    const { requestId: _omit, ...noId } = offlineParams();
    await expect(
      new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest(noId as any),
    ).rejects.toThrow(/requestId is required/);
  });

  it('derives a deterministic nonce from request_id so a rebuild is idempotent', async () => {
    // No explicit nonce → the default is now derived from request_id + depositor, not random.
    const a = await prepareOffline();
    const b = await prepareOffline();
    expect(permitOf(a).nonce).toBe(permitOf(b).nonce); // same identity → same single-use nonce
    expect(permitOf(a).nonce).not.toBe('0');
  });

  it('defaults the EVM permit deadline to the settlement horizon (fulfillment_deadline + 1s), not the 2030 constant', async () => {
    const pr = await prepareOffline();
    const deadline = Number(permitOf(pr).deadline);
    // Absolute Unix seconds, derived from the SAME (injected) clock as fulfillment_deadline —
    // exactly one second past it, so the permit always outlives settlement and never drifts.
    const fulfillmentSec = Math.floor(Date.parse(pr.fulfillment_deadline) / 1000);
    expect(deadline).toBe(fulfillmentSec + 1);
    expect(deadline).toBe(Math.floor(NOW_MS / 1000) + FULFILL_S + 1);
    expect(deadline).not.toBe(1924991999); // the old fixed far-future default
  });

  it('rejects a deadlineSeconds shorter than the settlement window (permit would expire before settlement)', async () => {
    // fulfillmentDeadlineSeconds is FULFILL_S (3600); a 60s permit would expire long before settlement,
    // so the on-chain deposit pull would revert. Guard it, mirroring the quote-vs-fulfillment check.
    await expect(
      new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest({
        ...offlineParams(),
        deadlineSeconds: 60,
      }),
    ).rejects.toThrow(/before settlement/);
  });

  it('accepts a deadlineSeconds at least as long as the settlement window', async () => {
    const pr = await new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest({
      ...offlineParams(),
      deadlineSeconds: FULFILL_S + 1,
    });
    expect(Number(permitOf(pr).deadline)).toBe(Math.floor(NOW_MS / 1000) + FULFILL_S + 1);
  });

  it('accepts a permit deadline exactly equal to the settlement deadline (valid through its deadline)', async () => {
    // NOW_MS is a whole second, so deadlineSeconds === FULFILL_S makes the permit deadline land
    // exactly on fulfillment_deadline (ms-equal). The verifier rejects only permit < fulfillment,
    // and Permit2 is valid through its deadline, so equality is allowed — not rejected.
    const pr = await new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest({
      ...offlineParams(),
      deadlineSeconds: FULFILL_S,
    });
    expect(Number(permitOf(pr).deadline) * 1000).toBe(Date.parse(pr.fulfillment_deadline));
  });

  it('accepts deadlineSeconds === fulfillmentDeadlineSeconds on a SUB-SECOND clock (ms-precision regression)', async () => {
    // Regression: the guard used to floor a (second) clock read, so a non-whole-second `now`
    // put the permit a fraction BELOW fulfillment_deadline and threw — even though equality is
    // legal. 500ms remainder is exactly the case that only passed when fetch latency happened to
    // cross a second boundary. Reading the clock once + rounding the seconds up keeps the permit
    // at or above fulfillment regardless of the sub-second offset.
    const subSecondNow = Date.parse('2035-01-01T00:00:00.500Z');
    const pr = await new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest({
      ...offlineParams(),
      now: () => subSecondNow,
      deadlineSeconds: FULFILL_S,
    });
    // Must not throw, and the permit must never expire before settlement.
    expect(Number(permitOf(pr).deadline) * 1000).toBeGreaterThanOrEqual(
      Date.parse(pr.fulfillment_deadline),
    );
  });

  it('a rebuild at a later wall clock keeps the SAME nonce (retry-safe), though the deadline differs', async () => {
    // The real guarantee is "same single-use nonce", NOT "byte-identical output": a crash-then-retry
    // runs at a later time, so the deadline — and thus the signed bytes — differ, but the nonce depends
    // only on request_id + depositor, so it is identical and only one deposit can ever settle.
    const build = (nowMs: number) =>
      new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest({
        ...offlineParams(),
        now: () => nowMs,
      });
    const a = await build(NOW_MS);
    const b = await build(NOW_MS + 5000); // 5s later, as a real retry would be

    expect(permitOf(a).nonce).toBe(permitOf(b).nonce); // retry-safe: same single-use nonce
    expect(permitOf(a).deadline).not.toBe(permitOf(b).deadline); // deadline tracks the clock
    expect(a.sender_auth!.signed_messages![0]!.message).not.toBe(
      b.sender_auth!.signed_messages![0]!.message,
    );
  });

  it('Solana: a rebuild reproduces the SAME nonce, but re-read issued_at makes the signed bytes differ', async () => {
    // The Solana shape of retry-safety: the nonce is derived from request_id + depositor, so it is
    // identical across rebuilds — but Solana re-reads issued_at each build, so the deposit hash
    // (the signed bytes) differs, and on-chain the nonce only dedups while the program still
    // remembers it (256-512s, selected by issued_at). Contrast with EVM/Tron above, whose Permit2
    // nonce is permanent. Covers the Solana source path, which build-payment-request otherwise
    // never exercises.
    // Each build reads its own issued_at from the injected clock reader; with the wall clock both
    // builds would read the same instant.
    const solanaParams = (issuedAt: bigint) => ({
      ...solanaOfflineParams(issuedAt),
      requestId: 'req-sol-rebuild',
    });
    const solanaNonceOf = (pr: PaymentRequest) => prehashOf(pr).nonce as string;

    const client = new NoFetchClient({ BASE: 'https://gateway.invalid' });
    const a = await client.preparePaymentRequest(solanaParams(1700000000n));
    const b = await client.preparePaymentRequest(solanaParams(1700000200n)); // a later replay window

    expect(solanaNonceOf(a)).toBe(solanaNonceOf(b)); // same identity → same single-use nonce
    expect(solanaNonceOf(a)).not.toBe('0');
    // issued_at differs → different deposit hash → different signed bytes (not byte-identical).
    expect(a.sender_auth!.signed_messages![0]!.message).not.toBe(
      b.sender_auth!.signed_messages![0]!.message,
    );
  });
});

describe('preparePaymentRequest default fulfillment deadline', () => {
  const TRON_TOKEN = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const TRON_ACCOUNT = 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';

  const evm = { ...offlineParams(), fulfillmentDeadlineSeconds: undefined };
  const tron = {
    ...evm,
    sourceAsset: `tron:shasta/trc20:${TRON_TOKEN}`,
    depositor: TRON_ACCOUNT,
    requestId: 'req-default-tron',
  };
  const solana = {
    ...solanaOfflineParams(),
    fulfillmentDeadlineSeconds: undefined,
    requestId: 'req-default-solana',
  };
  const build = (params: Parameters<PaymentGatewayClient['preparePaymentRequest']>[0]) =>
    new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest(params);

  it.each([
    ['EVM', evm],
    ['Tron', tron],
    ['Solana', solana],
  ] as const)(
    '%s source: stamps now + the default when no deadline is passed',
    async (_, params) => {
      const pr = await build(params);
      expect(pr.fulfillment_deadline).toBe(
        new Date(NOW_MS + DEFAULT_FULFILLMENT_DEADLINE_SECONDS * 1000).toISOString(),
      );
    },
  );

  it.each([
    ['EVM', evm],
    ['Tron', tron],
  ] as const)(
    '%s source: the default permit deadline still outlives the default fulfillment deadline',
    async (_, params) => {
      const pr = await build(params);
      expect(Number(prehashOf(pr).message.deadline)).toBe(
        NOW_MS / 1000 + DEFAULT_FULFILLMENT_DEADLINE_SECONDS + 1,
      );
    },
  );

  it('Solana source: the deposit deadline follows the replay window, not the fulfillment deadline', async () => {
    const pr = await build(solana);
    const { issued_at, deadline } = prehashOf(pr);
    // Inside the escrow's replay window, which the default fulfillment window would overrun.
    expect(Number(deadline) - Number(issued_at)).toBeLessThanOrEqual(REPLAY_HORIZON_SECS);
    expect(Number(deadline) * 1000).toBeLessThan(Date.parse(pr.fulfillment_deadline));
  });

  it('passes an explicit fulfillment window shorter than the default through unchanged', async () => {
    const pr = await build({ ...evm, fulfillmentDeadlineSeconds: 60 });
    expect(pr.fulfillment_deadline).toBe(new Date(NOW_MS + 60 * 1000).toISOString());
  });
});

// max_source_amount is the payer's signed Permit2 ceiling in the SOURCE token's smallest units.
// The SDK has no honest way to derive it (it depends on a live quote and the source token's
// decimals), so it must refuse to build without one rather than invent a figure the payer then
// signs. Params here omit `resolvedDefaults`, so a build that reached the network would surface
// NoFetchClient's error instead: the refusal must happen before any fetch.
describe('preparePaymentRequest requires an explicit maxSourceAmount', () => {
  const SOURCE_ASSET = 'eip155:8453/erc20:0x0000000000000000000000000000000000000006';
  const DESTINATION_ASSET = 'eip155:42161/erc20:0x0000000000000000000000000000000000000008';
  const FETCH_REACHED = 'fetchChainDefaults must not be called';

  type PrepareParams = Parameters<PaymentGatewayClient['preparePaymentRequest']>[0];

  const baseParams = {
    depositor: '0x0000000000000000000000000000000000000005',
    fulfillmentAmount: '100000',
    sourceAsset: SOURCE_ASSET,
    destinationAccount: '0x0000000000000000000000000000000000000007',
    destinationAsset: DESTINATION_ASSET,
    requestId: 'req-cap',
  };

  // Params that violate the declared type are built untyped and cast at the call, so this file
  // type-checks whether or not maxSourceAmount is yet required by the signature.
  async function rejectionOf(params: Record<string, unknown>): Promise<Error> {
    const client = new NoFetchClient({ BASE: 'https://gateway.invalid' });
    let caught: unknown;
    try {
      await client.preparePaymentRequest(params as unknown as PrepareParams);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    return caught as Error;
  }

  it('rejects when maxSourceAmount is absent, naming the corridor and the capFromQuote remedy', async () => {
    const err = await rejectionOf({ ...baseParams });

    expect(err.message).toMatch(/^payment-gateway-client:/);
    // The corridor is echoed verbatim so the caller can see which quote the cap must come from.
    expect(err.message).toContain(SOURCE_ASSET);
    expect(err.message).toContain(DESTINATION_ASSET);
    expect(err.message).toContain('capFromQuote');
    expect(err.message).not.toContain(FETCH_REACHED);
  });

  it('rejects an explicit maxSourceAmount: undefined the same way as an absent key', async () => {
    const err = await rejectionOf({ ...baseParams, maxSourceAmount: undefined });

    expect(err.message).toMatch(/^payment-gateway-client:/);
    expect(err.message).toContain('capFromQuote');
    expect(err.message).not.toContain(FETCH_REACHED);
  });

  // Only a canonical positive decimal integer string is a faithful uint256 amount. Numbers are
  // refused outright: past 2^53 they are already rounded before the SDK ever sees them.
  it.each([
    ['empty string', ''],
    ['zero', '0'],
    ['leading zero', '01'],
    ['fraction', '1.5'],
    ['negative', '-5'],
    ['leading space', ' 5'],
    ['trailing space', '5 '],
    ['non-numeric', 'abc'],
    ['exponent notation', '1e6'],
    ['hex', '0x10'],
    ['number', 5],
    // eslint-disable-next-line no-loss-of-precision -- deliberately imprecise, to prove a pre-rounded number is refused
    ['unsafe number', 9007199254740993],
    ['null', null],
  ])('rejects a malformed maxSourceAmount (%s) before any fetch', async (_label, value) => {
    const err = await rejectionOf({ ...baseParams, maxSourceAmount: value });

    expect(err.message).toMatch(/^payment-gateway-client:/);
    expect(err.message).not.toContain(FETCH_REACHED);
  });
});

describe('preparePaymentRequest reads deposit_request_hash_versions', () => {
  async function prepareWith(
    source: ChainDefaults,
    windows: { quoteDeadlineSeconds?: number; fulfillmentDeadlineSeconds?: number } = {},
  ) {
    const {
      quoteDeadlineSeconds: _q,
      fulfillmentDeadlineSeconds: _f,
      ...params
    } = offlineParams(1n);
    return new NoFetchClient({ BASE: 'https://gateway.invalid' }).preparePaymentRequest({
      ...params,
      ...windows,
      resolvedDefaults: { ...params.resolvedDefaults, source },
    });
  }
  const committed = (pr: PaymentRequest) =>
    JSON.parse(pr.sender_auth!.signed_messages![0]!.message_prehash!).message.witness
      .depositRequestHash as string;
  const unsigned = (pr: PaymentRequest) => {
    const { sender_auth: _signed, ...body } = pr;
    return JSON.stringify(body);
  };
  const quoteWindowSeconds = (pr: PaymentRequest) =>
    (Date.parse(pr.quote_deadline) - NOW_MS) / 1000;

  it('commits v2 once the gateway lists only 2', async () => {
    const pr = await prepareWith({
      ...evmDefaults,
      depositRequestHashVersion: 2,
      depositRequestHashVersions: [2],
    });
    expect(committed(pr)).toBe(readDepositRequest(unsigned(pr)).depositRequestHashV2);
  });

  // The list decides when published, over the single version an older gateway sends.
  it('commits v1 when the list leaves 2 out', async () => {
    const pr = await prepareWith({
      ...evmDefaults,
      depositRequestHashVersion: 2,
      depositRequestHashVersions: [1],
    });
    expect(committed(pr)).toBe(readDepositRequest(unsigned(pr)).depositRequestHashV1);
  });

  it('refuses a chain whose list names no version this build signs', async () => {
    await expect(prepareWith({ ...evmDefaults, depositRequestHashVersions: [3] })).rejects.toThrow(
      /none of which this build signs/,
    );
  });

  // The window is stamped before the caller signs under either version, so v2 needs no longer one.
  it.each([
    ['v1', evmDefaults],
    ['v1 and v2', { ...evmDefaults, depositRequestHashVersions: [1, 2] }],
    ['v2', { ...evmDefaults, depositRequestHashVersions: [2] }],
  ])('stamps the same quote window when the gateway lists %s', async (_name, source) => {
    expect(quoteWindowSeconds(await prepareWith(source))).toBe(
      DEFAULT_PAYMENT_QUOTE_DEADLINE_SECONDS,
    );
  });

  it("keeps the caller's quote window when it signs v2", async () => {
    const pr = await prepareWith(
      { ...evmDefaults, depositRequestHashVersions: [2] },
      { quoteDeadlineSeconds: 5 },
    );
    expect(quoteWindowSeconds(pr)).toBe(5);
  });
});

describe('preparePaymentRequest refuses an originator-executed deposit', () => {
  it.each([
    ['the string form', 'originator' as const],
    [
      'the split form',
      { deposit: 'originator' as const, reserve: 'settler' as const, fulfill: 'settler' as const },
    ],
  ])(
    'refuses %s before any network call, pointing at prepareDirectDepositRequest',
    async (_label, executor) => {
      const { resolvedDefaults: _offline, ...fetching } = offlineParams();

      await expect(
        new NoFetchClient().preparePaymentRequest({ ...fetching, executor }),
      ).rejects.toThrow(/originator-executed deposit .* prepareDirectDepositRequest/);
    },
  );

  it('still accepts an originator fulfill leg on a settler deposit', async () => {
    const executor = {
      deposit: 'settler' as const,
      reserve: 'settler' as const,
      fulfill: 'originator' as const,
    };

    const pr = await new NoFetchClient().preparePaymentRequest({ ...offlineParams(), executor });

    expect(pr.executor).toEqual(executor);
  });
});
