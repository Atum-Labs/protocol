package ldverification

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// Reserved and pass-through credentials (VerifyVPOptions.ReservedVCTypes).
//
// A presentation carries credentials to counterparties, who decide whom
// they trust as an issuer. Only reserved types (ReservedVCTypes together
// with RequiredVCTypes) are gated on the verifier's trusted issuers; any
// other credential is passed through untouched and returned in
// PassThroughClaims.

const (
	reservedTrustedIssuer = "did:web:atumlabs.test"
	thirdPartyIssuer      = "did:web:unlisted-issuer.example"
	// An absolute IRI, so the type resolves under any context. A short
	// name no loaded context defines can't be resolved and is checked,
	// not passed through (see TestVerifyVP_ReservedTypeSpellings_AreChecked).
	thirdPartyType = "https://example.org/credentials#PartnerAttestationCredential"
)

// guardResolver resolves only the trusted issuer and fails the test the
// moment any other issuer reaches it: a pass-through credential's issuer
// must never be resolved.
type guardResolver struct {
	t     *testing.T
	inner *mockResolver
}

func (r *guardResolver) Resolve(ctx context.Context, issuerDID string) (VerificationMethodSet, error) {
	if issuerDID != r.inner.issuerDID {
		r.t.Fatalf("issuer %q reached the resolver; a pass-through credential must never be resolved", issuerDID)
	}
	return r.inner.Resolve(ctx, issuerDID)
}

// thirdPartyVCForTest is a credential from an issuer that isn't trusted
// and can't be resolved, deliberately invalid by every per-VC check: it
// expired before the fixture clock, and its subject is another account.
// Its proof is a stub that no resolver could verify.
func thirdPartyVCForTest(t *testing.T, types []string) json.RawMessage {
	t.Helper()
	expired := mustTimeNoT("2026-02-01T00:00:00Z")
	vc := buildFixtureVC(
		thirdPartyIssuer,
		mustTimeNoT("2026-01-01T00:00:00Z"),
		&expired,
		types,
		"did:pkh:eip155:1:0xdeadbeef00000000000000000000000000000002",
		ProofTypeSecp256k1Recovery2020,
	)
	raw, err := json.Marshal(vc)
	if err != nil {
		t.Fatalf("marshal third-party VC: %v", err)
	}
	return raw
}

// wireVC returns verifiableCredential[i] exactly as it sits on the wire.
func wireVC(t *testing.T, envelope []byte, i int) json.RawMessage {
	t.Helper()
	var env struct {
		VerifiableCredential []json.RawMessage `json:"verifiableCredential"`
	}
	if err := json.Unmarshal(envelope, &env); err != nil {
		t.Fatalf("parse envelope: %v", err)
	}
	if i >= len(env.VerifiableCredential) {
		t.Fatalf("envelope carries %d credentials, want index %d", len(env.VerifiableCredential), i)
	}
	return env.VerifiableCredential[i]
}

// strictReservedOpts is happyOpts (RequiredVCTypes = KnownToAtum) with
// issuer trust strict on the one trusted issuer and VC-proof verification
// wired through a resolver that only knows that issuer.
func strictReservedOpts(t *testing.T, holderDID string, issuerPrivKey *mockResolver) VerifyVPOptions {
	opts := happyOpts(holderDID)
	opts.IsIssuerTrusted = strictTrust(reservedTrustedIssuer)
	opts.VerifyVCProofs = &guardResolver{t: t, inner: issuerPrivKey}
	opts.Context = context.Background()
	return opts
}

