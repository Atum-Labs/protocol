package lddataintegrity

import (
	"errors"
	"strings"
	"testing"
)

// The three credential contexts moved off schemas.atum.network to
// schemas.atum.xyz. Both halves of each context moved: the URL a credential
// names in its @context, and the vocabulary that context expands the
// credential's terms to (the kta:, kyc: and sc: prefixes). The vocabulary
// is the half a signature covers. URDNA2015 writes term IRIs into the
// canonical N-Quads and never a context URL, so moving only the URL would
// have left every signature byte-identical and the vocabulary where it was.
//
// The move is a hard cut. The retired URLs are not kept as aliases: a
// credential that still names one is refused as an unknown context, exactly
// like any other URL the loader does not hold.

// credentialContext describes one credential context: what its URL must be,
// what it used to be, and a credential that exercises its vocabulary.
type credentialContext struct {
	name string
	// url is the exported constant under test; current is the value it must
	// hold. They are separate so a test can fail on the constant itself.
	url     string
	current string
	retired string
	// prefix is the term prefix the context defines, and must expand to
	// current + "#".
	prefix string
	// typeTerm is the credential type the context defines.
	typeTerm string
	// subjectJSON is the credentialSubject of a credential of this type;
	// claimTerm and claimValue are the claim it makes, both terms of the
	// context's vocabulary.
	subjectJSON string
	claimTerm   string
	claimValue  string
}

func credentialContexts() []credentialContext {
	return []credentialContext{
		{
			name:        "known-to-atum",
			url:         KnownToAtumV1ContextURL,
			current:     "https://schemas.atum.xyz/credentials/known-to-atum/v1",
			retired:     "https://schemas.atum.network/credentials/known-to-atum/v1",
			prefix:      "kta",
			typeTerm:    "KnownToAtumVerifiableCredential",
			subjectJSON: `{"id":"did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","role":"settler"}`,
			claimTerm:   "role",
			claimValue:  "settler",
		},
		{
			name:        "kyc",
			url:         KYCV1ContextURL,
			current:     "https://schemas.atum.xyz/credentials/kyc/v1",
			retired:     "https://schemas.atum.network/credentials/kyc/v1",
			prefix:      "kyc",
			typeTerm:    "KYCCredential",
			subjectJSON: `{"id":"did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","kycStatus":"approved"}`,
			claimTerm:   "kycStatus",
			claimValue:  "approved",
		},
		{
			name:        "sender-compliance",
			url:         SenderComplianceV1ContextURL,
			current:     "https://schemas.atum.xyz/credentials/sender-compliance/v1",
			retired:     "https://schemas.atum.network/credentials/sender-compliance/v1",
			prefix:      "sc",
			typeTerm:    "SenderComplianceCredential",
			subjectJSON: `{"id":"did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266","complianceStatus":"approved"}`,
			claimTerm:   "complianceStatus",
			claimValue:  "approved",
		},
	}
}

// credentialJSON is a credential of c's type naming contextURL as its
// second context.
func (c credentialContext) credentialJSON(contextURL string) string {
	return `{"@context":["` + W3CVCV1ContextURL + `","` + contextURL + `"],` +
		`"id":"urn:uuid:credential-contexts-` + c.name + `",` +
		`"type":["VerifiableCredential","` + c.typeTerm + `"],` +
		`"issuer":"did:web:atumlabs.xyz",` +
		`"issuanceDate":"2026-01-01T00:00:00Z",` +
		`"credentialSubject":` + c.subjectJSON + `}`
}

func TestCredentialContexts_URLsAreUnderSchemasAtumXYZ(t *testing.T) {
	for _, c := range credentialContexts() {
		t.Run(c.name, func(t *testing.T) {
			if c.url != c.current {
				t.Errorf("context URL = %q, want %q", c.url, c.current)
			}
		})
	}
}

// The guard against moving only the URL: each context's vocabulary must live
// under its own URL, so the two cannot be split apart again unnoticed.
func TestCredentialContexts_VocabularyIsUnderTheContextURL(t *testing.T) {
	loader := NewDocumentLoader(nil)
	for _, c := range credentialContexts() {
		t.Run(c.name, func(t *testing.T) {
			doc, err := loader.LoadDocument(c.current)
			if err != nil {
				t.Fatalf("LoadDocument(%s) = %v, want the vendored context", c.current, err)
			}
			body, ok := doc.Document.(map[string]any)
			if !ok {
				t.Fatalf("context document is %T, want an object", doc.Document)
			}
			terms, ok := body["@context"].(map[string]any)
			if !ok {
				t.Fatalf("context's @context is %T, want an object", body["@context"])
			}
			if got, want := terms[c.prefix], c.current+"#"; got != want {
				t.Errorf("prefix %q expands to %v, want %q", c.prefix, got, want)
			}
		})
	}
}

// What a signature actually covers: every term of a credential canonicalizes
// to an IRI under schemas.atum.xyz, and nothing under schemas.atum.network.
func TestCredentialContexts_CanonicalTermIRIsUseTheCurrentVocabulary(t *testing.T) {
	loader := NewDocumentLoader(nil)
	for _, c := range credentialContexts() {
		t.Run(c.name, func(t *testing.T) {
			nquads, err := Canonicalize(parseJSONDocument(t, c.credentialJSON(c.current)), loader)
			if err != nil {
				t.Fatalf("Canonicalize: %v", err)
			}
			vocab := c.current + "#"
			for _, want := range []string{
				"<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <" + vocab + c.typeTerm + "> ",
				"<" + vocab + c.claimTerm + "> <" + vocab + c.claimValue + "> ",
			} {
				if !strings.Contains(nquads, want) {
					t.Errorf("canonical N-Quads lack %q:\n%s", want, nquads)
				}
			}
			if strings.Contains(nquads, "atum.network") {
				t.Errorf("canonical N-Quads still name atum.network:\n%s", nquads)
			}
		})
	}
}

func TestCredentialContexts_RetiredURLsAreUnknownContexts(t *testing.T) {
	loader := NewDocumentLoader(nil)
	for _, c := range credentialContexts() {
		t.Run(c.name, func(t *testing.T) {
			if _, err := loader.LoadDocument(c.retired); !errors.Is(err, ErrUnknownContext) {
				t.Errorf("LoadDocument(%s) = %v, want ErrUnknownContext", c.retired, err)
			}

			out, panicked, err := canonicalizeRecovering(parseJSONDocument(t, c.credentialJSON(c.retired)), loader)
			if panicked != nil {
				t.Fatalf("Canonicalize panicked with %v, want ErrUnknownContext", panicked)
			}
			if out != "" {
				t.Errorf("Canonicalize output = %q alongside an error, want empty", out)
			}
			if !errors.Is(err, ErrUnknownContext) {
				t.Fatalf("Canonicalize = %v, want ErrUnknownContext", err)
			}
			if !strings.Contains(err.Error(), c.retired) {
				t.Errorf("err = %q, want it to name %s", err, c.retired)
			}
			var ae *AdmissionError
			if errors.As(err, &ae) || errors.Is(err, ErrCanonicalizationFailed) {
				t.Errorf("err = %v, also classified as an admission or canonicalization failure; want only ErrUnknownContext", err)
			}
		})
	}
}
