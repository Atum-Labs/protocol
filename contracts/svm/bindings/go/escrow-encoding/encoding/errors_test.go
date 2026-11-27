package svm_escrow_encoding

import (
	"errors"
	"testing"
)

// TestSentinelErrors verifies that errors.Is() works with our sentinel errors.
// This enables callers to check for specific validation failures.
func TestSentinelErrors(t *testing.T) {
	tests := []struct {
		name     string
		encoder  func() error
		expected error
	}{
		{
			name: "deposit zero payment ID",
			encoder: func() error {
				_, err := ComputeDepositHash(EscrowDepositParams{}, testEscrowDomain())
				return err
			},
			expected: ErrZeroDepositRequestHash,
		},
		{
			name: "deposit zero depositor",
			encoder: func() error {
				_, err := ComputeDepositHash(EscrowDepositParams{
					DepositRequestHash: [32]byte{1},
				}, testEscrowDomain())
				return err
			},
			expected: ErrZeroDepositor,
		},
		{
			name: "deposit zero mint",
			encoder: func() error {
				_, err := ComputeDepositHash(EscrowDepositParams{
					DepositRequestHash: [32]byte{1},
					Depositor:          Pubkey{1},
				}, testEscrowDomain())
				return err
			},
			expected: ErrZeroMint,
		},
		{
			name: "deposit zero amount",
			encoder: func() error {
				_, err := ComputeDepositHash(EscrowDepositParams{
					DepositRequestHash: [32]byte{1},
					Depositor:          Pubkey{1},
					Mint:               Pubkey{1},
					Amount:             0,
				}, testEscrowDomain())
				return err
			},
			expected: ErrZeroAmount,
		},
		{
			name: "deposit zero reserver",
			encoder: func() error {
				_, err := ComputeDepositHash(EscrowDepositParams{
					DepositRequestHash: [32]byte{1},
					Depositor:          Pubkey{1},
					Mint:               Pubkey{1},
					Amount:             1,
					Reserver:           Pubkey{}, // zero
				}, testEscrowDomain())
				return err
			},
			expected: ErrZeroReserver,
		},
		{
			name: "deposit zero releaser",
			encoder: func() error {
				_, err := ComputeDepositHash(EscrowDepositParams{
					DepositRequestHash: [32]byte{1},
					Depositor:          Pubkey{1},
					Mint:               Pubkey{1},
					Amount:             1,
					Reserver:           Pubkey{1},
					Releaser:           Pubkey{}, // zero
				}, testEscrowDomain())
				return err
			},
			expected: ErrZeroReleaser,
		},
		{
			name: "release zero deposit hash",
			encoder: func() error {
				_, err := ComputeReleaseHash(EscrowReleaseParams{}, testEscrowDomain())
				return err
			},
			expected: ErrZeroDepositHash,
		},
		{
			name: "refund zero deposit hash",
			encoder: func() error {
				_, err := ComputeRefundHash(EscrowRefundParams{}, testEscrowDomain())
				return err
			},
			expected: ErrZeroDepositHash,
		},
		{
			name: "reserve zero deposit hash",
			encoder: func() error {
				_, err := ComputeReserveHash(EscrowReserveParams{}, testEscrowDomain())
				return err
			},
			expected: ErrZeroDepositHash,
		},
		{
			name: "reserve zero recipient",
			encoder: func() error {
				_, err := ComputeReserveHash(EscrowReserveParams{
					DepositHash: [32]byte{1},
				}, testEscrowDomain())
				return err
			},
			expected: ErrZeroRecipient,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.encoder()
			if err == nil {
				t.Fatal("expected error, got nil")
			}

			// Verify errors.Is() works with sentinel errors
			if !errors.Is(err, tc.expected) {
				t.Errorf("errors.Is() failed: got %v, want %v", err, tc.expected)
			}

			// Verify the error is exactly our sentinel (not wrapped)
			if err != tc.expected {
				t.Errorf("error mismatch: got %v, want %v", err, tc.expected)
			}
		})
	}
}
