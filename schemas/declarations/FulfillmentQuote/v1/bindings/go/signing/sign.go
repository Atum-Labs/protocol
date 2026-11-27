package ldverification

import (
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/crypto"
)

// SignOptions controls the proof fields a Sign call writes onto the
// signed FulfillmentQuote. All fields are required — there is no
// "guess a default" path because every field except Created participates
// in canonicalization and a wrong default would silently produce a
// signature no verifier reconstructs.
//
// VerificationMethod is the W3C `proof.verificationMethod` value. For
// secp256k1-recovery this is `did:pkh:eip155:<chainID>:<address>#blockchainAccountId`
// in EVM-style; for Tron it's the address-as-derived form. The verifier
// uses this to bind the recovered address back to a chain-canonical
// identity, so callers MUST construct it from the same key the priv
// argument represents.
//
// ProofPurpose is W3C-defined; the verifier rejects anything other than
// "assertionMethod" (see expectedProofPurpose in verify.go). Sign refuses
// other values up-front so the wire format never carries an unverifiable
// proof block.
//
// Created is the proof.created timestamp. The wire format is
// "YYYY-MM-DDTHH:MM:SS.sssZ" (millisecond UTC); Sign formats this from
// the time.Time the caller supplies. Callers that need a non-canonical
// form (e.g. an explicit `+00:00` offset, used in some negative tests)
// should use SignWithCreatedString.
type SignOptions struct {
	VerificationMethod string
	ProofPurpose       string
	Created            time.Time
}

// Sign produces a W3C Data Integrity-signed FulfillmentQuote under the
// EcdsaSecp256k1RecoverySignature2020 cryptosuite. The doc map is the
// quote payload without an `@context` or `proof` block — Sign injects
// the canonical context array and the proof. Any pre-existing `@context`
// or `proof` on doc is overwritten so a re-sign of an already-signed
// quote produces a fresh proof rather than a doubly-wrapped envelope.
//
// The returned JSON is byte-equivalent to what the TypeScript signQuote
// produces for the same inputs; that equivalence is exercised by the
// cross-language conformance suite.
//
// Mirror of the TypeScript signer.
func Sign(doc map[string]any, priv *ecdsa.PrivateKey, opts SignOptions) ([]byte, error) {
	createdStr := opts.Created.UTC().Format("2006-01-02T15:04:05.000Z07:00")
	return SignWithCreatedString(doc, priv, SignOptions{
		VerificationMethod: opts.VerificationMethod,
		ProofPurpose:       opts.ProofPurpose,
	}, createdStr)
}

// SignWithCreatedString is Sign with the proof.created field forwarded
// verbatim. Used by tests that drive non-canonical timestamp shapes
// (e.g. `+00:00` offset, sub-millisecond precision) to verify the
// rawString-from-proof policy holds; production callers should use Sign.
//
// opts.Created is ignored — createdStr is the source of truth.
func SignWithCreatedString(doc map[string]any, priv *ecdsa.PrivateKey, opts SignOptions, createdStr string) ([]byte, error) {
	if priv == nil {
		return nil, errors.New("sign: nil private key")
	}
	if err := validateSignOptions(opts.VerificationMethod, opts.ProofPurpose); err != nil {
		return nil, err
	}
	if err := rejectCallerSuppliedVC(doc); err != nil {
		return nil, err
	}

	// Build the doc with the canonical @context array. The caller-supplied
	// doc may carry its own @context; we replace it deterministically so
	// the signing input is reconstructable on the verifier side without
	// re-deriving the context list from the cryptosuite.
	docForHash := stripDocForHash(doc)
	docForHash["@context"] = []any{fulfillmentQuoteContextURL, secp256k1Recovery2020V2CtxURL}

	hash, err := HashQuote(docForHash, HashQuoteOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeSecp256k1Recovery2020,
			Created:            createdStr,
			VerificationMethod: opts.VerificationMethod,
			ProofPurpose:       opts.ProofPurpose,
			Context:            secp256k1Recovery2020V2CtxURL,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("sign: hash: %w", err)
	}

	sig, err := crypto.Sign(hash.SigningInput, priv)
	if err != nil {
		return nil, fmt.Errorf("sign: crypto.Sign: %w", err)
	}
	// Align v with ethers.js / W3C secp256k1recovery: v ∈ {27,28}.
	// go-ethereum returns v ∈ {0,1}; the verifier expects the W3C form.
	// (The lib's RecoverSecp256k1Signer accepts either, but the wire
	// format we emit pins to the EIP-191 convention for ecosystem
	// compatibility — JS/ethers and the cross-language conformance
	// fixtures both assume v >= 27.)
	sig[64] += 27

	jws, err := lddataintegrity.BuildSecp256k1JWS(sig)
	if err != nil {
		return nil, fmt.Errorf("sign: build JWS: %w", err)
	}

	signed := assembleSignedQuote(docForHash, map[string]any{
		"type":               ProofTypeSecp256k1Recovery2020,
		"created":            createdStr,
		"verificationMethod": opts.VerificationMethod,
		"proofPurpose":       opts.ProofPurpose,
		"jws":                jws,
	})

	out, err := json.Marshal(signed)
	if err != nil {
		return nil, fmt.Errorf("sign: marshal: %w", err)
	}
	return out, nil
}

