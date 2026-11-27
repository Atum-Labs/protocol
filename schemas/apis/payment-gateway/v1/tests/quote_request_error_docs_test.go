package paymentgateway

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// A quote request that reached no settler says why on the same object a failed payment uses, so
// integrators read one shape. The 202 reply is always `collecting` and never carries it.
func TestQuoteRequestErrorDocs(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	type property struct {
		AllOf []struct {
			Ref string `yaml:"$ref"`
		} `yaml:"allOf"`
		Description string `yaml:"description"`
	}
	var doc struct {
		Components struct {
			Schemas map[string]struct {
				Description string              `yaml:"description"`
				Properties  map[string]property `yaml:"properties"`
			} `yaml:"schemas"`
		} `yaml:"components"`
	}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	schemas := doc.Components.Schemas

	for _, name := range []string{"QuoteRequestResponse", "QuoteRequestStatusResponse"} {
		schema, ok := schemas[name]
		if !ok {
			t.Fatalf("no %s schema", name)
		}
		field, ok := schema.Properties["error"]
		if !ok {
			t.Errorf("%s has no error property", name)
			continue
		}
		if len(field.AllOf) != 1 || field.AllOf[0].Ref != "#/components/schemas/PaymentFailure" {
			t.Errorf("%s.error is not allOf [PaymentFailure]: %+v", name, field)
		}
		for _, code := range []string{"NO_SETTLER_FOR_CORRIDOR", "SERVICE_BUSY"} {
			if !strings.Contains(field.Description, "`"+code+"`") {
				t.Errorf("%s.error does not name %s", name, code)
			}
		}
		for _, prop := range []string{"status", "decline_summary"} {
			if !strings.Contains(strings.Join(strings.Fields(schema.Properties[prop].Description), " "), "`error` says why") {
				t.Errorf("%s.%s does not point an empty batch at error", name, prop)
			}
		}
	}

	created := strings.Join(strings.Fields(schemas["QuoteRequestResponse"].Properties["error"].Description), " ")
	if !strings.Contains(created, "same absence rules as on the status endpoint") {
		t.Errorf("QuoteRequestResponse.error does not take the status endpoint's absence rules: %q", created)
	}
	// With no requested_count and no capacity refusal, nobody can say whether a settler serves the
	// pair, so a missing error must not read as "a settler was asked".
	status := strings.Join(strings.Fields(schemas["QuoteRequestStatusResponse"].Properties["error"].Description), " ")
	for _, rule := range []string{"while `status` is `collecting`", "whenever a settler was asked", "`requested_count` is absent for any reason other than `SERVICE_BUSY`"} {
		if !strings.Contains(status, rule) {
			t.Errorf("QuoteRequestStatusResponse.error absence rules miss %q: %q", rule, status)
		}
	}

	// A request refused for capacity never had an auction, so only NO_SETTLER_FOR_CORRIDOR pairs
	// with a requested_count.
	bullets := map[string]string{}
	for line := range strings.SplitSeq(schemas["QuoteRequestStatusResponse"].Properties["error"].Description, "\n- ") {
		for _, code := range []string{"NO_SETTLER_FOR_CORRIDOR", "SERVICE_BUSY"} {
			if strings.HasPrefix(line, "`"+code+"`") {
				bullet, _, _ := strings.Cut(line, "\n\n")
				bullets[code] = strings.Join(strings.Fields(bullet), " ")
			}
		}
	}
	if !strings.Contains(bullets["NO_SETTLER_FOR_CORRIDOR"], "`requested_count` is 0") {
		t.Errorf("the NO_SETTLER_FOR_CORRIDOR bullet does not say requested_count is 0: %q", bullets["NO_SETTLER_FOR_CORRIDOR"])
	}
	if bullet, ok := bullets["SERVICE_BUSY"]; !ok || strings.Contains(bullet, "requested_count") {
		t.Errorf("the SERVICE_BUSY bullet is missing or mentions requested_count, which it never has: %q", bullet)
	}

	accepted, ok := schemas["QuoteRequestAccepted"]
	if !ok {
		t.Fatal("no QuoteRequestAccepted schema")
	}
	if _, ok := accepted.Properties["error"]; ok {
		t.Error("QuoteRequestAccepted is always collecting and must not carry error")
	}

	paymentFailure, ok := schemas["PaymentFailure"]
	if !ok {
		t.Fatal("no PaymentFailure schema")
	}
	failure := strings.Join(strings.Fields(paymentFailure.Description), " ")
	if !strings.Contains(failure, "quote request") {
		t.Errorf("PaymentFailure is described for payments only: %q", failure)
	}
}
