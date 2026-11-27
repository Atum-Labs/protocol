/**
 * Unit tests for the atum-escrow client scheme. The load-bearing assertion is that
 * the escrow-deposit signature recovers to the payer — proof the shared-encoder
 * typed data and the ethers signing round-trip agree. The emitted payload is also
 * validated against the published AtumEscrowPayload JSON Schema, and the
 * Milestone-A profile (no `presentation`) is checked.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Network, PaymentRequirements, SchemeNetworkClient } from '@x402/core/types';
import {
  deterministicFullRequestId,
  buildEscrowDestination,
  deriveDepositRequestHash,
  readDepositRequest,
} from '@atum-labs/payment-request-sender-auth';
import {
  AtumEscrowClientScheme,
  registerAtumEscrowScheme,
  type TrustResolver,
  type TrustedRoles,
} from './index';
import { PAYMENT_IDENTIFIER } from '../payment-identifier';
import type { SolanaSigner } from '../chain-adapters';

// The page every fixture requirement is published for, hashed as the request_id anchor folds it in.
const PAID_PAGE_HASH = ethers.keccak256(ethers.toUtf8Bytes('GET /paid')).slice(2);

// Well-known anvil account #0 — a throwaway dev key, safe to commit.
const PAYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// Every payment names the purchase it is for: the client refuses to build one that does not,
// since a payment with no identifier cannot be made re-attemptable.
const ANCHOR = 'pay_order_test_0001';
const wallet = new ethers.Wallet(PAYER_KEY);

const SOURCE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const requirement: PaymentRequirements = {
  scheme: 'atum-escrow',
  network: 'eip155:8453',
  asset: SOURCE_ASSET,
  amount: '10300000',
  payTo: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
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
      escrow: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
      fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      reserver: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      releaser: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
      quoteDeadlineSeconds: 20,
      fulfillmentDeadlineSeconds: 300,
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
  'tron:mainnet': {
    escrowContract: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m',
    quoteSelector: 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
    fulfillmentVerifierAccount: 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N',
    fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    tokens: [{ symbol: 'USDT', address: 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs', decimals: 6 }],
  },
};
const trust: TrustResolver = async (network) => {
  const roles = TRUSTED_ROLES[network];
  if (roles === undefined) throw new Error(`no trusted roles declared for ${network}`);
  return roles;
};

// Fixed clock so deadlines are deterministic.
const scheme = new AtumEscrowClientScheme({
  signer: wallet,
  now: () => Date.parse('2026-07-08T12:00:00Z'),
  trust,
});

/**
 * The 402's extensions with the purchase named, as the payer's `fetch` wrapper leaves them. The
 * client reads the identifier from here, so every payload built below supplies one.
 */
const named = { extensions: { [PAYMENT_IDENTIFIER]: { info: { required: true, id: ANCHOR } } } };

const payloadSchema = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../payload/schema.json', import.meta.url)), 'utf8'),
) as object;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validatePayload = ajv.compile(payloadSchema);

// ── Solana source fixture (Solana → EVM corridor) ────────────────────────────
// Base58 addresses from the svm encoding golden vectors. A deterministic throwaway
// Ed25519 keypair stands in for the payer's wallet (a Turnkey Solana signer would
// satisfy the same SolanaSigner interface).
const SOLANA_MINT = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
const SOLANA_ESCROW = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const SOLANA_ISSUED_AT = '1899999999';
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
  network: 'solana:localnet',
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
const solScheme = new AtumEscrowClientScheme({
  signer: solanaSigner,
  now: () => Date.parse('2026-07-08T12:00:00Z'),
  trust,
  // The payer stamps issued_at from the cluster clock the escrow judges it against; pinned here
  // so the signed deposit deadline below is an exact value rather than a moving one.
  solanaClockReader: async () => BigInt(SOLANA_ISSUED_AT),
});

