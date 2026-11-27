package ldverification

// Tests for VerifyVCProof. Coverage:
//   - Happy path: signed VC verifies against a mock resolver.
//   - Tampered proof.jws rejects with ErrVPVCSignatureInvalid.
//   - Tampered credential body rejects with ErrVPVCSignatureInvalid
//     (canonicalization changes the signing input).
//   - Resolver returns error → ErrVPVCIssuerUnresolvable.
//   - Resolver returns empty set → ErrVPVCIssuerUnresolvable.
//   - Resolver returns set without the proof's verificationMethod →
//     ErrVPVCIssuerKeyMismatch.
//   - Resolver returns a VM matching the URL but with a DIFFERENT
//     public key → ErrVPVCSignatureInvalid (the recovery succeeds
//     against the signer's actual key, doesn't match the claimed key).
//   - proof.type unrecognised → ErrVPVCUnsupportedProofType.
//   - VerificationMethod.Type unrecognised → ErrVPVCUnsupportedProofType.
//   - Ed25519Signature2020 happy path + signature-rejection + tampered-
//     proofValue + wrong-issuer-key.
//   - Nil resolver → ErrMalformedQuote (defensive — callers wire nil
//     through VerifyVPOptions.VerifyVCProofs to opt out; VerifyVCProof
//     itself rejects to surface mis-wiring).
//
// Cross-cutting fixture: every test mints a fresh secp256k1 issuer
// key + a VC the issuer signs end-to-end using the same primitives
// the production issuer does. The mock resolver returns the issuer's
// pubkey as a JsonWebKey2020 JWK, mirroring the DID document shape
// the issuer publishes.

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	fqe "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuoteEnvelope/v1/bindings/go/generated"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/mr-tron/base58"
)

// mockResolver is the test-side IssuerKeyResolver. Returns a pinned
// VerificationMethodSet for a configured issuer DID; any other DID
// returns mockResolverErr. Tests can also set forceEmpty=true to
// pin the empty-set rejection path.
type mockResolver struct {
	issuerDID  string
	vmSet      VerificationMethodSet
	forceEmpty bool
	forceErr   error
}

func (m *mockResolver) Resolve(_ context.Context, issuerDID string) (VerificationMethodSet, error) {
	if m.forceErr != nil {
		return nil, m.forceErr
	}
	if m.forceEmpty {
		return nil, nil
	}
	if issuerDID != m.issuerDID {
		return nil, errors.New("mockResolver: unknown issuer")
	}
	return m.vmSet, nil
}

// signedVCFixture mints a VC signed by the supplied issuer key.
// Returns the typed VC, the raw wire bytes (canonical input for
// VerifyVCProof), and the verificationMethod URL the resolver
// should advertise. The raw bytes are the marshal-source-of-truth
// that the production path passes from VerifyVP's `rawVCs` slice
// (preserved verbatim from the wire envelope).
func signedVCFixture(t *testing.T, issuerPriv *ecdsa.PrivateKey, issuerDID string) (fqe.VerifiableCredential, json.RawMessage, string) {
	t.Helper()
	vmURL := issuerDID + "#issuer-key-1"
	createdStr := "2026-01-01T00:00:00Z"
	suiteCtx := secp256k1Recovery2020V2CtxURL

	// VC body (no proof yet). Matches the production issuer's shape
	// minus the actual signing step.
	vcBody := map[string]any{
		"@context": []any{
			w3cVCV1ContextURL,
			lddataintegrity.KnownToAtumV1ContextURL,
		},
		"id":           "urn:uuid:vc-1615a-test",
		"type":         []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
		"issuer":       issuerDID,
		"issuanceDate": createdStr,
		"credentialSubject": map[string]any{
			"id":   "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
			"role": "settler",
		},
	}

	// Proof template (no jws yet). Mirrors sign/proof.go:76-85.
	proofTemplate := map[string]any{
		"@context":           suiteCtx,
		"type":               ProofTypeSecp256k1Recovery2020,
		"created":            createdStr,
		"verificationMethod": vmURL,
		"proofPurpose":       "assertionMethod",
	}

	// Canonicalize separately, hash, combine — mirrors sign/proof.go:87-98.
	canonicalCredential, err := Canonicalize(vcBody)
	if err != nil {
		t.Fatalf("canonicalize credential: %v", err)
	}
	canonicalProof, err := Canonicalize(proofTemplate)
	if err != nil {
		t.Fatalf("canonicalize proof: %v", err)
	}
	docHash := crypto.Keccak256([]byte(canonicalCredential))
	proofHash := crypto.Keccak256([]byte(canonicalProof))
	combined := crypto.Keccak256(bytes.Join([][]byte{proofHash, docHash}, nil))

	sig, err := crypto.Sign(combined, issuerPriv)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	// Match go-ethereum's recovery-id offset convention (the existing
	// signVPSecpForTest helper does the same +27 bump per RFC 7797 /
	// ES256K-R conventions).
	sig[64] += 27

	header := map[string]any{"alg": "ES256K-R", "b64": false, "crit": []string{"b64"}}
	headerJSON, _ := json.Marshal(header)
	jws := base64.RawURLEncoding.EncodeToString(headerJSON) + ".." + base64.RawURLEncoding.EncodeToString(sig)

	vcBody["proof"] = map[string]any{
		"@context":           suiteCtx,
		"type":               ProofTypeSecp256k1Recovery2020,
		"created":            createdStr,
		"verificationMethod": vmURL,
		"proofPurpose":       "assertionMethod",
		"jws":                jws,
	}

	wireBytes, err := json.Marshal(vcBody)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return mustUnmarshalVC(t, wireBytes), json.RawMessage(wireBytes), vmURL
}

