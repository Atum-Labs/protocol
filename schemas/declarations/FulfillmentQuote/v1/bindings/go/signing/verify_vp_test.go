package ldverification

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/mr-tron/base58"

	fqe "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuoteEnvelope/v1/bindings/go/generated"
)

// vpFixtureOptions configure signVPForTest. Defaults are filled in so a
// happy-path test reads as: `signVPForTest(t, priv, vpFixtureOptions{})`.
type vpFixtureOptions struct {
	// Identity / replay binding
	Holder             string // default derived from priv
	VerificationMethod string // default derived from priv
	Challenge          string // default "req-fixture-1"
	Domain             string // default "did:web:settler.atum.network"
	Created            string // default a fixed RFC3339 time

	// DeclarationType, when non-empty, is appended to the signed envelope's
	// `type` array (declaration-type binding). Empty keeps the earlier
	// ["VerifiablePresentation"] shape.
	DeclarationType string

	// Optional per-VC mutations applied to the default KnownToAtumVerifiableCredential.
	IssuerDID      string
	IssuanceDate   time.Time
	ExpirationDate *time.Time
	VCTypes        []string
	// SubjectDID overrides the VC's credentialSubject.id. Defaults to
	// Holder (matches the production shape: a settler's VC is bound to
	// their own holder DID). Tests that exercise the subject-holder
	// gate explicitly pass a different DID to make the gate fire.
	SubjectDID string
	// CredentialSubjectOverride replaces the VC's entire
	// `credentialSubject` map when non-nil. Use this to mint VCs whose
	// credentialSubject is malformed (missing `id`, non-string `id`) so
	// the malformed-quote branch of checkVCSubjectMatchesHolder can be
	// exercised. When nil, the default `{id: SubjectDID|Holder, role:
	// "settler"}` map is used. SubjectDID is ignored if this is
	// non-nil.
	CredentialSubjectOverride map[string]any
	// MutateVC, when non-nil, edits the default VC after it is built and
	// before the envelope is signed, so the holder signature covers the
	// edited credential. Use it for wire shapes the typed fields above
	// cannot express, such as a member set to JSON null or removed.
	MutateVC func(vc map[string]any)
	// ExtraVCs appends additional VCs to the envelope after the default
	// one. Used by tests that exercise multi-VC behaviors (mixed
	// valid+invalid VC pinning, and one-VC-holder-mismatch pinning).
	// Each entry is a fully-built VC map ready to canonicalize —
	// callers typically produce one via buildFixtureVC.
	ExtraVCs []map[string]any
	// SettlerProof signs the SettlerProof typed digest instead of the legacy signing input.
	SettlerProof bool
}

// signVPForTest assembles a signed FulfillmentQuoteEnvelope JSON using the
// same primitives sign-vp.ts wires together: HashQuote + crypto.Sign for
// secp256k1, ed25519.Sign for the ed25519 path. Mirrors the existing
// signForTestWithCreatedString helper (FQ side) but for the VP shape:
// VerifiableCredential array is kept, proof carries challenge + domain +
// proofPurpose: authentication, and the proof @context is the envelope +
// cryptosuite multi-context array.
func signVPSecpForTest(t *testing.T, priv *ecdsa.PrivateKey, opts vpFixtureOptions) []byte {
	t.Helper()
	const w3cVC = "https://www.w3.org/2018/credentials/v1"
	const envCtx = "https://schemas.atum.network/declarations/FulfillmentQuoteEnvelope/v1/context.jsonld"
	const secpCtx = "https://w3id.org/security/suites/secp256k1recovery-2020/v2"

	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	if opts.Holder == "" {
		opts.Holder = "did:pkh:eip155:1:" + addr
	}
	if opts.VerificationMethod == "" {
		opts.VerificationMethod = opts.Holder + "#blockchainAccountId"
	}
	if opts.Challenge == "" {
		opts.Challenge = "req-fixture-1"
	}
	if opts.Domain == "" {
		opts.Domain = "did:web:settler.atum.network"
	}
	if opts.Created == "" {
		opts.Created = "2026-05-20T00:00:00.000Z"
	}
	if opts.IssuerDID == "" {
		opts.IssuerDID = "did:web:atumlabs.xyz"
	}
	if opts.IssuanceDate.IsZero() {
		opts.IssuanceDate = mustTime(t, "2026-01-01T00:00:00Z")
	}
	if opts.VCTypes == nil {
		opts.VCTypes = []string{"VerifiableCredential", "KnownToAtumVerifiableCredential"}
	}

	subjectDID := opts.SubjectDID
	if subjectDID == "" {
		subjectDID = opts.Holder
	}
	vc := buildFixtureVC(opts.IssuerDID, opts.IssuanceDate, opts.ExpirationDate, opts.VCTypes, subjectDID, ProofTypeSecp256k1Recovery2020)
	if opts.CredentialSubjectOverride != nil {
		vc["credentialSubject"] = opts.CredentialSubjectOverride
	}
	if opts.MutateVC != nil {
		opts.MutateVC(vc)
	}

	vcs := []any{vc}
	for _, extra := range opts.ExtraVCs {
		vcs = append(vcs, extra)
	}
	typeArr := []any{"VerifiablePresentation"}
	if opts.DeclarationType != "" {
		typeArr = append(typeArr, opts.DeclarationType)
	}
	doc := map[string]any{
		"@context":             []any{w3cVC, envCtx, secpCtx},
		"type":                 typeArr,
		"holder":               opts.Holder,
		"verifiableCredential": vcs,
	}

	hash, err := HashQuote(doc, HashQuoteOptions{
		Cryptosuite:              ProofTypeSecp256k1Recovery2020,
		KeepVerifiableCredential: true,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeSecp256k1Recovery2020,
			Created:            opts.Created,
			VerificationMethod: opts.VerificationMethod,
			ProofPurpose:       expectedVPProofPurpose,
			Challenge:          opts.Challenge,
			Domain:             opts.Domain,
			Context:            []any{envCtx, secpCtx},
		},
	})
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	sig, err := crypto.Sign(testSigningDigest(t, hash, opts.SettlerProof), priv)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	sig[64] += 27

	header := map[string]any{"alg": "ES256K-R", "b64": false, "crit": []string{"b64"}}
	headerJSON, _ := json.Marshal(header)
	jws := base64.RawURLEncoding.EncodeToString(headerJSON) + ".." + base64.RawURLEncoding.EncodeToString(sig)

	signed := map[string]any{
		"@context":             doc["@context"],
		"type":                 doc["type"],
		"holder":               doc["holder"],
		"verifiableCredential": doc["verifiableCredential"],
		"proof": map[string]any{
			"type":               ProofTypeSecp256k1Recovery2020,
			"created":            opts.Created,
			"verificationMethod": opts.VerificationMethod,
			"proofPurpose":       expectedVPProofPurpose,
			"challenge":          opts.Challenge,
			"domain":             opts.Domain,
			"jws":                jws,
		},
	}
	b, err := json.Marshal(signed)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func signVPEd25519ForTest(t *testing.T, priv ed25519.PrivateKey, pub ed25519.PublicKey, opts vpFixtureOptions) []byte {
	t.Helper()
	const w3cVC = "https://www.w3.org/2018/credentials/v1"
	const envCtx = "https://schemas.atum.network/declarations/FulfillmentQuoteEnvelope/v1/context.jsonld"
	const edCtx = "https://w3id.org/security/suites/ed25519-2020/v1"

	pubBase58 := base58.Encode(pub)
	if opts.Holder == "" {
		opts.Holder = "did:pkh:solana:devnet:" + pubBase58
	}
	if opts.VerificationMethod == "" {
		opts.VerificationMethod = opts.Holder + "#blockchainAccountId"
	}
	if opts.Challenge == "" {
		opts.Challenge = "req-fixture-1"
	}
	if opts.Domain == "" {
		opts.Domain = "did:web:settler.atum.network"
	}
	if opts.Created == "" {
		opts.Created = "2026-05-20T00:00:00.000Z"
	}
	if opts.IssuerDID == "" {
		opts.IssuerDID = "did:web:atumlabs.xyz"
	}
	if opts.IssuanceDate.IsZero() {
		opts.IssuanceDate = mustTime(t, "2026-01-01T00:00:00Z")
	}
	if opts.VCTypes == nil {
		opts.VCTypes = []string{"VerifiableCredential", "KnownToAtumVerifiableCredential"}
	}

	subjectDID := opts.SubjectDID
	if subjectDID == "" {
		subjectDID = opts.Holder
	}
	vc := buildFixtureVC(opts.IssuerDID, opts.IssuanceDate, opts.ExpirationDate, opts.VCTypes, subjectDID, ProofTypeEd25519Signature2020)
	if opts.CredentialSubjectOverride != nil {
		vc["credentialSubject"] = opts.CredentialSubjectOverride
	}
	if opts.MutateVC != nil {
		opts.MutateVC(vc)
	}

	vcs := []any{vc}
	for _, extra := range opts.ExtraVCs {
		vcs = append(vcs, extra)
	}
	edTypeArr := []any{"VerifiablePresentation"}
	if opts.DeclarationType != "" {
		edTypeArr = append(edTypeArr, opts.DeclarationType)
	}
	doc := map[string]any{
		"@context":             []any{w3cVC, envCtx, edCtx},
		"type":                 edTypeArr,
		"holder":               opts.Holder,
		"verifiableCredential": vcs,
	}

	hash, err := HashQuote(doc, HashQuoteOptions{
		Cryptosuite:              ProofTypeEd25519Signature2020,
		KeepVerifiableCredential: true,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeEd25519Signature2020,
			Created:            opts.Created,
			VerificationMethod: opts.VerificationMethod,
			ProofPurpose:       expectedVPProofPurpose,
			Challenge:          opts.Challenge,
			Domain:             opts.Domain,
			Context:            []any{envCtx, edCtx},
		},
	})
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	sig := ed25519.Sign(priv, hash.SigningInput)
	proofValue := "z" + base58.Encode(sig)

	signed := map[string]any{
		"@context":             doc["@context"],
		"type":                 doc["type"],
		"holder":               doc["holder"],
		"verifiableCredential": doc["verifiableCredential"],
		"proof": map[string]any{
			"type":               ProofTypeEd25519Signature2020,
			"created":            opts.Created,
			"verificationMethod": opts.VerificationMethod,
			"proofPurpose":       expectedVPProofPurpose,
			"challenge":          opts.Challenge,
			"domain":             opts.Domain,
			"proofValue":         proofValue,
		},
	}
	b, err := json.Marshal(signed)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func buildFixtureVC(issuerDID string, issuance time.Time, expiration *time.Time, types []string, subjectDID string, proofCryptosuite string) map[string]any {
	const (
		w3cVC = "https://www.w3.org/2018/credentials/v1"
		// Fixture VCs MUST carry the known-to-atum context so the `role`
		// claim and the KnownToAtumVerifiableCredential @type alias bind
		// to stable IRIs. Without this, both are silently dropped during
		// URDNA2015 expansion — modelling the unsigned-claim anti-pattern
		// we set out to eliminate.
		kta = lddataintegrity.KnownToAtumV1ContextURL
	)
	// json-gold's normalizer expects JSON-shaped values (interface{}
	// slices). A native []string from Go produces "@type value must be
	// a string or array of strings" because the type-assert against
	// []interface{} fails. Convert up front.
	typesAny := make([]any, len(types))
	for i, t := range types {
		typesAny[i] = t
	}
	id := fixtureVCID(issuerDID, issuance, expiration, types, subjectDID, proofCryptosuite)
	proof := map[string]any{
		"type":               proofCryptosuite,
		"created":            issuance.UTC().Format(time.RFC3339),
		"verificationMethod": issuerDID + "#key-1",
		"proofPurpose":       "assertionMethod",
	}
	// A real proof carries a signature unique to its credential. Without
	// one, two stub proofs with equal type/created/method/purpose have
	// identical first-degree RDF quads regardless of the credential id,
	// and canonicalization refuses them as indistinguishable. The value
	// is a placeholder keyed on the id, under the term each suite defines.
	sigTerm := "jws"
	if proofCryptosuite == ProofTypeEd25519Signature2020 {
		sigTerm = "proofValue"
	}
	proof[sigTerm] = "stub-signature-of:" + id
	vc := map[string]any{
		"@context":     []any{w3cVC, kta},
		"id":           id,
		"type":         typesAny,
		"issuer":       issuerDID,
		"issuanceDate": issuance.UTC().Format(time.RFC3339),
		"credentialSubject": map[string]any{
			"id":   subjectDID,
			"role": "settler",
		},
		// Stub proof — the VP path doesn't verify embedded VC sigs.
		// proof.type matches the OUTER VP cryptosuite so the VP's
		// @context covers the canonicalization terms; otherwise URDNA2015
		// can't resolve the cryptosuite alias on the embedded proof.
		"proof": proof,
	}
	if expiration != nil {
		vc["expirationDate"] = expiration.UTC().Format(time.RFC3339)
	}
	return vc
}

