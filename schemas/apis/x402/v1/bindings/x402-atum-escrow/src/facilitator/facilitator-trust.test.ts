/**
 * The facilitator refuses to relay a payment toward roles its own trust source does not vouch for.
 *
 * The payer's client checks the 402's roles before signing, but a facilitator cannot assume every
 * payer runs that client: a payer that signed whatever a malicious 402 named produces a perfectly
 * valid signature over an escrow, reserver or fulfillment proxy nobody trusts. So after the
 * signature has bound the payer to the terms, the facilitator compares the roles against its own
 * trust source and refuses a mismatch before anything is submitted.
 *
 * The releaser is deliberately not compared: it is the verifier key the settlement network uses
 * to release the escrow, and the facilitator relays rather than releases.
 *
 * Every payment below is genuinely signed. The payer's client is handed a trust source that
 * vouches for exactly what each 402 names, so the signature is valid and the facilitator's trust
 * check is the only thing that can refuse it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ethers } from 'ethers';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { Network, PaymentPayload, PaymentRequirements } from '@x402/core/types';
import {
  AtumEscrowClientScheme,
  AtumEscrowTrustError,
  atumGatewayTrust,
  type TrustResolver,
  type SolanaSigner,
  type TrustedRoles,
} from '../client';
import * as clientEntry from '../client';
import { PAYMENT_IDENTIFIER } from '../payment-identifier';
import { AtumEscrowFacilitatorScheme, type PaymentSubmitter } from './index';
import * as facilitatorEntry from './index';

// Well-known anvil account #0 — a throwaway dev key, safe to commit.
const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
// Signing happens at SIGN_AT; the facilitator judges at NOW, shortly after, so deadlines hold.
const SIGN_AT = () => Date.parse('2026-07-08T12:00:00Z');
const NOW = () => Date.parse('2026-07-08T12:00:10Z');
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
// The source chain's own proxy: a trusted contract, but on the wrong chain for this role.
const SOURCE_FULFILLMENT_PROXY = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const ATTACKER = '0xBcd4042DE499D14e55001CcbB24a551F3b954096';

const USDC_6 = (address: string) => ({ symbol: 'USDC', address, decimals: 6 });

/** What the facilitator's trust source vouches for, per chain. */
const facilitatorTrusts: Record<string, TrustedRoles> = {
  [SOURCE]: {
    escrowContract: ESCROW,
    quoteSelector: RESERVER,
    fulfillmentVerifierAccount: RELEASER,
    fulfillmentProxy: SOURCE_FULFILLMENT_PROXY,
    tokens: [USDC_6(SOURCE_ASSET)],
  },
  [DEST]: {
    escrowContract: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
    quoteSelector: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
    fulfillmentVerifierAccount: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
    fulfillmentProxy: DEST_FULFILLMENT_PROXY,
    tokens: [USDC_6(DEST_ASSET)],
  },
};

function trustTable(table: Record<string, TrustedRoles>) {
  return vi.fn<TrustResolver>(async (network: string) => {
    const roles = table[network];
    if (roles === undefined) throw new Error(`test trust table has no entry for ${network}`);
    return roles;
  });
}

function requirementWith(
  overrides: { payTo?: string; atum?: Record<string, unknown> } = {},
): PaymentRequirements {
  return {
    scheme: 'atum-escrow',
    network: SOURCE,
    asset: SOURCE_ASSET,
    amount: '10300000',
    payTo: overrides.payTo ?? ESCROW,
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
        quoteDeadlineSeconds: 20,
        fulfillmentDeadlineSeconds: 300,
        ...overrides.atum,
      },
    },
  };
}

/**
 * A trust source that vouches for exactly the roles and assets a 402 names, so the payer's
 * client signs it whatever it says. It stands in for a payer that does no trust check of its own.
 */
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

