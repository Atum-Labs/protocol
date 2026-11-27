package settlementresult

import (
	"encoding/json"
	"errors"
	"regexp"
	"sync"
	"testing"
)

var hashPattern = regexp.MustCompile(`^0x[0-9a-f]{64}$`)

func hashOf(t *testing.T, doc map[string]any) (string, error) {
	t.Helper()
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return ComputeSettlementResultHash(raw)
}

func baseDoc() map[string]any {
	doc := map[string]any{"@context": []any{ContextURL}}
	for k, v := range base() {
		doc[k] = v
	}
	return doc
}

func mustHashDoc(t *testing.T, doc map[string]any) string {
	t.Helper()
	h, err := hashOf(t, doc)
	if err != nil {
		t.Fatalf("ComputeSettlementResultHash: %v", err)
	}
	return h
}

func TestComputeSettlementResultHash_FormatAndDeterministic(t *testing.T) {
	h := mustHashDoc(t, baseDoc())
	if !hashPattern.MatchString(h) {
		t.Fatalf("content hash %q does not match %s", h, hashPattern)
	}
	if h != mustHashDoc(t, baseDoc()) {
		t.Fatal("content hash is not deterministic")
	}
}

// Tampering with any declared field must change the hash, so no field can be altered under a signature.
func TestComputeSettlementResultHash_EveryFieldIsBound(t *testing.T) {
	want := mustHashDoc(t, baseDoc())
	tampered := map[string]string{
		"payment_id":       "0x00000000000000000000000000000000000000000000000000000000000000ff",
		"quote_request_id": "qr-1",
		"quote_hash":       "0x0000000000000000000000000000000000000000000000000000000000000001",
		"phase":            "RELEASE",
		"outcome":          "ERROR",
		"transaction_hash": "0xdead",
		"chain_id":         "eip155:1",
		"block_number":     "21587335",
		"error_json":       `{"code":"X"}`,
		"issued_at":        "2026-10-13T12:00:01.000Z",
	}
	for field, v := range tampered {
		doc := baseDoc()
		doc[field] = v
		if mustHashDoc(t, doc) == want {
			t.Errorf("changing %s did not change the content hash", field)
		}
	}
}

// Swapping two values between fields must change the hash: every field has its own IRI.
func TestComputeSettlementResultHash_FieldsAreNotInterchangeable(t *testing.T) {
	a := baseDoc()
	a["quote_request_id"], a["transaction_hash"] = "x", "y"
	b := baseDoc()
	b["quote_request_id"], b["transaction_hash"] = "y", "x"
	if mustHashDoc(t, a) == mustHashDoc(t, b) {
		t.Fatal("swapping quote_request_id and transaction_hash left the hash unchanged")
	}
}

func TestComputeSettlementResultHash_WireContextDoesNotMatter(t *testing.T) {
	doc := baseDoc()
	doc["@context"] = []any{"https://www.w3.org/2018/credentials/v1", ContextURL, "https://w3id.org/security/suites/secp256k1recovery-2020/v2"}
	if mustHashDoc(t, doc) != mustHashDoc(t, baseDoc()) {
		t.Fatal("the wire @context changed the content hash")
	}
}

func TestComputeSettlementResultHash_RejectsMalformed(t *testing.T) {
	cases := map[string]func(map[string]any){
		"unknown key":                 func(d map[string]any) { d["confirmations"] = "12" },
		"proof block":                 func(d map[string]any) { d["proof"] = map[string]any{"type": "x"} },
		"missing field":               func(d map[string]any) { delete(d, "error_json") },
		"omitted optional field":      func(d map[string]any) { delete(d, "block_number") },
		"unspecified phase":           func(d map[string]any) { d["phase"] = "UNSPECIFIED" },
		"unspecified outcome":         func(d map[string]any) { d["outcome"] = "UNSPECIFIED" },
		"prefixed phase":              func(d map[string]any) { d["phase"] = "settlement_phase_deposit" },
		"leading zero block":          func(d map[string]any) { d["block_number"] = "007" },
		"numeric block":               func(d map[string]any) { d["block_number"] = 7 },
		"null field":                  func(d map[string]any) { d["error_json"] = nil },
		"non-UTC issued_at":           func(d map[string]any) { d["issued_at"] = "2026-10-13T12:00:00+00:00" },
		"uppercase quote_hash":        func(d map[string]any) { d["quote_hash"] = "0x9F2C4A1E7B3D5C8A0E6F2B4D8C1A3E5F7092B4D6C8E0A2F4B6D8E0C2A4F6B8D0" },
		"non-CAIP-2 chain_id":         func(d map[string]any) { d["chain_id"] = "8453" },
		"empty payment_id":            func(d map[string]any) { d["payment_id"] = "" },
		"context without declaration": func(d map[string]any) { d["@context"] = []any{"https://example.com/other"} },
	}
	for name, mutate := range cases {
		doc := baseDoc()
		mutate(doc)
		if _, err := hashOf(t, doc); !errors.Is(err, ErrMalformedSettlementResult) {
			t.Errorf("%s: got %v, want ErrMalformedSettlementResult", name, err)
		}
	}
	if _, err := ComputeSettlementResultHash([]byte("{")); !errors.Is(err, ErrMalformedSettlementResult) {
		t.Errorf("truncated JSON: got %v, want ErrMalformedSettlementResult", err)
	}
}

// The embedded loader is shared process-wide; hashing concurrently must not race.
func TestComputeSettlementResultHash_Concurrent(t *testing.T) {
	want := mustHashDoc(t, baseDoc())
	raw, _ := json.Marshal(baseDoc())
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if got, err := ComputeSettlementResultHash(raw); err != nil || got != want {
				t.Errorf("concurrent hash = %q, %v", got, err)
			}
		}()
	}
	wg.Wait()
}
