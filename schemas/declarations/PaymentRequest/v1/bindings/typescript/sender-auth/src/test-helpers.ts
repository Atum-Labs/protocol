// Shared by the test suites only: the fake chain checker the signature vectors run against, and
// small-order ed25519 forgeries. Nothing in the library imports this file.

import { createHash } from 'node:crypto';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { ContractSignatureAnswer, DepositorSignatureChecker } from './depositor-signature.js';

/** The one account the fake checker models. See depositor-signature-vectors.json's _comment. */
export interface FakeChain {
  code?: string;
  isValidSignature?: { returnData?: string; reverts?: boolean; onlyCaller?: string };
  unavailable?: 'hasCode' | 'isValidSignatureFrom';
}

/** One call the fake checker received, with its arguments in hex. */
export interface CheckerCall {
  method: string;
  network: string;
  account: string;
  digest?: string;
  signature?: string;
  caller?: string;
}

/** Answers from a FakeChain and records every call. Mirrors the Go fakeChecker. */
export function fakeChecker(
  chain: FakeChain = {},
): DepositorSignatureChecker & { calls: CheckerCall[] } {
  const calls: CheckerCall[] = [];
  const hasCodeAt = chain.code !== undefined && chain.code !== '' && chain.code !== '0x';
  return {
    calls,
    async hasCode(network, account) {
      calls.push({ method: 'hasCode', network, account });
      if (chain.unavailable === 'hasCode') throw new Error('the chain is unavailable');
      return hasCodeAt;
    },
    async isValidSignatureFrom(
      network,
      account,
      digest,
      signature,
      caller,
    ): Promise<ContractSignatureAnswer> {
      calls.push({ method: 'isValidSignatureFrom', network, account, digest, signature, caller });
      if (chain.unavailable === 'isValidSignatureFrom') {
        throw new Error('the chain is unavailable');
      }
      const answer = chain.isValidSignature;
      // eth_call to an account with no code succeeds and returns nothing.
      if (!hasCodeAt || answer === undefined) return { reverted: false, returnData: '0x' };
      if (answer.reverts === true) return { reverted: true, returnData: '0x' };
      if (answer.onlyCaller !== undefined && caller !== answer.onlyCaller) {
        return { reverted: false, returnData: '0xffffffff' + '0'.repeat(56) };
      }
      return { reverted: false, returnData: answer.returnData ?? '0x' };
    },
  };
}

// ─── Small-order ed25519 forgeries ──────────────────────────────────────────
// Plain ed25519 verification accepts these; the Solana program's strict verification does not.
// Mirrors the Go ed25519_strict_test.go helpers.

export const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;

const leToBigInt = (b: Uint8Array): bigint => {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
  return v;
};

const bigIntToLe32 = (v: bigint): Buffer => {
  const b = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
};

/** The ed25519 secret scalar of a seed, reduced mod L. */
const secretScalar = (seed: Uint8Array): bigint => {
  const h = createHash('sha512').update(seed).digest();
  h[0]! &= 248;
  h[31]! &= 127;
  h[31]! |= 64;
  return leToBigInt(h.subarray(0, 32)) % ED25519_L;
};

/** The identity point's canonical encoding. */
export const IDENTITY_POINT = Buffer.from('01' + '00'.repeat(31), 'hex');

/** The identity point as a base58 public key: any signature with R = [S]B verifies under it. */
export const SMALL_ORDER_KEY = bs58.encode(IDENTITY_POINT);

/** seed's signature-shaped pair R = [a]B, S = a: valid under a small-order key whenever [k]A is the identity. */
const pairOf = (seed: Uint8Array): string =>
  '0x' +
  Buffer.from(nacl.sign.keyPair.fromSeed(seed).publicKey).toString('hex') +
  bigIntToLe32(secretScalar(seed)).toString('hex');

/** A signature valid for SMALL_ORDER_KEY over any message. */
export const smallOrderKeySignature = (): string => pairOf(new Uint8Array(32).fill(9));

/**
 * A signature over digest that plain verification accepts under publicKey, a small-order point, or
 * undefined when none of the first 256 seeds gives one (publicKey is then not a small-order point
 * the verifier can decode). For a point of order n, about one seed in n works.
 */
export const forgeForSmallOrderKey = (
  publicKey: Uint8Array,
  digest: Uint8Array,
): string | undefined => {
  for (let i = 1; i <= 256; i++) {
    const seed = new Uint8Array(32);
    seed[0] = i & 0xff;
    seed[1] = i >> 8;
    const signature = pairOf(seed);
    if (nacl.sign.detached.verify(digest, Buffer.from(signature.slice(2), 'hex'), publicKey)) {
      return signature;
    }
  }
  return undefined;
};

/** seed's signature over digest with R the identity point: S = k·a satisfies [S]B = R + [k]A. */
export const smallOrderRSignature = (digest: string, seed: Uint8Array): string => {
  const publicKey = nacl.sign.keyPair.fromSeed(seed).publicKey;
  const k =
    leToBigInt(
      createHash('sha512')
        .update(Buffer.concat([IDENTITY_POINT, publicKey, Buffer.from(digest.slice(2), 'hex')]))
        .digest(),
    ) % ED25519_L;
  return (
    '0x' +
    IDENTITY_POINT.toString('hex') +
    bigIntToLe32((k * secretScalar(seed)) % ED25519_L).toString('hex')
  );
};

/** The same ed25519 signature with S + L: the same point equation, but a non-canonical encoding. */
export function nonCanonicalEd25519(signature: string): string {
  const bytes = Buffer.from(signature.slice(2), 'hex');
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(bytes[i]!);
  s += ED25519_L;
  for (let i = 32; i < 64; i++) {
    bytes[i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return '0x' + bytes.toString('hex');
}
