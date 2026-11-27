package atumerror_test

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"

	atumerror "github.com/atum-labs/protocol/schemas/apis/error/v1/bindings/go"
)

// The values the field may carry. Kept here as a literal rather than
// derived from the constants, so a value added to the binding without being
// added to the published schema fails this test.
var wantValues = []string{
	"RETRY_AFTER_DELAY",
	"RECONCILE_THEN_DECIDE",
	"RETRY_WITH_NEW_IDENTIFIER",
	"POLL_FOR_COMPLETION",
	"NOT_RETRYABLE_FIX_REQUEST",
	"ALREADY_DONE",
	"CONTACT_SUPPORT",
}

// The published enum and the Go constants must agree. A value in one and not the
// other means a caller branching on a constant would miss a value the server can
// send, or a documented value no binding exposes.
func TestRetryClassification_SchemaAndConstantsAgree(t *testing.T) {
	spec, err := os.ReadFile("../../openapi.yaml")
	if err != nil {
		t.Fatalf("read openapi.yaml: %v", err)
	}
	// Anchor to the PUBLIC ErrorResponse component first. An unanchored search
	// matches the field wherever it appears, so the enum could sit on the internal
	// AtumError while ErrorResponse carried nothing and this would still pass.
	comp := regexp.MustCompile(`(?s)\n    ErrorResponse:\n(.*?)(?:\n    [A-Za-z]|\z)`).FindSubmatch(spec)
	if comp == nil {
		t.Fatal("no ErrorResponse component in openapi.yaml")
	}
	// Then the enum inside that component, terminated by any line indented less
	// than the list items so the match cannot run into the next property.
	m := regexp.MustCompile(`(?s)\n        retry_classification:\n(.*?)(?:\n        [a-z]|\z)`).FindSubmatch(comp[1])
	if m == nil {
		t.Fatal("ErrorResponse has no retry_classification property")
	}
	enum := regexp.MustCompile(`(?s)\n          enum:\n(.*?)(?:\n          [a-z]|\z)`).FindSubmatch(m[1])
	if enum == nil {
		t.Fatal("ErrorResponse.retry_classification has no enum (block style expected)")
	}
	inSpec := map[string]bool{}
	for _, line := range strings.Split(string(enum[1]), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "- ") {
			continue
		}
		inSpec[strings.TrimSpace(strings.TrimPrefix(line, "- "))] = true
	}

	// Compared as sets: enum order carries no meaning, so a reorder must not fail.
	if len(inSpec) != len(wantValues) {
		t.Fatalf("ErrorResponse enum lists %d values, want %d: %v", len(inSpec), len(wantValues), inSpec)
	}
	for _, v := range wantValues {
		if !inSpec[v] {
			t.Errorf("ErrorResponse enum is missing %q", v)
		}
	}

	constants := []atumerror.RetryClassification{
		atumerror.RetryAfterDelay,
		atumerror.ReconcileThenDecide,
		atumerror.RetryWithNewIdentifier,
		atumerror.PollForCompletion,
		atumerror.NotRetryableFixRequest,
		atumerror.AlreadyDone,
		atumerror.ContactSupport,
	}
	if len(constants) != len(wantValues) {
		t.Fatalf("binding exposes %d constants, want %d", len(constants), len(wantValues))
	}
	for i, want := range wantValues {
		if string(constants[i]) != want {
			t.Errorf("constant %d = %q, want %q", i, constants[i], want)
		}
	}
}

// A consumer compiled before the field existed models ErrorResponse without it.
// Adding the field must not stop such a consumer parsing a response.
func TestRetryClassification_OldConsumerStillParses(t *testing.T) {
	// The pre-change shape, verbatim.
	type oldErrorResponse struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestId string `json:"request_id,omitempty"`
		PaymentId string `json:"payment_id,omitempty"`
		DocsUrl   string `json:"docs_url,omitempty"`
		Domain    string `json:"domain,omitempty"`
	}

	body := []byte(`{"code":"SETTLEMENT_FAILED","message":"m","request_id":"req_1",` +
		`"docs_url":"https://docs.atum.xyz/errors#settlement-failed","domain":"SETTLER_AGENT",` +
		`"retry_classification":"RECONCILE_THEN_DECIDE"}`)

	var old oldErrorResponse
	if err := json.Unmarshal(body, &old); err != nil {
		t.Fatalf("a consumer built before the field failed to parse: %v", err)
	}
	if old.Code != "SETTLEMENT_FAILED" || old.RequestId != "req_1" {
		t.Fatalf("old consumer lost a field it does model: %+v", old)
	}
}

// The set is closed, but a caller must not reject a value it does not know: that
// turns a newer server into an outage. CORE-2039 is the precedent, where a
// generated client rejected an unknown enum value and the settler burned its
// retry budget on it.
func TestRetryClassification_UnknownValueIsTolerated(t *testing.T) {
	body := []byte(`{"code":"SETTLEMENT_FAILED","message":"m","retry_classification":"RETRY_ON_TUESDAY"}`)

	var got atumerror.ErrorResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unknown value rejected the whole response: %v", err)
	}
	if got.RetryClassification != "RETRY_ON_TUESDAY" {
		t.Fatalf("retry classification = %q, want it carried through verbatim", got.RetryClassification)
	}
	// And the rest of the body still parses, which is the point.
	if got.Code != "SETTLEMENT_FAILED" {
		t.Fatalf("code = %q, want SETTLEMENT_FAILED", got.Code)
	}
}

// An unclassified response must omit the key, not send an empty string: "" on
// the wire would read as a real value meaning "no retry". Every catalog entry is
// classified, so the fallback an unknown code lands on is the only way to get here.
func TestRetryClassification_OmittedWhileUnclassified(t *testing.T) {
	internal := atumerror.New("NO_SUCH_CODE_IN_THE_CATALOG", "internal", "req_1", atumerror.SchemaJsonDomainCOUNTERPARTYGATEWAY, nil)

	pub := internal.ToErrorResponse()
	if pub.RetryClassification != "" {
		t.Fatalf("retry classification = %q, want empty for a deliberately unclassified entry", pub.RetryClassification)
	}

	body, err := json.Marshal(pub)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(body), "retry_classification") {
		t.Fatalf("unclassified response should omit the key entirely, got %s", body)
	}
}

// The field is derived in ToErrorResponse, the one place every service funnels
// through, so a service emits it without changing any of its own code.
func TestRetryClassification_DerivedFromTheCatalog(t *testing.T) {
	// Stand in for a classified catalog entry by round-tripping the wire shape,
	// which is what a service would serialize.
	body := []byte(`{"code":"SETTLEMENT_FAILED","message":"m","retry_classification":"RECONCILE_THEN_DECIDE"}`)

	var got atumerror.ErrorResponse
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.RetryClassification != atumerror.ReconcileThenDecide {
		t.Fatalf("retry classification = %q, want %q", got.RetryClassification, atumerror.ReconcileThenDecide)
	}
	// A caller branches on the constant, not on a string literal.
	switch got.RetryClassification {
	case atumerror.ReconcileThenDecide:
	default:
		t.Fatalf("could not branch on the exported constant")
	}
}
