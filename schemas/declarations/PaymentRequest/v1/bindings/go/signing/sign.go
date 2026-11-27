package ldverification

import (
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// SignOptions controls the proof fields a SignPaymentRequest call writes
// onto the signed PaymentRequest. All fields are required — there is no
// "guess a default" path because every field except Created participates
// in canonicalization and a wrong default would silently produce a
// signature no verifier reconstructs.
//
// VerificationMethod is the W3C `proof.verificationMethod` value. For
// secp256k1-recovery this is
// `did:pkh:eip155:<chainID>:<address>#blockchainAccountId` in EVM-style.
// The verifier uses this to bind the recovered address back to a
// chain-canonical identity, so callers MUST construct it from the same
// key the priv argument represents.
//
// ProofPurpose is W3C-defined; the verifier rejects anything other than
// "assertionMethod" (see expectedProofPurpose in verify.go).
// SignPaymentRequest refuses other values up-front so the wire format
// never carries an unverifiable proof block.
//
// Created is the proof.created timestamp. The wire format is
// "YYYY-MM-DDTHH:MM:SS.sssZ" (millisecond UTC); SignPaymentRequest
// formats this from the time.Time the caller supplies. Callers that need
// a non-canonical form (e.g. an explicit `+00:00` offset, used in some
// negative tests) should use SignPaymentRequestWithCreatedString.
type SignOptions struct {
	VerificationMethod string
	ProofPurpose       string
	Created            time.Time
}

// SignPaymentRequest produces a W3C Data Integrity-signed PaymentRequest
// under the EcdsaSecp256k1RecoverySignature2020 cryptosuite. The doc map
// is the PaymentRequest payload without an `@context` or `proof` block —
// SignPaymentRequest injects the canonical context array and the proof.
// Any pre-existing `@context` or `proof` on doc is overwritten so a
// re-sign of an already-signed request produces a fresh proof rather
// than a doubly-wrapped envelope.
//
// The returned JSON is byte-equivalent to what the TypeScript
// signPaymentRequest produces for the same inputs; that equivalence is
// exercised by the cross-language conformance suite.
//
// Mirror of the FulfillmentQuote Sign and the TS signPaymentRequest.
func SignPaymentRequest(doc map[string]any, priv *ecdsa.PrivateKey, opts SignOptions) ([]byte, error) {
	createdStr := opts.Created.UTC().Format("2006-01-02T15:04:05.000Z07:00")
	return SignPaymentRequestWithCreatedString(doc, priv, SignOptions{
		VerificationMethod: opts.VerificationMethod,
		ProofPurpose:       opts.ProofPurpose,
	}, createdStr)
}

// SignPaymentRequestWithCreatedString is SignPaymentRequest with the
// proof.created field forwarded verbatim. Used by the conformance
// generator (to pin a deterministic timestamp byte-equal with the TS
// Date.toISOString() output) and by tests that drive non-canonical
// timestamp shapes (e.g. `+00:00` offset, sub-millisecond precision) to
// verify the rawString-from-proof policy holds; production callers
// should use SignPaymentRequest.
//
// opts.Created is ignored — createdStr is the source of truth. It wraps the
// raw key as a Secp256k1Signer and delegates to the *WithSigner* core; the
// wire output is byte-identical to signing with crypto.Sign directly.
func SignPaymentRequestWithCreatedString(doc map[string]any, priv *ecdsa.PrivateKey, opts SignOptions, createdStr string) ([]byte, error) {
	signer, err := lddataintegrity.NewECDSASigner(priv)
	if err != nil {
		return nil, fmt.Errorf("sign: %w", err)
	}
	return SignPaymentRequestWithSignerAndCreatedString(doc, signer, opts, createdStr)
}

// SignPaymentRequestWithSigner is SignPaymentRequest backed by an abstract
// lddataintegrity.Secp256k1Signer instead of a raw *ecdsa.PrivateKey. It lets
// a caller sign the inner PaymentRequest with a KMS-backed holder key without
// this shared lib importing any KMS SDK. Wrapping a raw key via
// lddataintegrity.NewECDSASigner produces byte-identical output to
// SignPaymentRequest.
func SignPaymentRequestWithSigner(doc map[string]any, signer lddataintegrity.Secp256k1Signer, opts SignOptions) ([]byte, error) {
	createdStr := opts.Created.UTC().Format("2006-01-02T15:04:05.000Z07:00")
	return SignPaymentRequestWithSignerAndCreatedString(doc, signer, SignOptions{
		VerificationMethod: opts.VerificationMethod,
		ProofPurpose:       opts.ProofPurpose,
	}, createdStr)
}

// SignPaymentRequestWithSignerAndCreatedString is the core signer shared by
// the raw-key and KMS paths: it hashes the canonicalized doc, asks the
// Secp256k1Signer for the 65-byte r||s||v (v∈{0,1}) signature, applies the
// +27 EIP-191 wire alignment exactly once, and assembles the proof.
// opts.Created is ignored — createdStr is the source of truth.
func SignPaymentRequestWithSignerAndCreatedString(doc map[string]any, signer lddataintegrity.Secp256k1Signer, opts SignOptions, createdStr string) ([]byte, error) {
	return signPaymentRequest(doc, signer, opts, createdStr, rawSigningInput)
}

// SignPaymentRequestTypedWithSigner signs the inner PaymentRequest in the typed form a wallet
// produces: the signature is over the EIP-712 digest of PaymentRequestProof{proofHash, docHash}
// (lddataintegrity.PaymentRequestProofTypedDigest) rather than over keccak256(proofHash ||
// docHash). Everything else, the proof options and the wire shape included, is the raw form's.
// Only VerifyPaymentRequestWithOptions with VerifyOptions.AcceptPaymentRequestTypedProof accepts
// it. Without it, `VerifyPaymentRequest` recovers an address other than the signer, with no error,
// so the caller's signer check is what refuses it. A wallet's eth_signTypedData_v4 over the same
// typed data yields the same signature, which is what lets a payer sign with the wallet it pays
// from.
func SignPaymentRequestTypedWithSigner(doc map[string]any, signer lddataintegrity.Secp256k1Signer, opts SignOptions) ([]byte, error) {
	createdStr := opts.Created.UTC().Format("2006-01-02T15:04:05.000Z07:00")
	return SignPaymentRequestTypedWithSignerAndCreatedString(doc, signer, SignOptions{
		VerificationMethod: opts.VerificationMethod,
		ProofPurpose:       opts.ProofPurpose,
	}, createdStr)
}

// SignPaymentRequestTypedWithSignerAndCreatedString is SignPaymentRequestTypedWithSigner with
// proof.created forwarded verbatim (the conformance generator pins it). opts.Created is ignored.
func SignPaymentRequestTypedWithSignerAndCreatedString(doc map[string]any, signer lddataintegrity.Secp256k1Signer, opts SignOptions, createdStr string) ([]byte, error) {
	return signPaymentRequest(doc, signer, opts, createdStr, func(hash HashResult) ([]byte, error) {
		return lddataintegrity.PaymentRequestProofTypedDigest(hash.ProofHash, hash.DocHash)
	})
}

// rawSigningInput is the digest the raw form signs: keccak256(proofHash || docHash).
func rawSigningInput(hash HashResult) ([]byte, error) { return hash.SigningInput, nil }

// signPaymentRequest is the core both forms share; digestOf picks the 32-byte digest the signer
// signs from the document's hashes.
func signPaymentRequest(doc map[string]any, signer lddataintegrity.Secp256k1Signer, opts SignOptions, createdStr string, digestOf func(HashResult) ([]byte, error)) ([]byte, error) {
	if signer == nil {
		return nil, errors.New("sign: nil signer")
	}
	if err := validateSignOptions(opts.VerificationMethod, opts.ProofPurpose); err != nil {
		return nil, err
	}

	// Build the doc with the canonical @context array. The caller-supplied
	// doc may carry its own @context; we replace it deterministically so
	// the signing input is reconstructable on the verifier side without
	// re-deriving the context list from the cryptosuite.
	docForHash := stripDocForHash(doc)
	docForHash["@context"] = []any{paymentRequestContextURL, secp256k1Recovery2020V2CtxURL}

	hash, err := HashPaymentRequest(docForHash, HashPaymentRequestOptions{
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

	digest, err := digestOf(hash)
	if err != nil {
		return nil, fmt.Errorf("sign: digest: %w", err)
	}
	sig, err := signer.SignDigest(digest)
	if err != nil {
		return nil, fmt.Errorf("sign: SignDigest: %w", err)
	}
	if len(sig) != 65 {
		return nil, fmt.Errorf("sign: signer returned %d-byte signature, want 65 (r||s||v)", len(sig))
	}
	if sig[64] > 1 {
		// Contract: Secp256k1Signer returns v ∈ {0,1}. A larger v means the
		// signer already applied the +27 alignment; double-adding would
		// corrupt the recovery id, so fail closed rather than emit it.
		return nil, fmt.Errorf("sign: signer returned v=%d, want 0 or 1 (must not pre-apply +27)", sig[64])
	}
	// Align v with ethers.js / W3C secp256k1recovery: v ∈ {27,28}.
	// The Secp256k1Signer contract returns v ∈ {0,1}; the verifier expects
	// the W3C form. (The lib's RecoverSecp256k1Signer accepts either, but the
	// wire format we emit pins to the EIP-191 convention for ecosystem
	// compatibility — JS/ethers and the cross-language conformance fixtures
	// both assume v >= 27.)
	sig[64] += 27

	jws, err := lddataintegrity.BuildSecp256k1JWS(sig)
	if err != nil {
		return nil, fmt.Errorf("sign: build JWS: %w", err)
	}

	signed := assembleSignedRequest(docForHash, map[string]any{
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

// stripDocForHash returns a copy of doc with the signing artifacts (proof,
// @context) and ALL credential carriers (verifiableCredential, presentation,
// originator_auth, and the nested sender_auth.verifiable_credential) removed.
// The verify path (documentForCanonicalization) strips the identical set;
// matching it keeps the hashed n-quads byte-identical across signer and
// verifier even when callers pass a pre-shaped envelope. Does NOT mutate doc.
//
// Credentials are stripped because the holder-signed
// PaymentRequestEnvelope (PRE) is the SOLE carrier of credentials — the inner
// PaymentRequest signature must cover the payment, never a VC. The inner
// credential fields are deprecated (schema.json). Two reasons this strip is
// load-bearing, not cosmetic:
//   - presentation: the producer splices the PRE into the PaymentRequest's
//     presentation field AFTER the inner proof is computed; the signed n-quads
//     must never include it (the term is bound @type:@id).
//   - originator_auth / sender_auth.verifiable_credential: these carry a
//     nested VC whose own @context (W3C VC v1 / known-to-atum, @protected)
//     would otherwise collide with the @protected PaymentRequest context
//     during URDNA2015 canonicalization ("protected term redefinition") and
//     abort signing — exactly the nested-VC failure. Removing the
//     credential removes the collision (and is what the directive requires).
func stripDocForHash(doc map[string]any) map[string]any {
	out := make(map[string]any, len(doc))
	for k, v := range doc {
		switch k {
		// proof + @context are signing artifacts. verifiableCredential,
		// presentation, and originator_auth are CREDENTIAL carriers:
		// the inner PaymentRequest signature MUST NOT cover any
		// credential material — credentials live ONLY in the holder-signed
		// PaymentRequestEnvelope (PRE). These inner credential fields are
		// deprecated (schema.json) and excluded from the signed n-quads so a
		// nested VC's @context (W3C/known-to-atum) can't collide with the
		// @protected PaymentRequest context during URDNA2015 canonicalization.
		case "proof", "@context", "verifiableCredential", "presentation", "originator_auth":
			continue
		}
		out[k] = v
	}
	// sender_auth carries the EVM_PERMIT2 transfer authorization (signed,
	// load-bearing) but MAY also carry a deprecated verifiable_credential
	// subfield — strip only that nested credential, keeping the authorization.
	if sa, ok := out["sender_auth"]; ok {
		out["sender_auth"] = stripNestedVerifiableCredential(sa)
	}
	return out
}

// stripNestedVerifiableCredential returns v with a top-level
// "verifiable_credential" key removed when v is a JSON object that has one,
// WITHOUT mutating the input (returns the original when there's nothing to
// strip). Used to keep credential material out of the inner PaymentRequest
// signature while preserving the rest of a carrier field (e.g. sender_auth's
// transfer authorization). The verify side applies the identical strip so
// canonicalization stays symmetric.
func stripNestedVerifiableCredential(v any) any {
	m, ok := v.(map[string]any)
	if !ok {
		return v
	}
	if _, has := m["verifiable_credential"]; !has {
		return v
	}
	cp := make(map[string]any, len(m))
	for k, vv := range m {
		if k == "verifiable_credential" {
			continue
		}
		cp[k] = vv
	}
	return cp
}

// assembleSignedRequest stitches the (stripped) doc fields and the proof
// block into the wire format. Field order is irrelevant — json.Marshal
// sorts map keys alphabetically, which is exactly what the TS conformance
// generator's sortKeysRecursively reproduces, so a byte-level diff against
// a TS fixture is meaningful.
//
// Unlike FQ's assembleSignedQuote, NO empty verifiableCredential[] is
// injected: PaymentRequest is an assertion document, not a VP, and its
// @context does not carry the credential-bag semantics the FQ wire form
// reserves that field for.
func assembleSignedRequest(stripped map[string]any, proof map[string]any) map[string]any {
	// Capacity hint only — a map's size argument is advisory and Go grows it
	// automatically, so we pass len(stripped) (a floor; the proof key added
	// below makes the real count len+1) rather than len(stripped)+1. The
	// arithmetic form trips CodeQL go/allocation-size-overflow; the hint being
	// off by one is irrelevant for a map.
	signed := make(map[string]any, len(stripped))
	for k, v := range stripped {
		signed[k] = v
	}
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
		// assertionMethod would be rejected by VerifyPaymentRequest
		// anyway; rejecting here keeps the bad wire form from ever
		// existing.
		return fmt.Errorf("sign: proofPurpose %q not allowed (only %q)", proofPurpose, expectedProofPurpose)
	}
	return nil
}
