package svm_escrow_encoding

import (
	"testing"
)

// TestComputeReleaseHash_Usage demonstrates how to compute the release hash
// for a Solana escrow release operation.
//
// The release hash is signed by the releaser (veri-fill) to authorize
// releasing escrowed funds to the settler after fulfillment verification.
func TestComputeReleaseHash_Usage(t *testing.T) {
	depositHash := [32]byte{1, 2, 3, 4, 5}

	releaseHash, err := ComputeReleaseHash(EscrowReleaseParams{
		DepositHash: depositHash,
	}, testEscrowDomain())
	if err != nil {
		t.Fatalf("ComputeReleaseHash failed: %v", err)
	}

	_ = releaseHash
}

func TestComputeReleaseHash(t *testing.T) {
	depositHash := [32]byte{}
	for i := range depositHash {
		depositHash[i] = byte(i + 1)
	}

	params := EscrowReleaseParams{
		DepositHash: depositHash,
	}

	digest, err := ComputeReleaseHash(params, testEscrowDomain())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var zero32 [32]byte
	if digest == zero32 {
		t.Error("digest should not be zero")
	}
}

func TestComputeReleaseHash_Deterministic(t *testing.T) {
	depositHash := [32]byte{0xaa, 0xbb, 0xcc}
	params := EscrowReleaseParams{DepositHash: depositHash}

	digest1, _ := ComputeReleaseHash(params, testEscrowDomain())
	digest2, _ := ComputeReleaseHash(params, testEscrowDomain())

	if digest1 != digest2 {
		t.Error("digest should be deterministic")
	}
}

func TestComputeReleaseHash_DifferentDepositHashes(t *testing.T) {
	depositHash1 := [32]byte{1}
	depositHash2 := [32]byte{2}

	digest1, _ := ComputeReleaseHash(EscrowReleaseParams{DepositHash: depositHash1}, testEscrowDomain())
	digest2, _ := ComputeReleaseHash(EscrowReleaseParams{DepositHash: depositHash2}, testEscrowDomain())

	if digest1 == digest2 {
		t.Error("different deposit hashes should produce different digests")
	}
}

func TestComputeReleaseHash_ZeroDepositHash(t *testing.T) {
	params := EscrowReleaseParams{
		DepositHash: [32]byte{},
	}

	_, err := ComputeReleaseHash(params, testEscrowDomain())
	if err == nil {
		t.Error("expected error for zero deposit hash")
	}
}

// Cross-language release-hash validation now lives in parity_golden_test.go
// (Go encoder asserted against the program-sourced parity-golden.json).
