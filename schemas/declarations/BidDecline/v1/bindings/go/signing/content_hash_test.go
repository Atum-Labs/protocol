package biddecline

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
	return ComputeBidDeclineHash(raw)
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
		t.Fatalf("ComputeBidDeclineHash: %v", err)
	}
	return h
}

func TestComputeBidDeclineHash_FormatAndDeterministic(t *testing.T) {
	h := mustHashDoc(t, baseDoc())
	if !hashPattern.MatchString(h) {
		t.Fatalf("content hash %q does not match %s", h, hashPattern)
	}
	if h != mustHashDoc(t, baseDoc()) {
		t.Fatal("content hash is not deterministic")
	}
}

// Tampering with any declared field must change the hash, so no field can be altered under a signature.
func TestComputeBidDeclineHash_EveryFieldIsBound(t *testing.T) {
	want := mustHashDoc(t, baseDoc())
	tampered := map[string]string{
		"payment_id":       "0x00000000000000000000000000000000000000000000000000000000000000ff",
		"quote_request_id": "qr-1",
		"reason_code":      "AUCTION_CLOSED",
		"message":          "other",
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

// Moving the identifier between payment_id and quote_request_id must change the hash.
func TestComputeBidDeclineHash_FieldsAreNotInterchangeable(t *testing.T) {
	a := baseDoc()
	a["payment_id"], a["quote_request_id"] = "id-1", ""
	b := baseDoc()
	b["payment_id"], b["quote_request_id"] = "", "id-1"
	if mustHashDoc(t, a) == mustHashDoc(t, b) {
		t.Fatal("moving the identifier between payment_id and quote_request_id left the hash unchanged")
	}
}

func TestComputeBidDeclineHash_WireContextDoesNotMatter(t *testing.T) {
	doc := baseDoc()
	doc["@context"] = []any{"https://www.w3.org/2018/credentials/v1", ContextURL, "https://w3id.org/security/suites/secp256k1recovery-2020/v2"}
	if mustHashDoc(t, doc) != mustHashDoc(t, baseDoc()) {
		t.Fatal("the wire @context changed the content hash")
	}
}

func TestComputeBidDeclineHash_RejectsMalformed(t *testing.T) {
	cases := map[string]func(map[string]any){
		"unknown key":                 func(d map[string]any) { d["reason"] = "DECLINE_REASON_DEADLINE_TOO_SHORT" },
		"proof block":                 func(d map[string]any) { d["proof"] = map[string]any{"type": "x"} },
		"missing field":               func(d map[string]any) { delete(d, "message") },
		"omitted optional field":      func(d map[string]any) { delete(d, "quote_request_id") },
		"prefixed reason_code":        func(d map[string]any) { d["reason_code"] = "decline_reason_internal" },
		"empty reason_code":           func(d map[string]any) { d["reason_code"] = "" },
		"null field":                  func(d map[string]any) { d["message"] = nil },
		"non-UTC issued_at":           func(d map[string]any) { d["issued_at"] = "2026-10-13T12:00:00+00:00" },
		"context without declaration": func(d map[string]any) { d["@context"] = []any{"https://example.com/other"} },
	}
	for name, mutate := range cases {
		doc := baseDoc()
		mutate(doc)
		if _, err := hashOf(t, doc); !errors.Is(err, ErrMalformedBidDecline) {
			t.Errorf("%s: got %v, want ErrMalformedBidDecline", name, err)
		}
	}
	if _, err := ComputeBidDeclineHash([]byte("{")); !errors.Is(err, ErrMalformedBidDecline) {
		t.Errorf("truncated JSON: got %v, want ErrMalformedBidDecline", err)
	}
}

// The embedded loader is shared process-wide; hashing concurrently must not race.
func TestComputeBidDeclineHash_Concurrent(t *testing.T) {
	want := mustHashDoc(t, baseDoc())
	raw, _ := json.Marshal(baseDoc())
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if got, err := ComputeBidDeclineHash(raw); err != nil || got != want {
				t.Errorf("concurrent hash = %q, %v", got, err)
			}
		}()
	}
	wg.Wait()
}