/** A genuinely signed payment for a 402, wrapped the way the framework hands it to verify. */
async function signedFor(
  requirement: PaymentRequirements,
  signer: ethers.Wallet = wallet,
): Promise<PaymentPayload> {
  const client = new AtumEscrowClientScheme({
    signer,
    now: SIGN_AT,
    trust: trustingThe402(requirement),
  });
  const result = await client.createPaymentPayload(2, requirement, named);
  return {
    x402Version: result.x402Version,
    accepted: requirement,
    payload: result.payload,
    extensions: result.extensions,
  } as unknown as PaymentPayload;
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

function facilitator(
  trust: TrustResolver | undefined,
  submitter: PaymentSubmitter = countingSubmitter(),
): AtumEscrowFacilitatorScheme {
  return new AtumEscrowFacilitatorScheme({ submitter, now: NOW, ...(trust ? { trust } : {}) });
}

/** Assert verify refuses with exactly `reason`, and that settle refuses it without submitting. */
async function expectRefused(
  payment: PaymentPayload,
  requirement: PaymentRequirements,
  reason: string,
  trust: TrustResolver = trustTable(facilitatorTrusts),
): Promise<void> {
  const verified = await facilitator(trust).verify(payment, requirement);
  expect(verified.isValid).toBe(false);
  expect(verified.invalidReason).toBe(reason);

  const submitter = countingSubmitter();
  const settled = await facilitator(trust, submitter).settle(payment, requirement);
  expect(settled.success).toBe(false);
  expect(settled.errorReason).toBe(reason);
  expect(submitter.calls).toBe(0);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AtumEscrowFacilitatorScheme — trusted roles', () => {
  it('accepts and settles a fully trusted payment exactly as before', async () => {
    const requirement = requirementWith();
    const payment = await signedFor(requirement);
    const trust = trustTable(facilitatorTrusts);

    const verified = await facilitator(trust).verify(payment, requirement);
    expect(verified.isValid, verified.invalidReason).toBe(true);
    expect(verified.payer).toBe(wallet.address);

    const submitter = countingSubmitter();
    const settled = await facilitator(trust, submitter).settle(payment, requirement);
    expect(settled.success).toBe(true);
    expect(submitter.calls).toBe(1);
  });

  it('consults the trust source for the source and the destination chain', async () => {
    const requirement = requirementWith();
    const payment = await signedFor(requirement);
    const trust = trustTable(facilitatorTrusts);

    await facilitator(trust).verify(payment, requirement);

    expect(trust.mock.calls.map(([n]) => n)).toEqual(expect.arrayContaining([SOURCE, DEST]));
  });

  it('refuses an untrusted escrow', async () => {
    // payTo names the same escrow, as a coherent 402 does; the escrow is the role reported.
    const requirement = requirementWith({ payTo: ATTACKER, atum: { escrow: ATTACKER } });
    await expectRefused(
      await signedFor(requirement),
      requirement,
      `extra.atum.escrow is not trusted by this facilitator on ${SOURCE}`,
    );
  });

  it('refuses a payTo that is not the trusted escrow', async () => {
    // payTo is not part of what the payer signs, so a relayer can rewrite it on a signed payment
    // while extra.atum.escrow keeps naming the trusted contract.
    const signed = await signedFor(requirementWith());
    const requirement = requirementWith({ payTo: ATTACKER });
    const payment = { ...signed, accepted: requirement } as PaymentPayload;
    await expectRefused(
      payment,
      requirement,
      `payTo is not trusted by this facilitator on ${SOURCE}`,
    );
  });

  it('refuses an untrusted reserver', async () => {
    const requirement = requirementWith({ atum: { reserver: ATTACKER } });
    await expectRefused(
      await signedFor(requirement),
      requirement,
      `extra.atum.reserver is not trusted by this facilitator on ${SOURCE}`,
    );
  });

  it("checks the fulfillment proxy against the DESTINATION chain's", async () => {
    const requirement = requirementWith({ atum: { fulfillmentProxy: SOURCE_FULFILLMENT_PROXY } });
    await expectRefused(
      await signedFor(requirement),
      requirement,
      `extra.atum.fulfillmentProxy is not trusted by this facilitator on ${DEST}`,
    );
  });

  it('does not compare the releaser', async () => {
    const requirement = requirementWith({ atum: { releaser: ATTACKER } });
    const payment = await signedFor(requirement);

    const verified = await facilitator(trustTable(facilitatorTrusts)).verify(payment, requirement);

    expect(verified.isValid, verified.invalidReason).toBe(true);
  });

  it('compares EVM addresses case-insensitively', async () => {
    const lower = (r: TrustedRoles): TrustedRoles => ({
      ...r,
      escrowContract: r.escrowContract.toLowerCase(),
      quoteSelector: r.quoteSelector.toLowerCase(),
      fulfillmentVerifierAccount: r.fulfillmentVerifierAccount.toLowerCase(),
      fulfillmentProxy: r.fulfillmentProxy.toLowerCase(),
    });
    const trust = trustTable({
      [SOURCE]: lower(facilitatorTrusts[SOURCE]!),
      [DEST]: lower(facilitatorTrusts[DEST]!),
    });
    const requirement = requirementWith();
    const payment = await signedFor(requirement);

    const verified = await facilitator(trust).verify(payment, requirement);

    expect(verified.isValid, verified.invalidReason).toBe(true);
  });
});