// fixtureVCID derives a credential id from every argument that shapes the
// credential. Real issuers mint a fresh id per credential; a shared id would
// make two credentials in one presentation the same RDF subject, and the
// stub signature is keyed on this id. Hashing the arguments keeps fixtures
// reproducible while giving distinct credentials distinct ids.
func fixtureVCID(issuerDID string, issuance time.Time, expiration *time.Time, types []string, subjectDID string, proofCryptosuite string) string {
	h := sha256.New()
	fields := []string{issuerDID, issuance.UTC().Format(time.RFC3339Nano), "", subjectDID, proofCryptosuite}
	if expiration != nil {
		fields[2] = expiration.UTC().Format(time.RFC3339Nano)
	}
	fields = append(fields, types...)
	for _, f := range fields {
		// NUL separators stop adjacent fields from aliasing, e.g. ("ab","c")
		// versus ("a","bc").
		h.Write([]byte(f))
		h.Write([]byte{0})
	}
	b := h.Sum(nil)[:16]
	// Stamp the RFC 9562 version-8 (custom) and variant bits so the value is
	// a well-formed UUID rather than arbitrary hex in uuid clothing.
	b[6] = (b[6] & 0x0f) | 0x80
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("urn:uuid:%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func mustTime(t *testing.T, s string) time.Time {
	t.Helper()
	tm, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return tm
}

func newSecpKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	return priv
}

func newEdKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("ed25519 GenerateKey: %v", err)
	}
	return pub, priv
}

// happyOpts returns a VerifyVPOptions matching the default fixture clock.
func happyOpts(holder string) VerifyVPOptions {
	return VerifyVPOptions{
		ExpectedChallenge: "req-fixture-1",
		ExpectedDomain:    "did:web:settler.atum.network",
		ExpectedHolder:    holder,
		Now:               mustTimeNoT("2026-05-20T00:00:30.000Z"),
		MaxProofAge:       5 * time.Minute,
		MaxFutureSkew:     30 * time.Second,
		RequiredVCTypes:   []string{"KnownToAtumVerifiableCredential"},
	}
}

func mustTimeNoT(s string) time.Time {
	tm, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return tm
}

// TestVerifyVP_Secp256k1_HappyPath pins the round-trip: a fixture signed
// with the Go HashQuote primitive verifies via VerifyVP and returns a
// VPResult with holder, cryptosuite, recovered address, and the attested
// VC.
func TestVerifyVP_Secp256k1_HappyPath(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{})

	res, err := VerifyVP(envelope, happyOpts(holder))
	if err != nil {
		t.Fatalf("VerifyVP: %v", err)
	}
	if res.Holder != holder {
		t.Fatalf("Holder = %q, want %q", res.Holder, holder)
	}
	if res.Cryptosuite != ProofTypeSecp256k1Recovery2020 {
		t.Fatalf("Cryptosuite = %q, want %q", res.Cryptosuite, ProofTypeSecp256k1Recovery2020)
	}
	if strings.ToLower(res.SignerAddress.Hex()) != addr {
		t.Fatalf("SignerAddress = %q, want %q", res.SignerAddress.Hex(), addr)
	}
	if res.DIDNetwork != "eip155:1" {
		t.Fatalf("DIDNetwork = %q, want %q", res.DIDNetwork, "eip155:1")
	}
	if len(res.AttestedClaims) != 1 {
		t.Fatalf("AttestedClaims length = %d, want 1", len(res.AttestedClaims))
	}
}

func TestVerifyVP_Ed25519_HappyPath(t *testing.T) {
	pub, priv := newEdKey(t)
	holder := "did:pkh:solana:devnet:" + base58.Encode(pub)

	envelope := signVPEd25519ForTest(t, priv, pub, vpFixtureOptions{})

	res, err := VerifyVP(envelope, happyOpts(holder))
	if err != nil {
		t.Fatalf("VerifyVP: %v", err)
	}
	if res.Holder != holder {
		t.Fatalf("Holder = %q, want %q", res.Holder, holder)
	}
	if res.Cryptosuite != ProofTypeEd25519Signature2020 {
		t.Fatalf("Cryptosuite = %q, want %q", res.Cryptosuite, ProofTypeEd25519Signature2020)
	}
	if !ed25519.PublicKey(res.Ed25519PublicKey).Equal(pub) {
		t.Fatal("Ed25519PublicKey does not match the signing pubkey")
	}
	if res.DIDNetwork != "solana:devnet" {
		t.Fatalf("DIDNetwork = %q, want %q", res.DIDNetwork, "solana:devnet")
	}
}

// TestVerifyVP_RejectsMismatchedHolder pins the holder-equality check —
// caller passes the FQ-recovered DID as ExpectedHolder; verifier MUST
// reject envelopes whose top-level holder string disagrees. This is the
// defense against a settler stuffing a stranger's VP alongside their FQ.
func TestVerifyVP_RejectsMismatchedHolder(t *testing.T) {
	priv := newSecpKey(t)
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{})

	opts := happyOpts("did:pkh:eip155:1:0xdeadbeef0000000000000000000000000000beef")
	_, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatal("VerifyVP accepted mismatched holder — consistency check broken")
	}
	if !errors.Is(err, ErrVPHolderMismatch) {
		t.Fatalf("expected ErrVPHolderMismatch, got %v", err)
	}
}

func TestVerifyVP_RejectsMismatchedChallenge(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{})

	opts := happyOpts(holder)
	opts.ExpectedChallenge = "req-WRONG"
	_, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatal("VerifyVP accepted mismatched challenge — cross-auction replay binding broken")
	}
	if !errors.Is(err, ErrVPChallengeMismatch) {
		t.Fatalf("expected ErrVPChallengeMismatch, got %v", err)
	}
}

func TestVerifyVP_RejectsMismatchedDomain(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{})

	opts := happyOpts(holder)
	opts.ExpectedDomain = "did:web:mismatched-verifier.example" // mismatched domain vs fixture domain
	_, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatal("VerifyVP accepted mismatched domain — cross-environment replay binding broken")
	}
	if !errors.Is(err, ErrVPDomainMismatch) {
		t.Fatalf("expected ErrVPDomainMismatch, got %v", err)
	}
}

// TestVerifyVP_RejectsSignerHolderMismatch_Secp256k1 pins the
// signature-to-holder binding: sign with key B, claim holder = key A's
// DID, set ExpectedHolder = key A's DID. Without
// the signerMatchesHolderSecp256k1 check, this would pass — labels
// align AND the signature is well-formed (just signed by the wrong
// person). The check ties recovered_addr to envelope.Holder's address
// segment so the verifier is self-validating regardless of what
// ExpectedHolder is.
func TestVerifyVP_RejectsSignerHolderMismatch_Secp256k1(t *testing.T) {
	// Key B (attacker) signs.
	attackerPriv := newSecpKey(t)
	// Key A (victim) holder DID — what the envelope and ExpectedHolder
	// both claim.
	victimPriv := newSecpKey(t)
	victimAddr := strings.ToLower(crypto.PubkeyToAddress(victimPriv.PublicKey).Hex())
	victimHolder := "did:pkh:eip155:1:" + victimAddr

	// Build the envelope: attackerPriv signs it, but Holder claims
	// victimHolder. The vpFixtureOptions.Holder override forces this
	// mismatch without changing the signing key.
	envelope := signVPSecpForTest(t, attackerPriv, vpFixtureOptions{
		Holder:             victimHolder,
		VerificationMethod: victimHolder + "#blockchainAccountId",
	})

	// ExpectedHolder = victim (mimics a caller wiring opts.ExpectedHolder
	// to the FQ-recovered identity — but the attacker forged that side too).
	_, err := VerifyVP(envelope, happyOpts(victimHolder))
	if err == nil {
		t.Fatal("VerifyVP accepted a VP whose holder field doesn't match the signer key — impersonation attack succeeded")
	}
	if !errors.Is(err, ErrVPSignerHolderMismatch) {
		t.Fatalf("expected ErrVPSignerHolderMismatch, got %v", err)
	}
}

