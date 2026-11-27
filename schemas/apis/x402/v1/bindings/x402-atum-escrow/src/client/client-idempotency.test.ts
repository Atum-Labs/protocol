/**
 * Deposit idempotency on the payer side.
 *
 * The payment's `request_id` is derived from the identifier naming the purchase being paid for,
 * which the payer supplies in the `payment-identifier` extension, and the payment gateway
 * de-duplicates on that `request_id`. So a payer that rebuilds the payment for the same purchase
 * resolves to the ORIGINAL payment instead of being charged again.
 *
 * These tests run under a MOVING clock on purpose. The permit's deadline is derived from the wall
 * clock, so two rebuilds produce different signature bytes and therefore a different `payment_id`
 * — only `request_id` is stable across attempts, and it is the gateway's dedup key. Freezing the
 * clock would assert a byte-identical deposit, a property this system does not have in production.
 */
import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { PaymentRequirements } from '@x402/core/types';
import { deterministicFullRequestId } from '@atum-labs/payment-request-sender-auth';
import { AtumEscrowClientScheme, type TrustResolver, type TrustedRoles } from './index';
import { PAYMENT_IDENTIFIER, withPaymentIdentifier } from '../payment-identifier';
import type { SolanaSigner } from '../chain-adapters';

// The page every fixture requirement is published for, hashed as the request_id anchor folds it in.
const PAID_PAGE_HASH = ethers.keccak256(ethers.toUtf8Bytes('GET /paid')).slice(2);

// Well-known anvil account #0 — a throwaway dev key, safe to commit.
const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);

/**
 * A clock shared by every build in this file, advancing on each read. Production behaves this
 * way: two attempts at one payment happen seconds apart, so the permit deadline — and therefore
 * the signature — differs between them. A per-build clock would reset and hide that.
 */
const clock = (() => {
  let t = Date.parse('2026-07-08T12:00:00Z');
  return () => (t += 1_500);
})();

/**
 * Two conforming purchase identifiers. The extension permits 16-128 characters of letters,
 * digits, hyphen and underscore; a payer's shorter own reference is mapped onto a conforming
 * identifier before it reaches the scheme, so what arrives here always conforms.
 */
const ORDER_A = 'pay_order_4711_a1b2';
const ORDER_B = 'pay_order_4712_a1b2';

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
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': {
    escrowContract: '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',
    quoteSelector: 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq',
    fulfillmentVerifierAccount: 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY',
    fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    tokens: [
      { symbol: 'USDC', address: 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8', decimals: 6 },
    ],
  },
};
const trust: TrustResolver = async (network) => {
  const roles = TRUSTED_ROLES[network];
  if (roles === undefined) throw new Error(`no trusted roles declared for ${network}`);
  return roles;
};

/** The 402's extensions with the purchase named, as the payer's `fetch` wrapper leaves them. */
const naming = (id: string) => ({
  extensions: { [PAYMENT_IDENTIFIER]: { info: { required: true, id } } },
});

function evmRequirement(amount = '10300000'): PaymentRequirements {
  const atum: Record<string, unknown> = {
    destination: {
      network: 'eip155:42161',
      asset: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
      address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    },
    fulfillmentAmount: '10000000',
    escrow: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
    fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    reserver: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    releaser: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
    quoteDeadlineSeconds: 20,
    fulfillmentDeadlineSeconds: 300,
  };
  return {
    scheme: 'atum-escrow',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount,
    payTo: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
    maxTimeoutSeconds: 60,
    extra: { atumResource: 'GET /paid', atum },
  };
}

const prOf = (r: { payload: unknown }) =>
  (r.payload as { paymentRequest: Record<string, any> }).paymentRequest;

/**
 * Build a payment the way the framework does, and return its PaymentRequest. Omitting the
 * identifier is how the "payer named no purchase" case is exercised.
 */
async function build(id?: string, amount?: string) {
  const scheme = new AtumEscrowClientScheme({ signer: wallet, now: clock, trust });
  return prOf(
    await scheme.createPaymentPayload(
      2,
      evmRequirement(amount),
      id === undefined ? undefined : naming(id),
    ),
  );
}

