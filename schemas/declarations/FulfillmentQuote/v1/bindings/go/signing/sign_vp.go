package ldverification

import (
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// SignVPOptions controls the proof fields a SignVP call writes onto the
// signed FulfillmentQuoteEnvelope. All fields are required: every one
// participates in canonicalization, and a wrong default would silently
// produce a signature no verifier reconstructs.
//
// Holder is the did:pkh URI of the entity presenting the credentials.
// MUST equal the recovered signer of the inner FulfillmentQuote — VerifyVP
// asserts this via VerifyVPOptions.ExpectedHolder. Sign-time consistency
// is the caller's responsibility (we don't have the FQ here to recover
// from).
//
// VerificationMethod is the full DID URL identifying the signing key,
// e.g. did:pkh:eip155:1:0x..#blockchainAccountId. The verifier uses this
// to bind the recovered address back to a chain-canonical identity.
//
// Challenge is the cross-auction replay binding — typically the bid's
// request_id. Domain is the cross-environment replay binding — typically
// the verifier's configured service identifier (e.g.
// did:web:settler.atum.network).
//
// Created is the proof.created timestamp. SignVP formats this from
// time.Time using the canonical "YYYY-MM-DDTHH:MM:SS.sssZ" shape.
// SignVPWithCreatedString accepts a verbatim string for callers that need
// a non-canonical form (cross-language conformance fixtures, negative
// tests). proofPurpose is hardcoded to "authentication" per W3C VC Data
// Model v1.1 §5.6 — distinct from the inner FQ's "assertionMethod".
type SignVPOptions struct {
	Holder             string
	VerificationMethod string
	Challenge          string
	Domain             string
	Created            time.Time

	// EnvelopeContextURL overrides the declaration context URL written
	// into the envelope's top-level @context and the proof block. Empty
	// uses the FulfillmentQuoteEnvelope URL (the default).
	// The PaymentRequestEnvelope (PRE) producer passes the PRE context
	// URL so the originator-side envelope carries its own declaration
	// context, mirroring the verify-side
	// VerifyVPOptions.ExtraEnvelopeContexts seam. The term definitions in
	// the two declaration contexts are byte-identical (they differ only
	// in the envelope-type term name, which doesn't participate in the
	// holder / verifiableCredential / proof n-quads), so the signature is
	// cross-verifiable as long as the verifier overlays the same URL.
	EnvelopeContextURL string

	// ExtraEnvelopeContexts overlays additional context URL → parsed-
	// content pairs onto the loader for the sign-time canonicalization.
	// REQUIRED when EnvelopeContextURL is a non-FQE URL fqLoader doesn't
	// know (e.g. the PRE URL) — without it canonicalization fails closed
	// at sign time. Nil for the default FQE path.
	ExtraEnvelopeContexts map[string]any

	// DeclarationType, when non-empty, is appended to the signed envelope's
	// top-level `type` array (e.g. "PaymentRequestEnvelope" →
	// type:["VerifiablePresentation","PaymentRequestEnvelope"]). The
	// declaration term is type-mapped in the declaration context
	// (atum:PaymentRequestEnvelope / atum:FulfillmentQuoteEnvelope, @type:@id),
	// so it emits an rdf:type n-quad and is therefore COVERED BY THE
	// SIGNATURE — binding the envelope kind into the proof. This
	// closes the PRE↔FQE interchangeability gap (without it the signed `type`
	// is always ["VerifiablePresentation"] and the only thing distinguishing
	// the two envelopes — the @context declaration term — never enters the
	// n-quads, so a PRE and an FQE with the same holder/challenge/domain/VCs
	// produce the SAME signature). Empty preserves the earlier wire
	// shape exactly (back-compat for unsigned-type verifiers + the FQE
	// producer until it adopts this). When set, the verifier MUST
	// overlay the matching declaration context (EnvelopeContextURL) or
	// canonicalization of the type term fails closed.
	DeclarationType string
}

// SignVP produces a W3C Data Integrity-signed FulfillmentQuoteEnvelope
// under the EcdsaSecp256k1RecoverySignature2020 cryptosuite. The vcs slice
// is the verifiableCredential array carried in the VP — each entry MUST
// be a fully-formed W3C VC (with its own @context, proof, etc.). VerifyVP
// runs policy checks (date window, issuer trust, required types) but does
// NOT cryptographically verify each VC's proof — that is a follow-up.
//
// Mirror of the TypeScript VP signer. The returned JSON is
// byte-equivalent to what the TypeScript signVP produces for the same
// inputs; the cross-language VP conformance suite pins that equivalence.
func SignVP(vcs []json.RawMessage, priv *ecdsa.PrivateKey, opts SignVPOptions) ([]byte, error) {
	createdStr := opts.Created.UTC().Format("2006-01-02T15:04:05.000Z07:00")
	return SignVPWithCreatedString(vcs, priv, opts, createdStr)
}

// SignVPWithCreatedString is SignVP with the proof.created field
// forwarded verbatim. Used by the conformance fixture generators to pin
// the timestamp string across languages so the ed25519 byte-identity
// invariant doesn't tip on offset-formatting differences.
//
// opts.Created is ignored — createdStr is the source of truth. It wraps the
// raw key as a Secp256k1Signer and delegates to the *WithSigner* core;
// output is byte-identical to signing with crypto.Sign directly.
func SignVPWithCreatedString(vcs []json.RawMessage, priv *ecdsa.PrivateKey, opts SignVPOptions, createdStr string) ([]byte, error) {
	signer, err := lddataintegrity.NewECDSASigner(priv)
	if err != nil {
		return nil, fmt.Errorf("SignVP: %w", err)
	}
	return SignVPWithSignerAndCreatedString(vcs, signer, opts, createdStr)
}

// SignVPWithSigner is SignVP backed by an abstract lddataintegrity.Secp256k1Signer
// instead of a raw *ecdsa.PrivateKey. Lets a caller sign the outer
// PaymentRequestEnvelope (and, by symmetry, any FQE) VP with a KMS-backed
// holder key without this shared lib importing a KMS SDK. Wrapping a raw
// key via lddataintegrity.NewECDSASigner produces byte-identical output to
// SignVP.
func SignVPWithSigner(vcs []json.RawMessage, signer lddataintegrity.Secp256k1Signer, opts SignVPOptions) ([]byte, error) {
	createdStr := opts.Created.UTC().Format("2006-01-02T15:04:05.000Z07:00")
	return SignVPWithSignerAndCreatedString(vcs, signer, opts, createdStr)
}

// SignVPWithSignerAndCreatedString is the core VP signer shared by the
// raw-key and KMS paths: it hashes the canonicalized VP body, asks the
// Secp256k1Signer for the 65-byte r||s||v (v∈{0,1}) signature, applies the
// +27 EIP-191 wire alignment exactly once, and assembles the proof.
// opts.Created is ignored — createdStr is the source of truth.
func SignVPWithSignerAndCreatedString(vcs []json.RawMessage, signer lddataintegrity.Secp256k1Signer, opts SignVPOptions, createdStr string) ([]byte, error) {
	return signVP(vcs, signer, opts, createdStr, func(hash HashResult) ([]byte, error) { return hash.SigningInput, nil })
}

// SignVPTypedWithSigner signs a PaymentRequestEnvelope's holder proof in the typed form a
// payer's wallet produces: the signature is over the EIP-712 digest of
// PaymentRequestEnvelopeProof{proofHash, docHash}
// (lddataintegrity.PaymentRequestEnvelopeProofTypedDigest) rather than over keccak256(proofHash
// || docHash). The proof options and the wire shape are the raw form's. VerifyVP accepts it under
// VerifyVPOptions.AcceptPaymentRequestEnvelopeTypedProof. Only a PaymentRequestEnvelope is signed
// this way, so opts.DeclarationType must name it.
func SignVPTypedWithSigner(vcs []json.RawMessage, signer lddataintegrity.Secp256k1Signer, opts SignVPOptions) ([]byte, error) {
	createdStr := opts.Created.UTC().Format("2006-01-02T15:04:05.000Z07:00")
	return SignVPTypedWithSignerAndCreatedString(vcs, signer, opts, createdStr)
}

// SignVPTypedWithSignerAndCreatedString is SignVPTypedWithSigner with proof.created forwarded
// verbatim (the conformance generator pins it). opts.Created is ignored.
func SignVPTypedWithSignerAndCreatedString(vcs []json.RawMessage, signer lddataintegrity.Secp256k1Signer, opts SignVPOptions, createdStr string) ([]byte, error) {
	if opts.DeclarationType != lddataintegrity.PaymentRequestEnvelopeType {
		return nil, fmt.Errorf("SignVP: the typed holder proof is a %s's; DeclarationType is %q",
			lddataintegrity.PaymentRequestEnvelopeType, opts.DeclarationType)
	}
	return signVP(vcs, signer, opts, createdStr, func(hash HashResult) ([]byte, error) {
		return lddataintegrity.PaymentRequestEnvelopeProofTypedDigest(hash.ProofHash, hash.DocHash)
	})
}

// signVP is the core both forms share; digestOf picks the 32-byte digest the signer signs from
// the envelope's hashes.
func signVP(vcs []json.RawMessage, signer lddataintegrity.Secp256k1Signer, opts SignVPOptions, createdStr string, digestOf func(HashResult) ([]byte, error)) ([]byte, error) {
	if signer == nil {
		return nil, errors.New("SignVP: nil signer")
	}
	if err := validateSignVPOptions(opts); err != nil {
		return nil, err
	}

	// The declaration context URL defaults to FQE; PRE producers
	// override it via EnvelopeContextURL + ExtraEnvelopeContexts so the
	// originator envelope carries its own declaration context.
	envCtxURL := opts.EnvelopeContextURL
	if envCtxURL == "" {
		envCtxURL = fulfillmentQuoteEnvelopeContextURL
	}

	vpBody, vcsAny, err := buildVPBody(vcs, opts, []any{
		w3cVCV1ContextURL,
		envCtxURL,
		secp256k1Recovery2020V2CtxURL,
	})
	if err != nil {
		return nil, err
	}

	hash, err := HashQuote(vpBody, HashQuoteOptions{
		Cryptosuite:              ProofTypeSecp256k1Recovery2020,
		KeepVerifiableCredential: true,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeSecp256k1Recovery2020,
			Created:            createdStr,
			VerificationMethod: opts.VerificationMethod,
			ProofPurpose:       expectedVPProofPurpose,
			Challenge:          opts.Challenge,
			Domain:             opts.Domain,
			// Multi-context proof block — this is load-bearing
			// (cryptosuite alone doesn't bind challenge /
			// domain; envelope context provides those terms).
			Context: []any{envCtxURL, secp256k1Recovery2020V2CtxURL},
		},
		// Overlay the declaration context (PRE) for the sign-time
		// canonicalization. Nil/empty extras → process-global
		// fqLoader (FQE-only default).
		Loader: loaderWithExtraEnvelopeContexts(opts.ExtraEnvelopeContexts),
	})
	if err != nil {
		return nil, fmt.Errorf("SignVP: hash: %w", err)
	}

	digest, err := digestOf(hash)
	if err != nil {
		return nil, fmt.Errorf("SignVP: digest: %w", err)
	}
	sig, err := signer.SignDigest(digest)
	if err != nil {
		return nil, fmt.Errorf("SignVP: SignDigest: %w", err)
	}
	if len(sig) != 65 {
		return nil, fmt.Errorf("SignVP: signer returned %d-byte signature, want 65 (r||s||v)", len(sig))
	}
	if sig[64] > 1 {
		// Contract: Secp256k1Signer returns v ∈ {0,1}. A larger v means the
		// signer already applied +27; double-adding would corrupt the
		// recovery id, so fail closed rather than emit an unverifiable proof.
		return nil, fmt.Errorf("SignVP: signer returned v=%d, want 0 or 1 (must not pre-apply +27)", sig[64])
	}
	// Align v with ethers.js / W3C secp256k1recovery: v ∈ {27,28}.
	sig[64] += 27

	jws, err := lddataintegrity.BuildSecp256k1JWS(sig)
	if err != nil {
		return nil, fmt.Errorf("SignVP: build JWS: %w", err)
	}

	signed := assembleSignedVP(vpBody, vcsAny, map[string]any{
		"type":               ProofTypeSecp256k1Recovery2020,
		"created":            createdStr,
		"verificationMethod": opts.VerificationMethod,
		"proofPurpose":       expectedVPProofPurpose,
		"challenge":          opts.Challenge,
		"domain":             opts.Domain,
		"jws":                jws,
	})

	out, err := json.Marshal(signed)
	if err != nil {
		return nil, fmt.Errorf("SignVP: marshal: %w", err)
	}
	return out, nil
}

