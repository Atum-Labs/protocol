package biddecline

import (
	"encoding/json"
	"strings"
	"testing"
)

// The schema is embedded, so it has to compile with nothing but this module's own files on disk.
func TestEmbeddedSchemaCompiles(t *testing.T) {
	if len(schemaJSON) == 0 {
		t.Fatal("embedded BidDecline schema is empty")
	}
	if _, err := getValidator(); err != nil {
		t.Fatalf("embedded BidDecline schema failed to compile: %v", err)
	}
}

// An empty object must fail validation, never schema loading — a loading failure means the embed is broken.
func TestValidateReportsValidationNotLoadFailure(t *testing.T) {
	err := Validate([]byte(`{}`))
	if err == nil {
		t.Fatal("expected an empty object to fail BidDecline validation")
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
	const want = "/declarations/BidDecline/v1/schema.json"
	if !strings.HasSuffix(doc.ID, want) {
		t.Fatalf("embedded schema $id is %q, want one ending %q", doc.ID, want)
	}
}