describe('AtumEscrowFacilitatorScheme — check order', () => {
  it('reports a bad signature, not a trust refusal, when both apply', async () => {
    // Terms are only meaningful once the signature binds the payer to them, so a forged payment
    // must be refused as forged — a trust reason would tell the forger which roles to fix.
    const requirement = requirementWith({ atum: { reserver: ATTACKER } });
    const forged = JSON.parse(JSON.stringify(await signedFor(requirement)));
    const signed = forged.payload.paymentRequest.sender_auth.signed_messages[0];
    const sig = ethers.getBytes(signed.signature);
    sig[10] = sig[10]! ^ 0xff;
    signed.signature = ethers.hexlify(sig);

    // The reason this forgery earns from a facilitator that trusts its roles: the baseline.
    const baseline = await facilitator(trustingThe402(requirement)).verify(forged, requirement);
    expect(baseline.isValid).toBe(false);

    const verified = await facilitator(trustTable(facilitatorTrusts)).verify(forged, requirement);
    expect(verified.isValid).toBe(false);
    expect(verified.invalidReason).toBe(baseline.invalidReason);
    expect(verified.invalidReason).not.toMatch(/not trusted by this facilitator/);
  });
});

describe('AtumEscrowFacilitatorScheme — what precedes and follows the trust lookup', () => {
  const BITCOIN: Network = 'bip122:000000000019d6689c085ae165831e93';

  /** A conforming signed payment whose requirement, as accepted and as passed, names `network`. */
  async function relabelledTo(
    network: Network,
  ): Promise<{ payment: PaymentPayload; requirement: PaymentRequirements }> {
    const signed = await signedFor(requirementWith());
    const requirement: PaymentRequirements = { ...requirementWith(), network };
    return { payment: { ...signed, accepted: requirement } as PaymentPayload, requirement };
  }

  it('refuses an unsupported network without consulting the trust source', async () => {
    // A source network the facilitator has no scheme for cannot be relayed whatever the trust
    // source says, so asking it would spend a round trip and let any payer drive lookups for a
    // source chain this facilitator never serves.
    const { payment, requirement } = await relabelledTo(BITCOIN);
    const trust = trustTable(facilitatorTrusts);

    const verified = await facilitator(trust).verify(payment, requirement);
    expect(verified.isValid).toBe(false);
    expect(verified.invalidReason).toBe(`unsupported network: ${BITCOIN}`);
    expect(trust).not.toHaveBeenCalled();

    const submitter = countingSubmitter();
    const settled = await facilitator(trust, submitter).settle(payment, requirement);
    expect(settled.success).toBe(false);
    expect(settled.errorReason).toBe(`unsupported network: ${BITCOIN}`);
    expect(submitter.calls).toBe(0);
    expect(trust).not.toHaveBeenCalled();
  });

  /** A facilitator that reports every payee check it makes to `onCommitmentResult`. */
  function observedFacilitator(
    trust: TrustResolver,
    onCommitmentResult: CommitmentObserver,
  ): AtumEscrowFacilitatorScheme {
    return new AtumEscrowFacilitatorScheme({
      submitter: countingSubmitter(),
      now: NOW,
      trust,
      onCommitmentResult,
    });
  }

  it('reports the payee check of a payment whose roles are trusted', async () => {
    // Control for the refusal below: the observer is wired and fires for a vouched-for payment,
    // so its silence there is a property of the refusal, not of the wiring.
    const requirement = requirementWith();
    const onCommitmentResult = vi.fn<CommitmentObserver>();

    const verified = await observedFacilitator(
      trustTable(facilitatorTrusts),
      onCommitmentResult,
    ).verify(await signedFor(requirement), requirement);

    expect(verified.isValid, verified.invalidReason).toBe(true);
    expect(onCommitmentResult).toHaveBeenCalledTimes(1);
  });

  it('does not report a payee check for a payment refused as untrusted', async () => {
    // The observer receives the payee check of a payment the facilitator vouches for, or of one
    // that check itself refused. A payment naming a reserver this facilitator does not trust is
    // neither: it is refused on its roles, so nothing is reported for it.
    const requirement = requirementWith({ atum: { reserver: ATTACKER } });
    const onCommitmentResult = vi.fn<CommitmentObserver>();

    const verified = await observedFacilitator(
      trustTable(facilitatorTrusts),
      onCommitmentResult,
    ).verify(await signedFor(requirement), requirement);

    expect(verified.isValid).toBe(false);
    expect(verified.invalidReason).toBe(
      `extra.atum.reserver is not trusted by this facilitator on ${SOURCE}`,
    );
    expect(onCommitmentResult).not.toHaveBeenCalled();
  });
});

