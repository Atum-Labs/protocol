/**
 * The Stellar arm of the facilitator, and the client's route to it, against the shared sender_auth
 * SDK's real Stellar adapter: the client builds and signs a deposit, and the facilitator verifies
 * it, with no fake in between. What these tests pin is what this package owns: the scheme a Stellar
 * source must declare, that the signing key is the payer account, the deadline window, the
 * values the client reads before it signs, and that every refusal is raised before anything is
 * relayed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import nacl from 'tweetnacl';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import {
  assertStellarSignable,
  getChainAdapter,
  deterministicStellarNonce,
} from '@atum-labs/payment-request-sender-auth';
import { AtumEscrowClientScheme, type StellarSigner, type TrustResolver } from '../client';
import { PAYMENT_IDENTIFIER } from '../payment-identifier';
import { AtumEscrowFacilitatorScheme, type PaymentSubmitter } from './index';

const NETWORK = 'stellar:testnet';
const stellar = getChainAdapter(NETWORK);

/** A Stellar strkey: base32 of the version byte, the 32-byte payload and its CRC16-XModem. */
function strkey(versionByte: number, payload: Uint8Array): string {
  const body = Uint8Array.from([versionByte, ...payload]);
  let crc = 0;
  for (const byte of body) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  const bytes = Uint8Array.from([...body, crc & 0xff, crc >> 8]);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
}
const account = (seed: number) => strkey(6 << 3, new Uint8Array(32).fill(seed));
const contract = (seed: number) => strkey(2 << 3, new Uint8Array(32).fill(seed));

const keyPair = (seedByte: number) => nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
const accountOf = (pair: nacl.SignKeyPair) =>
  stellar.deriveDelegateSigner!(Buffer.from(pair.secretKey.slice(0, 32)).toString('hex'));
const signerOf = (pair: nacl.SignKeyPair): StellarSigner => ({
  publicKey: accountOf(pair),
  sign: async (m: Uint8Array) => nacl.sign.detached(m, pair.secretKey),
});

const PAYER_KEYS = keyPair(1);
const ATTACKER_KEYS = keyPair(2);
const ACCOUNT = accountOf(PAYER_KEYS);
const ATTACKER = accountOf(ATTACKER_KEYS);
const USDC_CONTRACT = contract(11);
const ESCROW = contract(12);
const RESERVER = account(13);
const RELEASER = account(14);
const DEST_ASSET = '0x52e52f345139e57b87d288c9ea794bb3fbe591c3';
const PROXY = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const EPOCH = 7n;
const DAY = 86_400;

const requirementFor = (fulfillmentDeadlineSeconds: number): PaymentRequirements => ({
  scheme: 'atum-escrow',
  network: NETWORK,
  asset: USDC_CONTRACT,
  amount: '10300000',
  payTo: ESCROW,
  maxTimeoutSeconds: 60,
  extra: {
    atumResource: 'GET /paid',
    atum: {
      destination: {
        network: 'eip155:42161',
        asset: DEST_ASSET,
        address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      },
      fulfillmentAmount: '10000000',
      escrow: ESCROW,
      fulfillmentProxy: PROXY,
      reserver: RESERVER,
      releaser: RELEASER,
      fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
      quoteDeadlineSeconds: 20,
      fulfillmentDeadlineSeconds,
    },
  },
});
const requirement = requirementFor(300);

const trust: TrustResolver = async (network) =>
  network === NETWORK
    ? {
        escrowContract: ESCROW,
        quoteSelector: RESERVER,
        fulfillmentVerifierAccount: RELEASER,
        fulfillmentProxy: PROXY,
        tokens: [{ symbol: 'USDC', address: USDC_CONTRACT, decimals: 6 }],
      }
    : {
        escrowContract: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
        quoteSelector: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        fulfillmentVerifierAccount: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
        fulfillmentProxy: PROXY,
        tokens: [{ symbol: 'USDC', address: DEST_ASSET, decimals: 6 }],
      };

const SIGN_MS = Date.parse('2026-07-08T12:00:00Z');
const SIGN_SEC = Math.floor(SIGN_MS / 1000);
const NOW_MS = SIGN_MS + 10_000;

let relayed = 0;
const submitter: PaymentSubmitter = {
  submit: async () => {
    relayed += 1;
    return { payment_id: 'pay_abc', status: 'pending', transactions: undefined };
  },
};
const facilitatorAt = (nowMs: number) =>
  new AtumEscrowFacilitatorScheme({ submitter, now: () => nowMs, trust });
const facilitator = facilitatorAt(NOW_MS);

const identifier = {
  extensions: { [PAYMENT_IDENTIFIER]: { info: { required: true, id: 'pay_order_test_0001' } } },
};

