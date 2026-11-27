// secp256k1 signer recovery for the W3C
// EcdsaSecp256k1RecoverySignature2020 cryptosuite. Mirror of the Go
// lib's recovery.go. Two surfaces:
//
//   - recoverSecp256k1Signer: 65-byte ES256K-R sig + 32-byte digest
//     → recovered EVM address (the verifier path).
//   - secp256k1ESRecoveryFromDER: KMS-shape DER + expectedPub + digest
//     → 65-byte ES256K-R sig with v ∈ {0,1} (the signer path for
//     cloud KMS backends that return DER ECDSA sigs — AWS / GCP).

import { computeAddress, recoverAddress, Signature, hexlify } from "ethers";

import {
  MalformedProofError,
  SignatureRecoveryError,
} from "./errors.js";

// recoverSecp256k1Signer recovers the signer's EVM-canonical address
// from a Keccak256 32-byte digest and a 65-byte ES256K-R signature
// (r||s||v with v in {0,1,27,28}). The v normalization step (subtract
// 27 when v >= 27) accommodates the EIP-191 convention; ethers'
// recoverAddress accepts both forms transparently but we normalize
// for symmetry with the Go lib's behavior.
//
// Any other v is refused before ethers sees it. Signature.from reads a v of
// 35 or more as an EIP-155 v, so without the check a v of 8 to 26 (35 to 53
// after the +27 below) or of 35 and above recovered the signer. The Go
// sibling refuses the same set.
//
// Failure modes:
//   - MalformedProofError: signature not 65 bytes / digest not 32
//     bytes (defensive caller-error check).
//   - SignatureRecoveryError: v not in {0,1,27,28}, or ethers'
//     recoverAddress throws (malformed compact signature, invalid
//     recovery id).
export function recoverSecp256k1Signer(
  digest: Uint8Array,
  signature: Uint8Array
): string {
  if (signature.length !== 65) {
    throw new MalformedProofError(
      `signature must be 65 bytes, got ${signature.length}`
    );
  }
  if (digest.length !== 32) {
    throw new MalformedProofError(
      `digest must be 32 bytes, got ${digest.length}`
    );
  }

  const vByte = signature[64];
  if (vByte !== 0 && vByte !== 1 && vByte !== 27 && vByte !== 28) {
    throw new SignatureRecoveryError(
      `recovery byte v = ${vByte}, want 0, 1, 27 or 28`
    );
  }

  // Copy so the caller's slice isn't mutated by the v-byte normalization.
  const sig = new Uint8Array(65);
  sig.set(signature);
  if (sig[64] >= 27) {
    sig[64] -= 27;
  }

  try {
    // ethers expects v ∈ {0,1} for r||s||v compact form; the Signature
    // helper validates and returns a canonical EVM-flavored object.
    const r = hexlify(sig.slice(0, 32));
    const s = hexlify(sig.slice(32, 64));
    const v = sig[64];
    const ethersSig = Signature.from({ r, s, v: v + 27 });
    return recoverAddress(digest, ethersSig);
  } catch (err) {
    throw new SignatureRecoveryError("failed to recover signer", err);
  }
}

// ASN.1 DER tags for the sequence-of-two-integers ECDSA signature
// shape AWS / GCP KMS return. Minimal parser — full DER is more
// general, but this lib only needs the one shape KMS produces.
const DER_SEQUENCE = 0x30;
const DER_INTEGER = 0x02;

interface ParsedDER {
  r: bigint;
  s: bigint;
}

// secp256k1 group order N and N/2 (precomputed bigints, no
// runtime ECDSA dependency required to enforce low-s).
const SECP256K1_N = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
);
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