// buildVPBody composes the canonical VP doc (sans proof) the signer feeds
// to HashQuote, AND the []any VC slice we'll re-emit in the signed
// wire format. Both shapes come out of the same parse so they can't drift.
//
// We accept []json.RawMessage on input so callers can pass VCs whose
// wire bytes are preserved verbatim through the signer (no re-marshal).
// json.RawMessage canonicalizes through json-gold via the []any pivot
// below — gold reads the raw bytes and unmarshals into a generic map for
// URDNA2015.
func buildVPBody(vcs []json.RawMessage, opts SignVPOptions, ctxArr []any) (map[string]any, []any, error) {
	if len(vcs) == 0 {
		return nil, nil, fmt.Errorf("SignVP: verifiableCredential slice is empty")
	}
	vcsAny := make([]any, 0, len(vcs))
	for i, raw := range vcs {
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, nil, fmt.Errorf("SignVP: parse verifiableCredential[%d]: %w", i, err)
		}
		vcsAny = append(vcsAny, v)
	}
	typeArr := []any{"VerifiablePresentation"}
	if opts.DeclarationType != "" {
		// Bind the envelope declaration kind into the signed type array so it
		// participates in URDNA2015 n-quads (the declaration term is
		// type-mapped in the declaration context). See SignVPOptions.DeclarationType.
		typeArr = append(typeArr, opts.DeclarationType)
	}
	body := map[string]any{
		"@context":             ctxArr,
		"type":                 typeArr,
		"holder":               opts.Holder,
		"verifiableCredential": vcsAny,
	}
	return body, vcsAny, nil
}

// assembleSignedVP stitches the canonical VP body and the proof block
// into the wire format. Field order in the input map is normalized by
// Go's json.Marshal (alphabetical) — same as the TS signer's
// sortKeysRecursively path — so the two language outputs can byte-diff
// for the deterministic ed25519 case.
func assembleSignedVP(vpBody map[string]any, vcsAny []any, proof map[string]any) map[string]any {
	signed := make(map[string]any)
	for k, v := range vpBody {
		signed[k] = v
	}
	signed["verifiableCredential"] = vcsAny
	signed["proof"] = proof
	return signed
}

func validateSignVPOptions(opts SignVPOptions) error {
	if opts.Holder == "" {
		return errors.New("SignVP: Holder required")
	}
	if opts.VerificationMethod == "" {
		return errors.New("SignVP: VerificationMethod required")
	}
	if opts.Challenge == "" {
		return errors.New("SignVP: Challenge required")
	}
	if opts.Domain == "" {
		return errors.New("SignVP: Domain required")
	}
	return nil
}
