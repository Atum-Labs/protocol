package encoding

import (
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// EscrowPaymentIdEncoder implements calculation of PaymentID for escrow contract.
type EscrowPaymentIdEncoder struct{}

// NewEscrowPaymentIdEncoder returns an EscrowPaymentIdEncoder.
func NewEscrowPaymentIdEncoder() EscrowPaymentIdEncoder {
	return EscrowPaymentIdEncoder{}
}

// Digest implements calculation of PaymentID for escrow contract.
// Uses abi.encode(depositor, signature, nonce) to match Solidity
func (EscrowPaymentIdEncoder) Digest(depositor common.Address, depositSignature []byte, nonce *big.Int) ([]byte, error) {
	// For abi.encode(address, bytes, uint256):
	// - address: 32 bytes (padded)
	// - offset to bytes data: 32 bytes (0x60 = 96, after 3 * 32 bytes of fixed data)
	// - uint256: 32 bytes
	// - bytes length: 32 bytes
	// - bytes data: padded to multiple of 32

	// 1. Address (32 bytes)
	depositorBytes := EncodeAddress(depositor)

	// 2. Offset to dynamic bytes data (32 bytes) - points after all fixed-size params
	offset := make([]byte, 32)
	offset[31] = 0x60 // 96 = 3 * 32 (after address, offset, nonce)

	// 3. Nonce (32 bytes)
	nonceBytes := EncodeBig(*nonce)

	// 4. Bytes length (32 bytes)
	length := make([]byte, 32)
	lenBig := big.NewInt(int64(len(depositSignature)))
	lenBig.FillBytes(length)

	// 5. Bytes data (padded)
	paddedSigLen := ((len(depositSignature) + 31) / 32) * 32
	paddedSignature := make([]byte, paddedSigLen)
	copy(paddedSignature, depositSignature)

	// Concatenate all parts
	encodedData := append(depositorBytes, offset...)
	encodedData = append(encodedData, nonceBytes...)
	encodedData = append(encodedData, length...)
	encodedData = append(encodedData, paddedSignature...)

	// keccak256(abi.encode(depositor, signature, nonce))
	paymentId := crypto.Keccak256(encodedData)

	return paymentId, nil
}

// Backwards-compatible aliases

// EscrowDepositIdEncoder is the backwards-compatible name for EscrowPaymentIdEncoder.
type EscrowDepositIdEncoder = EscrowPaymentIdEncoder

// NewEscrowDepositIdEncoder is the backwards-compatible name for NewEscrowPaymentIdEncoder.
func NewEscrowDepositIdEncoder() EscrowDepositIdEncoder {
	return NewEscrowPaymentIdEncoder()
}
