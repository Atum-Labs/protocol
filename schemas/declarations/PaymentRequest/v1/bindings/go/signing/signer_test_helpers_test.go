package ldverification

import (
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
