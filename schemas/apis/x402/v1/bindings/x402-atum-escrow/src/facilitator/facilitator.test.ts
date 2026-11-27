/**
 * Unit tests for the atum-escrow facilitator mechanism. `verify` is exercised
 * against a real signed payload (built by the client scheme from a requirement the
 * server scheme produced), and `settle` against a mocked gateway — so the whole
 * mechanism is testable offline, with no chain and no payment-gateway SDK.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { AtumEscrowServerScheme, atumEscrowPrice, type AtumEscrowServerConfig } from '../server';
import { buildRequirement } from '../server/test-support';
import { AtumEscrowClientScheme, type TrustResolver, type TrustedRoles } from '../client';
import type { SolanaSigner } from '../chain-adapters';
import {
  getChainAdapter as senderAuthAdapter,
  readDepositRequest,
  type CommitmentResult,
} from '@atum-labs/payment-request-sender-auth';
import { toSenderSigner } from '../client/sender-signer';
import { atumEscrowRequestId } from '../request-id';
import { PAYMENT_IDENTIFIER } from '../payment-identifier';
import {
  AtumEscrowFacilitatorScheme,
  PaymentRejectedError,
  SETTLEMENT_FAILED,
  SETTLEMENT_NOT_ACCEPTED,
  SETTLEMENT_PENDING,
  type AtumEscrowFacilitatorConfig,
  type PaymentSubmitter,
  type SettleAt,
} from './index';

const SOURCE_NETWORK = 'eip155:8453';
const SOURCE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEST_NETWORK = 'eip155:42161';

const serverConfig: AtumEscrowServerConfig = {
  destination: {
    network: DEST_NETWORK,
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
  'solana:localnet': {
    escrowContract: '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',
    quoteSelector: 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq',
    fulfillmentVerifierAccount: 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY',
    fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    tokens: [
      { symbol: 'USDC', address: 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8', decimals: 6 },
    ],
  },
  'tron:shasta': {
    escrowContract: 'TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py',
    quoteSelector: 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N',
    fulfillmentVerifierAccount: 'T9yD14NjG6wxkArbchsTBKawgUVqYww3tQ',
    fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    tokens: [{ symbol: 'USDT', address: 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs', decimals: 6 }],
  },
};
const trust: TrustResolver = async (network) => {
  const roles = TRUSTED_ROLES[network];
  if (roles === undefined) throw new Error(`no trusted roles declared for ${network}`);
  return roles;
};

// Well-known anvil account #0 — a throwaway dev key, safe to commit.
const PAYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const wallet = new ethers.Wallet(PAYER_KEY);

// A gateway that always settles synchronously: a completed payment with its transactions.
const okSubmitter: PaymentSubmitter = {
  submit: async () => ({
    payment_id: 'pay_abc',
    status: 'completed',
    transactions: {
      deposit: { transaction_hash: '0x' + 'cd'.repeat(32), chain_id: SOURCE_NETWORK },
      fulfillment: { transaction_hash: '0x' + 'ab'.repeat(32), chain_id: DEST_NETWORK },
    },
  }),
};
// A gateway whose settlement goes async (a payment_id and a pending status, no payout yet).
const pendingSubmitter: PaymentSubmitter = {
  submit: async () => ({ payment_id: 'pay_pending', status: 'pending', transactions: undefined }),
};
// An older gateway that reports no status at all — the field is optional.
const statuslessSubmitter: PaymentSubmitter = {
  submit: async () => ({ payment_id: 'pay_nostatus', transactions: undefined }),
};
// A gateway reporting the payment reached a terminal failure.
const failedSubmitter: PaymentSubmitter = {
  submit: async () => ({ payment_id: 'pay_dead', status: 'failed', transactions: undefined }),
};
// A gateway reporting the payment was refunded, or that its refund is the payer's to submit.
const refundedSubmitter: PaymentSubmitter = {
  submit: async () => ({ payment_id: 'pay_refunded', status: 'refunded', transactions: undefined }),
};
const refundAvailableSubmitter: PaymentSubmitter = {
  submit: async () => ({
    payment_id: 'pay_refund_available',
    status: 'refund_available',
    transactions: undefined,
  }),
};
// A gateway reporting the payment is on chain but not yet final, without passing the payout
// transaction through (an adapter that predates `transactions`).
const finalizingSubmitter: PaymentSubmitter = {
  submit: async () => ({
    payment_id: 'pay_finalizing',
    status: 'finalizing',
    transactions: undefined,
  }),
};
const PAYOUT_HASH = '0x' + 'ef'.repeat(32);
// A gateway reporting the payout mined but not yet final, with the transaction to follow.
const finalizingWithTxSubmitter: PaymentSubmitter = {
  submit: async () => ({
    payment_id: 'pay_finalizing_tx',
    status: 'finalizing',
    transactions: {
      fulfillment: { transaction_hash: PAYOUT_HASH, chain_id: DEST_NETWORK, block_number: 123 },
    },
  }),
};
// A gateway reporting the settler gave up and the refund is under way — NOT terminal.
const refundingSubmitter: PaymentSubmitter = {
  submit: async () => ({
    payment_id: 'pay_refunding',
    status: 'refunding',
    transactions: undefined,
  }),
};
// A gateway that acknowledges the call but identifies no payment at all.
const emptySubmitter: PaymentSubmitter = { submit: async () => ({ transactions: undefined }) };
// A gateway refusing the payment on the caller's account (the 409 the terms fingerprint raises).
const rejectingSubmitter: PaymentSubmitter = {
  submit: async () => {
    throw new PaymentRejectedError(
      'IDEMPOTENCY_TERMS_MISMATCH',
      'request_id was already used for a payment with different economics',
    );
  },
};
// A gateway that is simply broken. Must NOT be dressed up as a payment outcome.
const brokenSubmitter: PaymentSubmitter = {
  submit: async () => {
    throw new Error('payment-gw POST /v1/payments failed: 503 Service Unavailable');
  },
};
// A gateway spy that records whether it was asked to submit — used to prove that
// `settle` refuses to relay a request that fails verification (it never reaches submit).
function spySubmitter(): PaymentSubmitter & { calls: number } {
  const spy = {
    calls: 0,
    async submit() {
      spy.calls++;
      return { transactions: undefined };
    },
  };
  return spy;
}

// Fixed clock just after signing time, so the fixture's deadlines are still ahead.
const NOW = () => Date.parse('2026-07-08T12:00:10Z');
function makeFacilitator(
  submitter: PaymentSubmitter,
  statusUrlFor?: (paymentId: string) => string | undefined,
  settleAt?: SettleAt,
): AtumEscrowFacilitatorScheme {
  return new AtumEscrowFacilitatorScheme({
    submitter,
    now: NOW,
    trust,
    ...(statusUrlFor ? { statusUrlFor } : {}),
    ...(settleAt ? { settleAt } : {}),
  });
}

/**
 * The identifier every fixture payment names its purchase with. Conforming to the extension's
 * format (16-128 characters of letters, digits, hyphen and underscore), as the payer's own
 * reference is mapped onto one before it reaches the client.
 */
const PURCHASE_ID = 'pay_order_test_0001';

/** The 402's extensions with the purchase named, as the payer's `fetch` wrapper leaves them. */
const naming = (id: string) => ({
  extensions: { [PAYMENT_IDENTIFIER]: { info: { required: true, id } } },
});

/** The same payment with the purchase identifier stripped off its payload. */
function withoutIdentifier(p: PaymentPayload): PaymentPayload {
  const clone = JSON.parse(JSON.stringify(p)) as { extensions?: Record<string, unknown> };
  delete clone.extensions?.[PAYMENT_IDENTIFIER];
  return clone as PaymentPayload;
}

