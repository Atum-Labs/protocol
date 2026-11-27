package paymentrequest

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/generated"
)

// The schema is embedded, so it has to compile with nothing but this module's own files on disk.
func TestEmbeddedSchemaCompiles(t *testing.T) {
	if len(schemaJSON) == 0 {
		t.Fatal("embedded PaymentRequest schema is empty")
	}
	if _, err := getValidator(); err != nil {
		t.Fatalf("embedded PaymentRequest schema failed to compile: %v", err)
	}
}

// An empty object must fail validation, never schema loading — a loading failure means the embed is broken.
func TestValidateReportsValidationNotLoadFailure(t *testing.T) {
	err := Validate([]byte(`{}`))
	if err == nil {
		t.Fatal("expected an empty object to fail PaymentRequest validation")
	}
	if strings.Contains(err.Error(), "failed to load") {
		t.Fatalf("schema could not be loaded: %v", err)
	}
}

// A mis-wired copy step would embed a different declaration's schema, which every other assertion here accepts.
func TestEmbeddedSchemaIsThisDeclaration(t *testing.T) {
	var doc struct {
		ID string `json:"$id"`
	}
	if err := json.Unmarshal(schemaJSON, &doc); err != nil {
		t.Fatalf("embedded schema is not valid JSON: %v", err)
	}
	// Suffix, not the whole IRI: the schema host still moves; the declaration path is what identifies it.
	const want = "/declarations/PaymentRequest/v1/schema.json"
	if !strings.HasSuffix(doc.ID, want) {
		t.Fatalf("embedded schema $id is %q, want one ending %q", doc.ID, want)
	}
}

// exampleWith returns example.json after edit has changed it, for a test that needs the example
// with one thing different.
func exampleWith(t *testing.T, edit func(doc map[string]any)) []byte {
	t.Helper()
	raw, err := os.ReadFile("../../example.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	edit(doc)
	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// Every chain needs the verifier, the escrow and the deposit's prehash, so a request missing any of them is refused.
func TestValidateRequiresContractFields(t *testing.T) {
	if err := Validate(exampleWith(t, func(map[string]any) {})); err != nil {
		t.Fatalf("example.json must validate: %v", err)
	}
	cases := map[string]func(doc map[string]any){
		"fulfillment_verifier":    func(doc map[string]any) { delete(doc, "fulfillment_verifier") },
		"escrow_contract_address": func(doc map[string]any) { delete(doc, "escrow_contract_address") },
		"message_prehash": func(doc map[string]any) {
			messages := doc["sender_auth"].(map[string]any)["signed_messages"].([]any)
			delete(messages[0].(map[string]any), "message_prehash")
		},
	}
	for field, drop := range cases {
		t.Run(field, func(t *testing.T) {
			err := Validate(exampleWith(t, drop))
			if err == nil {
				t.Fatalf("a request without %s must fail validation", field)
			}
			if !strings.Contains(err.Error(), field) {
				t.Fatalf("error does not name %s: %v", field, err)
			}
		})
	}
}

// STELLAR is a wire-valid message_scheme and a SEP-41 asset is a wire-valid CAIP-19 destination.
// Whether a Stellar source can be verified is the commitment check's call, not the schema's. A
// scheme the enum does not name is still refused.
func TestValidateAcceptsStellar(t *testing.T) {
	stellar := func(scheme string) func(doc map[string]any) {
		return func(doc map[string]any) {
			destination := doc["destination"].([]any)[0].(map[string]any)
			destination["asset_identifier"] = "stellar:testnet/sep41:CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5"
			destination["account"] = "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH"
			doc["sender_auth"].(map[string]any)["message_scheme"] = scheme
		}
	}
	if err := Validate(exampleWith(t, stellar("STELLAR"))); err != nil {
		t.Fatalf("a STELLAR request must validate: %v", err)
	}
	if err := Validate(exampleWith(t, stellar("STELLAR_PERMIT"))); err == nil {
		t.Fatal("a message_scheme the enum does not name must be refused")
	}
}

// max_source_amount is a count of the source asset's smallest units, so it is whole digits, as
// fulfillment_amount is. A dollar limit compares it against a cap, and a value the comparison
// can't order (NaN), or one below zero, would pass any cap. Both the schema and the generated
// decoder refuse them, so a consumer that decodes the request never sees one.
func TestValidateRefusesACeilingThatIsNotWholeUnits(t *testing.T) {
	withCeiling := func(ceiling string) func(doc map[string]any) {
		return func(doc map[string]any) { doc["max_source_amount"] = ceiling }
	}
	for _, bad := range []string{"NaN", "Inf", "+Inf", "-Inf", "-5000000", "1.5", "1e6", "0x10", " 100", ""} {
		t.Run(bad, func(t *testing.T) {
			doc := exampleWith(t, withCeiling(bad))
			if err := Validate(doc); err == nil || !strings.Contains(err.Error(), "max_source_amount") {
				t.Errorf("Validate accepted max_source_amount %q, or didn't name it: %v", bad, err)
			}
			var decoded generated.SchemaJson
			if err := json.Unmarshal(doc, &decoded); err == nil {
				t.Errorf("the generated decoder accepted max_source_amount %q", bad)
			}
		})
	}
	for name, edit := range map[string]func(doc map[string]any){
		"whole units": withCeiling("1000001"),
		"zero":        withCeiling("0"),
		"absent":      func(doc map[string]any) { delete(doc, "max_source_amount") },
	} {
		t.Run(name, func(t *testing.T) {
			doc := exampleWith(t, edit)
			if err := Validate(doc); err != nil {
				t.Errorf("Validate refused the %s ceiling: %v", name, err)
			}
			var decoded generated.SchemaJson
			if err := json.Unmarshal(doc, &decoded); err != nil {
				t.Errorf("the generated decoder refused the %s ceiling: %v", name, err)
			}
		})
	}
}
