// Ed25519Signature2020 quote and VP proofs sign the raw signingInput by default
// and ed25519ProofMessage(signingInput) with textProof; verifiers accept both,
// and quote_hash stays keccak256(signingInput).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { keccak256 } from 'ethers';
import nacl from 'tweetnacl';
import { ed25519ProofMessage, encodeEd25519ProofValue } from '@atum-labs/ld-data-integrity';

import { hashQuote } from './hash.js';
import {
  ED25519_2020_CONTEXT_URL,
  FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
} from './canonicalize.js';
import { canonicalSigningInput, verifyQuote } from './verify.js';
import { computeQuoteHash } from './quote-hash.js';
import { verifyVP } from './verify-vp.js';
import { signQuoteEd25519 } from './sign-ed25519.js';
import { signVPEd25519 } from './sign-vp-ed25519.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../../../conformance/fixtures');
const readFixture = (name: string) =>
  JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf-8')) as Record<string, unknown>;

const GOLDEN_ED25519_QUOTE_HASH =
  '0xdc2d2df1f96d4224cec32e0ff4fc4f1a50a983396d1dc123f00a38d355c6517a';
const HOLDER = 'did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS';
const ZERO_SEED_KEY = nacl.sign.keyPair.fromSeed(new Uint8Array(32)).secretKey;
const TEXT_PROOF_CASES: [string, boolean | undefined, boolean][] = [
  ['unset', undefined, false],
  ['false', false, false],
  ['true', true, true],
];

function withProofValue(doc: Record<string, unknown>, msg: Uint8Array): Record<string, unknown> {
  const proof = { ...(doc.proof as Record<string, unknown>) };
  proof.proofValue = encodeEd25519ProofValue(nacl.sign.detached(msg, ZERO_SEED_KEY));
  return { ...doc, proof };
}

describe('ed25519 quote proof message', () => {
  it('verifies the raw and text forms, rejects another input, keeps quote_hash', async () => {
    const doc = readFixture('ed25519-ts-signed.json');
    const signingInput = await canonicalSigningInput(
      doc,
      doc.proof as Record<string, unknown>,
      'Ed25519Signature2020',
    );

    // The fixture is the default signer's output: a signature over the raw signingInput.
    expect(withProofValue(doc, signingInput)).toEqual(doc);
    await expect(
      verifyQuote(withProofValue(doc, ed25519ProofMessage(signingInput))),
    ).resolves.toBeDefined();
    await expect(verifyQuote(withProofValue(doc, signingInput))).resolves.toBeDefined();
    const other = Uint8Array.from(signingInput);
    other[0] ^= 0xff;
    for (const msg of [other, ed25519ProofMessage(other)]) {
      await expect(verifyQuote(withProofValue(doc, msg))).rejects.toThrow(
        'ed25519 signature verification failed',
      );
    }

    expect(keccak256(signingInput)).toBe(GOLDEN_ED25519_QUOTE_HASH);
    expect(await computeQuoteHash(doc)).toBe(GOLDEN_ED25519_QUOTE_HASH);
  });

  // The signer signs the raw signingInput unless textProof is true.
  for (const [name, textProof, text] of TEXT_PROOF_CASES) {
    it(`signQuoteEd25519 signs ${text ? 'the text' : 'raw'} with textProof ${name}`, async () => {
      const doc = readFixture('ed25519-ts-signed.json');
      const proof = doc.proof as Record<string, unknown>;
      const signingInput = await canonicalSigningInput(doc, proof, 'Ed25519Signature2020');
      const signed = await signQuoteEd25519(
        doc as unknown as Parameters<typeof signQuoteEd25519>[0],
        ZERO_SEED_KEY,
        {
          verificationMethod: proof.verificationMethod as string,
          created: proof.created as string,
          textProof,
        },
      );
      const msg = text ? ed25519ProofMessage(signingInput) : signingInput;
      expect(signed.proof.proofValue).toBe(
        (withProofValue(doc, msg).proof as Record<string, unknown>).proofValue,
      );
    });
  }
});

async function vpSigningInput(doc: Record<string, unknown>): Promise<Uint8Array> {
  const { proof: wireProof, ...body } = doc;
  const proof = wireProof as Record<string, unknown>;
  const { signingInput } = await hashQuote(body, {
    cryptosuite: 'Ed25519Signature2020',
    proofOptions: {
      type: 'Ed25519Signature2020',
      created: proof.created as string,
      verificationMethod: proof.verificationMethod as string,
      proofPurpose: proof.proofPurpose as string,
      challenge: proof.challenge as string,
      domain: proof.domain as string,
    },
    keepVerifiableCredential: true,
    proofContext: proof['@context'] ?? [
      FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
      ED25519_2020_CONTEXT_URL,
    ],
  });
  return signingInput;
}

describe('ed25519 VP proof message', () => {
  it('accepts a holder signature over the raw signingInput or its text', async () => {
    const doc = readFixture('ed25519-ts-vp.json');
    const signingInput = await vpSigningInput(doc);
    const opts = {
      expectedChallenge: 'req-fixture-1',
      expectedDomain: 'did:web:settler.atum.network',
      expectedHolder: HOLDER,
      now: new Date('2026-04-01T00:00:30Z'),
      maxProofAgeMs: 60 * 60 * 1000,
      maxFutureSkewMs: 60 * 60 * 1000,
    };

    const text = withProofValue(doc, ed25519ProofMessage(signingInput));
    expect((await verifyVP(JSON.stringify(text), opts)).holder).toBe(HOLDER);
    expect(withProofValue(doc, signingInput)).toEqual(doc);
    expect((await verifyVP(JSON.stringify(withProofValue(doc, signingInput)), opts)).holder).toBe(
      HOLDER,
    );
    const other = Uint8Array.from(signingInput);
    other[0] ^= 0xff;
    await expect(verifyVP(JSON.stringify(withProofValue(doc, other)), opts)).rejects.toThrow(
      'ed25519 signature verification failed',
    );
  });

  // The signer signs the raw signingInput unless textProof is true.
  for (const [name, textProof, text] of TEXT_PROOF_CASES) {
    it(`signVPEd25519 signs ${text ? 'the text' : 'raw'} with textProof ${name}`, async () => {
      const doc = readFixture('ed25519-ts-vp.json');
      const proof = doc.proof as Record<string, unknown>;
      const signingInput = await vpSigningInput(doc);
      const signed = await signVPEd25519(
        doc.verifiableCredential as Parameters<typeof signVPEd25519>[0],
        ZERO_SEED_KEY,
        {
          holder: HOLDER,
          verificationMethod: proof.verificationMethod as string,
          challenge: proof.challenge as string,
          domain: proof.domain as string,
          created: proof.created as string,
          textProof,
        },
      );
      const msg = text ? ed25519ProofMessage(signingInput) : signingInput;
      expect(signed.proof.proofValue).toBe(
        (withProofValue(doc, msg).proof as Record<string, unknown>).proofValue,
      );
    });
  }
});
