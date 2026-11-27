package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/piprate/json-gold/ld"
	"github.com/xeipuuv/gojsonschema"
)

func main() {
	var validateExamples bool
	var validateContextSync bool
	flag.BoolVar(&validateExamples, "examples", false, "Validate example.json files against their schemas")
	flag.BoolVar(&validateContextSync, "context-sync", false, "Validate JSON-LD context files are in sync with their schemas")
	flag.Parse()

	if len(flag.Args()) < 1 {
		fmt.Println("Usage: go run schema-validator.go [--examples|--context-sync] <directory>")
		os.Exit(1)
	}

	dir := flag.Args()[0]

	if validateExamples {
		fmt.Printf("Validating examples against schemas in: %s\n", dir)
		if err := validateExamplesInDirectory(dir); err != nil {
			fmt.Printf("Example validation failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("✅ All examples validated successfully against their schemas")
		return
	}

	if validateContextSync {
		fmt.Printf("Validating JSON-LD context sync in: %s\n", dir)
		if err := validateContextSyncInDirectory(dir); err != nil {
			fmt.Printf("Context sync validation failed: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("✅ All JSON-LD contexts are in sync with their schemas")
		return
	}

	fmt.Printf("Validating schemas in: %s\n", dir)

	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		if d.IsDir() {
			return nil
		}

		if strings.HasSuffix(path, ".json") {
			return validateJSONFile(path)
		}

		if strings.HasSuffix(path, ".jsonld") {
			return validateJSONLDFile(path)
		}

		return nil
	})

	if err != nil {
		fmt.Printf("Validation failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("✅ All JSON and JSON-LD files validated successfully")
}

func validateExamplesInDirectory(dir string) error {
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		if d.IsDir() {
			return nil
		}

		// Look for example.json files
		if strings.HasSuffix(path, "example.json") {
			// Skip template files
			if strings.Contains(path, "template") {
				fmt.Printf("Skipping template file: %s\n", path)
				return nil
			}
			return validateExampleAgainstSchema(path)
		}

		return nil
	})
}

func validateExampleAgainstSchema(examplePath string) error {
	fmt.Printf("Validating example: %s\n", examplePath)

	// Find the corresponding schema.json file
	schemaPath := findSchemaFile(examplePath)
	if schemaPath == "" {
		fmt.Printf("  ⚠ Skipping (no schema.json found)\n")
		return nil
	}

	// Load the schema
	schemaLoader := gojsonschema.NewReferenceLoader("file://" + schemaPath)
	schema, err := gojsonschema.NewSchema(schemaLoader)
	if err != nil {
		return fmt.Errorf("failed to load schema %s: %w", schemaPath, err)
	}

	// Load the example
	exampleLoader := gojsonschema.NewReferenceLoader("file://" + examplePath)

	// Validate the example against the schema
	result, err := schema.Validate(exampleLoader)
	if err != nil {
		return fmt.Errorf("failed to validate %s against %s: %w", examplePath, schemaPath, err)
	}

	if !result.Valid() {
		var errors []string
		for _, err := range result.Errors() {
			errors = append(errors, err.String())
		}
		return fmt.Errorf("example %s is invalid against schema %s: %s",
			examplePath, schemaPath, strings.Join(errors, "; "))
	}

	fmt.Printf("  ✓ Example validated against schema\n")
	return nil
}

func findSchemaFile(examplePath string) string {
	// Get the directory containing the example
	dir := filepath.Dir(examplePath)

	// Look for schema.json in the same directory
	schemaPath := filepath.Join(dir, "schema.json")
	if _, err := os.Stat(schemaPath); err == nil {
		return schemaPath
	}

	// If not found, look in parent directory
	parentDir := filepath.Dir(dir)
	schemaPath = filepath.Join(parentDir, "schema.json")
	if _, err := os.Stat(schemaPath); err == nil {
		return schemaPath
	}

	// If still not found, look for any schema.json in the same directory tree
	// but only up to 2 levels up to avoid going too far
	for i := 0; i < 2; i++ {
		dir = filepath.Dir(dir)
		schemaPath = filepath.Join(dir, "schema.json")
		if _, err := os.Stat(schemaPath); err == nil {
			return schemaPath
		}
	}

	return ""
}

func validateContextSyncInDirectory(dir string) error {
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		if d.IsDir() {
			return nil
		}

		// Look for schema.json files
		if strings.HasSuffix(path, "schema.json") {
			// Find corresponding context.jsonld file
			contextPath := findContextFile(path)
			if contextPath != "" {
				return validateContextSchemaSync(path, contextPath)
			}
		}

		return nil
	})
}

