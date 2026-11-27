// Package svm_escrow_encoding provides message hash generation for the Solana escrow program.
// This is analogous to evm-escrow-encoding for EVM chains.
//
// Solana uses a simpler hashing scheme than EVM:
// - Tag prefix (e.g., "deposit", "release")
// - Concatenation of parameters
// - Keccak256 hash
//
// No EIP-712 complexity required.
package svm_escrow_encoding

import (
	"encoding/hex"
	"errors"
	"strings"

	"github.com/mr-tron/base58"
)

// Pubkey represents a 32-byte Solana public key.
type Pubkey [32]byte

var (
	// ErrInvalidPubkeyLength is returned when a pubkey has an invalid length.
	ErrInvalidPubkeyLength = errors.New("invalid pubkey length: expected 32 bytes")

	// ErrInvalidBase58 is returned when base58 decoding fails.
	ErrInvalidBase58 = errors.New("invalid base58 encoding")

	// ErrInvalidHex is returned when hex decoding fails.
	ErrInvalidHex = errors.New("invalid hex encoding")
)

// PubkeyFromBase58 parses a Solana address from Base58 encoding.
// This is the standard format for Solana public keys.
func PubkeyFromBase58(s string) (Pubkey, error) {
	decoded, err := base58.Decode(s)
	if err != nil {
		return Pubkey{}, ErrInvalidBase58
	}

	if len(decoded) != 32 {
		return Pubkey{}, ErrInvalidPubkeyLength
	}

	var pk Pubkey
	copy(pk[:], decoded)
	return pk, nil
}

// MustPubkeyFromBase58 parses a Solana address from Base58 encoding.
// Panics if parsing fails. Use only for known-good values (e.g., in tests).
func MustPubkeyFromBase58(s string) Pubkey {
	pk, err := PubkeyFromBase58(s)
	if err != nil {
		panic(err)
	}
	return pk
}

// PubkeyFromHex parses a public key from hex encoding.
// Accepts with or without "0x" prefix.
func PubkeyFromHex(s string) (Pubkey, error) {
	s = strings.TrimPrefix(s, "0x")
	s = strings.TrimPrefix(s, "0X")

	decoded, err := hex.DecodeString(s)
	if err != nil {
		return Pubkey{}, ErrInvalidHex
	}

	if len(decoded) != 32 {
		return Pubkey{}, ErrInvalidPubkeyLength
	}

	var pk Pubkey
	copy(pk[:], decoded)
	return pk, nil
}

// MustPubkeyFromHex parses a public key from hex encoding.
// Panics if parsing fails. Use only for known-good values (e.g., in tests).
func MustPubkeyFromHex(s string) Pubkey {
	pk, err := PubkeyFromHex(s)
	if err != nil {
		panic(err)
	}
	return pk
}

// PubkeyFromBytes creates a Pubkey from raw bytes.
func PubkeyFromBytes(b []byte) (Pubkey, error) {
	if len(b) != 32 {
		return Pubkey{}, ErrInvalidPubkeyLength
	}

	var pk Pubkey
	copy(pk[:], b)
	return pk, nil
}

// MustPubkeyFromBytes creates a Pubkey from raw bytes.
// Panics if the length is not 32 bytes. Use only for known-good values.
func MustPubkeyFromBytes(b []byte) Pubkey {
	pk, err := PubkeyFromBytes(b)
	if err != nil {
		panic(err)
	}
	return pk
}

// Bytes returns the pubkey as a byte slice.
func (pk Pubkey) Bytes() []byte {
	return pk[:]
}

// String returns the base58 encoding of the pubkey.
func (pk Pubkey) String() string {
	return base58.Encode(pk[:])
}

// Hex returns the hex encoding of the pubkey (without 0x prefix).
func (pk Pubkey) Hex() string {
	return hex.EncodeToString(pk[:])
}

// IsZero returns true if the pubkey is all zeros.
func (pk Pubkey) IsZero() bool {
	var zero Pubkey
	return pk == zero
}