// A Known-to-Atum credential from the trusted issuer plus a third-party
// credential from an issuer that is neither trusted nor resolvable, and
// is expired and about another account: the presentation verifies under
// strict issuer trust with VC-proof verification wired. The third-party
// credential is returned byte-identical in PassThroughClaims, never in
// AttestedClaims, and records no issuer-trust observation.
func TestVerifyVP_UnreservedVC_PassedThroughUnchecked(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)

	trusted := mintTrustedVCForSubject(t, issuerPriv, reservedTrustedIssuer, holderDID)
	third := thirdPartyVCForTest(t, []string{"VerifiableCredential", thirdPartyType})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trusted, third})

	resolver := &mockResolver{issuerDID: reservedTrustedIssuer, vmSet: issuerVMSet(t, issuerPriv, reservedTrustedIssuer)}
	res, err := VerifyVP(envelope, strictReservedOpts(t, holderDID, resolver))
	if err != nil {
		t.Fatalf("VerifyVP refused a presentation over an unreserved third-party credential: %v", err)
	}
	if len(res.AttestedClaims) != 1 || !bytes.Equal(res.AttestedClaims[0], wireVC(t, envelope, 0)) {
		t.Fatalf("AttestedClaims = %d entries, want exactly the Known-to-Atum credential", len(res.AttestedClaims))
	}
	if len(res.PassThroughClaims) != 1 {
		t.Fatalf("PassThroughClaims = %d entries, want 1", len(res.PassThroughClaims))
	}
	if !bytes.Equal(res.PassThroughClaims[0], wireVC(t, envelope, 1)) {
		t.Fatalf("PassThroughClaims[0] is not byte-identical to the wire credential:\n got %s\nwant %s",
			res.PassThroughClaims[0], wireVC(t, envelope, 1))
	}
	if len(res.IssuerTrustObservations) != 0 {
		t.Fatalf("IssuerTrustObservations = %+v, want none: a pass-through credential's issuer isn't judged", res.IssuerTrustObservations)
	}
}

// The impersonator: a credential claiming the reserved type from an issuer
// outside the trust list is refused under strict, whatever else rides with
// it.
func TestVerifyVP_ReservedTypeFromUnknownIssuer_Refused(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	impostorPriv := newSecpKey(t)
	const impostor = "did:web:impersonator.example"

	forged := mintTrustedVCForSubject(t, impostorPriv, impostor, holderDID)
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{forged})

	opts := happyOpts(holderDID)
	opts.IsIssuerTrusted = strictTrust(reservedTrustedIssuer)
	_, err := VerifyVP(envelope, opts)
	if !errors.Is(err, ErrVPIssuerNotTrusted) {
		t.Fatalf("VerifyVP: want ErrVPIssuerNotTrusted for a reserved credential from an unlisted issuer, got %v", err)
	}
}

// A pass-through credential never satisfies RequiredVCTypes: a presentation
// carrying only third-party credentials is refused for the missing type.
func TestVerifyVP_UnreservedVC_DoesNotSatisfyRequiredVCTypes(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)

	third := thirdPartyVCForTest(t, []string{"VerifiableCredential", thirdPartyType})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{third})

	opts := happyOpts(holderDID)
	opts.IsIssuerTrusted = strictTrust(reservedTrustedIssuer)
	_, err := VerifyVP(envelope, opts)
	if !errors.Is(err, ErrVPMissingRequiredVCType) {
		t.Fatalf("VerifyVP: want ErrVPMissingRequiredVCType, got %v", err)
	}
}

// ReservedVCTypes adds to RequiredVCTypes: listing the third-party type
// makes that credential walk every check, so its expiry refuses the
// presentation even though the caller only requires Known-to-Atum.
func TestVerifyVP_ExplicitReservedType_IsChecked(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)

	trusted := mintTrustedVCForSubject(t, issuerPriv, reservedTrustedIssuer, holderDID)
	third := thirdPartyVCForTest(t, []string{"VerifiableCredential", thirdPartyType})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trusted, third})

	resolver := &mockResolver{issuerDID: reservedTrustedIssuer, vmSet: issuerVMSet(t, issuerPriv, reservedTrustedIssuer)}
	opts := happyOpts(holderDID)
	opts.IsIssuerTrusted = strictTrust(reservedTrustedIssuer)
	opts.VerifyVCProofs = resolver
	opts.ReservedVCTypes = []string{thirdPartyType}
	_, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatal("VerifyVP accepted a reserved-type credential that fails its checks")
	}
	if !strings.Contains(err.Error(), "verifiableCredential[1]") {
		t.Fatalf("want the error to name verifiableCredential[1], got %v", err)
	}
}

// With neither ReservedVCTypes nor RequiredVCTypes set there is no reserved
// set, and every credential walks every check, as before the option
// existed: the expired third-party credential refuses the presentation.
func TestVerifyVP_NoReservedSet_ChecksEveryVC(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)

	trusted := mintTrustedVCForSubject(t, issuerPriv, reservedTrustedIssuer, holderDID)
	third := thirdPartyVCForTest(t, []string{"VerifiableCredential", thirdPartyType})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trusted, third})

	opts := happyOpts(holderDID)
	opts.RequiredVCTypes = nil
	opts.IsIssuerTrusted = strictTrust(reservedTrustedIssuer)
	res, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatalf("VerifyVP passed every credential through with no reserved set: %d attested, %d passed through",
			len(res.AttestedClaims), len(res.PassThroughClaims))
	}
	if !strings.Contains(err.Error(), "verifiableCredential[1]") {
		t.Fatalf("want the error to name verifiableCredential[1], got %v", err)
	}
}

