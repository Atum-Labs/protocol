package stellar_escrow_encoding

import (
	"encoding/hex"
	"strings"
)

// Pubkey is a raw 32-byte ed25519 public key: the bytes behind a G... strkey. The delegate signer,
// reserver and releaser are Pubkeys, not Addresses: the contract verifies their signatures itself and
// never calls require_auth for them.
type Pubkey [32]byte

// PubkeyFromStrkey parses a G... strkey into the key behind it. A C... contract address has no
// signing key and is rejected.
func PubkeyFromStrkey(s string) (Pubkey, error) {
	a, err := ParseAddress(s)
	if err != nil {
		return Pubkey{}, err
	}
	if a.Type != AccountAddress {
		return Pubkey{}, ErrUnsupportedAddress
	}
	return Pubkey(a.Key), nil
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
	return PubkeyFromBytes(decoded)
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

// Bytes returns the key as a byte slice.
func (pk Pubkey) Bytes() []byte {
	return pk[:]
}

// String returns the G... strkey of the key.
func (pk Pubkey) String() string {
	return NewAccountAddress(pk).String()
}

// Hex returns the hex encoding of the key (without 0x prefix).
func (pk Pubkey) Hex() string {
	return hex.EncodeToString(pk[:])
}

// IsZero returns true if the key is all zeros.
func (pk Pubkey) IsZero() bool {
	var zero Pubkey
	return pk == zero
}