func mustUnmarshalVC(t *testing.T, b []byte) fqe.VerifiableCredential {
	t.Helper()
	var v fqe.VerifiableCredential
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("unmarshal VC: %v", err)
	}
	return v
}

// issuerVMSet builds the resolver-side VerificationMethodSet that
// matches signedVCFixture's issuer key. Mirrors the issuer-side DID
// document shape the production issuer publishes.
func issuerVMSet(t *testing.T, priv *ecdsa.PrivateKey, issuerDID string) VerificationMethodSet {
	t.Helper()
	vmURL := issuerDID + "#issuer-key-1"
	// Uncompressed pubkey: 0x04 || X || Y. Strip the 0x04 prefix and
	// split into 32-byte X and Y halves the JWK expects.
	uncompressed := crypto.FromECDSAPub(&priv.PublicKey)
	if len(uncompressed) != 65 {
		t.Fatalf("expected 65-byte uncompressed pubkey, got %d", len(uncompressed))
	}
	x := uncompressed[1:33]
	y := uncompressed[33:65]
	return VerificationMethodSet{{
		ID:   vmURL,
		Type: "JsonWebKey2020",
		PublicKeyJWK: map[string]interface{}{
			"kty": "EC",
			"crv": "secp256k1",
			"x":   base64.RawURLEncoding.EncodeToString(x),
			"y":   base64.RawURLEncoding.EncodeToString(y),
		},
	}}
}

// TestVerifyVCProof_HappyPath_Secp256k1 pins the load-bearing
// positive: a VC signed by the issuer's key, with the resolver
// returning the matching JWK, MUST verify clean.
func TestVerifyVCProof_HappyPath_Secp256k1(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, rawVC, _ := signedVCFixture(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, priv, issuerDID)}

	if err := VerifyVCProof(vc, rawVC, resolver, VerifyVCProofOptions{Context: context.Background()}); err != nil {
		t.Fatalf("VerifyVCProof rejected a valid signed VC: %v", err)
	}
}

// TestVerifyVCProof_TamperedJWS_SignatureBody pins the signature-
// invalid path: the JWS signature payload is mutated but the
// envelope stays structurally valid (header..base64url-payload).
// RecoverAddress runs successfully but recovers a different signer
// than the issuer's published key → ErrVPVCSignatureInvalid.
// Splitting pins each sentinel exactly (rather than matching this OR
// ErrMalformedSignatureMaterial) so a future taxonomy regression that
// mis-buckets sig-invalid as ops fails loudly.
func TestVerifyVCProof_TamperedJWS_SignatureBody(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, _, _ := signedVCFixture(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, priv, issuerDID)}

	wire, err := json.Marshal(vc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var asMap map[string]any
	if err := json.Unmarshal(wire, &asMap); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	proof := asMap["proof"].(map[string]any)
	jws := proof["jws"].(string)
	dotdot := strings.Index(jws, "..")
	if dotdot < 0 {
		t.Fatalf("test fixture: JWS doesn't have detached `..` separator: %q", jws)
	}
	header := jws[:dotdot]
	sigPart := jws[dotdot+2:]
	// Flip a single base64url char near the start so the bytes
	// differ but base64url decode + sig-length checks still pass.
	flip := byte('B')
	if sigPart[0] == 'B' {
		flip = 'C'
	}
	proof["jws"] = header + ".." + string(flip) + sigPart[1:]
	asMap["proof"] = proof
	tamperedBytes, _ := json.Marshal(asMap)
	tampered := mustUnmarshalVC(t, tamperedBytes)

	err = VerifyVCProof(tampered, json.RawMessage(tamperedBytes), resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted a JWS with mutated signature payload")
	}
	if !errors.Is(err, ErrVPVCSignatureInvalid) {
		t.Errorf("expected ErrVPVCSignatureInvalid (sig-invalid path), got %v", err)
	}
}

