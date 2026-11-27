package ldverification

// Holder-issued VC carve-out tests. The originator (VP holder) mints a
// SenderComplianceCredential about a third-party sender wallet under its
// own did:pkh key. These tests pin the security invariants of the
// carve-out:
//
//   - issuer==holder is enforced in ALL modes (never mode-gated),
//   - the carve-out applies ONLY to types listed in HolderIssuedVCTypes,
//   - did:pkh issuers never touch the did:web resolver,
//   - carved VCs don't satisfy RequiredVCTypes for other types,
//   - carved VCs are excluded from issuer-trust observations,
//   - date-window checks still apply.

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/mr-tron/base58"
)

const senderComplianceVCTypeForTest = "SenderComplianceCredential"

// holderDIDForKey derives the eip155:1 did:pkh for a secp key — the
// same chain-canonical (lowercased-address) form the fixtures use.
func holderDIDForKey(priv *ecdsa.PrivateKey) string {
	return "did:pkh:eip155:1:" + strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
}

// mintTrustedVCForSubject mints a did:web-issuer-signed
// KnownToAtumVerifiableCredential about `subjectDID`, using the public
// SignVCProofSecp256k1WithCreatedString signer so the proof shape is
// byte-for-byte the production issuer's. The resolver side is
// issuerVMSet (verify_vc_test.go) — same #issuer-key-1 fragment.
func mintTrustedVCForSubject(t *testing.T, issuerPriv *ecdsa.PrivateKey, issuerDID, subjectDID string) json.RawMessage {
	t.Helper()
	vcBody := map[string]any{
		"@context": []any{
			w3cVCV1ContextURL,
			lddataintegrity.KnownToAtumV1ContextURL,
		},
		"id":           "urn:uuid:vc-holder-issued-trusted",
		"type":         []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
		"issuer":       issuerDID,
		"issuanceDate": "2026-01-01T00:00:00Z",
		"credentialSubject": map[string]any{
			"id":   subjectDID,
			"role": "settler",
		},
	}
	signed, err := SignVCProofSecp256k1WithCreatedString(
		vcBody, issuerPriv, issuerDID+"#issuer-key-1", "assertionMethod", "2026-01-01T00:00:00Z")
	if err != nil {
		t.Fatalf("sign trusted VC: %v", err)
	}
	raw, err := json.Marshal(signed)
	if err != nil {
		t.Fatalf("marshal trusted VC: %v", err)
	}
	return raw
}

// senderVCParams parameterize mintSenderVCForTest. Zero values fall
// back to the well-minted shape (approved status, future expiration).
type senderVCParams struct {
	IssuerDID      string // VC issuer — the well-minted shape is the HOLDER's did:pkh
	SubjectDID     string // credentialSubject.id — the SENDER's did:pkh
	Status         string // complianceStatus; default "approved"
	ExpirationDate string // default "2027-01-01T00:00:00Z" (future vs the fixture clock)
	VCTypes        []any  // default [VerifiableCredential, SenderComplianceCredential]
	ContextURLs    []any  // default [w3c-vc-v1, sender-compliance-v1]
	SubjectExtra   map[string]any
	// MutateVC, when non-nil, edits the credential body before it is
	// signed, for wire shapes the fields above cannot express, such as a
	// member set to JSON null.
	MutateVC func(vc map[string]any)
}

// mintSenderVCForTest mints a holder-signed sender compliance VC in the
// production originator shape (same contexts, same #blockchainAccountId
// verificationMethod fragment, same mandatory expirationDate).
func mintSenderVCForTest(t *testing.T, signerPriv *ecdsa.PrivateKey, p senderVCParams) json.RawMessage {
	t.Helper()
	if p.Status == "" {
		p.Status = "approved"
	}
	if p.ExpirationDate == "" {
		p.ExpirationDate = "2027-01-01T00:00:00Z"
	}
	if p.VCTypes == nil {
		p.VCTypes = []any{"VerifiableCredential", senderComplianceVCTypeForTest}
	}
	if p.ContextURLs == nil {
		p.ContextURLs = []any{
			w3cVCV1ContextURL,
			lddataintegrity.SenderComplianceV1ContextURL,
		}
	}
	subject := map[string]any{
		"id":               p.SubjectDID,
		"complianceStatus": p.Status,
	}
	for k, v := range p.SubjectExtra {
		subject[k] = v
	}
	vcBody := map[string]any{
		"@context":          p.ContextURLs,
		"id":                "urn:uuid:vc-holder-issued-sender",
		"type":              p.VCTypes,
		"issuer":            p.IssuerDID,
		"issuanceDate":      "2026-01-01T00:00:00Z",
		"expirationDate":    p.ExpirationDate,
		"credentialSubject": subject,
	}
	if p.MutateVC != nil {
		p.MutateVC(vcBody)
	}
	signed, err := SignVCProofSecp256k1WithCreatedString(
		vcBody, signerPriv, p.IssuerDID+"#blockchainAccountId", "assertionMethod", "2026-01-01T00:00:00Z")
	if err != nil {
		t.Fatalf("sign sender VC: %v", err)
	}
	raw, err := json.Marshal(signed)
	if err != nil {
		t.Fatalf("marshal sender VC: %v", err)
	}
	return raw
}