func findContextFile(schemaPath string) string {
	// Get the directory containing the schema
	dir := filepath.Dir(schemaPath)

	// Look for context.jsonld in the same directory
	contextPath := filepath.Join(dir, "context.jsonld")
	if _, err := os.Stat(contextPath); err == nil {
		return contextPath
	}

	return ""
}

func validateContextSchemaSync(schemaPath, contextPath string) error {
	fmt.Printf("Validating context sync: %s <-> %s (%s)\n",
		filepath.Base(schemaPath), filepath.Base(contextPath), filepath.Dir(schemaPath))

	// Load schema and extract all property names
	schemaData, err := os.ReadFile(schemaPath)
	if err != nil {
		return fmt.Errorf("failed to read schema: %w", err)
	}

	var schema map[string]interface{}
	if err := json.Unmarshal(schemaData, &schema); err != nil {
		return fmt.Errorf("failed to parse schema: %w", err)
	}

	// Load context
	contextData, err := os.ReadFile(contextPath)
	if err != nil {
		return fmt.Errorf("failed to read context: %w", err)
	}

	var contextDoc map[string]interface{}
	if err := json.Unmarshal(contextData, &contextDoc); err != nil {
		return fmt.Errorf("failed to parse context: %w", err)
	}

	// Extract schema properties
	schemaFields := extractSchemaProperties(schema)

	// Extract context field mappings
	contextFields := extractContextFields(contextDoc)

	// Collect all validation errors instead of stopping at the first one
	var validationErrors []string

	// Check for missing fields in context
	var missingInContext []string
	for _, field := range schemaFields {
		if !contains(contextFields, field) {
			missingInContext = append(missingInContext, field)
		}
	}

	if len(missingInContext) > 0 {
		validationErrors = append(validationErrors, fmt.Sprintf("fields missing from JSON-LD context: %v", missingInContext))
	}

	// Check for obsolete fields in context that don't exist in schema (reverse validation)
	var extraInContext []string

	// Build skip list: namespace prefixes and type aliases
	skipContextFields := make(map[string]bool)
	if context, ok := contextDoc["@context"].(map[string]interface{}); ok {
		for key, value := range context {
			// Skip JSON-LD keywords
			if strings.HasPrefix(key, "@") {
				continue
			}
			// If value is a plain string (URL), it's a namespace prefix definition
			if _, isString := value.(string); isString {
				skipContextFields[key] = true
				continue
			}
			// If value is an object with "@type": "@id", check if it's a type alias
			if valueObj, ok := value.(map[string]interface{}); ok {
				if typeVal, ok := valueObj["@type"].(string); ok && typeVal == "@id" {
					// Check if @id references a type (ends with capitalized name after colon)
					if idVal, ok := valueObj["@id"].(string); ok {
						parts := strings.Split(idVal, ":")
						if len(parts) == 2 && strings.Title(parts[1]) == parts[1] {
							// This is a type reference/alias, skip it
							skipContextFields[key] = true
						}
					}
				}
			}
		}
	}

	// Common schema-level aliases and nested properties that aren't top-level data fields
	schemaAliases := map[string]bool{
		"bid_award":         true,
		"fulfillment_quote": true,
		"payment_request":   true,
		"auth":              true, // Generic auth alias
		"endpoint":          true, // Nested property in fulfillment_verifier
		// W3C security vocabulary terms used in DataIntegrityProof
		"proof":              true,
		"jws":                true,
		"proofValue":         true,
		"proofPurpose":       true,
		"verificationMethod": true,
		"created":            true,
		"assertionMethod":    true,
		// VP-side sibling of assertionMethod: W3C VC Data Model v1.1 §5.6
		// makes proofPurpose: "authentication" the canonical value for
		// VerifiablePresentation proofs. Same shape as assertionMethod —
		// it's a vocabulary alias (target of proofPurpose: @vocab), not
		// a schema property — so the context-sync check should treat it
		// identically and not flag it as an "obsolete" term.
		"authentication": true,
	}

	for _, field := range contextFields {
		// Skip type definitions (capitalized names), skipped context fields, schema aliases, and fields with colons
		if strings.Title(field) == field || skipContextFields[field] || schemaAliases[field] || strings.Contains(field, ":") {
			continue
		}
		if !contains(schemaFields, field) {
			extraInContext = append(extraInContext, field)
		}
	}

	if len(extraInContext) > 0 {
		validationErrors = append(validationErrors, fmt.Sprintf("obsolete fields in JSON-LD context (not in schema): %v", extraInContext))
	}

	// Return all validation errors if any were found
	if len(validationErrors) > 0 {
		return fmt.Errorf("%s", strings.Join(validationErrors, "; "))
	}

	// Use json-gold to validate that context can properly process all schema fields
	if err := validateContextCompleteness(schemaFields, contextDoc); err != nil {
		return fmt.Errorf("context validation failed: %w", err)
	}

	fmt.Printf("  ✓ Context is in sync with schema (%d fields validated)\n", len(schemaFields))
	return nil
}

