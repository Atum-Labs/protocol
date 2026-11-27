// Declaration content hash. Mirror of the Go lib's content_hash.go: both MUST return the same
// string for the same declaration, which the per-declaration conformance goldens pin.

import { getBytes, keccak256 } from 'ethers';

import { SECP256K1_RECOVERY_2020_V2_CTX_URL } from './documentLoader.js';
import type { DocumentLoader } from './documentLoader.js';
import { CRYPTOSUITE_SECP256K1_RECOVERY_2020, hashDocument } from './hash.js';

// computeContentHash returns "0x"+hex(keccak256(docHash)) of doc under [contextUrl, secp256k1recovery-2020/v2], the challenge a holder VP binds.
// Callers must reject unmapped keys first; it verifies no signature.
export async function computeContentHash(
  doc: Record<string, unknown>,
  contextUrl: string,
  loader: DocumentLoader,
): Promise<string> {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new TypeError('computeContentHash: document must be an object');
  }
  if (!contextUrl) {
    throw new TypeError('computeContentHash: empty declaration context URL');
  }
  if (!loader) {
    throw new TypeError('computeContentHash: missing document loader');
  }

  // The wire @context is dropped so a non-canonical one cannot fork the hash.
  const { '@context': _wireContext, ...stripped } = doc;
  void _wireContext;

  const suiteCtx = SECP256K1_RECOVERY_2020_V2_CTX_URL;
  // Only docHash is consumed; the placeholder proof options never reach the result.
  const { docHash } = await hashDocument(
    stripped,
    {
      cryptosuite: CRYPTOSUITE_SECP256K1_RECOVERY_2020,
      proofOptions: {
        type: CRYPTOSUITE_SECP256K1_RECOVERY_2020,
        created: '1970-01-01T00:00:00Z',
        verificationMethod: 'did:atum:content-hash#placeholder',
        proofPurpose: 'assertionMethod',
        context: suiteCtx,
      },
      defaultDocContext: [contextUrl, suiteCtx],
      stripVerifiableCredential: true,
    },
    loader,
  );

  return keccak256(getBytes(docHash));
}
