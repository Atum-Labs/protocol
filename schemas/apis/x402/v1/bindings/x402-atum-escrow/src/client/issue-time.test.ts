/**
 * Where a Solana deposit's `issued_at` comes from.
 *
 * The Solana escrow bounds a deposit authorization by a replay window anchored on `issued_at`, so
 * the value the payer signs decides whether the deposit is landable at all. Two things follow.
 *
 * First, it is the payer's to determine, not the merchant's: a merchant that could dictate the
 * issue time could hand out authorizations that were already expired, or ones anchored far enough
 * ahead to stay landable long after the payer considered the payment abandoned. The 402 is remote,
 * unauthenticated input at this boundary, so a 402 that carries one is refused rather than
 * tolerated.
 *
 * Second, the payer's own wall clock is not the cluster's. Solana's on-chain clock lags real time
 * whenever slots run slow, so an authorization stamped with local time can be rejected on arrival
 * as being in the cluster's future. A payer that can read the cluster clock should use it verbatim;
 * a payer that cannot must back-date its own clock enough to stay behind a lagging cluster, which
 * costs it part of the replay window and is why the reader exists.
 *
 * `issued_at` is observable from the built payload: it is a field of the signed deposit prehash,
 * which the payload carries as JSON in `sender_auth.signed_messages[0].message_prehash`.
 */
import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { PaymentRequirements } from '@x402/core/types';
import { AtumEscrowClientScheme, type TrustResolver, type TrustedRoles } from './index';
import { PAYMENT_IDENTIFIER } from '../payment-identifier';
import type { SolanaSigner } from '../chain-adapters';

const SOLANA_NETWORK = 'solana:localnet';
const SOLANA_MINT = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
const SOLANA_ESCROW = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';

// Every payment names the purchase it is for; the client refuses to build one that does not.
const ANCHOR = 'pay_order_test_0001';
const named = { extensions: { [PAYMENT_IDENTIFIER]: { info: { required: true, id: ANCHOR } } } };