// TestVerifyVCProof_TamperedJWS_MangledStructure pins the malformed-
// material path: the JWS envelope itself is structurally broken so
// the parser rejects BEFORE RecoverAddress runs. Sentinel routes to
// ErrMalformedSignatureMaterial / ErrMalformedProof (umbrella) —
// distinct from sig-invalid so the perimeter's per-reason tag can
// distinguish "issuer's key didn't match" from "shape was garbage".
func TestVerifyVCProof_TamperedJWS_MangledStructure(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, _, _ := signedVCFixture(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, priv, issuerDID)}

	wire, err := json.Marshal(vc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var asMap map[string]any
	if err := json.Unmarshal(wire, &asMap); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	proof := asMap["proof"].(map[string]any)
	// No `..` separator + characters outside the base64url alphabet
	// (`#`) — ParseDetachedJWS rejects before any crypto runs.
	proof["jws"] = "not#a#valid#jws#####"
	asMap["proof"] = proof
	tamperedBytes, _ := json.Marshal(asMap)
	tampered := mustUnmarshalVC(t, tamperedBytes)

	err = VerifyVCProof(tampered, json.RawMessage(tamperedBytes), resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted a structurally invalid JWS")
	}
	if !errors.Is(err, ErrMalformedSignatureMaterial) && !errors.Is(err, ErrMalformedProof) {
		t.Errorf("expected ErrMalformedSignatureMaterial or ErrMalformedProof, got %v", err)
	}
}

// TestVerifyVCProof_TamperedBody rejects when the credential body
// (not the proof) is mutated. URDNA2015 produces different canonical
// bytes → different signing input → recovered address ≠ expected.
// Pinned because date-window / subject-holder checks happen on a
// typed view; the cryptographic check is the only one that sees the
// wire-form mutation here.
func TestVerifyVCProof_TamperedBody(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, _, _ := signedVCFixture(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, priv, issuerDID)}

	wire, err := json.Marshal(vc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var asMap map[string]any
	if err := json.Unmarshal(wire, &asMap); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	subject := asMap["credentialSubject"].(map[string]any)
	subject["role"] = "atumOperatedService" // bump from "settler"
	asMap["credentialSubject"] = subject
	tamperedBytes, _ := json.Marshal(asMap)
	tampered := mustUnmarshalVC(t, tamperedBytes)

	err = VerifyVCProof(tampered, json.RawMessage(tamperedBytes), resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted a tampered credentialSubject")
	}
	if !errors.Is(err, ErrVPVCSignatureInvalid) {
		t.Errorf("expected ErrVPVCSignatureInvalid, got %v", err)
	}
}

// TestVerifyVCProof_IssuerUnresolvable_Error fires when the resolver
// returns an error (DNS / network / issuer outage). Ops-class
// per the taxonomy.
func TestVerifyVCProof_IssuerUnresolvable_Error(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, rawVC, _ := signedVCFixture(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, forceErr: errors.New("network down")}

	err := VerifyVCProof(vc, rawVC, resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted with resolver returning error")
	}
	if !errors.Is(err, ErrVPVCIssuerUnresolvable) {
		t.Errorf("expected ErrVPVCIssuerUnresolvable, got %v", err)
	}
}

// TestVerifyVCProof_IssuerUnresolvable_EmptySet pins the defense
// against a buggy resolver returning (nil, nil): a non-error empty
// set still means "no key to verify against," so route to
// ErrVPVCIssuerUnresolvable rather than silently pass.
func TestVerifyVCProof_IssuerUnresolvable_EmptySet(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, rawVC, _ := signedVCFixture(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, forceEmpty: true}

	err := VerifyVCProof(vc, rawVC, resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted with resolver returning empty set")
	}
	if !errors.Is(err, ErrVPVCIssuerUnresolvable) {
		t.Errorf("expected ErrVPVCIssuerUnresolvable, got %v", err)
	}
}

// TestVerifyVCProof_IssuerKeyMismatch fires when the resolver returns
// a non-empty set, but the proof's verificationMethod URL doesn't
// match any entry. Compliance-class: attacker claiming a trusted
// issuer but signing with a key not in the document.
func TestVerifyVCProof_IssuerKeyMismatch(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, rawVC, _ := signedVCFixture(t, priv, issuerDID)
	// Resolver returns a VM at a DIFFERENT fragment than what the
	// VC's proof points to. The proof claims #issuer-key-1; the
	// resolver advertises #other-key.
	vmSet := issuerVMSet(t, priv, issuerDID)
	vmSet[0].ID = issuerDID + "#other-key"
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: vmSet}

	err := VerifyVCProof(vc, rawVC, resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted when proof.verificationMethod ≠ resolver's VM IDs")
	}
	if !errors.Is(err, ErrVPVCIssuerKeyMismatch) {
		t.Errorf("expected ErrVPVCIssuerKeyMismatch, got %v", err)
	}
}

