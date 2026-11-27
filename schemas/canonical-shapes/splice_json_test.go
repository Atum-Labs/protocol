package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// A declaration with three $defs members, so a replacement can be exercised in the middle
// (comma kept), at the end (no comma), and against a neighbour that must not move.
const declFixture = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Thing",
  "properties": {
    "Target": { "type": "string" }
  },
  "$defs": {
    "Before": {
      "type": "string"
    },
    "Target": {
      "type": "object",
      "properties": { "stale": { "type": "string" } }
    },
    "After": {
      "type": "string"
    }
  }
}
`

func TestSpliceDefReplacesAMiddleMemberAndKeepsItsComma(t *testing.T) {
	out, err := spliceDef([]byte(declFixture), "Target", bodyNode(t, `{"type":"integer"}`))
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	// The whole document must still parse — a lost or doubled comma shows up here.
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("result is not valid JSON: %v\n%s", err, out)
	}
	defs := doc["$defs"].(map[string]any)
	if got := defs["Target"].(map[string]any)["type"]; got != "integer" {
		t.Errorf("Target was not replaced, got type %v", got)
	}
	for _, n := range []string{"Before", "After"} {
		if _, ok := defs[n]; !ok {
			t.Errorf("neighbour %s was lost", n)
		}
	}
	if strings.Contains(string(out), "stale") {
		t.Error("the previous body survived")
	}
}

// The last member has no trailing comma; adding one would break the document.
func TestSpliceDefReplacesTheLastMemberWithoutAddingAComma(t *testing.T) {
	out, err := spliceDef([]byte(declFixture), "After", bodyNode(t, `{"type":"boolean"}`))
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatalf("result is not valid JSON: %v\n%s", err, out)
	}
	if got := doc["$defs"].(map[string]any)["After"].(map[string]any)["type"]; got != "boolean" {
		t.Errorf("After was not replaced, got %v", got)
	}
}

// A name that also appears outside $defs must not be mistaken for the definition.
func TestSpliceDefIgnoresOccurrencesOutsideDefs(t *testing.T) {
	out, err := spliceDef([]byte(declFixture), "Target", bodyNode(t, `{"type":"integer"}`))
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	var doc map[string]any
	json.Unmarshal(out, &doc)
	props := doc["properties"].(map[string]any)
	if got := props["Target"].(map[string]any)["type"]; got != "string" {
		t.Errorf("the property named Target was rewritten, got %v", got)
	}
}

func TestSpliceDefRejectsAnUnknownName(t *testing.T) {
	_, err := spliceDef([]byte(declFixture), "Missing", bodyNode(t, `{"type":"string"}`))
	if err == nil || !strings.Contains(err.Error(), "Missing") {
		t.Errorf("want an error naming the missing def, got %v", err)
	}
}

func TestSpliceDefRejectsADocumentWithNoDefs(t *testing.T) {
	_, err := spliceDef([]byte(`{"title": "x"}`), "Target", bodyNode(t, `{"type":"string"}`))
	if err == nil || !strings.Contains(err.Error(), "$defs") {
		t.Errorf("want a no-$defs error, got %v", err)
	}
}