describe('atum-escrow client — deposit idempotency', () => {
  it('reproduces the same request_id when the same purchase is paid again', async () => {
    // The property the whole mechanism rests on. An agent that re-attempts re-requests the
    // resource and receives a FRESH 402; as long as it names the same purchase, the rebuild lands
    // on the same payment.
    const first = await build(ORDER_A);
    const second = await build(ORDER_A);
    expect(second.request_id).toBe(first.request_id);
  });

  it('derives request_id through the shared SDK helper, not a local copy', async () => {
    // Pins that this client and mppx run ONE recipe. A local reimplementation would still be
    // stable, so the assertions above would not catch it — this one does.
    const pr = await build(ORDER_A);
    expect(pr.request_id).toBe(
      deterministicFullRequestId({
        anchor: `${ORDER_A}:${PAID_PAGE_HASH}`,
        account: wallet.address,
        prefix: 'req_x402_',
      }),
    );
    expect(pr.request_id.startsWith('req_x402_')).toBe(true);
  });

  it('gives two distinct purchases distinct request_ids, even with identical terms', async () => {
    // The inverse property. If these collided, the second purchase would be silently de-duplicated
    // as a retry: the payer receives twice and the merchant is paid once.
    const a = await build(ORDER_A);
    const b = await build(ORDER_B);
    expect(a.request_id).not.toBe(b.request_id);
  });

  it('keeps request_id stable even when the payment terms differ under one identifier', async () => {
    // request_id is the identity of the PURCHASE, not of the terms. This documents that binding:
    // re-pricing under a reused identifier de-duplicates onto the original payment, which is why
    // an identifier must never be reused across genuinely different purchases.
    const a = await build(ORDER_A, '10300000');
    const b = await build(ORDER_A, '10400000');
    expect(b.request_id).toBe(a.request_id);
  });

  it('refuses to build a payment for an unnamed purchase, naming what to supply', async () => {
    // Fail-closed. There is deliberately no generated fallback: one would look like an idempotency
    // key while letting every re-attempt become a second payment.
    await expect(build(undefined)).rejects.toThrow(/no purchase identifier/i);
    await expect(build(undefined)).rejects.toThrow(/payment-identifier/);
  });

  it('does NOT reproduce byte-identical deposits across rebuilds (only request_id is stable)', async () => {
    // The honest counterpart to the first test, and the reason the gateway's request_id dedup is
    // the load-bearing control: the permit deadline comes from the wall clock, so the signature —
    // and the payment_id derived from it — differ on every rebuild. An earlier version of this
    // suite froze the clock and asserted the opposite, which does not hold in production.
    const first = await build(ORDER_A);
    const second = await build(ORDER_A);
    expect(second.request_id).toBe(first.request_id);
    expect(second.sender_auth.signed_messages[0].signature).not.toBe(
      first.sender_auth.signed_messages[0].signature,
    );
  });

  it('derives the deposit nonce from the request_id, so the on-chain backstop follows it', async () => {
    // EVM/Tron get a second line of defence: the Permit2 nonce is single-use on-chain, so if the
    // gateway dedup were ever bypassed the duplicate deposit reverts. That only holds while the
    // nonce is derived from the request_id, which is what this pins.
    const a = await build(ORDER_A);
    const b = await build(ORDER_A);
    const nonceOf = (pr: Record<string, any>) =>
      JSON.parse(pr.sender_auth.signed_messages[0].message_prehash).message.nonce;
    expect(nonceOf(b)).toBe(nonceOf(a));
  });
});

