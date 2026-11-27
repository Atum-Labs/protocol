package ldverification

import (
	"encoding/json"
	"errors"
	"regexp"
	"testing"
)

// quoteHashPattern is the externally-promised shape: "0x" followed by an even
// run of lowercase hex. quote_hash is keccak256(SigningInput) for every
// cryptosuite, so it is uniformly 32 bytes → 64 hex nibbles.
var quoteHashPattern = regexp.MustCompile(`^0x([0-9a-f]{2})+$`)

// quoteHashLen is len("0x" + hex(keccak256(SigningInput))) — 32 bytes, the
// same for both cryptosuites after the normalizing keccak256.
const quoteHashLen = 2 + 64

// TestComputeQuoteHash_Deterministic pins the two acceptance properties: the
// derivation is stable across repeated calls, and the output has the promised
// uniform 0x-hex shape and length for both cryptosuites.
func TestComputeQuoteHash_Deterministic(t *testing.T) {
	for _, fixture := range []string{"secp256k1-go-signed.json", "ed25519-go-signed.json"} {
		t.Run(fixture, func(t *testing.T) {
			signed := readFixture(t, fixture)

			first, err := ComputeQuoteHash(signed)
			if err != nil {
				t.Fatalf("ComputeQuoteHash(%s): %v", fixture, err)
			}
			if !quoteHashPattern.MatchString(first) {
				t.Errorf("quote_hash %q does not match %s", first, quoteHashPattern)
			}
			if len(first) != quoteHashLen {
				t.Errorf("quote_hash length = %d, want %d (%q)", len(first), quoteHashLen, first)
			}

			second, err := ComputeQuoteHash(signed)
			if err != nil {
				t.Fatalf("ComputeQuoteHash(%s) second call: %v", fixture, err)
			}
			if first != second {
				t.Errorf("ComputeQuoteHash not deterministic: %q != %q", first, second)
			}
		})
	}
}

// TestComputeQuoteHash_DependsOnCreated is the SigningInput-not-DocHash guard.
// The only difference between the two documents is proof.created; because the
// signing input folds in the proof hash (which commits to created), the
// quote_hashes MUST differ. Equal hashes here would mean the wrapper regressed
// onto DocHash, where same-content/different-created quotes collide.
func TestComputeQuoteHash_DependsOnCreated(t *testing.T) {
	signed := readFixture(t, "secp256k1-go-signed.json")

	original, err := ComputeQuoteHash(signed)
	if err != nil {
		t.Fatalf("ComputeQuoteHash(original): %v", err)
	}

	doc := decodeFixture(t, signed)
	proofMap(t, doc)["created"] = "2099-01-01T00:00:00Z"
	mutatedHash, err := ComputeQuoteHash(remarshal(t, doc))
	if err != nil {
		t.Fatalf("ComputeQuoteHash(mutated): %v", err)
	}
	if original == mutatedHash {
		t.Fatalf("quote_hash unchanged after mutating proof.created (%q) — wrapper is hashing DocHash, not SigningInput", original)
	}
}

// TestComputeQuoteHash_IgnoresSignatureMaterial pins the security-relevant
// property that the hash is independent of the (non-deterministic, and
// attacker-replaceable) signature bytes: it never reads proof.jws or
// proof.proofValue. Tampering with them leaves the quote_hash unchanged —
// which is exactly why an equal quote_hash does NOT imply a valid signature
// and callers must still Verify.
func TestComputeQuoteHash_IgnoresSignatureMaterial(t *testing.T) {
	t.Run("secp256k1 jws", func(t *testing.T) {
		signed := readFixture(t, "secp256k1-go-signed.json")
		base, err := ComputeQuoteHash(signed)
		if err != nil {
			t.Fatalf("ComputeQuoteHash(base): %v", err)
		}
		doc := decodeFixture(t, signed)
		proofMap(t, doc)["jws"] = "eyJ0YW1wZXJlZCI6dHJ1ZX0.tampered.signature"
		got, err := ComputeQuoteHash(remarshal(t, doc))
		if err != nil {
			t.Fatalf("ComputeQuoteHash(tampered jws): %v", err)
		}
		if got != base {
			t.Errorf("quote_hash changed after tampering proof.jws: %q != %q", got, base)
		}
	})

	t.Run("ed25519 proofValue", func(t *testing.T) {
		signed := readFixture(t, "ed25519-go-signed.json")
		base, err := ComputeQuoteHash(signed)
		if err != nil {
			t.Fatalf("ComputeQuoteHash(base): %v", err)
		}
		doc := decodeFixture(t, signed)
		proofMap(t, doc)["proofValue"] = "z3TamperedSignatureValueThatIsNotReal"
		got, err := ComputeQuoteHash(remarshal(t, doc))
		if err != nil {
			t.Fatalf("ComputeQuoteHash(tampered proofValue): %v", err)
		}
		if got != base {
			t.Errorf("quote_hash changed after tampering proof.proofValue: %q != %q", got, base)
		}
	})
}