describe('AtumEscrowClientScheme', () => {
  // The property that makes the committed destination safe, pinned.
  //
  // The escrow stores only keccak256(bytes(destination)) and has no rescue function, so if the
  // depositor signed one destination string and the release signer composed a different one, the
  // deposit would be neither releasable nor refundable. Nothing validates WHICH asset namespace
  // is used -- buildEscrowDestination only rejects a non-lowercase one -- so `spl:` and `token:`
  // both compose into valid but DIFFERENT commitments, and this repo emits `spl:` while every
  // normative artifact spells it `token:`.
  //
  // What makes that survivable is not the spellings agreeing. It is that the destination is
  // derived exactly ONCE per payment and transported verbatim: the client writes the same value
  // into the signed witness and into paymentRequest.destination[0], and the release signer reads
  // that field back rather than re-deriving it (atum-core solver-gw calls
  // SelectCommittedDestination then BuildDestination on the STORED request). Before this test
  // that invariant lived only in a source comment, so a future edit that re-derived the
  // identifier in either place would have composed a divergent commitment silently.
  it('signs the SAME destination string the request advertises (single derivation, verbatim)', async () => {
    const result = await scheme.createPaymentPayload(2, requirement, named);
    const pr = (result.payload as { paymentRequest: any }).paymentRequest;

    const witness = JSON.parse(pr.sender_auth.signed_messages[0].message_prehash).message.witness;
    // Composed through the shared helper from the REQUEST's own fields, exactly as the release
    // signer does. Comparing against a hand-built string would only re-test the helper.
    const fromRequest = buildEscrowDestination(
      pr.destination[0].asset_identifier,
      pr.destination[0].account,
    );

    expect(witness.destination).toBe(fromRequest);
    // And the deposit-request commitment is over the request id the body carries, not a second one.
    expect(witness.depositRequestHash).toBe(deriveDepositRequestHash(pr.request_id));
  });

  it('builds a PaymentRequest from extra.atum and signs a recoverable deposit authorization', async () => {
    const result = await scheme.createPaymentPayload(2, requirement, named);
    expect(result.x402Version).toBe(2);

    const pr = (result.payload as { paymentRequest: any }).paymentRequest;
    expect(pr.source.account).toBe(wallet.address);
    expect(pr.source.asset_identifier).toBe(`eip155:8453/erc20:${SOURCE_ASSET}`);
    expect(pr.destination[0].asset_identifier).toBe(
      'eip155:42161/erc20:0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
    );
    expect(pr.destination[0].account).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(pr.fulfillment_amount).toBe('10000000');
    expect(pr.max_source_amount).toBe('10300000');
    expect(pr.sender_auth.message_scheme).toBe('EVM_PERMIT2');

    // The signature recovers to the payer over the exact typed data that was signed
    // (message_prehash is a JSON string of the typed data).
    const { domain, types, message } = JSON.parse(
      pr.sender_auth.signed_messages[0].message_prehash,
    );
    const recovered = ethers.verifyTypedData(
      domain,
      types,
      message,
      pr.sender_auth.signed_messages[0].signature,
    );
    expect(recovered).toBe(wallet.address);
  });

  it('emits a payload that validates against the published AtumEscrowPayload schema', async () => {
    const result = await scheme.createPaymentPayload(2, requirement, named);
    // The framework wraps the scheme result with the accepted requirement.
    const payload = {
      x402Version: result.x402Version,
      accepted: requirement,
      payload: result.payload,
    };
    expect(validatePayload(payload), JSON.stringify(ajv.errors)).toBe(true);
  });

  it('omits presentation in the Milestone-A profile', async () => {
    const result = await scheme.createPaymentPayload(2, requirement, named);
    const pr = (result.payload as { paymentRequest: Record<string, unknown> }).paymentRequest;
    expect(pr.presentation).toBeUndefined();
  });

  it('refuses a requirement that does not name the page it pays for', async () => {
    // Without extra.atumResource the request_id cannot be bound to the page, so there is no
    // safe payment to build and no fallback.
    const { atumResource: _dropped, ...extra } = requirement.extra as Record<string, unknown>;
    const bad = { ...requirement, extra } as PaymentRequirements;
    await expect(scheme.createPaymentPayload(2, bad, named)).rejects.toThrow(/extra\.atumResource/);
  });

  it('derives a different request_id for the same purchase on another page', async () => {
    const onA = await scheme.createPaymentPayload(2, requirement, named);
    const onB = await scheme.createPaymentPayload(
      2,
      { ...requirement, extra: { ...requirement.extra, atumResource: 'GET /other' } },
      named,
    );
    const idOf = (r: { payload: Record<string, unknown> }) =>
      (r.payload as { paymentRequest: { request_id: string } }).paymentRequest.request_id;
    expect(idOf(onB)).not.toBe(idOf(onA));
  });

  it('rejects a requirement missing extra.atum', async () => {
    const bad = { ...requirement, extra: {} } as PaymentRequirements;
    await expect(scheme.createPaymentPayload(2, bad, named)).rejects.toThrow(/extra\.atum/);
  });

  it('rejects extra.atum missing a schema-required field (fulfillmentProxy)', async () => {
    // The prior hand-written guard omitted fulfillmentProxy; the schema requires it,
    // so the ajv-backed guard now catches its absence.
    const atum = { ...(requirement.extra as { atum: Record<string, unknown> }).atum };
    delete atum.fulfillmentProxy;
    const bad = {
      ...requirement,
      extra: { atumResource: 'GET /paid', atum },
    } as PaymentRequirements;
    await expect(scheme.createPaymentPayload(2, bad, named)).rejects.toThrow(/extra\.atum/);
  });

  it('rejects extra.atum with a malformed address', async () => {
    const atum = {
      ...(requirement.extra as { atum: Record<string, unknown> }).atum,
      escrow: 'not-an-address',
    };
    const bad = {
      ...requirement,
      extra: { atumResource: 'GET /paid', atum },
    } as PaymentRequirements;
    await expect(scheme.createPaymentPayload(2, bad, named)).rejects.toThrow(/extra\.atum/);
  });

  it('throws when the deadline ordering is violated', async () => {
    const atum = {
      ...(requirement.extra as { atum: Record<string, unknown> }).atum,
      quoteDeadlineSeconds: 300,
      fulfillmentDeadlineSeconds: 300, // quote must be strictly before fulfillment
    };
    const bad = {
      ...requirement,
      extra: { atumResource: 'GET /paid', atum },
    } as PaymentRequirements;
    await expect(scheme.createPaymentPayload(2, bad, named)).rejects.toThrow(
      /deadline ordering violated/,
    );
  });
});

