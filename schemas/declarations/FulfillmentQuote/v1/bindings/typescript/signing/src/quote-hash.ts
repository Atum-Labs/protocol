// Content-addressed quote_hash derivation. Mirror of the Go ComputeQuoteHash
// (quote_hash.go); the two produce the same quote_hash value for valid signed
// quotes (pinned by quote-hash-golden.json).

import { keccak256 } from "ethers";

import { canonicalSigningInput } from "./verify.js";
import type { Cryptosuite } from "./hash.js";

// Required top-level FulfillmentQuote fields, mirroring the Go side's
// generated schema (fq.SchemaJson `required`). The Go ComputeQuoteHash gets
// this validation for free from its typed parse; TS parses untyped, so we
// enforce the same required set here to keep the accept/reject boundary
// aligned across languages. (Presence only — full type-level schema parity is
// a follow-up that belongs with verifyQuote, which is also untyped.)
const REQUIRED_TOP_LEVEL_FIELDS = [
  "version",
  "source_amount",
  "award_deadline",
  "source",
  "destination",
  "settler_address",
  "payment_request_json",
] as const;

// computeQuoteHash returns the content-addressed identifier for a signed
// FulfillmentQuote:
//
//   quote_hash = "0x" + hex(keccak256(signingInput))
//
// signingInput is the canonical signing input produced by hashQuote. A secp256k1
// settler may sign the SettlerProof typed digest instead, but quote_hash always
// derives from signingInput. This is a thin wrapper over the existing canonicalization
// — it adds no new canonicalization, only the final keccak256 + 0x-hex shaping.
//
// Why keccak256(signingInput) and not hex(signingInput) directly: signingInput
// is 32 bytes for secp256k1 but 64 bytes for ed25519 (a raw sha256 concat).
// Hashing once more yields a uniform 32-byte identifier for every cryptosuite,
// matching payment_id (a 32-byte keccak256 digest on all chains). It is a full
// digest, not a truncation, so content-binding is preserved at full strength.
//
// The value carries the _hash suffix, not _id, because it is a deterministic
// content hash rather than a minted/random identifier. It binds the full quote
// content + proof metadata via signingInput; because proof.created participates,
// the same logical quote signed at two different times yields two different
// hashes (per-signed-artifact identity, by design — uses signingInput, not
// docHash, so same-content/different-created quotes do NOT collide).
//
// The derivation is deterministic and independent of the non-deterministic
// signature material: it never reads proof.jws or proof.proofValue.
//
// SECURITY: this function does NOT verify the signature. Callers MUST
// independently verify the quote (via verifyQuote) before trusting this value
// as an identifier — an equal quote_hash does NOT imply a valid signature.
//
// PARITY SCOPE: the Go<->TS guarantee is on the hash *value* for inputs both
// sides accept. The accept/reject boundary on malformed input is validated to
// match but is not part of the hash contract: this path inherits verifyQuote's
// untyped parse and enforces required-field *presence* only, whereas Go's typed
// parse also rejects wrong-*typed* fields. So a present-but-wrong-type field can
// be accepted here and rejected by Go. Full type-level parity is a verifier-wide
// concern (it belongs with verifyQuote, which parses the same way), not specific
// to this wrapper.
export async function computeQuoteHash(
  signedQuote: string | Record<string, unknown>
): Promise<string> {
  const doc =
    typeof signedQuote === "string"
      ? (JSON.parse(signedQuote) as Record<string, unknown>)
      : signedQuote;

  // Mirror Go's typed-parse required-field enforcement so both languages
  // reject the same malformed documents.
  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (doc[field] === undefined) {
      throw new Error(`computeQuoteHash: missing required field ${field}`);
    }
  }

  const proof = doc.proof as Record<string, unknown> | undefined;
  if (!proof) {
    throw new Error("computeQuoteHash: missing proof block");
  }

  // Dispatch on proof.type to pick the hash algorithm (keccak256 for
  // secp256k1, sha256 for ed25519) — selecting the same cryptosuite the
  // verifier would. Unlike verifyQuote, quote_hash derivation deliberately
  // does NOT validate proofPurpose or require signature material: the hash
  // is a content identity derivable from the proof metadata alone.
  const proofType = String(proof.type ?? "");
  if (
    proofType !== "EcdsaSecp256k1RecoverySignature2020" &&
    proofType !== "Ed25519Signature2020"
  ) {
    throw new Error(
      `computeQuoteHash: unsupported proof.type ${JSON.stringify(proofType)}`
    );
  }

  // canonicalSigningInput rejects empty proof strings (created/
  // verificationMethod/proofPurpose) via parseRequiredString, mirroring Go's
  // non-empty checks.
  const signingInput = await canonicalSigningInput(
    doc,
    proof,
    proofType as Cryptosuite
  );
  return keccak256(signingInput);
}
