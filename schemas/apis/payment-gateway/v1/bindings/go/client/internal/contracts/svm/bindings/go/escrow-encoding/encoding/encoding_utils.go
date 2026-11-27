package svm_escrow_encoding

import (
	"encoding/binary"

	"golang.org/x/crypto/sha3"
)

// EncodeU64LE encodes a uint64 in little-endian format.
// This matches Solana/Borsh convention and Rust's `to_le_bytes()`.
func EncodeU64LE(v uint64) []byte {
	buf := make([]byte, 8)
	binary.LittleEndian.PutUint64(buf, v)
	return buf
}

// Keccak256 computes the Keccak-256 hash of the provided data.
// This matches Solana's `solana_program::keccak::hashv()`.
//
// Note: Keccak-256 is NOT the same as SHA3-256.
// - Keccak-256 uses the pre-NIST padding scheme
// - SHA3-256 uses the NIST-specified domain separation padding
//
// Solana uses the original Keccak-256 (same as Ethereum).
func Keccak256(data ...[]byte) [32]byte {
	h := sha3.NewLegacyKeccak256()
	for _, d := range data {
		h.Write(d)
	}

	var result [32]byte
	h.Sum(result[:0])
	return result
}