/** The `extensions.atum` block a settle response carries, read the way a caller would. */
function atumExtension(res: { extensions?: Record<string, unknown> }) {
  return res.extensions?.atum as
    { paymentId?: string; state?: string; statusUrl?: string } | undefined;
}

let requirement: PaymentRequirements;
let payload: PaymentPayload;

beforeAll(async () => {
  const server = new AtumEscrowServerScheme(serverConfig);
  const client = new AtumEscrowClientScheme({
    signer: wallet,
    now: () => Date.parse('2026-07-08T12:00:00Z'),
    trust,
  });
  const priced = await server.parsePrice(atumEscrowPrice(serverConfig), SOURCE_NETWORK);
  ({ requirement } = await buildRequirement(server, {
    scheme: 'atum-escrow',
    network: SOURCE_NETWORK,
    asset: priced.asset,
    amount: priced.amount,
    payTo: '',
    maxTimeoutSeconds: 60,
    extra: {},
  }));
  const result = await client.createPaymentPayload(2, requirement, naming(PURCHASE_ID));
  payload = {
    x402Version: result.x402Version,
    accepted: requirement,
    payload: result.payload,
    extensions: result.extensions,
  } as unknown as PaymentPayload;
});

/**
 * A relayer that rewrites the payee and serves a requirement naming that same payee passes every
 * receive-side check, so only the destination the payer signed can refuse the payment.
 */
async function expectPayeeSwapRefused(
  original: PaymentPayload,
  originalRequirement: PaymentRequirements,
): Promise<void> {
  const attacker = '0x' + 'a1'.repeat(20);
  const swapped = JSON.parse(JSON.stringify(originalRequirement));
  swapped.extra.atum.destination.address = attacker;
  const bad = JSON.parse(JSON.stringify(original));
  bad.payload.paymentRequest.destination[0].account = attacker;
  bad.accepted = swapped;

  const res = await makeFacilitator(okSubmitter).verify(bad, swapped);
  expect(res.isValid).toBe(false);
  expect(res.invalidReason).toMatch(/the payer signed a deposit payable to/);

  const spy = spySubmitter();
  const settled = await makeFacilitator(spy).settle(bad, swapped);
  expect(settled.success).toBe(false);
  expect(spy.calls).toBe(0);
}

/**
 * A reader matching member names case-insensitively would see the second payee, so a request that
 * spells `destination` two ways is refused and never relayed.
 */
