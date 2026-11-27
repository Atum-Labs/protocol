package ldverification

import (
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/common"
)

// RecoverAddress recovers the signer's Ethereum address from a Keccak256
// 32-byte digest and a 65-byte ES256K-R signature (r||s||v with v in
// {0,1,27,28}).
//
// Thin wrapper over [lddataintegrity.RecoverSecp256k1Signer]. Errors from
// the lib (wrapping [lddataintegrity.ErrMalformedProof] or
// [lddataintegrity.ErrSignatureRecovery]) are returned unchanged; FQ
// callers compose their own higher-level sentinel (typically
// [ErrVPVCSignatureInvalid] via errors.Join) so no FQ-side wrapping is
// needed here.
func RecoverAddress(hash []byte, signature []byte) (common.Address, error) {
	return lddataintegrity.RecoverSecp256k1Signer(hash, signature)
}

// recoverProofSigner recovers a secp256k1 proof signer from hash, accepting the legacy signing
// input or the SettlerProof typed digest (see [lddataintegrity.RecoverSecp256k1ProofSigner]).
func recoverProofSigner(hash HashResult, signature []byte, matches func(common.Address) bool) (common.Address, error) {
	return lddataintegrity.RecoverSecp256k1ProofSigner(hash, signature, matches)
}
