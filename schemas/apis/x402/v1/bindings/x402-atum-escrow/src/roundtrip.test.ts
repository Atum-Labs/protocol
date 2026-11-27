/**
 * Offline mechanisms round-trip: the server scheme produces a 402 requirement, and
 * the client scheme consumes THAT requirement to produce a payment. This proves the
 * two halves agree on the `extra.atum` contract — the per-side unit tests use
 * independent fixtures, so only the round-trip catches drift between what the server
 * emits and what the client reads — and that the emitted payload satisfies the
 * published schema. No HTTP, no facilitator, no chain: a real 402 would additionally
 * need a facilitator advertising the scheme via /supported, which is out of scope.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { x402ResourceServer } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { AtumEscrowServerScheme, atumEscrowPrice, type AtumEscrowServerConfig } from './server';
import { buildRequirement } from './server/test-support';
import { PAYMENT_IDENTIFIER } from './payment-identifier';
import { AtumEscrowClientScheme, type TrustResolver, type TrustedRoles } from './client';
import type { SolanaSigner } from './chain-adapters';
import { AtumEscrowFacilitatorScheme, type PaymentSubmitter } from './facilitator';

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

// Well-known anvil account #0 — a throwaway dev key, safe to commit.
const PAYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const wallet = new ethers.Wallet(PAYER_KEY);

const payloadSchema = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../payload/schema.json', import.meta.url)), 'utf8'),
) as object;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validatePayload = ajv.compile(payloadSchema);

/** The identifier naming the purchase, and the 402 extensions that carry it to the client. */
const PURCHASE_ID = 'pay_order_test_0001';
const naming = (id: string) => ({
  extensions: { [PAYMENT_IDENTIFIER]: { info: { required: true, id } } },
});

