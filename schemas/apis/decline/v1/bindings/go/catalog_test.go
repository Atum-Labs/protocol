package atumdecline

import (
	"regexp"
	"strings"
	"testing"
)

// publicCodePattern is the pattern the OpenAPI DeclineReason publishes.
var publicCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

// TestCatalogIntegrity fails on a broken catalog entry (bad public_code, empty
// message) that would otherwise only surface to an integrator.
func TestCatalogIntegrity(t *testing.T) {
	check := func(name string, e catalogEntry) {
		if !publicCodePattern.MatchString(e.PublicCode) {
			t.Errorf("%s: public_code %q does not match the published pattern %s", name, e.PublicCode, publicCodePattern)
		}
		if e.PublicMessage == "" {
			t.Errorf("%s: empty public_message", name)
		}
	}

	check("fallback", catalog.Fallback)
	if len(catalog.Entries) == 0 {
		t.Fatal("catalog has no entries")
	}
	for code, e := range catalog.Entries {
		if !publicCodePattern.MatchString(code) {
			t.Errorf("%s: internal reason code does not match the published pattern %s", code, publicCodePattern)
		}
		check(code, e)
	}
}

// TestUnknownReasonProjectsToFallback pins the property the whole design rests on: a
// settler running a newer catalog than this consumer is counted, not dropped and not an
// error. Without it a decline summary silently stops summing to the number of settlers
// that declined.
func TestUnknownReasonProjectsToFallback(t *testing.T) {
	got := ReasonFor("A_REASON_FROM_THE_FUTURE")
	if got.Code != catalog.Fallback.PublicCode {
		t.Errorf("unknown reason projected to %q, want the fallback %q", got.Code, catalog.Fallback.PublicCode)
	}
	if got.Message == "" {
		t.Error("unknown reason projected to an empty message")
	}
	if Known("A_REASON_FROM_THE_FUTURE") {
		t.Error("Known reported true for a reason absent from the catalog")
	}
}

// TestFallbackIsNeverAMappingTarget keeps OTHER meaning "we do not recognise this" for
// codes we genuinely do not know, while still letting a catalogued reason be bucketed
// there deliberately. Known is what separates the two, so it has to stay true for every
// entry that maps to the fallback code.
func TestFallbackIsNeverAMappingTarget(t *testing.T) {
	for code, e := range catalog.Entries {
		if e.PublicCode != catalog.Fallback.PublicCode {
			continue
		}
		if !Known(code) {
			t.Errorf("%s buckets to %s but Known reports false, so it is indistinguishable from an unknown reason", code, e.PublicCode)
		}
	}
}

// TestGeneratedConstantsCoverTheCatalog fails if codes.go drifts from catalog.json.
// The Makefile drift guard catches an uncommitted regeneration, this catches a hand
// edit that removed a constant the catalog still names.
func TestGeneratedConstantsCoverTheCatalog(t *testing.T) {
	generated := map[string]bool{}
	for _, c := range AllReasonCodes {
		generated[string(c)] = true
	}
	for code := range catalog.Entries {
		if !generated[code] {
			t.Errorf("catalog names %s but codes.go has no constant for it", code)
		}
	}
	if len(generated) != len(catalog.Entries) {
		t.Errorf("codes.go declares %d constants, catalog has %d entries", len(generated), len(catalog.Entries))
	}
}

// Every reason, and the fallback, must say what would change the answer. A blank
// one reaches a caller as an empty string, which reads as a real value meaning
// "no retry" rather than "we did not say". The values are the error catalog's
// closed set, so a caller reads one vocabulary across both catalogs.
func TestEveryReasonCarriesAKnownClassification(t *testing.T) {
	known := map[string]bool{
		"ALREADY_DONE": true, "CONTACT_SUPPORT": true, "NOT_RETRYABLE_FIX_REQUEST": true,
		"POLL_FOR_COMPLETION": true, "RECONCILE_THEN_DECIDE": true,
		"RETRY_AFTER_DELAY": true, "RETRY_WITH_NEW_IDENTIFIER": true,
	}
	check := func(name string, e catalogEntry) {
		switch {
		case e.RetryClassification == "":
			t.Errorf("%s: no retry_classification", name)
		case !known[e.RetryClassification]:
			t.Errorf("%s: retry_classification %q is not in the error catalog's set", name, e.RetryClassification)
		}
	}
	for code, e := range catalog.Entries {
		check(code, e)
	}
	check("fallback", catalog.Fallback)
}

// A decline is a settler saying no before it settled anything, so nothing of this
// payment landed with it. RECONCILE_THEN_DECIDE and ALREADY_DONE both assert the
// opposite and would send a caller looking for a payment that was never made.
func TestNoReasonClaimsWorkMayHaveLanded(t *testing.T) {
	for code, e := range catalog.Entries {
		if e.RetryClassification == "RECONCILE_THEN_DECIDE" || e.RetryClassification == "ALREADY_DONE" {
			t.Errorf("%s: classified %q, but a decline means this settler did no work", code, e.RetryClassification)
		}
	}
}

