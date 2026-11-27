import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import nacl from 'tweetnacl';

import {
  ED25519_PROOF_MESSAGE_PREFIX,
  ed25519ProofMessage,
  MalformedProofError,
  verifyEd25519Proof,
} from './index.js';

interface VectorFile {
  prefix: string;
  vectors: { name: string; signingInputHex: string; message: string }[];
  invalidSigningInputLengths: number[];
}

const VECTORS_PATH = new URL('../../conformance/ed25519-proof-message.json', import.meta.url);
const f = JSON.parse(readFileSync(VECTORS_PATH, 'utf-8')) as VectorFile;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

describe('ed25519ProofMessage conformance', () => {
  it('pins the prefix', () => {
    expect(f.prefix).toBe(ED25519_PROOF_MESSAGE_PREFIX);
    expect(f.vectors.length).toBeGreaterThan(0);
  });

  for (const v of f.vectors) {
    it(`matches vector ${v.name}`, () => {
      const got = ed25519ProofMessage(hexToBytes(v.signingInputHex));
      expect(got.length).toBe(103);
      expect(new TextDecoder().decode(got)).toBe(v.message);
    });
  }

  for (const n of f.invalidSigningInputLengths) {
    it(`rejects a ${n} byte signing input`, () => {
      expect(() => ed25519ProofMessage(new Uint8Array(n))).toThrow(MalformedProofError);
    });
  }
});

describe('verifyEd25519Proof', () => {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32));
  const input = Uint8Array.from({ length: 64 }, (_, i) => i);
  const sign = (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey);

  it('accepts the raw signing input and its text form', () => {
    expect(verifyEd25519Proof(kp.publicKey, input, sign(input))).toBe(true);
    expect(verifyEd25519Proof(kp.publicKey, input, sign(ed25519ProofMessage(input)))).toBe(true);
  });

  it('rejects anything else', () => {
    const other = Uint8Array.from(input);
    other[0] ^= 0xff;
    const body = new TextDecoder()
      .decode(ed25519ProofMessage(input))
      .slice(ED25519_PROOF_MESSAGE_PREFIX.length);
    const relabel = (p: string) => new TextEncoder().encode(p + body);
    const prefixed = new Uint8Array([
      ...new TextEncoder().encode(ED25519_PROOF_MESSAGE_PREFIX),
      ...input,
    ]);
    for (const m of [
      other,
      ed25519ProofMessage(other),
      input.slice(0, 63),
      new Uint8Array([...input, 0]),
      prefixed,
      ...['atum ld-proof v2 ', 'atum deposit v1 ', 'atum release v1 ', ''].map(relabel),
      input.slice(0, 32),
    ]) {
      expect(verifyEd25519Proof(kp.publicKey, input, sign(m))).toBe(false);
    }
  });
});
