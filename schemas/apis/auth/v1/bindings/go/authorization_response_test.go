package auth

import (
	"encoding/json"
	"sort"
	"testing"
)

// decline_reason is optional, and absent on every response that does not decline on the
// per-payment amount limit alone. An unset reason must leave the body exactly as it was
// before the field existed, so every approval and every other decline still answers with
// request_id and decision only.
func TestAuthorizationResponse_UnsetDeclineReasonLeavesTheBodyAsItWas(t *testing.T) {
	for _, d := range []AuthorizationResponseDecision{APPROVED, DECLINED, RETRY} {
		body, err := json.Marshal(AuthorizationResponse{RequestId: "req-1", Decision: d})
		if err != nil {
			t.Fatalf("%s: marshal: %v", d, err)
		}
		var m map[string]json.RawMessage
		if err := json.Unmarshal(body, &m); err != nil {
			t.Fatalf("%s: unmarshal: %v", d, err)
		}
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		if len(keys) != 2 || keys[0] != "decision" || keys[1] != "request_id" {
			t.Errorf("%s: body has keys %v, want [decision request_id]: %s", d, keys, body)
		}
	}
}

// The reason round-trips under its wire name and value.
func TestAuthorizationResponse_DeclineReasonOnTheWire(t *testing.T) {
	reason := DeclineReasonAmountLimit
	body, err := json.Marshal(AuthorizationResponse{RequestId: "req-1", Decision: DECLINED, DeclineReason: &reason})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"decision":"DECLINED","decline_reason":"AMOUNT_LIMIT","request_id":"req-1"}`
	if string(body) != want {
		t.Fatalf("body = %s, want %s", body, want)
	}
}

// A payment gateway built before the field existed reads the decision and ignores the
// reason. One built against this binding reads a value it does not know without failing
// the whole response, and has to treat it as absent itself.
func TestAuthorizationResponse_ReadersTolerateTheReason(t *testing.T) {
	type before struct {
		Decision  string `json:"decision"`
		RequestId string `json:"request_id"`
	}
	var old before
	if err := json.Unmarshal([]byte(`{"decision":"DECLINED","decline_reason":"AMOUNT_LIMIT","request_id":"r"}`), &old); err != nil {
		t.Fatalf("a reader built before decline_reason rejected it: %v", err)
	}
	if old.Decision != "DECLINED" || old.RequestId != "r" {
		t.Fatalf("an old reader lost a field it does read: %+v", old)
	}

	var cur AuthorizationResponse
	if err := json.Unmarshal([]byte(`{"decision":"DECLINED","decline_reason":"SOMETHING_NEWER","request_id":"r"}`), &cur); err != nil {
		t.Fatalf("a newer reason rejected the whole response: %v", err)
	}
	if cur.Decision != DECLINED || cur.DeclineReason == nil || *cur.DeclineReason == DeclineReasonAmountLimit {
		t.Fatalf("a newer reason must arrive as itself, never as AMOUNT_LIMIT: %+v", cur)
	}
}
