/**
 * The facilitator judges a payment's expiry after its trust lookup, not only before it.
 *
 * The trust lookup is a network round trip of unbounded length. A payment that was live when
 * verify began can expire while that lookup is in flight, and relaying it afterwards submits a
 * deposit the escrow or the auction will refuse — or, worse, one the payer has already written off.
 * So the expiry that decides is the one read once the lookup has returned.
 *
 * A payment carries several deadlines; the earliest one that applies to its source chain is the
 * one that ends it. A deadline D has passed once the clock reads D or later.
 *
 * Every payment below is genuinely signed. The facilitator's trust source vouches for exactly
 * what the 402 names and moves the injected clock forward while it "looks up", which is the only
 * place time passes, so the deadline crossed during the lookup is the only thing that can refuse.
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { Network, PaymentPayload, PaymentRequirements } from '@x402/core/types';
import {
  AtumEscrowClientScheme,
  type TrustResolver,
  type SolanaSigner,
  type TrustedRoles,
} from '../client';
import { PAYMENT_IDENTIFIER } from '../payment-identifier';
import { AtumEscrowFacilitatorScheme, PAYMENT_EXPIRED, type PaymentSubmitter } from './index';

// Well-known anvil account #0 — a throwaway dev key, safe to commit.
const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const SIGN_AT_MS = Date.parse('2026-07-08T12:00:00Z');
// Verify begins shortly after signing, while every deadline is still ahead.
const VERIFY_STARTS_MS = SIGN_AT_MS + 10_000;
const named = {
  extensions: { [PAYMENT_IDENTIFIER]: { info: { required: true, id: 'pay_order_test_0001' } } },
};

const SOURCE: Network = 'eip155:8453';
const DEST: Network = 'eip155:42161';
const SOURCE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEST_ASSET = '0x52e52f345139e57b87d288c9ea794bb3fbe591c3';
const ESCROW = '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33';
const RESERVER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const RELEASER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const DEST_FULFILLMENT_PROXY = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

const USDC_6 = (address: string) => ({ symbol: 'USDC', address, decimals: 6 });

function evmRequirement(budgets: {
  quoteDeadlineSeconds: number;
  fulfillmentDeadlineSeconds: number;
}): PaymentRequirements {
  return {
    scheme: 'atum-escrow',
    network: SOURCE,
    asset: SOURCE_ASSET,
    amount: '10300000',
    payTo: ESCROW,
    maxTimeoutSeconds: 60,
    extra: {
      atumResource: 'GET /paid',
      atum: {
        destination: {
          network: DEST,
          asset: DEST_ASSET,
          address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        },
        fulfillmentAmount: '10000000',
        escrow: ESCROW,
        fulfillmentProxy: DEST_FULFILLMENT_PROXY,
        reserver: RESERVER,
        releaser: RELEASER,
        fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
        ...budgets,
      },
    },
  };
}

/** A trust source that vouches for exactly the roles and assets a 402 names. */
function trustingThe402(requirement: PaymentRequirements): TrustResolver {
  const atum = (requirement.extra as { atum: Record<string, any> }).atum;
  const roles = (tokenAddress: string): TrustedRoles => ({
    escrowContract: atum.escrow,
    quoteSelector: atum.reserver,
    fulfillmentVerifierAccount: atum.releaser,
    fulfillmentProxy: atum.fulfillmentProxy,
    tokens: [USDC_6(tokenAddress)],
  });
  return async (network: string) =>
    network === requirement.network ? roles(requirement.asset) : roles(atum.destination.asset);
}

function wrap(
  requirement: PaymentRequirements,
  result: Awaited<ReturnType<AtumEscrowClientScheme['createPaymentPayload']>>,
): PaymentPayload {
  return {
    x402Version: result.x402Version,
    accepted: requirement,
    payload: result.payload,
    extensions: result.extensions,
  } as unknown as PaymentPayload;
}

