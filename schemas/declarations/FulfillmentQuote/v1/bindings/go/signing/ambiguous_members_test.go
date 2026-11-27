package ldverification

import (
	"context"
	"crypto/ecdsa"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
)

// A document that names a member twice, exactly or under the case folding
// encoding/json applies, is refused before anything reads it. Each case below
// signs a presentation the verifier refuses on its own, then adds a member
// after signing. The added member is not covered by any proof: the canonical
// form keeps only the exact names a context defines.

func addrOf(priv *ecdsa.PrivateKey) string {
	return crypto.PubkeyToAddress(priv.PublicKey).Hex()
}

// withMemberAfter inserts `,member` right after the one occurrence of anchor.
func withMemberAfter(t *testing.T, raw []byte, anchor, member string) []byte {
	t.Helper()
	if n := strings.Count(string(raw), anchor); n != 1 {
		t.Fatalf("anchor %s occurs %d times in the fixture, want exactly once", anchor, n)
	}
	return []byte(strings.Replace(string(raw), anchor, anchor+","+member, 1))
}

func wantAmbiguous(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, ErrAmbiguousMember) {
		t.Fatalf("err = %v, want ErrAmbiguousMember", err)
	}
	if !errors.Is(err, ErrMalformedQuote) {
		t.Errorf("err = %v, want it to match ErrMalformedQuote too", err)
	}
}

func TestVerifyVP_RefusesAMemberNamedTwice(t *testing.T) {
	priv := newSecpKey(t)
	holder := "did:pkh:eip155:1:" + strings.ToLower(addrOf(priv))
	other := "did:pkh:eip155:1:0x0000000000000000000000000000000000000001"
	expired := mustTime(t, "2026-02-01T00:00:00Z")

	cases := []struct {
		name   string
		opts   vpFixtureOptions
		anchor string
		twin   string
	}{
		{
			name:   "a credential's expirationDate, in lower case",
			opts:   vpFixtureOptions{ExpirationDate: &expired},
			anchor: `"expirationDate":"2026-02-01T00:00:00Z"`,
			twin:   `"expirationdate":"2099-01-01T00:00:00Z"`,
		},
		{
			name:   "a credential's type, capitalised",
			opts:   vpFixtureOptions{VCTypes: []string{"VerifiableCredential"}},
			anchor: `"type":["VerifiableCredential"]`,
			twin:   `"Type":["VerifiableCredential","KnownToAtumVerifiableCredential"]`,
		},
		{
			name:   "a credential's credentialSubject, in lower case",
			opts:   vpFixtureOptions{SubjectDID: other},
			anchor: `"credentialSubject":{"id":"` + other + `","role":"settler"}`,
			twin:   `"credentialsubject":{"id":"` + holder + `","role":"settler"}`,
		},
		{
			name:   "a credential's credentialSubject, spelled with U+017F, which folds to s",
			opts:   vpFixtureOptions{SubjectDID: other},
			anchor: `"credentialSubject":{"id":"` + other + `","role":"settler"}`,
			twin:   `"credentialſubject":{"id":"` + holder + `","role":"settler"}`,
		},
		{
			name:   "the presentation's holder, exactly",
			opts:   vpFixtureOptions{},
			anchor: `"holder":"` + holder + `"`,
			twin:   `"holder":"` + holder + `"`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			c.opts.Holder = holder
			raw := signVPSecpForTest(t, priv, c.opts)
			if c.name != "the presentation's holder, exactly" {
				if _, err := VerifyVP(raw, happyOpts(holder)); err == nil {
					t.Fatal("the fixture verifies on its own; it must be refused for the added member to matter")
				}
			}
			_, err := VerifyVP(withMemberAfter(t, raw, c.anchor, c.twin), happyOpts(holder))
			wantAmbiguous(t, err)
		})
	}
}

// The presentation's own proof, named again with a fresh created.
func TestVerifyVP_RefusesASecondProof(t *testing.T) {
	priv := newSecpKey(t)
	holder := "did:pkh:eip155:1:" + strings.ToLower(addrOf(priv))
	raw := signVPSecpForTest(t, priv, vpFixtureOptions{Holder: holder, Created: "2026-05-19T23:50:00.000Z"})
	if _, err := VerifyVP(raw, happyOpts(holder)); !errors.Is(err, ErrVPFreshnessFailure) {
		t.Fatalf("err = %v, want the fixture refused as stale on its own", err)
	}

	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		t.Fatal(err)
	}
	var proof map[string]any
	if err := json.Unmarshal(top["proof"], &proof); err != nil {
		t.Fatal(err)
	}
	proof["created"] = "2026-05-20T00:00:20.000Z"
	twin, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	trimmed := strings.TrimSuffix(string(raw), "}")
	_, err = VerifyVP([]byte(trimmed+`,"Proof":`+string(twin)+"}"), happyOpts(holder))
	wantAmbiguous(t, err)
}

func TestVerifyVCProof_RefusesAMemberNamedTwice(t *testing.T) {
	vc := buildFixtureVC("did:web:atumlabs.xyz", mustTime(t, "2026-01-01T00:00:00Z"), nil,
		[]string{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
		"did:pkh:eip155:1:0x0000000000000000000000000000000000000001", ProofTypeSecp256k1Recovery2020)
	raw, err := json.Marshal(vc)
	if err != nil {
		t.Fatal(err)
	}
	twinned := withMemberAfter(t, raw, `"issuer":"did:web:atumlabs.xyz"`, `"Issuer":"did:web:elsewhere.example"`)
	err = VerifyVCProof(mustUnmarshalVC(t, twinned), twinned, &mockResolver{issuerDID: "did:web:atumlabs.xyz"},
		VerifyVCProofOptions{Context: context.Background()})
	wantAmbiguous(t, err)
}

// The freshness window reads the exact proof member's exact created, the
// string the signing input is rebuilt from, whatever else the envelope holds.
func TestRawProofCreated_ReadsTheExactProofMember(t *testing.T) {
	// Each twin comes after the exact member: encoding/json keeps the last
	// match of a folded name, so a folding read would return the twin.
	doc := []byte(`{"proof":{"created":"2026-05-19T23:50:00Z","Created":"2026-05-20T00:00:25Z"},"Proof":{"created":"2026-05-20T00:00:20Z"}}`)
	got, err := rawProofCreated(doc)
	if err != nil {
		t.Fatal(err)
	}
	if want := time.Date(2026, 5, 19, 23, 50, 0, 0, time.UTC); !got.Equal(want) {
		t.Fatalf("created = %s, want %s from proof.created", got, want)
	}
}