// rejectCallerSuppliedVC fails when a caller passes a non-empty
// verifiableCredential to the base signer. The base signer covers quote
// terms only, so a VC here would never be signed. Failing loud stops it
// from being silently discarded. An absent or empty verifiableCredential
// is accepted, matching the empty slot the wire form reserves. Callers
// carrying credentials must use the VP signer.
func rejectCallerSuppliedVC(doc map[string]any) error {
	v, ok := doc["verifiableCredential"]
	if !ok {
		return nil
	}
	if list, isList := v.([]any); isList && len(list) == 0 {
		return nil
	}
	return errors.New("sign: base signer does not carry verifiableCredential, use the VP signer for credentials")
}

// stripDocForHash returns a copy of doc with proof, verifiableCredential,
// and @context removed. The verify path applies the same defensive strip;
// matching it in Sign keeps the hashed n-quads byte-identical across
// signer and verifier even when callers pass a pre-shaped envelope.
func stripDocForHash(doc map[string]any) map[string]any {
	out := make(map[string]any, len(doc))
	for k, v := range doc {
		switch k {
		case "proof", "verifiableCredential", "@context":
			continue
		}
		out[k] = v
	}
	return out
}

// assembleSignedQuote stitches the (stripped) doc fields, an empty
// verifiableCredential list, and the proof block into the wire format.
// Field order matches what the TS signer emits so a byte-level diff
// against a TS fixture is meaningful.
//
// The empty verifiableCredential is the canonical wire slot the FQ form
// reserves. The base signer covers quote terms only, so a non-empty
// caller-supplied VC is rejected up front by rejectCallerSuppliedVC rather
// than silently dropped. Credentials belong at the VP or envelope layer.
func assembleSignedQuote(stripped map[string]any, proof map[string]any) map[string]any {
	signed := make(map[string]any, len(stripped)+2)
	for k, v := range stripped {
		signed[k] = v
	}
	signed["verifiableCredential"] = []any{}
	signed["proof"] = proof
	return signed
}

func validateSignOptions(verificationMethod, proofPurpose string) error {
	if verificationMethod == "" {
		return errors.New("sign: verificationMethod required")
	}
	if proofPurpose == "" {
		return errors.New("sign: proofPurpose required")
	}
	if proofPurpose != expectedProofPurpose {
		// Fail closed at sign time. A proof.proofPurpose other than
		// assertionMethod would be rejected by Verify anyway; rejecting
		// here keeps the bad wire form from ever existing.
		return fmt.Errorf("sign: proofPurpose %q not allowed (only %q)", proofPurpose, expectedProofPurpose)
	}
	return nil
}