describe('AtumEscrowClientScheme (Solana source)', () => {
  it('builds a SOLANA PaymentRequest with a base58 account, SPL asset id, and a delegate_signer', async () => {
    const result = await solScheme.createPaymentPayload(2, solanaRequirement, named);
    const pr = (result.payload as { paymentRequest: any }).paymentRequest;

    expect(pr.sender_auth.message_scheme).toBe('SOLANA');
    expect(pr.source.account).toBe(solPubkey);
    // Source keeps the Solana SPL CAIP-19 namespace (`spl:`), not EVM `erc20:`.
    expect(pr.source.asset_identifier).toBe(`solana:localnet/spl:${SOLANA_MINT}`);
    // Destination is EVM in this corridor, so it keeps the `erc20:` form.
    expect(pr.destination[0].asset_identifier).toBe(
      'eip155:42161/erc20:0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
    );
    expect(pr.destination[0].account).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    expect(pr.max_source_amount).toBe('10300000');

    // Ed25519 is not public-key recoverable, so the payer's key rides as delegate_signer.
    const signed = pr.sender_auth.signed_messages[0];
    expect(signed.payload.delegate_signer).toBe(solPubkey);

    // The prehash is the Solana deposit shape, and the deposit deadline is derived from
    // the payer-stamped issued_at + the replay horizon — NOT the (300s) fulfillment
    // budget, which would exceed Solana's ~128s replay window.
    const prehash = JSON.parse(signed.message_prehash);
    expect(prehash.depositor).toBe(solPubkey);
    expect(prehash.mint).toBe(SOLANA_MINT);
    expect(prehash.issued_at).toBe(SOLANA_ISSUED_AT);
    expect(prehash.deadline).toBe(String(Number(SOLANA_ISSUED_AT) + 120));

    // The Ed25519 signature verifies against the delegate_signer over the signed digest.
    const ok = nacl.sign.detached.verify(
      ethers.getBytes(signed.message),
      ethers.getBytes(signed.signature),
      bs58.decode(solPubkey),
    );
    expect(ok).toBe(true);
  });

  it('emits a Solana payload that validates against the published AtumEscrowPayload schema', async () => {
    const result = await solScheme.createPaymentPayload(2, solanaRequirement, named);
    const payload = {
      x402Version: result.x402Version,
      accepted: solanaRequirement,
      payload: result.payload,
    };
    expect(validatePayload(payload), JSON.stringify(ajv.errors)).toBe(true);
  });
});

