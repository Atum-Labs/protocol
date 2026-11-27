package encoding

import (
	"fmt"
	"math/big"

	"github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/encoding"

	"github.com/ethereum/go-ethereum/crypto"
)

// EscrowPaymentIdEncoder implements calculation of PaymentID for the V3 Tron
// escrow contract. Mirrors the EVM equivalent: keccak256(abi.encode(depositor,
// signature, nonce)). The depositor address is TIP-712-encoded to its 20-byte
// form (no `0x41` prefix) before ABI-encoding to match the on-chain
// abi.encode(address) representation.
type EscrowPaymentIdEncoder struct{}

// NewEscrowPaymentIdEncoder returns an EscrowPaymentIdEncoder.
func NewEscrowPaymentIdEncoder() EscrowPaymentIdEncoder {
	return EscrowPaymentIdEncoder{}
}

// Digest computes paymentId = keccak256(abi.encode(depositor, signature, nonce)).
// The `depositor` argument may be a base58 ("T…") or 41-prefixed-hex Tron address.
func (EscrowPaymentIdEncoder) Digest(depositor string, depositSignature []byte, nonce *big.Int) ([]byte, error) {
	if depositSignature == nil {
		return nil, fmt.Errorf("deposit signature is required")
	}
	if nonce == nil {
		return nil, fmt.Errorf("nonce is required")
	}

	// abi.encode layout for (address, bytes, uint256):
	//   slot 0 (32B): address (left-padded)
	//   slot 1 (32B): offset to dynamic bytes data (= 0x60, after the 3 head slots)
	//   slot 2 (32B): nonce
	//   slot 3 (32B): bytes length
	//   slot 4..  : bytes data (right-padded to 32-byte boundary)
	depositorBytes, err := EncodeTIP712Address(depositor)
	if err != nil {
		return nil, err
	}

	offset := make([]byte, 32)
	offset[31] = 0x60

	nonceBytes := encoding.EncodeBig(*nonce)

	length := make([]byte, 32)
	new(big.Int).SetInt64(int64(len(depositSignature))).FillBytes(length)

	paddedSigLen := ((len(depositSignature) + 31) / 32) * 32
	paddedSignature := make([]byte, paddedSigLen)
	copy(paddedSignature, depositSignature)

	encodedData := append([]byte{}, depositorBytes...)
	encodedData = append(encodedData, offset...)
	encodedData = append(encodedData, nonceBytes...)
	encodedData = append(encodedData, length...)
	encodedData = append(encodedData, paddedSignature...)

	return crypto.Keccak256(encodedData), nil
}

// Backwards-compatible aliases (kept for callers that haven't migrated to the
// V3 paymentId terminology yet — same shape, different name).

// EscrowDepositIdEncoder is the backwards-compatible name for EscrowPaymentIdEncoder.
type EscrowDepositIdEncoder = EscrowPaymentIdEncoder

// NewEscrowDepositIdEncoder is the backwards-compatible name for NewEscrowPaymentIdEncoder.
func NewEscrowDepositIdEncoder() EscrowDepositIdEncoder {
	return NewEscrowPaymentIdEncoder()
}
