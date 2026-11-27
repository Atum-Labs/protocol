package ldverification

import (
	lddataintegrity "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/common"
)

// RecoverAddress recovers the signer's Ethereum address from a Keccak256
// 32-byte digest and a 65-byte ES256K-R signature (r||s||v with v in
// {0,1,27,28}).
//
// Thin wrapper over [lddataintegrity.RecoverSecp256k1Signer]. Errors from
// the lib (wrapping [lddataintegrity.ErrMalformedProof] or
// [lddataintegrity.ErrSignatureRecovery]) are returned unchanged.
func RecoverAddress(hash []byte, signature []byte) (common.Address, error) {
	return lddataintegrity.RecoverSecp256k1Signer(hash, signature)
}