// A third-party credential that declares the reserved type alongside its
// own is reserved, so it walks every check: a credential can't dodge the
// trust list by adding types.
func TestVerifyVP_VCDeclaringReservedTypeAmongOthers_IsChecked(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)

	trusted := mintTrustedVCForSubject(t, issuerPriv, reservedTrustedIssuer, holderDID)
	smuggled := thirdPartyVCForTest(t, []string{"VerifiableCredential", thirdPartyType, "KnownToAtumVerifiableCredential"})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trusted, smuggled})

	opts := happyOpts(holderDID)
	opts.IsIssuerTrusted = strictTrust(reservedTrustedIssuer)
	_, err := VerifyVP(envelope, opts)
	if err == nil {
		t.Fatal("VerifyVP passed through a credential that declares a reserved type")
	}
	if !strings.Contains(err.Error(), "verifiableCredential[1]") {
		t.Fatalf("want the error to name verifiableCredential[1], got %v", err)
	}
}

// knownToAtumTypeIRI is the IRI the known-to-atum context maps
// KnownToAtumVerifiableCredential to.
const knownToAtumTypeIRI = "https://schemas.atum.xyz/credentials/known-to-atum/v1#KnownToAtumVerifiableCredential"

// spelledVCForTest is a credential from issuer about subject, valid by date,
// with the given @context and types. Its proof is a stub: these tests don't
// wire VC-proof verification, so only the policy checks decide.
func spelledVCForTest(t *testing.T, issuer, subject string, ctx []any, types []string) json.RawMessage {
	t.Helper()
	vc := buildFixtureVC(issuer, mustTimeNoT("2026-01-01T00:00:00Z"), nil, types, subject, ProofTypeSecp256k1Recovery2020)
	vc["@context"] = ctx
	raw, err := json.Marshal(vc)
	if err != nil {
		t.Fatalf("marshal VC: %v", err)
	}
	return raw
}

// Every JSON-LD spelling of the reserved type, and a type nothing defines,
// is checked: from an issuer outside the trust list it refuses the
// presentation under strict trust. Trusting that issuer as well makes the
// same presentation verify with the credential in AttestedClaims, so the
// refusal came from the issuer check on a checked credential, not from
// anything else.
//
// An inline context object can't alias the IRI: canonicalization admits
// only context URLs and refuses the whole presentation first. A context
// that aliases it can only be one the caller supplies, covered by
// TestVerifyVP_SuppliedContextAliasingReservedType_IsChecked.
func TestVerifyVP_ReservedTypeSpellings_AreChecked(t *testing.T) {
	const (
		w3c      = "https://www.w3.org/2018/credentials/v1"
		ktaCtx   = "https://schemas.atum.xyz/credentials/known-to-atum/v1"
		impostor = "did:web:impersonator.example"
	)
	cases := []struct {
		name  string
		ctx   []any
		types []string
	}{
		{"the full IRI", []any{w3c, ktaCtx}, []string{"VerifiableCredential", knownToAtumTypeIRI}},
		{"the kta: compact form", []any{w3c, ktaCtx}, []string{"VerifiableCredential", "kta:KnownToAtumVerifiableCredential"}},
		{"the kta: form without the known-to-atum context", []any{w3c}, []string{"VerifiableCredential", "kta:KnownToAtumVerifiableCredential"}},
		{"a short name no context defines", []any{w3c, ktaCtx}, []string{"VerifiableCredential", "PartnerAttestationCredential"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			holderPriv := newSecpKey(t)
			holderDID := holderDIDForKey(holderPriv)
			issuerPriv := newSecpKey(t)

			trusted := mintTrustedVCForSubject(t, issuerPriv, reservedTrustedIssuer, holderDID)
			spelled := spelledVCForTest(t, impostor, holderDID, c.ctx, c.types)
			envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trusted, spelled})

			opts := happyOpts(holderDID)
			opts.IsIssuerTrusted = strictTrust(reservedTrustedIssuer)
			_, err := VerifyVP(envelope, opts)
			if !errors.Is(err, ErrVPIssuerNotTrusted) || !strings.Contains(err.Error(), "verifiableCredential[1]") {
				t.Fatalf("VerifyVP: want ErrVPIssuerNotTrusted on verifiableCredential[1], got %v", err)
			}

			opts.IsIssuerTrusted = func(d string) (bool, bool) { return d == reservedTrustedIssuer || d == impostor, true }
			res, err := VerifyVP(envelope, opts)
			if err != nil {
				t.Fatalf("VerifyVP with both issuers trusted: %v", err)
			}
			if len(res.AttestedClaims) != 2 || len(res.PassThroughClaims) != 0 {
				t.Fatalf("got %d attested and %d passed through, want both credentials checked", len(res.AttestedClaims), len(res.PassThroughClaims))
			}
		})
	}
}

