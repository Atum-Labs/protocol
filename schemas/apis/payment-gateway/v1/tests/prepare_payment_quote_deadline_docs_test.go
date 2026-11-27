package paymentgateway

import (
	"strings"
	"testing"
)

// quote_deadline_seconds is the SDK's default quote window and is short. A settler that has
// to source the payout before it can bid declines a window that short, so a reader of the
// default needs the decline code that signals it and the fix: a longer window.
func TestPreparePaymentQuoteDeadlineSecondsDocumentsTooShortDecline(t *testing.T) {
	const schema, property = "PreparePaymentRequest", "quote_deadline_seconds"
	found := openapiPropertyDescriptions(t, map[string]bool{schema: true}, property)
	desc, ok := found[schema]
	if !ok {
		t.Fatalf("found no %s property on openapi %s", property, schema)
	}
	if desc == "" {
		t.Fatalf("openapi %s.%s has an empty description", schema, property)
	}
	text := strings.Join(strings.Fields(desc), " ")

	sentences := splitSentences(text)
	named := false
	for i, sentence := range sentences {
		if !strings.Contains(sentence, "QUOTE_WINDOW_TOO_SHORT") {
			continue
		}
		named = true
		// The fix has to sit next to the code; "longer" elsewhere in the description could
		// be about some other field or bound.
		near := strings.ToLower(sentence)
		if i > 0 {
			near = strings.ToLower(sentences[i-1]) + " " + near
		}
		if !strings.Contains(near, "longer") {
			t.Errorf("sentence naming QUOTE_WINDOW_TOO_SHORT, and the one before it, do not say to pass a longer window: %q", sentence)
		}
		// "longer" can describe the cause ("may need longer than the default") rather than
		// the fix; the caller must be told to reissue with a larger value, in the decline's
		// own sentence or the one that follows it.
		after := strings.ToLower(sentence)
		if i+1 < len(sentences) {
			after += " " + strings.ToLower(sentences[i+1])
		}
		if !strings.Contains(after, "reissue") || !strings.Contains(after, "larger value") {
			t.Errorf("sentence naming QUOTE_WINDOW_TOO_SHORT, and the one after it, do not tell the caller to reissue with a larger value: %q", sentence)
		}
	}
	if !named {
		t.Errorf("openapi %s.%s description does not name QUOTE_WINDOW_TOO_SHORT: %q", schema, property, text)
	}
}