// parseDER decodes the ASN.1 DER encoding cloud KMS backends return
// for ECDSA secp256k1 signatures into (r, s) bigints. Short-form
// length encoding only — secp256k1 signatures (max ~72 bytes for
// r||s + ASN.1 overhead) always fit in a single length byte; long-
// form (0x81+, high bit set) would imply a >127-byte payload which
// can't happen for secp256k1. Long-form input is rejected explicitly
// so a future KMS that violates this constraint surfaces a clear
// error rather than a misleading "length mismatch".
function parseDER(der: Uint8Array): ParsedDER {
  if (der.length < 8 || der[0] !== DER_SEQUENCE) {
    throw new Error("not a DER SEQUENCE");
  }
  if (der[1] & 0x80) {
    throw new Error(
      "DER long-form length not supported (secp256k1 sigs fit in short form)"
    );
  }
  const seqLen = der[1];
  if (seqLen + 2 !== der.length) {
    throw new Error(
      `DER SEQUENCE length mismatch: header says ${seqLen}, total ${der.length - 2}`
    );
  }
  let off = 2;
  if (der[off] !== DER_INTEGER) {
    throw new Error("expected INTEGER for r");
  }
  if (der[off + 1] & 0x80) {
    throw new Error("DER long-form INTEGER length not supported for r");
  }
  const rLen = der[off + 1];
  off += 2;
  const rBytes = der.slice(off, off + rLen);
  off += rLen;
  if (der[off] !== DER_INTEGER) {
    throw new Error("expected INTEGER for s");
  }
  if (der[off + 1] & 0x80) {
    throw new Error("DER long-form INTEGER length not supported for s");
  }
  const sLen = der[off + 1];
  off += 2;
  const sBytes = der.slice(off, off + sLen);
  off += sLen;
  if (off !== der.length) {
    throw new Error(`trailing ${der.length - off} bytes after DER signature`);
  }

  const r = BigInt("0x" + Buffer.from(rBytes).toString("hex"));
  const s = BigInt("0x" + Buffer.from(sBytes).toString("hex"));
  if (r <= 0n || s <= 0n) {
    throw new Error("invalid r or s in DER signature");
  }
  // Bound into the valid ECDSA range [1, N-1] — same diagnostic
  // benefit as the Go side: out-of-range values surface as a parse
  // error rather than a downstream "neither v recovers expectedPub".
  if (r >= SECP256K1_N || s >= SECP256K1_N) {
    throw new Error("r or s out of range [1, N-1] for secp256k1");
  }
  return { r, s };
}

// secp256k1ESRecoveryFromDER converts an ASN.1 DER-encoded ECDSA
// signature (the format AWS / GCP KMS return for secp256k1 keys) into
// a 65-byte ES256K-R signature suitable for the
// EcdsaSecp256k1RecoverySignature2020 cryptosuite (r||s||v with
// v ∈ {0,1}).
//
// expectedPub MUST be the uncompressed 65-byte public key (0x04||X||Y)
// of the signing key — used to disambiguate v=0 vs v=1.
//
// Failure modes:
//   - MalformedProofError: digest not 32 bytes, expectedPub wrong
//     shape, DER unparseable.
//   - SignatureRecoveryError: neither v=0 nor v=1 reproduces
//     expectedPub.
export function secp256k1ESRecoveryFromDER(
  der: Uint8Array,
  expectedPub: Uint8Array,
  digest: Uint8Array
): Uint8Array {
  if (digest.length !== 32) {
    throw new MalformedProofError(
      `digest must be 32 bytes, got ${digest.length}`
    );
  }
  if (expectedPub.length !== 65 || expectedPub[0] !== 0x04) {
    throw new MalformedProofError(
      `expectedPub must be 65-byte uncompressed (0x04||X||Y), got len=${expectedPub.length}`
    );
  }

  let parsed: ParsedDER;
  try {
    parsed = parseDER(der);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new MalformedProofError(`parse DER: ${cause}`, err);
  }

  // Normalize to low-s (EIP-2 / canonical ECDSA). Cloud KMS backends
  // pick whichever s they please; flip half the time so downstream
  // Ethereum-flavored verifiers don't reject as malleable.
  let s = parsed.s;
  if (s > SECP256K1_HALF_N) {
    s = SECP256K1_N - s;
  }

  // Convert r, s to 32-byte big-endian fixed-width buffers.
  const rsCompact = new Uint8Array(64);
  const rHex = parsed.r.toString(16).padStart(64, "0");
  const sHex = s.toString(16).padStart(64, "0");
  rsCompact.set(Buffer.from(rHex, "hex"), 0);
  rsCompact.set(Buffer.from(sHex, "hex"), 32);

  // Expected address derived from expectedPub (computeAddress accepts
  // the 65-byte uncompressed form via hex string).
  const expectedAddr = computeAddress(hexlify(expectedPub));

  // Try v=0 then v=1; pick the v that reproduces expectedAddr.
  for (let v = 0; v <= 1; v++) {
    const sig = new Uint8Array(65);
    sig.set(rsCompact);
    sig[64] = v;
    try {
      const r = hexlify(sig.slice(0, 32));
      const sStr = hexlify(sig.slice(32, 64));
      const ethersSig = Signature.from({ r, s: sStr, v: v + 27 });
      const recoveredAddr = recoverAddress(digest, ethersSig);
      if (recoveredAddr.toLowerCase() === expectedAddr.toLowerCase()) {
        return sig;
      }
    } catch {
      // Continue trying the other recovery id.
      continue;
    }
  }
  throw new SignatureRecoveryError(
    "neither v=0 nor v=1 recovered the expected public key (digest/pubkey mismatch?)"
  );
}
