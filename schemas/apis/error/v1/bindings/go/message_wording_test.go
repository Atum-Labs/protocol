package atumerror

// Internal, because it reads the parsed catalog directly. Both rules here are
// about what a public_message may say, which is not observable from outside the
// package once ToErrorResponse has substituted the text.

import (
	"regexp"
	"strings"
	"testing"
)

// The schema publishes maxLength 500 on `message` in both error/v1/schema.json
// and error/v1/openapi.yaml. A longer message validates locally and is rejected
// by a consumer validating against the published schema.
const maxPublicMessageLen = 500

func TestPublicMessagesFitTheSchemaLimit(t *testing.T) {
	check := func(name string, e catalogEntry) {
		if n := len(e.PublicMessage); n > maxPublicMessageLen {
			t.Errorf("%s: public_message is %d characters, over the published limit of %d", name, n, maxPublicMessageLen)
		}
	}
	for code, e := range catalog.Entries {
		check(code, e)
	}
	check("fallback", catalog.Fallback)
}

// Retry guidance belongs in retry_classification, not in the message. A message
// that also carries it is how the two disagree, which is what got a boolean
// `retryable` removed from this model: it said a settlement was safe to retry
// while its own message said to reconcile first.
//
// The exception is a code a caller can reach on the asynchronous payment-failure
// path. That path does now carry retry_classification and docs_url, so the message
// is no longer the only carrier there, but these messages still restate the answer
// and are listed below with the producer that puts them on that path. The list
// shrinks as each message is rewritten to drop the duplicated guidance.
var retryWording = regexp.MustCompile(`(?i)(\b(retry|retrying|retries|try again|reconcile|resubmit|re-submit|spent)\b|check the payment)`)

func TestOnlyAsyncReachableMessagesCarryRetryGuidance(t *testing.T) {
	asyncReachable := map[string]string{
		// Written to error_json by the settler's settlement-result mapping and
		// projected through PublicPaymentError onto the status endpoint.
		"TX_REVERTED":                  "settler settlement-result mapping",
		"BROADCAST_REJECTED":           "settler settlement-result mapping",
		"NONCE_TOO_LOW":                "settler code set, kept with its siblings' message",
		"FULFILLMENT_DEADLINE_EXPIRED": "settler gateway deadline closure",
		// payment-gw's deadline scheduler fails the payment asynchronously.
		"QUOTE_DEADLINE_EXPIRED": "payment-gw deadline scheduler",
		// The same call site as QUOTE_DEADLINE_EXPIRED, chosen instead of it when the
		// auction reached nobody, so it rides the same asynchronous path.
		"NO_SETTLER_FOR_CORRIDOR": "payment-gw deadline scheduler",
		"QUOTE_SELECTION_FAILED":  "payment-gw deadline scheduler",
		// Persisted as a finalized_reason by the settler report consumer and rendered
		// on the status and timeline endpoints.
		"SETTLER_REPORTED_ERROR": "settler report consumer",
		// The settler gateway reports these back after the payment row is committed.
		"SETTLER_GATEWAY_AT_CAPACITY":    "settler gateway worker capacity handler",
		"SETTLER_GATEWAY_INTERNAL_ERROR": "settler gateway failure notification",
		// Reached for any uncatalogued code, including on that same path.
		"<fallback>": "the fallback for an unrecognised code",
		// Synchronous, but the duplicate-payment risk is the one condition where
		// the message repeating the field is worth the duplication.
		"CONFLICT_DUPLICATE_INTENT":          "double-payment risk",
		"CONFLICT_DUPLICATE_INTENT_RECOVERY": "double-payment risk",
		// Explains the idempotency mechanic itself, which no field carries.
		"IDEMPOTENCY_TERMS_MISMATCH": "explains what request_id reuse does",
	}

	carries := func(name, msg string) {
		hit := retryWording.FindString(msg)
		_, allowed := asyncReachable[name]
		switch {
		case hit != "" && !allowed:
			t.Errorf("%s: public_message says %q. Retry guidance belongs in retry_classification unless the code is reachable on the asynchronous path, where no field arrives.\n   %s", name, hit, msg)
		case hit == "" && allowed:
			t.Errorf("%s: listed as needing its own retry guidance (%s) but the message carries none, so a caller on the asynchronous path is told nothing.\n   %s", name, asyncReachable[name], msg)
		}
	}
	for code, e := range catalog.Entries {
		carries(code, e.PublicMessage)
	}
	carries("<fallback>", catalog.Fallback.PublicMessage)

	for code := range asyncReachable {
		if code == "<fallback>" {
			continue
		}
		if _, ok := catalog.Entries[code]; !ok {
			t.Errorf("%s: listed as asynchronously reachable but no such entry, remove the stale entry", code)
		}
	}
}

// A code whose entries share one public_message must not have those entries
// disagree about the retry answer, or the one message is wrong for some of them.
// SERVICE_BUSY was exactly this: five entries shared "please retry shortly"
// while one of them needed a new request_id.
func TestEntriesSharingAMessageAgreeOnTheRetryAnswer(t *testing.T) {
	seen := map[string]struct {
		code  string
		class RetryClassification
	}{}
	for code, e := range catalog.Entries {
		prev, ok := seen[e.PublicMessage]
		if ok && prev.class != e.RetryClassification {
			t.Errorf("%s and %s share one public_message but are classified %q and %q, so the message cannot be right for both.\n   %s",
				prev.code, code, prev.class, e.RetryClassification, e.PublicMessage)
			continue
		}
		if !ok {
			seen[e.PublicMessage] = struct {
				code  string
				class RetryClassification
			}{code, e.RetryClassification}
		}
	}
}

// The catalog is the source for the public documentation page, which renders the
// message as a blockquote. A newline would break out of it.
func TestPublicMessagesAreSingleLine(t *testing.T) {
	check := func(name, msg string) {
		if strings.ContainsAny(msg, "\n\r") {
			t.Errorf("%s: public_message contains a line break", name)
		}
	}
	for code, e := range catalog.Entries {
		check(code, e.PublicMessage)
	}
	check("fallback", catalog.Fallback.PublicMessage)
}

// These internal codes also explain a quote request that reached no settler, where no
// payment exists, so their text must hold for both.
func TestQuoteRequestReachableMessagesDoNotNameAPayment(t *testing.T) {
	payment := regexp.MustCompile(`(?i)\bpayments?\b`)
	for _, code := range []string{"NO_SETTLER_FOR_CORRIDOR", "SETTLER_GATEWAY_AT_CAPACITY"} {
		e, ok := catalog.Entries[code]
		if !ok {
			t.Errorf("%s: no such catalog entry", code)
			continue
		}
		if hit := payment.FindString(e.PublicMessage); hit != "" {
			t.Errorf("%s: public_message says %q, which is wrong on a quote request.\n   %s", code, hit, e.PublicMessage)
		}
	}
}