// signSenderVPForTest assembles a holder-signed VP over the supplied
// VCs via the production SignVP path, timed to match happyOpts' clock.
func signSenderVPForTest(t *testing.T, holderPriv *ecdsa.PrivateKey, holderDID string, vcs []json.RawMessage) []byte {
	t.Helper()
	envelope, err := SignVPWithCreatedString(vcs, holderPriv, SignVPOptions{
		Holder:             holderDID,
		VerificationMethod: holderDID + "#blockchainAccountId",
		Challenge:          "req-fixture-1",
		Domain:             "did:web:settler.atum.network",
	}, "2026-05-20T00:00:00.000Z")
	if err != nil {
		t.Fatalf("SignVP: %v", err)
	}
	return envelope
}

// fatalOnDIDPKHResolver wraps an inner resolver and fails the test the
// moment any did:pkh issuer is routed to it — the carve-out contract is
// that holder-issued VCs NEVER consult the did:web resolver.
type fatalOnDIDPKHResolver struct {
	t     *testing.T
	inner *mockResolver
}

func (r *fatalOnDIDPKHResolver) Resolve(ctx context.Context, issuerDID string) (VerificationMethodSet, error) {
	if strings.HasPrefix(strings.ToLower(issuerDID), "did:pkh:") {
		r.t.Fatalf("did:pkh issuer %q reached the did:web resolver — the holder-issued carve-out must never route it here", issuerDID)
	}
	return r.inner.Resolve(ctx, issuerDID)
}

// strictTrust allows exactly one issuer DID, enforced (strict mode).
func strictTrust(allowedDID string) IsIssuerTrustedFunc {
	return func(d string) (bool, bool) { return d == allowedDID, true }
}

// senderHappyOpts is happyOpts + the holder-issued carve-out + strict
// issuer-trust + strict VC-sig verification via the supplied resolver.
func senderHappyOpts(holderDID, trustedIssuerDID string, resolver IssuerKeyResolver) VerifyVPOptions {
	opts := happyOpts(holderDID)
	opts.HolderIssuedVCTypes = []string{senderComplianceVCTypeForTest}
	opts.IsIssuerTrusted = strictTrust(trustedIssuerDID)
	opts.VerifyVCProofs = resolver
	opts.Context = context.Background()
	return opts
}

// Invariant 1 — happy path: a PRE-shaped VP (holder H) carrying a
// trusted-issuer VC about H AND a SenderComplianceCredential issued /
// signed by H about sender S verifies under strict issuer-trust +
// strict VC-sig with the carve-out enabled.
func TestVerifyVP_HolderIssuedSenderVC_HappyPath_StrictModes(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)
	const issuerDID = "did:web:atumlabs.test"
	senderPriv := newSecpKey(t)
	senderDID := holderDIDForKey(senderPriv)

	trustedVC := mintTrustedVCForSubject(t, issuerPriv, issuerDID, holderDID)
	senderVC := mintSenderVCForTest(t, holderPriv, senderVCParams{IssuerDID: holderDID, SubjectDID: senderDID})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trustedVC, senderVC})

	resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, issuerPriv, issuerDID)}
	res, err := VerifyVP(envelope, senderHappyOpts(holderDID, issuerDID, resolver))
	if err != nil {
		t.Fatalf("VerifyVP rejected a valid holder-issued sender VC under strict modes: %v", err)
	}
	if len(res.AttestedClaims) != 2 {
		t.Fatalf("AttestedClaims length = %d, want 2", len(res.AttestedClaims))
	}
	if len(res.IssuerTrustObservations) != 0 {
		t.Fatalf("IssuerTrustObservations = %+v, want empty (trusted issuer + carved sender VC)", res.IssuerTrustObservations)
	}
}

