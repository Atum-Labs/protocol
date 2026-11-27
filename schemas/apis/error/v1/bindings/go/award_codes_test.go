package atumerror

import (
	"strings"
	"testing"
)

// The award refuses a request with these codes, and the payment gateway spec names them. A
// refusal that leaves the request_id free must say so, and a check the award shares with
// POST /v1/payments answers what that endpoint answers.
func TestCatalog_AwardCodes(t *testing.T) {
	want := map[Code]struct {
		publicCode string
		status     int
	}{
		CodeQuoteRequestNotFound:       {"QUOTE_REQUEST_NOT_FOUND", 404},
		CodeQuoteNotFound:              {"QUOTE_NOT_FOUND", 404},
		CodeQuoteRequestAlreadyAwarded: {"QUOTE_REQUEST_ALREADY_AWARDED", 409},
		CodeAwardQuoteExpired:          {"QUOTES_EXPIRED", 422},
		CodeAwardSenderAuthNotAllowed:  {"SENDER_AUTH_NOT_ALLOWED", 400},
		CodeMissingReserveAuth:         {"MISSING_RESERVE_AUTH", 400},
		CodeReserveAuthNotAllowed:      {"RESERVE_AUTH_NOT_ALLOWED", 400},
		CodeReserveAuthInvalid:         {"RESERVE_AUTH_INVALID", 400},
		CodeAwardSignerMismatch:        {"AWARD_SIGNER_MISMATCH", 401},
		CodeReserverMismatch:           {"RESERVER_MISMATCH", 400},
		CodePermitAmountMismatch:       {"PERMIT_AMOUNT_MISMATCH", 400},
		CodePermitTokenMismatch:        {"PERMIT_TOKEN_MISMATCH", 400},
		CodeQuoteSelectorNotAllowed:    {"QUOTE_SELECTOR_NOT_ALLOWED", 400},
		CodeAwardPresentationInvalid:   {"UNAUTHENTICATED", 401},
		CodeAwardPresentationRequired:  {"UNAUTHENTICATED", 401},
	}
	for code, w := range want {
		e, ok := catalog.Entries[string(code)]
		if !ok {
			t.Errorf("%s: no catalog entry", code)
			continue
		}
		if e.PublicCode != w.publicCode || e.HTTPStatus != w.status {
			t.Errorf("%s: got %s %d, want %s %d", code, e.PublicCode, e.HTTPStatus, w.publicCode, w.status)
		}
		if e.RetryClassification != NotRetryableFixRequest {
			t.Errorf("%s: retry_classification %q, want %q", code, e.RetryClassification, NotRetryableFixRequest)
		}
		// A refused award writes nothing, so the award's request_id is still free.
		if e.RequestIdReusable == nil || !*e.RequestIdReusable {
			t.Errorf("%s: a refused award creates no payment, so request_id_reusable must be true", code)
		}
	}
}

// A reused award request_id names the award's own fields, and answers what POST /v1/payments
// answers for a reused request_id.
func TestCatalog_AwardIdempotencyTermsMismatch(t *testing.T) {
	award, ok := catalog.Entries[string(CodeAwardIdempotencyTermsMismatch)]
	if !ok {
		t.Fatalf("%s: no catalog entry", CodeAwardIdempotencyTermsMismatch)
	}
	payments := catalog.Entries[string(CodeIdempotencyTermsMismatch)]
	if award.PublicCode != payments.PublicCode || award.HTTPStatus != payments.HTTPStatus ||
		award.RetryClassification != RetryWithNewIdentifier || award.RequestIdReusable == nil || *award.RequestIdReusable {
		t.Errorf("got %s %d %s, want %s %d %s and request_id_reusable false", award.PublicCode, award.HTTPStatus,
			award.RetryClassification, payments.PublicCode, payments.HTTPStatus, RetryWithNewIdentifier)
	}
	for _, field := range []string{"quote_request_id", "quote_id"} {
		if !strings.Contains(award.PublicMessage, field) {
			t.Errorf("public_message does not name %s: %q", field, award.PublicMessage)
		}
	}
}
