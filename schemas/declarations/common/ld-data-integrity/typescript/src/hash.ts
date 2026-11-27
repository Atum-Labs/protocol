// W3C Data Integrity signing-input composition. Mirror of the Go
// lib's hash.go. Both halves MUST stay in lockstep on canonical
// n-quads + hash composition or the cross-language signing round
// trip silently breaks.
//
// Cryptosuite-specific composition:
//
//   EcdsaSecp256k1RecoverySignature2020:
//     signingInput = keccak256(proofHash || docHash)
//     per-hash     = keccak256(canonical n-quads)
//
//   Ed25519Signature2020:
//     signingInput = proofHash || docHash   (raw 64-byte concat)
//     per-hash     = SHA-256(canonical n-quads)

import { createHash } from "node:crypto";

import { keccak256, getBytes } from "ethers";

import {
  canonicalize,
} from "./canonicalize.js";
import {
  SECP256K1_RECOVERY_2020_V2_CTX_URL,
  ED25519_SIGNATURE_2020_V1_CTX_URL,
} from "./documentLoader.js";
import type { DocumentLoader } from "./documentLoader.js";
import {
  MalformedProofError,
  UnsupportedProofTypeError,
} from "./errors.js";

// Cryptosuite identifiers per W3C Data Integrity 1.0. Aliased to the
// string literals the FQ verifier dispatches on; mismatches here
// would produce signatures no verifier on the network accepts.
export type Cryptosuite =
  | "EcdsaSecp256k1RecoverySignature2020"
  | "Ed25519Signature2020";

export const CRYPTOSUITE_SECP256K1_RECOVERY_2020: Cryptosuite =
  "EcdsaSecp256k1RecoverySignature2020";
export const CRYPTOSUITE_ED25519_SIGNATURE_2020: Cryptosuite =
  "Ed25519Signature2020";

// ProofOptions are the W3C Data Integrity proof fields that participate
// in canonicalization. proofValue / jws are excluded by design — they
// are computed FROM the signingInput hashDocument returns.
export interface ProofOptions {
  type: Cryptosuite;
  created: string;
  verificationMethod: string;
  proofPurpose: string;
  // Optional verbatim @context for the proof block. Verifiers pass
  // the wire value so a non-canonical-but-equivalent signer doesn't
  // produce hashes that silently diverge from the signed bytes.
  // When unset, hashDocument falls back to the canonical IRI for
  // the cryptosuite.
  context?: unknown;
  // Challenge + domain are VP-only (W3C VC Data Model v1.1 §5.6) and
  // stay optional so existing FulfillmentQuote callers are unaffected.
  challenge?: string;
  domain?: string;
}

export interface HashOptions {
  cryptosuite: Cryptosuite;
  proofOptions: ProofOptions;
  // defaultDocContext is the @context to inject when the caller doc
  // lacks one. Schema-specific callers pass their declaration's
  // context URL array (e.g. [FulfillmentQuote, suiteContext]); a
  // verifier reconstructing the hash reads the verbatim @context
  // from the wire bytes and doesn't fall through to this default.
  // Undefined means "if the doc has no @context, canonicalize
  // without injecting one" — useful for tests; not what production
  // signers want.
  defaultDocContext?: unknown;
  // stripVerifiableCredential — see Go lib's HashOptions:
  //   true  → strip the array (FQ-mode; defensive, protects against
  //           re-sign carryover).
  //   false → keep the array (VP-mode; the VC array IS the signed
  //           payload).
  stripVerifiableCredential?: boolean;
}

export interface HashResult {
  signingInput: Uint8Array;
  cryptosuite: Cryptosuite;
  docHash: Uint8Array;
  proofHash: Uint8Array;
}

const SUITE_CONTEXT: Record<Cryptosuite, string> = {
  EcdsaSecp256k1RecoverySignature2020: SECP256K1_RECOVERY_2020_V2_CTX_URL,
  Ed25519Signature2020: ED25519_SIGNATURE_2020_V1_CTX_URL,
};

function suiteContextURL(cs: string): string | undefined {
  return SUITE_CONTEXT[cs as Cryptosuite];
}