// Invariant 2 — a SenderComplianceCredential whose issuer is a
// DIFFERENT did:pkh than the holder is rejected with
// ErrVPVCIssuerNotHolder in strict AND audit-shaped configurations:
// the issuer==holder gate is forgery-shaped, never mode-gated.
func TestVerifyVP_SenderVCIssuerNotHolder_RejectedInAllModes(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)
	const issuerDID = "did:web:atumlabs.test"
	attackerPriv := newSecpKey(t)
	attackerDID := holderDIDForKey(attackerPriv)
	senderPriv := newSecpKey(t)
	senderDID := holderDIDForKey(senderPriv)

	trustedVC := mintTrustedVCForSubject(t, issuerPriv, issuerDID, holderDID)
	// Sender VC minted + signed by the ATTACKER's key under the
	// attacker's did:pkh — a wallet other than the holder claiming
	// issuer-ship of the carved credential.
	forgedSenderVC := mintSenderVCForTest(t, attackerPriv, senderVCParams{IssuerDID: attackerDID, SubjectDID: senderDID})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trustedVC, forgedSenderVC})

	t.Run("strict (resolver wired, trust enforced)", func(t *testing.T) {
		resolver := &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, issuerPriv, issuerDID)}
		_, err := VerifyVP(envelope, senderHappyOpts(holderDID, issuerDID, resolver))
		if !errors.Is(err, ErrVPVCIssuerNotHolder) {
			t.Fatalf("want ErrVPVCIssuerNotHolder, got %v", err)
		}
	})
	t.Run("audit-shaped (no resolver, trust not enforced)", func(t *testing.T) {
		opts := happyOpts(holderDID)
		opts.HolderIssuedVCTypes = []string{senderComplianceVCTypeForTest}
		opts.IsIssuerTrusted = func(string) (bool, bool) { return false, false }
		_, err := VerifyVP(envelope, opts)
		if !errors.Is(err, ErrVPVCIssuerNotHolder) {
			t.Fatalf("want ErrVPVCIssuerNotHolder even without enforcement wiring, got %v", err)
		}
	})
}

// Invariant 3 — the carve-out never applies to a type NOT listed in
// HolderIssuedVCTypes: a holder-issued VC typed KYCCredential (did:pkh
// issuer, subject = sender) follows the normal policy path and is
// rejected by the subject-holder binding.
func TestVerifyVP_CarveOutDoesNotApplyToUnlistedTypes(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	senderPriv := newSecpKey(t)
	senderDID := holderDIDForKey(senderPriv)

	// Holder self-signs a KYCCredential about the sender — the exact
	// shape of the sender VC except for the type + context. KYCCredential
	// is NOT in HolderIssuedVCTypes, so no carve-out applies.
	selfSignedKYC := mintSenderVCForTest(t, holderPriv, senderVCParams{
		IssuerDID:  holderDID,
		SubjectDID: senderDID,
		VCTypes:    []any{"VerifiableCredential", "KYCCredential"},
		ContextURLs: []any{
			w3cVCV1ContextURL,
			lddataintegrity.KYCV1ContextURL,
		},
	})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{selfSignedKYC})

	opts := happyOpts(holderDID)
	opts.RequiredVCTypes = nil
	opts.HolderIssuedVCTypes = []string{senderComplianceVCTypeForTest}
	_, err := VerifyVP(envelope, opts)
	if !errors.Is(err, ErrVPSubjectHolderMismatch) {
		t.Fatalf("want ErrVPSubjectHolderMismatch (normal policy path for unlisted type), got %v", err)
	}
}