describe('AtumEscrowFacilitatorScheme — trust source failures', () => {
  it('refuses as unavailable when the resolver fails with a plain error', async () => {
    const trust = vi.fn<TrustResolver>(async (network: string) => {
      if (network === SOURCE) throw new Error('resolver exploded');
      return facilitatorTrusts[DEST]!;
    });
    const requirement = requirementWith();
    await expectRefused(
      await signedFor(requirement),
      requirement,
      `trust source unavailable for ${SOURCE}`,
      trust,
    );
  });

  it('refuses as unavailable when the resolver reports TRUST_SOURCE_UNAVAILABLE', async () => {
    const trust = vi.fn<TrustResolver>(async (network: string) => {
      if (network === SOURCE) {
        throw new AtumEscrowTrustError({
          code: 'TRUST_SOURCE_UNAVAILABLE',
          network,
          message: 'custom trust source is offline',
        });
      }
      return facilitatorTrusts[DEST]!;
    });
    const requirement = requirementWith();
    await expectRefused(
      await signedFor(requirement),
      requirement,
      `trust source unavailable for ${SOURCE}`,
      trust,
    );
  });

  it('refuses a chain the trust source does not serve, naming that chain', async () => {
    // The real gateway resolver: every gateway 404s the source chain and vouches for the
    // destination, so CHAIN_NOT_TRUSTED is raised exactly as in production, for the source only.
    const fake = vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const href =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const chain = new URL(href).searchParams.get('chain_id');
      if (chain === DEST) return Response.json(defaultsBody(DEST, facilitatorTrusts[DEST]!));
      return new Response('not found', { status: 404 });
    });
    const trust = atumGatewayTrust({ fetch: fake as unknown as typeof fetch, now: NOW });
    const requirement = requirementWith();
    await expectRefused(
      await signedFor(requirement),
      requirement,
      `${SOURCE} is not served by this facilitator's trust source`,
      trust,
    );
  });

  it('refuses as unavailable when only the destination lookup fails', async () => {
    const trust = vi.fn<TrustResolver>(async (network: string) => {
      if (network === DEST) throw new Error('resolver exploded');
      return facilitatorTrusts[SOURCE]!;
    });
    const requirement = requirementWith();
    await expectRefused(
      await signedFor(requirement),
      requirement,
      `trust source unavailable for ${DEST}`,
      trust,
    );
  });

  it('refuses a destination chain the trust source does not serve, naming it', async () => {
    const trust = vi.fn<TrustResolver>(async (network: string) => {
      if (network === DEST) {
        throw new AtumEscrowTrustError({
          code: 'CHAIN_NOT_TRUSTED',
          network,
          message: 'no operator serves this chain',
        });
      }
      return facilitatorTrusts[SOURCE]!;
    });
    const requirement = requirementWith();
    await expectRefused(
      await signedFor(requirement),
      requirement,
      `${DEST} is not served by this facilitator's trust source`,
      trust,
    );
  });

  it('reports the source failure when both lookups fail', async () => {
    // One deterministic reason regardless of which lookup settles first: the chain the funds
    // leave from is the one named.
    const trust = vi.fn<TrustResolver>(async (network: string) => {
      if (network === SOURCE) throw new Error('resolver exploded');
      throw new AtumEscrowTrustError({
        code: 'CHAIN_NOT_TRUSTED',
        network,
        message: 'no operator serves this chain',
      });
    });
    const requirement = requirementWith();
    await expectRefused(
      await signedFor(requirement),
      requirement,
      `trust source unavailable for ${SOURCE}`,
      trust,
    );
  });
});