// TestVerifyVCProof_SignatureMismatch_DifferentKey fires when the
// resolver returns a VM matching the proof's verificationMethod URL
// but advertising a DIFFERENT public key than the one the VC was
// signed with. The recovery succeeds against the actual signer's key
// → recovered address ≠ resolver's address → ErrVPVCSignatureInvalid.
//
// This is the load-bearing compliance pin: an attacker who knows the
// trusted issuer's DID can mint a VC, sign with their own key, and
// declare verificationMethod = the issuer's URL. The verifier closes
// the gap by checking the recovered key against the resolver-
// published key, not the proof's claimed URL.
func TestVerifyVCProof_SignatureMismatch_DifferentKey(t *testing.T) {
	signerPriv := newSecpKey(t) // attacker's key
	otherPriv := newSecpKey(t)  // "issuer's" advertised key
	issuerDID := "did:web:atumlabs.test"
	vc, rawVC, _ := signedVCFixture(t, signerPriv, issuerDID)

	// Resolver advertises otherPriv's pubkey at the SAME URL the
	// VC's proof references.
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, otherPriv, issuerDID)}

	err := VerifyVCProof(vc, rawVC, resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted a VC signed with a key the resolver doesn't advertise")
	}
	if !errors.Is(err, ErrVPVCSignatureInvalid) {
		t.Errorf("expected ErrVPVCSignatureInvalid, got %v", err)
	}
}

// TestVerifyVCProof_ProofContextMismatch_RejectsSwap pins the
// canonicalization-confusion defense: an attacker pairing
// proof.type=EcdsaSecp256k1RecoverySignature2020
// with proof.@context = the ed25519-2020 suite URL would canonicalize
// the proof block under different term bindings if the verifier
// trusted the wire @context. requireProofContextMatchesSuite rejects
// the mismatch before HashQuote runs.
func TestVerifyVCProof_ProofContextMismatch_RejectsSwap(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, _, _ := signedVCFixture(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, priv, issuerDID)}

	wire, _ := json.Marshal(vc)
	var asMap map[string]any
	_ = json.Unmarshal(wire, &asMap)
	proof := asMap["proof"].(map[string]any)
	// Swap proof.@context to the ed25519-2020 suite URL while
	// proof.type stays secp256k1. The verifier MUST reject.
	proof["@context"] = "https://w3id.org/security/suites/ed25519-2020/v1"
	asMap["proof"] = proof
	mutatedBytes, _ := json.Marshal(asMap)
	mutated := mustUnmarshalVC(t, mutatedBytes)

	err := VerifyVCProof(mutated, json.RawMessage(mutatedBytes), resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted proof.@context swapped to a different cryptosuite URL")
	}
	if !errors.Is(err, ErrVPVCUnsupportedProofType) {
		t.Errorf("expected ErrVPVCUnsupportedProofType, got %v", err)
	}
}

// TestVerifyVCProof_ProofContextArray_AcceptsWhenSuiteIncluded pins
// the array-shape branch of requireProofContextMatchesSuite. The
// issuer side emits proof.@context as a bare string today, but the
// W3C cryptosuite spec allows an array; a future signer using the
// array form with the cryptosuite URL included MUST verify.
func TestVerifyVCProof_ProofContextArray_AcceptsWhenSuiteIncluded(t *testing.T) {
	// Direct unit test on the helper — keeps the test focused on the
	// dispatch gate rather than re-minting a signed fixture under a
	// new proof shape (which would require rewiring signedVCFixture's
	// canonicalization input).
	cases := []struct {
		name      string
		proofType string
		ctx       any
		wantErr   bool
	}{
		{"string match", ProofTypeSecp256k1Recovery2020, "https://w3id.org/security/suites/secp256k1recovery-2020/v2", false},
		{"string mismatch", ProofTypeSecp256k1Recovery2020, "https://w3id.org/security/suites/ed25519-2020/v1", true},
		{"array includes suite", ProofTypeSecp256k1Recovery2020, []any{"https://w3id.org/security/suites/secp256k1recovery-2020/v2", "other"}, false},
		{"array excludes suite", ProofTypeSecp256k1Recovery2020, []any{"https://w3id.org/security/suites/ed25519-2020/v1"}, true},
		{"absent ctx ok", ProofTypeSecp256k1Recovery2020, nil, false},
		{"wrong type", ProofTypeSecp256k1Recovery2020, 42, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			proof := map[string]any{}
			if tc.ctx != nil {
				proof["@context"] = tc.ctx
			}
			err := requireProofContextMatchesSuite(tc.proofType, proof)
			gotErr := err != nil
			if gotErr != tc.wantErr {
				t.Errorf("requireProofContextMatchesSuite: gotErr=%v want=%v (err=%v)", gotErr, tc.wantErr, err)
			}
			if gotErr && !errors.Is(err, ErrVPVCUnsupportedProofType) {
				t.Errorf("expected ErrVPVCUnsupportedProofType, got %v", err)
			}
		})
	}
}