// ── Tron source fixture (Tron → EVM corridor) ────────────────────────────────
// Base58 Tron addresses (34 chars) from the tvm/sender-auth golden vectors. The payer
// is the same secp256k1 wallet as EVM — a Tron address is the same 20 key-derived bytes,
// just base58check-encoded — so an ethers.Wallet drives the Tron (TIP-712) path.
const TRON_TOKEN = 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';
const TRON_ESCROW = 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m';
const TRON_RESERVER = 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp';
const TRON_RELEASER = 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N';
const tronRequirement: PaymentRequirements = {
  scheme: 'atum-escrow',
  network: 'tron:mainnet',
  asset: TRON_TOKEN,
  amount: '10300000',
  payTo: TRON_ESCROW,
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
const tronScheme = new AtumEscrowClientScheme({
  signer: wallet,
  now: () => Date.parse('2026-07-08T12:00:00Z'),
  trust,
});

describe('AtumEscrowClientScheme (Tron source)', () => {
  it('normalizes top-level roles to the hex form the signed witness carries; leaves escrow base58', async () => {
    const result = await tronScheme.createPaymentPayload(2, tronRequirement, named);
    const pr = (result.payload as { paymentRequest: any }).paymentRequest;
    // Tron reuses the EVM Permit2 (TIP-712) message scheme.
    expect(pr.sender_auth.message_scheme).toBe('EVM_PERMIT2');

    // The signed witness carries reserver/releaser as canonical 20-byte hex (the tvm
    // deposit-encoder runs normalizeAddress on them). The top-level request-body roles MUST
    // match that form, or the request the settlement backend verifies is internally
    // inconsistent (hex witness vs base58 body). This mirrors PGC resolveContractOverrides.
    const witness = JSON.parse(pr.sender_auth.signed_messages[0].message_prehash).message.witness;
    expect(witness.reserver).toMatch(/^0x[0-9a-f]{40}$/);
    expect(pr.quote_selector).toBe(witness.reserver);
    expect(pr.fulfillment_verifier.account).toBe(witness.releaser);

    // escrow_contract_address is deliberately left base58 (PGC leaves it base58 too).
    expect(pr.escrow_contract_address).toBe(TRON_ESCROW);
  });
});

/** Records the (network) keys a scheme is registered under; stands in for x402Client. */
class ClientRecorder {
  readonly networks: string[] = [];
  lastClient?: SchemeNetworkClient;
  register(network: Network, client: SchemeNetworkClient): this {
    this.networks.push(network);
    this.lastClient = client;
    return this;
  }
}

describe('registerAtumEscrowScheme (client)', () => {
  it('registers under the eip155 wildcard by default', () => {
    const recorder = new ClientRecorder();
    const returned = registerAtumEscrowScheme(recorder, { signer: wallet });
    expect(returned).toBe(recorder); // chainable: returns the same client
    expect(recorder.networks).toEqual(['eip155:*']);
  });

  it('registers under explicit networks when provided', () => {
    const recorder = new ClientRecorder();
    registerAtumEscrowScheme(recorder, {
      signer: wallet,
      networks: ['eip155:8453', 'eip155:42161'],
    });
    expect(recorder.networks).toEqual(['eip155:8453', 'eip155:42161']);
  });

  // Registration carries no payment-scoped state. A scheme instance outlives any single payment,
  // so an identifier configured here would be shared by every payment it ever builds — which
  // de-duplicates distinct purchases onto the first. The identifier is supplied per payment
  // instead, which is the one channel that varies.
  it('derives request_id from the purchase identifier, not from registration', async () => {
    const recorder = new ClientRecorder();
    registerAtumEscrowScheme(recorder, { signer: wallet, trust });
    const scheme = recorder.lastClient as AtumEscrowClientScheme;
    const pr = (
      (await scheme.createPaymentPayload(2, requirement, named)).payload as {
        paymentRequest: { request_id: string };
      }
    ).paymentRequest;
    expect(pr.request_id).toBe(
      deterministicFullRequestId({
        anchor: `${ANCHOR}:${PAID_PAGE_HASH}`,
        account: wallet.address,
        prefix: 'req_x402_',
      }),
    );
  });
});

// The 402 lists the depositRequestHash versions the merchant's facilitator accepts. The client
// signs v2, the hash of the request body it posts, when the list contains 2, and v1 otherwise.
describe('AtumEscrowClientScheme depositRequestHashVersions', () => {
  async function committedAndRead(versions: number[] | undefined) {
    const atum = (requirement.extra as { atum: Record<string, unknown> }).atum;
    const withVersions: PaymentRequirements = {
      ...requirement,
      extra: {
        atumResource: 'GET /paid',
        atum: versions === undefined ? atum : { ...atum, depositRequestHashVersions: versions },
      },
    };
    const result = await scheme.createPaymentPayload(2, withVersions, named);
    const { sender_auth: senderAuth, ...body } = (
      result.payload as { paymentRequest: Record<string, any> }
    ).paymentRequest;
    const witness = JSON.parse(senderAuth.signed_messages[0].message_prehash).message.witness;
    return {
      committed: witness.depositRequestHash as string,
      read: readDepositRequest(JSON.stringify(body)),
    };
  }

  it.each([[undefined], [[1]]])('signs v1 when the 402 lists %j', async (versions) => {
    const { committed, read } = await committedAndRead(versions);
    expect(committed).toBe(read.depositRequestHashV1);
  });

  it.each([[[1, 2]], [[2]], [[2, 3]]])('signs v2 when the 402 lists %j', async (versions) => {
    const { committed, read } = await committedAndRead(versions);
    expect(committed).toBe(read.depositRequestHashV2);
  });
});