func extractSchemaProperties(schema map[string]interface{}) []string {
	var fields []string
	visited := make(map[string]bool)

	// Fields that don't need explicit context mappings
	skipFields := map[string]bool{
		// JSON-LD keywords
		"@context": true,
		"@type":    true,
		"@id":      true,
		// Standard W3C VC fields that inherit from external contexts
		"issuer":            true,
		"issuanceDate":      true,
		"expirationDate":    true,
		"credentialStatus":  true,
		"credentialSubject": true,
		"proof":             true,
		"id":                true,
		"type":              true,
	}

	// Extract properties from top-level schema
	if properties, ok := schema["properties"].(map[string]interface{}); ok {
		for fieldName := range properties {
			if !visited[fieldName] && !skipFields[fieldName] {
				fields = append(fields, fieldName)
				visited[fieldName] = true
			}
		}
	}

	// Recursively check ALL $defs for custom properties (not just hardcoded ones)
	if defs, ok := schema["$defs"].(map[string]interface{}); ok {
		for _, defValue := range defs {
			if defObj, ok := defValue.(map[string]interface{}); ok {
				if properties, ok := defObj["properties"].(map[string]interface{}); ok {
					for fieldName := range properties {
						if !visited[fieldName] && !skipFields[fieldName] {
							fields = append(fields, fieldName)
							visited[fieldName] = true
						}
					}
				}
			}
		}
	}

	return fields
}

func extractContextFields(contextDoc map[string]interface{}) []string {
	var fields []string

	if context, ok := contextDoc["@context"].(map[string]interface{}); ok {
		for key, value := range context {
			// Skip JSON-LD keywords
			if strings.HasPrefix(key, "@") {
				continue
			}

			// Add field regardless of whether it's a simple string or object mapping
			switch value.(type) {
			case string:
				fields = append(fields, key)
			case map[string]interface{}:
				fields = append(fields, key)
			}
		}
	}

	return fields
}

func validateContextCompleteness(fields []string, contextDoc map[string]interface{}) error {
	// Create a test document with all schema fields
	testDoc := map[string]interface{}{
		"@context": contextDoc["@context"],
	}

	// Add all schema fields with dummy values
	for _, field := range fields {
		testDoc[field] = "test_value"
	}

	// Try to expand using json-gold - if this succeeds without error,
	// it means the context can handle all the fields
	proc := ld.NewJsonLdProcessor()
	options := ld.NewJsonLdOptions("")

	_, err := proc.Expand(testDoc, options)
	if err != nil {
		return fmt.Errorf("context cannot handle all schema fields: %w", err)
	}

	// If expansion succeeded, the context is complete
	return nil
}

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

// isTSConfig reports whether path is a TypeScript compiler config (tsconfig.json,
// tsconfig.test.json, ...). Those are JSONC -- tsc accepts comments in them -- so a strict
// JSON parse rejects valid configs, and they are not schemas either.
func isTSConfig(path string) bool {
	base := filepath.Base(path)
	matched, _ := filepath.Match("tsconfig.*.json", base)
	return base == "tsconfig.json" || matched
}