func TestComputeQuoteHash_Errors(t *testing.T) {
	t.Run("malformed json", func(t *testing.T) {
		if _, err := ComputeQuoteHash([]byte("{not json")); !errors.Is(err, ErrMalformedQuote) {
			t.Errorf("err = %v, want ErrMalformedQuote", err)
		}
	})

	t.Run("missing proof", func(t *testing.T) {
		// Otherwise-valid quote with the proof block dropped — exercises the
		// proof==nil guard, not a generic parse failure.
		signed := readFixture(t, "secp256k1-go-signed.json")
		doc := decodeFixture(t, signed)
		delete(doc, "proof")
		if _, err := ComputeQuoteHash(remarshal(t, doc)); !errors.Is(err, ErrMissingProof) {
			t.Errorf("err = %v, want ErrMissingProof", err)
		}
	})

	t.Run("missing required top-level field", func(t *testing.T) {
		// Direction-A boundary: a doc missing a required top-level field is
		// rejected (mirror of the TS computeQuoteHash required-field check).
		signed := readFixture(t, "secp256k1-go-signed.json")
		doc := decodeFixture(t, signed)
		delete(doc, "source_amount")
		if _, err := ComputeQuoteHash(remarshal(t, doc)); !errors.Is(err, ErrMalformedQuote) {
			t.Errorf("err = %v, want ErrMalformedQuote", err)
		}
	})

	t.Run("empty proofPurpose", func(t *testing.T) {
		// Direction-B boundary: a present-but-empty proof field is rejected
		// (mirror of the TS side, which rejects empty proof strings).
		signed := readFixture(t, "secp256k1-go-signed.json")
		doc := decodeFixture(t, signed)
		proofMap(t, doc)["proofPurpose"] = ""
		if _, err := ComputeQuoteHash(remarshal(t, doc)); !errors.Is(err, ErrMalformedProof) {
			t.Errorf("err = %v, want ErrMalformedProof", err)
		}
	})

	t.Run("empty verificationMethod", func(t *testing.T) {
		signed := readFixture(t, "secp256k1-go-signed.json")
		doc := decodeFixture(t, signed)
		proofMap(t, doc)["verificationMethod"] = ""
		if _, err := ComputeQuoteHash(remarshal(t, doc)); !errors.Is(err, ErrMalformedProof) {
			t.Errorf("err = %v, want ErrMalformedProof", err)
		}
	})

	t.Run("unsupported proof type", func(t *testing.T) {
		signed := readFixture(t, "secp256k1-go-signed.json")
		doc := decodeFixture(t, signed)
		proofMap(t, doc)["type"] = "SomeUnknownSignature2099"
		if _, err := ComputeQuoteHash(remarshal(t, doc)); !errors.Is(err, ErrUnsupportedProofType) {
			t.Errorf("err = %v, want ErrUnsupportedProofType", err)
		}
	})
}

// --- small test helpers for fixture mutation ---

func decodeFixture(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("unmarshal fixture: %v", err)
	}
	return doc
}

func proofMap(t *testing.T, doc map[string]any) map[string]any {
	t.Helper()
	p, ok := doc["proof"].(map[string]any)
	if !ok {
		t.Fatalf("fixture proof is not an object")
	}
	return p
}

func remarshal(t *testing.T, doc map[string]any) []byte {
	t.Helper()
	b, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal mutated doc: %v", err)
	}
	return b
}
