package senderauth

import (
	svm "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/svm/bindings/go/escrow-encoding/encoding"
)

// isSmallOrderEncoding reports whether a 32-byte point encoding, with either sign bit, is a point
// whose order divides 8. It is the escrow encoding's check.
func isSmallOrderEncoding(point []byte) bool { return svm.IsSmallOrderEncoding(point) }

// verifyEd25519Strict is ed25519 verification as the Solana ed25519 program performs it
// (verify_strict). It is the escrow encoding's check. Mirrors the TS `verifyEd25519Strict`.
func verifyEd25519Strict(publicKey, message, signature []byte) bool {
	return svm.VerifyEd25519Strict(publicKey, message, signature)
}