// A decline summary folds by public code, so two internal reasons that collapse onto
// one public code must agree on the answer. They do not have to share a message, so
// nothing else in here would catch a disagreement, and the folded entry would carry
// whichever answer the map iteration reached last.
func TestPublicCodesAgreeOnTheAnswer(t *testing.T) {
	seen := map[string]struct {
		code   string
		answer string
	}{}
	for code, e := range catalog.Entries {
		prev, ok := seen[e.PublicCode]
		if ok && prev.answer != e.RetryClassification {
			t.Errorf("%s and %s both project onto %s but are classified %q and %q, so a folded summary entry has no one answer",
				prev.code, code, e.PublicCode, prev.answer, e.RetryClassification)
			continue
		}
		if !ok {
			seen[e.PublicCode] = struct {
				code   string
				answer string
			}{code, e.RetryClassification}
		}
	}
	// The fallback projects onto a public code too, and an uncatalogued reason lands
	// on it, so it must not disagree with the entries sharing that code either.
	if prev, ok := seen[catalog.Fallback.PublicCode]; ok && prev.answer != catalog.Fallback.RetryClassification {
		t.Errorf("the fallback projects onto %s, which %s classifies %q, but the fallback says %q",
			catalog.Fallback.PublicCode, prev.code, prev.answer, catalog.Fallback.RetryClassification)
	}
}

// A docs link that resolves nowhere is worse than none: it invites a reader to follow
// it and leaves them on a 404 with no sign anything is wrong. The base ends in '#' so
// every url is a fragment on one page, and every reason must carry a slug to anchor.
func TestEveryReasonResolvesToAnAnchorOnOnePage(t *testing.T) {
	if !strings.HasSuffix(catalog.DocsBaseURL, "#") {
		t.Fatalf("docs_base_url = %q, want it to end in '#' so a slug is a fragment", catalog.DocsBaseURL)
	}

	slugPattern := regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	check := func(name string, e catalogEntry) {
		if !slugPattern.MatchString(e.DocsSlug) {
			t.Errorf("%s: docs_slug %q is not a usable html id", name, e.DocsSlug)
		}
	}
	for code, e := range catalog.Entries {
		check(code, e)
	}
	check("fallback", catalog.Fallback)
}

// The summary folds by public code, so the link has to belong to the public code and
// not the internal one. Two internal reasons sharing a public code that disagreed on
// the slug would give one of them the other's page.
func TestOneSlugPerPublicCode(t *testing.T) {
	seen := map[string]string{}
	for code, e := range catalog.Entries {
		if prev, ok := seen[e.PublicCode]; ok && prev != e.DocsSlug {
			t.Errorf("%s projects onto %s with slug %q, but another reason gives it %q",
				code, e.PublicCode, e.DocsSlug, prev)
		}
		seen[e.PublicCode] = e.DocsSlug
	}
	if prev, ok := seen[catalog.Fallback.PublicCode]; ok && prev != catalog.Fallback.DocsSlug {
		t.Errorf("the fallback projects onto %s with slug %q, but an entry gives it %q",
			catalog.Fallback.PublicCode, catalog.Fallback.DocsSlug, prev)
	}
}

// A quote_deadline too close to produce a quote in is the caller's to fix, the mirror
// of one too far out. It needs its own public code so a decline summary can tell the
// caller which way to move the deadline; folded into OTHER it says nothing actionable.
func TestQuoteWindowTooShortProjectsToItsOwnFixableReason(t *testing.T) {
	const code = "QUOTE_WINDOW_TOO_SHORT"
	if !Known(code) {
		t.Errorf("Known(%q) = false, want it catalogued", code)
	}
	got := ReasonFor(code)
	if got.Code != code {
		t.Errorf("Code = %q, want its own public code %q", got.Code, code)
	}
	if got.Code == catalog.Fallback.PublicCode {
		t.Errorf("Code = %q, the fallback, so a caller cannot tell which way to move the deadline", got.Code)
	}
	if got.RetryClassification != "NOT_RETRYABLE_FIX_REQUEST" {
		t.Errorf("RetryClassification = %q, want NOT_RETRYABLE_FIX_REQUEST", got.RetryClassification)
	}
	// The fix is a longer quote_deadline, so the message has to name the field to change.
	if !strings.Contains(got.Message, "quote_deadline") {
		t.Errorf("Message = %q, want it to name quote_deadline", got.Message)
	}
	// Naming the field is not enough: the direction is the fix, and the opposite
	// direction would send the caller further from an acceptable deadline.
	if !strings.Contains(got.Message, "longer quote_deadline") {
		t.Errorf("Message = %q, want it to ask for a longer quote_deadline", got.Message)
	}
	// The two window reasons ask for opposite fixes, so sharing one message would
	// tell one of them to move the deadline the wrong way.
	if tooLong := ReasonFor("QUOTE_WINDOW_TOO_LONG"); got.Message == tooLong.Message {
		t.Errorf("Message = %q, identical to QUOTE_WINDOW_TOO_LONG's, want a distinct message", got.Message)
	}
	if got.DocsUrl == "" || !strings.HasSuffix(got.DocsUrl, "#quote-window-too-short") {
		t.Errorf("DocsUrl = %q, want a link ending in #quote-window-too-short", got.DocsUrl)
	}
}

