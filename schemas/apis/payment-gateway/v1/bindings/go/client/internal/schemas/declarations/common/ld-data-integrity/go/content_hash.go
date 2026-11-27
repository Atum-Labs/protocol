package lddataintegrity

import (
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/ethereum/go-ethereum/crypto"
)

// contentHashCryptosuite is fixed so a declaration's content hash does not depend on which suite,
// if any, signs it. It selects only the DocHash digest (keccak256).
const contentHashCryptosuite = CryptosuiteSecp256k1Recovery2020

// ComputeContentHash returns "0x"+hex(keccak256(DocHash)) of doc under [contextURL, secp256k1recovery-2020/v2], the challenge a holder VP binds.
// doc must be a generic-map parse of the verbatim bytes with unmapped keys already rejected; it verifies no signature.
func ComputeContentHash(doc map[string]any, contextURL string, loader *DocumentLoader) (string, error) {
	if doc == nil {
		return "", errors.New("ComputeContentHash: nil document")
	}
	if contextURL == "" {
		return "", errors.New("ComputeContentHash: empty declaration context URL")
	}
	if loader == nil {
		return "", errors.New("ComputeContentHash: nil document loader")
	}

	// The wire @context is dropped so a non-canonical one cannot fork the hash.
	stripped := make(map[string]any, len(doc))
	for k, v := range doc {
		if k == "@context" {
			continue
		}
		stripped[k] = v
	}

	suiteCtx := Secp256k1Recovery2020V2CtxURL
	// Only DocHash is consumed; the placeholder proof options never reach the result.
	hash, err := HashDocument(stripped, HashOptions{
		Cryptosuite: contentHashCryptosuite,
		ProofOptions: ProofOptions{
			Type:               contentHashCryptosuite,
			Created:            "1970-01-01T00:00:00Z",
			VerificationMethod: "did:atum:content-hash#placeholder",
			ProofPurpose:       "assertionMethod",
			Context:            suiteCtx,
		},
		DefaultDocContext:         []any{contextURL, suiteCtx},
		StripVerifiableCredential: true,
	}, loader)
	if err != nil {
		return "", fmt.Errorf("ComputeContentHash: %w", err)
	}

	return "0x" + hex.EncodeToString(crypto.Keccak256(hash.DocHash)), nil
}