describe('atum-escrow client — deposit idempotency (Solana source)', () => {
  const seed = new Uint8Array(32).fill(7);
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const solanaSigner: SolanaSigner = {
    publicKey: bs58.encode(keyPair.publicKey),
    sign: async (m: Uint8Array) => nacl.sign.detached(m, keyPair.secretKey),
  };

  function solanaRequirement(): PaymentRequirements {
    const atum: Record<string, unknown> = {
      destination: {
        network: 'eip155:42161',
        asset: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      },
      fulfillmentAmount: '10000000',
      escrow: '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',
      fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      reserver: 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq',
      releaser: 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY',
      fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
      quoteDeadlineSeconds: 20,
      fulfillmentDeadlineSeconds: 300,
      svmSignatureClusterId: 'localnet',
      svmSignatureDomainVersion: 5,
    };
    return {
      scheme: 'atum-escrow',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      asset: 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8',
      amount: '10300000',
      payTo: '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',
      maxTimeoutSeconds: 60,
      extra: { atumResource: 'GET /paid', atum },
    };
  }

  async function buildSolana(id?: string) {
    // A pinned cluster clock, so two rebuilds sign the same issued_at and the signed payloads
    // are comparable byte-for-byte. It is not what makes request_id stable: that is derived from
    // the purchase identifier and the payer alone, before any clock is read.
    const scheme = new AtumEscrowClientScheme({
      signer: solanaSigner,
      now: clock,
      trust,
      solanaClockReader: async () => BigInt(Math.floor(Date.parse('2026-07-08T12:00:00Z') / 1000)),
    });
    return prOf(
      await scheme.createPaymentPayload(
        2,
        solanaRequirement(),
        id === undefined ? undefined : naming(id),
      ),
    );
  }

  it('reproduces the same request_id across rebuilds', async () => {
    // Solana matters most here: its on-chain replay nonce is only remembered for 256-512s (the
    // authorization is valid for 128s), so the gateway's request_id dedup is the only durable
    // protection against a late retry.
    const first = await buildSolana(ORDER_A);
    const second = await buildSolana(ORDER_A);
    expect(second.request_id).toBe(first.request_id);
    expect(second.request_id).toBe(
      deterministicFullRequestId({
        anchor: `${ORDER_A}:${PAID_PAGE_HASH}`,
        account: solanaSigner.publicKey,
        prefix: 'req_x402_',
      }),
    );
  });

  it('refuses a payment for an unnamed purchase', async () => {
    await expect(buildSolana(undefined)).rejects.toThrow(/no purchase identifier/i);
  });

  it('derives a different request_id than an EVM payer naming the same purchase', async () => {
    // The account is folded into the derivation, so one order id paid from two different source
    // accounts must not collapse onto a single payment.
    const solana = await buildSolana(ORDER_A);
    const evm = await build(ORDER_A);
    expect(solana.request_id).not.toBe(evm.request_id);
  });
});

describe('naming the purchase when driving the client directly', () => {
  // Not every payer uses a payment-enabled fetch: one that fetches the 402 itself and calls
  // createPaymentPayload has to name the purchase on the 402 first. withPaymentIdentifier is how,
  // and it is the same function the fetch wrapper uses, so the two paths cannot drift.
  const unnamed402 = () => ({ accepts: [evmRequirement()], extensions: {} });

  /** Build a payment the way a payer driving the client directly does. */
  async function buildDirect(reference?: string) {
    const scheme = new AtumEscrowClientScheme({ signer: wallet, now: clock, trust });
    const named = withPaymentIdentifier(unnamed402(), reference);
    return prOf(
      await scheme.createPaymentPayload(2, named.accepts[0], { extensions: named.extensions }),
    );
  }

  it("carries the caller's reference into request_id", async () => {
    const pr = await buildDirect(ORDER_A);
    expect(pr.request_id).toBe(
      deterministicFullRequestId({
        anchor: `${ORDER_A}:${PAID_PAGE_HASH}`,
        account: wallet.address,
        prefix: 'req_x402_',
      }),
    );
  });

  it('lands two attempts at one purchase on the same payment', async () => {
    // The regression this guards: a direct-drive path that accepted a reference and dropped it
    // still built a valid payment, so nothing failed — it just charged twice on retry.
    const first = await buildDirect(ORDER_A);
    const second = await buildDirect(ORDER_A);
    expect(second.request_id).toBe(first.request_id);
  });

  it('keeps two purchases apart', async () => {
    const a = await buildDirect(ORDER_A);
    const b = await buildDirect(ORDER_B);
    expect(a.request_id).not.toBe(b.request_id);
  });

  it('refuses to build when neither the caller nor the resource server named the purchase', async () => {
    await expect(buildDirect(undefined)).rejects.toThrow(/was not told which purchase/i);
  });

  it('agrees with the fetch wrapper: a server-named purchase needs no caller reference', () => {
    const server402 = { accepts: [evmRequirement()], ...naming(ORDER_A) };
    // Returned by identity — the server's declaration is not copied or rewritten.
    expect(withPaymentIdentifier(server402, undefined)).toBe(server402);
    expect(withPaymentIdentifier(server402, ORDER_A)).toBe(server402);
    expect(() => withPaymentIdentifier(server402, ORDER_B)).toThrow(/already named it/i);
  });
});