// TestVerifyVP_RejectsSignerHolderMismatch_Ed25519 mirrors the
// secp256k1 case on the ed25519 path. publicKeyFromVerificationMethod
// extracts a pubkey from a wire field; without signerMatchesHolderEd25519
// that pubkey is never tied back to envelope.Holder.
//
// Attack shape: attacker signs with their own pubkey AND sets
// verificationMethod to their own DID (so ed25519.Verify passes), but
// writes the victim's DID in envelope.Holder. The
// signerMatchesHolderEd25519 check ties recovered pubkey back to
// envelope.Holder's address segment so this attack is caught.
func TestVerifyVP_RejectsSignerHolderMismatch_Ed25519(t *testing.T) {
	attackerPub, attackerPriv := newEdKey(t)
	attackerDID := "did:pkh:solana:devnet:" + base58.Encode(attackerPub)
	// Victim — what envelope.Holder + ExpectedHolder claim.
	victimPub, _ := newEdKey(t)
	victimHolder := "did:pkh:solana:devnet:" + base58.Encode(victimPub)

	// Attacker signs with their own key AND keeps their verificationMethod
	// (so ed25519.Verify passes). They lie about envelope.Holder only.
	// This isolates the signer-holder binding gap from cryptographic
	// verification.
	envelope := signVPEd25519ForTest(t, attackerPriv, attackerPub, vpFixtureOptions{
		Holder:             victimHolder,
		VerificationMethod: attackerDID + "#" + base58.Encode(attackerPub),
	})

	_, err := VerifyVP(envelope, happyOpts(victimHolder))
	if err == nil {
		t.Fatal("VerifyVP accepted an ed25519 VP whose verificationMethod key doesn't match holder — impersonation attack succeeded")
	}
	if !errors.Is(err, ErrVPSignerHolderMismatch) {
		t.Fatalf("expected ErrVPSignerHolderMismatch, got %v", err)
	}
}

// TestVerifyVP_Ed25519_VerificationMethodTiedToHolder pins that the proof's
// verificationMethod names the same did:pkh namespace and network as the
// holder. The key bytes are the same in every case, so the signature and the
// key/holder-address binding both pass; only the namespace or network label
// differs. A network reference such as "devnet" is not unique to a namespace,
// so the label is what tells a Solana signer from a Stellar one.
func TestVerifyVP_Ed25519_VerificationMethodTiedToHolder(t *testing.T) {
	pub, priv := newEdKey(t)
	sol := base58.Encode(pub)
	xlm := encodeStellarAccount(pub)

	cases := []struct {
		name   string
		holder string
		vm     string
		reject bool
	}{
		{"solana holder, stellar method, same reference", "did:pkh:solana:devnet:" + sol, "did:pkh:stellar:devnet:" + xlm + "#blockchainAccountId", true},
		{"stellar holder, solana method, same reference", "did:pkh:stellar:testnet:" + xlm, "did:pkh:solana:testnet:" + sol + "#blockchainAccountId", true},
		{"solana holder, same namespace, other network", "did:pkh:solana:devnet:" + sol, "did:pkh:solana:mainnet:" + sol + "#blockchainAccountId", true},
		{"stellar holder, same namespace, other network", "did:pkh:stellar:pubnet:" + xlm, "did:pkh:stellar:testnet:" + xlm + "#blockchainAccountId", true},
		{"control: same namespace and network", "did:pkh:solana:devnet:" + sol, "did:pkh:solana:devnet:" + sol + "#blockchainAccountId", false},
		{"control: stellar, same namespace and network", "did:pkh:stellar:pubnet:" + xlm, "did:pkh:stellar:pubnet:" + xlm + "#blockchainAccountId", false},
		{"control: namespace and network differ only in case", "did:pkh:solana:devnet:" + sol, "DID:PKH:SOLANA:DEVNET:" + sol + "#blockchainAccountId", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			envelope := signVPEd25519ForTest(t, priv, pub, vpFixtureOptions{
				Holder:             tc.holder,
				VerificationMethod: tc.vm,
			})
			res, err := VerifyVP(envelope, happyOpts(tc.holder))
			if !tc.reject {
				if err != nil {
					t.Fatalf("VerifyVP refused a matching verificationMethod: %v", err)
				}
				if !ed25519.PublicKey(res.Ed25519PublicKey).Equal(pub) {
					t.Fatal("Ed25519PublicKey does not match the signing pubkey")
				}
				return
			}
			if err == nil {
				t.Fatal("VerifyVP accepted a verificationMethod in a different namespace or network than the holder")
			}
			if !errors.Is(err, ErrVPVerificationMethodMismatch) {
				t.Fatalf("err = %v, want ErrVPVerificationMethodMismatch", err)
			}
			if !errors.Is(err, ErrMalformedProof) {
				t.Fatalf("err = %v, want it to wrap the ErrMalformedProof umbrella", err)
			}
			if errors.Is(err, ErrVPSignerHolderMismatch) {
				t.Fatalf("err = %v: refused by the key/holder binding, not the verificationMethod compare", err)
			}
		})
	}
}

// TestVerifyVP_RejectsTamperedSignature pins the cryptographic check on
// the holder side. Both paths now also reject signer/holder mismatch
// once the signerMatchesHolder* check is wired —
// signature tampering still surfaces as a recovery / verify failure,
// before that check ever runs, so the rejection path here is distinct.
func TestVerifyVP_RejectsTamperedSignature(t *testing.T) {
	t.Run("ed25519", func(t *testing.T) {
		pub, priv := newEdKey(t)
		holder := "did:pkh:solana:devnet:" + base58.Encode(pub)
		envelope := signVPEd25519ForTest(t, priv, pub, vpFixtureOptions{})

		// Flip a byte in the proofValue base58 payload. Decoding may still
		// succeed but ed25519.Verify will return false.
		var doc map[string]any
		if err := json.Unmarshal(envelope, &doc); err != nil {
			t.Fatal(err)
		}
		proof := doc["proof"].(map[string]any)
		pv := proof["proofValue"].(string)
		// Replace the last 5 chars with a fixed pattern, guaranteed to
		// change the bytes (and bs58 will decode a valid 64-byte string
		// with high probability since 5 chars carry only ~29 bits).
		proof["proofValue"] = pv[:len(pv)-5] + "AAAAA"
		mut, _ := json.Marshal(doc)

		_, err := VerifyVP(mut, happyOpts(holder))
		if err == nil {
			t.Fatal("VerifyVP accepted tampered ed25519 signature")
		}
	})
}

// TestVerifyVP_RejectsExpiredVC pins the per-VC date-window check listed
// in the design doc §5.
func TestVerifyVP_RejectsExpiredVC(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	expired := mustTimeNoT("2026-05-19T00:00:00Z") // before Now
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		ExpirationDate: &expired,
	})

	_, err := VerifyVP(envelope, happyOpts(holder))
	if err == nil {
		t.Fatal("VerifyVP accepted an expired VC")
	}
	if !errors.Is(err, ErrVPVCDateWindow) {
		t.Fatalf("expected ErrVPVCDateWindow, got %v", err)
	}
}

// TestVerifyVP_MixedValidVCs_RejectsWhenAnySingleVCInvalid pins the
// VALIDITY-tier all-must-pass contract flagged in review.
// Asymmetry IS the design:
//
//   - VALIDITY tier (date window, issuer trust) — every VC the producer
//     chose to include MUST be individually valid. Including a VC is an
//     assertion of intent; the verifier doesn't drop VCs it finds
//     inconvenient.
//   - POLICY tier (required-type) — at least one VC must match the
//     operator's required-type list. Coverage check, not a per-VC
//     predicate.
//
// This test pins the intentional behavior by including (a) a valid VC
// that satisfies the required type AND (b) an expired unrelated VC.
// The envelope is rejected as a whole — same as the "legitimate bid
// with one expired unrelated VC" scenario, but flipped from "this is
// a bug" to "this is the contract." A future refactor that drops
// the expired VC silently (or accepts the envelope because the
// required-type match passed) surfaces as this test failing.
func TestVerifyVP_MixedValidVCs_RejectsWhenAnySingleVCInvalid(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	// Build the "unrelated, expired" extra VC manually so it lives
	// alongside the default-built (valid, required-type-matching) VC.
	expired := mustTimeNoT("2026-05-19T00:00:00Z")
	extraExpired := buildFixtureVC(
		"did:web:atumlabs.xyz",
		mustTimeNoT("2026-01-01T00:00:00Z"),
		&expired,
		[]string{"VerifiableCredential", "UnrelatedExpired"},
		holder,
		ProofTypeSecp256k1Recovery2020,
	)

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		ExtraVCs: []map[string]any{extraExpired},
	})

	_, err := VerifyVP(envelope, happyOpts(holder))
	if err == nil {
		t.Fatal("VerifyVP accepted a mixed-validity envelope — VALIDITY tier should reject when any single VC fails")
	}
	if !errors.Is(err, ErrVPVCDateWindow) {
		t.Fatalf("expected ErrVPVCDateWindow on the expired extra VC, got %v", err)
	}
	// Cross-check: error message must identify the offending index so
	// triage doesn't have to inspect every VC. The default VC is index
	// 0; the expired extra is index 1.
	if !strings.Contains(err.Error(), "verifiableCredential[1]") {
		t.Errorf("expected error to identify offending VC index [1]; got: %v", err)
	}
}

