package encoding

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"

	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
)

// TestEventTopic0Stability freezes the topic0 (event-signature keccak) of every escrow and
// fulfillment-proxy event off-chain consumers filter on. Each topic0 is derived from the event's
// signature in the SOURCE-EXTRACTED ABI (see collectEventTopic0s), so a change to an event's *type*
// signature — adding/removing a param, changing a param type, reordering typed params, or renaming
// the event — changes its topic0 and fails this test. topic0 is keccak of the type-only
// signature, so it does NOT move on an `indexed`-flag flip, a same-type reorder, or a param
// RENAME; those change the log-decode layout (or nothing) without changing topic0 — a known
// limitation of pinning topic0 alone.
//
// The golden pins the event shapes carried by the vendored Solidity in ../../../source, which is what
// the next escrow deployment will emit. Whether an entry matches the CURRENTLY-DEPLOYED contract
// differs per interface, and the distinction is load-bearing:
//
//   - IEscrow entries are deliberately post-CORE-2022 and DID move (4 events rotated, plus the new
//     DepositCommitments). Every off-chain consumer must be updated in lockstep with the redeploy, and
//     this guard is the alarm that says which ones.
//   - IFulfillmentProxy entries deliberately match the DEPLOYED values — Fulfilled 0x6344d803 and
//     FulfilledMany 0xa55853fe, both verifiable as PUSH32 constants in ../../../source/broadcast.
//     `settler` was restored and declared in its original position precisely so these would NOT
//     rotate, which is what lets consumers stay unchanged for both fulfillment events. If either
//     value moves, someone has reordered a parameter: topic0 hashes the TYPE-ONLY signature, so a
//     rename can never do it but a reorder always will.
//
// Why it matters: off-chain consumers match logs on these exact topic0s; if a deployed contract's
// event shape changes but a consumer's bindings don't, reshaped logs are silently never matched and
// every Deposited/Fulfilled is dropped. This golden freezes the current generation so a partial
// regen in THIS repo is red; the consumers live outside this repo and can't be enforced from here.
//
// When you intentionally change an event, reseed with `UPDATE_TOPIC0_GOLDEN=1 go test ./encoding/`
// and update every off-chain decoder of the changed event in lockstep.
func TestEventTopic0Stability(t *testing.T) {
	actual := collectEventTopic0s(t)
	goldenPath := filepath.Join("testdata", "event_topic0_golden.json")

	if os.Getenv("UPDATE_TOPIC0_GOLDEN") == "1" {
		b, err := json.MarshalIndent(actual, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(goldenPath, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Skipf("reseeded %s", goldenPath)
	}

	raw, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("read golden (seed once with UPDATE_TOPIC0_GOLDEN=1): %v", err)
	}
	var golden map[string]map[string]string
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatalf("parse golden: %v", err)
	}

	for _, contract := range sortedKeys(golden) {
		for _, name := range sortedKeys(golden[contract]) {
			want := golden[contract][name]
			got, ok := actual[contract][name]
			if !ok {
				t.Errorf("%s.%s: event no longer present in the ABI (removed/renamed). Update every "+
					"off-chain decoder of this event + regen bindings, then "+
					"reseed with UPDATE_TOPIC0_GOLDEN=1.", contract, name)
				continue
			}
			if got != want {
				t.Errorf("%s.%s: topic0 changed (event shape changed).\n  golden: %s\n  actual: %s\n"+
					"Regenerate bindings AND update every off-chain decoder to match, then reseed with "+
					"UPDATE_TOPIC0_GOLDEN=1.",
					contract, name, want, got)
			}
		}
	}
	// New events are safe (they can't silently break existing parsing) but should be added to the
	// golden so coverage stays complete.
	for _, contract := range sortedKeys(actual) {
		for _, name := range sortedKeys(actual[contract]) {
			if _, ok := golden[contract][name]; !ok {
				t.Logf("note: %s.%s is in the ABI but not the golden; add it if an off-chain consumer reads it.", contract, name)
			}
		}
	}
}