// signedVCFixtureEd25519 mints a VC signed by the supplied ed25519
// issuer key. The end-to-end protocol mirrors signedVCFixture's
// secp256k1 path: build VC body, build proof template, HashQuote
// (which composes canonicalDoc + canonicalProof into the ed25519
// signing input), ed25519.Sign, encode the signature as multibase-
// base58btc, re-attach the proof. Same primitives the production
// issuer would use once an ed25519 signing path lands issuer-side.
func signedVCFixtureEd25519(t *testing.T, priv ed25519.PrivateKey, issuerDID string) (fqe.VerifiableCredential, json.RawMessage, string) {
	t.Helper()
	vmURL := issuerDID + "#issuer-key-ed25519-1"
	createdStr := "2026-01-01T00:00:00Z"
	suiteCtx := ed25519Signature2020V1CtxURL

	vcBody := map[string]any{
		"@context": []any{
			w3cVCV1ContextURL,
			lddataintegrity.KnownToAtumV1ContextURL,
		},
		"id":           "urn:uuid:vc-1737-ed25519-test",
		"type":         []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
		"issuer":       issuerDID,
		"issuanceDate": createdStr,
		"credentialSubject": map[string]any{
			"id":   "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
			"role": "settler",
		},
	}

	hash, err := HashQuote(vcBody, HashQuoteOptions{
		Cryptosuite: ProofTypeEd25519Signature2020,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeEd25519Signature2020,
			Created:            createdStr,
			VerificationMethod: vmURL,
			ProofPurpose:       "assertionMethod",
			Context:            suiteCtx,
		},
		KeepVerifiableCredential: false,
	})
	if err != nil {
		t.Fatalf("HashQuote: %v", err)
	}

	sig := ed25519.Sign(priv, hash.SigningInput)
	proofValue := "z" + base58.Encode(sig)

	vcBody["proof"] = map[string]any{
		"@context":           suiteCtx,
		"type":               ProofTypeEd25519Signature2020,
		"created":            createdStr,
		"verificationMethod": vmURL,
		"proofPurpose":       "assertionMethod",
		"proofValue":         proofValue,
	}

	wireBytes, err := json.Marshal(vcBody)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return mustUnmarshalVC(t, wireBytes), json.RawMessage(wireBytes), vmURL
}

// issuerVMSetEd25519 builds the resolver-side VerificationMethodSet
// that matches signedVCFixtureEd25519's ed25519 issuer key. JWK shape
// per RFC 8037 §2: kty=OKP, crv=Ed25519, x=base64url(32-byte pubkey).
// The verificationMethod type stays JsonWebKey2020 (the cryptosuite-
// agnostic shape the issuer already uses for secp256k1 keys).
func issuerVMSetEd25519(t *testing.T, priv ed25519.PrivateKey, issuerDID string) VerificationMethodSet {
	t.Helper()
	vmURL := issuerDID + "#issuer-key-ed25519-1"
	pub := priv.Public().(ed25519.PublicKey)
	return VerificationMethodSet{{
		ID:   vmURL,
		Type: "JsonWebKey2020",
		PublicKeyJWK: map[string]interface{}{
			"kty": "OKP",
			"crv": "Ed25519",
			"x":   base64.RawURLEncoding.EncodeToString(pub),
		},
	}}
}

func newEd25519Key(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}
	return priv
}

// TestVerifyVCProof_HappyPath_Ed25519 pins the load-bearing positive
// for the ed25519 path. A VC signed by an ed25519 issuer key, with
// the resolver returning the matching JWK
// (kty=OKP, crv=Ed25519, x=base64url(pubkey)), MUST verify clean.
func TestVerifyVCProof_HappyPath_Ed25519(t *testing.T) {
	priv := newEd25519Key(t)
	issuerDID := "did:web:atumlabs.test"
	vc, rawVC, _ := signedVCFixtureEd25519(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSetEd25519(t, priv, issuerDID)}

	if err := VerifyVCProof(vc, rawVC, resolver, VerifyVCProofOptions{Context: context.Background()}); err != nil {
		t.Fatalf("VerifyVCProof: %v", err)
	}
}

