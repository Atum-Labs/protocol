package encoding

import (
	"math/big"

	"github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/encoding"
)

// ChainIDMask keeps the low 32 bits of a chain ID for TIP-712 (Tron uses uint32
// chain IDs). Invariant: TVM chain IDs must fit in 32 bits. Two IDs sharing their
// low 32 bits mask to the same value and thus the same signing domain, so a
// signature for one would verify on the other. All current Tron networks are < 2^32.
const ChainIDMask = 0xFFFFFFFF

// MaskTronChainId returns chainID & 0xFFFFFFFF (the value Tron contracts use
// internally when constructing the EIP712Domain hash). See ChainIDMask for the
// 32-bit-fit invariant and the cross-chain signing-domain collision risk when
// it is violated.
func MaskTronChainId(chainID big.Int) big.Int {
	chainIDMask := new(big.Int).SetUint64(ChainIDMask)
	return *new(big.Int).And(&chainID, chainIDMask)
}

// MaskTronChainIdBig is the *big.Int variant used by the V3 encoders.
func MaskTronChainIdBig(chainID *big.Int) *big.Int {
	chainIDMask := new(big.Int).SetUint64(ChainIDMask)
	return new(big.Int).And(chainID, chainIDMask)
}

// EncodeTvmChainId returns the masked chainID as 32 ABI-encoded bytes. Used by
// callers that need the wire-format chainID directly (e.g., test fixtures).
func EncodeTvmChainId(chainID big.Int) []byte {
	maskedChainID := MaskTronChainId(chainID)
	return encoding.EncodeBig(maskedChainID)
}
