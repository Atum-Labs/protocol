package fulfillmentauthorization

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"github.com/xeipuuv/gojsonschema"

	"github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/jsonmembers"
)

//go:embed schema.json
var schemaJSON []byte

var (
	schemaValidator *gojsonschema.Schema
	schemaOnce      sync.Once
	schemaErr       error
)

func getValidator() (*gojsonschema.Schema, error) {
	schemaOnce.Do(func() {
		schemaValidator, schemaErr = gojsonschema.NewSchema(gojsonschema.NewBytesLoader(schemaJSON))
		if schemaErr != nil {
			schemaErr = fmt.Errorf("failed to load FulfillmentAuthorization schema: %w", schemaErr)
		}
	})
	return schemaValidator, schemaErr
}

// Validate checks the document against the FulfillmentAuthorization schema and
// the shared authorization rules (expiry, signer, amount, asset, recipient, nonce).
//
// It accepts the declaration on its own or as the settler identity-signs it, with
// `@context`, `type` and `proof` alongside the declaration fields. Validate does not
// verify that identity proof.
func Validate(jsonData []byte, opts ...Option) error {
	return validateWith(jsonData, newOptions(opts))
}

func validateWith(jsonData []byte, resolved options) error {
	validator, err := getValidator()
	if err != nil {
		return err
	}
	// Before anything reads the document. encoding/json matches member names case-insensitively
	// and keeps the last match, so a twin that JSON.parse and the quote's canonicalization both
	// ignore would be the value Go checks: an accept here would no longer show that the settler
	// signed what was validated.
	if path, err := jsonmembers.FirstAmbiguousMember(jsonData); err != nil {
		return fmt.Errorf("fulfillment authorization: %w", err)
	} else if path != "" {
		return fmt.Errorf("fulfillment authorization has ambiguous member %s: two members of one object fold to the same name", path)
	}
	jsonData, err = withoutIdentityProof(jsonData)
	if err != nil {
		return err
	}
	documentLoader := gojsonschema.NewBytesLoader(jsonData)
	result, err := validator.Validate(documentLoader)
	if err != nil {
		return fmt.Errorf("schema validation failed: %w", err)
	}
	if !result.Valid() {
		return formatValidationErrors(result.Errors())
	}
	return validateRules(jsonData, resolved)
}

// identityProofFields are the JSON-LD members the settler adds when it identity-signs
// the declaration. They are not declaration fields, so the schema does not list them.
var identityProofFields = []string{"@context", "type", "proof"}

// withoutIdentityProof returns the declaration fields of an identity-signed
// FulfillmentAuthorization, or the input unchanged when it carries no identity proof.
func withoutIdentityProof(jsonData []byte) ([]byte, error) {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(jsonData, &members); err != nil {
		return nil, fmt.Errorf("failed to unmarshal fulfillment authorization: %w", err)
	}
	found := false
	for _, field := range identityProofFields {
		if _, ok := members[field]; ok {
			found = true
		}
	}
	if !found {
		return jsonData, nil
	}
	if raw, ok := members["type"]; ok {
		var docType string
		if err := json.Unmarshal(raw, &docType); err != nil || docType != "FulfillmentAuthorization" {
			return nil, fmt.Errorf("validation error: type must be \"FulfillmentAuthorization\", got %s", raw)
		}
	}
	for _, field := range identityProofFields {
		delete(members, field)
	}
	return json.Marshal(members)
}

func formatValidationErrors(errors []gojsonschema.ResultError) error {
	if len(errors) == 0 {
		return fmt.Errorf("validation failed with unknown errors")
	}
	var errorMessages []string
	for _, err := range errors {
		field := err.Field()
		if field == "(root)" {
			field = ""
		}
		if field != "" {
			errorMessages = append(errorMessages, fmt.Sprintf("%s: %s", field, err.Description()))
		} else {
			errorMessages = append(errorMessages, err.Description())
		}
	}
	if len(errorMessages) == 1 {
		return fmt.Errorf("validation error: %s", errorMessages[0])
	}
	return fmt.Errorf("validation errors: %s", strings.Join(errorMessages, "; "))
}
