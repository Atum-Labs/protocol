import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import {
  ESCROW_LABEL_DEPOSIT,
  ESCROW_LABEL_REFUND,
  ESCROW_LABEL_RELEASE,
  ESCROW_LABEL_RESERVE,
  EscrowLabel,
  escrowEd25519Instruction,
  escrowMessage,
  escrowText,
} from './signed-text';

// Frozen Go-authored vectors (signed_text_test.go writes them, REGEN_SIGNED_TEXT=1); the
// program pins the same bytes in signatures.rs.
const __dirname = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(__dirname, '../../../../conformance/signed-text.json');

interface Vector {
  name: string;
  label: string;
  hash: string;
  text: string;
  bare: string;
  v1: string;
  v0: string;
  sigBare: string;
  sigV1: string;
  sigV0: string;
}

interface File {
  seed: string;
  publicKey: string;
  vectors: Vector[];
  nonCanonicalS: { name: string; message: string; signature: string }[];
}

const file = JSON.parse(readFileSync(vectorsPath, 'utf8')) as File;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function u16(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8);
}

const pk = hexToBytes(file.publicKey);

describe('escrow signed text conformance', () => {
  it('derives the pinned public key from the seed', () => {
    expect(toHex(ed25519.getPublicKey(hexToBytes(file.seed)))).toBe(file.publicKey);
  });

  it('has the four labels', () => {
    const labels = new Set(file.vectors.map((v) => v.label));
    expect([...labels].sort()).toEqual(
      [ESCROW_LABEL_DEPOSIT, ESCROW_LABEL_REFUND, ESCROW_LABEL_RELEASE, ESCROW_LABEL_RESERVE].sort(),
    );
  });

  for (const v of file.vectors) {
    it(`${v.name}: text and forms match`, () => {
      const hash = hexToBytes(v.hash);
      const label = v.label as EscrowLabel;
      expect(new TextDecoder().decode(escrowText(label, hash))).toBe(v.text);
      expect(toHex(escrowMessage('bare', label, hash, pk))).toBe(v.bare);
      expect(toHex(escrowMessage('v1', label, hash, pk))).toBe(v.v1);
      expect(toHex(escrowMessage('v0', label, hash, pk))).toBe(v.v0);
    });

    it(`${v.name}: signatures verify and are deterministic`, () => {
      const seed = hexToBytes(file.seed);
      for (const [msg, sig] of [
        [v.bare, v.sigBare],
        [v.v1, v.sigV1],
        [v.v0, v.sigV0],
      ] as const) {
        expect(ed25519.verify(hexToBytes(sig), hexToBytes(msg), pk)).toBe(true);
        expect(toHex(ed25519.sign(hexToBytes(msg), seed))).toBe(sig);
      }
    });
  }

  it('rejects the non-canonical S vectors', () => {
    for (const n of file.nonCanonicalS) {
      expect(ed25519.verify(hexToBytes(n.signature), hexToBytes(n.message), pk)).toBe(false);
    }
  });
});

describe('escrowEd25519Instruction', () => {
  const v = file.vectors[0]!;
  const sig = hexToBytes(v.sigBare);

  function parts(data: Uint8Array) {
    return {
      count: data[0],
      sig: data.subarray(u16(data, 2), u16(data, 2) + 64),
      pk: data.subarray(u16(data, 6), u16(data, 6) + 32),
      msg: data.subarray(u16(data, 10), u16(data, 10) + u16(data, 12)),
      indices: [u16(data, 4), u16(data, 8), u16(data, 14)],
    };
  }

  it('bare uses the web3.js layout', () => {
    const msg = hexToBytes(v.bare);
    const data = escrowEd25519Instruction('bare', pk, msg, sig);
    expect(data.length).toBe(112 + msg.length);
    const p = parts(data);
    expect(p.count).toBe(1);
    expect(p.indices).toEqual([0xffff, 0xffff, 0xffff]);
    expect(u16(data, 6)).toBe(16);
    expect(u16(data, 2)).toBe(48);
    expect(toHex(p.pk)).toBe(file.publicKey);
    expect(toHex(p.sig)).toBe(v.sigBare);
    expect(toHex(p.msg)).toBe(v.bare);
  });

  for (const [form, hex, sigHex, pkAt] of [
    ['v1', v.v1, v.sigV1, 18],
    ['v0', v.v0, v.sigV0, 51],
  ] as const) {
    it(`${form} points the pubkey offset inside the message`, () => {
      const msg = hexToBytes(hex);
      const data = escrowEd25519Instruction(form, pk, msg, hexToBytes(sigHex));
      expect(data.length).toBe(80 + msg.length);
      const p = parts(data);
      expect(u16(data, 6)).toBe(80 + pkAt);
      expect(toHex(p.pk)).toBe(file.publicKey);
      expect(toHex(p.sig)).toBe(sigHex);
      expect(toHex(p.msg)).toBe(hex);
    });

    it(`${form} refuses a message for another signer`, () => {
      const other = new Uint8Array(32).fill(7);
      expect(() => escrowEd25519Instruction(form, other, hexToBytes(hex), sig)).toThrow();
    });
  }

  it('validates lengths', () => {
    expect(() => escrowText(ESCROW_LABEL_DEPOSIT, new Uint8Array(31))).toThrow();
    expect(() => escrowMessage('v1', ESCROW_LABEL_DEPOSIT, new Uint8Array(32), new Uint8Array(31))).toThrow();
    expect(() => escrowEd25519Instruction('bare', pk, new Uint8Array(1), new Uint8Array(63))).toThrow();
  });
});