// TestVerifyVCProof_TamperedProofValue_Ed25519 pins the
// signature-rejection path: flipping the first byte of the decoded
// signature MUST surface as ErrVPVCSignatureInvalid (the same
// compliance-class outcome the secp256k1 tampered-jws test asserts).
func TestVerifyVCProof_TamperedProofValue_Ed25519(t *testing.T) {
	priv := newEd25519Key(t)
	issuerDID := "did:web:atumlabs.test"
	vc, rawVC, _ := signedVCFixtureEd25519(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSetEd25519(t, priv, issuerDID)}

	var asMap map[string]any
	_ = json.Unmarshal(rawVC, &asMap)
	proof := asMap["proof"].(map[string]any)
	pv := proof["proofValue"].(string)
	sig, err := base58.Decode(strings.TrimPrefix(pv, "z"))
	if err != nil {
		t.Fatalf("decode proofValue: %v", err)
	}
	sig[0] ^= 0xFF
	proof["proofValue"] = "z" + base58.Encode(sig)
	asMap["proof"] = proof
	tamperedBytes, _ := json.Marshal(asMap)
	tampered := mustUnmarshalVC(t, tamperedBytes)

	err = VerifyVCProof(tampered, json.RawMessage(tamperedBytes), resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted a tampered proof.proofValue")
	}
	if !errors.Is(err, ErrVPVCSignatureInvalid) {
		t.Errorf("expected ErrVPVCSignatureInvalid, got %v", err)
	}
	_ = vc
}

// TestVerifyVCProof_WrongIssuerKey_Ed25519 pins the
// resolver-returns-different-pubkey path. The resolver advertises
// a fresh ed25519 key under the same verificationMethod URL; the
// VC's signature won't verify under it. ErrVPVCSignatureInvalid.
func TestVerifyVCProof_WrongIssuerKey_Ed25519(t *testing.T) {
	signingPriv := newEd25519Key(t)
	wrongPriv := newEd25519Key(t)
	issuerDID := "did:web:atumlabs.test"
	vc, rawVC, _ := signedVCFixtureEd25519(t, signingPriv, issuerDID)

	// Resolver returns the WRONG key under the same VM URL.
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSetEd25519(t, wrongPriv, issuerDID)}

	err := VerifyVCProof(vc, rawVC, resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted a VC against the wrong issuer key")
	}
	if !errors.Is(err, ErrVPVCSignatureInvalid) {
		t.Errorf("expected ErrVPVCSignatureInvalid, got %v", err)
	}
}

// TestVerifyVCProof_MalformedJWK_Ed25519 pins the
// jwkEd25519ToPublicKey guard for shape errors. A JWK with the
// wrong kty/crv/x routes to ErrMalformedQuote so the perimeter
// taxonomy sees an ops-class failure rather than a compliance
// signal — distinguishing "bad issuer key publication" from
// "attacker forgery."
func TestVerifyVCProof_MalformedJWK_Ed25519(t *testing.T) {
	priv := newEd25519Key(t)
	issuerDID := "did:web:atumlabs.test"
	vc, rawVC, _ := signedVCFixtureEd25519(t, priv, issuerDID)

	cases := []struct {
		name string
		jwk  map[string]interface{}
	}{
		{"wrong kty", map[string]interface{}{"kty": "EC", "crv": "Ed25519", "x": base64.RawURLEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))}},
		{"wrong crv", map[string]interface{}{"kty": "OKP", "crv": "X25519", "x": base64.RawURLEncoding.EncodeToString(priv.Public().(ed25519.PublicKey))}},
		{"missing x", map[string]interface{}{"kty": "OKP", "crv": "Ed25519"}},
		{"short x", map[string]interface{}{"kty": "OKP", "crv": "Ed25519", "x": base64.RawURLEncoding.EncodeToString([]byte{0x01, 0x02})}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vmURL := issuerDID + "#issuer-key-ed25519-1"
			resolver := &mockResolver{
				issuerDID: issuerDID,
				vmSet: VerificationMethodSet{{
					ID:           vmURL,
					Type:         "JsonWebKey2020",
					PublicKeyJWK: tc.jwk,
				}},
			}
			err := VerifyVCProof(vc, rawVC, resolver, VerifyVCProofOptions{Context: context.Background()})
			if err == nil {
				t.Fatalf("VerifyVCProof accepted a malformed JWK (%s)", tc.name)
			}
			if !errors.Is(err, ErrMalformedQuote) {
				t.Errorf("expected ErrMalformedQuote, got %v", err)
			}
		})
	}
}

// TestVerifyVCProof_UnsupportedProofType_Unknown pins the default
// branch: any proof.type the dispatch doesn't recognise routes to
// ErrVPVCUnsupportedProofType.
func TestVerifyVCProof_UnsupportedProofType_Unknown(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, _, _ := signedVCFixture(t, priv, issuerDID)

	wire, _ := json.Marshal(vc)
	var asMap map[string]any
	_ = json.Unmarshal(wire, &asMap)
	proof := asMap["proof"].(map[string]any)
	proof["type"] = "FutureFancySuite2030"
	asMap["proof"] = proof
	mutatedBytes, _ := json.Marshal(asMap)
	mutated := mustUnmarshalVC(t, mutatedBytes)

	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, priv, issuerDID)}
	err := VerifyVCProof(mutated, json.RawMessage(mutatedBytes), resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted an unrecognised proof.type")
	}
	if !errors.Is(err, ErrVPVCUnsupportedProofType) {
		t.Errorf("expected ErrVPVCUnsupportedProofType, got %v", err)
	}
}

