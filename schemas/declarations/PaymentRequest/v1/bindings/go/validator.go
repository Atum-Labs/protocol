package paymentrequest

import (
	_ "embed"
	"fmt"
	"strings"
	"sync"

	"github.com/xeipuuv/gojsonschema"
)

// schemaJSON is embedded so the validator works when this module is resolved on its own, with no surrounding repository on disk.
//
//go:embed schema.json
var schemaJSON []byte

var (
	schemaValidator *gojsonschema.Schema
	schemaOnce      sync.Once
	schemaErr       error
)

// getValidator loads the PaymentRequest JSON Schema on first call and caches it for subsequent calls.
// Uses sync.Once to ensure thread-safe lazy loading.
func getValidator() (*gojsonschema.Schema, error) {
	schemaOnce.Do(func() {
		schemaValidator, schemaErr = gojsonschema.NewSchema(gojsonschema.NewBytesLoader(schemaJSON))
		if schemaErr != nil {
			schemaErr = fmt.Errorf("failed to load PaymentRequest schema: %w", schemaErr)
		}
	})
	return schemaValidator, schemaErr
}

// Validate validates raw JSON data against the PaymentRequest JSON Schema, then applies the
// rules that sit above the schema (ValidateRules).
// Returns nil if valid, or a formatted error describing validation failures.
//
// The schema runs first, so a rule only ever sees a document of the right shape. A rule refusal
// carries its own error type — see UnsupportedDestinationAssetError — which a caller reaches for
// with errors.As to tell it apart from a shape failure.
//
// This function is thread-safe and uses lazy loading - the schema is loaded once
// on first call and cached for the lifetime of the process.
func Validate(jsonData []byte) error {
	validator, err := getValidator()
	if err != nil {
		return err
	}

	// Validate the JSON data against the schema
	documentLoader := gojsonschema.NewBytesLoader(jsonData)
	result, err := validator.Validate(documentLoader)
	if err != nil {
		return fmt.Errorf("schema validation failed: %w", err)
	}

	if !result.Valid() {
		return formatValidationErrors(result.Errors())
	}

	return ValidateRules(jsonData)
}

// formatValidationErrors converts gojsonschema validation errors into a user-friendly error message.
func formatValidationErrors(errors []gojsonschema.ResultError) error {
	if len(errors) == 0 {
		return fmt.Errorf("validation failed with unknown errors")
	}

	var errorMessages []string
	for _, err := range errors {
		// Create a more readable error message
		field := err.Field()
		if field == "(root)" {
			field = ""
		}

		var message string
		if field != "" {
			message = fmt.Sprintf("%s: %s", field, err.Description())
		} else {
			message = err.Description()
		}

		errorMessages = append(errorMessages, message)
	}

	if len(errorMessages) == 1 {
		return fmt.Errorf("validation error: %s", errorMessages[0])
	}

	return fmt.Errorf("validation errors: %s", strings.Join(errorMessages, "; "))
}
