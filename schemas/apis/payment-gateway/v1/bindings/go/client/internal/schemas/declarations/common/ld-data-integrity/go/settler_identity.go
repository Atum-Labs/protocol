package lddataintegrity

import (
	"fmt"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// Settler identity EIP-712 domain. It carries no chainId, so the digest is identical on EVM
// and Tron. The verifying contract is a sentinel with no code: the last 20 bytes of
// keccak256("atum.settler.identity.v1").
const (
	SettlerIdentityDomainName        = "Atum Settler Identity"
	SettlerIdentityDomainVersion     = "1"
	SettlerIdentityVerifyingContract = "0x1238944D14f50709Cc27101B2746fDeFCE08B37e"

	SettlerProofPrimaryType = "SettlerProof"
	WalletProofPrimaryType  = "WalletProof"
)

var (
	eip712DomainTypeHash = crypto.Keccak256([]byte("EIP712Domain(string name,string version,address verifyingContract)"))
	settlerProofTypeHash = crypto.Keccak256([]byte("SettlerProof(bytes32 proofHash,bytes32 docHash)"))
	walletProofTypeHash  = crypto.Keccak256([]byte("WalletProof(bytes32 digest)"))

	settlerIdentityDomainSeparator = crypto.Keccak256(
		eip712DomainTypeHash,
		crypto.Keccak256([]byte(SettlerIdentityDomainName)),
		crypto.Keccak256([]byte(SettlerIdentityDomainVersion)),
		common.LeftPadBytes(common.HexToAddress(SettlerIdentityVerifyingContract).Bytes(), 32),
	)
)

// SettlerIdentityDomainSeparator returns the EIP-712 domain separator of the settler identity domain.
func SettlerIdentityDomainSeparator() []byte {
	return common.CopyBytes(settlerIdentityDomainSeparator)
}

// SettlerProofTypedDigest returns the EIP-712 digest of SettlerProof{proofHash, docHash} under
// the settler identity domain. Both inputs are the 32-byte hashes HashDocument returns.
func SettlerProofTypedDigest(proofHash, docHash []byte) ([]byte, error) {
	if len(proofHash) != 32 || len(docHash) != 32 {
		return nil, fmt.Errorf("%w: SettlerProof hashes must be 32 bytes, got proofHash=%d docHash=%d",
			ErrMalformedProof, len(proofHash), len(docHash))
	}
	return identityTypedDigest(crypto.Keccak256(settlerProofTypeHash, proofHash, docHash)), nil
}

// WalletProofTypedDigest returns the EIP-712 digest of WalletProof{digest} under the settler
// identity domain, for the settler to gateway handshake wallet proof.
func WalletProofTypedDigest(digest []byte) ([]byte, error) {
	if len(digest) != 32 {
		return nil, fmt.Errorf("%w: WalletProof digest must be 32 bytes, got %d", ErrMalformedProof, len(digest))
	}
	return identityTypedDigest(crypto.Keccak256(walletProofTypeHash, digest)), nil
}

func identityTypedDigest(structHash []byte) []byte {
	return crypto.Keccak256([]byte{0x19, 0x01}, settlerIdentityDomainSeparator, structHash)
}

// RecoverSecp256k1ProofSigner recovers an EcdsaSecp256k1RecoverySignature2020 signer, accepting
// either the legacy digest (hash.SigningInput) or the SettlerProof typed digest. The typed digest
// is tried only when the legacy signer fails `matches`; if neither matches, the legacy result is
// returned so the caller's mismatch handling is unchanged.
func RecoverSecp256k1ProofSigner(hash HashResult, signature []byte, matches func(common.Address) bool) (common.Address, error) {
	return RecoverSecp256k1ProofSignerFrom(hash, signature, matches, SettlerProofTypedDigest)
}
