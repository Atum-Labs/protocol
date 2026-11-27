package lddataintegrity

import (
	"reflect"
	"sort"
	"strings"
	"testing"
)

// known-to-atum-v2 exists because v1 is @protected and defines only the
// settler, psp and atumOperatedService roles. A role value v1 does not define
// expands to a relative IRI, which URDNA2015 leaves out of the canonical
// N-Quads, so the signature on such a credential does not cover its role.
// v2 adds quoteAwarder and merchant and keeps every v1 term unchanged.

const ktaVocabulary = "https://schemas.atum.xyz/credentials/known-to-atum/v1#"

// ktaContextTerms returns the term definitions of the known-to-atum context
// the loader resolves for url.
func ktaContextTerms(t *testing.T, url string) map[string]any {
	t.Helper()
	doc, err := NewDocumentLoader(nil).LoadDocument(url)
	if err != nil {
		t.Fatalf("LoadDocument(%s) = %v, want the vendored context", url, err)
	}
	body, ok := doc.Document.(map[string]any)
	if !ok {
		t.Fatalf("context document is %T, want an object", doc.Document)
	}
	terms, ok := body["@context"].(map[string]any)
	if !ok {
		t.Fatalf("context's @context is %T, want an object", body["@context"])
	}
	return terms
}

// ktaCredential is a known-to-atum credential for role, naming contextURL.
func ktaCredential(t *testing.T, contextURL, role string) map[string]any {
	t.Helper()
	return parseJSONDocument(t, `{"@context":["`+W3CVCV1ContextURL+`","`+contextURL+`"],`+
		`"id":"urn:uuid:known-to-atum-v2-`+role+`",`+
		`"type":["VerifiableCredential","KnownToAtumVerifiableCredential"],`+
		`"issuer":"did:web:atumlabs.xyz",`+
		`"issuanceDate":"2026-01-01T00:00:00Z",`+
		`"expirationDate":"2026-03-02T00:00:00Z",`+
		`"credentialSubject":{"id":"did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","role":"`+role+`"}}`)
}

func roleTriple(role string) string {
	return "<" + ktaVocabulary + "role> <" + ktaVocabulary + role + "> "
}

func TestKnownToAtumV2_URL(t *testing.T) {
	if want := "https://schemas.atum.xyz/credentials/known-to-atum/v2"; KnownToAtumV2ContextURL != want {
		t.Errorf("KnownToAtumV2ContextURL = %q, want %q", KnownToAtumV2ContextURL, want)
	}
}

// v2 may only add terms. Every v1 term must be defined exactly as v1 defines
// it, the kta prefix included, and the only new terms are the two roles.
func TestKnownToAtumV2_KeepsEveryV1TermAndAddsTwoRoles(t *testing.T) {
	v1 := ktaContextTerms(t, KnownToAtumV1ContextURL)
	v2 := ktaContextTerms(t, KnownToAtumV2ContextURL)

	for term, def := range v1 {
		got, ok := v2[term]
		if !ok {
			t.Errorf("v2 drops v1's term %q", term)
			continue
		}
		if !reflect.DeepEqual(got, def) {
			t.Errorf("v2 redefines %q: v1 %#v, v2 %#v", term, def, got)
		}
	}

	var added []string
	for term := range v2 {
		if _, ok := v1[term]; !ok {
			added = append(added, term)
		}
	}
	sort.Strings(added)
	if want := []string{"merchant", "quoteAwarder"}; !reflect.DeepEqual(added, want) {
		t.Errorf("v2 adds %v to v1, want %v", added, want)
	}
	for _, role := range []string{"merchant", "quoteAwarder"} {
		if got, want := v2[role], "kta:"+role; got != want {
			t.Errorf("v2 defines %q as %#v, want %q", role, got, want)
		}
	}
}

// What a signature covers. Under v2 every role is in the canonical N-Quads.
// Under v1 the two roles v1 does not define are not, which is why they are
// issued under v2.
func TestKnownToAtumV2_EveryRoleIsInTheSignedNQuads(t *testing.T) {
	loader := NewDocumentLoader(nil)
	cases := []struct {
		role      string
		definedV1 bool
	}{
		{"settler", true},
		{"psp", true},
		{"atumOperatedService", true},
		{"quoteAwarder", false},
		{"merchant", false},
	}
	for _, c := range cases {
		t.Run(c.role, func(t *testing.T) {
			v2, err := Canonicalize(ktaCredential(t, KnownToAtumV2ContextURL, c.role), loader)
			if err != nil {
				t.Fatalf("Canonicalize under v2: %v", err)
			}
			if !strings.Contains(v2, roleTriple(c.role)) {
				t.Errorf("under v2 the canonical N-Quads lack the %s role:\n%s", c.role, v2)
			}

			v1, err := Canonicalize(ktaCredential(t, KnownToAtumV1ContextURL, c.role), loader)
			if err != nil {
				t.Fatalf("Canonicalize under v1: %v", err)
			}
			if got := strings.Contains(v1, "<"+ktaVocabulary+"role> "); got != c.definedV1 {
				t.Errorf("under v1, role in the canonical N-Quads = %v, want %v:\n%s", got, c.definedV1, v1)
			}
			if c.definedV1 && v1 != v2 {
				t.Errorf("a %s credential signs different N-Quads under v1 and v2:\n--- v1 ---\n%s--- v2 ---\n%s", c.role, v1, v2)
			}
		})
	}
}
