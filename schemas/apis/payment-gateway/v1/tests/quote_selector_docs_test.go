package paymentgateway

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// A quote request names the account that signs the award's reserve. Leaving the field out
// stands for nothing, so no description may describe a default.
func TestQuoteSelectorDocsOnQuoteRequests(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Paths map[string]map[string]struct {
			Responses map[string]struct {
				Description string `yaml:"description"`
			} `yaml:"responses"`
		} `yaml:"paths"`
		Components struct {
			Schemas map[string]struct {
				Properties map[string]struct {
					Description string `yaml:"description"`
				} `yaml:"properties"`
			} `yaml:"schemas"`
		} `yaml:"components"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}

	create, ok := doc.Components.Schemas["CreateQuoteRequest"]
	if !ok {
		t.Fatal("no CreateQuoteRequest schema")
	}
	desc := strings.Join(strings.Fields(create.Properties["quote_selector"].Description), " ")
	if strings.Contains(strings.ToLower(desc), "omit") {
		t.Errorf("CreateQuoteRequest.quote_selector still describes omitting it: %q", desc)
	}
	if !strings.Contains(desc, "`source.account`") {
		t.Errorf("CreateQuoteRequest.quote_selector does not name source.account as the usual value: %q", desc)
	}

	op, ok := doc.Paths["/v1/payments/quote-requests"]["post"]
	if !ok {
		t.Fatal("no POST /v1/payments/quote-requests")
	}
	if !strings.Contains(op.Responses["400"].Description, "MISSING_QUOTE_SELECTOR") {
		t.Error("the quote-request 400 response does not name MISSING_QUOTE_SELECTOR")
	}

	// Generated blocks come from the canonical-shapes overlays, so those are read as well.
	overlays, err := filepath.Glob(filepath.Join("..", "canonical-shapes*.yaml"))
	if err != nil || len(overlays) == 0 {
		t.Fatalf("no canonical-shapes overlays found: %v", err)
	}
	texts := map[string][]byte{"openapi.yaml": raw}
	for _, path := range overlays {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		texts[filepath.Base(path)] = b
	}
	for name, text := range texts {
		flat := strings.Join(strings.Fields(string(text)), " ")
		for _, fallback := range []*regexp.Regexp{
			regexp.MustCompile("(?i)omitted `?quote_selector"),
			regexp.MustCompile("(?i)`source\\.account`[^.]* when (it|the quote request) (was )?omitted"),
		} {
			if m := fallback.FindString(flat); m != "" {
				t.Errorf("%s still describes a source.account fallback for quote_selector: %q", name, m)
			}
		}
	}
}

// The PaymentRequest declaration is shared by every way of paying, so its quote_selector text says
// what the field is, and leaves whether it is required, or what its absence means, to each endpoint.
func TestQuoteSelectorDeclarationNamesNoFlowOrDefault(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "declarations", "PaymentRequest", "v1", "schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var decl struct {
		Properties map[string]struct {
			Description string `json:"description"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(raw, &decl); err != nil {
		t.Fatal(err)
	}
	desc, ok := decl.Properties["quote_selector"]
	if !ok || desc.Description == "" {
		t.Fatal("the PaymentRequest declaration does not describe quote_selector")
	}
	lower := strings.ToLower(desc.Description)
	for _, word := range []string{"default", "leave empty", "omit", "quote request", "/v1/", "direct deposit", "x402"} {
		if strings.Contains(lower, word) {
			t.Errorf("the declaration's quote_selector description mentions %q: %q", word, desc.Description)
		}
	}
	if !strings.Contains(lower, "reserve") {
		t.Errorf("the declaration's quote_selector description does not say the account signs the reserve: %q", desc.Description)
	}
}
