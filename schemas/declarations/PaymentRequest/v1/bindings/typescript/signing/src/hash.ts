// hashPaymentRequest produces the W3C Data Integrity signing input for a
// PaymentRequest under a given cryptosuite. A thin adapter over
// @atum-labs/ld-data-integrity's hashDocument; the canonicalize-then-hash
// pipeline (URDNA2015 + keccak256 or SHA-256 + combined composition) is
// owned by the shared TS lib so PaymentRequest TS + PaymentRequest Go
// share a single implementation per side.

import {
  hashDocument,
  type HashResult as LibHashResult,
} from "@atum-labs/ld-data-integrity";

import {
  PAYMENT_REQUEST_CONTEXT_URL,
  SECP256K1_RECOVERY_CONTEXT_URL,
  ED25519_2020_CONTEXT_URL,
  prLoader,
} from "./canonicalize.js";

export type Cryptosuite =
  | "EcdsaSecp256k1RecoverySignature2020"
  | "Ed25519Signature2020";

export interface HashableProofOptions {
  type: Cryptosuite;
  created: string;
  verificationMethod: string;
  proofPurpose: string;
  challenge?: string;
  domain?: string;
}

export interface HashPaymentRequestOptions {
  cryptosuite: Cryptosuite;
  proofOptions: HashableProofOptions;
  // Optional verbatim @context for the proof block. Defaults to the
  // canonical IRI for the cryptosuite.
  proofContext?: unknown;
  // Mirrors the FQ option's negated semantics against the lib's
  // stripVerifiableCredential. The inner PaymentRequest is NOT a VP, so
  // callers leave it false (default) — any verifiableCredential field is
  // defensively stripped.
  keepVerifiableCredential?: boolean;
}

export interface HashResult {
  signingInput: Uint8Array;
  cryptosuite: Cryptosuite;
  docHash: Uint8Array;
  proofHash: Uint8Array;
}

const SUITE_CONTEXT: Record<Cryptosuite, string> = {
  EcdsaSecp256k1RecoverySignature2020: SECP256K1_RECOVERY_CONTEXT_URL,
  Ed25519Signature2020: ED25519_2020_CONTEXT_URL,
};

// hashPaymentRequest is the PaymentRequest-public hashing function. Thin
// adapter over [hashDocument] from @atum-labs/ld-data-integrity. The
// PaymentRequest-specific behavior preserved here:
//
//   - defaultDocContext is [PaymentRequestContext, suiteContext]; the lib
//     injects it only when the caller doc has no @context.
//   - keepVerifiableCredential maps to the lib's
//     stripVerifiableCredential (negated semantics).
//   - HashResult shape matches the lib's exactly.
//
// Shares the process-level prLoader instance with canonicalize.ts.
export async function hashPaymentRequest(
  request: Record<string, unknown>,
  options: HashPaymentRequestOptions
): Promise<HashResult> {
  const suiteContext = SUITE_CONTEXT[options.cryptosuite];

  const result: LibHashResult = await hashDocument(
    request,
    {
      cryptosuite: options.cryptosuite,
      proofOptions: {
        type: options.proofOptions.type,
        created: options.proofOptions.created,
        verificationMethod: options.proofOptions.verificationMethod,
        proofPurpose: options.proofOptions.proofPurpose,
        context: options.proofContext,
        challenge: options.proofOptions.challenge,
        domain: options.proofOptions.domain,
      },
      defaultDocContext: [PAYMENT_REQUEST_CONTEXT_URL, suiteContext],
      stripVerifiableCredential: !options.keepVerifiableCredential,
    },
    prLoader
  );

  return {
    signingInput: result.signingInput,
    cryptosuite: result.cryptosuite as Cryptosuite,
    docHash: result.docHash,
    proofHash: result.proofHash,
  };
}
