// W3C Data Integrity signer for the Ed25519Signature2020 cryptosuite.
// Sibling to sign.ts (which handles EcdsaSecp256k1RecoverySignature2020):
// the doc/proof canonicalization step is identical, only the hash and
// signature primitives differ. The hash construction lives in hash.ts
// (hashPaymentRequest) so signer + verifier (and the Go twin) share one
// implementation; this file is responsible only for the proof-block
// shape, the multibase encoding, and the ed25519.Sign call.

import bs58 from "bs58";
import nacl from "tweetnacl";

import {
  ED25519_2020_CONTEXT_URL,
  PAYMENT_REQUEST_CONTEXT_URL,
} from "./canonicalize.js";
import { hashPaymentRequest } from "./hash.js";
import type { PaymentRequest } from "@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript";

interface Ed25519ProofOptions {
  type: "Ed25519Signature2020";
  created: string;
  verificationMethod: string;
  proofPurpose: string;
}

interface Ed25519DataIntegrityProof extends Ed25519ProofOptions {
  // Multibase-encoded signature: MULTIBASE_BASE58BTC_PREFIX followed by
  // base58btc(64-byte ed25519 signature). Distinct from the detached-JWS
  // shape secp256k1 uses.
  proofValue: string;
}

// Multibase indicator for base58btc. Mirror of the Go verifier's
// multibaseBase58btcPrefix; both sides MUST agree or the cross-language
// round trip breaks.
const MULTIBASE_BASE58BTC_PREFIX = "z";

export interface SignedPaymentRequestEd25519
  extends Omit<PaymentRequest, "proof"> {
  "@context": string[];
  proof: Ed25519DataIntegrityProof;
}

export interface SignEd25519Options {
  // Full DID URL identifying the signing key, embedded into
  // proof.verificationMethod. Solana callers pass
  // `did:pkh:solana:NETWORK:base58pubkey#blockchainAccountId`.
  verificationMethod: string;
  // Optional override for proof.created. Defaults to new Date().toISOString().
  // Conformance fixtures and any other caller that needs a deterministic
  // timestamp pass an explicit ISO-8601 UTC string here; production
  // callers leave it undefined.
  created?: string;
}

// signPaymentRequestEd25519 canonicalizes the document and proof options,
// hashes each canonical n-quad form with SHA-256, signs proofHash ||
// docHash with ed25519, and returns the request with @context and
// proof.proofValue (multibase z-base58btc) attached.
//
// secretKey is the 64-byte ed25519 secret key — the same shape the Solana
// Keypair.secretKey property exposes. Throws if it isn't 64 bytes (a
// 32-byte seed alone is rejected to keep the contract crisp).
export async function signPaymentRequestEd25519(
  request: PaymentRequest,
  secretKey: Uint8Array,
  options: SignEd25519Options
): Promise<SignedPaymentRequestEd25519> {
  if (secretKey.length !== 64) {
    throw new Error(
      `Ed25519 secretKey must be 64 bytes (got ${secretKey.length}); pass the full Solana Keypair secret`
    );
  }
  if (!options.verificationMethod) {
    // Caller-side guard against an easy mistake (empty/undefined DID would
    // still produce a "valid" signature that downstream verifiers reject,
    // but the failure mode is opaque). Fail fast at the producer instead.
    throw new Error("SignEd25519Options.verificationMethod is required");
  }

  // Strip any pre-existing W3C fields from the input before signing
  // (hashPaymentRequest also strips them defensively, but the OUTPUT shape
  // we return must drop them too so the wire reflects only the post-sign
  // values).
  const { proof: _staleProof, "@context": _staleCtx, ...bareRequest } =
    request as PaymentRequest & { "@context"?: unknown };
  void _staleProof;
  void _staleCtx;

  const proofOptions: Ed25519ProofOptions = {
    type: "Ed25519Signature2020",
    created: options.created ?? new Date().toISOString(),
    verificationMethod: options.verificationMethod,
    proofPurpose: "assertionMethod",
  };

  const { signingInput } = await hashPaymentRequest(
    bareRequest as Record<string, unknown>,
    {
      cryptosuite: "Ed25519Signature2020",
      proofOptions,
    }
  );

  const signature = nacl.sign.detached(signingInput, secretKey);
  if (signature.length !== 64) {
    throw new Error(`expected 64-byte ed25519 signature, got ${signature.length}`);
  }
  const proofValue =
    MULTIBASE_BASE58BTC_PREFIX + bs58.encode(Buffer.from(signature));

  return {
    ...(bareRequest as Omit<PaymentRequest, "proof">),
    "@context": [PAYMENT_REQUEST_CONTEXT_URL, ED25519_2020_CONTEXT_URL],
    proof: { ...proofOptions, proofValue },
  };
}