/** A genuinely signed EVM payment, signed at `signAtMs`. */
async function signedEvm(
  requirement: PaymentRequirements,
  signAtMs: number = SIGN_AT_MS,
): Promise<PaymentPayload> {
  const client = new AtumEscrowClientScheme({
    signer: wallet,
    now: () => signAtMs,
    trust: trustingThe402(requirement),
  });
  return wrap(requirement, await client.createPaymentPayload(2, requirement, named));
}

function paymentRequestOf(payment: PaymentPayload): Record<string, any> {
  return (payment.payload as { paymentRequest: Record<string, any> }).paymentRequest;
}

function quoteDeadlineMs(payment: PaymentPayload): number {
  return Date.parse(paymentRequestOf(payment).quote_deadline);
}

/** The deadline the payer signed into the deposit authorization, in epoch seconds. */
function signedDeadlineSec(payment: PaymentPayload): number {
  const prehash = JSON.parse(
    paymentRequestOf(payment).sender_auth.signed_messages[0].message_prehash,
  );
  // EVM nests it in the Permit2 typed-data message; Solana carries it at the top level.
  return Number(prehash.message?.deadline ?? prehash.deadline);
}

/** The facilitator's payee-check observer, typed from its own constructor option. */
type CommitmentObserver = NonNullable<
  ConstructorParameters<typeof AtumEscrowFacilitatorScheme>[0]['onCommitmentResult']
>;

/** A gateway that settles synchronously and counts how often it was asked to. */
function countingSubmitter(): PaymentSubmitter & { calls: number } {
  const submitter = {
    calls: 0,
    async submit() {
      submitter.calls++;
      return {
        payment_id: 'pay_abc',
        status: 'completed' as const,
        transactions: {
          deposit: { transaction_hash: '0x' + 'cd'.repeat(32), chain_id: SOURCE },
          fulfillment: { transaction_hash: '0x' + 'ab'.repeat(32), chain_id: DEST },
        },
      };
    },
  };
  return submitter;
}

/**
 * A facilitator with its own clock, starting at VERIFY_STARTS_MS. Its trust source vouches for
 * what the 402 names and, when asked, moves that clock to `lookupEndsMs` — the time a slow lookup
 * returns. Setting rather than adding keeps the source and destination lookups from compounding.
 * When given, `onCommitmentResult` receives every payee check the facilitator reports.
 */
function facilitatorWhoseLookupEndsAt(
  requirement: PaymentRequirements,
  lookupEndsMs: number,
  submitter: PaymentSubmitter = countingSubmitter(),
  onCommitmentResult?: CommitmentObserver,
): AtumEscrowFacilitatorScheme {
  const clock = { ms: VERIFY_STARTS_MS };
  const vouch = trustingThe402(requirement);
  const trust: TrustResolver = async (network: string) => {
    clock.ms = lookupEndsMs;
    return vouch(network);
  };
  return new AtumEscrowFacilitatorScheme({
    submitter,
    now: () => clock.ms,
    trust,
    ...(onCommitmentResult ? { onCommitmentResult } : {}),
  });
}

/** Assert verify refuses as expired, and that settle refuses it without submitting. */
async function expectExpired(
  payment: PaymentPayload,
  requirement: PaymentRequirements,
  lookupEndsMs: number,
): Promise<void> {
  const verified = await facilitatorWhoseLookupEndsAt(requirement, lookupEndsMs).verify(
    payment,
    requirement,
  );
  expect(verified.isValid).toBe(false);
  expect(verified.invalidReason).toBe(PAYMENT_EXPIRED);

  const submitter = countingSubmitter();
  const settled = await facilitatorWhoseLookupEndsAt(requirement, lookupEndsMs, submitter).settle(
    payment,
    requirement,
  );
  expect(settled.success).toBe(false);
  expect(settled.errorReason).toBe(PAYMENT_EXPIRED);
  expect(submitter.calls).toBe(0);
}

describe('PAYMENT_EXPIRED', () => {
  it("is the stable reason string 'payment_expired'", () => {
    expect(PAYMENT_EXPIRED).toBe('payment_expired');
  });
});