// The reserved set is ReservedVCTypes together with RequiredVCTypes: listing
// another type in ReservedVCTypes keeps the required type reserved, so a
// Known-to-Atum credential from an issuer outside the trust list beside
// Atum's is still checked and refused.
func TestVerifyVP_ReservedVCTypesKeepsRequiredTypesReserved(t *testing.T) {
	const impostor = "did:web:impersonator.example"
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)

	trusted := mintTrustedVCForSubject(t, issuerPriv, reservedTrustedIssuer, holderDID)
	foreign := spelledVCForTest(t, impostor, holderDID,
		[]any{"https://www.w3.org/2018/credentials/v1", lddataintegrity.KnownToAtumV1ContextURL},
		[]string{"VerifiableCredential", "KnownToAtumVerifiableCredential"})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trusted, foreign})

	opts := happyOpts(holderDID)
	opts.IsIssuerTrusted = strictTrust(reservedTrustedIssuer)
	opts.ReservedVCTypes = []string{thirdPartyType}
	_, err := VerifyVP(envelope, opts)
	if !errors.Is(err, ErrVPIssuerNotTrusted) || !strings.Contains(err.Error(), "verifiableCredential[1]") {
		t.Fatalf("VerifyVP: want ErrVPIssuerNotTrusted on verifiableCredential[1], got %v", err)
	}
}

// PassThroughClaims holds the credential exactly as it sits on the wire,
// whitespace included, never a re-marshal. The holder signature covers the
// canonical form, so the indented envelope still verifies.
func TestVerifyVP_PassThroughClaims_AreTheWireBytes(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)

	trusted := mintTrustedVCForSubject(t, issuerPriv, reservedTrustedIssuer, holderDID)
	third := thirdPartyVCForTest(t, []string{"VerifiableCredential", thirdPartyType})
	compact := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trusted, third})
	var indented bytes.Buffer
	if err := json.Indent(&indented, compact, "", "    "); err != nil {
		t.Fatalf("indent envelope: %v", err)
	}
	envelope := indented.Bytes()

	resolver := &mockResolver{issuerDID: reservedTrustedIssuer, vmSet: issuerVMSet(t, issuerPriv, reservedTrustedIssuer)}
	res, err := VerifyVP(envelope, strictReservedOpts(t, holderDID, resolver))
	if err != nil {
		t.Fatalf("VerifyVP(indented): %v", err)
	}
	want := wireVC(t, envelope, 1)
	if !bytes.Contains(want, []byte("\n    ")) {
		t.Fatalf("the wire credential isn't indented, so this proves nothing: %s", want)
	}
	if len(res.PassThroughClaims) != 1 || !bytes.Equal(res.PassThroughClaims[0], want) {
		t.Fatalf("PassThroughClaims isn't the wire bytes:\n got %s\nwant %s", res.PassThroughClaims, want)
	}
}

// A pass-through credential's issuer isn't judged at all, so in audit mode
// it records no IssuerTrustObservation. A checked credential from the same
// kind of issuer does, which shows the audit path is live.
func TestVerifyVP_PassThroughVC_RecordsNoAuditObservation(t *testing.T) {
	const impostor = "did:web:impersonator.example"
	audit := func(d string) (bool, bool) { return d == reservedTrustedIssuer, false }

	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)
	trusted := mintTrustedVCForSubject(t, issuerPriv, reservedTrustedIssuer, holderDID)

	third := thirdPartyVCForTest(t, []string{"VerifiableCredential", thirdPartyType})
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trusted, third})
	opts := happyOpts(holderDID)
	opts.IsIssuerTrusted = audit
	res, err := VerifyVP(envelope, opts)
	if err != nil {
		t.Fatalf("VerifyVP (audit, pass-through): %v", err)
	}
	if len(res.PassThroughClaims) != 1 || len(res.IssuerTrustObservations) != 0 {
		t.Fatalf("got %d passed through and observations %+v, want 1 and none", len(res.PassThroughClaims), res.IssuerTrustObservations)
	}

	foreign := spelledVCForTest(t, impostor, holderDID,
		[]any{"https://www.w3.org/2018/credentials/v1", lddataintegrity.KnownToAtumV1ContextURL},
		[]string{"VerifiableCredential", "KnownToAtumVerifiableCredential"})
	envelope = signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trusted, foreign})
	res, err = VerifyVP(envelope, opts)
	if err != nil {
		t.Fatalf("VerifyVP (audit, checked): %v", err)
	}
	if len(res.IssuerTrustObservations) != 1 || res.IssuerTrustObservations[0].VCIndex != 1 || res.IssuerTrustObservations[0].IssuerDID != impostor {
		t.Fatalf("observations = %+v, want one for verifiableCredential[1] from %s", res.IssuerTrustObservations, impostor)
	}
}

