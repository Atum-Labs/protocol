package authorizationresponse

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

// getValidator loads the AuthorizationResponse JSON Schema on first call and caches it for subsequent calls.
// Uses sync.Once to ensure thread-safe lazy loading.
func getValidator() (*gojsonschema.Schema, error) {
	schemaOnce.Do(func() {
		schemaValidator, schemaErr = gojsonschema.NewSchema(gojsonschema.NewBytesLoader(schemaJSON))
		if schemaErr != nil {
			schemaErr = fmt.Errorf("failed to load AuthorizationResponse schema: %w", schemaErr)
		}
	})
	return schemaValidator, schemaErr
}

// Validate validates raw JSON data against the AuthorizationResponse JSON Schema.
// Returns nil if valid, or a formatted error describing validation failures.
//
// This function is thread-safe and uses lazy loading - the schema is loaded once
// on first call and cached for the lifetime of the process.
func Validate(jsonData []byte) error {
	validator, err := getValidator()
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

	return nil
}

// formatValidationErrors converts gojsonschema validation errors into a user-friendly error message.
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
