// Package stellar_escrow_encoding provides digest generation for the Soroban escrow contract.
// This is analogous to svm-escrow-encoding for Solana.
//
// Stellar uses the Solana port's framing:
// - a constant prefix (tag, version, network id, contract id)
// - an operation tag
// - fixed-width fields concatenated with no separators
// - Keccak256 hash
//
// The layouts are specified byte for byte in contracts/stellar/source/docs/witness-layouts.md and
// implemented by contracts/stellar/source/contracts/escrow/src/signatures.rs.
package stellar_escrow_encoding

import (
	"encoding/base32"
	"encoding/binary"
	"fmt"
)

// AddressType is the XDR ScAddressType byte that leads an addr33.
type AddressType uint8

const (
	// AccountAddress is a G... strkey: the 32-byte ed25519 key behind the account.
	AccountAddress AddressType = 0
	// ContractAddress is a C... strkey: the 32-byte contract id hash.
	ContractAddress AddressType = 1
)

// strkey version bytes: the version number shifted left three bits, so the first base32 character is
// the letter. Only the two address types the layout can represent are decoded to an Address.
const (
	versionAccount          = 6 << 3
	versionContract         = 2 << 3
	versionMuxedAccount     = 12 << 3
	versionClaimableBalance = 1 << 3
)

var strkeyEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// Address is a Soroban address as the layout encodes it: one type byte and 32 bytes.
type Address struct {
	Type AddressType
	Key  [32]byte
}

// NewAccountAddress wraps a raw ed25519 public key as a G... address.
func NewAccountAddress(key [32]byte) Address { return Address{Type: AccountAddress, Key: key} }

// NewContractAddress wraps a 32-byte contract id hash as a C... address.
func NewContractAddress(id [32]byte) Address { return Address{Type: ContractAddress, Key: id} }

// ParseAddress parses a G... or C... strkey. Muxed (M...) and claimable-balance (B...) addresses are
// well-formed but have no 33-byte form and return ErrUnsupportedAddress, as the contract does.
func ParseAddress(s string) (Address, error) {
	version, payload, err := decodeStrkey(s)
	if err != nil {
		return Address{}, err
	}
	switch version {
	case versionAccount, versionContract:
		if len(payload) != 32 {
			return Address{}, fmt.Errorf("%w: payload is %d bytes, want 32", ErrInvalidStrkey, len(payload))
		}
		a := Address{Type: AccountAddress}
		if version == versionContract {
			a.Type = ContractAddress
		}
		copy(a.Key[:], payload)
		return a, nil
	case versionMuxedAccount, versionClaimableBalance:
		return Address{}, ErrUnsupportedAddress
	default:
		// Includes secret seeds (S...): never decoded, and the input is not echoed back
		return Address{}, fmt.Errorf("%w: not an account or contract address", ErrInvalidStrkey)
	}
}

// MustParseAddress parses a strkey and panics on failure. Use only for known-good values.
func MustParseAddress(s string) Address {
	a, err := ParseAddress(s)
	if err != nil {
		panic(err)
	}
	return a
}

// Bytes33 returns the addr33 encoding: the type byte then the 32-byte key.
func (a Address) Bytes33() [33]byte {
	var out [33]byte
	out[0] = byte(a.Type)
	copy(out[1:], a.Key[:])
	return out
}

// String returns the strkey (G... or C...).
func (a Address) String() string {
	version := byte(versionAccount)
	if a.Type == ContractAddress {
		version = versionContract
	}
	return encodeStrkey(version, a.Key[:])
}

// valid reports whether the type byte is one the layout defines.
func (a Address) valid() bool { return a.Type == AccountAddress || a.Type == ContractAddress }

func encodeStrkey(version byte, payload []byte) string {
	body := append([]byte{version}, payload...)
	crc := make([]byte, 2)
	binary.LittleEndian.PutUint16(crc, crc16XModem(body))
	return strkeyEncoding.EncodeToString(append(body, crc...))
}

// decodeStrkey checks base32, canonical form, checksum, and returns the version byte and payload.
func decodeStrkey(s string) (byte, []byte, error) {
	// Alphabet first: Go's base32 decoder silently drops \r and \n, so an embedded line break would
	// otherwise reach the decoder as a shorter string. The canonical re-encode below also refuses it; this
	// keeps the refusal local to the character that causes it rather than depending on a later check.
	if s == "" {
		return 0, nil, fmt.Errorf("%w: expected upper-case base32", ErrInvalidStrkey)
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; (c < 'A' || c > 'Z') && (c < '2' || c > '7') {
			return 0, nil, fmt.Errorf("%w: expected upper-case base32", ErrInvalidStrkey)
		}
	}
	raw, err := strkeyEncoding.DecodeString(s)
	if err != nil || len(raw) < 3 {
		return 0, nil, fmt.Errorf("%w: bad base32", ErrInvalidStrkey)
	}
	// Re-encoding rejects non-zero trailing bits, which base32 decoders otherwise ignore
	if strkeyEncoding.EncodeToString(raw) != s {
		return 0, nil, fmt.Errorf("%w: non-canonical base32", ErrInvalidStrkey)
	}
	body, crc := raw[:len(raw)-2], binary.LittleEndian.Uint16(raw[len(raw)-2:])
	if crc16XModem(body) != crc {
		return 0, nil, fmt.Errorf("%w: bad checksum", ErrInvalidStrkey)
	}
	return body[0], body[1:], nil
}

// crc16XModem is the strkey checksum: CRC-16/XMODEM (polynomial 0x1021, initial value 0).
func crc16XModem(data []byte) uint16 {
	var crc uint16
	for _, b := range data {
		crc ^= uint16(b) << 8
		for i := 0; i < 8; i++ {
			if crc&0x8000 != 0 {
				crc = crc<<1 ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return crc
}