const (
	partnerContextURL           = "https://partner.example/credentials/v1"
	partnerMembershipContextURL = "https://partner.example/membership/v1"
)

// partnerContext defines a partner's own credential type and subject terms.
func partnerContext() map[string]any {
	return map[string]any{"@context": map[string]any{
		"@version":                     1.1,
		"@protected":                   true,
		"pt":                           "https://partner.example/credentials/v1#",
		"PartnerAttestationCredential": "pt:PartnerAttestationCredential",
		"riskScore":                    "pt:riskScore",
	}}
}

// partnerMembershipContext defines a term that stands for the Known-to-Atum
// type's IRI under another name.
func partnerMembershipContext() map[string]any {
	return map[string]any{"@context": map[string]any{
		"@version":                    1.1,
		"PartnerMembershipCredential": knownToAtumTypeIRI,
	}}
}

// partnerVCForTest is a credential under the partner's own context.
func partnerVCForTest(t *testing.T, issuer, subject, ctxURL, typ string, expires bool) json.RawMessage {
	t.Helper()
	vc := map[string]any{
		"@context":          []any{"https://www.w3.org/2018/credentials/v1", ctxURL},
		"id":                "urn:uuid:7f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
		"type":              []any{"VerifiableCredential", typ},
		"issuer":            issuer,
		"issuanceDate":      "2026-01-02T00:00:00Z",
		"credentialSubject": map[string]any{"id": subject, "riskScore": "low"},
		"proof": map[string]any{
			"type":               ProofTypeSecp256k1Recovery2020,
			"created":            "2026-01-02T00:00:00Z",
			"verificationMethod": issuer + "#key-1",
			"proofPurpose":       "assertionMethod",
		},
	}
	if expires {
		vc["expirationDate"] = "2026-02-01T00:00:00Z"
	}
	raw, err := json.Marshal(vc)
	if err != nil {
		t.Fatalf("marshal partner VC: %v", err)
	}
	return raw
}

func signVPWithContextsForTest(t *testing.T, holderPriv *ecdsa.PrivateKey, holderDID string, vcs []json.RawMessage, contexts map[string]any) []byte {
	t.Helper()
	envelope, err := SignVPWithCreatedString(vcs, holderPriv, SignVPOptions{
		Holder:                holderDID,
		VerificationMethod:    holderDID + "#blockchainAccountId",
		Challenge:             "req-fixture-1",
		Domain:                "did:web:settler.atum.network",
		ExtraEnvelopeContexts: contexts,
	}, "2026-05-20T00:00:00.000Z")
	if err != nil {
		t.Fatalf("SignVP: %v", err)
	}
	return envelope
}

// A partner credential under its own context, from an issuer that is
// neither trusted nor resolvable, expired and about another account, passes
// through when the caller supplies that context. Without it the loader
// can't read the credential and the whole presentation is refused: the
// loader never fetches a context.
func TestVerifyVP_PartnerCredentialWithSuppliedContext_PassesThrough(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)

	trusted := mintTrustedVCForSubject(t, issuerPriv, reservedTrustedIssuer, holderDID)
	partner := partnerVCForTest(t, thirdPartyIssuer, "did:pkh:eip155:1:0xdeadbeef00000000000000000000000000000002",
		partnerContextURL, "PartnerAttestationCredential", true)
	contexts := map[string]any{partnerContextURL: partnerContext()}
	envelope := signVPWithContextsForTest(t, holderPriv, holderDID, []json.RawMessage{trusted, partner}, contexts)

	resolver := &mockResolver{issuerDID: reservedTrustedIssuer, vmSet: issuerVMSet(t, issuerPriv, reservedTrustedIssuer)}
	opts := strictReservedOpts(t, holderDID, resolver)
	opts.ExtraCredentialContexts = contexts
	res, err := VerifyVP(envelope, opts)
	if err != nil {
		t.Fatalf("VerifyVP with the partner context supplied: %v", err)
	}
	if len(res.PassThroughClaims) != 1 || !bytes.Equal(res.PassThroughClaims[0], wireVC(t, envelope, 1)) {
		t.Fatalf("PassThroughClaims = %d entries, want the partner credential byte-identical", len(res.PassThroughClaims))
	}

	opts.ExtraCredentialContexts = nil
	if _, err := VerifyVP(envelope, opts); err == nil || !strings.Contains(err.Error(), partnerContextURL) {
		t.Fatalf("VerifyVP without the partner context: want a refusal naming %s, got %v", partnerContextURL, err)
	}
}