// ── Tron source ──────────────────────────────────────────────────────────────
// A Tron address is 0x41 + 20 key-derived bytes, base58check-encoded; the trust source may give a
// role in that base58 form or as the 0x-prefixed 20-byte hex the signed witness carries.
const TRON: Network = 'tron:shasta';
const TRON_TOKEN = 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';
const TRON_ESCROW = 'TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py';
const TRON_RESERVER = 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N';
const TRON_RELEASER = 'T9yD14NjG6wxkArbchsTBKawgUVqYww3tQ';
const TRON_STRANGER = 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m';
// Throwaway secp256k1 key — Tron uses the same key type as EVM.
const tronWallet = new ethers.Wallet('0x' + '22'.repeat(32));

function tronHex(base58: string): string {
  const raw = bs58.decode(base58);
  expect(raw.length).toBe(25);
  expect(raw[0]).toBe(0x41);
  return ethers.hexlify(raw.slice(1, 21));
}

const tronRequirement: PaymentRequirements = {
  scheme: 'atum-escrow',
  network: TRON,
  asset: TRON_TOKEN,
  amount: '10300000',
  payTo: TRON_ESCROW,
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
      escrow: TRON_ESCROW,
      fulfillmentProxy: DEST_FULFILLMENT_PROXY,
      reserver: TRON_RESERVER,
      releaser: TRON_RELEASER,
      fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
      quoteDeadlineSeconds: 20,
      fulfillmentDeadlineSeconds: 300,
    },
  },
};

describe('AtumEscrowFacilitatorScheme — trusted roles (Tron source)', () => {
  const tronTrust = (quoteSelector: string) =>
    trustTable({
      [TRON]: {
        escrowContract: tronHex(TRON_ESCROW),
        quoteSelector,
        fulfillmentVerifierAccount: TRON_RELEASER,
        fulfillmentProxy: tronHex(TRON_STRANGER),
        tokens: [{ symbol: 'USDT', address: TRON_TOKEN, decimals: 6 }],
      },
      [DEST]: facilitatorTrusts[DEST]!,
    });

  it('accepts trusted roles given in hex when the 402 uses base58', async () => {
    const payment = await signedFor(tronRequirement, tronWallet);

    const verified = await facilitator(tronTrust(tronHex(TRON_RESERVER))).verify(
      payment,
      tronRequirement,
    );

    expect(verified.isValid, verified.invalidReason).toBe(true);
  });

  it('still refuses a genuinely different Tron reserver', async () => {
    // Discriminator for the encoding-tolerance case above.
    await expectRefused(
      await signedFor(tronRequirement, tronWallet),
      tronRequirement,
      `extra.atum.reserver is not trusted by this facilitator on ${TRON}`,
      tronTrust(tronHex(TRON_STRANGER)),
    );
  });
});

