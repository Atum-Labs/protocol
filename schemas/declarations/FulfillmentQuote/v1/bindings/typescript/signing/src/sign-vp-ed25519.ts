// W3C Data Integrity signer for a FulfillmentQuoteEnvelope under the
// Ed25519Signature2020 cryptosuite. Sibling to sign-vp.ts (which handles
// EcdsaSecp256k1RecoverySignature2020): doc/proof canonicalization is
// identical (hashQuote with keepVerifiableCredential: true), only the
// hash and signature primitives differ.

import nacl from "tweetnacl";

import { ed25519ProofMessage, encodeEd25519ProofValue } from "@atum-labs/ld-data-integrity";

import {
  assertDeclarationContextSupplied,
  ED25519_2020_CONTEXT_URL,
  FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
  W3C_VC_V1_CONTEXT_URL,
} from "./canonicalize.js";
import { hashQuote } from "./hash.js";
import type {
  FulfillmentQuoteEnvelope,
  VerifiableCredential,
} from "@atum-labs/schema-declarations/FulfillmentQuoteEnvelope/v1/bindings/typescript";

interface VPEd25519ProofOptions {
  type: "Ed25519Signature2020";
  created: string;
  verificationMethod: string;
  proofPurpose: "authentication";
  challenge: string;
  domain: string;
}

interface VPEd25519DataIntegrityProof extends VPEd25519ProofOptions {
  // Multibase z-base58btc-encoded 64-byte ed25519 signature. Matches
  // the FQ ed25519 signer's encoding; verifier and Go twin agree on
  // this prefix.
  proofValue: string;
}

export interface SignedFulfillmentQuoteEnvelopeEd25519
  extends Omit<
    FulfillmentQuoteEnvelope,
    "proof" | "verifiableCredential" | "@context" | "type"
  > {
  "@context": string[];
  type: string[];
  verifiableCredential: VerifiableCredential[];
  proof: VPEd25519DataIntegrityProof;
}

export interface SignVPEd25519Options {
  // did:pkh URI of the entity presenting the credentials. MUST match
  // the recovered signer of the inner FulfillmentQuote.
  holder: string;
  // Full DID URL identifying the signing key, embedded into
  // proof.verificationMethod. Solana callers pass
  // did:pkh:solana:NETWORK:base58pubkey#blockchainAccountId.
  verificationMethod: string;
  // Replay binding to the bid: verifier requires this to equal the
  // bid's request_id.
  challenge: string;
  // Replay binding to the verifier service identifier.
  domain: string;
  // ISO 8601 timestamp; defaults to now.
  created?: string;
  // Declaration-type binding — see the secp256k1 signVP's
  // SignVPOptions.declarationType. When set, appended to the signed `type`
  // array (covered by the holder signature via the rdf:type n-quad). Mirror
  // of the Go SignVPEd25519Options.DeclarationType; keep the two in lock-step.
  declarationType?: string;
  // Overrides the declaration context URL in the envelope body +
  // proof. Empty uses the FulfillmentQuoteEnvelope URL; a PRE producer passes
  // the PaymentRequestEnvelope URL. Mirror of signVP / Go EnvelopeContextURL.
  envelopeContextUrl?: string;
  // Per-call loader overlay (URL → parsed context) for a non-FQE
  // declaration context; REQUIRED when envelopeContextUrl is a URL the shared
  // loader doesn't know. Mirror of Go ExtraEnvelopeContexts.
  extraEnvelopeContexts?: Record<string, unknown>;
  // Signs ed25519ProofMessage(signingInput) instead of the raw signingInput.
  // Verifiers accept both. Default false.
  textProof?: boolean;
}

// signVPEd25519 builds a W3C VerifiablePresentation around the supplied
// VCs, canonicalizes doc + proof options, hashes each with SHA-256, and
// signs proofHash || docHash with ed25519. Returns the envelope with a
// multibase z-base58btc proofValue.
//
// secretKey is the 64-byte ed25519 secret key (Solana Keypair.secretKey
// form). A 32-byte seed alone is rejected.
export async function signVPEd25519(
  verifiableCredentials: VerifiableCredential[],
  secretKey: Uint8Array,
  options: SignVPEd25519Options
): Promise<SignedFulfillmentQuoteEnvelopeEd25519> {
  if (verifiableCredentials.length === 0) {
    throw new Error(
      "signVPEd25519: verifiableCredentials must contain at least one credential"
    );
  }
  if (secretKey.length !== 64) {
    throw new Error(
      `Ed25519 secretKey must be 64 bytes (got ${secretKey.length}); pass the full Solana Keypair secret`
    );
  }
  if (!options.holder) {
    throw new Error("SignVPEd25519Options.holder is required");
  }
  if (!options.verificationMethod) {
    throw new Error("SignVPEd25519Options.verificationMethod is required");
  }
  if (!options.challenge) {
    throw new Error("SignVPEd25519Options.challenge is required");
  }
  if (!options.domain) {
    throw new Error("SignVPEd25519Options.domain is required");
  }

  const proofOptions: VPEd25519ProofOptions = {
    type: "Ed25519Signature2020",
    created: options.created ?? new Date().toISOString(),
    verificationMethod: options.verificationMethod,
    proofPurpose: "authentication",
    challenge: options.challenge,
    domain: options.domain,
  };

  // Declaration context for both body + proof; defaults to FQE,
  // overridden by a PRE producer (with extraEnvelopeContexts supplying the
  // parsed PRE context so the URL resolves on the loader).
  const envelopeContextUrl =
    options.envelopeContextUrl ?? FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL;

  // Fail loudly rather than silently mint an unbound VP when a non-FQE
  // declaration type is requested without its declaration context.
  assertDeclarationContextSupplied(
    options.declarationType,
    envelopeContextUrl,
    options.extraEnvelopeContexts,
  );

  const vpBody = {
    "@context": [
      W3C_VC_V1_CONTEXT_URL,
      envelopeContextUrl,
      ED25519_2020_CONTEXT_URL,
    ],
    type: options.declarationType
      ? ["VerifiablePresentation", options.declarationType]
      : ["VerifiablePresentation"],
    holder: options.holder,
    verifiableCredential: verifiableCredentials,
  };

  const { signingInput } = await hashQuote(vpBody as Record<string, unknown>, {
    cryptosuite: "Ed25519Signature2020",
    proofOptions,
    keepVerifiableCredential: true,
    extraEnvelopeContexts: options.extraEnvelopeContexts,
    // See sign-vp.ts for the rationale: cryptosuite alone doesn't bind
    // challenge / domain; envelope context provides those terms.
    proofContext: [envelopeContextUrl, ED25519_2020_CONTEXT_URL],
  });

  const signature = nacl.sign.detached(
    options.textProof === true ? ed25519ProofMessage(signingInput) : signingInput,
    secretKey
  );
  if (signature.length !== 64) {
    throw new Error(`expected 64-byte ed25519 signature, got ${signature.length}`);
  }
  const proofValue = encodeEd25519ProofValue(signature);

  return {
    ...vpBody,
    proof: { ...proofOptions, proofValue },
  };
}