func validateJSONFile(path string) error {
	fmt.Printf("Validating: %s\n", path)

	if strings.Contains(path, "node_modules") ||
		strings.Contains(path, ".git") ||
		strings.Contains(path, "package.json") ||
		strings.Contains(path, "pnpm-lock.yaml") ||
		isTSConfig(path) {
		return nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("failed to read %s: %w", path, err)
	}

	var v interface{}
	if err := json.Unmarshal(data, &v); err != nil {
		return fmt.Errorf("invalid JSON in %s: %w", path, err)
	}

	// example.json files AND conformance/fixtures/*.json files are
	// fixtures, not schemas. The isJSONSchemaFile heuristic below
	// classifies on the presence of JSON Schema keywords like `type` or
	// `required`, which collides with W3C-shaped examples (e.g. a VP's
	// top-level `type: ["VerifiablePresentation"]` is W3C `@type`, not
	// a JSON Schema type declaration). The conformance fixtures
	// carry the same wire shape — signed
	// FQ / VP documents — and trip the same heuristic. Both are
	// covered by their own validation paths (validate-examples for
	// example.json; cross-language verify tests for the conformance
	// fixtures), so skipping the schema check here avoids the false
	// positive without weakening real schema validation.
	// testdata/ is Go's conventional home for fixtures a package's own tests own, and the
	// documents there are wire artifacts for the same reason as the two above — a golden
	// signed envelope carries `type: ["VerifiablePresentation", …]`, which this heuristic
	// reads as a JSON Schema type declaration. Their correctness is asserted by the golden
	// tests that produced them, byte for byte, which is a stricter check than this one.
	if strings.HasSuffix(path, "example.json") ||
		strings.Contains(filepath.ToSlash(path), "/conformance/fixtures/") ||
		strings.Contains(filepath.ToSlash(path), "/testdata/") {
		fmt.Printf("  ✓ Basic JSON validation passed (skipping schema check for fixture)\n")
		return nil
	}

	if isJSONSchemaFile(path) {
		if err := validateJSONSchema(data); err != nil {
			return fmt.Errorf("invalid JSON Schema in %s: %w", path, err)
		}
		fmt.Printf("  ✓ JSON Schema validation passed\n")
	} else {
		fmt.Printf("  ✓ Basic JSON validation passed\n")
	}

	return nil
}

func validateJSONLDFile(path string) error {
	fmt.Printf("Validating JSON-LD: %s\n", path)

	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("failed to read %s: %w", path, err)
	}

	// First, check if it's valid JSON
	var doc interface{}
	if err := json.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("invalid JSON in %s: %w", path, err)
	}

	// Use json-gold to validate JSON-LD
	proc := ld.NewJsonLdProcessor()
	options := ld.NewJsonLdOptions("")

	// Try to expand the JSON-LD document
	_, err = proc.Expand(doc, options)
	if err != nil {
		return fmt.Errorf("JSON-LD validation failed in %s: %w", path, err)
	}

	fmt.Printf("  ✓ JSON-LD validation passed\n")
	return nil
}

func isJSONSchemaFile(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}

	var content map[string]interface{}
	if err := json.Unmarshal(data, &content); err != nil {
		return false
	}

	schemaKeywords := []string{
		"$schema", "$id", "$ref", "$defs", "definitions",
		"type", "properties", "required", "items", "additionalProperties",
		"pattern", "format", "minimum", "maximum", "minLength", "maxLength",
		"enum", "const", "allOf", "anyOf", "oneOf", "not",
	}

	for _, keyword := range schemaKeywords {
		if _, exists := content[keyword]; exists {
			return true
		}
	}

	if schema, ok := content["$schema"].(string); ok {
		return strings.Contains(schema, "json-schema.org")
	}

	return false
}

func validateJSONSchema(data []byte) error {
	schemaLoader := gojsonschema.NewBytesLoader(data)
	metaSchemaURL := "https://json-schema.org/draft/2020-12/schema"
	metaSchemaLoader := gojsonschema.NewReferenceLoader(metaSchemaURL)
	result, err := gojsonschema.Validate(metaSchemaLoader, schemaLoader)
	if err != nil {
		return fmt.Errorf("failed to validate JSON Schema: %w", err)
	}
	if !result.Valid() {
		var errors []string
		for _, err := range result.Errors() {
			errors = append(errors, err.String())
		}
		return fmt.Errorf("JSON Schema validation failed: %s", strings.Join(errors, "; "))
	}
	return nil
}