describe('atum-escrow server→client round-trip', () => {
  it('server-built requirement drives a valid, recoverable client payment', async () => {
    const server = new AtumEscrowServerScheme(serverConfig);
    const client = new AtumEscrowClientScheme({
      signer: wallet,
      now: () => Date.parse('2026-07-08T12:00:00Z'),
      trust,
    });

    // Server side: price the source cap, then build the full requirement.
    const { asset, amount } = await server.parsePrice(
      atumEscrowPrice(serverConfig),
      SOURCE_NETWORK,
    );
    const base: PaymentRequirements = {
      scheme: 'atum-escrow',
      network: SOURCE_NETWORK,
      asset,
      amount,
      payTo: '',
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const { requirement } = await buildRequirement(server, base);

    // Client side: consume exactly that requirement (nothing hand-written in between).
    const result = await client.createPaymentPayload(2, requirement, naming(PURCHASE_ID));
    // The framework wraps the scheme result with the accepted requirement.
    const payload = {
      x402Version: result.x402Version,
      accepted: requirement,
      payload: result.payload,
      extensions: result.extensions,
    };

    // The emitted payload validates against the published AtumEscrowPayload schema.
    expect(validatePayload(payload), JSON.stringify(ajv.errors)).toBe(true);

    const pr = (result.payload as { paymentRequest: any }).paymentRequest;

    // The two halves agree: destination + fulfillment_amount round-trip from server config.
    expect(pr.destination[0].account).toBe(serverConfig.destination.address);
    expect(pr.destination[0].asset_identifier).toBe(
      `${serverConfig.destination.network}/erc20:${serverConfig.destination.asset}`,
    );
    expect(pr.fulfillment_amount).toBe(serverConfig.fulfillmentAmount);

    // Amount property: the client signs the full advertised cap (fulfillmentAmount + markup),
    // and it never exceeds the requirement's amount (the facilitator's accept condition).
    expect(pr.max_source_amount).toBe(amount);
    expect(BigInt(pr.max_source_amount) <= BigInt(requirement.amount)).toBe(true);

    // The deposit signature recovers to the payer over the exact typed data
    // (message_prehash is a JSON string of the typed data).
    const { domain, types, message } = JSON.parse(
      pr.sender_auth.signed_messages[0].message_prehash,
    );
    expect(
      ethers.verifyTypedData(domain, types, message, pr.sender_auth.signed_messages[0].signature),
    ).toBe(wallet.address);
  });
});

describe('atum-escrow server→client round-trip (Solana source)', () => {
  it('server-built Solana requirement drives a valid client payment', async () => {
    const SOLANA_NETWORK = 'solana:localnet';
    const solServerConfig: AtumEscrowServerConfig = {
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
      reserver: 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq',
      releaser: 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY',
      fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
      quoteDeadlineSeconds: 20,
      fulfillmentDeadlineSeconds: 300,
      now: () => Date.parse('2026-07-08T12:00:00Z'),
      sources: {
        [SOLANA_NETWORK]: {
          asset: 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8',
          escrow: '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR',
          symbol: 'USDC',
          decimals: 6,
          svmSignatureClusterId: 'localnet',
          svmSignatureDomainVersion: 5,
        },
      },
    };
    const server = new AtumEscrowServerScheme(solServerConfig);

    // A deterministic throwaway Ed25519 payer (a Turnkey Solana signer would satisfy
    // the same SolanaSigner interface).
    const solKeypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
    const solPubkey = bs58.encode(solKeypair.publicKey);
    const solanaSigner: SolanaSigner = {
      publicKey: solPubkey,
      async sign(message: Uint8Array): Promise<Uint8Array> {
        return nacl.sign.detached(message, solKeypair.secretKey);
      },
    };
    const client = new AtumEscrowClientScheme({
      signer: solanaSigner,
      now: () => Date.parse('2026-07-08T12:00:00Z'),
      trust,
    });

    const { asset, amount } = await server.parsePrice(
      atumEscrowPrice(solServerConfig),
      SOLANA_NETWORK,
    );
    const base: PaymentRequirements = {
      scheme: 'atum-escrow',
      network: SOLANA_NETWORK,
      asset,
      amount,
      payTo: '',
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const { requirement } = await buildRequirement(server, base);

    const result = await client.createPaymentPayload(2, requirement, naming(PURCHASE_ID));
    const payload = {
      x402Version: result.x402Version,
      accepted: requirement,
      payload: result.payload,
      extensions: result.extensions,
    };
    expect(validatePayload(payload), JSON.stringify(ajv.errors)).toBe(true);

    const pr = (result.payload as { paymentRequest: any }).paymentRequest;
    expect(pr.sender_auth.message_scheme).toBe('SOLANA');
    expect(pr.source.account).toBe(solPubkey);
    expect(pr.source.asset_identifier).toBe(`${SOLANA_NETWORK}/spl:${asset}`);
    // Ed25519 is not recoverable, so the payer key rides as delegate_signer.
    expect(pr.sender_auth.signed_messages[0].payload.delegate_signer).toBe(solPubkey);
  });
});

/**
 * Cross-route replay. The gateway de-duplicates on request_id and answers a resubmission with the
 * original receipt, so a request_id that did not depend on the page would let a payment for route A
 * be presented, with the same identifier, as payment for a same-priced route B.
 */
describe('atum-escrow cross-route replay', () => {
  const SIGNED_AT = Date.parse('2026-07-08T12:00:00Z');
  const submitted: string[] = [];
  const submitter: PaymentSubmitter = {
    submit: async (pr) => {
      submitted.push((pr as { request_id: string }).request_id);
      return {
        payment_id: 'pay_abc',
        status: 'completed',
        transactions: {
          deposit: { transaction_hash: '0x' + 'cd'.repeat(32), chain_id: SOURCE_NETWORK },
          fulfillment: { transaction_hash: '0x' + 'ab'.repeat(32), chain_id: 'eip155:42161' },
        },
      };
    },
  };
  const facilitator = new AtumEscrowFacilitatorScheme({
    submitter,
    now: () => SIGNED_AT + 10_000,
    trust,
  });
  const server = new AtumEscrowServerScheme(serverConfig);
  const client = new AtumEscrowClientScheme({ signer: wallet, now: () => SIGNED_AT, trust });
  const core = new x402ResourceServer().register(SOURCE_NETWORK, server);

  /** Route A and route B: same price, same payTo, different pages. */
  async function routes(): Promise<[PaymentRequirements, PaymentRequirements]> {
    const { asset, amount } = await server.parsePrice(
      atumEscrowPrice(serverConfig),
      SOURCE_NETWORK,
    );
    const base: PaymentRequirements = {
      scheme: 'atum-escrow',
      network: SOURCE_NETWORK,
      asset,
      amount,
      payTo: '',
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const a = (await buildRequirement(server, base, 'https://shop.test/reports/a')).requirement;
    const b = (await buildRequirement(server, base, 'https://shop.test/reports/b')).requirement;
    expect(a.amount).toBe(b.amount);
    expect(a.payTo).toBe(b.payTo);
    return [a, b];
  }

  async function pay(requirement: PaymentRequirements, id: string): Promise<PaymentPayload> {
    const result = await client.createPaymentPayload(2, requirement, naming(id));
    return {
      x402Version: result.x402Version,
      accepted: requirement,
      payload: result.payload,
      extensions: result.extensions,
    } as unknown as PaymentPayload;
  }
  const requestIdOf = (p: PaymentPayload) =>
    (p.payload as { paymentRequest: { request_id: string } }).paymentRequest.request_id;

  it('keeps a payment for route A from buying route B with the same identifier', async () => {
    const [routeA, routeB] = await routes();

    // Paying route A works.
    const paidA = await pay(routeA, PURCHASE_ID);
    expect(core.findMatchingRequirements([routeA], paidA)).toBeDefined();
    expect((await facilitator.verify(paidA, routeA)).isValid).toBe(true);
    expect((await facilitator.settle(paidA, routeA)).success).toBe(true);

    // The same payload sent to route B matches none of B's requirements.
    expect(core.findMatchingRequirements([routeB], paidA)).toBeUndefined();

    // Rewriting the echo to B's requirement gets past matching, but A's request_id is refused.
    const forged = { ...paidA, accepted: routeB } as PaymentPayload;
    expect(core.findMatchingRequirements([routeB], forged)).toBeDefined();
    const verdict = await facilitator.verify(forged, routeB);
    expect(verdict.isValid).toBe(false);
    expect(verdict.invalidReason).toMatch(/identifier and page/);
    submitted.length = 0;
    expect((await facilitator.settle(forged, routeB)).success).toBe(false);
    expect(submitted).toEqual([]);

    // An honest payment for B with the same identifier is a new payment.
    const paidB = await pay(routeB, PURCHASE_ID);
    expect(requestIdOf(paidB)).not.toBe(requestIdOf(paidA));
    expect((await facilitator.verify(paidB, routeB)).isValid).toBe(true);
  });

  it('reproduces the same request_id when the same route is paid again', async () => {
    const [routeA] = await routes();
    const first = await pay(routeA, PURCHASE_ID);
    const retry = await pay((await routes())[0], PURCHASE_ID);
    expect(requestIdOf(retry)).toBe(requestIdOf(first));
  });
});
