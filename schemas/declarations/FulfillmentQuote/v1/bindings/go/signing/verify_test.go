package ldverification

import (
	"fmt"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// mustSecp256k1Signer asserts res.Signer is a RecoveredSecp256k1Signer and
// returns the recovered address, failing the test otherwise.
func mustSecp256k1Signer(t *testing.T, res Result) common.Address {
	t.Helper()
	sig, ok := res.Signer.(RecoveredSecp256k1Signer)
	if !ok {
		t.Fatalf("Signer = %T, want RecoveredSecp256k1Signer", res.Signer)
	}
	return sig.Address
}

// mustEd25519Signer asserts res.Signer is a SelfAssertedEd25519Signer and
// returns it, failing the test otherwise.
func mustEd25519Signer(t *testing.T, res Result) SelfAssertedEd25519Signer {
	t.Helper()
	sig, ok := res.Signer.(SelfAssertedEd25519Signer)
	if !ok {
		t.Fatalf("Signer = %T, want SelfAssertedEd25519Signer", res.Signer)
	}
	return sig
}

// quoteWithProof returns a minimal valid FulfillmentQuote JSON whose proof
// block is the literal `proofJSON` argument. Pass an empty string to omit
// the proof entirely.
func quoteWithProof(proofJSON string) []byte {
	base := `{
		"version":"1.0",
		"source_amount":"100",
		"award_deadline":"2030-01-01T00:00:00Z",
		"source":{"id":"eip155:1/erc20:0xaaa","account":"eip155:1:0x1"},
		"destination":{"id":"eip155:1/erc20:0xbbb","account":"eip155:1:0x2"},
		"settler_address":"0xsettler",
		"payment_request_json":"{}"`
	if proofJSON == "" {
		return []byte(base + "}")
	}
	return []byte(fmt.Sprintf("%s,\"proof\":%s}", base, proofJSON))
}

func TestVerify_RejectsMissingProof(t *testing.T) {
	_, err := Verify(quoteWithProof(""))
	if err == nil || !strings.Contains(err.Error(), "missing proof") {
		t.Fatalf("err = %v, want 'missing proof'", err)
	}
}

func TestVerify_RejectsUnsupportedProofType(t *testing.T) {
	// `Ed25519Signature2018` is not in our supported set — distinct from
	// the supported `Ed25519Signature2020` which uses multibase proofValue
	// (covered by the dedicated round-trip test).
	proof := `{"type":"Ed25519Signature2018","created":"2024-01-01T00:00:00Z","verificationMethod":"did:example","proofPurpose":"assertionMethod","jws":"x..y"}`
	_, err := Verify(quoteWithProof(proof))
	if err == nil || !strings.Contains(err.Error(), "unsupported proof type") {
		t.Fatalf("err = %v, want 'unsupported proof type'", err)
	}
}

func TestVerify_RejectsMissingJws(t *testing.T) {
	proof := `{"type":"EcdsaSecp256k1RecoverySignature2020","created":"2024-01-01T00:00:00Z","verificationMethod":"did:example","proofPurpose":"assertionMethod"}`
	_, err := Verify(quoteWithProof(proof))
	if err == nil || !strings.Contains(err.Error(), "proof.jws is required") {
		t.Fatalf("err = %v, want 'proof.jws is required'", err)
	}
}

func TestVerify_RejectsMalformedJws(t *testing.T) {
	proof := `{"type":"EcdsaSecp256k1RecoverySignature2020","created":"2024-01-01T00:00:00Z","verificationMethod":"did:example","proofPurpose":"assertionMethod","jws":"not-a-jws"}`
	_, err := Verify(quoteWithProof(proof))
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestVerify_RejectsInvalidJSON(t *testing.T) {
	_, err := Verify([]byte(`not-json`))
	if err == nil || !strings.Contains(err.Error(), "failed to parse FulfillmentQuote") {
		t.Fatalf("err = %v, want 'failed to parse FulfillmentQuote'", err)
	}
}

// proofPurpose is validated BEFORE cryptosuite dispatch (verify.go), so
// the rejection applies uniformly to every did:pkh:<network> corridor —
// EVM (eip155, secp256k1), Tron (tron, secp256k1), Solana (solana,
// ed25519), and any future network/cryptosuite. The cases below pin
// that contract one-per-corridor so a future refactor that re-introduces
// per-branch validation can't silently fail-open on a single chain.
func TestVerify_RejectsBadProofPurpose_EVM(t *testing.T) {
	// secp256k1 path, did:pkh:eip155:... DID prefix.
	proof := `{"type":"EcdsaSecp256k1RecoverySignature2020","created":"2024-01-01T00:00:00Z","verificationMethod":"did:pkh:eip155:1:0xabc#blockchainAccountId","proofPurpose":"keyAgreement","jws":"x..y"}`
	_, err := Verify(quoteWithProof(proof))
	if err == nil || !strings.Contains(err.Error(), "proofPurpose") {
		t.Fatalf("err = %v, want error mentioning 'proofPurpose'", err)
	}
}

func TestVerify_RejectsBadProofPurpose_Tron(t *testing.T) {
	// secp256k1 path, did:pkh:tron:... DID prefix. Same cryptosuite as
	// EVM but a separate corridor — pinning the case explicitly so a
	// future branch-level validator can't accept Tron's keyAgreement
	// while rejecting EVM's.
	proof := `{"type":"EcdsaSecp256k1RecoverySignature2020","created":"2024-01-01T00:00:00Z","verificationMethod":"did:pkh:tron:shasta:TDXXQzHTpwnwBB9HEizB1DG61GdDWtTuuk#blockchainAccountId","proofPurpose":"keyAgreement","jws":"x..y"}`
	_, err := Verify(quoteWithProof(proof))
	if err == nil || !strings.Contains(err.Error(), "proofPurpose") {
		t.Fatalf("err = %v, want error mentioning 'proofPurpose'", err)
	}
}

func TestVerify_RejectsBadProofPurpose_Solana(t *testing.T) {
	// ed25519 path, did:pkh:solana:... DID prefix. Distinct cryptosuite
	// branch from EVM/Tron — pinning ensures the dispatch-level check
	// also catches Solana before we land on the ed25519-specific
	// proofValue parse.
	proof := `{"type":"Ed25519Signature2020","created":"2024-01-01T00:00:00Z","verificationMethod":"did:pkh:solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:BsoLXZos4V2cgvpiQZMFmFXWKMp1Lw2d3jh6nGQAHpaj#blockchainAccountId","proofPurpose":"keyAgreement","proofValue":"zSomething"}`
	_, err := Verify(quoteWithProof(proof))
	if err == nil || !strings.Contains(err.Error(), "proofPurpose") {
		t.Fatalf("err = %v, want error mentioning 'proofPurpose'", err)
	}
}

func TestVerify_RejectsEmptyProofPurpose(t *testing.T) {
	// A signer that drops proofPurpose entirely (or sets it to "") must
	// not fail-open. Pinning here so the check stays a strict equality
	// rather than drifting to a "non-empty + maybe match" predicate.
	proof := `{"type":"EcdsaSecp256k1RecoverySignature2020","created":"2024-01-01T00:00:00Z","verificationMethod":"did:pkh:eip155:1:0xabc","proofPurpose":"","jws":"x..y"}`
	_, err := Verify(quoteWithProof(proof))
	if err == nil || !strings.Contains(err.Error(), "proofPurpose") {
		t.Fatalf("err = %v, want error mentioning 'proofPurpose'", err)
	}
}
