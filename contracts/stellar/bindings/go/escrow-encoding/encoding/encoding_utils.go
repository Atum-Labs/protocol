package stellar_escrow_encoding

import (
	"encoding/binary"
	"math/big"

	"golang.org/x/crypto/sha3"
)

// maxI128 is 2^127 - 1: SEP-41 amounts are i128 and the contract only ever hashes non-negative ones.
var maxI128 = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 127), big.NewInt(1))

// EncodeU64LE encodes a uint64 in little-endian format, as the contract's `u64::to_le_bytes`.
func EncodeU64LE(v uint64) []byte {
	buf := make([]byte, 8)
	binary.LittleEndian.PutUint64(buf, v)
	return buf
}

// EncodeAmount16 encodes a non-negative i128 as 16 little-endian bytes (`amt16` in the layout doc).
// Negative values and values above i128::MAX are rejected: the contract would encode a negative one as
// its two's-complement u128, a digest no honest transaction can reach.
func EncodeAmount16(v *big.Int) ([]byte, error) {
	if v == nil || v.Sign() < 0 || v.Cmp(maxI128) > 0 {
		return nil, ErrAmountOutOfRange
	}
	be := v.FillBytes(make([]byte, 16))
	for i, j := 0, len(be)-1; i < j; i, j = i+1, j-1 {
		be[i], be[j] = be[j], be[i]
	}
	return be, nil
}

// Keccak256 computes the Keccak-256 hash of the provided data, as the host's `keccak256`.
//
// Note: Keccak-256 is NOT the same as SHA3-256. It uses the pre-NIST padding, as Ethereum and the
// Solana port do.
func Keccak256(data ...[]byte) [32]byte {
	h := sha3.NewLegacyKeccak256()
	for _, d := range data {
		h.Write(d)
	}

	var result [32]byte
	h.Sum(result[:0])
	return result
}