async function expectCaseTwinRefused(
  original: PaymentPayload,
  originalRequirement: PaymentRequirements,
): Promise<void> {
  const bad = JSON.parse(JSON.stringify(original));
  const pr = bad.payload.paymentRequest;
  pr.Destination = [
    { ...pr.destination[0], account: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' },
  ];

  const res = await makeFacilitator(okSubmitter).verify(bad, originalRequirement);
  expect(res.isValid).toBe(false);
  expect(res.invalidReason).toMatch(
    /two members that differ only in letter case, at \$\.Destination/,
  );

  const spy = spySubmitter();
  const settled = await makeFacilitator(spy).settle(bad, originalRequirement);
  expect(settled.success).toBe(false);
  expect(spy.calls).toBe(0);
}

// Deep-clone a payload and expose its paymentRequest for tampering.
function tamperedPayload(mutate: (pr: Record<string, unknown>) => void): PaymentPayload {
  const clone = JSON.parse(JSON.stringify(payload));
  mutate(clone.payload.paymentRequest);
  return clone as PaymentPayload;
}

describe('AtumEscrowFacilitatorScheme', () => {
  it('advertises no signers (keyless gateway) and the all-families wildcard', () => {
    const f = makeFacilitator(okSubmitter);
    expect(f.getSigners(SOURCE_NETWORK)).toEqual([]);
    // Multichain (eip155 + solana + tron), keyless — caipFamily is the (always-empty) signer
    // bucket label; "*" is honest where a single "eip155:*" would misrepresent /supported.
    expect(f.caipFamily).toBe('*');
    expect(f.scheme).toBe('atum-escrow');
  });

  it('verifies a valid payment and returns the payer', async () => {
    const f = makeFacilitator(okSubmitter);
    const res = await f.verify(payload, requirement);
    expect(res.isValid).toBe(true);
    expect(res.payer).toBe(wallet.address);
  });

  it('rejects a payment whose signer does not match the claimed source account', async () => {
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedPayload((pr) => {
      (pr.source as Record<string, unknown>).account = '0x000000000000000000000000000000000000dEaD';
    });
    const res = await f.verify(bad, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toBeTruthy();
  });

  it('rejects a payment whose max_source_amount exceeds the requirement cap', async () => {
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedPayload((pr) => {
      pr.max_source_amount = (BigInt(requirement.amount) + 1n).toString();
    });
    const res = await f.verify(bad, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/max_source_amount|cap|amount/i);
  });

  it('rejects a payload declaring a message_scheme the facilitator does not implement', async () => {
    const f = makeFacilitator(okSubmitter);
    // A structurally-valid payload carrying a genuine EVM_PERMIT2 signature, but
    // relabeled with a scheme this facilitator does not verify. A verifier that
    // ignores message_scheme would still EVM-recover the payer and accept it; the
    // dispatch must reject it up front (signature-scheme confusion guard).
    const bad = tamperedPayload((pr) => {
      (pr.sender_auth as Record<string, unknown>).message_scheme = 'EVM_PERMIT2_ESCROW';
    });
    const res = await f.verify(bad, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/message_scheme/i);
  });

  it('refuses a payee swapped in both the request and the requirement, and never relays it', async () => {
    await expectPayeeSwapRefused(payload, requirement);
  });

  // A contract account (ERC-1271, such as a Safe) signs with an owner key, so its signer never
  // recovers to the payer. The facilitator recovers the signer off chain and refuses it.
  it('refuses a contract-account payer, whose owner key signs', async () => {
    const safe = '0x5afe5afe5afe5afe5afe5afe5afe5afe5afe5afe';
    const client = new AtumEscrowClientScheme({
      signer: {
        getAddress: async () => safe,
        signTypedData: (domain, types, message) => wallet.signTypedData(domain, types, message),
      },
      now: () => Date.parse('2026-07-08T12:00:00Z'),
      trust,
    });
    const result = await client.createPaymentPayload(2, requirement, naming(PURCHASE_ID));
    const safePayload = {
      x402Version: result.x402Version,
      accepted: requirement,
      payload: result.payload,
      extensions: result.extensions,
    } as unknown as PaymentPayload;
    const pr = (safePayload.payload as { paymentRequest: { source: { account: string } } })
      .paymentRequest;
    expect(pr.source.account).toBe(safe);
    const res = await makeFacilitator(okSubmitter).verify(safePayload, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/does not recover to the payment's source account/);
  });

  it('reports every payee check to onCommitmentResult', async () => {
    const seen: string[] = [];
    const f = new AtumEscrowFacilitatorScheme({
      submitter: okSubmitter,
      now: NOW,
      trust,
      onCommitmentResult: (_result, fields) => seen.push(fields.sender_auth_result!),
    });
    expect((await f.verify(payload, requirement)).isValid).toBe(true);
    const swapped = tamperedPayload((pr) => {
      (pr.destination as Array<Record<string, unknown>>)[0]!.account =
        '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
    });
    expect((await f.verify(swapped, requirement)).isValid).toBe(false);
    expect(seen).toEqual(['verified', 'destination_mismatch']);

    const throwing = new AtumEscrowFacilitatorScheme({
      submitter: okSubmitter,
      now: NOW,
      trust,
      onCommitmentResult: () => {
        throw new Error('metrics backend down');
      },
    });
    // On an admission the payment is refused with a fixed reason, and settle never submits.
    const refused = await throwing.verify(payload, requirement);
    expect(refused.isValid).toBe(false);
    expect(refused.invalidReason).toBe(
      'atum-escrow: the payment could not be recorded, so it is refused',
    );
    const spy = spySubmitter();
    const settled = await new AtumEscrowFacilitatorScheme({
      submitter: spy,
      now: NOW,
      trust,
      onCommitmentResult: () => {
        throw new Error('metrics backend down');
      },
    }).settle(payload, requirement);
    expect(settled.success).toBe(false);
    expect(spy.calls).toBe(0);
    // On a refusal the refusal stands as it was.
    const stillRefused = await throwing.verify(swapped, requirement);
    expect(stillRefused.invalidReason).toMatch(/the payer signed a deposit payable to/);
  });

  it('refuses an EVM payment relabelled with the Solana scheme', async () => {
    const bad = tamperedPayload((pr) => {
      (pr.sender_auth as Record<string, unknown>).message_scheme = 'SOLANA';
    });
    const res = await makeFacilitator(okSubmitter).verify(bad, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/unsupported message_scheme for eip155:8453: SOLANA/);
  });

  it('rejects a payment whose fulfillment_verifier.endpoint was pointed at an internal URL (SSRF)', async () => {
    // The endpoint is a payer-controlled URL a settler may fetch, and no source signature
    // covers it. Repointing it at cloud metadata must be caught at verify, not relayed.
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedPayload((pr) => {
      (pr.fulfillment_verifier as Record<string, unknown>).endpoint =
        'http://169.254.169.254/latest/meta-data/';
    });
    const res = await f.verify(bad, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/endpoint/i);
  });

  it('rejects a payment whose fulfillment_proxy was aimed at an unadvertised address', async () => {
    // fulfillment_proxy is a top-level routing field the source signature does not cover;
    // a tampered value must not be relayed to the settler network.
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedPayload((pr) => {
      pr.fulfillment_proxy = '0x000000000000000000000000000000000000dEaD';
    });
    const res = await f.verify(bad, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/fulfillment_proxy/i);
  });

  it('rejects a payment whose source.asset_identifier contradicts the requirement', async () => {
    // The signed permit token is bound by the SDK, but the top-level source.asset_identifier
    // string is payer-controlled and unsigned. A value that disagrees with the verified
    // corridor must not earn an isValid:true vouch.
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedPayload((pr) => {
      (pr.source as Record<string, unknown>).asset_identifier =
        'eip155:8453/erc20:0x0000000000000000000000000000000000000bad';
    });
    const res = await f.verify(bad, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/source asset|asset_identifier/i);
  });

  it("rejects a payment whose quote_deadline exceeds the merchant's advertised budget", async () => {
    // The merchant offered quoteDeadlineSeconds=20, but the payer controls the absolute
    // timestamps. Push both deadlines an hour/two out: ordering still holds, yet the quote
    // window is 180x the offer — it must be bound to the budget, not just ordered.
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedPayload((pr) => {
      pr.quote_deadline = new Date(NOW() + 3_600_000).toISOString();
      pr.fulfillment_deadline = new Date(NOW() + 7_200_000).toISOString();
    });
    const res = await f.verify(bad, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/quote_deadline|budget/i);
  });

  it("rejects a payment whose fulfillment_deadline exceeds the merchant's advertised budget", async () => {
    // quote_deadline stays within the 20s offer; only fulfillment_deadline is inflated past its
    // 300s budget (ordering still holds), extending the settlement horizon beyond the offer.
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedPayload((pr) => {
      pr.fulfillment_deadline = new Date(NOW() + 3_600_000).toISOString();
    });
    const res = await f.verify(bad, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/fulfillment_deadline|budget/i);
  });

  // The compatibility headers: who built the request and its v2 as relayed.
  it('hands the submitter the producer and the v2 of the request it relays', async () => {
    const contexts: unknown[] = [];
    const relayed: string[] = [];
    const f = makeFacilitator({
      submit: async (request, context) => {
        relayed.push(JSON.stringify(request));
        contexts.push(context);
        return okSubmitter.submit(request);
      },
    });
    expect((await f.settle(payload, requirement)).success).toBe(true);
    expect(contexts).toEqual([
      {
        shadow: {
          producer: 'x402',
          depositRequestHashV2: readDepositRequest(relayed[0]!).depositRequestHashV2,
        },
      },
    ]);
  });

  it('settles by relaying to the gateway and maps the payout transaction', async () => {
    const f = makeFacilitator(okSubmitter);
    const res = await f.settle(payload, requirement);
    expect(res.success).toBe(true);
    expect(res.transaction).toBe('0x' + 'ab'.repeat(32));
    expect(res.network).toBe(DEST_NETWORK);
    expect(res.payer).toBe(wallet.address);
    expect(atumExtension(res)).toMatchObject({ paymentId: 'pay_abc', state: 'completed' });
  });

  it('reports an async settlement as pending, carrying the payment id to poll', async () => {
    // x402 has no pending outcome, so an accepted-but-unfinished settlement has to travel as
    // success:false — the merchant must not release the goods yet. What it must not look like
    // is a payment that never happened: funds may already be moving, so the response names a
    // distinct reason and hands back the id, and the reader polls instead of paying again.
    const f = makeFacilitator(pendingSubmitter);
    const res = await f.settle(payload, requirement);
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe(SETTLEMENT_PENDING);
    expect(atumExtension(res)).toMatchObject({ paymentId: 'pay_pending', state: 'pending' });
    // Verification ran before the relay, so the payer is known even with nothing settled.
    expect(res.payer).toBe(wallet.address);
  });

  it('settles at finalizing by default, with the payout transaction and its state', async () => {
    // The payout is on chain, not yet final. The default serves the resource now and tells the
    // merchant so through `state`, with the transaction to follow.
    const f = makeFacilitator(finalizingWithTxSubmitter, (id) => `https://gw.test/${id}`);
    const res = await f.settle(payload, requirement);
    expect(res.success).toBe(true);
    expect(res.transaction).toBe(PAYOUT_HASH);
    expect(res.network).toBe(DEST_NETWORK);
    expect(res.payer).toBe(wallet.address);
    expect(atumExtension(res)).toEqual({
      paymentId: 'pay_finalizing_tx',
      state: 'finalizing',
      statusUrl: 'https://gw.test/pay_finalizing_tx',
    });
  });

  it("with settleAt 'completed', a finalizing payment is still pending", async () => {
    const f = makeFacilitator(finalizingWithTxSubmitter, undefined, 'completed');
    const res = await f.settle(payload, requirement);
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe(SETTLEMENT_PENDING);
    expect(atumExtension(res)).toMatchObject({
      paymentId: 'pay_finalizing_tx',
      state: 'finalizing',
    });
  });

  it('never reports success for a failed payment, even with a payout transaction', async () => {
    // A payout a reorganization dropped leaves the payment failed with the old transaction listed.
    const failedWithTx: PaymentSubmitter = {
      submit: async () => ({
        payment_id: 'pay_dropped',
        status: 'failed',
        transactions: { fulfillment: { transaction_hash: PAYOUT_HASH, chain_id: DEST_NETWORK } },
      }),
    };
    const res = await makeFacilitator(failedWithTx).settle(payload, requirement);
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe(SETTLEMENT_FAILED);
  });

  it('makes an adapter state transactions, so the faster answer cannot be dropped silently', () => {
    // @ts-expect-error transactions is a required key: pass the gateway's value, or undefined
    const missing: Awaited<ReturnType<PaymentSubmitter['submit']>> = {
      payment_id: 'p',
      status: 'pending',
    };
    const stated: Awaited<ReturnType<PaymentSubmitter['submit']>> = {
      payment_id: 'p',
      status: 'pending',
      transactions: undefined,
    };
    expect([missing, stated]).toHaveLength(2);
  });

  describe('status decides, never the presence of a payout', () => {
    const FULFILLMENT = { transaction_hash: PAYOUT_HASH, chain_id: DEST_NETWORK };
    const settleWith = (
      result: Awaited<ReturnType<PaymentSubmitter['submit']>>,
      settleAt?: SettleAt,
    ) =>
      makeFacilitator(
        { submit: async () => result },
        (id) => `https://gw.test/${id}`,
        settleAt,
      ).settle(payload, requirement);

    it('reports pending for a completed status that names no payout transaction, and says so', async () => {
      // The payer is told to wait (never that it failed), and that the payout is not reported yet.
      // The payer cannot act on the cause, so the message names none.
      const res = await settleWith({
        payment_id: 'pay_e',
        status: 'completed',
        transactions: undefined,
      });
      expect(res.success).toBe(false);
      expect(res.errorReason).toBe(SETTLEMENT_PENDING);
      expect(res.errorMessage).toMatch(
        /The payment is completed, but its payout is not reported yet/,
      );
      expect(res.errorMessage).not.toMatch(/submitter/);
    });

    it.each([
      ['finalizing', { deposit: FULFILLMENT }],
      ['completed', { fulfillment: { ...FULFILLMENT, chain_id: '' } }],
    ] as const)(
      'reports pending, saying the payout is not reported yet, for %s with transactions %j',
      async (status, transactions) => {
        const res = await settleWith({ payment_id: 'pay_m', status, transactions });
        expect(res.success).toBe(false);
        expect(res.errorReason).toBe(SETTLEMENT_PENDING);
        expect(res.errorMessage).toMatch(/its payout is not reported yet/);
      },
    );

    it('says nothing about a missing payout while the payment is genuinely in flight', async () => {
      const res = await settleWith({
        payment_id: 'pay_q',
        status: 'pending',
        transactions: undefined,
      });
      expect(res.errorReason).toBe(SETTLEMENT_PENDING);
      expect(res.errorMessage).not.toMatch(/payout is not reported/);
    });

    it('reports pending for a payout hash on a pending payment', async () => {
      const res = await settleWith({
        payment_id: 'pay_p',
        status: 'pending',
        transactions: { fulfillment: FULFILLMENT },
      });
      expect(res.success).toBe(false);
      expect(res.errorReason).toBe(SETTLEMENT_PENDING);
    });

    it('reports pending for a payout hash with no status', async () => {
      const res = await settleWith({
        payment_id: 'pay_n',
        transactions: { fulfillment: FULFILLMENT },
      });
      expect(res.success).toBe(false);
      expect(res.errorReason).toBe(SETTLEMENT_PENDING);
    });

    it('reports pending, never not-accepted, for a payment it cannot name', async () => {
      // Something was reported, so money may have moved: calling it "not accepted" would invite a
      // second payment.
      for (const result of [
        { status: 'completed' as const, transactions: { fulfillment: FULFILLMENT } },
        { status: 'failed' as const, transactions: undefined },
        { transactions: { deposit: FULFILLMENT } },
      ]) {
        const res = await settleWith(result);
        expect(res.success).toBe(false);
        expect(res.errorReason).toBe(SETTLEMENT_PENDING);
      }
    });

    it("settles a completed payment under settleAt 'completed', without a status URL", async () => {
      const res = await settleWith(
        { payment_id: 'pay_c', status: 'completed', transactions: { fulfillment: FULFILLMENT } },
        'completed',
      );
      expect(res.success).toBe(true);
      expect(atumExtension(res)).toEqual({ paymentId: 'pay_c', state: 'completed' });
    });
  });

  it('refuses an unknown settleAt at construction', () => {
    expect(() => makeFacilitator(okSubmitter, undefined, 'later' as SettleAt)).toThrow(
      /settleAt must be 'finalizing' or 'completed'/,
    );
  });

  it('reports a finalizing settlement without a payout transaction as pending', async () => {
    // An adapter that does not pass `transactions` through gives the facilitator nothing to
    // serve against, so the payment stays pending, never a terminal failure.
    const f = makeFacilitator(finalizingSubmitter);
    const res = await f.settle(payload, requirement);
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe(SETTLEMENT_PENDING);
    expect(res.errorReason).not.toBe(SETTLEMENT_NOT_ACCEPTED);
    expect(atumExtension(res)).toMatchObject({
      paymentId: 'pay_finalizing',
      state: 'finalizing',
    });
  });

  it.each([
    ['refunding', refundingSubmitter, 'pay_refunding'],
    ['refund_available', refundAvailableSubmitter, 'pay_refund_available'],
  ] as const)(
    'reports a %s settlement as pending, never as a terminal failure',
    async (state, submitter, paymentId) => {
      // Both can still end completed, so the same key must keep resolving to the payment.
      const res = await makeFacilitator(submitter).settle(payload, requirement);
      expect(res.errorReason).toBe(SETTLEMENT_PENDING);
      expect(res.errorMessage?.includes('refund_signature')).toBe(state === 'refund_available');
      expect(atumExtension(res)).toMatchObject({ paymentId, state });
    },
  );

  it('publishes a status URL on a pending settlement only when one is configured', async () => {
    // The facilitator relays over an address that is usually internal, so the URL a reader is
    // told to poll has to be supplied explicitly. Unconfigured, the id ships without a URL —
    // better than one that 404s or resolves inside a private network.
    const withUrl = makeFacilitator(
      pendingSubmitter,
      (id) => `https://gw.test/v1/payments/${id}/status`,
    );
    expect(atumExtension(await withUrl.settle(payload, requirement))?.statusUrl).toBe(
      'https://gw.test/v1/payments/pay_pending/status',
    );

    const withoutUrl = makeFacilitator(pendingSubmitter);
    const bare = atumExtension(await withoutUrl.settle(payload, requirement));
    expect(bare?.paymentId).toBe('pay_pending');
    expect(bare).not.toHaveProperty('statusUrl');
  });

  it('reports a gateway response with neither a payout nor a payment id as a plain failure', async () => {
    // Nothing to wait on and nothing to correlate, so calling this pending would send the reader
    // chasing an id we never got. It is a failure, and says so.
    const f = makeFacilitator(emptySubmitter);
    const res = await f.settle(payload, requirement);
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe(SETTLEMENT_NOT_ACCEPTED);
    expect(res.extensions).toBeUndefined();
  });

  it.each([
    ['failed', failedSubmitter, 'pay_dead'],
    ['refunded', refundedSubmitter, 'pay_refunded'],
  ] as const)(
    'distinguishes a terminally %s payment from a pending one, and says a new key is needed',
    async (state, submitter, paymentId) => {
      // The distinction is not cosmetic: pending means "retry with the SAME key", terminal means
      // "the same key resolves to this corpse forever, use a NEW one". Reporting both as pending
      // instructs the caller to do the opposite of the right thing half the time.
      const res = await makeFacilitator(submitter).settle(payload, requirement);
      expect(res.success).toBe(false);
      expect(res.errorReason).toBe(SETTLEMENT_FAILED);
      expect(res.errorReason).not.toBe(SETTLEMENT_PENDING);
      expect(res.errorMessage).toMatch(/NEW idempotency key/);
      expect(atumExtension(res)).toMatchObject({ paymentId, state });
    },
  );

  it('treats a gateway that reports no status as pending, not failed', async () => {
    // `status` is optional, so an older gateway omits it. Of the two possible readings only one
    // is safe: calling a payment that may still be settling "failed" would push the caller onto a
    // new idempotency key and charge them twice.
    const res = await makeFacilitator(statuslessSubmitter).settle(payload, requirement);
    expect(res.errorReason).toBe(SETTLEMENT_PENDING);
    expect(atumExtension(res)).toMatchObject({ paymentId: 'pay_nostatus', state: 'pending' });
  });

  it('surfaces a gateway refusal as its own reason instead of an internal error', async () => {
    // A reused idempotency key carrying different terms is the caller's bug and is fixable by
    // them. Letting the throw escape would surface as a 500 — telling someone with a fixable
    // request that our side is broken, and hiding the one thing they need to know.
    const res = await makeFacilitator(rejectingSubmitter).settle(payload, requirement);
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe('IDEMPOTENCY_TERMS_MISMATCH');
    expect(res.errorMessage).toMatch(/different economics/);
    expect(res.payer).toBe(wallet.address);
  });

  it('lets an infrastructure failure propagate rather than reporting it as a payment outcome', async () => {
    // The counterpart to the above. A 503 is not a verdict on the payment: swallowing it into
    // `success: false` would tell the merchant the payment definitively did not happen, when in
    // truth we do not know — and the payer would be pushed toward a second one.
    await expect(makeFacilitator(brokenSubmitter).settle(payload, requirement)).rejects.toThrow(
      /503/,
    );
  });

  it('rejects a request that spells one member two ways, and never relays it', async () => {
    await expectCaseTwinRefused(payload, requirement);
  });

  it('rejects a request carrying a signed message besides the deposit', async () => {
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedPayload((pr) => {
      const auth = pr.sender_auth as { signed_messages: unknown[] };
      auth.signed_messages.push({ ...(auth.signed_messages[0] as object) });
    });
    const res = await f.verify(bad, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/exactly one signed message/);
  });

  it("rejects a request whose request_id is not derived from the requirement's anchor", async () => {
    // The gateway de-duplicates on request_id, so a client that mints its own instead of
    // deriving it from the merchant's anchor produces a fresh id on every attempt — it looks
    // fine on the first payment and charges twice on the retry. Catch it on the first attempt.
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedPayload((pr) => {
      pr.request_id = 'req_x402_deadbeefdeadbeefdeadbeef';
    });
    const res = await f.verify(bad, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/identifier/i);
  });

  it('rejects a request_id derived from the right identifier but with the wrong prefix', async () => {
    // The prefix is not hashed, but it IS part of the id the gateway keys on. Accepting any
    // prefix would leave the hole open: a client varying it per attempt gets the digest right
    // and still emits a different id each time. So the whole id has to match, not the digest.
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedPayload((pr) => {
      pr.request_id = atumEscrowRequestId(PURCHASE_ID, wallet.address, 'GET /paid').replace(
        'req_x402_',
        'req_other_',
      );
    });
    const res = await f.verify(bad, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/identifier/i);
  });

  it('rejects the 96-bit truncation of the right request_id', async () => {
    // Only the whole 256-bit digest is accepted, so a payer cannot fall back to a short id it
    // could search for collisions on.
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedPayload((pr) => {
      pr.request_id = atumEscrowRequestId(PURCHASE_ID, wallet.address, 'GET /paid').slice(
        0,
        'req_x402_'.length + 24,
      );
    });
    const res = await f.verify(bad, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/identifier/i);
  });

  it('accepts the request_id the client derives, so the guard is not vacuous', async () => {
    // Negative control for the two above: the untouched payload must pass, and its id must be
    // exactly what an independent derivation from the identifier produces.
    const pr = (payload as unknown as { payload: { paymentRequest: { request_id: string } } })
      .payload.paymentRequest;
    expect(pr.request_id).toBe(atumEscrowRequestId(PURCHASE_ID, wallet.address, 'GET /paid'));
    expect((await makeFacilitator(okSubmitter).verify(payload, requirement)).isValid).toBe(true);
  });

  it('refuses requirements that do not name the page being charged for', async () => {
    // The page is read from the requirements the resource server passed, so without it there is
    // nothing to bind the request_id to, and nothing may be relayed.
    const { atumResource: _dropped, ...extra } = requirement.extra as Record<string, unknown>;
    const unbound = { ...requirement, extra } as PaymentRequirements;
    const res = await makeFacilitator(okSubmitter).verify(payload, unbound);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/extra\.atumResource/);

    const spy = spySubmitter();
    const settled = await makeFacilitator(spy).settle(payload, unbound);
    expect(settled.success).toBe(false);
    expect(spy.calls).toBe(0);
  });

  it("refuses a payment made for one page when presented for another page's requirements", async () => {
    // Same price, same payTo, same identifier: only the page differs. The payload's own echoed
    // `accepted` still names page A, which must not matter: the requirements decide.
    const routeB = { ...requirement, extra: { ...requirement.extra, atumResource: 'GET /other' } };
    const res = await makeFacilitator(okSubmitter).verify(payload, routeB);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/identifier and page/);

    const spy = spySubmitter();
    const settled = await makeFacilitator(spy).settle(payload, routeB);
    expect(settled.success).toBe(false);
    expect(spy.calls).toBe(0);
  });

  it('refuses it too when the echoed accepted is rewritten to name the other page', async () => {
    const routeB = { ...requirement, extra: { ...requirement.extra, atumResource: 'GET /other' } };
    const forged = { ...payload, accepted: routeB } as PaymentPayload;
    expect((await makeFacilitator(okSubmitter).verify(forged, routeB)).isValid).toBe(false);
  });

  it('refuses a payment that carries no purchase identifier at all', async () => {
    // The check must not be skippable. If a payment with no identifier were waved through, any
    // payer could opt out of re-attemptability by simply omitting one — and its retry would be
    // charged a second time, which is the failure this guard exists to prevent.
    const f = makeFacilitator(okSubmitter);
    const res = await f.verify(withoutIdentifier(payload), requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/no purchase identifier/i);
  });

  it('refuses to settle a request that fails verification and never relays it', async () => {
    // /settle must be self-sufficient: an attacker can POST straight to it without
    // ever calling /verify, so settle re-runs verification and must reject a request
    // whose signature no longer recovers to the claimed source account — before
    // the gateway is ever contacted.
    const spy = spySubmitter();
    const f = makeFacilitator(spy);
    const bad = tamperedPayload((pr) => {
      (pr.source as Record<string, unknown>).account = '0x000000000000000000000000000000000000dEaD';
    });
    const res = await f.settle(bad, requirement);
    expect(res.success).toBe(false);
    expect(res.errorReason).toBeTruthy();
    expect(spy.calls).toBe(0);
  });

  it('refuses to settle a payment carrying no purchase identifier, and never relays it', async () => {
    // The identifier guard lives on the verify path, so this pins that settle really does re-run it.
    // Were it reachable only through verify, a caller could skip verify entirely and have an
    // un-re-attemptable payment settled — the exact bypass the guard exists to close.
    const spy = spySubmitter();
    const f = makeFacilitator(spy);
    const res = await f.settle(withoutIdentifier(payload), requirement);
    expect(res.success).toBe(false);
    expect(res.errorReason).toMatch(/no purchase identifier/i);
    expect(spy.calls).toBe(0);
  });
});

// ── Solana source (Solana → EVM corridor) ────────────────────────────────────
// The server scheme does not yet emit the svm fields (that lands with the merchant
// clock-stamping step), so the Solana requirement is a hand-built fixture; the client
// still produces the payload end-to-end from it.
const SOLANA_NETWORK = 'solana:localnet';
const SOLANA_MINT = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
const SOLANA_ESCROW = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const solKeypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
const solPubkey = bs58.encode(solKeypair.publicKey);
const solanaSigner: SolanaSigner = {
  publicKey: solPubkey,
  async sign(message: Uint8Array): Promise<Uint8Array> {
    return nacl.sign.detached(message, solKeypair.secretKey);
  },
};
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
        network: DEST_NETWORK,
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

let solanaPayload: PaymentPayload;

beforeAll(async () => {
  // issued_at reaches the signed authorization through the payer's cluster-clock reader, which is
  // the production path: it is signed data, and the facilitator recovers it from the signature
  // rather than reading the requirement. Pinned so the deposit deadline (issued_at + 120) sits
  // inside the 128s replay window at the facilitator clock (NOW = signing + 10s).
  const client = new AtumEscrowClientScheme({
    signer: solanaSigner,
    now: () => Date.parse('2026-07-08T12:00:00Z'),
    trust,
    solanaClockReader: async () => BigInt(SIGN_EPOCH),
  });
  const result = await client.createPaymentPayload(2, solanaRequirement, naming(PURCHASE_ID));
  solanaPayload = {
    x402Version: result.x402Version,
    accepted: solanaRequirement,
    payload: result.payload,
    extensions: result.extensions,
  } as unknown as PaymentPayload;
});

function tamperedSolana(mutate: (pr: Record<string, unknown>) => void): PaymentPayload {
  const clone = JSON.parse(JSON.stringify(solanaPayload));
  mutate(clone.payload.paymentRequest);
  return clone as PaymentPayload;
}

// Signing epoch (seconds) — the issued_at the payer stamps on the valid fixture. The
// facilitator clock NOW is 10s later, so a fresh deposit (deadline = issued_at + 120) is
// comfortably inside the 128s replay window.
const SIGN_EPOCH = Math.floor(Date.parse('2026-07-08T12:00:00Z') / 1000);

// Build a full Solana payload end-to-end with a specific issued_at, so the deposit deadline
// (issued_at + 120) can be pushed outside the on-chain replay window to exercise the
// facilitator's fail-fast freshness gate.
//
// The value travels the way production does — through the payer's cluster-clock reader, into the
// signed authorization — rather than through the requirement. That is what the facilitator
// actually reads: it recovers the deadline from the signature, so a requirement field could be
// set to anything without moving the gate under test.
async function solanaPayloadWithIssuedAt(issuedAt: string): Promise<PaymentPayload> {
  const client = new AtumEscrowClientScheme({
    signer: solanaSigner,
    now: () => Date.parse('2026-07-08T12:00:00Z'),
    trust,
    solanaClockReader: async () => BigInt(issuedAt),
  });
  const result = await client.createPaymentPayload(2, solanaRequirement, naming(PURCHASE_ID));
  return {
    x402Version: result.x402Version,
    accepted: solanaRequirement,
    payload: result.payload,
    extensions: result.extensions,
  } as unknown as PaymentPayload;
}

describe('AtumEscrowFacilitatorScheme (Solana source)', () => {
  it('verifies a valid Solana payment and returns the payer', async () => {
    const f = makeFacilitator(okSubmitter);
    const res = await f.verify(solanaPayload, solanaRequirement);
    expect(res.isValid, res.invalidReason).toBe(true);
    expect(res.payer).toBe(solPubkey);
  });

  it('refuses a payee swapped in both the request and the requirement, and never relays it', async () => {
    await expectPayeeSwapRefused(solanaPayload, solanaRequirement);
  });

  it('rejects a Solana request that spells one member two ways, and never relays it', async () => {
    await expectCaseTwinRefused(solanaPayload, solanaRequirement);
  });

  it('refuses a Solana payment relabelled with the EVM scheme', async () => {
    const bad = tamperedSolana((pr) => {
      (pr.sender_auth as Record<string, unknown>).message_scheme = 'EVM_PERMIT2';
    });
    const res = await makeFacilitator(okSubmitter).verify(bad, solanaRequirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/unsupported message_scheme for solana:.*: EVM_PERMIT2/);
  });

  it('checks the purchase identifier against a base58 source account too', async () => {
    // The derivation folds in the source account, and base58 is case-SENSITIVE where EVM hex is
    // not — so a canonicalization that over-normalizes would make Solana ids irreproducible and
    // break the dedup this guard exists to protect. Pin both directions on a real base58 payer.
    const f = makeFacilitator(okSubmitter);
    const pr = (solanaPayload as unknown as { payload: { paymentRequest: { request_id: string } } })
      .payload.paymentRequest;
    expect(pr.request_id).toBe(atumEscrowRequestId(PURCHASE_ID, solPubkey, 'GET /paid'));

    const clone = JSON.parse(JSON.stringify(solanaPayload));
    clone.payload.paymentRequest.request_id = atumEscrowRequestId(
      'pay_some_other_order',
      solPubkey,
      'GET /paid',
    );
    const res = await f.verify(clone as PaymentPayload, solanaRequirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/identifier/i);
  });

  it('rejects a Solana payment whose deposit authorization has already expired', async () => {
    const f = makeFacilitator(okSubmitter);
    // issued_at an hour before signing ⇒ deadline (issued_at + 120) is well before the facilitator
    // clock, so the settler could never land the deposit inside the on-chain replay window.
    const bad = await solanaPayloadWithIssuedAt((SIGN_EPOCH - 3600).toString());
    const res = await f.verify(bad, solanaRequirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/expired|deadline/i);
  });

  it('rejects a Solana payment whose issued_at is in the future (deadline beyond the replay window)', async () => {
    const f = makeFacilitator(okSubmitter);
    // issued_at an hour ahead ⇒ deadline is far beyond now + 128s; the chain would reject it.
    const bad = await solanaPayloadWithIssuedAt((SIGN_EPOCH + 3600).toString());
    const res = await f.verify(bad, solanaRequirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/future|not yet valid|window/i);
  });

  it('rejects a Solana payment whose max_source_amount exceeds the requirement cap', async () => {
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedSolana((pr) => {
      pr.max_source_amount = (BigInt(solanaRequirement.amount) + 1n).toString();
    });
    const res = await f.verify(bad, solanaRequirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/max_source_amount|cap|amount/i);
  });

  it('rejects a Solana payment whose depositor differs from source.account', async () => {
    const f = makeFacilitator(okSubmitter);
    // A different account than the signer/source. Re-sign a deposit that names it as the
    // depositor (the fund owner) while the signature is still made by — and delegate_signer
    // still discloses — the real source key. Recovery therefore passes and delegate_signer
    // == source.account passes; only the depositor≠source.account binding can catch it.
    // (depositor is bound into the signed digest, so it cannot be JSON-mutated after signing.)
    const victim = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).publicKey);
    const atum = (solanaRequirement.extra as { atum: Record<string, string> }).atum;
    // Build through the shared sender_auth SDK (the same path production/verify use), naming
    // `victim` as the depositor. The signature + delegate_signer below are still the REAL source
    // key, so recovery and delegate_signer==source.account both pass — leaving depositor ≠
    // source.account as the only bind that can reject.
    const built = await senderAuthAdapter(SOLANA_NETWORK).buildAuthMessage({
      sourceAsset: `${SOLANA_NETWORK}/spl:${SOLANA_MINT}`,
      depositor: victim,
      maxSourceAmount: solanaRequirement.amount,
      requestId: 'req_000000000000000000000000',
      // The corridor's destination, matching the other fixtures in this file. The depositor
      // check runs first, so it is the reason this payment is refused.
      destinationAsset: `${DEST_NETWORK}/erc20:0x52e52f345139e57b87d288c9ea794bb3fbe591c3`,
      destinationAccount: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      sourceDefaults: {
        escrowContract: SOLANA_ESCROW,
        quoteSelector: atum.reserver,
        fulfillmentVerifierAccount: atum.releaser,
        fulfillmentVerifierEndpoint: atum.fulfillmentVerifierEndpoint,
        fulfillmentProxy: atum.fulfillmentProxy,
        svmSignatureClusterId: atum.svmSignatureClusterId,
        svmSignatureDomainVersion: Number(atum.svmSignatureDomainVersion),
      },
      solanaClockReader: async () => BigInt(SIGN_EPOCH),
    });
    // Sign via the same capability-signer bridge production uses, with the real source key, so
    // message/prehash/signature stay a consistent triple and delegate_signer == source.account.
    const { signature } = await toSenderSigner(SOLANA_NETWORK, solanaSigner).sign({
      message: built.messageHash,
      message_prehash: built.messagePrehash,
      signature: '',
    });
    const bad = JSON.parse(JSON.stringify(solanaPayload));
    const sm = (
      bad.payload.paymentRequest.sender_auth as { signed_messages: Array<Record<string, unknown>> }
    ).signed_messages[0];
    // Replace message + prehash + signature as a consistent triple (all from `built`), so
    // the digest matches its prehash and verification reaches the depositor bind rather than
    // failing earlier on a message/prehash mismatch. Only depositor≠source.account remains.
    sm.message = built.messageHash;
    sm.message_prehash = built.messagePrehash;
    sm.signature = signature;
    const res = await f.verify(bad, solanaRequirement);
    expect(res.isValid).toBe(false);
    // The shared verifier folds the depositor bind into its uniform "does not recover to
    // source.account" rejection (it does not name the depositor field).
    expect(res.invalidReason).toMatch(/depositor|recover|source\.account/i);
  });

  it('rejects a Solana payment whose delegate_signer is swapped for another key', async () => {
    const f = makeFacilitator(okSubmitter);
    const otherKey = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey);
    const bad = tamperedSolana((pr) => {
      (
        (pr.sender_auth as any).signed_messages[0].payload as Record<string, unknown>
      ).delegate_signer = otherKey;
    });
    const res = await f.verify(bad, solanaRequirement);
    // The Ed25519 signature no longer verifies against the claimed key.
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/the delegate signer is not the payment's source account/);
  });
});