// ── No trust option: the production gateways are the default trust source ────
function defaultsBody(network: string, roles: TrustedRoles) {
  return {
    chain_id: network,
    quote_selector: roles.quoteSelector,
    escrow_contract: roles.escrowContract,
    fulfillment_proxy: roles.fulfillmentProxy,
    fulfillment_verifier: {
      account: roles.fulfillmentVerifierAccount,
      endpoint: 'https://v.example',
    },
    tokens: roles.tokens,
  };
}

describe('AtumEscrowFacilitatorScheme — default trust source', () => {
  const MAINNET_GW = 'https://payment-gw.production-mainnet.atum.xyz';

  it('asks the production mainnet gateway and accepts when it vouches for the roles', async () => {
    const requirement = requirementWith();
    const payment = await signedFor(requirement);
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const href =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        requested.push(href);
        const url = new URL(href);
        const roles = facilitatorTrusts[url.searchParams.get('chain_id') ?? ''];
        if (url.origin !== MAINNET_GW || roles === undefined) {
          return new Response('not found', { status: 404 });
        }
        return Response.json(defaultsBody(url.searchParams.get('chain_id')!, roles));
      }),
    );

    const verified = await facilitator(undefined).verify(payment, requirement);

    expect(requested).toContain(`${MAINNET_GW}/v1/defaults?chain_id=${encodeURIComponent(SOURCE)}`);
    expect(verified.isValid, verified.invalidReason).toBe(true);
  });
});

// ── Solana source ────────────────────────────────────────────────────────────
// The same base58 fixture and deterministic Ed25519 payer as the facilitator's Solana tests.
const SOLANA: Network = 'solana:localnet';
const SOLANA_MINT = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
const SOLANA_ESCROW = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const SOLANA_RESERVER = 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq';
const SOLANA_RELEASER = 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY';
const SOLANA_STRANGER = bs58.encode(
  nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey,
);
const solKeypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
const solanaSigner: SolanaSigner = {
  publicKey: bs58.encode(solKeypair.publicKey),
  async sign(message: Uint8Array): Promise<Uint8Array> {
    return nacl.sign.detached(message, solKeypair.secretKey);
  },
};

function solanaRequirement(reserver: string): PaymentRequirements {
  return {
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
        reserver,
        releaser: SOLANA_RELEASER,
        fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
        quoteDeadlineSeconds: 20,
        fulfillmentDeadlineSeconds: 300,
        svmSignatureClusterId: 'localnet',
        svmSignatureDomainVersion: 5,
      },
    },
  };
}

/** A genuinely signed Solana payment, its issue time pinned to the signing clock. */
async function signedSolana(requirement: PaymentRequirements): Promise<PaymentPayload> {
  const client = new AtumEscrowClientScheme({
    signer: solanaSigner,
    now: SIGN_AT,
    trust: trustingThe402(requirement),
    solanaClockReader: async () => BigInt(Math.floor(SIGN_AT() / 1000)),
  });
  const result = await client.createPaymentPayload(2, requirement, named);
  return {
    x402Version: result.x402Version,
    accepted: requirement,
    payload: result.payload,
    extensions: result.extensions,
  } as unknown as PaymentPayload;
}

