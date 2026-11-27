package lddataintegrity

import (
	"errors"
	"regexp"
	"testing"
)

const testDeclContextURL = "https://schemas.atum.network/declarations/ContentHashTest/v1/context.jsonld"

func testDeclLoader() *DocumentLoader {
	return NewDocumentLoader(map[string]any{
		testDeclContextURL: map[string]any{
			"@context": map[string]any{
				"@version":   1.1,
				"@protected": true,
				"atum":       "https://schemas.atum.network/",
				"xsd":        "http://www.w3.org/2001/XMLSchema#",
				"payment_id": map[string]any{"@id": "atum:paymentId", "@type": "xsd:string"},
				"note":       map[string]any{"@id": "atum:contentHashTestNote", "@type": "xsd:string"},
			},
		},
	})
}

func testDeclDoc() map[string]any {
	return map[string]any{"@context": []any{testDeclContextURL}, "payment_id": "0xabc", "note": "n"}
}

func TestComputeContentHash_Format(t *testing.T) {
	h, err := ComputeContentHash(testDeclDoc(), testDeclContextURL, testDeclLoader())
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^0x[0-9a-f]{64}$`).MatchString(h) {
		t.Fatalf("content hash %q is not 0x + 64 lowercase hex", h)
	}
}

// The wire @context, proof and verifiableCredential never take part in the hash.
func TestComputeContentHash_IgnoresEnvelopeFields(t *testing.T) {
	loader := testDeclLoader()
	want, err := ComputeContentHash(testDeclDoc(), testDeclContextURL, loader)
	if err != nil {
		t.Fatal(err)
	}
	noisy := testDeclDoc()
	noisy["@context"] = []any{"https://www.w3.org/2018/credentials/v1", testDeclContextURL}
	noisy["proof"] = map[string]any{"type": CryptosuiteSecp256k1Recovery2020}
	noisy["verifiableCredential"] = []any{map[string]any{"id": "urn:uuid:ignored"}}
	got, err := ComputeContentHash(noisy, testDeclContextURL, loader)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("envelope fields changed the content hash: %s != %s", got, want)
	}

	changed := testDeclDoc()
	changed["note"] = "m"
	if h, _ := ComputeContentHash(changed, testDeclContextURL, loader); h == want {
		t.Fatal("changing a mapped field did not change the content hash")
	}
}

func TestComputeContentHash_RejectsBadArguments(t *testing.T) {
	loader := testDeclLoader()
	if _, err := ComputeContentHash(nil, testDeclContextURL, loader); err == nil {
		t.Error("nil document accepted")
	}
	if _, err := ComputeContentHash(testDeclDoc(), "", loader); err == nil {
		t.Error("empty context URL accepted")
	}
	if _, err := ComputeContentHash(testDeclDoc(), testDeclContextURL, nil); err == nil {
		t.Error("nil loader accepted")
	}
	if _, err := ComputeContentHash(testDeclDoc(), "https://unregistered.example/decl.jsonld", loader); !errors.Is(err, ErrUnknownContext) {
		t.Errorf("unregistered context: got %v, want ErrUnknownContext", err)
	}
}
