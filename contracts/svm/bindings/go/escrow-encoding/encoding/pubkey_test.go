package svm_escrow_encoding

import (
	"bytes"
	"testing"
)

// TestPubkey_Usage demonstrates how to parse Solana public keys from
// various formats (Base58, hex, raw bytes).
func TestPubkey_Usage(t *testing.T) {
	// From Base58 (standard Solana format - most common)
	pk1, err := PubkeyFromBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
	if err != nil {
		t.Fatalf("PubkeyFromBase58 failed: %v", err)
	}

	// From hex (with or without 0x prefix)
	pk2, err := PubkeyFromHex("0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20")
	if err != nil {
		t.Fatalf("PubkeyFromHex failed: %v", err)
	}

	// From raw bytes
	rawBytes := make([]byte, 32)
	for i := range rawBytes {
		rawBytes[i] = byte(i)
	}
	pk3, err := PubkeyFromBytes(rawBytes)
	if err != nil {
		t.Fatalf("PubkeyFromBytes failed: %v", err)
	}

	// Check for zero pubkey (validation)
	if pk1.IsZero() {
		t.Error("pk1 should not be zero")
	}

	// Convert back to Base58 string
	_ = pk1.String()

	// Use in encoder params
	_ = pk2
	_ = pk3
}

func TestPubkeyFromBase58(t *testing.T) {
	// System Program pubkey (11111111111111111111111111111111)
	systemProgram := "11111111111111111111111111111111"
	pk, err := PubkeyFromBase58(systemProgram)
	if err != nil {
		t.Fatalf("failed to parse system program pubkey: %v", err)
	}

	// System program is all zeros
	var expectedZero Pubkey
	if pk != expectedZero {
		t.Errorf("system program should be all zeros, got %x", pk[:])
	}

	// A real Solana pubkey
	realPubkey := "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
	pk, err = PubkeyFromBase58(realPubkey)
	if err != nil {
		t.Fatalf("failed to parse token program pubkey: %v", err)
	}

	if pk.IsZero() {
		t.Error("token program pubkey should not be zero")
	}

	// Round-trip test
	encoded := pk.String()
	if encoded != realPubkey {
		t.Errorf("round-trip failed: got %s, want %s", encoded, realPubkey)
	}
}

func TestPubkeyFromBase58_Invalid(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"invalid characters", "0OIl"},
		{"too short", "11111111111"},
		{"empty", ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := PubkeyFromBase58(tc.input)
			if err == nil {
				t.Error("expected error for invalid input")
			}
		})
	}
}

func TestPubkeyFromHex(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []byte
	}{
		{
			name:     "without prefix",
			input:    "0000000000000000000000000000000000000000000000000000000000000000",
			expected: make([]byte, 32),
		},
		{
			name:     "with 0x prefix",
			input:    "0x0000000000000000000000000000000000000000000000000000000000000001",
			expected: append(make([]byte, 31), 1),
		},
		{
			name:     "with 0X prefix",
			input:    "0X0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
			expected: []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			pk, err := PubkeyFromHex(tc.input)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if !bytes.Equal(pk[:], tc.expected) {
				t.Errorf("got %x, want %x", pk[:], tc.expected)
			}
		})
	}
}

func TestPubkeyFromHex_Invalid(t *testing.T) {
	tests := []struct {
		name  string
		input string
	}{
		{"odd length", "0x123"},
		{"invalid hex", "0xGGGG0000000000000000000000000000000000000000000000000000000000"},
		{"too short", "0x1234"},
		{"empty", ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := PubkeyFromHex(tc.input)
			if err == nil {
				t.Error("expected error for invalid input")
			}
		})
	}
}

func TestPubkeyFromBytes(t *testing.T) {
	data := make([]byte, 32)
	for i := range data {
		data[i] = byte(i)
	}

	pk, err := PubkeyFromBytes(data)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !bytes.Equal(pk[:], data) {
		t.Errorf("got %x, want %x", pk[:], data)
	}
}

func TestPubkeyFromBytes_Invalid(t *testing.T) {
	tests := []struct {
		name string
		data []byte
	}{
		{"too short", make([]byte, 31)},
		{"too long", make([]byte, 33)},
		{"empty", []byte{}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := PubkeyFromBytes(tc.data)
			if err == nil {
				t.Error("expected error for invalid input")
			}
		})
	}
}

func TestPubkeyIsZero(t *testing.T) {
	var zero Pubkey
	if !zero.IsZero() {
		t.Error("zero pubkey should be zero")
	}

	nonZero := Pubkey{1}
	if nonZero.IsZero() {
		t.Error("non-zero pubkey should not be zero")
	}
}

func TestMustPubkeyFromBase58_Panic(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic for invalid input")
		}
	}()

	MustPubkeyFromBase58("invalid")
}

func TestMustPubkeyFromHex_Panic(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic for invalid input")
		}
	}()

	MustPubkeyFromHex("invalid")
}

func TestMustPubkeyFromBytes_Panic(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Error("expected panic for invalid input")
		}
	}()

	MustPubkeyFromBytes([]byte{1, 2, 3})
}
