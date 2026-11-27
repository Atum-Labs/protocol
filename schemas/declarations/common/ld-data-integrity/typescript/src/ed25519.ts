// Ed25519Signature2020 primitives. Mirror of the Go lib's ed25519.go.
// W3C Data Integrity multibase z-base58btc encoding for the proofValue
// field + sign/verify wrappers over tweetnacl.

import bs58 from "bs58";
import nacl from "tweetnacl";

import { MalformedProofError, Ed25519VerifyError } from "./errors.js";

// Multibase prefix byte ('z') for the base58btc encoding. W3C
// Ed25519Signature2020 mandates this prefix on proof.proofValue; any
// other prefix is a wire-format error.
const MULTIBASE_BASE58BTC_PREFIX = "z";

const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBKEY_BYTES = 32;

// encodeEd25519ProofValue produces the W3C multibase z-base58btc-
// encoded proofValue string from a 64-byte ed25519 signature. Inverse
// of decodeEd25519ProofValue. Throws MalformedProofError if the
// signature is not exactly 64 bytes — defensive caller-error check
// since RFC 8032 always produces 64-byte signatures.
export function encodeEd25519ProofValue(signature: Uint8Array): string {
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new MalformedProofError(
      `ed25519 signature must be ${ED25519_SIGNATURE_BYTES} bytes, got ${signature.length}`
    );
  }
  return MULTIBASE_BASE58BTC_PREFIX + bs58.encode(signature);
}

// decodeEd25519ProofValue parses a W3C multibase z-base58btc-encoded
// proofValue string and returns the 64-byte ed25519 signature.
// Enforces the multibase prefix + length invariants — failures throw
// MalformedProofError.
export function decodeEd25519ProofValue(proofValue: string): Uint8Array {
  if (proofValue.length === 0 || proofValue[0] !== MULTIBASE_BASE58BTC_PREFIX) {
    throw new MalformedProofError(
      "proofValue must be z-base58btc multibase (start with 'z')"
    );
  }
  let signature: Uint8Array;
  try {
    signature = bs58.decode(proofValue.slice(1));
  } catch (err) {
    throw new MalformedProofError("decode base58btc", err);
  }
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new MalformedProofError(
      `decoded ed25519 signature must be ${ED25519_SIGNATURE_BYTES} bytes, got ${signature.length}`
    );
  }
  return signature;
}

// signEd25519 produces a 64-byte ed25519 signature over the given
// signing input. Thin wrapper over tweetnacl's sign.detached; exists
// so caller packages don't import tweetnacl directly and so a future
// audit can add observability / key-policy hooks in a single place.
//
// `priv` MUST be a 64-byte ed25519 secret key (tweetnacl's "secret
// key" form — the expanded form, NOT the 32-byte seed). The 32-byte
// seed should be expanded via nacl.sign.keyPair.fromSeed before use.
export function signEd25519(priv: Uint8Array, signingInput: Uint8Array): Uint8Array {
  if (priv.length !== 64) {
    throw new MalformedProofError(
      `ed25519 secret key must be 64 bytes (tweetnacl expanded form), got ${priv.length}`
    );
  }
  return nacl.sign.detached(signingInput, priv);
}

// verifyEd25519 returns nothing on success, throws Ed25519VerifyError
// on failure. The boolean-returning stdlib function is wrapped so the
// lib's verification taxonomy stays consistent (typed errors callers
// catch via instanceof).
export function verifyEd25519(
  pub: Uint8Array,
  signingInput: Uint8Array,
  signature: Uint8Array
): void {
  if (pub.length !== ED25519_PUBKEY_BYTES) {
    throw new MalformedProofError(
      `ed25519 public key must be ${ED25519_PUBKEY_BYTES} bytes, got ${pub.length}`
    );
  }
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new MalformedProofError(
      `ed25519 signature must be ${ED25519_SIGNATURE_BYTES} bytes, got ${signature.length}`
    );
  }
  if (!nacl.sign.detached.verify(signingInput, signature, pub)) {
    throw new Ed25519VerifyError();
  }
}