describe('AtumEscrowFacilitatorScheme — expiry during the trust lookup (EVM source)', () => {
  // The client derives the Permit2 deadline from the fulfillment budget, which the schema requires
  // to exceed the quote budget, so on a payment signed as built the quote deadline comes first.
  const requirement = evmRequirement({ quoteDeadlineSeconds: 20, fulfillmentDeadlineSeconds: 300 });

  it('refuses when the quote deadline passes while the lookup is in flight', async () => {
    const payment = await signedEvm(requirement);
    const quoteDeadline = quoteDeadlineMs(payment);
    expect(quoteDeadline).toBeGreaterThan(VERIFY_STARTS_MS);
    expect(quoteDeadline).toBeLessThan(signedDeadlineSec(payment) * 1000);

    await expectExpired(payment, requirement, quoteDeadline + 5_000);
  });

  it('refuses when the clock reaches exactly the earliest deadline during the lookup', async () => {
    const payment = await signedEvm(requirement);

    await expectExpired(payment, requirement, quoteDeadlineMs(payment));
  });

  it('accepts and settles once when the lookup ends one second before the earliest deadline', async () => {
    // Discriminator for the refusals: the same payment and the same slow lookup, ending just short.
    const payment = await signedEvm(requirement);
    const lookupEnds = quoteDeadlineMs(payment) - 1_000;

    const verified = await facilitatorWhoseLookupEndsAt(requirement, lookupEnds).verify(
      payment,
      requirement,
    );
    expect(verified.isValid, verified.invalidReason).toBe(true);

    const submitter = countingSubmitter();
    const settled = await facilitatorWhoseLookupEndsAt(requirement, lookupEnds, submitter).settle(
      payment,
      requirement,
    );
    expect(settled.success, settled.errorReason).toBe(true);
    expect(submitter.calls).toBe(1);
  });

  it('reports the payee check when the lookup ends one second before the earliest deadline', async () => {
    // Control for the refusal below: the observer is wired and fires for a live payment, so its
    // silence there is a property of the expiry, not of the wiring.
    const payment = await signedEvm(requirement);
    const observer = vi.fn<CommitmentObserver>();

    const verified = await facilitatorWhoseLookupEndsAt(
      requirement,
      quoteDeadlineMs(payment) - 1_000,
      countingSubmitter(),
      observer,
    ).verify(payment, requirement);

    expect(verified.isValid, verified.invalidReason).toBe(true);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it('does not report a payee check for a payment that expired during the lookup', async () => {
    // The observer receives the payee check of a payment the facilitator vouches for, or of one
    // that check itself refused. A payment that expired during the lookup is neither, so nothing
    // is reported for it.
    const payment = await signedEvm(requirement);
    const observer = vi.fn<CommitmentObserver>();

    const verified = await facilitatorWhoseLookupEndsAt(
      requirement,
      quoteDeadlineMs(payment) + 5_000,
      countingSubmitter(),
      observer,
    ).verify(payment, requirement);

    expect(verified.isValid).toBe(false);
    expect(verified.invalidReason).toBe(PAYMENT_EXPIRED);
    expect(observer).not.toHaveBeenCalled();
  });

  it('refuses when the signed Permit2 deadline passes while the lookup is in flight', async () => {
    // quote_deadline is not covered by the payer's signature, so it can arrive later than the
    // Permit2 deadline. Signing part-way through a second makes the Permit2 deadline (floored to
    // whole seconds) fall before fulfillment_deadline; quote_deadline is then placed between the
    // two, leaving the signed Permit2 deadline as the earliest one and the only one crossed.
    const signAt = SIGN_AT_MS + 600;
    const shortFulfillment = evmRequirement({
      quoteDeadlineSeconds: 20,
      fulfillmentDeadlineSeconds: 30,
    });
    const payment = JSON.parse(
      JSON.stringify(await signedEvm(shortFulfillment, signAt)),
    ) as PaymentPayload;
    const permitDeadline = signedDeadlineSec(payment) * 1000;
    const fulfillmentDeadline = Date.parse(paymentRequestOf(payment).fulfillment_deadline);
    expect(fulfillmentDeadline - permitDeadline).toBe(600);
    const laterQuote = permitDeadline + 500;
    paymentRequestOf(payment).quote_deadline = new Date(laterQuote).toISOString();

    // Discriminator: with the lookup ending before the Permit2 deadline, this payment verifies.
    const live = await facilitatorWhoseLookupEndsAt(
      shortFulfillment,
      permitDeadline - 1_000,
    ).verify(payment, shortFulfillment);
    expect(live.isValid, live.invalidReason).toBe(true);

    const lookupEnds = permitDeadline + 200;
    expect(lookupEnds).toBeLessThan(laterQuote);
    await expectExpired(payment, shortFulfillment, lookupEnds);
  });
});

// ── Solana source ────────────────────────────────────────────────────────────
const SOLANA: Network = 'solana:localnet';
const SOLANA_MINT = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
const SOLANA_ESCROW = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const SOLANA_RESERVER = 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq';
const SOLANA_RELEASER = 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY';
const solKeypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
const solanaSigner: SolanaSigner = {
  publicKey: bs58.encode(solKeypair.publicKey),
  async sign(message: Uint8Array): Promise<Uint8Array> {
    return nacl.sign.detached(message, solKeypair.secretKey);
  },
};

// Budgets long enough that the deposit authorization's fixed window from issued_at ends first.
const solanaRequirement: PaymentRequirements = {
  scheme: 'atum-escrow',
  network: SOLANA,
  asset: SOLANA_MINT,
  amount: '10300000',
  payTo: SOLANA_ESCROW,
  maxTimeoutSeconds: 60,
  extra: {
    atumResource: 'GET /paid',
    atum: {
      destination: {
        network: DEST,
        asset: DEST_ASSET,
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      },
      fulfillmentAmount: '10000000',
      escrow: SOLANA_ESCROW,
      fulfillmentProxy: DEST_FULFILLMENT_PROXY,
      reserver: SOLANA_RESERVER,
      releaser: SOLANA_RELEASER,
      fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
      quoteDeadlineSeconds: 200,
      fulfillmentDeadlineSeconds: 300,
      svmSignatureClusterId: 'localnet',
      svmSignatureDomainVersion: 5,
    },
  },
};

/** A genuinely signed Solana payment, its issue time pinned to the signing clock. */
async function signedSolana(requirement: PaymentRequirements): Promise<PaymentPayload> {
  const client = new AtumEscrowClientScheme({
    signer: solanaSigner,
    now: () => SIGN_AT_MS,
    trust: trustingThe402(requirement),
    solanaClockReader: async () => BigInt(Math.floor(SIGN_AT_MS / 1000)),
  });
  return wrap(requirement, await client.createPaymentPayload(2, requirement, named));
}

describe('AtumEscrowFacilitatorScheme — expiry during the trust lookup (Solana source)', () => {
  it('refuses when the signed deposit deadline passes while the lookup is in flight', async () => {
    const payment = await signedSolana(solanaRequirement);
    const depositDeadline = signedDeadlineSec(payment) * 1000;
    expect(depositDeadline).toBeGreaterThan(VERIFY_STARTS_MS);
    expect(depositDeadline).toBeLessThan(quoteDeadlineMs(payment));

    // Discriminator: with the lookup ending before the deposit deadline, this payment verifies.
    const live = await facilitatorWhoseLookupEndsAt(
      solanaRequirement,
      depositDeadline - 1_000,
    ).verify(payment, solanaRequirement);
    expect(live.isValid, live.invalidReason).toBe(true);

    const lookupEnds = depositDeadline + 500;
    expect(lookupEnds).toBeLessThan(quoteDeadlineMs(payment));
    await expectExpired(payment, solanaRequirement, lookupEnds);
  });
});