// Invariant 4 — a did:pkh-issued VC NEVER reaches the did:web resolver:
// the resolver stub fails the test if consulted for any did:pkh DID.
func TestVerifyVP_SenderVC_NeverReachesResolver(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)
	const issuerDID = "did:web:atumlabs.test"
	senderPriv := newSecpKey(t)
	senderDID := holderDIDForKey(senderPriv)

	trustedVC := mintTrustedVCForSubject(t, issuerPriv, issuerDID, holderDID)
	senderVC := mintSenderVCForTest(t, holderPriv, senderVCParams{IssuerDID: holderDID, SubjectDID: senderDID})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trustedVC, senderVC})

	resolver := &fatalOnDIDPKHResolver{
		t:     t,
		inner: &mockResolver{issuerDID: issuerDID, vmSet: issuerVMSet(t, issuerPriv, issuerDID)},
	}
	if _, err := VerifyVP(envelope, senderHappyOpts(holderDID, issuerDID, resolver)); err != nil {
		t.Fatalf("VerifyVP: %v", err)
	}
}

// Invariant 5 — the sender VC does NOT satisfy RequiredVCTypes for
// other credential types: a VP carrying ONLY the sender VC with
// RequiredVCTypes=[KYCCredential] fails vp_missing_required_vc_type.
func TestVerifyVP_SenderVC_DoesNotSatisfyRequiredVCTypes(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	senderPriv := newSecpKey(t)
	senderDID := holderDIDForKey(senderPriv)

	senderVC := mintSenderVCForTest(t, holderPriv, senderVCParams{IssuerDID: holderDID, SubjectDID: senderDID})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{senderVC})

	opts := happyOpts(holderDID)
	opts.RequiredVCTypes = []string{"KYCCredential"}
	opts.HolderIssuedVCTypes = []string{senderComplianceVCTypeForTest}
	_, err := VerifyVP(envelope, opts)
	if !errors.Is(err, ErrVPMissingRequiredVCType) {
		t.Fatalf("want ErrVPMissingRequiredVCType (sender VC must not stand in for KYCCredential), got %v", err)
	}
}

// Invariant 6 — carved VCs are excluded from issuer-trust
// observations: under an audit-shaped IsIssuerTrusted (enforced=false),
// the sender VC's did:pkh issuer must NOT be recorded as an
// out-of-allow-list observation.
func TestVerifyVP_SenderVC_ExcludedFromIssuerTrustObservations(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)
	const issuerDID = "did:web:atumlabs.test"
	senderPriv := newSecpKey(t)
	senderDID := holderDIDForKey(senderPriv)

	trustedVC := mintTrustedVCForSubject(t, issuerPriv, issuerDID, holderDID)
	senderVC := mintSenderVCForTest(t, holderPriv, senderVCParams{IssuerDID: holderDID, SubjectDID: senderDID})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trustedVC, senderVC})

	opts := happyOpts(holderDID)
	opts.HolderIssuedVCTypes = []string{senderComplianceVCTypeForTest}
	// Audit posture: only the did:web issuer is in the allow-list;
	// everything else observes (enforced=false). A broken carve-out
	// would record the holder's did:pkh here.
	opts.IsIssuerTrusted = func(d string) (bool, bool) { return d == issuerDID, false }

	res, err := VerifyVP(envelope, opts)
	if err != nil {
		t.Fatalf("VerifyVP: %v", err)
	}
	if len(res.IssuerTrustObservations) != 0 {
		t.Fatalf("IssuerTrustObservations = %+v, want empty — the carved sender VC's did:pkh issuer must not be observed", res.IssuerTrustObservations)
	}
}

// Invariant 8 — an EXPIRED sender VC is rejected by the standard date
// window: the carve-out does not exempt holder-issued VCs from
// issuance/expiration validation.
func TestVerifyVP_ExpiredSenderVC_RejectedByDateWindow(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	senderPriv := newSecpKey(t)
	senderDID := holderDIDForKey(senderPriv)

	// happyOpts' clock is 2026-05-20; this expiry is three months past.
	expiredSenderVC := mintSenderVCForTest(t, holderPriv, senderVCParams{
		IssuerDID:      holderDID,
		SubjectDID:     senderDID,
		ExpirationDate: "2026-02-01T00:00:00Z",
	})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{expiredSenderVC})

	opts := happyOpts(holderDID)
	opts.RequiredVCTypes = nil
	opts.HolderIssuedVCTypes = []string{senderComplianceVCTypeForTest}
	_, err := VerifyVP(envelope, opts)
	if !errors.Is(err, ErrVPVCDateWindow) {
		t.Fatalf("want ErrVPVCDateWindow for expired sender VC, got %v", err)
	}
}

