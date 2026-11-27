// PaymentRequest Ed25519Signature2020 proofs sign the raw signingInput by default
// and ed25519ProofMessage(signingInput) with textProof; the verifier accepts both.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import nacl from 'tweetnacl';
import { ed25519ProofMessage, encodeEd25519ProofValue } from '@atum-labs/ld-data-integrity';

import { canonicalSigningInput, verifyPaymentRequest } from './verify.js';
import { signPaymentRequestEd25519 } from './sign-ed25519.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../../../conformance/fixtures');
const ZERO_SEED_KEY = nacl.sign.keyPair.fromSeed(new Uint8Array(32)).secretKey;

function withProofValue(doc: Record<string, unknown>, msg: Uint8Array): Record<string, unknown> {
  const proof = { ...(doc.proof as Record<string, unknown>) };
  proof.proofValue = encodeEd25519ProofValue(nacl.sign.detached(msg, ZERO_SEED_KEY));
  return { ...doc, proof };
}

describe('ed25519 PaymentRequest proof message', () => {
  it('verifies the raw and text forms and rejects another input', async () => {
    const doc = JSON.parse(
      readFileSync(resolve(fixturesDir, 'ed25519-ts-signed.json'), 'utf-8'),
    ) as Record<string, unknown>;
    const signingInput = await canonicalSigningInput(
      doc,
      doc.proof as Record<string, unknown>,
      'Ed25519Signature2020',
    );

    await expect(verifyPaymentRequest(doc)).resolves.toBeDefined();
    await expect(
      verifyPaymentRequest(withProofValue(doc, ed25519ProofMessage(signingInput))),
    ).resolves.toBeDefined();
    expect(withProofValue(doc, signingInput)).toEqual(doc);
    await expect(verifyPaymentRequest(withProofValue(doc, signingInput))).resolves.toBeDefined();
    const other = Uint8Array.from(signingInput);
    other[0] ^= 0xff;
    await expect(verifyPaymentRequest(withProofValue(doc, other))).rejects.toThrow(
      'ed25519 signature verification failed',
    );
  });

  // The signer signs the raw signingInput unless textProof is true.
  for (const [name, textProof, text] of [
    ['unset', undefined, false],
    ['false', false, false],
    ['true', true, true],
  ] as const) {
    it(`signPaymentRequestEd25519 signs ${text ? 'the text' : 'raw'} with textProof ${name}`, async () => {
      const doc = JSON.parse(
        readFileSync(resolve(fixturesDir, 'ed25519-ts-signed.json'), 'utf-8'),
      ) as Record<string, unknown>;
      const proof = doc.proof as Record<string, unknown>;
      const signingInput = await canonicalSigningInput(doc, proof, 'Ed25519Signature2020');
      const signed = await signPaymentRequestEd25519(
        doc as unknown as Parameters<typeof signPaymentRequestEd25519>[0],
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