// ── Tron source (Permit2 / EVM_PERMIT2 scheme; base58 roles, hex-normalized witness) ──
const TRON_NETWORK = 'tron:shasta';
const TRON_TOKEN = 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';
const TRON_ESCROW = 'TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py'; // Permit2 spender (source escrow)
const TRON_RESERVER = 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N';
const TRON_RELEASER = 'T9yD14NjG6wxkArbchsTBKawgUVqYww3tQ';
// Throwaway secp256k1 key — Tron uses the same key type as EVM (an ethers.Wallet).
const tronWallet = new ethers.Wallet('0x' + '22'.repeat(32));

const tronRequirement: PaymentRequirements = {
  scheme: 'atum-escrow',
  network: TRON_NETWORK,
  asset: TRON_TOKEN,
  amount: '10300000',
  payTo: TRON_ESCROW,
  maxTimeoutSeconds: 60,
  extra: {
    atumResource: 'GET /paid',
    atum: {
      destination: {
        network: DEST_NETWORK,
        asset: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      },
      fulfillmentAmount: '10000000',
      escrow: TRON_ESCROW,
      fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      reserver: TRON_RESERVER,
      releaser: TRON_RELEASER,
      fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
      quoteDeadlineSeconds: 20,
      fulfillmentDeadlineSeconds: 300,
    },
  },
};