// A sender VC whose issuanceDate is null is refused like any other
// credential's: the carve-out swaps the subject-holder and issuer-trust
// gates, not the issuanceDate check. A verifier that ran that check only
// on the standard path would accept this envelope.
func TestVerifyVP_NullIssuanceDateSenderVC_Refused(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	senderPriv := newSecpKey(t)
	senderDID := holderDIDForKey(senderPriv)

	senderVC := mintSenderVCForTest(t, holderPriv, senderVCParams{
		IssuerDID:  holderDID,
		SubjectDID: senderDID,
		MutateVC:   func(vc map[string]any) { vc["issuanceDate"] = nil },
	})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{senderVC})

	opts := happyOpts(holderDID)
	opts.RequiredVCTypes = nil
	opts.HolderIssuedVCTypes = []string{senderComplianceVCTypeForTest}
	_, err := VerifyVP(envelope, opts)
	if !errors.Is(err, ErrVPVCMissingIssuanceDate) {
		t.Fatalf("want ErrVPVCMissingIssuanceDate for a sender VC with a null issuanceDate, got %v", err)
	}
}

// --- VerifyVCProof-level did:pkh leaf tests -------------------------

// A did:pkh-issued VC with no HolderDID threaded fails closed — a
// caller that didn't supply the envelope's verified holder cannot
// vouch for a holder-issued credential.
func TestVerifyVCProof_DIDPKHIssuer_EmptyHolderDID_FailsClosed(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	raw := mintSenderVCForTest(t, holderPriv, senderVCParams{IssuerDID: holderDID, SubjectDID: holderDID})
	vc := mustUnmarshalVC(t, raw)

	resolver := &mockResolver{forceErr: errors.New("must not be called")}
	err := VerifyVCProof(vc, raw, resolver, VerifyVCProofOptions{Context: context.Background()})
	if !errors.Is(err, ErrVPVCIssuerNotHolder) {
		t.Fatalf("want ErrVPVCIssuerNotHolder for empty HolderDID, got %v", err)
	}
}

// A did:pkh-issued VC whose issuer isn't the supplied HolderDID is
// rejected before any crypto runs.
func TestVerifyVCProof_DIDPKHIssuer_MismatchedHolder(t *testing.T) {
	attackerPriv := newSecpKey(t)
	attackerDID := holderDIDForKey(attackerPriv)
	holderDID := holderDIDForKey(newSecpKey(t))
	raw := mintSenderVCForTest(t, attackerPriv, senderVCParams{IssuerDID: attackerDID, SubjectDID: holderDID})
	vc := mustUnmarshalVC(t, raw)

	resolver := &mockResolver{forceErr: errors.New("must not be called")}
	err := VerifyVCProof(vc, raw, resolver, VerifyVCProofOptions{Context: context.Background(), HolderDID: holderDID})
	if !errors.Is(err, ErrVPVCIssuerNotHolder) {
		t.Fatalf("want ErrVPVCIssuerNotHolder for issuer != HolderDID, got %v", err)
	}
}

// A did:pkh-issued VC SIGNED BY THE WRONG KEY (issuer claims the
// holder's DID but the signature recovers to a different wallet) is a
// signature-invalid outcome.
func TestVerifyVCProof_DIDPKHIssuer_WrongKey_SignatureInvalid(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	wrongPriv := newSecpKey(t)
	// Issuer string claims the holder; the actual signer is wrongPriv.
	raw := mintSenderVCForTest(t, wrongPriv, senderVCParams{IssuerDID: holderDID, SubjectDID: holderDIDForKey(newSecpKey(t))})
	vc := mustUnmarshalVC(t, raw)

	resolver := &mockResolver{forceErr: errors.New("must not be called")}
	err := VerifyVCProof(vc, raw, resolver, VerifyVCProofOptions{Context: context.Background(), HolderDID: holderDID})
	if !errors.Is(err, ErrVPVCSignatureInvalid) {
		t.Fatalf("want ErrVPVCSignatureInvalid for wrong-key did:pkh proof, got %v", err)
	}
}

