package atumerror

import (
	"regexp"
	"strings"
	"testing"
)

// A payment refused for a dollar limit used to arrive as AUTHORIZATION_DECLINED, the
// same answer as a sanctions hit, so every limit refusal became a support ticket. Each
// limit now has its own code. The two limits need different retry answers, and one
// entry carries one, so they are two codes: a per-payment cap needs a higher limit,
// while a daily total clears at 00:00 UTC.
//
// Keyed by string rather than by the generated constants, so removing an entry fails
// here instead of failing to compile.
func TestLimitRefusalsHaveTheirOwnCodes(t *testing.T) {
	declined, ok := catalog.Entries["AUTHORIZATION_DECLINED"]
	if !ok {
		t.Fatal("AUTHORIZATION_DECLINED: no catalog entry")
	}
	cases := []struct {
		key   string
		class RetryClassification
		names string // the kind of limit the message must name
	}{
		{"AMOUNT_LIMIT_EXCEEDED", ContactSupport, "per-payment"},
		{"VOLUME_LIMIT_EXCEEDED", RetryAfterDelay, "daily"},
	}
	for _, tc := range cases {
		e, ok := catalog.Entries[tc.key]
		if !ok {
			t.Errorf("%s: no catalog entry, so the refusal falls back to INTERNAL_ERROR/500", tc.key)
			continue
		}
		if e.PublicCode != tc.key {
			t.Errorf("%s: public_code %q, want %q", tc.key, e.PublicCode, tc.key)
		}
		if e.PublicCode == declined.PublicCode {
			t.Errorf("%s: shares AUTHORIZATION_DECLINED's public code, so a caller still cannot tell a limit from a compliance decline", tc.key)
		}
		// The status a limit refusal had as AUTHORIZATION_DECLINED. Moving it would change
		// what every client that branches on the status does, and a 429 would invite an
		// immediate retry the limit will refuse again.
		if e.HTTPStatus != declined.HTTPStatus {
			t.Errorf("%s: HTTP %d, want %d, the status this refusal already had", tc.key, e.HTTPStatus, declined.HTTPStatus)
		}
		if e.RetryClassification != tc.class {
			t.Errorf("%s: retry_classification %q, want %q", tc.key, e.RetryClassification, tc.class)
		}
		// Left absent, as on AUTHORIZATION_DECLINED. The payment adapter for MPP turns a
		// RETRY_AFTER_DELAY answer that claims a reusable id into "re-attempt in a moment",
		// and its fetch then re-attempts at once, which a daily total refuses until 00:00 UTC.
		if e.RequestIdReusable != nil {
			t.Errorf("%s: request_id_reusable is %v, want it absent as on AUTHORIZATION_DECLINED", tc.key, *e.RequestIdReusable)
		}
		if !strings.Contains(e.PublicMessage, tc.names) {
			t.Errorf("%s: public_message does not name the %s limit: %q", tc.key, tc.names, e.PublicMessage)
		}
		assertNamesNoAmount(t, tc.key, e.PublicMessage)
	}

	if v, ok := catalog.Entries["VOLUME_LIMIT_EXCEEDED"]; ok && !strings.Contains(v.PublicMessage, "00:00 UTC") {
		t.Errorf("VOLUME_LIMIT_EXCEEDED: public_message does not say when the daily total resets: %q", v.PublicMessage)
	}
}

// Every decline that is not a limit stays as opaque as it was: a sanctions or screening
// decline must not start explaining itself because the limits now do.
func TestAuthorizationDeclinedStaysOpaque(t *testing.T) {
	e, ok := catalog.Entries["AUTHORIZATION_DECLINED"]
	if !ok {
		t.Fatal("AUTHORIZATION_DECLINED: no catalog entry")
	}
	if e.PublicCode != "AUTHORIZATION_DECLINED" || e.HTTPStatus != 403 || e.RetryClassification != ContactSupport {
		t.Errorf("AUTHORIZATION_DECLINED is %s %d %s, want AUTHORIZATION_DECLINED 403 %s",
			e.PublicCode, e.HTTPStatus, e.RetryClassification, ContactSupport)
	}
	if !strings.Contains(e.PublicMessage, "The reason is not included in this response.") {
		t.Errorf("AUTHORIZATION_DECLINED: public_message no longer says the reason is withheld: %q", e.PublicMessage)
	}
	if strings.Contains(strings.ToLower(e.PublicMessage), "limit") {
		t.Errorf("AUTHORIZATION_DECLINED: public_message names a limit, which it must not: %q", e.PublicMessage)
	}
}

// amountLike is a number written into a message: a dollar figure, a count, a percentage.
// The reset time and the support channel's link are the only numbers a limit message
// carries, and both are removed first.
var amountLike = regexp.MustCompile(`[0-9$%]`)

// supportChannelURL is where a limit message sends a caller who needs a higher
// limit.
const supportChannelURL = "https://discord.com/channels/1546918135892803724/1546951586348277841"

// assertNamesNoAmount fails a message that states the limit's amount, what is left of it,
// or which tier the caller is on.
func assertNamesNoAmount(t *testing.T, key, msg string) {
	t.Helper()
	// The reset time and the support channel's link are the only digits a limit
	// message may carry. Only that exact link is exempt, so an amount hidden in any
	// other URL still fails.
	rest := strings.ReplaceAll(msg, "00:00 UTC", "")
	rest = strings.ReplaceAll(rest, supportChannelURL, "")
	if m := amountLike.FindString(rest); m != "" {
		t.Errorf("%s: public_message carries %q, and a limit message never states an amount: %q", key, m, msg)
	}
	lower := strings.ToLower(msg)
	for _, banned := range []string{"usd", "dollar", "remaining", "headroom", "tier", "authenticated", "listed"} {
		if strings.Contains(lower, banned) {
			t.Errorf("%s: public_message says %q, which describes the cap or the caller's standing: %q", key, banned, msg)
		}
	}
}