/** The epoch reads the client made, so a test can see what it asked and what it signed. */
const epochReads: unknown[] = [];
const clientFor = (signer: StellarSigner, over: Record<string, unknown> = {}) =>
  new AtumEscrowClientScheme({
    signer,
    now: () => SIGN_MS,
    trust,
    stellarClockReader: async () => BigInt(SIGN_SEC),
    stellarDelegateEpochReader: async (query) => {
      epochReads.push(query);
      return EPOCH;
    },
    ...over,
  });

async function payloadFor(
  client: AtumEscrowClientScheme,
  req: PaymentRequirements = requirement,
): Promise<PaymentPayload> {
  const result = await client.createPaymentPayload(2, req, identifier);
  return {
    x402Version: result.x402Version,
    accepted: req,
    payload: result.payload,
    extensions: result.extensions,
  } as unknown as PaymentPayload;
}

type Pr = {
  source: { account: string; asset_identifier: string };
  sender_auth: {
    message_scheme: string;
    signed_messages: Array<{
      message: string;
      message_prehash: string;
      signature: string;
      payload?: { delegate_signer?: string };
    }>;
  };
  max_source_amount: string;
};
const prOf = (p: PaymentPayload) =>
  (p as unknown as { payload: { paymentRequest: Pr } }).payload.paymentRequest;
const clone = (p: PaymentPayload) => JSON.parse(JSON.stringify(p)) as PaymentPayload;

let payload: PaymentPayload;
let dayPayload: PaymentPayload;

beforeAll(async () => {
  payload = await payloadFor(clientFor(signerOf(PAYER_KEYS)));
  dayPayload = await payloadFor(clientFor(signerOf(PAYER_KEYS)), requirementFor(DAY));
});