// TestVerifyVCProof_UnsupportedVMType pins the JsonWebKey2020-only
// VM-type contract. A resolver returning a VM under a different type
// (e.g. Ed25519VerificationKey2020) routes to
// ErrVPVCUnsupportedProofType — the proof might be secp256k1 but the
// resolver's published key isn't in a shape we can derive an EVM
// address from.
func TestVerifyVCProof_UnsupportedVMType(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, rawVC, _ := signedVCFixture(t, priv, issuerDID)

	vmSet := issuerVMSet(t, priv, issuerDID)
	vmSet[0].Type = "Ed25519VerificationKey2020" // not the one we support
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: vmSet}

	err := VerifyVCProof(vc, rawVC, resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted a VM with unsupported type")
	}
	if !errors.Is(err, ErrVPVCUnsupportedProofType) {
		t.Errorf("expected ErrVPVCUnsupportedProofType, got %v", err)
	}
}

// TestVerifyVCProof_NilResolver pins the defensive entry-point check:
// a direct call with nil resolver MUST fail closed, even though the
// VerifyVPOptions.VerifyVCProofs=nil contract opts the check out at
// the caller level. Two different layers, two different contracts.
func TestVerifyVCProof_NilResolver(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, rawVC, _ := signedVCFixture(t, priv, issuerDID)

	err := VerifyVCProof(vc, rawVC, nil, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted a nil resolver — should fail closed")
	}
	if !errors.Is(err, ErrMalformedQuote) {
		t.Errorf("expected ErrMalformedQuote, got %v", err)
	}
}

// TestVerifyVCProof_NilContext pins the same defense for opts.Context.
// Callers that forget to set it would silently break resolver
// timeouts; failing closed surfaces the mis-wire.
func TestVerifyVCProof_NilContext(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, rawVC, _ := signedVCFixture(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, priv, issuerDID)}

	err := VerifyVCProof(vc, rawVC, resolver, VerifyVCProofOptions{})
	if err == nil {
		t.Fatal("VerifyVCProof accepted a nil opts.Context — should fail closed")
	}
	if !errors.Is(err, ErrMalformedQuote) {
		t.Errorf("expected ErrMalformedQuote, got %v", err)
	}
}

// W3C VC v1 inline-twin-vs-full-snapshot drift guard lives in the
// shared drift test.

// TestVerifyVPOptions_NilVCProofs_OptsOut pins the upper-layer
// contract: VerifyVPOptions.VerifyVCProofs=nil short-circuits the
// per-VC cryptographic check, preserving the earlier behavior for
// callers that haven't wired a resolver yet. The test mints a VP
// (not a bare VC) and exercises the verify_vp.go path that calls
// verifyVCPolicies.
func TestVerifyVPOptions_NilVCProofs_OptsOut(t *testing.T) {
	priv := newSecpKey(t)
	holder := "did:pkh:eip155:1:" + strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{Holder: holder})

	// VerifyVP with nil VerifyVCProofs (the default opts struct).
	// The existing happy path expects no cryptographic VC check; this
	// test pins the contract explicitly so a future refactor that
	// flips the default doesn't silently start rejecting bids whose
	// stub VC proofs predate the VC-signature check.
	opts := happyOpts(holder)
	if _, err := VerifyVP(envelope, opts); err != nil {
		t.Fatalf("VerifyVP rejected when VerifyVCProofs is nil — opt-out contract broken: %v", err)
	}
}

// happyOpts and newSecpKey are defined in verify_vp_test.go (same
// package) — reused here so these tests share the same baseline
// VerifyVPOptions as the VP tests.

// Input-validation tests for the proof block's `created` field.
// The earlier silent string-coercion
// idiom (`created, _ := proof["created"].(string)`) routed
// missing-or-non-string values through HashQuote → recovery
// mismatch → ErrVPVCSignatureInvalid, mis-classifying a
// producer-side malformed-input bug as a cryptographic failure on
// observability dashboards. The fail-fast gate now classifies both
// shapes as ErrMalformedQuote.