describe('AtumEscrowFacilitatorScheme — trusted roles (Solana source)', () => {
  const solanaTrust = () =>
    trustTable({
      [SOLANA]: {
        escrowContract: SOLANA_ESCROW,
        quoteSelector: SOLANA_RESERVER,
        fulfillmentVerifierAccount: SOLANA_RELEASER,
        fulfillmentProxy: DEST_FULFILLMENT_PROXY,
        tokens: [USDC_6(SOLANA_MINT)],
      },
      [DEST]: facilitatorTrusts[DEST]!,
    });

  it('accepts a Solana payment whose roles are trusted', async () => {
    // Discriminator for the refusal below: the fixture itself verifies.
    const requirement = solanaRequirement(SOLANA_RESERVER);
    const verified = await facilitator(solanaTrust()).verify(
      await signedSolana(requirement),
      requirement,
    );
    expect(verified.isValid, verified.invalidReason).toBe(true);
  });

  it('refuses an untrusted Solana reserver', async () => {
    const requirement = solanaRequirement(SOLANA_STRANGER);
    await expectRefused(
      await signedSolana(requirement),
      requirement,
      `extra.atum.reserver is not trusted by this facilitator on ${SOLANA}`,
      solanaTrust(),
    );
  });
});

// ── Solana: base58 letter case is identity ───────────────────────────────────
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * The same Solana address with the case of one letter flipped. Base58 is case-sensitive, so this
 * is a different, well-formed 32-byte account that a case-folding comparison would wrongly accept.
 * The last flippable letter is used, and the result is checked to still decode to 32 bytes, so a
 * refusal of it can only be due to case, never to a malformed key.
 */
function caseFlipped(address: string): string {
  for (let i = address.length - 1; i >= 0; i--) {
    const c = address[i]!;
    const f = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
    if (f === c || !BASE58_ALPHABET.includes(f)) continue;
    const flipped = address.slice(0, i) + f + address.slice(i + 1);
    expect(flipped).not.toBe(address);
    expect(flipped.toLowerCase()).toBe(address.toLowerCase());
    expect(bs58.decode(flipped).length).toBe(32);
    return flipped;
  }
  throw new Error(`no case-flippable base58 letter in ${address}`);
}

describe('AtumEscrowFacilitatorScheme — Solana roles are compared case-sensitively', () => {
  const solanaTrust = () =>
    trustTable({
      [SOLANA]: {
        escrowContract: SOLANA_ESCROW,
        quoteSelector: SOLANA_RESERVER,
        fulfillmentVerifierAccount: SOLANA_RELEASER,
        fulfillmentProxy: DEST_FULFILLMENT_PROXY,
        tokens: [USDC_6(SOLANA_MINT)],
      },
      [DEST]: facilitatorTrusts[DEST]!,
    });

  it('refuses an escrow differing from the trusted one only in letter case', async () => {
    // payTo names the same escrow, as a coherent 402 does; the escrow is the role reported.
    const nearMiss = caseFlipped(SOLANA_ESCROW);
    const base = solanaRequirement(SOLANA_RESERVER);
    const atum = (base.extra as { atum: Record<string, unknown> }).atum;
    const requirement: PaymentRequirements = {
      ...base,
      payTo: nearMiss,
      extra: { atumResource: 'GET /paid', atum: { ...atum, escrow: nearMiss } },
    };
    await expectRefused(
      await signedSolana(requirement),
      requirement,
      `extra.atum.escrow is not trusted by this facilitator on ${SOLANA}`,
      solanaTrust(),
    );
  });

  it('refuses a payTo differing from the trusted escrow only in letter case', async () => {
    // payTo is not part of what the payer signs, so it is rewritten on a genuinely signed payment
    // while extra.atum.escrow keeps naming the trusted contract.
    const signed = await signedSolana(solanaRequirement(SOLANA_RESERVER));
    const requirement: PaymentRequirements = {
      ...solanaRequirement(SOLANA_RESERVER),
      payTo: caseFlipped(SOLANA_ESCROW),
    };
    await expectRefused(
      { ...signed, accepted: requirement } as PaymentPayload,
      requirement,
      `payTo is not trusted by this facilitator on ${SOLANA}`,
      solanaTrust(),
    );
  });

  it('refuses a reserver differing from the trusted one only in letter case', async () => {
    const requirement = solanaRequirement(caseFlipped(SOLANA_RESERVER));
    await expectRefused(
      await signedSolana(requirement),
      requirement,
      `extra.atum.reserver is not trusted by this facilitator on ${SOLANA}`,
      solanaTrust(),
    );
  });
});