// hashDocument composes the signingInput for a JSON-LD document under
// the given cryptosuite. See the module doc-comment for the
// composition rules.
//
// Input rules:
//   - doc's `proof` block is ALWAYS stripped (load-bearing — the
//     proof is what's being computed; it can't input to itself).
//   - doc's `verifiableCredential` array is stripped iff
//     stripVerifiableCredential === true.
//   - doc's `@context` is preserved verbatim if present; otherwise
//     opts.defaultDocContext is injected (or omitted if undefined).
export async function hashDocument(
  doc: Record<string, unknown>,
  opts: HashOptions,
  loader: DocumentLoader
): Promise<HashResult> {
  const suiteCtx = suiteContextURL(opts.cryptosuite);
  if (!suiteCtx) {
    throw new UnsupportedProofTypeError(opts.cryptosuite);
  }
  if (opts.proofOptions.type !== opts.cryptosuite) {
    // Cheap typo guard. Mismatched type/cryptosuite would canonicalize
    // the proof block under the wrong IRI and produce a signingInput
    // no verifier on the network would reconstruct.
    throw new MalformedProofError(
      `ProofOptions.type (${opts.proofOptions.type}) must match cryptosuite (${opts.cryptosuite})`
    );
  }

  // Strip proof + (optionally) verifiableCredential before canonicalize.
  const {
    proof: _proof,
    verifiableCredential: existingVC,
    "@context": existingContext,
    ...bareWithoutVC
  } = doc as Record<string, unknown> & {
    proof?: unknown;
    verifiableCredential?: unknown;
    "@context"?: unknown;
  };
  void _proof;

  const bare: Record<string, unknown> =
    opts.stripVerifiableCredential || existingVC === undefined
      ? bareWithoutVC
      : { ...bareWithoutVC, verifiableCredential: existingVC };

  const context =
    existingContext !== undefined
      ? existingContext
      : opts.defaultDocContext;

  const docForCanon: Record<string, unknown> =
    context !== undefined ? { "@context": context, ...bare } : bare;

  // Build the proof block. Required fields first (canonical order
  // matches the Go lib's HashDocument).
  const proofForCanon: Record<string, unknown> = {
    "@context": opts.proofOptions.context ?? suiteCtx,
    type: opts.proofOptions.type,
    created: opts.proofOptions.created,
    verificationMethod: opts.proofOptions.verificationMethod,
    proofPurpose: opts.proofOptions.proofPurpose,
  };
  if (opts.proofOptions.challenge) {
    proofForCanon.challenge = opts.proofOptions.challenge;
  }
  if (opts.proofOptions.domain) {
    proofForCanon.domain = opts.proofOptions.domain;
  }

  const canonicalDoc = await canonicalize(docForCanon, loader);
  const canonicalProof = await canonicalize(proofForCanon, loader);

  switch (opts.cryptosuite) {
    case "EcdsaSecp256k1RecoverySignature2020": {
      const docHash = getBytes(keccak256(Buffer.from(canonicalDoc)));
      const proofHash = getBytes(keccak256(Buffer.from(canonicalProof)));
      const combined = Buffer.concat([
        Buffer.from(proofHash),
        Buffer.from(docHash),
      ]);
      const signingInput = getBytes(keccak256(combined));
      return { signingInput, cryptosuite: opts.cryptosuite, docHash, proofHash };
    }
    case "Ed25519Signature2020": {
      const docHash = new Uint8Array(
        createHash("sha256").update(canonicalDoc).digest()
      );
      const proofHash = new Uint8Array(
        createHash("sha256").update(canonicalProof).digest()
      );
      const signingInput = new Uint8Array(proofHash.length + docHash.length);
      signingInput.set(proofHash, 0);
      signingInput.set(docHash, proofHash.length);
      return { signingInput, cryptosuite: opts.cryptosuite, docHash, proofHash };
    }
    default: {
      // Exhaustive — the union has no other arms. Kept as a runtime
      // guard in case a caller bypasses the type system.
      const exhaustive: never = opts.cryptosuite;
      throw new UnsupportedProofTypeError(String(exhaustive));
    }
  }
}
