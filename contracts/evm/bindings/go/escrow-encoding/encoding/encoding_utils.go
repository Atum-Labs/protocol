package encoding

import (
	"github.com/ethereum/go-ethereum/common"
	"math/big"
)

// EvmAddressLength is the length of an address encoded as a 32-byte ABI word.
const EvmAddressLength = 32

// EncodeAddress left-pads an address into a 32-byte ABI word.
func EncodeAddress(address common.Address) []byte {
	addressBytes := make([]byte, EvmAddressLength)
	copy(addressBytes[12:], address.Bytes())

	return addressBytes
}

// EncodeBig encodes value as a big-endian 32-byte ABI word.
func EncodeBig(value big.Int) []byte {
	bytes := make([]byte, 32)
	value.FillBytes(bytes)

	return bytes
}

// EncodeBytes calculates ABI encoded bytes for Solidity
func EncodeBytes(bytes []byte) []byte {
	// abi.encode layout for (bytes):
	// - 32 bytes: offset to bytes data (0x40 = 64)
	// - 32 bytes: length of bytes data
	// - N bytes: actual bytes data (right-padded to multiple of 32)

	// 1. Offset (32 bytes) - points to where dynamic data starts
	offset := make([]byte, 32)
	offset[31] = 0x40 // 64 in hex

	// 2. Length (32 bytes) - length of signature bytes as uint256
	length := make([]byte, 32)
	// Convert length to big-endian bytes
	lenBig := big.NewInt(int64(len(bytes)))
	lenBig.FillBytes(length)

	// 3. Data - signature bytes padded to multiple of 32
	paddedSigLen := ((len(bytes) + 31) / 32) * 32
	paddedSignature := make([]byte, paddedSigLen)
	copy(paddedSignature, bytes)

	encodedBytes := append(offset, length...)
	encodedBytes = append(encodedBytes, paddedSignature...)

	return encodedBytes
}
