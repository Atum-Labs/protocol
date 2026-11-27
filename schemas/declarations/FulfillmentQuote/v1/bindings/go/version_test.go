package fulfillmentquote

import (
	"encoding/json"
	"strings"
	"testing"

	generated "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go/generated"
)

// TestVersionConstantMatchesSchemaRegex is the lightweight Go-side
// mirror of `make -C schemas verify-version`. Running it in CI without
// the Makefile catches a producer-side bump that diverges from the
// schema regex before it reaches the deployed binary.
func TestVersionConstantMatchesSchemaRegex(t *testing.T) {
	// Schema enforces ^1\.[0-9]+$ — sanity-check the constant.
	if !strings.HasPrefix(Version, "1.") {
		t.Fatalf("Version %q must start with 1. (parent dir = v1)", Version)
	}
}

// TestUnmarshalRejectsMissingVersion confirms the generated
// UnmarshalJSON rejects payloads missing the `version` field.
// Important because producer-side mistakes (forgotten field) should
// fail closed at the receiver.
func TestUnmarshalRejectsMissingVersion(t *testing.T) {
	raw := `{
		"source_amount":"100",
		"award_deadline":"2030-01-01T00:00:00Z",
		"source":{"id":"x","account":"y"},
		"destination":{"id":"x","account":"y"},
		"settler_address":"0x1",
		"payment_request_json":"{}"
	}`
	var q generated.SchemaJson
	err := json.Unmarshal([]byte(raw), &q)
	if err == nil || !strings.Contains(err.Error(), "version") {
		t.Fatalf("expected version-required rejection, got %v", err)
	}
}

// TestUnmarshalRejectsLegacyExpiryKey pins the rename refactoring breaking
// contract: a quote carrying the old `expiry` key (and no
// `award_deadline`) MUST be rejected, not silently accepted with a
// zero-valued deadline. This guards against a future lenient or
// dual-read parser re-introducing silent acceptance of stale payloads —
// the whole safety of the rename rests on stale quotes failing closed.
func TestUnmarshalRejectsLegacyExpiryKey(t *testing.T) {
	raw := `{
		"version":"1.0",
		"source_amount":"100",
		"expiry":"2030-01-01T00:00:00Z",
		"source":{"id":"x","account":"y"},
		"destination":{"id":"x","account":"y"},
		"settler_address":"0x1",
		"payment_request_json":"{}"
	}`
	var q generated.SchemaJson
	err := json.Unmarshal([]byte(raw), &q)
	if err == nil || !strings.Contains(err.Error(), "award_deadline") {
		t.Fatalf("expected award_deadline-required rejection for legacy expiry key, got %v", err)
	}
}

// TestUnmarshalRejectsMalformedVersion confirms the generated regex
// validator rejects shapes outside MAJOR.MINOR. Covers the three
// classes of bad input most likely to leak in from a misbehaving
// producer: wrong major, wrong shape (3-part), non-numeric.
func TestUnmarshalRejectsMalformedVersion(t *testing.T) {
	bad := []string{
		"2.0",      // wrong major — directory-locked to 1
		"1",        // not MAJOR.MINOR
		"1.0.0",    // 3-part semver
		"v1.0",     // prefix
		"1.0-beta", // suffix
		"",         // empty
	}
	for _, v := range bad {
		raw := buildQuoteWithVersion(v)
		var q generated.SchemaJson
		err := json.Unmarshal([]byte(raw), &q)
		if err == nil {
			t.Errorf("version %q was accepted, want rejection", v)
		}
	}
}

// TestUnmarshalAcceptsCanonicalAndForwardMinor confirms the regex
// accepts the canonical value AND a forward-compatible higher minor.
// The intent is that consumers compiled today against 1.0 keep working
// when a producer bumps to 1.1 additively.
func TestUnmarshalAcceptsCanonicalAndForwardMinor(t *testing.T) {
	good := []string{"1.0", "1.1", "1.99"}
	for _, v := range good {
		raw := buildQuoteWithVersion(v)
		var q generated.SchemaJson
		if err := json.Unmarshal([]byte(raw), &q); err != nil {
			t.Errorf("version %q rejected: %v", v, err)
		}
	}
}

func buildQuoteWithVersion(version string) string {
	return `{
		"version":"` + version + `",
		"source_amount":"100",
		"award_deadline":"2030-01-01T00:00:00Z",
		"source":{"id":"x","account":"y"},
		"destination":{"id":"x","account":"y"},
		"settler_address":"0x1",
		"payment_request_json":"{}"
	}`
}