// collectEventTopic0s returns {contract: {eventName: topic0Hex}} for the escrow and
// fulfillment-proxy contracts, read from the committed generated bindings.
// abiSourceDir holds the ABIs extracted from the vendored Solidity by `make generate-abi`. This is the
// AUTHORITATIVE input: it is derived from source, not from anything this test could also be wrong about.
const abiSourceDir = "../../../../source/generated/abi"

// collectEventTopic0s derives topic0 from the SOURCE-EXTRACTED ABI, deliberately NOT from the ABI embedded
// in the generated bindings.
//
// This distinction is the whole point, and getting it wrong cost this repo two releases of silent drift.
// The guard previously read contracts.IEscrowMetaData.GetAbi() — the ABI baked into the very bindings it
// exists to police. When the bindings went stale, the golden and the "actual" both came from the same stale
// artifact, they agreed, and the test passed green while the deployed contract emitted six different
// topic0s. A guard that reads its subject as its own oracle cannot fail.
//
// Reading from source instead means the golden is compared against what the CONTRACTS say, so an event
// shape change fails here whether or not anyone remembered to regenerate.
func collectEventTopic0s(t *testing.T) map[string]map[string]string {
	t.Helper()
	out := map[string]map[string]string{}
	for _, name := range []string{"IEscrow", "IFulfillmentProxy"} {
		out[name] = eventTopic0sFromSourceABI(t, name)
	}
	return out
}

func eventTopic0sFromSourceABI(t *testing.T, contract string) map[string]string {
	t.Helper()
	path := filepath.Join(abiSourceDir, contract+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read source ABI %s (run `make generate-abi` in contracts/evm/source): %v", path, err)
	}
	parsed, err := abi.JSON(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("parse source ABI %s: %v", path, err)
	}
	got := map[string]string{}
	for name, ev := range parsed.Events {
		got[name] = ev.ID.Hex()
	}
	if len(got) == 0 {
		t.Fatalf("%s: source ABI declares no events — wrong file or an empty extraction", path)
	}
	return got
}

// TestGeneratedBindingsMatchSourceABI is the check whose absence let the drift persist: it compares the ABI
// EMBEDDED IN THE COMMITTED BINDINGS against the ABI extracted from source, and fails when they disagree.
//
// TestEventTopic0Stability alone cannot catch this. It asks "did the event shape change?"; this asks "are the
// bindings actually generated from the contracts they ship beside?" Those are different questions, and only
// the second one fails when someone edits a contract and forgets to run `make generate`.
func TestGeneratedBindingsMatchSourceABI(t *testing.T) {
	type pair struct {
		name string
		get  func() (*abi.ABI, error)
	}
	for _, p := range []pair{
		{"IEscrow", contracts.IEscrowMetaData.GetAbi},
		{"IFulfillmentProxy", contracts.IFulfillmentProxyMetaData.GetAbi},
	} {
		bound, err := p.get()
		if err != nil {
			t.Fatalf("%s: binding ABI: %v", p.name, err)
		}
		fromBinding := map[string]string{}
		for name, ev := range bound.Events {
			fromBinding[name] = ev.ID.Hex()
		}
		fromSource := eventTopic0sFromSourceABI(t, p.name)

		for _, name := range sortedKeys(fromSource) {
			got, ok := fromBinding[name]
			if !ok {
				t.Errorf("%s.%s: present in the SOURCE ABI but missing from the committed bindings — "+
					"the bindings are stale. Run `make generate` in contracts/evm/bindings/go/escrow-encoding.", p.name, name)
				continue
			}
			if got != fromSource[name] {
				t.Errorf("%s.%s: committed bindings disagree with the source ABI (STALE BINDINGS).\n"+
					"  source:   %s\n  bindings: %s\n"+
					"Run `make generate` in contracts/evm/bindings/go/escrow-encoding, then update every "+
					"off-chain decoder before reseeding the topic0 golden.",
					p.name, name, fromSource[name], got)
			}
		}
		for _, name := range sortedKeys(fromBinding) {
			if _, ok := fromSource[name]; !ok {
				t.Errorf("%s.%s: in the committed bindings but NOT in the source ABI — the event was "+
					"removed or renamed in Solidity and the bindings were never regenerated.", p.name, name)
			}
		}
	}
}

func sortedKeys[V any](m map[string]V) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}
