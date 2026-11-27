package svm_escrow_encoding

import (
	"testing"
)

// TestComputeReserveHash_Usage demonstrates how to compute the reserve hash
// for a Solana escrow reserve operation.
//
// The reserve hash is signed by the reserver (payment-gw) to authorize
// funds allocation to a specific settler (recipient).
func TestComputeReserveHash_Usage(t *testing.T) {
	depositHash := [32]byte{1, 2, 3, 4, 5}

	recipient, _ := PubkeyFromBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")

	reserveHash, err := ComputeReserveHash(EscrowReserveParams{
		DepositHash: depositHash,
		Recipient:   recipient,
	}, testEscrowDomain())
	if err != nil {
		t.Fatalf("ComputeReserveHash failed: %v", err)
	}

	_ = reserveHash
}

func TestComputeReserveHash(t *testing.T) {
	depositHash := [32]byte{}
	for i := range depositHash {
		depositHash[i] = byte(i + 1)
	}

	recipient := Pubkey{}
	for i := range recipient {
		recipient[i] = byte(i + 100)
	}

	params := EscrowReserveParams{
		DepositHash: depositHash,
		Recipient:   recipient,
	}

	digest, err := ComputeReserveHash(params, testEscrowDomain())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var zero32 [32]byte
	if digest == zero32 {
		t.Error("digest should not be zero")
	}
}

func TestComputeReserveHash_Deterministic(t *testing.T) {
	depositHash := [32]byte{0xaa, 0xbb, 0xcc}
	recipient := Pubkey{1, 2, 3}

	params := EscrowReserveParams{
		DepositHash: depositHash,
		Recipient:   recipient,
	}

	digest1, _ := ComputeReserveHash(params, testEscrowDomain())
	digest2, _ := ComputeReserveHash(params, testEscrowDomain())

	if digest1 != digest2 {
		t.Error("digest should be deterministic")
	}
}

func TestComputeReserveHash_DifferentRecipients(t *testing.T) {
	depositHash := [32]byte{1}
	recipient1 := Pubkey{1}
	recipient2 := Pubkey{2}

	digest1, _ := ComputeReserveHash(EscrowReserveParams{DepositHash: depositHash, Recipient: recipient1}, testEscrowDomain())
	digest2, _ := ComputeReserveHash(EscrowReserveParams{DepositHash: depositHash, Recipient: recipient2}, testEscrowDomain())

	if digest1 == digest2 {
		t.Error("different recipients should produce different digests")
	}
}

func TestComputeReserveHash_ZeroDepositHash(t *testing.T) {
	recipient := Pubkey{1}
	params := EscrowReserveParams{
		DepositHash: [32]byte{},
		Recipient:   recipient,
	}

	_, err := ComputeReserveHash(params, testEscrowDomain())
	if err == nil {
		t.Error("expected error for zero deposit hash")
	}
}

func TestComputeReserveHash_ZeroRecipient(t *testing.T) {
	depositHash := [32]byte{1}
	params := EscrowReserveParams{
		DepositHash: depositHash,
		Recipient:   Pubkey{},
	}

	_, err := ComputeReserveHash(params, testEscrowDomain())
	if err == nil {
		t.Error("expected error for zero recipient")
	}
}

func TestComputeReserveHash_DifferentFromReleaseAndRefund(t *testing.T) {
	depositHash := [32]byte{1, 2, 3, 4, 5}
	recipient := Pubkey{6, 7, 8, 9, 10}

	releaseDigest, _ := ComputeReleaseHash(EscrowReleaseParams{DepositHash: depositHash}, testEscrowDomain())
	refundDigest, _ := ComputeRefundHash(EscrowRefundParams{DepositHash: depositHash}, testEscrowDomain())
	reserveDigest, _ := ComputeReserveHash(EscrowReserveParams{DepositHash: depositHash, Recipient: recipient}, testEscrowDomain())

	if releaseDigest == reserveDigest {
		t.Error("release and reserve should produce different digests")
	}

	if refundDigest == reserveDigest {
		t.Error("refund and reserve should produce different digests")
	}
}

// Cross-language reserve-hash validation now lives in parity_golden_test.go
// (Go encoder asserted against the program-sourced parity-golden.json). The
// contract-anchored reserve parity vectors in ../../vectors.json remain, tested
// by reserve_parity_test.go.

func TestComputeReserveHash_WithBase58Pubkey(t *testing.T) {
	depositHash := [32]byte{1, 2, 3, 4, 5}

	recipient, err := PubkeyFromBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
	if err != nil {
		t.Fatalf("failed to parse pubkey: %v", err)
	}

	params := EscrowReserveParams{
		DepositHash: depositHash,
		Recipient:   recipient,
	}

	digest, err := ComputeReserveHash(params, testEscrowDomain())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var zero32 [32]byte
	if digest == zero32 {
		t.Error("digest should not be zero")
	}
}
