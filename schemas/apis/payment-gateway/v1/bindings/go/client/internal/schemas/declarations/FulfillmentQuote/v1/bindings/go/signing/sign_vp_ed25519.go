package ldverification

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	lddataintegrity "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/common/ld-data-integrity/go"
)

// SignVPEd25519Options is the Ed25519Signature2020 counterpart of
// SignVPOptions. Same field semantics — see SignVPOptions doc — except
// VerificationMethod takes a did:pkh:solana:<network>:<base58pubkey>
// shape (VerifyVP rejects other namespaces on the ed25519 path).
type SignVPEd25519Options struct {
	Holder             string
	VerificationMethod string
	Challenge          string
	Domain             string
	Created            time.Time

	// EnvelopeContextURL / ExtraEnvelopeContexts — declaration-context
	// override, identical semantics to SignVPOptions' same-named fields
	// (see there). Empty URL → FQE.
	EnvelopeContextURL    string
	ExtraEnvelopeContexts map[string]any

	// DeclarationType — declaration-type binding, identical semantics
	// to SignVPOptions.DeclarationType (see there). Empty keeps the
	// earlier ["VerifiablePresentation"] type array. A Solana
	// (ed25519) PRE producer MUST set "PaymentRequestEnvelope" or the
	// type-asserting PRE perimeters reject it.
	DeclarationType string

	// TextProof signs lddataintegrity.Ed25519ProofMessage(SigningInput)
	// instead of the raw SigningInput. VerifyVP accepts both.
	TextProof bool
}

// SignVPEd25519 produces a W3C Data Integrity-signed FulfillmentQuoteEnvelope
// under the Ed25519Signature2020 cryptosuite. RFC 8032 deterministic; for
// the same inputs Go and TS produce byte-identical signatures (pinned by
// the cross-language VP conformance suite).
//
// priv MUST be a 64-byte ed25519.PrivateKey (the expanded "secret key"
// form, matching nacl.sign.keyPair.fromSeed's secretKey output on the TS
// side). The 32-byte seed form is rejected to keep the contract crisp —
// callers should construct via ed25519.NewKeyFromSeed.
//
// Mirror of the TypeScript ed25519 VP signer.
func SignVPEd25519(vcs []json.RawMessage, priv ed25519.PrivateKey, opts SignVPEd25519Options) ([]byte, error) {
	createdStr := opts.Created.UTC().Format("2006-01-02T15:04:05.000Z07:00")
	return SignVPEd25519WithCreatedString(vcs, priv, opts, createdStr)
}

// SignVPEd25519WithCreatedString is SignVPEd25519 with the proof.created
// field forwarded verbatim — see SignVPWithCreatedString.
func SignVPEd25519WithCreatedString(vcs []json.RawMessage, priv ed25519.PrivateKey, opts SignVPEd25519Options, createdStr string) ([]byte, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("SignVPEd25519: priv must be %d bytes (got %d)", ed25519.PrivateKeySize, len(priv))
	}
	if err := validateSignVPEd25519Options(opts); err != nil {
		return nil, err
	}

	envCtxURL := opts.EnvelopeContextURL
	if envCtxURL == "" {
		envCtxURL = fulfillmentQuoteEnvelopeContextURL
	}

	vpBody, vcsAny, err := buildVPBody(vcs, SignVPOptions{
		Holder:             opts.Holder,
		VerificationMethod: opts.VerificationMethod,
		Challenge:          opts.Challenge,
		Domain:             opts.Domain,
		DeclarationType:    opts.DeclarationType,
	}, []any{
		w3cVCV1ContextURL,
		envCtxURL,
		ed25519Signature2020V1CtxURL,
	})
	if err != nil {
		return nil, err
	}

	hash, err := HashQuote(vpBody, HashQuoteOptions{
		Cryptosuite:              ProofTypeEd25519Signature2020,
		KeepVerifiableCredential: true,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeEd25519Signature2020,
			Created:            createdStr,
			VerificationMethod: opts.VerificationMethod,
			ProofPurpose:       expectedVPProofPurpose,
			Challenge:          opts.Challenge,
			Domain:             opts.Domain,
			Context:            []any{envCtxURL, ed25519Signature2020V1CtxURL},
		},
		// Overlay the declaration context (PRE) for sign-time
		// canonicalization.
		Loader: loaderWithExtraEnvelopeContexts(opts.ExtraEnvelopeContexts),
	})
	if err != nil {
		return nil, fmt.Errorf("SignVPEd25519: hash: %w", err)
	}

	msg := hash.SigningInput
	if opts.TextProof {
		if msg, err = lddataintegrity.Ed25519ProofMessage(hash.SigningInput); err != nil {
			return nil, fmt.Errorf("SignVPEd25519: proof message: %w", err)
		}
	}
	sig := ed25519.Sign(priv, msg)
	proofValue, err := lddataintegrity.EncodeEd25519ProofValue(sig)
	if err != nil {
		return nil, fmt.Errorf("SignVPEd25519: encode proofValue: %w", err)
	}

	signed := assembleSignedVP(vpBody, vcsAny, map[string]any{
		"type":               ProofTypeEd25519Signature2020,
		"created":            createdStr,
		"verificationMethod": opts.VerificationMethod,
		"proofPurpose":       expectedVPProofPurpose,
		"challenge":          opts.Challenge,
		"domain":             opts.Domain,
		"proofValue":         proofValue,
	})

	out, err := json.Marshal(signed)
	if err != nil {
		return nil, fmt.Errorf("SignVPEd25519: marshal: %w", err)
	}
	return out, nil
}

func validateSignVPEd25519Options(opts SignVPEd25519Options) error {
	if opts.Holder == "" {
		return errors.New("SignVPEd25519: Holder required")
	}
	if opts.VerificationMethod == "" {
		return errors.New("SignVPEd25519: VerificationMethod required")
	}
	if opts.Challenge == "" {
		return errors.New("SignVPEd25519: Challenge required")
	}
	if opts.Domain == "" {
		return errors.New("SignVPEd25519: Domain required")
	}
	return nil
}
