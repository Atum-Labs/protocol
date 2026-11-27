package ldverification

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestConformance_RequestHashMatchesGolden is the Go leg of the
// content-addressed request_hash parity contract. It asserts ComputeRequestHash
// reproduces the committed golden value for every fixture; the TS
// conformance.test.ts asserts the same golden from its computeRequestHash. If
// both sides match this one committed file, they match each other — so this
// pins Go↔TS request_hash parity without a cross-process test.
//
// A drift in either canonicalization, the request_hash strip set, or the
// keccak256(DocHash) shaping changes the output and fires here. To intentionally
// rebaseline, regenerate the golden (see conformance/README.md) — the diff is
// reviewable.
func TestConformance_RequestHashMatchesGolden(t *testing.T) {
	goldenPath := filepath.Join(conformanceFixturesDir(t), "..", "request-hash-golden.json")
	raw, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("read golden %s: %v", goldenPath, err)
	}
	var golden map[string]string
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatalf("parse golden: %v", err)
	}

	for _, name := range []string{
		"secp256k1-go-signed.json", "secp256k1-ts-signed.json",
		"ed25519-go-signed.json", "ed25519-ts-signed.json",
	} {
		want, ok := golden[name]
		if !ok {
			t.Errorf("golden has no entry for %s", name)
			continue
		}
		got, err := ComputeRequestHash(readFixture(t, name))
		if err != nil {
			t.Fatalf("ComputeRequestHash(%s): %v", name, err)
		}
		if got != want {
			t.Errorf("request_hash(%s) = %s, golden = %s", name, got, want)
		}
	}

	// Cross-suite invariant: the secp and ed25519 fixtures carry different
	// content (request_id), so their request_hashes MUST differ. (The inverse
	// of FQ's DependsOnCreated — this pins that request_hash tracks CONTENT, and
	// guards against an accidental collapse to a content-blind constant.)
	if golden["secp256k1-go-signed.json"] == golden["ed25519-go-signed.json"] {
		t.Error("secp and ed25519 fixtures hash identically — request_hash is not content-sensitive across the fixture set")
	}
	// Within-suite parity: go-signed and ts-signed share content + differ only
	// in signature material, so pure-content request_hash MUST collide.
	if golden["secp256k1-go-signed.json"] != golden["secp256k1-ts-signed.json"] {
		t.Error("secp go-signed vs ts-signed request_hash differ — pure-content / signature-independence regressed")
	}
}

// An originator-executed deposit's request carries deposit_nonce, a term the context defines so
// request_hash covers it. Go and TS must canonicalize it alike: both assert this golden.
func TestConformance_RequestHashOfADirectDepositMatchesGolden(t *testing.T) {
	path := filepath.Join(conformanceFixturesDir(t), "..", "request-hash-direct-deposit-golden.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden %s: %v", path, err)
	}
	var golden struct {
		Request string `json:"request"`
		Want    string `json:"want"`
	}
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatalf("parse golden: %v", err)
	}
	got, err := ComputeRequestHash([]byte(golden.Request))
	if err != nil {
		t.Fatalf("ComputeRequestHash: %v", err)
	}
	if got != golden.Want {
		t.Errorf("request_hash = %s, golden = %s", got, golden.Want)
	}
}