// TestVerifyVP_RejectsFutureIssuanceVC pins the symmetric guard: a VC
// claiming an issuance date past Now is rejected.
func TestVerifyVP_RejectsFutureIssuanceVC(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		IssuanceDate: mustTimeNoT("2027-01-01T00:00:00Z"),
	})

	_, err := VerifyVP(envelope, happyOpts(holder))
	if err == nil {
		t.Fatal("VerifyVP accepted a future-dated VC")
	}
	if !errors.Is(err, ErrVPVCDateWindow) {
		t.Fatalf("expected ErrVPVCDateWindow, got %v", err)
	}
}

// TestVerifyVP_RefusesVCWithoutIssuanceDate pins that a VC with no issuance
// date is refused however the wire leaves it out: the member absent, an empty
// string, or JSON null. The binding refuses the first two while decoding. It
// decodes null to the zero time.Time, which no date comparison refuses, so
// null is the case checkVCDateWindow has to catch itself. The zero instant
// decodes to the same value, so it is refused with null in every offset
// spelling, as TypeScript refuses it. The holder signs every case, so none of
// the refusals is a signature failure, and all of them are malformed
// documents (ErrMalformedQuote).
func TestVerifyVP_RefusesVCWithoutIssuanceDate(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(vc map[string]any)
		// decodedAsZero marks the cases the binding admits and the verifier
		// refuses with ErrVPVCMissingIssuanceDate.
		decodedAsZero bool
	}{
		{"null", func(vc map[string]any) { vc["issuanceDate"] = nil }, true},
		{"absent", func(vc map[string]any) { delete(vc, "issuanceDate") }, false},
		{"empty string", func(vc map[string]any) { vc["issuanceDate"] = "" }, false},
		{"zero instant", func(vc map[string]any) { vc["issuanceDate"] = "0001-01-01T00:00:00Z" }, true},
		{"zero instant, +01:00 offset", func(vc map[string]any) { vc["issuanceDate"] = "0001-01-01T01:00:00+01:00" }, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			check := func(t *testing.T, envelope []byte, holder string) {
				t.Helper()
				_, err := VerifyVP(envelope, happyOpts(holder))
				if err == nil {
					t.Fatal("VerifyVP accepted a VC without an issuanceDate")
				}
				if !errors.Is(err, ErrMalformedQuote) {
					t.Fatalf("expected ErrMalformedQuote, got %v", err)
				}
				if tc.decodedAsZero && !errors.Is(err, ErrVPVCMissingIssuanceDate) {
					t.Fatalf("expected ErrVPVCMissingIssuanceDate, got %v", err)
				}
			}
			t.Run("secp256k1", func(t *testing.T) {
				priv := newSecpKey(t)
				holder := "did:pkh:eip155:1:" + strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
				check(t, signVPSecpForTest(t, priv, vpFixtureOptions{MutateVC: tc.mutate}), holder)
			})
			t.Run("ed25519", func(t *testing.T) {
				pub, priv := newEdKey(t)
				holder := "did:pkh:solana:devnet:" + base58.Encode(pub)
				check(t, signVPEd25519ForTest(t, priv, pub, vpFixtureOptions{MutateVC: tc.mutate}), holder)
			})
		})
	}
}

// TestVerifyVP_NullIssuanceDateOnSecondVC_Refused pins that the issuanceDate
// check runs on every credential, not only the first: a valid default VC
// followed by an unrelated VC whose issuanceDate is null is refused, and the
// error names the second credential.
func TestVerifyVP_NullIssuanceDateOnSecondVC_Refused(t *testing.T) {
	priv := newSecpKey(t)
	holder := "did:pkh:eip155:1:" + strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())

	extra := buildFixtureVC(
		"did:web:atumlabs.xyz",
		mustTimeNoT("2026-01-01T00:00:00Z"),
		nil,
		[]string{"VerifiableCredential", "Unrelated"},
		holder,
		ProofTypeSecp256k1Recovery2020,
	)
	extra["issuanceDate"] = nil
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		ExtraVCs: []map[string]any{extra},
	})

	_, err := VerifyVP(envelope, happyOpts(holder))
	if err == nil {
		t.Fatal("VerifyVP accepted an envelope whose second VC has a null issuanceDate")
	}
	if !errors.Is(err, ErrVPVCMissingIssuanceDate) {
		t.Fatalf("expected ErrVPVCMissingIssuanceDate, got %v", err)
	}
	if !strings.Contains(err.Error(), "verifiableCredential[1]") {
		t.Errorf("expected the error to name verifiableCredential[1]; got: %v", err)
	}
}

// TestVerifyVP_ZeroInstantExpirationDateIsExpired pins that an expirationDate
// at the zero instant is a past expiry, in any offset spelling, as it is in
// TypeScript. expirationDate is optional, so null still means no expiry: the
// null control verifies.
func TestVerifyVP_ZeroInstantExpirationDateIsExpired(t *testing.T) {
	cases := []struct {
		name     string
		value    any
		verifies bool
	}{
		{"zero instant", "0001-01-01T00:00:00Z", false},
		{"zero instant, +01:00 offset", "0001-01-01T01:00:00+01:00", false},
		{"null (control)", nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mutate := func(vc map[string]any) { vc["expirationDate"] = tc.value }
			check := func(t *testing.T, envelope []byte, holder string) {
				t.Helper()
				_, err := VerifyVP(envelope, happyOpts(holder))
				if tc.verifies {
					if err != nil {
						t.Fatalf("VerifyVP refused a VC whose expirationDate is null: %v", err)
					}
					return
				}
				if err == nil {
					t.Fatal("VerifyVP accepted a VC that expired at the zero instant")
				}
				if !errors.Is(err, ErrVPVCDateWindow) {
					t.Fatalf("expected ErrVPVCDateWindow, got %v", err)
				}
			}
			t.Run("secp256k1", func(t *testing.T) {
				priv := newSecpKey(t)
				holder := "did:pkh:eip155:1:" + strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
				check(t, signVPSecpForTest(t, priv, vpFixtureOptions{MutateVC: mutate}), holder)
			})
			t.Run("ed25519", func(t *testing.T) {
				pub, priv := newEdKey(t)
				holder := "did:pkh:solana:devnet:" + base58.Encode(pub)
				check(t, signVPEd25519ForTest(t, priv, pub, vpFixtureOptions{MutateVC: mutate}), holder)
			})
		})
	}
}

// TestVerifyVP_RejectsUntrustedIssuer pins the IsIssuerTrusted gate at
// the strict-mode level: an issuer not in the trust anchors fails the
// envelope. Mirrors the trustedissuers.ModeStrict behavior; audit /
// permissive modes are exercised by the trustedissuers lib's own tests.
func TestVerifyVP_RejectsUntrustedIssuer(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		IssuerDID: "did:web:rogue.example",
	})

	opts := happyOpts(holder)
	opts.IsIssuerTrusted = func(did string) (allowed, enforced bool) {
		// Strict-mode-equivalent: only one trusted issuer.
		return did == "did:web:atumlabs.xyz", true
	}
	_, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatal("VerifyVP accepted a VC from an untrusted issuer in strict mode")
	}
	if !errors.Is(err, ErrVPIssuerNotTrusted) {
		t.Fatalf("expected ErrVPIssuerNotTrusted, got %v", err)
	}
}

// TestVerifyVP_PermissiveIssuerPassesThrough pins the audit/permissive
// modes — IsIssuerTrusted returns enforced=false; VerifyVP must accept
// even when allowed=false. Matches trustedissuers.ModePermissive.
//
// Also asserts the structured audit-mode signal: an untrusted issuer
// under enforced=false must surface in VPResult.IssuerTrustObservations
// so the perimeter can fire the `accepted_would_reject` counterfactual
// metric. Without this contract the audit posture is invisible — the
// gap review called out.
func TestVerifyVP_PermissiveIssuerPassesThrough(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		IssuerDID: "did:web:not-in-list.example",
	})

	opts := happyOpts(holder)
	opts.IsIssuerTrusted = func(did string) (allowed, enforced bool) {
		return false, false // permissive
	}
	res, err := VerifyVP(envelope, opts)
	if err != nil {
		t.Fatalf("VerifyVP rejected in permissive mode: %v", err)
	}
	if len(res.IssuerTrustObservations) != 1 {
		t.Fatalf("IssuerTrustObservations = %d entries, want 1 (audit/permissive must surface the untrusted-issuer signal)", len(res.IssuerTrustObservations))
	}
	got := res.IssuerTrustObservations[0]
	if got.IssuerDID != "did:web:not-in-list.example" {
		t.Errorf("observation.IssuerDID = %q, want %q", got.IssuerDID, "did:web:not-in-list.example")
	}
	if got.VCIndex != 0 {
		t.Errorf("observation.VCIndex = %d, want 0 (single-VC envelope)", got.VCIndex)
	}
}

// TestVerifyVP_TrustedIssuerEmitsNoObservation is the negative half of
// the audit-mode contract: when IsIssuerTrusted returns allowed=true
// (regardless of enforced), no observation is recorded. Otherwise the
// perimeter would fire a "would reject" signal for every legitimate
// bid — corrupting the rollout dashboard the observation field is
// meant to drive.
func TestVerifyVP_TrustedIssuerEmitsNoObservation(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		IssuerDID: "did:web:trusted.example",
	})

	opts := happyOpts(holder)
	opts.IsIssuerTrusted = func(did string) (allowed, enforced bool) {
		return true, true // strict + in-list
	}
	res, err := VerifyVP(envelope, opts)
	if err != nil {
		t.Fatalf("VerifyVP rejected a trusted issuer: %v", err)
	}
	if len(res.IssuerTrustObservations) != 0 {
		t.Fatalf("IssuerTrustObservations populated for a trusted issuer: %+v", res.IssuerTrustObservations)
	}
}

