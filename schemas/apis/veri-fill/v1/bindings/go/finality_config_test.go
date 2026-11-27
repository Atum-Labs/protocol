package verifill

import (
	"encoding/json"
	"strings"
	"testing"

	gen "github.com/atum-labs/protocol/schemas/apis/veri-fill/v1/bindings/go/generated"
)

// `finality` and `time_to_final_ms` are optional on the wire: `finality` is never set on a
// commitment-based chain, and `finality` is an open set, so an unknown method is carried,
// never rejected.
func TestFinalityConfigDecodesFinalityAndTimeToFinal(t *testing.T) {
	body := `{"chains":[
	  {"chain_id":"eip155:42161","finality":"finalized",
	   "min_confirmations":1,"block_time_ms":250,"time_to_final_ms":1260000},
	  {"chain_id":"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp","commitment":"finalized",
	   "block_time_ms":400,"time_to_final_ms":13000},
	  {"chain_id":"eip155:999","finality":"attested","min_confirmations":3}
	]}`

	var resp gen.FinalityConfigResponse
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatalf("decode finality config: %v", err)
	}
	if len(resp.Chains) != 3 {
		t.Fatalf("chains: got %d, want 3", len(resp.Chains))
	}

	evm := resp.Chains[0]
	if evm.Finality == nil || *evm.Finality != "finalized" {
		t.Errorf("evm finality: got %v, want finalized", evm.Finality)
	}
	if evm.TimeToFinalMs == nil || *evm.TimeToFinalMs != 1_260_000 {
		t.Errorf("evm time_to_final_ms: got %v, want 1260000", evm.TimeToFinalMs)
	}

	sol := resp.Chains[1]
	if sol.Finality != nil {
		t.Errorf("solana finality: got %q, want absent", *sol.Finality)
	}
	if sol.TimeToFinalMs == nil || *sol.TimeToFinalMs != 13_000 {
		t.Errorf("solana time_to_final_ms: got %v, want 13000", sol.TimeToFinalMs)
	}

	unknown := resp.Chains[2]
	if unknown.Finality == nil || *unknown.Finality != "attested" {
		t.Errorf("unknown method carried verbatim: got %v, want attested", unknown.Finality)
	}
	if unknown.TimeToFinalMs != nil {
		t.Errorf("time_to_final_ms absent on the wire must decode as nil, got %d", *unknown.TimeToFinalMs)
	}
}

// A member this version does not declare, such as a chain-level label a server may still send,
// is ignored rather than rejected, and the entry decodes as if it were absent.
func TestFinalityConfigIgnoresUndeclaredMembers(t *testing.T) {
	body := `{"chains":[{"chain_id":"eip155:42161","finality_model":"probabilistic",
	  "finality":"finalized","min_confirmations":1}]}`

	var resp gen.FinalityConfigResponse
	if err := json.Unmarshal([]byte(body), &resp); err != nil {
		t.Fatalf("decode finality config with an undeclared member: %v", err)
	}
	if len(resp.Chains) != 1 {
		t.Fatalf("chains: got %d, want 1", len(resp.Chains))
	}
	entry := resp.Chains[0]
	if entry.ChainId != "eip155:42161" || entry.Finality == nil || *entry.Finality != "finalized" {
		t.Errorf("declared members must decode unchanged, got %+v", entry)
	}
	out, err := json.Marshal(entry)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if strings.Contains(string(out), "finality_model") {
		t.Errorf("an undeclared member must not survive a round trip, got %s", out)
	}
}

func TestFinalityConfigOmitsAbsentMembers(t *testing.T) {
	entry := gen.ChainFinalityConfig{ChainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"}
	out, err := json.Marshal(entry)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	for _, member := range []string{`"finality"`, `"time_to_final_ms"`} {
		if strings.Contains(string(out), member) {
			t.Errorf("absent member %s must be omitted, got %s", member, out)
		}
	}

	method, ms := "depth", int64(2_000)
	entry.Finality = &method
	entry.TimeToFinalMs = &ms
	out, err = json.Marshal(entry)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	for _, member := range []string{`"finality":"depth"`, `"time_to_final_ms":2000`} {
		if !strings.Contains(string(out), member) {
			t.Errorf("set member %s must be encoded, got %s", member, out)
		}
	}
}
