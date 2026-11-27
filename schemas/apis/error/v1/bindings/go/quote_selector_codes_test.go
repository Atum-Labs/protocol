package atumerror

import (
	"strings"
	"testing"
)

// A quote request must name the account that signs the award's reserve, so neither refusal may
// point the caller at leaving quote_selector out.
func TestCatalog_QuoteSelectorCodes(t *testing.T) {
	want := map[Code]string{
		CodeMissingQuoteSelector:    "MISSING_QUOTE_SELECTOR",
		CodeQuoteSelectorNotAllowed: "QUOTE_SELECTOR_NOT_ALLOWED",
	}
	for code, publicCode := range want {
		e, ok := catalog.Entries[string(code)]
		if !ok {
			t.Errorf("%s: no catalog entry", code)
			continue
		}
		if e.PublicCode != publicCode || e.HTTPStatus != 400 {
			t.Errorf("%s: got %s %d, want %s 400", code, e.PublicCode, e.HTTPStatus, publicCode)
		}
		if e.RetryClassification != NotRetryableFixRequest {
			t.Errorf("%s: retry_classification %q, want %q", code, e.RetryClassification, NotRetryableFixRequest)
		}
		if e.RequestIdReusable == nil || !*e.RequestIdReusable {
			t.Errorf("%s: a refused quote request stores nothing, so request_id_reusable must be true", code)
		}
		msg := strings.ToLower(e.PublicMessage)
		if strings.Contains(msg, "omit") {
			t.Errorf("%s: message %q tells the caller to omit quote_selector", code, e.PublicMessage)
		}
		if !strings.Contains(msg, "source.account") {
			t.Errorf("%s: message %q does not name source.account as the usual selector", code, e.PublicMessage)
		}
	}
}

func TestCatalog_ReserverMismatchNamesNoFallback(t *testing.T) {
	e := catalog.Entries[string(CodeReserverMismatch)]
	if strings.Contains(strings.ToLower(e.PublicMessage), "source account") {
		t.Errorf("message %q still describes a source account fallback", e.PublicMessage)
	}
}
