package ldverification

import (
	"encoding/json"
	"errors"
	"fmt"

	fq "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/FulfillmentQuote/v1/bindings/go/generated"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// ComputeQuoteHash returns the content-addressed identifier for a signed
// FulfillmentQuote:
//
//	quote_hash = "0x" + hex(keccak256(SigningInput))
//
// SigningInput is the canonical signing input produced by HashQuote. A secp256k1
// settler may sign the SettlerProof typed digest instead, but quote_hash always
// derives from SigningInput. This is a thin wrapper over the existing
// canonicalization — it adds no new canonicalization, only the final
// keccak256 + 0x-hex shaping.
//
// Why keccak256(SigningInput) and not hex(SigningInput) directly: SigningInput
// is 32 bytes for secp256k1 (already keccak256(proofHash‖docHash)) but 64 bytes
// for ed25519 (the raw sha256 proofHash‖docHash concat — ed25519 signs
// arbitrary-length input, so it is never folded into a single digest). Hashing
// it once more yields a uniform 32-byte identifier for every cryptosuite,
// matching payment_id (also a 32-byte keccak256 digest on all chains) so the
// two sibling identifiers are width-consistent and storage/on-chain-friendly.
// It is a full digest, not a truncation, so content-binding is preserved at
// full strength.
//
// The value carries the _hash suffix, not _id, because it is a deterministic
// content hash rather than a minted or random identifier. (Minted/client
// identifiers — payment_id, quote_request_id, request_id — keep _id.)
//
// It binds the full quote content + proof metadata (created/verificationMethod/
// proofPurpose/type) via SigningInput. Because created participates, the same
// logical quote signed at two different times yields two different hashes —
// this is a per-signed-artifact identity, by design (it uses SigningInput, not
// DocHash, so same-content/different-created quotes do NOT collide).
//
// The derivation is deterministic and independent of the non-deterministic
// signature material: it never reads proof.jws or proof.proofValue. A quote
// therefore has the same quote_hash regardless of how many times it is signed,
// as long as its content and proof metadata are unchanged.
//
// SECURITY: this function does NOT verify the signature. It only requires the
// content + proof metadata to be well-formed. Callers MUST independently verify
// the quote (via Verify) before trusting this value as an identifier — an equal
// quote_hash does NOT imply a valid signature by the claimed signer.
//
// Mirror of the TypeScript computeQuoteHash(); the two produce the same
// quote_hash value for valid signed quotes (pinned by quote-hash-golden.json).
// That parity guarantee is on the value; the accept/reject decision on
// malformed input is validated to match but is not part of the hash contract.
func ComputeQuoteHash(signedQuoteJSON []byte) (string, error) {
	var quote fq.SchemaJson
	if err := json.Unmarshal(signedQuoteJSON, &quote); err != nil {
		return "", fmt.Errorf("failed to parse FulfillmentQuote: %w", errors.Join(ErrMalformedQuote, err))
	}
	if quote.Proof == nil {
		return "", ErrMissingProof
	}

	// Dispatch on proof.type to pick the hash algorithm inside HashQuote
	// (keccak256 for secp256k1, sha256 for ed25519) — selecting the same
	// cryptosuite the verifier would. Unlike Verify, quote_hash derivation
	// deliberately does NOT validate proofPurpose or require signature
	// material: the hash is a content identity derivable from the proof
	// metadata alone.
	cryptosuite := quote.Proof.Type
	switch cryptosuite {
	case ProofTypeSecp256k1Recovery2020, ProofTypeEd25519Signature2020:
	default:
		return "", fmt.Errorf("unsupported proof type: %s: %w", quote.Proof.Type, ErrUnsupportedProofType)
	}

	// Reject present-but-empty proof fields that participate in the hash.
	// The typed parse above only enforces presence (and rejects an empty
	// created, which can't parse as a timestamp); these two strings can be
	// present-and-empty. Rejecting them keeps the accept/reject boundary
	// aligned with the TS side, which rejects empty proof strings.
	if quote.Proof.VerificationMethod == "" {
		return "", fmt.Errorf("proof.verificationMethod must not be empty: %w", ErrMalformedProof)
	}
	if quote.Proof.ProofPurpose == "" {
		return "", fmt.Errorf("proof.proofPurpose must not be empty: %w", ErrMalformedProof)
	}

	hash, err := canonicalSigningInput(signedQuoteJSON, &quote, cryptosuite)
	if err != nil {
		return "", err
	}

	return "0x" + common.Bytes2Hex(crypto.Keccak256(hash.SigningInput)), nil
}