let tronPayload: PaymentPayload;

beforeAll(async () => {
  const client = new AtumEscrowClientScheme({
    signer: tronWallet,
    now: () => Date.parse('2026-07-08T12:00:00Z'),
    trust,
  });
  const result = await client.createPaymentPayload(2, tronRequirement, naming(PURCHASE_ID));
  tronPayload = {
    x402Version: result.x402Version,
    accepted: tronRequirement,
    payload: result.payload,
    extensions: result.extensions,
  } as unknown as PaymentPayload;
});

function tamperedTron(mutate: (pr: Record<string, unknown>) => void): PaymentPayload {
  const clone = JSON.parse(JSON.stringify(tronPayload));
  mutate(clone.payload.paymentRequest);
  return clone as PaymentPayload;
}

describe('AtumEscrowFacilitatorScheme (Tron source)', () => {
  it('verifies a valid Tron payment and returns the payer', async () => {
    const f = makeFacilitator(okSubmitter);
    const res = await f.verify(tronPayload, tronRequirement);
    expect(res.isValid, res.invalidReason).toBe(true);
    // The payer is the base58 Tron source account the client derived from the key.
    expect(res.payer).toBe(
      (tronPayload.payload as { paymentRequest: { source: { account: string } } }).paymentRequest
        .source.account,
    );
  });

  it('refuses a payee swapped in both the request and the requirement, and never relays it', async () => {
    await expectPayeeSwapRefused(tronPayload, tronRequirement);
  });

  it('rejects a Tron request that spells one member two ways, and never relays it', async () => {
    await expectCaseTwinRefused(tronPayload, tronRequirement);
  });

  it('refuses a Tron payment relabelled with the TRON scheme', async () => {
    const bad = tamperedTron((pr) => {
      (pr.sender_auth as Record<string, unknown>).message_scheme = 'TRON';
    });
    const res = await makeFacilitator(okSubmitter).verify(bad, tronRequirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/unsupported message_scheme for tron:.*: TRON/);
  });

  it('rejects a Tron payment whose max_source_amount exceeds the requirement cap', async () => {
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedTron((pr) => {
      pr.max_source_amount = (BigInt(tronRequirement.amount) + 1n).toString();
    });
    const res = await f.verify(bad, tronRequirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/max_source_amount|cap|amount/i);
  });

  it('rejects a Tron payment whose destination was altered (payout redirected)', async () => {
    const f = makeFacilitator(okSubmitter);
    const bad = tamperedTron((pr) => {
      (pr.destination as Array<{ account: string }>)[0].account =
        '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
    });
    const res = await f.verify(bad, tronRequirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(/the payer signed a deposit payable to/);
  });
});

// Readers accept depositRequestHash v1 or v2 with no flag (the spec's rollout), so the facilitator
// reads v2 in audit mode by default: a v2 deposit is accepted where the requirement lists 2, and a
// request the strict reader refuses is admitted by the v1 reading and reported. Enforce refuses it
// instead.
describe('AtumEscrowFacilitatorScheme depositRequestHash v2', () => {
  let v2Requirement: PaymentRequirements;
  let v2Payload: PaymentPayload;

  beforeAll(async () => {
    const server = new AtumEscrowServerScheme({
      ...serverConfig,
      sources: {
        [SOURCE_NETWORK]: {
          ...serverConfig.sources[SOURCE_NETWORK]!,
          depositRequestHashVersions: [1, 2],
        },
      },
    });
    const client = new AtumEscrowClientScheme({
      signer: wallet,
      now: () => Date.parse('2026-07-08T12:00:00Z'),
      trust,
    });
    const priced = await server.parsePrice(atumEscrowPrice(serverConfig), SOURCE_NETWORK);
    ({ requirement: v2Requirement } = await buildRequirement(server, {
      scheme: 'atum-escrow',
      network: SOURCE_NETWORK,
      asset: priced.asset,
      amount: priced.amount,
      payTo: '',
      maxTimeoutSeconds: 60,
      extra: {},
    }));
    const result = await client.createPaymentPayload(2, v2Requirement, naming(PURCHASE_ID));
    v2Payload = {
      x402Version: result.x402Version,
      accepted: v2Requirement,
      payload: result.payload,
      extensions: result.extensions,
    } as unknown as PaymentPayload;
  });

  type Mode = AtumEscrowFacilitatorConfig['depositRequestHashV2Mode'];

  /** `mode` may be null, which only configuration read from untyped JSON passes. */
  function recording(mode?: Mode | null) {
    const seen: CommitmentResult[] = [];
    const f = new AtumEscrowFacilitatorScheme({
      submitter: okSubmitter,
      now: NOW,
      trust,
      onCommitmentResult: (result) => seen.push(result),
      ...(mode !== undefined && { depositRequestHashV2Mode: mode as Mode }),
    });
    return { f, seen };
  }

  /** The v1-signed payment with a member v1 does not hash and the strict reader refuses. */
  const strictRefused = () =>
    tamperedPayload((pr) => {
      pr.unknown_member = 1;
    });

  it('accepts a v2-signed payment by default and reports v2', async () => {
    const { f, seen } = recording();
    expect(await f.verify(v2Payload, v2Requirement)).toMatchObject({ isValid: true });
    expect(seen.map((r) => r.depositRequestHashVersion)).toEqual(['v2']);
  });

  /** v2Requirement with `extra.atum.depositRequestHashVersions` replaced, or removed when undefined. */
  const listing = (versions: [number, ...number[]] | undefined): PaymentRequirements => {
    const copy = JSON.parse(JSON.stringify(v2Requirement)) as PaymentRequirements;
    const atum = (copy.extra as { atum: { depositRequestHashVersions?: number[] } }).atum;
    if (versions === undefined) delete atum.depositRequestHashVersions;
    else atum.depositRequestHashVersions = versions;
    return copy;
  };

  // A merchant lists 2 only once the network reads v2, so where the requirement does not list it the
  // gateway may still refuse a v2 deposit. It is refused here rather than at settle, after the
  // merchant's handler has run.
  it.each([
    ['absent', undefined],
    ['[1]', [1] as [number]],
  ])('refuses a v2-signed payment when the requirement lists %s', async (_name, versions) => {
    const { f, seen } = recording();
    expect((await f.verify(v2Payload, listing(versions))).isValid).toBe(false);
    expect(seen.map((r) => r.outcome)).toEqual(['request_hash_mismatch']);
  });

  it('reports a v1-signed payment as v1', async () => {
    const { f, seen } = recording();
    expect(await f.verify(payload, requirement)).toMatchObject({ isValid: true });
    expect(seen.map((r) => r.depositRequestHashVersion)).toEqual(['v1']);
  });

  it('admits a request the strict reader refuses by default, and reports why', async () => {
    const { f, seen } = recording();
    expect(await f.verify(strictRefused(), requirement)).toMatchObject({ isValid: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.strictDetail).toMatch(/unknown_member is not a PaymentRequest member/);
  });

  // A v2 deposit over a body the strict reader refuses cannot match v1 either, so it is refused;
  // audit still reports why the strict reader refused it, the signal a reader divergence shows as.
  it('reports why the strict reader refused a v2-signed payment it refuses', async () => {
    const { f, seen } = recording();
    const refused = JSON.parse(JSON.stringify(v2Payload));
    refused.payload.paymentRequest.unknown_member = 1;
    expect((await f.verify(refused as PaymentPayload, v2Requirement)).isValid).toBe(false);
    expect(seen.map((r) => r.outcome)).toEqual(['request_hash_mismatch']);
    expect(seen[0]!.strictDetail).toMatch(/unknown_member is not a PaymentRequest member/);
  });

  it('refuses a request the strict reader refuses in enforce mode', async () => {
    const { f, seen } = recording('enforce');
    const res = await f.verify(strictRefused(), requirement);
    expect(res.isValid).toBe(false);
    expect(seen.map((r) => r.outcome)).toEqual(['request_malformed']);
  });

  // The empty string and null are off, as the shared SDK and Go read them: only v1 is read, exactly
  // as before v2, even for a requirement that lists 2.
  it.each([
    ['the empty string', ''],
    ['null', null],
  ] as const)('reads only v1 when the mode is %s', async (_name, mode) => {
    const { f, seen } = recording(mode);
    expect((await f.verify(v2Payload, v2Requirement)).isValid).toBe(false);
    expect(await f.verify(strictRefused(), requirement)).toMatchObject({ isValid: true });
    expect(seen.map((r) => [r.outcome, r.depositRequestHashVersion, r.strictDetail])).toEqual([
      ['request_hash_mismatch', undefined, undefined],
      ['verified', undefined, undefined],
    ]);
  });

  it.each(['Enforce', 'Retire'])(
    'refuses the unknown mode %s at construction rather than every payment after',
    (mode) => {
      expect(
        () =>
          new AtumEscrowFacilitatorScheme({
            submitter: okSubmitter,
            trust,
            depositRequestHashV2Mode: mode as 'enforce',
          }),
      ).toThrow(/depositRequestHashV2Mode must be 'audit', 'enforce', 'retire' or '' \(off\)/);
    },
  );

  describe("in 'retire' mode", () => {
    function retiring() {
      const seen: CommitmentResult[] = [];
      const f = new AtumEscrowFacilitatorScheme({
        submitter: okSubmitter,
        now: NOW,
        trust,
        onCommitmentResult: (result) => seen.push(result),
        depositRequestHashV2Mode: 'retire',
      });
      return { f, seen };
    }

    it('admits a v2-signed payment', async () => {
      const { f, seen } = retiring();
      expect(await f.verify(v2Payload, v2Requirement)).toMatchObject({ isValid: true });
      expect(seen.map((r) => [r.outcome, r.depositRequestHashVersion])).toEqual([
        ['verified', 'v2'],
      ]);
    });

    it('refuses a v1-signed payment', async () => {
      const { f, seen } = retiring();
      expect((await f.verify(payload, v2Requirement)).isValid).toBe(false);
      expect(seen.map((r) => r.outcome)).toEqual(['request_hash_mismatch']);
      expect(seen[0]!.detail).toMatch(/no longer accepts: sign depositRequestHash v2/);
    });

    it('refuses a request the strict reader refuses, as enforce does', async () => {
      const { f, seen } = retiring();
      expect((await f.verify(strictRefused(), v2Requirement)).isValid).toBe(false);
      expect(seen.map((r) => r.outcome)).toEqual(['request_malformed']);
    });

    it.each([
      ['absent', undefined],
      ['[1]', [1] as [number]],
    ])(
      'refuses a requirement that lists %s, which no payment could satisfy, before reading the payment',
      async (_name, versions) => {
        const { f, seen } = retiring();
        for (const signed of [v2Payload, payload]) {
          const res = await f.verify(signed, listing(versions));
          expect(res).toEqual({
            isValid: false,
            invalidReason: expect.stringMatching(
              /accepts only depositRequestHash v2, but the requirement does not list 2/,
            ),
          });
        }
        expect(seen).toEqual([]);
      },
    );
  });
});