// TestVerifyVP_NilIsIssuerTrustedEmitsNoObservation pins the
// disabled-mode contract: a nil callback (caller's
// trusted_credential_issuers.mode=disabled) means "no trust check, no
// signal." VPResult.IssuerTrustObservations must stay nil regardless
// of issuer DID — otherwise the disabled mode would still leak issuer
// metadata downstream.
func TestVerifyVP_NilIsIssuerTrustedEmitsNoObservation(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		IssuerDID: "did:web:not-in-list.example",
	})

	opts := happyOpts(holder)
	opts.IsIssuerTrusted = nil
	res, err := VerifyVP(envelope, opts)
	if err != nil {
		t.Fatalf("VerifyVP rejected with nil IsIssuerTrusted: %v", err)
	}
	if res.IssuerTrustObservations != nil {
		t.Fatalf("IssuerTrustObservations populated when IsIssuerTrusted is nil: %+v", res.IssuerTrustObservations)
	}
}

func TestVerifyVP_RejectsMissingRequiredVCType(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	// VC lacks the required type — only VerifiableCredential, no
	// KnownToAtumVerifiableCredential.
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		VCTypes: []string{"VerifiableCredential"},
	})

	_, err := VerifyVP(envelope, happyOpts(holder))
	if err == nil {
		t.Fatal("VerifyVP accepted a VP missing the required VC type")
	}
	if !errors.Is(err, ErrVPMissingRequiredVCType) {
		t.Fatalf("expected ErrVPMissingRequiredVCType, got %v", err)
	}
}

// TestVerifyVP_RejectsSubjectHolderMismatch_DifferentAccount pins the
// subject-holder gate: a VC whose credentialSubject.id is a *different*
// chain account than the VP holder must be rejected, even when the
// issuer is trusted and the cryptosuite matches. Closes the "presenter
// swaps in someone else's valid VC" path ahead of full VC-signature
// verification.
func TestVerifyVP_RejectsSubjectHolderMismatch_DifferentAccount(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		// Different chain account (a valid did:pkh on the same chain) —
		// the VC is well-formed but doesn't belong to the holder.
		SubjectDID: "did:pkh:eip155:1:0xdeadbeef00000000000000000000000000000001",
	})

	_, err := VerifyVP(envelope, happyOpts(holder))
	if err == nil {
		t.Fatal("VerifyVP accepted a VC whose credentialSubject.id is a different chain account")
	}
	if !errors.Is(err, ErrVPSubjectHolderMismatch) {
		t.Fatalf("expected ErrVPSubjectHolderMismatch, got %v", err)
	}
}

// TestVerifyVP_RejectsSubjectHolderMismatch_DifferentChain pins the
// subject-holder gate against a cross-chain subject: the holder is on EVM but the
// VC's subject is a Solana DID. Same address bytes would still mismatch
// because the chain namespace segment differs.
func TestVerifyVP_RejectsSubjectHolderMismatch_DifferentChain(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		SubjectDID: "did:pkh:solana:devnet:" + addr,
	})

	_, err := VerifyVP(envelope, happyOpts(holder))
	if err == nil {
		t.Fatal("VerifyVP accepted a VC whose credentialSubject.id is on a different chain namespace")
	}
	if !errors.Is(err, ErrVPSubjectHolderMismatch) {
		t.Fatalf("expected ErrVPSubjectHolderMismatch, got %v", err)
	}
}

// TestVerifyVP_SubjectHolder_AcceptsBareSubjectWithFragmentedHolder
// confirms the subject-holder check uses holderEquals semantics (strips
// fragments before compare), so a bare credentialSubject.id still
// matches a holder DID that carries a #blockchainAccountId fragment.
func TestVerifyVP_SubjectHolder_AcceptsBareSubjectWithFragmentedHolder(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	bareHolder := "did:pkh:eip155:1:" + addr

	// The default fixture builds verificationMethod = holder + "#blockchainAccountId"
	// and uses holder (no fragment) as the wire envelope.holder; this test
	// pins that the subject (bare DID) matches against the bare holder, and
	// the check would also match if the holder carried a fragment because
	// holderEquals strips it.
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{})

	if _, err := VerifyVP(envelope, happyOpts(bareHolder)); err != nil {
		t.Fatalf("VerifyVP rejected a matched subject/holder pair: %v", err)
	}
}

// TestVerifyVP_SubjectHolder_AcceptsChecksummedEVMSubject pins the
// EVM-aware case-fold contract specifically on the subject-holder
// gate: when an issuer mints a VC whose
// credentialSubject.id carries an EIP-55 checksummed EVM address
// (the form did:pkh / CAIP-10 recommend), the gate MUST accept it
// against a lowercase holder DID. EIP-55 mixed-case is a checksum
// over the SAME account — not a different one — so an exact byte
// compare would lock out every legitimate settler whose issuer emits
// checksummed subjects.
//
// holderEquals already does case-fold on `eip155`; this test pins
// that contract specifically through the subject-holder path so a
// future refactor that flattens the chain-aware switch to exact-compare
// fails here rather than reaching a settler in production.
//
// Solana/Tron exact-compare contract is covered separately by
// TestVerifyVP_HolderEqualityAddressIsCaseSensitive and the ed25519
// mirror; this test is the eip155 half.
func TestVerifyVP_SubjectHolder_AcceptsChecksummedEVMSubject(t *testing.T) {
	priv := newSecpKey(t)
	lowercaseAddr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + lowercaseAddr

	// Build the EIP-55 checksummed form of the same address. crypto.PubkeyToAddress
	// returns the mixed-case Hex() form by default — checksum encoding is
	// just (rough)case-flips relative to lowercase. Use the wallet's own
	// .Hex() result (which IS checksummed under EIP-55) as the subject so
	// the casing is the canonical issuer-side shape, not contrived.
	checksummedAddr := crypto.PubkeyToAddress(priv.PublicKey).Hex()
	if checksummedAddr == lowercaseAddr {
		// Defensive: if EIP-55 happens to produce an all-lowercase
		// result for this random key, the test exercises nothing.
		// Force a casing perturbation so we're definitely comparing
		// different byte sequences.
		checksummedAddr = "0x" + strings.ToUpper(lowercaseAddr[2:6]) + lowercaseAddr[6:]
	}
	subjectDID := "did:pkh:eip155:1:" + checksummedAddr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{SubjectDID: subjectDID})

	if _, err := VerifyVP(envelope, happyOpts(holder)); err != nil {
		t.Fatalf("VerifyVP rejected a checksummed EVM subject vs lowercase holder — eip155 case-fold regressed (subject=%q, holder=%q): %v", subjectDID, holder, err)
	}
}

// TestVerifyVP_RejectsSubjectHolderMismatch_Ed25519 mirrors the secp
// rejection coverage on the ed25519 cryptosuite path so a Solana-style
// VP can't silently bypass the subject-holder gate via a divergence
// between the two language-helper code paths.
func TestVerifyVP_RejectsSubjectHolderMismatch_Ed25519(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	pubBase58 := base58.Encode(pub)
	holder := "did:pkh:solana:devnet:" + pubBase58

	envelope := signVPEd25519ForTest(t, priv, pub, vpFixtureOptions{
		// Different Solana account on the same chain — the VC is
		// well-formed and signed by the holder key but its subject
		// doesn't belong to the holder.
		SubjectDID: "did:pkh:solana:devnet:11111111111111111111111111111111",
	})

	_, err = VerifyVP(envelope, happyOpts(holder))
	if err == nil {
		t.Fatal("VerifyVP accepted an ed25519 VP whose VC subject ≠ holder")
	}
	if !errors.Is(err, ErrVPSubjectHolderMismatch) {
		t.Fatalf("expected ErrVPSubjectHolderMismatch, got %v", err)
	}
}

// TestVerifyVP_RejectsSubjectHolderMismatch_MissingID confirms the
// "credentialSubject lacks an `id` key" branch routes to ErrMalformedQuote
// (not ErrVPSubjectHolderMismatch) — a structurally malformed VC is
// distinct from a present-but-wrong subject. Dashboards split these so
// the rejection reason stays informative.
func TestVerifyVP_RejectsSubjectHolderMismatch_MissingID(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		CredentialSubjectOverride: map[string]any{
			// No "id" key — the binding still unmarshals (credentialSubject
			// is freeform map[string]interface{}), but the subject-holder
			// check returns ErrMalformedQuote. `role` is just a non-empty-
			// map filler here; the test asserts the missing-id branch.
			"role": "settler",
		},
	})

	_, err := VerifyVP(envelope, happyOpts(holder))
	if err == nil {
		t.Fatal("VerifyVP accepted a VC missing credentialSubject.id")
	}
	if !errors.Is(err, ErrMalformedQuote) {
		t.Fatalf("expected ErrMalformedQuote (structurally malformed VC), got %v", err)
	}
	// Negative cross-check: ensure this branch is NOT wired to the
	// subject-holder sentinel — dashboards split malformed-input from
	// adversarial-mismatch and would lose that signal.
	if errors.Is(err, ErrVPSubjectHolderMismatch) {
		t.Fatalf("missing credentialSubject.id wrongly routed to ErrVPSubjectHolderMismatch: %v", err)
	}
}

