package atumerror

import (
	"encoding/json"
	"testing"
)

// request_id_reusable answers a question retry_classification does not: may the
// caller re-send this same request_id. The two come apart, which is why the field
// exists. A malformed body and an unserved corridor are both
// NOT_RETRYABLE_FIX_REQUEST, and only the first leaves the id free.

// A classification that presupposes a payment cannot sit on an entry that also
// claims the id is still free. Those two statements contradict each other, and the
// contradiction is the one that costs money: it invites a caller to re-send an id
// that is already bound to a payment.
func TestReusableIsNotClaimedWhereAPaymentMustExist(t *testing.T) {
	presupposesAPayment := map[RetryClassification]string{
		ReconcileThenDecide: "tells the caller to reconcile a payment, so one exists",
		AlreadyDone:         "says the operation already completed, so one exists",
	}

	// POLL_FOR_COMPLETION is deliberately not in that map, because it means two
	// different things depending on which surface returns it. On the payment path
	// (CONFLICT_IN_PROGRESS) it means poll the status endpoint and the id is spent.
	// On the verification service (EVENT_NOT_FOUND, INSUFFICIENT_CONFIRMATIONS) the
	// poll IS re-sending the same request, and no payment is involved at all. One
	// value carrying both readings is a real defect, tracked separately, but it
	// cannot be expressed as an invariant here.

	for code, e := range catalog.Entries {
		why, presupposed := presupposesAPayment[e.RetryClassification]
		if !presupposed {
			continue
		}
		if e.RequestIdReusable != nil && *e.RequestIdReusable {
			t.Errorf("%s is %s, which %s, yet it claims request_id_reusable=true",
				code, e.RetryClassification, why)
		}
	}
}

// The field is optional on purpose, but an absent value is read as "not reusable",
// so leaving it off a plain validation rejection needlessly blocks the obvious
// retry. Every entry that rejects the request outright should say so explicitly.
func TestFixRequestEntriesStateWhetherTheIdSurvives(t *testing.T) {
	for code, e := range catalog.Entries {
		if e.RetryClassification != NotRetryableFixRequest {
			continue
		}
		if e.RequestIdReusable == nil {
			t.Errorf("%s is NOT_RETRYABLE_FIX_REQUEST but does not say whether the "+
				"request_id survives, so a caller must assume it did not", code)
		}
	}
}

func TestToErrorResponse_CarriesReusability(t *testing.T) {
	// MALFORMED_REQUEST_BODY is rejected at ingress, so the id is untouched.
	got := New(CodeMalformedRequestBody, "internal detail", "req-1", "PAYMENT_GATEWAY", nil).
		ToErrorResponse()
	if got.RequestIdReusable == nil {
		t.Fatal("MALFORMED_REQUEST_BODY should state that the request_id is reusable")
	}
	if !*got.RequestIdReusable {
		t.Error("a body rejected at ingress creates no payment, so the id is still free")
	}

	// NO_SETTLER_FOR_CORRIDOR fails an existing payment, so the id is spent. This is
	// the pair that motivated the field: both are NOT_RETRYABLE_FIX_REQUEST.
	got = New(CodeNoSettlerForCorridor, "internal detail", "req-2", "PAYMENT_GATEWAY", nil).
		ToErrorResponse()
	if got.RequestIdReusable == nil {
		t.Fatal("NO_SETTLER_FOR_CORRIDOR should state that the request_id is spent")
	}
	if *got.RequestIdReusable {
		t.Error("NO_SETTLER_FOR_CORRIDOR fails an existing payment, so the id is spent")
	}
	if got.RetryClassification != NotRetryableFixRequest {
		t.Errorf("both entries should share NOT_RETRYABLE_FIX_REQUEST, got %q",
			got.RetryClassification)
	}
}

// An unrecognised code tells us nothing about the caller's id, so the fallback must
// not guess. Absent is the honest answer and reads as not reusable.
func TestFallbackDoesNotGuessReusability(t *testing.T) {
	got := New("NO_SUCH_CODE_EXISTS", "internal detail", "req-3", "PAYMENT_GATEWAY", nil).
		ToErrorResponse()
	if got.RequestIdReusable != nil {
		t.Errorf("the fallback must not assert reusability, got %v", *got.RequestIdReusable)
	}
}

// Absent must serialize as absent, not as false, so the two stay distinguishable on
// the wire for a caller that checks for the field's presence.
func TestReusabilityOmittedWhenUndetermined(t *testing.T) {
	b, err := json.Marshal(ErrorResponse{Code: "INTERNAL_ERROR", Message: "x"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(b, &raw); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, present := raw["request_id_reusable"]; present {
		t.Errorf("an undetermined value must be omitted entirely, got %s", b)
	}
}

// False must survive the round trip. A *bool is used precisely so that "spent" is
// not silently dropped by omitempty the way a plain false bool would be.
func TestReusableFalseSurvivesTheWire(t *testing.T) {
	spent := false
	b, err := json.Marshal(ErrorResponse{Code: "X", Message: "y", RequestIdReusable: &spent})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back ErrorResponse
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.RequestIdReusable == nil || *back.RequestIdReusable {
		t.Errorf("false must round-trip as false, got %s", b)
	}
}

// A consumer built before the field existed must still parse a response carrying it.
func TestOldConsumerIgnoresTheNewField(t *testing.T) {
	type oldShape struct {
		Code                string `json:"code"`
		Message             string `json:"message"`
		RetryClassification string `json:"retry_classification"`
	}
	reusable := true
	b, err := json.Marshal(ErrorResponse{
		Code: "MALFORMED_REQUEST_BODY", Message: "m",
		RetryClassification: NotRetryableFixRequest, RequestIdReusable: &reusable,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var old oldShape
	if err := json.Unmarshal(b, &old); err != nil {
		t.Fatalf("a pre-change consumer failed to parse: %v", err)
	}
	if old.Code != "MALFORMED_REQUEST_BODY" || old.RetryClassification != "NOT_RETRYABLE_FIX_REQUEST" {
		t.Errorf("the fields an old consumer reads changed: %+v", old)
	}
}