describe('the client on a Stellar source', () => {
  it('names the payer by the signer account and the token as a sep41 asset, and signs as STELLAR', () => {
    const pr = prOf(payload);
    expect(pr.source.account).toBe(ACCOUNT);
    expect(pr.sender_auth.message_scheme).toBe('STELLAR');
    expect(pr.source.asset_identifier).toBe(`${NETWORK}/sep41:${USDC_CONTRACT}`);
  });

  it('discloses its own account as the delegate signer', () => {
    expect(prOf(payload).sender_auth.signed_messages[0]!.payload).toEqual({
      delegate_signer: ACCOUNT,
    });
  });

  it('signs the epoch it read, the ledger issue time and a u64 nonce derived from the request', () => {
    const pr = prOf(payload);
    const prehash = JSON.parse(pr.sender_auth.signed_messages[0]!.message_prehash) as Record<
      string,
      string
    >;
    expect(prehash['epoch']).toBe(EPOCH.toString());
    expect(prehash['issued_at']).toBe(SIGN_SEC.toString());
    expect(BigInt(prehash['nonce']!)).toBeLessThan(1n << 64n);
    const requestId = (pr as unknown as { request_id: string }).request_id;
    expect(prehash['nonce']).toBe(
      deterministicStellarNonce({ requestId, depositor: ACCOUNT }).toString(),
    );
    expect(epochReads.at(-1)).toEqual({
      network: NETWORK,
      escrow: ESCROW,
      depositor: ACCOUNT,
      token: USDC_CONTRACT,
    });
  });

  it('refuses to sign without a delegate epoch reader, naming it', async () => {
    const client = new AtumEscrowClientScheme({
      signer: signerOf(PAYER_KEYS),
      now: () => SIGN_MS,
      trust,
    });
    await expect(payloadFor(client)).rejects.toThrow(/stellarDelegateEpochReader/);
  });

  it('signs nothing when the payer has no delegate registered, so the reader throws', async () => {
    const client = clientFor(signerOf(PAYER_KEYS), {
      stellarDelegateEpochReader: async () => {
        throw new Error('no delegate registered for the payer');
      },
    });
    await expect(payloadFor(client)).rejects.toThrow(/no delegate registered/);
  });

  it('refuses a fulfillment budget longer than the escrow admits, before signing', async () => {
    await expect(
      payloadFor(clientFor(signerOf(PAYER_KEYS)), requirementFor(DAY + 60)),
    ).rejects.toThrow(/exceeds the escrow's/);
  });

  it('refuses an account whose strkey checksum is wrong, though its shape is right', async () => {
    // The last character changed: still G followed by 55 base32 characters. The adapter's shape
    // check passes it, and the shared builder, which checks every strkey's checksum, refuses it
    // before the payer signs.
    const last = ACCOUNT.at(-1) === 'A' ? 'B' : 'A';
    const typo = { ...signerOf(PAYER_KEYS), publicKey: `${ACCOUNT.slice(0, -1)}${last}` };
    await expect(payloadFor(clientFor(typo))).rejects.toThrow(/depositor is not a G or C strkey/);
  });
});

describe('AtumEscrowFacilitatorScheme (Stellar source)', () => {
  it('verifies a real round trip against the requirement and returns the payer', async () => {
    const res = await facilitator.verify(payload, requirement);
    expect(res.isValid, res.invalidReason).toBe(true);
    expect(res.payer).toBe(ACCOUNT);
  });

  it('settles the same payment, relaying it once', async () => {
    relayed = 0;
    const res = await facilitator.settle(payload, requirement);
    // The stub gateway answers `pending`, which settle reports as not yet settled; what matters
    // here is that the verified payment was handed to the gateway, once.
    expect(res.errorReason).toBe('settlement_pending');
    expect(relayed).toBe(1);
  });

  it.each(['EVM_PERMIT2', 'SOLANA'])('refuses a Stellar payment relabelled %s', async (label) => {
    const copy = clone(payload);
    prOf(copy).sender_auth.message_scheme = label;
    const res = await facilitator.verify(copy, requirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toMatch(
      new RegExp(`unsupported message_scheme for ${NETWORK}: ${label}`),
    );
  });

  it('refuses an EVM payment relabelled STELLAR', async () => {
    const evmRequirement = { ...requirement, network: 'eip155:8453' } as PaymentRequirements;
    const res = await facilitator.verify(payload, evmRequirement);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toBe('unsupported message_scheme for eip155:8453: STELLAR');
  });

  it('refuses a signature that does not verify', async () => {
    const copy = clone(payload);
    const message = prOf(copy).sender_auth.signed_messages[0]!;
    message.signature = `0x${'00'.repeat(64)}`;
    const res = await facilitator.verify(copy, requirement);
    expect(res.isValid).toBe(false);
  });

  // The client signs a digest it built itself, but the key signs plain ed25519 over 32 bytes, which
  // is also how a Stellar transaction is signed, so the client runs the SDK's guard first. The
  // payload it produced must satisfy that guard, and a digest that is not the deposit must not.
  it('signs a message the SDK guard accepts for its network and escrow, and not another digest', () => {
    const message = prOf(payload).sender_auth.signed_messages[0]!;
    expect(() => assertStellarSignable(message, NETWORK, ESCROW)).not.toThrow();
    expect(() =>
      assertStellarSignable({ ...message, message: `0x${'ab'.repeat(32)}` }, NETWORK, ESCROW),
    ).toThrow(/refusing to sign bytes that are not the deposit/);
  });

  // The signature of an unrelated key over a deposit that names someone else's account as the
  // depositor. The shared library refuses a delegate that is not source.account (ErrDelegateUnverified
  // on the Go side), so the refusal is its message.
  describe('a deposit for one account signed by another key', () => {
    async function forged(): Promise<PaymentPayload> {
      const copy = clone(payload);
      const message = prOf(copy).sender_auth.signed_messages[0]!;
      const signature = nacl.sign.detached(
        Buffer.from(message.message.slice(2), 'hex'),
        ATTACKER_KEYS.secretKey,
      );
      message.signature = `0x${Buffer.from(signature).toString('hex')}`;
      message.payload = { delegate_signer: ATTACKER };
      return copy;
    }

    it('is refused, though the signature is valid for the key the payload names', async () => {
      const res = await facilitator.verify(await forged(), requirement);
      expect(res.isValid).toBe(false);
      expect(res.invalidReason).toMatch(/delegate signer is not source\.account/);
    });

    it('is never relayed', async () => {
      relayed = 0;
      const res = await facilitator.settle(await forged(), requirement);
      expect(res.success).toBe(false);
      expect(relayed).toBe(0);
    });

    it('is refused when the disclosed delegate is the payer but the key that signed is not', async () => {
      const copy = await forged();
      prOf(copy).sender_auth.signed_messages[0]!.payload = { delegate_signer: ACCOUNT };
      const res = await facilitator.verify(copy, requirement);
      expect(res.isValid).toBe(false);
    });
  });

  describe('the signed deadline', () => {
    const deadlineSec = SIGN_SEC + 300;

    it.each([
      ['exactly now', deadlineSec * 1000],
      ['a second ago', (deadlineSec + 1) * 1000],
    ])('refuses a deadline that is %s', async (_label, nowMs) => {
      const res = await facilitatorAt(nowMs).verify(payload, requirement);
      expect(res.isValid).toBe(false);
      expect(res.invalidReason).toMatch(/Stellar deposit authorization has expired/);
    });

    it.each([
      ['exactly a day ahead', SIGN_SEC, true],
      ['a day and a second ahead', SIGN_SEC - 1, false],
    ])(
      'on a day-long budget, a deadline %s is judged by the escrow bound',
      async (_label, nowSec, valid) => {
        const res = await facilitatorAt(nowSec * 1000).verify(dayPayload, requirementFor(DAY));
        expect(res.isValid, res.invalidReason).toBe(valid);
        if (!valid) expect(res.invalidReason).toMatch(/more than a day away/);
      },
    );

    it('never relays a payment whose deadline has passed', async () => {
      relayed = 0;
      const res = await facilitatorAt(deadlineSec * 1000).settle(payload, requirement);
      expect(res.success).toBe(false);
      expect(relayed).toBe(0);
    });
  });
});