// The payer's local clock. The offset inside the second is deliberate: epoch seconds are reached
// by truncation, so a build that rounded instead of floored would land on a different second and
// this fixture would catch it.
const NOW_MS = Date.parse('2026-07-08T12:00:00.700Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

// A deterministic throwaway Ed25519 keypair stands in for the payer's Solana wallet.
const keypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
const pubkey = bs58.encode(keypair.publicKey);
const solanaSigner: SolanaSigner = {
  publicKey: pubkey,
  async sign(message: Uint8Array): Promise<Uint8Array> {
    return nacl.sign.detached(message, keypair.secretKey);
  },
};

/** A Solana-source 402 as a merchant builds it: corridor configuration only, no issue time. */
const solanaRequirement: PaymentRequirements = {
  scheme: 'atum-escrow',
  network: SOLANA_NETWORK,
  asset: SOLANA_MINT,
  amount: '10300000',
  payTo: SOLANA_ESCROW,
  maxTimeoutSeconds: 60,
  extra: {
    atumResource: 'GET /paid',
    atum: {
      destination: {
        network: 'eip155:42161',
        asset: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      },
      fulfillmentAmount: '10000000',
      escrow: SOLANA_ESCROW,
      fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      reserver: 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq',
      releaser: 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY',
      fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
      quoteDeadlineSeconds: 20,
      fulfillmentDeadlineSeconds: 300,
      svmSignatureClusterId: 'localnet',
      svmSignatureDomainVersion: 5,
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
  'solana:localnet': {
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

/** The `issued_at` the payer actually signed, read back out of the deposit prehash. */
async function signedIssuedAt(
  scheme: AtumEscrowClientScheme,
  requirement: PaymentRequirements = solanaRequirement,
): Promise<unknown> {
  const result = await scheme.createPaymentPayload(2, requirement, named);
  const pr = (
    result.payload as {
      paymentRequest: { sender_auth: { signed_messages: { message_prehash: string }[] } };
    }
  ).paymentRequest;
  return (JSON.parse(pr.sender_auth.signed_messages[0]!.message_prehash) as { issued_at: unknown })
    .issued_at;
}

describe('AtumEscrowClientScheme — the Solana issue time', () => {
  it('back-dates its own clock by 45 seconds when no cluster clock reader is configured', async () => {
    // 45 is written out rather than imported and subtracted. Deriving the expectation from the
    // same constant the production code reads would make the two agree by construction, and the
    // test could not tell a correct buffer from a wrong one.
    const scheme = new AtumEscrowClientScheme({ signer: solanaSigner, now: () => NOW_MS, trust });
    expect(await signedIssuedAt(scheme)).toBe(String(NOW_SECONDS - 45));
  });

  it('uses a configured cluster clock reader verbatim, called with the source chain id', async () => {
    // Verbatim means verbatim: the reader already speaks for the cluster, so subtracting the
    // local-clock safety buffer from it would throw away replay window for no reason, and the
    // value must not be re-rounded either.
    const CLUSTER_SECONDS = 1_899_999_999n;
    const chainIdsSeen: string[] = [];
    const scheme = new AtumEscrowClientScheme({
      signer: solanaSigner,
      now: () => NOW_MS,
      trust,
      solanaClockReader: async (chainId: string) => {
        chainIdsSeen.push(chainId);
        return CLUSTER_SECONDS;
      },
    });

    expect(await signedIssuedAt(scheme)).toBe('1899999999');
    // The reader is per-cluster — a payer paying from several Solana clusters needs to know which
    // clock is being asked for, so the chain id has to reach it.
    expect(chainIdsSeen).toEqual([SOLANA_NETWORK]);
  });

  it('refuses a 402 that dictates the issue time', async () => {
    const atum = (solanaRequirement.extra as { atum: Record<string, unknown> }).atum;
    const dictating: PaymentRequirements = {
      ...solanaRequirement,
      extra: { atumResource: 'GET /paid', atum: { ...atum, issuedAt: '1899999999' } },
    };
    const scheme = new AtumEscrowClientScheme({ signer: solanaSigner, now: () => NOW_MS, trust });

    await expect(scheme.createPaymentPayload(2, dictating, named)).rejects.toThrow(
      /invalid extra\.atum/,
    );

    // Discriminator: the same 402 with the dictated issue time removed is accepted. Without this,
    // the rejection above could be coming from an unrelated defect in the fixture and the test
    // would still be green.
    await expect(scheme.createPaymentPayload(2, solanaRequirement, named)).resolves.toBeDefined();
  });
});

// Bidding closes at quote_deadline, so the payer's own reads must not come out of the window: the
// deadlines are stamped from a clock read taken after the trust lookup and the cluster-clock read.
describe('AtumEscrowClientScheme — when the deadlines are stamped', () => {
  const QUOTE_BUDGET_MS = 20_000;

  async function signedQuoteDeadline(scheme: AtumEscrowClientScheme): Promise<string> {
    const result = await scheme.createPaymentPayload(2, solanaRequirement, named);
    return (result.payload as { paymentRequest: { quote_deadline: string } }).paymentRequest
      .quote_deadline;
  }

  it('after the trust lookup', async () => {
    let clock = NOW_MS;
    const scheme = new AtumEscrowClientScheme({
      signer: solanaSigner,
      now: () => clock,
      trust: async (network) => {
        clock += 3_000;
        return trust(network);
      },
    });

    const quoteDeadline = await signedQuoteDeadline(scheme);

    expect(quoteDeadline).toBe(new Date(clock + QUOTE_BUDGET_MS).toISOString());
  });

  it('after the cluster-clock read', async () => {
    let clock = NOW_MS;
    const scheme = new AtumEscrowClientScheme({
      signer: solanaSigner,
      now: () => clock,
      trust,
      solanaClockReader: async () => {
        clock += 1_500;
        return BigInt(NOW_SECONDS);
      },
    });

    const quoteDeadline = await signedQuoteDeadline(scheme);

    expect(quoteDeadline).toBe(new Date(clock + QUOTE_BUDGET_MS).toISOString());
  });
});