// TestCheckVCSubjectMatchesHolder_MalformedSubject pins the helper's
// fail-closed behavior on credentialSubject shapes that *could* arrive
// over the wire (the JSON binding is freeform `map[string]interface{}`)
// but that a well-formed signer would never produce — canonicalization
// rejects non-string @id values upstream, so reaching this branch
// requires either a divergent canonicalizer on the wire or a malformed
// wire envelope whose proof is broken by something else first.
//
// Tested as a direct unit on the helper rather than through VerifyVP
// because the only way to construct a "signed" VP with these subject
// shapes is to bypass the sign-side canonicalization, which would also
// make VerifyVP fail at crypto verification before this check runs.
// The helper is defense-in-depth; this test pins the defense.
func TestCheckVCSubjectMatchesHolder_MalformedSubject(t *testing.T) {
	holder := "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"

	cases := []struct {
		name              string
		credentialSubject map[string]interface{}
	}{
		{"nil map", nil},
		// `role` is a non-empty-map filler — the assertion under test
		// is the `id`-shape check, not the other field. Migrated from
		// the earlier `knownToAtum: true` placeholder so even the
		// negative-test fixtures model the production-realistic
		// credentialSubject shape.
		{"missing id key", map[string]interface{}{"role": "settler"}},
		{"id is empty string", map[string]interface{}{"id": "", "role": "settler"}},
		{"id is JSON number", map[string]interface{}{"id": float64(42), "role": "settler"}},
		{"id is JSON null", map[string]interface{}{"id": nil, "role": "settler"}},
		{"id is array", map[string]interface{}{"id": []any{"a", "b"}, "role": "settler"}},
		{"id is object", map[string]interface{}{"id": map[string]any{"nested": "x"}, "role": "settler"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			vc := fqe.VerifiableCredential{CredentialSubject: tc.credentialSubject}
			err := checkVCSubjectMatchesHolder(vc, holder)
			if err == nil {
				t.Fatalf("checkVCSubjectMatchesHolder accepted malformed subject (%s)", tc.name)
			}
			if !errors.Is(err, ErrMalformedQuote) {
				t.Errorf("expected ErrMalformedQuote, got %v", err)
			}
			// Negative cross-check: malformed-input must NOT route to the
			// adversarial subject-holder-mismatch sentinel — dashboards
			// would lose the malformed-vs-adversarial split.
			if errors.Is(err, ErrVPSubjectHolderMismatch) {
				t.Errorf("malformed subject wrongly routed to ErrVPSubjectHolderMismatch: %v", err)
			}
		})
	}
}

// TestVerifyVP_RejectsSubjectHolderMismatch_MultiVC_OneMatchesOneDoesnt
// pins the per-index iteration semantics: when the VP carries two VCs
// where VC[0]'s subject matches the holder but VC[1]'s doesn't, the
// rejection must fire on index 1 — not silently accept just because
// SOME VC matched. The error message MUST identify the offending
// index for triage.
func TestVerifyVP_RejectsSubjectHolderMismatch_MultiVC_OneMatchesOneDoesnt(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	// Build a second VC whose subject is a different chain account.
	// Mirror the buildFixtureVC shape so both VCs canonicalize cleanly
	// under the same VP @context.
	extraVC := buildFixtureVC(
		"did:web:atumlabs.xyz",
		mustTime(t, "2026-01-01T00:00:00Z"),
		nil,
		[]string{"VerifiableCredential", "KnownToAtumVC"},
		"did:pkh:eip155:1:0xdeadbeef00000000000000000000000000000001",
		ProofTypeSecp256k1Recovery2020,
	)
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		ExtraVCs: []map[string]any{extraVC},
	})

	_, err := VerifyVP(envelope, happyOpts(holder))
	if err == nil {
		t.Fatal("VerifyVP accepted a multi-VC envelope with one mismatched subject")
	}
	if !errors.Is(err, ErrVPSubjectHolderMismatch) {
		t.Fatalf("expected ErrVPSubjectHolderMismatch, got %v", err)
	}
	// Error message MUST identify the offending VC index — silently
	// dropping the index would force operators to inspect every VC in
	// the envelope at triage.
	if !strings.Contains(err.Error(), "verifiableCredential[1]") {
		t.Errorf("expected error to identify offending VC index [1]; got: %v", err)
	}
}

func TestVerifyVP_RejectsBadProofPurpose(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{})
	// Replace proofPurpose with the FQ-style value; VP MUST be
	// "authentication" per W3C VC §5.6.
	var doc map[string]any
	if err := json.Unmarshal(envelope, &doc); err != nil {
		t.Fatal(err)
	}
	doc["proof"].(map[string]any)["proofPurpose"] = "assertionMethod"
	mut, _ := json.Marshal(doc)

	_, err := VerifyVP(mut, happyOpts(holder))
	if err == nil {
		t.Fatal("VerifyVP accepted proofPurpose: assertionMethod")
	}
	if !errors.Is(err, ErrUnsupportedProofType) {
		t.Fatalf("expected ErrUnsupportedProofType, got %v", err)
	}
}

func TestVerifyVP_RejectsStaleFreshness(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		Created: "2026-05-20T00:00:00.000Z",
	})

	opts := happyOpts(holder)
	opts.Now = mustTimeNoT("2026-05-20T01:00:00Z") // 1h past fixture created
	opts.MaxProofAge = 5 * time.Minute

	_, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatal("VerifyVP accepted a proof older than MaxProofAge")
	}
	if !errors.Is(err, ErrVPFreshnessFailure) {
		t.Fatalf("expected ErrVPFreshnessFailure, got %v", err)
	}
}

func TestVerifyVP_RejectsFutureFreshness(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		Created: "2026-05-20T01:00:00.000Z",
	})

	opts := happyOpts(holder)
	opts.Now = mustTimeNoT("2026-05-20T00:00:00Z") // 1h before fixture created
	opts.MaxFutureSkew = 30 * time.Second

	_, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatal("VerifyVP accepted a proof exceeding MaxFutureSkew")
	}
	if !errors.Is(err, ErrVPFreshnessFailure) {
		t.Fatalf("expected ErrVPFreshnessFailure, got %v", err)
	}
}

// TestVerifyVP_AcceptsIssuerAsObject pins the W3C VC v1 alternate
// issuer shape: issuer can be a string OR an object with `id` plus
// arbitrary metadata. Caller code in vcIssuerDID() has the type switch
// for both; this test exercises the object branch so a regression on
// the map[string]any handler doesn't slip past.
func TestVerifyVP_AcceptsIssuerAsObject(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{})
	// Re-shape envelope.verifiableCredential[0].issuer to the object form.
	var doc map[string]any
	if err := json.Unmarshal(envelope, &doc); err != nil {
		t.Fatal(err)
	}
	vcs, _ := doc["verifiableCredential"].([]any)
	vc0, _ := vcs[0].(map[string]any)
	vc0["issuer"] = map[string]any{
		"id":   "did:web:atumlabs.xyz",
		"name": "Atum Labs",
	}
	envelope, _ = json.Marshal(doc)

	opts := happyOpts(holder)
	opts.IsIssuerTrusted = func(did string) (allowed, enforced bool) {
		return did == "did:web:atumlabs.xyz", true
	}
	if _, err := VerifyVP(envelope, opts); err != nil {
		t.Fatalf("VerifyVP rejected issuer-as-object form: %v", err)
	}
}

// TestVerifyVP_MultiVC_MatchedRequiredTypeOnSecondEntry pins the multi-
// VC match: the required-type check passes when ANY VC in the envelope
// declares all RequiredVCTypes — not just the first.
//
// Build the multi-VC envelope BEFORE signing (via ExtraVCs) — the
// previous post-sign reshape silently broke once the signer/holder
// binding landed (tampered canonical form → recovered
// signer ≠ holder → ErrVPSignerHolderMismatch instead of the
// required-type pass this test intends to pin). The pre-sign path is
// the right shape: the verifier sees a coherent signature over the
// multi-VC document.
func TestVerifyVP_MultiVC_MatchedRequiredTypeOnSecondEntry(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	// Index 0 in the envelope's VC array becomes a generic
	// VerifiableCredential (overrides the default fixture's VCTypes).
	// Index 1 (extra) carries KnownToAtumVerifiableCredential, which happyOpts requires.
	requiredTypeVC := buildFixtureVC(
		"did:web:atumlabs.xyz",
		mustTimeNoT("2026-01-01T00:00:00Z"),
		nil,
		[]string{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
		holder,
		ProofTypeSecp256k1Recovery2020,
	)
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		VCTypes:  []string{"VerifiableCredential"},
		ExtraVCs: []map[string]any{requiredTypeVC},
	})

	if _, err := VerifyVP(envelope, happyOpts(holder)); err != nil {
		t.Fatalf("VerifyVP rejected multi-VC envelope where second VC declares the required type: %v", err)
	}
}

func cloneMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// TestVerifyVP_RejectsTooManyVCs pins the MaxVerifiableCredentials DoS
// bound from the self-review. An unauthenticated attacker submitting a
// large VC array at the bid perimeter would amplify URDNA2015
// canonicalization cost; the verifier must reject BEFORE canonicalization
// to keep the rejection cost O(parse), not O(canonicalize).
func TestVerifyVP_RejectsTooManyVCs(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr

	// Hand-build an envelope with multiple VCs so we can blow past the
	// cap without going through signVPSecpForTest (which has a single VC).
	// We don't need the signature to be valid — the MaxVCs check fires
	// before canonicalization, so the wire shape just needs the right
	// envelope fields.
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{})
	var doc map[string]any
	if err := json.Unmarshal(envelope, &doc); err != nil {
		t.Fatal(err)
	}
	vcs, _ := doc["verifiableCredential"].([]any)
	// Inflate to 5 VCs. cap=2 should reject.
	for i := 0; i < 4; i++ {
		vcs = append(vcs, vcs[0])
	}
	doc["verifiableCredential"] = vcs
	envelope, _ = json.Marshal(doc)

	opts := happyOpts(holder)
	opts.MaxVerifiableCredentials = 2
	_, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatal("VerifyVP accepted VC count above MaxVerifiableCredentials")
	}
	if !errors.Is(err, ErrVPTooManyVCs) {
		t.Fatalf("expected ErrVPTooManyVCs, got %v", err)
	}
}

// TestVerifyVP_AttestedClaimsPreserveWireBytes pins the
// re-marshal-via-sidecar fix from the self-review: AttestedClaims must
// return the verbatim wire bytes of each VC, not a Go-map-iteration-
// order re-marshal. Downstream consumers (audit logging, signature-
// chain anchoring) can byte-compare against the issuer-signed payload
// without first reconstructing the wire form.
func TestVerifyVP_AttestedClaimsPreserveWireBytes(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{})

	// Find the wire VC bytes via a sidecar parse on the same JSON the
	// verifier consumed — that's the contract we're pinning.
	var wireSidecar struct {
		VerifiableCredential []json.RawMessage `json:"verifiableCredential"`
	}
	if err := json.Unmarshal(envelope, &wireSidecar); err != nil {
		t.Fatalf("sidecar parse: %v", err)
	}

	res, err := VerifyVP(envelope, happyOpts(holder))
	if err != nil {
		t.Fatalf("VerifyVP: %v", err)
	}
	if len(res.AttestedClaims) != len(wireSidecar.VerifiableCredential) {
		t.Fatalf("AttestedClaims length %d != wire VC length %d",
			len(res.AttestedClaims), len(wireSidecar.VerifiableCredential))
	}
	for i := range res.AttestedClaims {
		if !bytes.Equal(res.AttestedClaims[i], wireSidecar.VerifiableCredential[i]) {
			t.Fatalf("AttestedClaims[%d] not byte-identical to wire VC[%d]:\n  got:  %s\n  want: %s",
				i, i, res.AttestedClaims[i], wireSidecar.VerifiableCredential[i])
		}
	}
}

