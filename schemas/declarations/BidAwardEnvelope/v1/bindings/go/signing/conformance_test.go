package awardhash

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// goldenFile is the frozen cross-language contract shared with the TS port
// (signing/typescript). It lives two levels up from this package —
// schemas/declarations/BidAwardEnvelope/v1/conformance/ — and is regenerated
// from the Go binding (the canonical source; see conformance/README.md). Both
// languages assert against it; matching the file on both sides means they match
// each other.
const goldenRelPath = "../../../conformance/award-hash-golden.json"

type goldenCase struct {
	Name      string `json:"name"`
	PaymentID string `json:"payment_id"`
	QuoteHash string `json:"quote_hash"`
	SettlerID string `json:"settler_id"`
	AwardHash string `json:"award_hash"`
}

type goldenFile struct {
	DomainSeparator string       `json:"domain_separator"`
	Cases           []goldenCase `json:"cases"`
}

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("cwd: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(cwd, goldenRelPath))
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var g goldenFile
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("unmarshal golden: %v", err)
	}
	if len(g.Cases) == 0 {
		t.Fatal("golden has no cases")
	}
	return g
}

// TestConformance_Golden asserts the Go ComputeAwardHash reproduces every
// frozen vector. Drift here means either the implementation changed or the
// golden needs a deliberate, reviewed regeneration (and a "v1" bump if the
// preimage layout moved).
func TestConformance_Golden(t *testing.T) {
	g := loadGolden(t)

	if g.DomainSeparator != DomainSeparator {
		t.Fatalf("golden domain_separator %q != code DomainSeparator %q", g.DomainSeparator, DomainSeparator)
	}

	for _, c := range g.Cases {
		got, err := ComputeAwardHash(c.PaymentID, c.QuoteHash, c.SettlerID)
		if err != nil {
			t.Fatalf("case %q: ComputeAwardHash errored: %v", c.Name, err)
		}
		if got != c.AwardHash {
			t.Errorf("case %q: award_hash = %q, golden = %q", c.Name, got, c.AwardHash)
		}
	}
}
