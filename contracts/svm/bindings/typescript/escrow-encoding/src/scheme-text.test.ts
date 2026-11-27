import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import {
  MESSAGE_SCHEMES,
  SCHEME_ESCROW_TEXT_V1,
  SCHEME_RAW_HASH,
  WitnessKind,
  acceptedForms,
  matchEscrowWitness,
  messageForms,
  signingBytes,
  witnessLabel,
} from './scheme';
import {
  escrowEd25519Instruction,
  escrowMessage,
  escrowText,
  type EscrowMessageForm,
} from './signed-text';

const __dirname = dirname(fileURLToPath(import.meta.url));
const file = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../conformance/signed-text.json'), 'utf8'),
) as {
  seed: string;
  publicKey: string;
  vectors: {
    name: string;
    label: string;
    hash: string;
    bare: string;
    v1: string;
    v0: string;
    sigBare: string;
    sigV1: string;
    sigV0: string;
  }[];
  nonCanonicalS: { signature: string }[];
};

const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const seed = hexToBytes(file.seed);
const pk = ed25519.getPublicKey(seed);
const hash = Uint8Array.from({ length: 32 }, (_, i) => i);
const KINDS = [WitnessKind.Deposit, WitnessKind.Reserve, WitnessKind.Release, WitnessKind.Refund];
const ALL_FORMS: EscrowMessageForm[] = ['raw', 'bare', 'v1', 'v0'];

describe('escrow-text-v1 scheme', () => {
  it.each(KINDS)('signingBytes(text, %d) is the bare text', (kind) => {
    expect(signingBytes(SCHEME_ESCROW_TEXT_V1, kind, hash)).toEqual(
      escrowText(witnessLabel(kind), hash),
    );
  });

  it('signingBytes(text) is the frozen bare vector for every kind', () => {
    for (const v of file.vectors) {
      const kind = KINDS.find((k) => witnessLabel(k) === v.label)!;
      expect(
        Buffer.from(signingBytes(SCHEME_ESCROW_TEXT_V1, kind, hexToBytes(v.hash))).toString('hex'),
      ).toBe(v.bare);
    }
  });

  it.each([
    [SCHEME_RAW_HASH, ['raw']],
    [SCHEME_ESCROW_TEXT_V1, ['bare', 'v1', 'v0']],
  ])('messageForms(%j) = %j and acceptedForms is the scheme', (scheme, forms) => {
    expect(messageForms(scheme)).toEqual(forms);
    expect(acceptedForms(scheme)).toEqual([scheme]);
  });

  it.each(['text', ' ', 'escrow-text-v2', 'ESCROW-TEXT-V1'])('unknown scheme %j throws', (s) => {
    expect(() => messageForms(s)).toThrow('unknown message scheme');
    expect(() => signingBytes(s, WitnessKind.Deposit, hash)).toThrow('unknown message scheme');
    expect(
      matchEscrowWitness(s, WitnessKind.Deposit, hash, pk, new Uint8Array(64)),
    ).toBeUndefined();
  });

  it('knows exactly the raw and text schemes', () => {
    expect(MESSAGE_SCHEMES).toEqual(['', 'escrow-text-v1']);
  });
});

describe('matchEscrowWitness', () => {
  for (const scheme of MESSAGE_SCHEMES) {
    const accepted = messageForms(scheme);
    for (const kind of [WitnessKind.Deposit, WitnessKind.Reserve]) {
      for (const signed of ALL_FORMS) {
        const ok = accepted.includes(signed);
        it(`scheme ${JSON.stringify(scheme)} kind ${kind} ${signed}: ${ok ? 'matches' : 'refused'}`, () => {
          const msg = escrowMessage(signed, witnessLabel(kind), hash, pk);
          const got = matchEscrowWitness(scheme, kind, hash, pk, ed25519.sign(msg, seed));
          if (ok) expect(got).toEqual({ form: signed, message: msg });
          else expect(got).toBeUndefined();
        });
      }
    }
  }

  it('a deposit text does not authorize a reserve', () => {
    const sig = ed25519.sign(
      escrowMessage('bare', witnessLabel(WitnessKind.Deposit), hash, pk),
      seed,
    );
    expect(
      matchEscrowWitness(SCHEME_ESCROW_TEXT_V1, WitnessKind.Reserve, hash, pk, sig),
    ).toBeUndefined();
  });

  it('frozen vectors match their form under text and never under raw', () => {
    for (const v of file.vectors) {
      const kind = KINDS.find((k) => witnessLabel(k) === v.label)!;
      const h = hexToBytes(v.hash);
      for (const [form, msg, sig] of [
        ['bare', v.bare, v.sigBare],
        ['v1', v.v1, v.sigV1],
        ['v0', v.v0, v.sigV0],
      ] as const) {
        expect(matchEscrowWitness(SCHEME_ESCROW_TEXT_V1, kind, h, pk, hexToBytes(sig))).toEqual({
          form,
          message: hexToBytes(msg),
        });
        expect(matchEscrowWitness(SCHEME_RAW_HASH, kind, h, pk, hexToBytes(sig))).toBeUndefined();
      }
    }
    for (const n of file.nonCanonicalS) {
      expect(
        matchEscrowWitness(
          SCHEME_ESCROW_TEXT_V1,
          WitnessKind.Deposit,
          hash,
          pk,
          hexToBytes(n.signature),
        ),
      ).toBeUndefined();
    }
  });

  it('refuses malformed input', () => {
    const sig = ed25519.sign(hash, seed);
    expect(matchEscrowWitness(SCHEME_RAW_HASH, WitnessKind.Deposit, hash, pk, sig)?.form).toBe(
      'raw',
    );
    expect(matchEscrowWitness(SCHEME_RAW_HASH, 0 as WitnessKind, hash, pk, sig)).toBeUndefined();
    expect(
      matchEscrowWitness(SCHEME_RAW_HASH, WitnessKind.Deposit, hash.subarray(1), pk, sig),
    ).toBeUndefined();
    expect(
      matchEscrowWitness(SCHEME_RAW_HASH, WitnessKind.Deposit, hash, pk.subarray(1), sig),
    ).toBeUndefined();
    expect(
      matchEscrowWitness(SCHEME_RAW_HASH, WitnessKind.Deposit, hash, pk, sig.subarray(1)),
    ).toBeUndefined();
  });
});

describe('raw form', () => {
  it('escrowMessage(raw) is a copy of the hash', () => {
    const got = escrowMessage('raw', witnessLabel(WitnessKind.Deposit), hash, pk);
    expect(got).toEqual(hash);
    expect(got).not.toBe(hash);
  });

  it('escrowEd25519Instruction(raw) is the bare layout over the 32 byte hash', () => {
    const sig = ed25519.sign(hash, seed);
    expect(escrowEd25519Instruction('raw', pk, hash, sig)).toEqual(
      escrowEd25519Instruction('bare', pk, hash, sig),
    );
    expect(() => escrowEd25519Instruction('raw', pk, hash.subarray(1), sig)).toThrow(
      'message must be 32 bytes',
    );
  });
});