func TestAwardWindowTooShortNamesTheHoldAndAsksForALaterFulfillmentDeadline(t *testing.T) {
	const code = "AWARD_WINDOW_TOO_SHORT"
	if !Known(code) {
		t.Errorf("Known(%q) = false, want it catalogued", code)
	}
	got := ReasonFor(code)
	if got.Code != code {
		t.Errorf("Code = %q, want its own public code %q", got.Code, code)
	}
	if got.Code == catalog.Fallback.PublicCode {
		t.Errorf("Code = %q, the fallback, so a caller cannot tell which field to move", got.Code)
	}
	if got.RetryClassification != "NOT_RETRYABLE_FIX_REQUEST" {
		t.Errorf("RetryClassification = %q, want NOT_RETRYABLE_FIX_REQUEST", got.RetryClassification)
	}
	// The window that ran out is the settler's own price hold, so the message names it.
	if !strings.Contains(got.Message, "award_deadline") {
		t.Errorf("Message = %q, want it to name award_deadline", got.Message)
	}
	// No request field is called award_deadline, so the message has to say whose it is and
	// what it holds, or a caller goes looking for a field of their own to change.
	if !strings.Contains(got.Message, "settler's award_deadline") {
		t.Errorf("Message = %q, want it to call award_deadline the settler's", got.Message)
	}
	if !strings.Contains(strings.ToLower(got.Message), "price") {
		t.Errorf("Message = %q, want it to say award_deadline is how long the settler holds its price", got.Message)
	}
	// award_deadline is the settler's, not the caller's: the field the caller can move
	// is fulfillment_deadline, and only a later one widens the window.
	if !strings.Contains(got.Message, "fulfillment_deadline") {
		t.Errorf("Message = %q, want it to name fulfillment_deadline", got.Message)
	}
	if !strings.Contains(got.Message, "later fulfillment_deadline") {
		t.Errorf("Message = %q, want it to ask for a later fulfillment_deadline", got.Message)
	}
	// Moving quote_deadline does not widen this window, so naming it sends the caller
	// to the wrong field.
	if strings.Contains(got.Message, "quote_deadline") {
		t.Errorf("Message = %q, want no mention of quote_deadline", got.Message)
	}
	// DEADLINE_TOO_SHORT is a different cause (the fulfillment window itself is below
	// the settler's minimum), so the two cannot share a message.
	if tooShort := ReasonFor("DEADLINE_TOO_SHORT"); got.Message == tooShort.Message {
		t.Errorf("Message = %q, identical to DEADLINE_TOO_SHORT's, want a distinct message", got.Message)
	}
	if got.DocsUrl == "" || !strings.HasSuffix(got.DocsUrl, "#award-window-too-short") {
		t.Errorf("DocsUrl = %q, want a link ending in #award-window-too-short", got.DocsUrl)
	}
}

// Each token transfer restriction gets its own public code with the retry advice its fix needs: a
// paused asset clears when the issuer resumes, a restricted destination needs a changed request.
func TestTokenRestrictionReasonsProjectToTheirOwnCodes(t *testing.T) {
	for _, tc := range []struct{ code, retry, slug, advice string }{
		{"ASSET_PAUSED", "RETRY_AFTER_DELAY", "#asset-paused", "once the issuer resumes"},
		{"DESTINATION_ACCOUNT_RESTRICTED", "NOT_RETRYABLE_FIX_REQUEST", "#destination-account-restricted", "destination account that can receive"},
	} {
		got := ReasonFor(tc.code)
		if got.Code != tc.code {
			t.Errorf("%s: Code = %q, want its own public code", tc.code, got.Code)
		}
		if got.RetryClassification != tc.retry {
			t.Errorf("%s: RetryClassification = %q, want %s", tc.code, got.RetryClassification, tc.retry)
		}
		if !strings.HasSuffix(got.DocsUrl, tc.slug) {
			t.Errorf("%s: DocsUrl = %q, want a link ending in %s", tc.code, got.DocsUrl, tc.slug)
		}
		// The payer only sees this message, so it says what to do next.
		if !strings.Contains(got.Message, tc.advice) {
			t.Errorf("%s: Message = %q, want it to advise %q", tc.code, got.Message, tc.advice)
		}
	}
}
