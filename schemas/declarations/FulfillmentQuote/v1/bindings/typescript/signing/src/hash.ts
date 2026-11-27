// hashQuote produces the W3C Data Integrity signing input for a
// FulfillmentQuote under a given cryptosuite. This is
// a thin adapter over @atum-labs/ld-data-integrity's hashDocument;
// the canonicalize-then-hash pipeline (URDNA2015 + keccak256 or
// SHA-256 + combined composition) is owned by the shared TS lib so
// the FQ TS binding, the issuer, and the FQ Go binding all share a
// single implementation per side.

import {
  hashDocument,
  type HashResult as LibHashResult,
} from "@atum-labs/ld-data-integrity";

import {
  FULFILLMENT_QUOTE_CONTEXT_URL,
  SECP256K1_RECOVERY_CONTEXT_URL,
  ED25519_2020_CONTEXT_URL,
  fqLoader,
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

export interface HashQuoteOptions {
  cryptosuite: Cryptosuite;
  proofOptions: HashableProofOptions;
  // Optional verbatim @context for the proof block. Defaults to the
  // canonical IRI for the cryptosuite.
  proofContext?: unknown;
  // VP envelope callers pass keepVerifiableCredential: true
  // so the VC array participates in canonicalization. FQ callers leave
  // it false (default) — the VC field is defensively stripped.
  keepVerifiableCredential?: boolean;
  // Per-call context overlay (URL → parsed context) for an
  // envelope declaration context the shared fqLoader doesn't know — e.g.
  // a PaymentRequestEnvelope producer passes the PRE context so its
  // declaration URL resolves at canonicalization without registering it
  // globally. Empty/omitted keeps the shared fqLoader (the FQE path).
  // Mirror of Go's loaderWithExtraEnvelopeContexts seam.
  extraEnvelopeContexts?: Record<string, unknown> | undefined;
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

// hashQuote is the FQ-public hashing function. Thin adapter over
// [hashDocument] from @atum-labs/ld-data-integrity. The FQ-specific
// behavior preserved here:
//
//   - defaultDocContext is [FulfillmentQuoteContext, suiteContext];
//     the lib injects it only when the caller doc has no @context.
//   - keepVerifiableCredential maps to the lib's
//     stripVerifiableCredential (negated semantics).
//   - HashResult shape matches the lib's exactly.
//
// Shares the process-level fqLoader instance with canonicalize.ts —
// single registered-contexts map across the FQ TS signing surface.
export async function hashQuote(
  quote: Record<string, unknown>,
  options: HashQuoteOptions
): Promise<HashResult> {
  const suiteContext = SUITE_CONTEXT[options.cryptosuite];

  // Overlay any caller-supplied envelope declaration contexts onto the
  // shared loader for this call only (non-mutating); falls back to the
  // shared fqLoader when none are supplied (the FQE path).
  const loader =
    options.extraEnvelopeContexts &&
    Object.keys(options.extraEnvelopeContexts).length > 0
      ? fqLoader.withExtraContexts(
          options.extraEnvelopeContexts as Parameters<
            typeof fqLoader.withExtraContexts
          >[0]
        )
      : fqLoader;

  const result: LibHashResult = await hashDocument(
    quote,
    {
      cryptosuite: options.cryptosuite,
      proofOptions: {
        type: options.proofOptions.type,
        created: options.proofOptions.created,
        verificationMethod: options.proofOptions.verificationMethod,
        proofPurpose: options.proofOptions.proofPurpose,
        context: options.proofContext,
        // hashDocument reads these two by truthiness; leaving the keys off when unset keeps the
        // call valid under exactOptionalPropertyTypes without changing what is hashed.
        ...(options.proofOptions.challenge !== undefined
          ? { challenge: options.proofOptions.challenge }
          : {}),
        ...(options.proofOptions.domain !== undefined ? { domain: options.proofOptions.domain } : {}),
      },
      defaultDocContext: [FULFILLMENT_QUOTE_CONTEXT_URL, suiteContext],
      stripVerifiableCredential: !options.keepVerifiableCredential,
    },
    loader
  );

  return {
    signingInput: result.signingInput,
    cryptosuite: result.cryptosuite as Cryptosuite,
    docHash: result.docHash,
    proofHash: result.proofHash,
  };
}
