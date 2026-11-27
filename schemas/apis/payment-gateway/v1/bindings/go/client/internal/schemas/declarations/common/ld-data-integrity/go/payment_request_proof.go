package lddataintegrity

import (
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// The payment request EIP-712 domain, for the two proofs a payment request carries about its
// originator: the inner PaymentRequest proof and the PaymentRequestEnvelope holder proof.
//
// An EcdsaSecp256k1RecoverySignature2020 proof signs keccak256(proofHash || docHash), a raw
// 32-byte digest, and a browser wallet signs no raw digest: it signs typed data
// (eth_signTypedData_v4) or a prefixed message (personal_sign). So a payer whose key is in a
// wallet signs the typed form instead: the same proof, whose signature is over the EIP-712 digest
// of {proofHash, docHash}, the two hashes the raw form combines. Nothing else changes on the wire:
// proof.type, the proof options and the detached JWS are the raw form's, and a verifier tells the
// two apart by which digest recovers the signer the proof names.
//
// Like the settler identity domain, it carries no chainId: the digest is the same on every chain,
// so a wallet signs it whatever chain it is on, and its verifying contract is a sentinel with no
// code, the last 20 bytes of keccak256("atum.payment-request.v1").
const (
	PaymentRequestDomainName        = "Atum Payment Request"
	PaymentRequestDomainVersion     = "1"
	PaymentRequestVerifyingContract = "0x520A20100F01165e806D6d239d9D287a109Ce456"

	// PaymentRequestProofPrimaryType is the inner PaymentRequest proof's typed struct.
	PaymentRequestProofPrimaryType = "PaymentRequestProof"
	// PaymentRequestEnvelopeProofPrimaryType is the PaymentRequestEnvelope holder proof's.
	PaymentRequestEnvelopeProofPrimaryType = "PaymentRequestEnvelopeProof"

	// PaymentRequestEnvelopeType is the declaration type a PaymentRequestEnvelope's signed `type`
	// carries. The typed holder proof is only ever accepted for an envelope that declares it.
	PaymentRequestEnvelopeType = "PaymentRequestEnvelope"
)

var (
	paymentRequestProofTypeHash         = crypto.Keccak256([]byte("PaymentRequestProof(bytes32 proofHash,bytes32 docHash)"))
	paymentRequestEnvelopeProofTypeHash = crypto.Keccak256([]byte("PaymentRequestEnvelopeProof(bytes32 proofHash,bytes32 docHash)"))

	paymentRequestDomainSeparator = crypto.Keccak256(
		eip712DomainTypeHash,
		crypto.Keccak256([]byte(PaymentRequestDomainName)),
		crypto.Keccak256([]byte(PaymentRequestDomainVersion)),
		common.LeftPadBytes(common.HexToAddress(PaymentRequestVerifyingContract).Bytes(), 32),
	)
)

// TypedProofDigest computes a typed digest from the two hashes HashDocument returns.
type TypedProofDigest func(proofHash, docHash []byte) ([]byte, error)

// PaymentRequestDomainSeparator returns the EIP-712 domain separator of the payment request domain.
func PaymentRequestDomainSeparator() []byte {
	return common.CopyBytes(paymentRequestDomainSeparator)
}

// PaymentRequestProofTypedDigest returns the EIP-712 digest of PaymentRequestProof{proofHash,
// docHash} under the payment request domain: what a wallet signs for the inner PaymentRequest.
func PaymentRequestProofTypedDigest(proofHash, docHash []byte) ([]byte, error) {
	return paymentRequestTypedDigest(paymentRequestProofTypeHash, PaymentRequestProofPrimaryType, proofHash, docHash)
}

// PaymentRequestEnvelopeProofTypedDigest returns the EIP-712 digest of
// PaymentRequestEnvelopeProof{proofHash, docHash} under the payment request domain: what a wallet
// signs for the PaymentRequestEnvelope's holder proof.
func PaymentRequestEnvelopeProofTypedDigest(proofHash, docHash []byte) ([]byte, error) {
	return paymentRequestTypedDigest(paymentRequestEnvelopeProofTypeHash, PaymentRequestEnvelopeProofPrimaryType, proofHash, docHash)
}

func paymentRequestTypedDigest(typeHash []byte, primaryType string, proofHash, docHash []byte) ([]byte, error) {
	if len(proofHash) != 32 || len(docHash) != 32 {
		return nil, fmt.Errorf("%w: %s hashes must be 32 bytes, got proofHash=%d docHash=%d",
			ErrMalformedProof, primaryType, len(proofHash), len(docHash))
	}
	structHash := crypto.Keccak256(typeHash, proofHash, docHash)
	return crypto.Keccak256([]byte{0x19, 0x01}, paymentRequestDomainSeparator, structHash), nil
}

// RecoverSecp256k1ProofSignerFrom recovers an EcdsaSecp256k1RecoverySignature2020 signer, accepting
// the raw signing input or any of the typed forms the caller names. Each typed digest is tried, in
// order, only when every form before it recovered a signer `matches` refuses; if none matches, the
// raw signer is returned, so the caller's mismatch handling is unchanged. An error from the raw
// recovery is returned as it is, before any typed form is tried.
func RecoverSecp256k1ProofSignerFrom(hash HashResult, signature []byte, matches func(common.Address) bool, typed ...TypedProofDigest) (common.Address, error) {
	addr, err := RecoverSecp256k1Signer(hash.SigningInput, signature)
	if err != nil || matches(addr) {
		return addr, err
	}
	for _, digestOf := range typed {
		digest, digestErr := digestOf(hash.ProofHash, hash.DocHash)
		if digestErr != nil {
			continue
		}
		if typedAddr, recErr := RecoverSecp256k1Signer(digest, signature); recErr == nil && matches(typedAddr) {
			return typedAddr, nil
		}
	}
	return addr, nil
}