// TestVerifyVCProof_ProofCreatedNonString_RejectsAsMalformed
// covers the wire-level case where the producer emits `created` as
// a number (Unix timestamp) instead of an ISO-8601 string. Today's
// issuer always emits a string, but the verifier must protect
// against a future producer that breaks the contract.
func TestVerifyVCProof_ProofCreatedNonString_RejectsAsMalformed(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, _, _ := signedVCFixture(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, priv, issuerDID)}

	wire, _ := json.Marshal(vc)
	var asMap map[string]any
	_ = json.Unmarshal(wire, &asMap)
	proof := asMap["proof"].(map[string]any)
	// Flip `created` from a string to a Unix-timestamp number.
	proof["created"] = float64(1716163200)
	asMap["proof"] = proof
	mutatedBytes, _ := json.Marshal(asMap)
	mutated := mustUnmarshalVC(t, mutatedBytes)

	err := VerifyVCProof(mutated, json.RawMessage(mutatedBytes), resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted proof.created as a number — malformed-input gate broken")
	}
	if !errors.Is(err, ErrMalformedQuote) {
		t.Errorf("expected ErrMalformedQuote (input-shape failure), got %v", err)
	}
	if errors.Is(err, ErrVPVCSignatureInvalid) {
		t.Error("non-string proof.created mis-classified as ErrVPVCSignatureInvalid — observability label drift")
	}
}

// TestVerifyVCProof_ProofCreatedMissing_RejectsAsMalformed covers
// the case where the producer omits `created` entirely. The
// pre-fix behaviour coerced this to "" and fed it into HashQuote,
// hiding the contract violation behind a crypto failure.
func TestVerifyVCProof_ProofCreatedMissing_RejectsAsMalformed(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, _, _ := signedVCFixture(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, priv, issuerDID)}

	wire, _ := json.Marshal(vc)
	var asMap map[string]any
	_ = json.Unmarshal(wire, &asMap)
	proof := asMap["proof"].(map[string]any)
	delete(proof, "created")
	asMap["proof"] = proof
	mutatedBytes, _ := json.Marshal(asMap)
	mutated := mustUnmarshalVC(t, mutatedBytes)

	err := VerifyVCProof(mutated, json.RawMessage(mutatedBytes), resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted a proof block with no `created` field")
	}
	if !errors.Is(err, ErrMalformedQuote) {
		t.Errorf("expected ErrMalformedQuote, got %v", err)
	}
}

// TestVerifyVCProof_ProofPurposeMismatch_Rejects pins the W3C Data
// Integrity §4.2 requirement (mirroring verify.go:96 / verify_vp.go:338):
// the verifier MUST reject a VC proof whose purpose doesn't match
// the intended use. Not exploitable today (the value is inside the
// signed hash + the issuer only ever signs with `assertionMethod`),
// but the moment the issuer's KMS key signs
// any non-`assertionMethod` proof in the future, that signature
// would become replayable as a VC assertion — cheap defense-in-
// depth.
func TestVerifyVCProof_ProofPurposeMismatch_Rejects(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, _, _ := signedVCFixture(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, priv, issuerDID)}

	wire, _ := json.Marshal(vc)
	var asMap map[string]any
	_ = json.Unmarshal(wire, &asMap)
	proof := asMap["proof"].(map[string]any)
	// Use `authentication` — the purpose VP proofs use. A future
	// cross-purpose key-reuse attack would surface as this exact
	// shape (a valid signature lifted from a VP-style proof being
	// presented as a VC assertion).
	proof["proofPurpose"] = "authentication"
	asMap["proof"] = proof
	mutatedBytes, _ := json.Marshal(asMap)
	mutated := mustUnmarshalVC(t, mutatedBytes)

	err := VerifyVCProof(mutated, json.RawMessage(mutatedBytes), resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted proof.proofPurpose=\"authentication\" — W3C Data Integrity §4.2 gate broken")
	}
	if !errors.Is(err, ErrVPVCUnsupportedProofType) {
		t.Errorf("expected ErrVPVCUnsupportedProofType, got %v", err)
	}
}

// TestVerifyVCProof_ProofPurposeMissing_Rejects covers the
// boundary where the producer omits proofPurpose entirely. Empty
// string MUST NOT pass the gate (would otherwise leak through as
// "" != "assertionMethod" → the gate fires, but pinning this
// explicitly protects against a refactor that special-cases
// empty).
func TestVerifyVCProof_ProofPurposeMissing_Rejects(t *testing.T) {
	priv := newSecpKey(t)
	issuerDID := "did:web:atumlabs.test"
	vc, _, _ := signedVCFixture(t, priv, issuerDID)
	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, priv, issuerDID)}

	wire, _ := json.Marshal(vc)
	var asMap map[string]any
	_ = json.Unmarshal(wire, &asMap)
	proof := asMap["proof"].(map[string]any)
	delete(proof, "proofPurpose")
	asMap["proof"] = proof
	mutatedBytes, _ := json.Marshal(asMap)
	mutated := mustUnmarshalVC(t, mutatedBytes)

	err := VerifyVCProof(mutated, json.RawMessage(mutatedBytes), resolver, VerifyVCProofOptions{Context: context.Background()})
	if err == nil {
		t.Fatal("VerifyVCProof accepted a proof block with no proofPurpose")
	}
	if !errors.Is(err, ErrVPVCUnsupportedProofType) {
		t.Errorf("expected ErrVPVCUnsupportedProofType, got %v", err)
	}
}
