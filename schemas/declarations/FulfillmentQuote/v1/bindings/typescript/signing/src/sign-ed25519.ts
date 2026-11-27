// W3C Data Integrity signer for the Ed25519Signature2020 cryptosuite.
// Sibling to sign.ts (which handles EcdsaSecp256k1RecoverySignature2020):
// the doc/proof canonicalization step is identical, only the hash and
// signature primitives differ. The hash construction lives in hash.ts
// (hashQuote) so signer + verifier (and the Go twin) share one
// implementation; this file is responsible only for the proof-block
// shape, the multibase encoding, and the ed25519.Sign call.
//
// Produces the canonical Ed25519Signature2020 wire format for FulfillmentQuote.
// Cross-language conformance tests pin the exact bytes.

import nacl from "tweetnacl";

import { ed25519ProofMessage, encodeEd25519ProofValue } from "@atum-labs/ld-data-integrity";

import {
  ED25519_2020_CONTEXT_URL,
  FULFILLMENT_QUOTE_CONTEXT_URL,
} from "./canonicalize.js";
import { hashQuote } from "./hash.js";
import { rejectCallerSuppliedVC } from "./sign-guards.js";
import type { FulfillmentQuote } from "@atum-labs/schema-declarations/FulfillmentQuote/v1/bindings/typescript";

interface Ed25519ProofOptions {
  type: "Ed25519Signature2020";
  created: string;
  verificationMethod: string;
  proofPurpose: string;
}

interface Ed25519DataIntegrityProof extends Ed25519ProofOptions {
  // Multibase z-base58btc-encoded 64-byte ed25519 signature (produced by
  // the shared lib's encodeEd25519ProofValue). Distinct from the
  // detached-JWS shape secp256k1 uses.
  proofValue: string;
}

export interface SignedFulfillmentQuoteEd25519
  extends Omit<FulfillmentQuote, "proof" | "verifiableCredential"> {
  "@context": string[];
  verifiableCredential: never[];
  proof: Ed25519DataIntegrityProof;
}

export interface SignEd25519Options {
  // Full DID URL identifying the signing key, embedded into
  // proof.verificationMethod. Solana callers pass
  // `did:pkh:solana:NETWORK:base58pubkey#blockchainAccountId`.
  verificationMethod: string;
  // Optional override for proof.created. Defaults to new Date().toISOString().
  // Conformance fixtures and any other caller that needs a
  // deterministic timestamp pass an explicit ISO-8601 UTC string here;
  // production callers leave it undefined.
  created?: string;
  // Signs ed25519ProofMessage(signingInput) instead of the raw signingInput.
  // Verifiers accept both. Default false.
  textProof?: boolean;
}

// signQuoteEd25519 canonicalizes the document and proof options, hashes
// each canonical n-quad form with SHA-256, signs proofHash || docHash
// with ed25519, and returns the quote with @context, proof.proofValue
// (multibase z-base58btc), and verifiableCredential: [] attached.
//
// secretKey is the 64-byte ed25519 secret key — the same shape the Solana
// Keypair.secretKey property exposes. Throws if it isn't 64 bytes (a
// 32-byte seed alone is rejected to keep the contract crisp).
export async function signQuoteEd25519(
  quote: FulfillmentQuote,
  secretKey: Uint8Array,
  options: SignEd25519Options
): Promise<SignedFulfillmentQuoteEd25519> {
  if (secretKey.length !== 64) {
    throw new Error(
      `Ed25519 secretKey must be 64 bytes (got ${secretKey.length}); pass the full Solana Keypair secret`
    );
  }
  if (!options.verificationMethod) {
    // Caller-side guard against an easy mistake (empty/undefined DID
    // would still produce a "valid" signature that verifiers reject
    // downstream, but the failure mode is opaque). Fail fast at the
    // producer instead.
    throw new Error("SignEd25519Options.verificationMethod is required");
  }
  rejectCallerSuppliedVC(quote);

  // Strip any pre-existing W3C fields from the input before signing
  // (hashQuote also strips them defensively, but the OUTPUT shape we
  // return must drop them too so the wire reflects only the post-sign
  // values). Without this, an already-signed quote re-passed in would
  // leak its stale @context / proof into the returned object.
  const {
    proof: _staleProof,
    verifiableCredential: _staleVC,
    "@context": _staleCtx,
    ...bareQuote
  } = quote as FulfillmentQuote & { "@context"?: unknown };
  void _staleProof;
  void _staleVC;
  void _staleCtx;

  const proofOptions: Ed25519ProofOptions = {
    type: "Ed25519Signature2020",
    created: options.created ?? new Date().toISOString(),
    verificationMethod: options.verificationMethod,
    proofPurpose: "assertionMethod",
  };

  const { signingInput } = await hashQuote(bareQuote as Record<string, unknown>, {
    cryptosuite: "Ed25519Signature2020",
    proofOptions,
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
    ...bareQuote,
    "@context": [FULFILLMENT_QUOTE_CONTEXT_URL, ED25519_2020_CONTEXT_URL],
    verifiableCredential: [],
    proof: { ...proofOptions, proofValue },
  };
}
