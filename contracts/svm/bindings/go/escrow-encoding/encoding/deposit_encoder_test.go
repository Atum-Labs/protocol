package svm_escrow_encoding

import (
	"fmt"
	"testing"
)

// TestComputeDepositHash_Usage demonstrates how to compute the deposit_hash
// for a Solana escrow deposit operation.
//
// The deposit_hash serves as:
// 1. The unique identifier for this deposit (analogous to EVM's paymentID)
// 2. The PDA seed for the escrow account
// 3. The input to reserve, release, and refund hash computations
func TestComputeDepositHash_Usage(t *testing.T) {
	// Parse pubkeys from Base58 (standard Solana format)
	depositor, _ := PubkeyFromBase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
	mint, _ := PubkeyFromBase58("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")
	reserver, _ := PubkeyFromBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
	releaser, _ := PubkeyFromBase58("So11111111111111111111111111111111111111112")

	// Create a deposit_request_hash (typically keccak256(request_id))
	paymentID := Keccak256([]byte("payment-request-12345"))

	// Compute the deposit_hash
	depositHash, err := ComputeDepositHash(EscrowDepositParams{
		DepositRequestHash: paymentID,
		Depositor:          depositor,
		Mint:               mint,
		Amount:             1_000_000, // 1 USDC (6 decimals)
		Reserver:           reserver,
		Releaser:           releaser,
		Nonce:              12345,
		IssuedAt:           1700000000, // Unix timestamp
		Deadline:           1700000128, // Must be within 128s of IssuedAt
	}, testEscrowDomain())
	if err != nil {
		t.Fatalf("ComputeDepositHash failed: %v", err)
	}

	// depositHash is a [32]byte - use as unique payment identifier
	_ = fmt.Sprintf("0x%x", depositHash[:])
}

func TestComputeDepositHash(t *testing.T) {
	params := createTestDepositParams()

	digest, err := ComputeDepositHash(params, testEscrowDomain())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify digest is non-zero
	var zero32 [32]byte
	if digest == zero32 {
		t.Error("digest should not be zero")
	}
}

func TestComputeDepositHash_Deterministic(t *testing.T) {
	params := createTestDepositParams()

	digest1, _ := ComputeDepositHash(params, testEscrowDomain())
	digest2, _ := ComputeDepositHash(params, testEscrowDomain())

	if digest1 != digest2 {
		t.Error("digest should be deterministic")
	}
}

func TestComputeDepositHash_DifferentAmounts(t *testing.T) {
	params1 := createTestDepositParams()
	params1.Amount = 1000000

	params2 := createTestDepositParams()
	params2.Amount = 2000000

	digest1, _ := ComputeDepositHash(params1, testEscrowDomain())
	digest2, _ := ComputeDepositHash(params2, testEscrowDomain())

	if digest1 == digest2 {
		t.Error("different amounts should produce different digests")
	}
}

func TestComputeDepositHash_DifferentDeadlines(t *testing.T) {
	// Note: On-chain, deadline must be within 128 seconds of issued_at.
	// These test values are for encoding validation only.
	params1 := createTestDepositParams()
	params1.Deadline = 1700000060 // 60 seconds after issued_at

	params2 := createTestDepositParams()
	params2.Deadline = 1700000120 // 120 seconds after issued_at

	digest1, _ := ComputeDepositHash(params1, testEscrowDomain())
	digest2, _ := ComputeDepositHash(params2, testEscrowDomain())

	if digest1 == digest2 {
		t.Error("different deadlines should produce different digests")
	}
}