// ── Solana destination: the fulfillment proxy is a base58 role ───────────────
describe('AtumEscrowFacilitatorScheme — Solana destination fulfillment proxy is compared case-sensitively', () => {
  const SOLANA_FULFILLMENT_PROXY = bs58.encode(
    nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).publicKey,
  );
  const evmToSolanaTrust = () =>
    trustTable({
      [SOURCE]: facilitatorTrusts[SOURCE]!,
      [SOLANA]: {
        escrowContract: SOLANA_ESCROW,
        quoteSelector: SOLANA_RESERVER,
        fulfillmentVerifierAccount: SOLANA_RELEASER,
        fulfillmentProxy: SOLANA_FULFILLMENT_PROXY,
        tokens: [USDC_6(SOLANA_MINT)],
      },
    });
  const toSolana = (fulfillmentProxy: string) =>
    requirementWith({
      atum: {
        destination: { network: SOLANA, asset: SOLANA_MINT, address: SOLANA_RELEASER },
        fulfillmentProxy,
      },
    });

  it('accepts and settles an EVM-to-Solana payment naming the trusted proxy', async () => {
    // Discriminator for the refusal below: the corridor itself verifies and settles.
    const requirement = toSolana(SOLANA_FULFILLMENT_PROXY);
    const payment = await signedFor(requirement);
    const trust = evmToSolanaTrust();

    const verified = await facilitator(trust).verify(payment, requirement);
    expect(verified.isValid, verified.invalidReason).toBe(true);

    const submitter = countingSubmitter();
    const settled = await facilitator(trust, submitter).settle(payment, requirement);
    expect(settled.success, settled.errorReason).toBe(true);
    expect(submitter.calls).toBe(1);
  });

  it('refuses a proxy differing from the trusted one only in letter case', async () => {
    // The payer's client vouches for whatever the 402 names, so the near-miss is genuinely signed
    // and only the facilitator's case-sensitive comparison can refuse it.
    const requirement = toSolana(caseFlipped(SOLANA_FULFILLMENT_PROXY));
    await expectRefused(
      await signedFor(requirement),
      requirement,
      `extra.atum.fulfillmentProxy is not trusted by this facilitator on ${SOLANA}`,
      evmToSolanaTrust(),
    );
  });
});

// ── The facilitator entry re-exports the trust API ───────────────────────────
describe('facilitator entry — trust API', () => {
  it('re-exports the same trust values the client entry exports', () => {
    // An operator wiring only the facilitator must be able to configure its trust source without
    // importing the client, and the two entries must not ship divergent copies.
    expect(facilitatorEntry.atumGatewayTrust).toBe(clientEntry.atumGatewayTrust);
    expect(facilitatorEntry.ATUM_DEFAULT_TRUST_GATEWAYS).toBe(
      clientEntry.ATUM_DEFAULT_TRUST_GATEWAYS,
    );
    expect(facilitatorEntry.AtumEscrowTrustError).toBe(clientEntry.AtumEscrowTrustError);
  });

  it('re-exports the trust types, interchangeable with the client entry', () => {
    // Compile-time: each assignment only type-checks if the facilitator entry exports the type
    // and it is structurally the client's in both directions.
    const roles: facilitatorEntry.TrustedRoles = facilitatorTrusts[SOURCE]!;
    const back: clientEntry.TrustedRoles = roles;
    const token: facilitatorEntry.TrustedToken = back.tokens[0]!;
    const tokenBack: clientEntry.TrustedToken = token;
    const resolver: facilitatorEntry.TrustResolver = trustTable(facilitatorTrusts);
    const resolverBack: clientEntry.TrustResolver = resolver;
    expect(tokenBack).toEqual(USDC_6(SOURCE_ASSET));
    expect(typeof resolverBack).toBe('function');
  });
});