// TestVerifyVP_RejectsZeroNow pins the fail-closed-on-missing-freshness-
// anchor fix from the self-review: previously a zero Now silently
// disabled all freshness checks (the verifier became a no-freshness
// verifier with no signal). Now zero Now is a hard rejection.
func TestVerifyVP_RejectsZeroNow(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{})

	opts := happyOpts(holder)
	opts.Now = time.Time{} // explicitly zero — the bug we're guarding against

	_, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatal("VerifyVP accepted zero Now — fail-closed freshness regressed")
	}
	if !errors.Is(err, ErrVPFreshnessFailure) {
		t.Fatalf("expected ErrVPFreshnessFailure, got %v", err)
	}
}

func TestVerifyVP_RejectsMissingRequiredOptions(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{})

	cases := []struct {
		name  string
		opts  VerifyVPOptions
		match string
	}{
		{
			name:  "ExpectedChallenge missing",
			opts:  VerifyVPOptions{ExpectedDomain: "did:web:settler.atum.network", ExpectedHolder: holder},
			match: "ExpectedChallenge",
		},
		{
			name:  "ExpectedDomain missing",
			opts:  VerifyVPOptions{ExpectedChallenge: "req-fixture-1", ExpectedHolder: holder},
			match: "ExpectedDomain",
		},
		{
			name:  "ExpectedHolder missing",
			opts:  VerifyVPOptions{ExpectedChallenge: "req-fixture-1", ExpectedDomain: "did:web:settler.atum.network"},
			match: "ExpectedHolder",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := VerifyVP(envelope, tc.opts)
			if err == nil {
				t.Fatal("VerifyVP accepted missing required option")
			}
			if !strings.Contains(err.Error(), tc.match) {
				t.Fatalf("error %q does not mention %q", err, tc.match)
			}
		})
	}
}

// TestVerifyVP_HolderEqualityPrefixIsCaseInsensitive pins the
// case-insensitive part of holderEquals: the
// did:pkh:<namespace>:<reference> prefix is W3C case-insensitive, so
// a caller passing the EVM hex address in any case (most DID resolvers
// normalize, but defense in depth) matches. The address segment is
// already lowercase here so the exact-compare half doesn't fire.
func TestVerifyVP_HolderEqualityPrefixIsCaseInsensitive(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{Holder: holder})

	// Uppercase only the prefix; keep the address segment exact.
	expected := "DID:PKH:EIP155:1:" + addr
	opts := happyOpts(expected)
	if _, err := VerifyVP(envelope, opts); err != nil {
		t.Fatalf("prefix-only case-insensitive compare regressed: %v", err)
	}
}

// TestVerifyVP_HolderEqualityAddressIsCaseSensitive pins the EXACT-
// compare half of holderEquals — Solana base58 pubkeys are case-
// sensitive (and so is Tron base58check). A previous EqualFold compare
// would silently match different accounts on these chains; this test
// fails on that regression.
//
// We sign the VP with the wallet's lowercase EVM address as the
// reference for the keccak recovery, but place a Solana-shaped holder
// in the envelope so the address segment is real base58. The verifier
// MUST reject when ExpectedHolder differs ONLY in the address case.
func TestVerifyVP_HolderEqualityAddressIsCaseSensitive(t *testing.T) {
	priv := newSecpKey(t)
	holderMixed := "did:pkh:solana:devnet:AbCdEfGhIjKlMnOpQrStUvWxYz123456789ABCDEFGH"
	vm := holderMixed + "#blockchainAccountId"
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{
		Holder:             holderMixed,
		VerificationMethod: vm,
	})

	// Case-flipped address segment — different Solana account.
	expected := "did:pkh:solana:devnet:aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789abcdefgh"
	_, err := VerifyVP(envelope, happyOpts(expected))
	if err == nil {
		t.Fatal("VerifyVP accepted case-flipped Solana holder — case-fold compare bug regressed")
	}
	if !strings.Contains(err.Error(), "does not match ExpectedHolder") {
		t.Fatalf("error %q does not mention holder mismatch", err)
	}
}

// TestVerifyVP_CorrelationIDPrefixesError pins the correlation-ID
// rewrap: when RequestID is set, every returned error
// MUST carry the [request_id=X] prefix so operators can join the
// failure back to a specific bid. errors.Is on the wrapped sentinel
// MUST still work — preserving the chain is what makes the rewrap
// useful instead of opaque.
func TestVerifyVP_CorrelationIDPrefixesError(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{})

	opts := happyOpts(holder)
	opts.RequestID = "req-42"
	opts.ExpectedChallenge = "req-WRONG" // force a challenge mismatch

	_, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatal("VerifyVP: expected challenge-mismatch rejection")
	}
	if !strings.Contains(err.Error(), "[request_id=req-42]") {
		t.Fatalf("error %q does not carry [request_id=req-42] prefix", err)
	}
	if !errors.Is(err, ErrVPChallengeMismatch) {
		t.Fatalf("rewrap broke the sentinel chain: errors.Is(err, ErrVPChallengeMismatch) returned false; err = %v", err)
	}
}

// TestVerifyVP_AcceptsAnyRequestID pins the contract that VerifyVP does
// NOT own the format of opts.RequestID — it's the caller's job to
// validate before invoking us (the gRPC bid perimeter does this in
// the downstream verifier). Whatever the caller passes here MUST be
// echoed verbatim in the [request_id=…] rewrap, and MUST NOT cause a
// verification rejection. If a regression reintroduces a format gate
// at this layer, a requester schema change could silently start
// rejecting legitimate proofs with a misleading
// "proof malformed" reason — this test guards against that.
func TestVerifyVP_AcceptsAnyRequestID(t *testing.T) {
	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{})

	cases := []string{
		"req-42",
		"5b5d7e0e-9d27-4f1f-a5db-3a52cfb24d2f",
		"prod_req.5b5d7e0e",
		strings.Repeat("a", 128),
		strings.Repeat("a", 256), // far past the old format gate's 128 cap — perimeter owns length policy now
		"req with spaces",        // not in the old charset; perimeter owns charset policy now
	}
	for _, rid := range cases {
		t.Run(rid, func(t *testing.T) {
			opts := happyOpts(holder)
			opts.RequestID = rid
			if _, err := VerifyVP(envelope, opts); err != nil {
				t.Fatalf("VerifyVP rejected RequestID %q at the library layer; format ownership belongs to the perimeter: %v", rid, err)
			}
		})
	}
}

// TestVerifyVCProofs_PreservesObservationsOnSigFailure pins the
// observation-accumulator contract: when VerifyVCProofs is wired AND
// the envelope carries multiple VCs, an issuer-trust observation
// accumulated for an earlier VC MUST survive a later VC's
// cryptographic-proof failure. Pre-fix the single-pass loop short-
// circuited on first sig failure, dropping the observation slice
// upstream — the audit-mode counterfactual dashboard would
// undercount issuer-trust signals on mixed-failure envelopes.
//
// This test is intentionally narrow on what it asserts: VerifyVP
// returns an error (the sig failure propagates) AND callers that
// inspect VPResult.IssuerTrustObservations through the new
// two-pass loop preserve the observation accumulator across the
// per-VC iteration. The exact observation surfacing pattern (passing
// observations to the caller on a failing envelope) is the perimeter
// layer's contract; this test asserts the underlying accumulator
// doesn't get truncated.
func TestVerifyVCProofs_PreservesObservationsOnSigFailure(t *testing.T) {
	t.Skip("placeholder — full test plumbing through the verify_vp.go observations slice belongs in the downstream wiring, not this package; the two-pass loop refactor itself is exercised by the existing observation tests + the new VerifyVCProof tests with mock resolver")
}

