package svm_escrow_encoding

import (
	"testing"
)

// TestComputeRefundHash_Usage demonstrates how to compute the refund hash
// for a Solana escrow refund operation.
//
// The refund hash is signed by the releaser to authorize returning
// escrowed funds to the depositor (e.g., on settlement timeout).
func TestComputeRefundHash_Usage(t *testing.T) {
	depositHash := [32]byte{1, 2, 3, 4, 5}

	refundHash, err := ComputeRefundHash(EscrowRefundParams{
		DepositHash: depositHash,
	}, testEscrowDomain())
	if err != nil {
		t.Fatalf("ComputeRefundHash failed: %v", err)
	}

	_ = refundHash
}

func TestComputeRefundHash(t *testing.T) {
	depositHash := [32]byte{}
	for i := range depositHash {
		depositHash[i] = byte(i + 1)
	}

	params := EscrowRefundParams{
		DepositHash: depositHash,
	}

	digest, err := ComputeRefundHash(params, testEscrowDomain())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var zero32 [32]byte
	if digest == zero32 {
		t.Error("digest should not be zero")
	}
}

func TestComputeRefundHash_Deterministic(t *testing.T) {
	depositHash := [32]byte{0xaa, 0xbb, 0xcc}
	params := EscrowRefundParams{DepositHash: depositHash}

	digest1, _ := ComputeRefundHash(params, testEscrowDomain())
	digest2, _ := ComputeRefundHash(params, testEscrowDomain())

	if digest1 != digest2 {
		t.Error("digest should be deterministic")
	}
}

func TestComputeRefundHash_DifferentDepositHashes(t *testing.T) {
	depositHash1 := [32]byte{1}
	depositHash2 := [32]byte{2}

	digest1, _ := ComputeRefundHash(EscrowRefundParams{DepositHash: depositHash1}, testEscrowDomain())
	digest2, _ := ComputeRefundHash(EscrowRefundParams{DepositHash: depositHash2}, testEscrowDomain())

	if digest1 == digest2 {
		t.Error("different deposit hashes should produce different digests")
	}
}

func TestComputeRefundHash_ZeroDepositHash(t *testing.T) {
	params := EscrowRefundParams{
		DepositHash: [32]byte{},
	}

	_, err := ComputeRefundHash(params, testEscrowDomain())
	if err == nil {
		t.Error("expected error for zero deposit hash")
	}
}

func TestComputeRefundHash_DifferentFromRelease(t *testing.T) {
	depositHash := [32]byte{1, 2, 3, 4, 5}

	releaseDigest, _ := ComputeReleaseHash(EscrowReleaseParams{DepositHash: depositHash}, testEscrowDomain())
	refundDigest, _ := ComputeRefundHash(EscrowRefundParams{DepositHash: depositHash}, testEscrowDomain())

	if releaseDigest == refundDigest {
		t.Error("release and refund should produce different digests for same deposit hash")
	}
}

// Cross-language refund-hash validation now lives in parity_golden_test.go
// (Go encoder asserted against the program-sourced parity-golden.json).
