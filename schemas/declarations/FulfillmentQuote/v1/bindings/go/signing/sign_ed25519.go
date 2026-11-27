package ldverification

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// SignEd25519Options is the ed25519 counterpart to SignOptions. The
// fields are identical in shape; the cryptosuite differs in how the
// signature is encoded onto proof.proofValue (multibase z-base58btc
// rather than a detached JWS).
type SignEd25519Options struct {
	VerificationMethod string
	ProofPurpose       string
	Created            time.Time
}

// SignEd25519 produces a W3C Data Integrity-signed FulfillmentQuote
// under the Ed25519Signature2020 cryptosuite. Same doc-strip and
// canonical-context-injection semantics as Sign; the wire format
// differs only in:
//   - proof.type is Ed25519Signature2020
//   - the signature is emitted as multibase-z-base58btc-encoded
//     proof.proofValue (not a detached JWS)
//   - SHA-256 (not keccak256) is the per-component hash, with raw
//     concatenation as the signing input
//
// Mirror of the TypeScript ed25519 signer.
func SignEd25519(doc map[string]any, priv ed25519.PrivateKey, opts SignEd25519Options) ([]byte, error) {
	createdStr := opts.Created.UTC().Format("2006-01-02T15:04:05.000Z07:00")
	return SignEd25519WithCreatedString(doc, priv, SignEd25519Options{
		VerificationMethod: opts.VerificationMethod,
		ProofPurpose:       opts.ProofPurpose,
	}, createdStr)
}

// SignEd25519WithCreatedString forwards proof.created verbatim. See the
// doc on SignWithCreatedString for the rawString-from-proof rationale.
func SignEd25519WithCreatedString(doc map[string]any, priv ed25519.PrivateKey, opts SignEd25519Options, createdStr string) ([]byte, error) {
	if len(priv) == 0 {
		return nil, errors.New("sign_ed25519: nil private key")
	}
	if err := validateSignOptions(opts.VerificationMethod, opts.ProofPurpose); err != nil {
		return nil, err
	}
	if err := rejectCallerSuppliedVC(doc); err != nil {
		return nil, err
	}

	docForHash := stripDocForHash(doc)
	docForHash["@context"] = []any{fulfillmentQuoteContextURL, ed25519Signature2020V1CtxURL}

	hash, err := HashQuote(docForHash, HashQuoteOptions{
		Cryptosuite: ProofTypeEd25519Signature2020,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeEd25519Signature2020,
			Created:            createdStr,
			VerificationMethod: opts.VerificationMethod,
			ProofPurpose:       opts.ProofPurpose,
			Context:            ed25519Signature2020V1CtxURL,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("sign_ed25519: hash: %w", err)
	}

	sig := ed25519.Sign(priv, hash.SigningInput)
	proofValue, err := lddataintegrity.EncodeEd25519ProofValue(sig)
	if err != nil {
		return nil, fmt.Errorf("sign_ed25519: encode proofValue: %w", err)
	}

	signed := assembleSignedQuote(docForHash, map[string]any{
		"type":               ProofTypeEd25519Signature2020,
		"created":            createdStr,
		"verificationMethod": opts.VerificationMethod,
		"proofPurpose":       opts.ProofPurpose,
		"proofValue":         proofValue,
	})

	out, err := json.Marshal(signed)
	if err != nil {
		return nil, fmt.Errorf("sign_ed25519: marshal: %w", err)
	}
	return out, nil
}