// A supplied context whose term stands for the Known-to-Atum type's IRI
// makes that credential reserved: from an issuer outside the trust list it
// is refused, and trusting that issuer too makes it verify with both
// credentials checked.
func TestVerifyVP_SuppliedContextAliasingReservedType_IsChecked(t *testing.T) {
	const impostor = "did:web:impersonator.example"
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)

	trusted := mintTrustedVCForSubject(t, issuerPriv, reservedTrustedIssuer, holderDID)
	aliased := partnerVCForTest(t, impostor, holderDID, partnerMembershipContextURL, "PartnerMembershipCredential", false)
	contexts := map[string]any{partnerMembershipContextURL: partnerMembershipContext()}
	envelope := signVPWithContextsForTest(t, holderPriv, holderDID, []json.RawMessage{trusted, aliased}, contexts)

	opts := happyOpts(holderDID)
	opts.ExtraCredentialContexts = contexts
	opts.IsIssuerTrusted = strictTrust(reservedTrustedIssuer)
	_, err := VerifyVP(envelope, opts)
	if !errors.Is(err, ErrVPIssuerNotTrusted) || !strings.Contains(err.Error(), "verifiableCredential[1]") {
		t.Fatalf("VerifyVP: want ErrVPIssuerNotTrusted on verifiableCredential[1], got %v", err)
	}

	opts.IsIssuerTrusted = func(d string) (bool, bool) { return d == reservedTrustedIssuer || d == impostor, true }
	res, err := VerifyVP(envelope, opts)
	if err != nil {
		t.Fatalf("VerifyVP with both issuers trusted: %v", err)
	}
	if len(res.AttestedClaims) != 2 || len(res.PassThroughClaims) != 0 {
		t.Fatalf("got %d attested and %d passed through, want both checked", len(res.AttestedClaims), len(res.PassThroughClaims))
	}
}

// A supplied credential context may add a vocabulary, never replace one of
// Atum's: a bundled context URL, or an ExtraEnvelopeContexts key, is refused
// before anything is verified.
func TestVerifyVP_ExtraCredentialContexts_CannotReplaceAContext(t *testing.T) {
	holderPriv := newSecpKey(t)
	holderDID := holderDIDForKey(holderPriv)
	issuerPriv := newSecpKey(t)
	trusted := mintTrustedVCForSubject(t, issuerPriv, reservedTrustedIssuer, holderDID)
	envelope := signSenderVPForTest(t, holderPriv, holderDID, []json.RawMessage{trusted})

	for name, mutate := range map[string]func(*VerifyVPOptions){
		"a bundled context": func(o *VerifyVPOptions) {
			o.ExtraCredentialContexts = map[string]any{lddataintegrity.KnownToAtumV1ContextURL: partnerMembershipContext()}
		},
		"an envelope context": func(o *VerifyVPOptions) {
			o.ExtraEnvelopeContexts = map[string]any{partnerContextURL: partnerContext()}
			o.ExtraCredentialContexts = map[string]any{partnerContextURL: partnerContext()}
		},
	} {
		t.Run(name, func(t *testing.T) {
			opts := happyOpts(holderDID)
			mutate(&opts)
			_, err := VerifyVP(envelope, opts)
			if !errors.Is(err, ErrMalformedProof) || !strings.Contains(err.Error(), "ExtraCredentialContexts") {
				t.Fatalf("VerifyVP: want the ExtraCredentialContexts refusal, got %v", err)
			}
		})
	}
	if _, err := VerifyVP(envelope, happyOpts(holderDID)); err != nil {
		t.Fatalf("the same presentation without the bad option must verify: %v", err)
	}
}
