package encoding

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/fbsobreira/gotron-sdk/pkg/address"
)

const (
	//TVMAddressLength TVM address length in bytes (21 bytes = 1 byte prefix + 20 bytes address)
	TVMAddressLength = 21
	//TVMMainnetPrefix TVM mainnet address prefix
	TVMMainnetPrefix = "41"
)

// ConvertBase58ToHex converts a TVM base58 address (e.g., "TYaKH9ApqbdftVGSnTMPVL9kp1S5AQBQSs")
// to hex format without 0x prefix (e.g., "41f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f")
func ConvertBase58ToHex(base58Addr string) (string, error) {
	if base58Addr == "" {
		return "", errors.New("empty base58 address")
	}

	// Use gotron-sdk to decode the base58 address
	addr, err := address.Base58ToAddress(base58Addr)
	if err != nil {
		return "", err
	}

	// Convert to hex string without 0x prefix
	hexAddr := hex.EncodeToString(addr)
	return hexAddr, nil
}

// NormalizeAddress takes an address in any format (base58 or hex) and returns it in hex format
// without 0x prefix, suitable for TIP-712 encoding. Hex input is accepted in two shapes: the
// 21-byte spelling carrying Tron's 41 marker byte, and the bare 20-byte body. Length selects
// which shape an input is; the marker byte must then be exactly 41.
func NormalizeAddress(addr string) (string, error) {
	if addr == "" {
		return "", errors.New("empty address")
	}

	// Handle base58
	if strings.HasPrefix(addr, "T") {
		var err error
		addr, err = ConvertBase58ToHex(addr)
		if err != nil {
			return "", err
		}
	}

	// Trim 0x
	addr = strings.TrimPrefix(addr, "0x")

	// Trim the 41 marker byte, which only the 21-byte spelling carries. A 20-byte
	// body is free to begin with 0x41 itself, so gating on the leading characters
	// alone would eat the first byte of one address in 256.
	if len(addr) == 2*TVMAddressLength {
		addr = strings.TrimPrefix(addr, TVMMainnetPrefix)
	}

	// Check length
	if len(addr) != 2*(TVMAddressLength-1) {
		return "", errors.New("invalid address length")
	}

	// Validate hex
	decoded, err := hex.DecodeString(addr)
	if err != nil {
		return "", err
	}

	if len(decoded) != TVMAddressLength-1 {
		return "", errors.New("invalid address length after decode")
	}

	return hex.EncodeToString(decoded), nil
}

// TIP712AddressWord encodes a 40-hex-character address body as a 32-byte TIP-712 word.
func TIP712AddressWord(hex40 string) ([]byte, error) {
	// Decode the 40 hex chars (20 bytes)
	addr20, err := hex.DecodeString(hex40)
	if err != nil {
		return []byte{}, fmt.Errorf("invalid hex: %w", err)
	}
	if len(addr20) != 20 {
		return []byte{}, fmt.Errorf("expected 20 bytes, got %d", len(addr20))
	}

	word := make([]byte, 32)

	// Left-pad into 32 bytes (ABI encoding for address/uint160)
	copy(word[12:], addr20)
	return word, nil
}

// EncodeTIP712Address encodes a Tron address in any spelling as a 32-byte TIP-712 word.
func EncodeTIP712Address(addr string) ([]byte, error) {
	normalizedAddress, err := NormalizeAddress(addr)

	if err != nil {
		return []byte{}, err
	}

	return TIP712AddressWord(normalizedAddress)
}

// TVMAddress converts a Tron address in any accepted spelling — base58
// (e.g., "TR6y…"), 41-prefixed hex, or the bare 20-byte body — to a 20-byte
// common.Address suitable for inclusion in a witness struct or as the
// verifyingContract field of a TIP-712 domain. The 0x41 Tron-mainnet marker
// comes off the 21-byte spelling only; TIP-712 hashing operates on the bare
// 20-byte form, and pre-normalizing to common.Address lets V3 encoders share
// the same apitypes.TypedDataAndHash path as the EVM encoders.
func TVMAddress(addr string) (common.Address, error) {
	normalized, err := NormalizeAddress(addr)
	if err != nil {
		return common.Address{}, err
	}
	return common.HexToAddress("0x" + normalized), nil
}