// A non-secp256k1 did:pkh issuer (solana / ed25519) fails closed with
// the existing unsupported-proof-type error — the recovery-based
// holder binding only exists for secp256k1 chains.
func TestVerifyVCProof_DIDPKHIssuer_Ed25519_FailsClosed(t *testing.T) {
	pub, priv := newEdKey(t)
	solanaDID := "did:pkh:solana:devnet:" + base58.Encode(pub)

	vcBody := map[string]any{
		"@context": []any{
			w3cVCV1ContextURL,
			lddataintegrity.SenderComplianceV1ContextURL,
		},
		"id":             "urn:uuid:vc-holder-issued-solana-sender",
		"type":           []any{"VerifiableCredential", senderComplianceVCTypeForTest},
		"issuer":         solanaDID,
		"issuanceDate":   "2026-01-01T00:00:00Z",
		"expirationDate": "2027-01-01T00:00:00Z",
		"credentialSubject": map[string]any{
			"id":               "did:pkh:solana:devnet:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
			"complianceStatus": "approved",
		},
	}
	signed, err := SignVCProofEd25519WithCreatedString(
		vcBody, priv, solanaDID+"#blockchainAccountId", "assertionMethod", "2026-01-01T00:00:00Z")
	if err != nil {
		t.Fatalf("sign ed25519 sender VC: %v", err)
	}
	raw, err := json.Marshal(signed)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	vc := mustUnmarshalVC(t, raw)

	resolver := &mockResolver{forceErr: errors.New("must not be called")}
	err = VerifyVCProof(vc, json.RawMessage(raw), resolver, VerifyVCProofOptions{Context: context.Background(), HolderDID: solanaDID})
	if !errors.Is(err, ErrVPVCUnsupportedProofType) {
		t.Fatalf("want ErrVPVCUnsupportedProofType for ed25519 did:pkh issuer, got %v", err)
	}
}

// TestVerifyVP_HolderIssuedVC_DualTypeSmuggling_Rejected is the type-
// confinement regression. A holder self-signs ONE did:pkh-issued VC
// that declares BOTH a carved type (SenderComplianceCredential) AND a
// trust-gated type (KnownToAtumVerifiableCredential). Without type
// confinement the carve-out would skip issuer-trust + subject-holder for the
// whole VC, letting the self-signed credential satisfy RequiredVCTypes with
// no trusted issuer (and be read as an approved trust-gated claim downstream)
// — a total trust bypass. It MUST be rejected in ALL modes.
func TestVerifyVP_HolderIssuedVC_DualTypeSmuggling_Rejected(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	senderPriv := newSecpKey(t)
	senderDID := holderDIDForKey(senderPriv)

	// Self-signed VC typed [VerifiableCredential, KnownToAtumVerifiableCredential,
	// SenderComplianceCredential] — issuer == holder so it clears the
	// issuer==holder gate, but it smuggles the trust-gated KnownToAtum type.
	smuggled := mintSenderVCForTest(t, holderPriv, senderVCParams{
		IssuerDID:  holderDID,
		SubjectDID: senderDID,
		VCTypes: []any{
			"VerifiableCredential",
			"KnownToAtumVerifiableCredential",
			senderComplianceVCTypeForTest,
		},
	})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{smuggled})

	// Strict issuer-trust that does NOT include the holder, RequiredVCTypes
	// demanding the trust-gated type, and a resolver that fatals if any
	// did:pkh is routed to it.
	assertRejected := func(t *testing.T, opts VerifyVPOptions) {
		opts.HolderIssuedVCTypes = []string{senderComplianceVCTypeForTest}
		opts.RequiredVCTypes = []string{"KnownToAtumVerifiableCredential"}
		_, err := VerifyVP(envelope, opts)
		if !errors.Is(err, ErrVPVCIssuerNotHolder) {
			t.Fatalf("dual-type smuggled VC accepted or wrong error: got %v, want ErrVPVCIssuerNotHolder", err)
		}
	}

	t.Run("strict (trust enforced + resolver wired)", func(t *testing.T) {
		opts := senderHappyOpts(holderDID, "did:web:atumlabs.test",
			&fatalOnDIDPKHResolver{t: t, inner: &mockResolver{issuerDID: "did:web:atumlabs.test"}})
		assertRejected(t, opts)
	})
	t.Run("audit-shaped (no resolver, trust not enforced)", func(t *testing.T) {
		opts := happyOpts(holderDID)
		opts.Context = context.Background()
		assertRejected(t, opts)
	})
}
