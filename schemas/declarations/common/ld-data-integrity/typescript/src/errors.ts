// Typed error classes for the lib's primitive surface. Mirror of
// the Go lib's errors.go sentinels. TS uses classes (rather than Go's
// `errors.Is` sentinel values) so callers dispatch via `instanceof`
// + tag the error chain via `cause` for diagnostics:
//
//   try { await canonicalize(doc, loader); }
//   catch (err) {
//     if (err instanceof UnknownContextError) { ... }
//   }

// UnknownContextError: the document loader was asked to fetch a JSON-LD
// @context URL not in its registered set. The lib refuses network
// fetches by design (no silent context drift, no SSRF); register the
// URL via NewDocumentLoader's `extra` map if it's legitimate.
export class UnknownContextError extends Error {
  readonly url: string;
  constructor(url: string, cause?: unknown) {
    super(`unknown JSON-LD context: ${url}`, { cause });
    this.name = "UnknownContextError";
    this.url = url;
  }
}

// MalformedProofError: signature material was the wrong shape — JWS
// envelope unparseable, multibase prefix wrong, ed25519 length wrong,
// DER decode failure, ProofOptions.Type / cryptosuite mismatch. The
// caller intended to provide signing material but mangled the shape.
export class MalformedProofError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "MalformedProofError";
  }
}

// SignatureRecoveryError: the recovery step couldn't reconstruct the
// expected signer. Two distinct underlying causes:
//   - secp256k1: neither v=0 nor v=1 recovers the expected public key
//     (key/digest mismatch — caller passed the wrong key or computed
//     the digest from different bytes than what was signed).
//   - generic: the recovery primitive itself errored (go-ethereum-side
//     SigToPub returned an error for malformed compact sig).
export class SignatureRecoveryError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SignatureRecoveryError";
  }
}

// Ed25519VerifyError: ed25519.verify returned false. The signature
// was structurally valid (64 bytes, multibase decoded cleanly, etc.)
// but didn't verify under the supplied public key.
export class Ed25519VerifyError extends Error {
  constructor(message?: string, cause?: unknown) {
    super(message ?? "ed25519 signature verification failed", { cause });
    this.name = "Ed25519VerifyError";
  }
}

// UnsupportedProofTypeError: the cryptosuite identifier isn't one this
// lib supports (EcdsaSecp256k1RecoverySignature2020 or
// Ed25519Signature2020 — see hash.ts's Cryptosuite type union).
export class UnsupportedProofTypeError extends Error {
  readonly cryptosuite: string;
  constructor(cryptosuite: string, cause?: unknown) {
    super(`unsupported cryptosuite: ${cryptosuite}`, { cause });
    this.name = "UnsupportedProofTypeError";
    this.cryptosuite = cryptosuite;
  }
}