func TestComputeDepositHash_ValidationErrors(t *testing.T) {
	validParams := createTestDepositParams()

	tests := []struct {
		name   string
		modify func(*EscrowDepositParams)
	}{
		{
			name:   "zero payment ID",
			modify: func(p *EscrowDepositParams) { p.DepositRequestHash = [32]byte{} },
		},
		{
			name:   "zero depositor",
			modify: func(p *EscrowDepositParams) { p.Depositor = Pubkey{} },
		},
		{
			name:   "zero mint",
			modify: func(p *EscrowDepositParams) { p.Mint = Pubkey{} },
		},
		{
			name:   "zero amount",
			modify: func(p *EscrowDepositParams) { p.Amount = 0 },
		},
		{
			name:   "zero reserver",
			modify: func(p *EscrowDepositParams) { p.Reserver = Pubkey{} },
		},
		{
			name:   "zero releaser",
			modify: func(p *EscrowDepositParams) { p.Releaser = Pubkey{} },
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			params := validParams
			tc.modify(&params)

			_, err := ComputeDepositHash(params, testEscrowDomain())
			if err == nil {
				t.Error("expected error for invalid input")
			}
		})
	}
}

func TestComputeDepositHash_ZeroNonceAllowed(t *testing.T) {
	// Zero nonce should be allowed (it's a valid value)
	params := createTestDepositParams()
	params.Nonce = 0

	_, err := ComputeDepositHash(params, testEscrowDomain())
	if err != nil {
		t.Errorf("zero nonce should be allowed: %v", err)
	}
}

func TestComputeDepositHash_ZeroTimestampsAllowed(t *testing.T) {
	// Zero timestamps should be allowed
	params := createTestDepositParams()
	params.IssuedAt = 0
	params.Deadline = 0

	_, err := ComputeDepositHash(params, testEscrowDomain())
	if err != nil {
		t.Errorf("zero timestamps should be allowed: %v", err)
	}
}

// Cross-language deposit-hash validation now lives in parity_golden_test.go,
// asserting the Go encoder against the program-sourced parity-golden.json
// (Rust + Go + TS all validated against one authoritative source).

func TestComputeDepositHash_WithBase58Pubkeys(t *testing.T) {
	paymentID := [32]byte{1, 2, 3, 4, 5}

	// Use real Solana pubkeys in base58 format
	depositor, _ := PubkeyFromBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
	mint, _ := PubkeyFromBase58("So11111111111111111111111111111111111111112")

	// Non-zero pubkeys for reserver and releaser (validation rejects zero pubkeys)
	reserver := Pubkey{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32}
	releaser := Pubkey{32, 31, 30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1}

	params := EscrowDepositParams{
		DepositRequestHash: paymentID,
		Depositor:          depositor,
		Mint:               mint,
		Amount:             1000000,
		Reserver:           reserver,
		Releaser:           releaser,
		Nonce:              12345,
		IssuedAt:           1700000000,
		Deadline:           1700000120, // 120 seconds after issued_at (within 128s replay window)
	}

	digest, err := ComputeDepositHash(params, testEscrowDomain())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify digest is non-zero (32 bytes is guaranteed by return type)
	var zero32 [32]byte
	if digest == zero32 {
		t.Error("digest should not be zero")
	}
}

// Helper function to create valid test parameters.
//
// Time constraints for Solana escrow:
// - issued_at: When the authorization was signed
// - deadline: Must satisfy issued_at <= deadline <= issued_at + 128 (REPLAY_HORIZON_SECS)
func createTestDepositParams() EscrowDepositParams {
	paymentID := [32]byte{}
	for i := range paymentID {
		paymentID[i] = byte(i + 1)
	}

	depositor := Pubkey{}
	for i := range depositor {
		depositor[i] = byte(i + 10)
	}

	mint := Pubkey{}
	for i := range mint {
		mint[i] = byte(i + 20)
	}

	reserver := Pubkey{}
	for i := range reserver {
		reserver[i] = byte(i + 30)
	}

	releaser := Pubkey{}
	for i := range releaser {
		releaser[i] = byte(i + 40)
	}

	return EscrowDepositParams{
		DepositRequestHash: paymentID,
		Depositor:          depositor,
		Mint:               mint,
		Amount:             1000000,
		Reserver:           reserver,
		Releaser:           releaser,
		Nonce:              12345,
		IssuedAt:           1700000000,
		Deadline:           1700000120, // 120 seconds after issued_at (within 128s replay window)
	}
}