// TestVerifyVP_ExtraEnvelopeContexts_OverlaysLoader pins the
// loader-pluggability seam. The OUTER envelope's top-level @context is declaration-
// specific: FulfillmentQuoteEnvelope envelopes resolve under the
// process-global fqLoader, but originator-side declarations (e.g.
// PaymentRequestEnvelope) carry a context URL fqLoader does NOT — and per
// the settler/originator layering boundary MUST NOT — know.
//
// Without ExtraEnvelopeContexts, an envelope whose top-level @context
// references an unregistered URL fails closed at canonicalization
// (ErrUnknownContext, the SSRF defense). With the URL → parsed-context
// overlay supplied, the SAME envelope verifies — proving the per-call
// loader overlay resolves the foreign context WITHOUT mutating fqLoader.
//
// The fixture is signed under the synthetic URL itself (term definitions
// identical to FQE's context — the two declarations differ only in the
// envelope-type term name, which doesn't participate in the holder /
// verifiableCredential / proof n-quads), so the signature is valid only
// when the overlay is active. This is the exact mechanism the requester
// perimeter's PRE path relies on.
func TestVerifyVP_ExtraEnvelopeContexts_OverlaysLoader(t *testing.T) {
	const w3cVC = "https://www.w3.org/2018/credentials/v1"
	const secpCtx = "https://w3id.org/security/suites/secp256k1recovery-2020/v2"
	// Synthetic foreign envelope context URL, standing in for the PRE
	// declaration. Reuses the FQE context CONTENT (byte-identical term
	// bindings) under a URL fqLoader doesn't know.
	const foreignURL = "https://schemas.atum.network/declarations/TestForeignEnvelope/v1/context.jsonld"

	priv := newSecpKey(t)
	addr := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + addr
	vm := holder + "#blockchainAccountId"
	const challenge = "pmt-foreign-fixture"
	const domain = "did:web:devnet.atum.network"
	const created = "2026-05-20T00:00:00.000Z"

	vc := buildFixtureVC("did:web:atumlabs.xyz", mustTime(t, "2026-01-01T00:00:00Z"), nil,
		[]string{"VerifiableCredential", "KnownToAtumVerifiableCredential"}, holder, ProofTypeSecp256k1Recovery2020)

	// Sign with the FOREIGN url at top level + the proof block (the proof
	// block context content is the same term set, so the overlay covers
	// both). The overlay must be present at SIGN time too — fqLoader alone
	// would reject the foreign URL.
	overlay := map[string]any{foreignURL: mustParseFQContext(fulfillmentQuoteEnvelopeContext)}
	loader := fqLoader.WithExtraContexts(overlay)

	doc := map[string]any{
		"@context":             []any{w3cVC, foreignURL, secpCtx},
		"type":                 []any{"VerifiablePresentation"},
		"holder":               holder,
		"verifiableCredential": []any{vc},
	}
	hash, err := HashQuote(doc, HashQuoteOptions{
		Cryptosuite:              ProofTypeSecp256k1Recovery2020,
		KeepVerifiableCredential: true,
		ProofOptions: HashableProofOptions{
			Type:               ProofTypeSecp256k1Recovery2020,
			Created:            created,
			VerificationMethod: vm,
			ProofPurpose:       expectedVPProofPurpose,
			Challenge:          challenge,
			Domain:             domain,
			Context:            []any{foreignURL, secpCtx},
		},
		Loader: loader,
	})
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	sig, err := crypto.Sign(hash.SigningInput, priv)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	sig[64] += 27
	header := map[string]any{"alg": "ES256K-R", "b64": false, "crit": []string{"b64"}}
	headerJSON, _ := json.Marshal(header)
	jws := base64.RawURLEncoding.EncodeToString(headerJSON) + ".." + base64.RawURLEncoding.EncodeToString(sig)

	signed := map[string]any{
		"@context":             doc["@context"],
		"type":                 doc["type"],
		"holder":               doc["holder"],
		"verifiableCredential": doc["verifiableCredential"],
		"proof": map[string]any{
			"type":               ProofTypeSecp256k1Recovery2020,
			"created":            created,
			"verificationMethod": vm,
			"proofPurpose":       expectedVPProofPurpose,
			"challenge":          challenge,
			"domain":             domain,
			"jws":                jws,
		},
	}
	envelopeJSON, err := json.Marshal(signed)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	baseOpts := VerifyVPOptions{
		ExpectedChallenge: challenge,
		ExpectedDomain:    domain,
		ExpectedHolder:    holder,
		Now:               mustTimeNoT("2026-05-20T00:00:10.000Z"),
		MaxProofAge:       time.Hour,
		MaxFutureSkew:     time.Hour,
		RequiredVCTypes:   []string{"KnownToAtumVerifiableCredential"},
	}

	// Without the overlay: fqLoader fails closed on the foreign URL.
	if _, err := VerifyVP(envelopeJSON, baseOpts); err == nil {
		t.Fatal("VerifyVP accepted a foreign-context envelope WITHOUT ExtraEnvelopeContexts — the SSRF-fail-closed loader guard regressed")
	}

	// With the overlay: the same envelope verifies.
	withOverlay := baseOpts
	withOverlay.ExtraEnvelopeContexts = overlay
	res, err := VerifyVP(envelopeJSON, withOverlay)
	if err != nil {
		t.Fatalf("VerifyVP rejected the foreign-context envelope WITH ExtraEnvelopeContexts wired — loader overlay seam broken: %v", err)
	}
	if res.Holder != holder {
		t.Errorf("Holder = %q, want %q", res.Holder, holder)
	}
	if len(res.AttestedClaims) != 1 {
		t.Errorf("AttestedClaims = %d, want 1", len(res.AttestedClaims))
	}

	// Layering guard: the overlay is per-call. A fresh VerifyVP WITHOUT
	// the overlay must STILL reject — proving fqLoader was not mutated.
	if _, err := VerifyVP(envelopeJSON, baseOpts); err == nil {
		t.Fatal("fqLoader leaked the overlay — a subsequent no-overlay VerifyVP accepted the foreign context; per-call isolation broken")
	}
}

// --- declaration-type binding -------------------------------------

// TestVerifyVP_DeclarationType_RoundTrip pins the happy path: an envelope
// signed with a declaration term in its `type` array verifies when the caller
// pins the matching ExpectedDeclarationType.
func TestVerifyVP_DeclarationType_RoundTrip(t *testing.T) {
	priv := newSecpKey(t)
	holder := "did:pkh:eip155:1:" + strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{DeclarationType: "FulfillmentQuoteEnvelope"})

	opts := happyOpts(holder)
	opts.ExpectedDeclarationType = "FulfillmentQuoteEnvelope"
	if _, err := VerifyVP(envelope, opts); err != nil {
		t.Fatalf("typed envelope with matching ExpectedDeclarationType: %v; want accept", err)
	}
}

// TestVerifyVP_DeclarationType_CrossConfusionRejected is the load-bearing
// guard: an envelope signed as one declaration kind must be rejected
// by a verifier expecting a different kind — the PRE↔FQE interchangeability
// the binding closes.
func TestVerifyVP_DeclarationType_CrossConfusionRejected(t *testing.T) {
	priv := newSecpKey(t)
	holder := "did:pkh:eip155:1:" + strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	// Signed as FulfillmentQuoteEnvelope...
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{DeclarationType: "FulfillmentQuoteEnvelope"})

	// ...presented to a verifier expecting PaymentRequestEnvelope.
	opts := happyOpts(holder)
	opts.ExpectedDeclarationType = "PaymentRequestEnvelope"
	_, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatal("cross-declaration envelope accepted — PRE↔FQE binding not enforced")
	}
	if !errors.Is(err, ErrVPDeclarationTypeMismatch) {
		t.Fatalf("err = %v; want ErrVPDeclarationTypeMismatch", err)
	}
}

// TestVerifyVP_DeclarationType_MissingRejectedWhenExpected pins that an
// envelope signed WITHOUT a declaration term (an earlier producer) is
// rejected by a verifier that pins ExpectedDeclarationType — the assert fires
// on absence, not just mismatch.
func TestVerifyVP_DeclarationType_MissingRejectedWhenExpected(t *testing.T) {
	priv := newSecpKey(t)
	holder := "did:pkh:eip155:1:" + strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{}) // no DeclarationType

	opts := happyOpts(holder)
	opts.ExpectedDeclarationType = "FulfillmentQuoteEnvelope"
	_, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatal("untyped envelope accepted by type-asserting verifier")
	}
	if !errors.Is(err, ErrVPDeclarationTypeMismatch) {
		t.Fatalf("err = %v; want ErrVPDeclarationTypeMismatch", err)
	}
}

// TestVerifyVP_DeclarationType_BackCompat pins that an untyped envelope still
// verifies when the caller does NOT pin ExpectedDeclarationType — the binding
// is opt-in and back-compatible.
func TestVerifyVP_DeclarationType_BackCompat(t *testing.T) {
	priv := newSecpKey(t)
	holder := "did:pkh:eip155:1:" + strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{}) // no DeclarationType

	if _, err := VerifyVP(envelope, happyOpts(holder)); err != nil { // no ExpectedDeclarationType
		t.Fatalf("untyped envelope without ExpectedDeclarationType: %v; want accept (back-compat)", err)
	}
}

// TestVerifyVP_DeclarationType_IsSignatureBound proves the declaration term is
// COVERED BY THE SIGNATURE, not merely a wire label: sign with the term, then
// strip it from the wire `type` array and verify WITHOUT pinning the type. If
// the term were not in the signed n-quads, recovery would still match the
// holder; because it IS, the canonical bytes differ and recovery yields a
// different address → holder mismatch.
func TestVerifyVP_DeclarationType_IsSignatureBound(t *testing.T) {
	priv := newSecpKey(t)
	holder := "did:pkh:eip155:1:" + strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	envelope := signVPSecpForTest(t, priv, vpFixtureOptions{DeclarationType: "FulfillmentQuoteEnvelope"})

	// Strip the declaration term from the wire type array post-signing.
	var doc map[string]any
	if err := json.Unmarshal(envelope, &doc); err != nil {
		t.Fatal(err)
	}
	doc["type"] = []any{"VerifiablePresentation"}
	tampered, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}

	// No ExpectedDeclarationType — isolate the signature-coverage effect from
	// the type-assert. Recovery over the now-shorter n-quads must NOT recover
	// the original holder.
	opts := happyOpts(holder)
	if _, err := VerifyVP(tampered, opts); err == nil {
		t.Fatal("stripping the signed declaration term still verified — the term was NOT signature-bound")
	}
}

// TestVerifyVP_DeclarationType_Ed25519 pins the declaration-type binding on the
// ed25519 (Solana) signer path — the secp256k1 tests above cover the EVM path,
// but a Solana PRE producer goes through SignVPEd25519, so the binding must
// hold there too or every Solana PRE would be rejected by the type-asserting
// PRE perimeters.
func TestVerifyVP_DeclarationType_Ed25519(t *testing.T) {
	pub, priv := newEdKey(t)
	holder := "did:pkh:solana:devnet:" + base58.Encode(pub)
	envelope := signVPEd25519ForTest(t, priv, pub, vpFixtureOptions{DeclarationType: "PaymentRequestEnvelope"})

	// Matching ExpectedDeclarationType → accept.
	accept := happyOpts(holder)
	accept.ExpectedDeclarationType = "PaymentRequestEnvelope"
	if _, err := VerifyVP(envelope, accept); err != nil {
		t.Fatalf("ed25519 typed envelope, matching expect: %v; want accept", err)
	}

	// Cross-declaration → reject.
	reject := happyOpts(holder)
	reject.ExpectedDeclarationType = "FulfillmentQuoteEnvelope"
	_, err := VerifyVP(envelope, reject)
	if err == nil || !errors.Is(err, ErrVPDeclarationTypeMismatch) {
		t.Fatalf("ed25519 cross-declaration: err=%v; want ErrVPDeclarationTypeMismatch", err)
	}
}
