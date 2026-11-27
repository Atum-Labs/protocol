package atumerror

// Internal, because it swaps the parsed catalog to stand in for a classified
// entry. No entry carries a classification yet (that is CORE-2223), so an
// external test cannot exercise the derivation at all, which is how a suite ends
// up green with the passthrough deleted.

import (
	"encoding/json"
	"strings"
	"testing"
)

// withClassified swaps one catalog entry for a classified copy and restores the
// catalog afterwards.
func withClassified(t *testing.T, code string, rc RetryClassification) {
	t.Helper()
	orig := catalog
	entries := make(map[string]catalogEntry, len(orig.Entries))
	for k, v := range orig.Entries {
		entries[k] = v
	}
	e, ok := entries[code]
	if !ok {
		t.Fatalf("catalog has no entry %q to classify", code)
	}
	e.RetryClassification = rc
	entries[code] = e
	catalog = errorCatalog{DocsBaseURL: orig.DocsBaseURL, Fallback: orig.Fallback, Entries: entries}
	t.Cleanup(func() { catalog = orig })
}

// The one line this change adds to production code. Deleting the passthrough in
// ToErrorResponse must fail here.
func TestToErrorResponse_CarriesTheCatalogClassification(t *testing.T) {
	withClassified(t, "TX_REVERTED", ReconcileThenDecide)

	pub := New("TX_REVERTED", "internal detail", "req_1", SchemaJsonDomainSETTLERAGENT, nil).ToErrorResponse()

	if pub.RetryClassification != ReconcileThenDecide {
		t.Fatalf("retry classification = %q, want %q. Is the passthrough in ToErrorResponse still there?",
			pub.RetryClassification, ReconcileThenDecide)
	}
	body, err := json.Marshal(pub)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(body), `"retry_classification":"RECONCILE_THEN_DECIDE"`) {
		t.Fatalf("classification missing from the wire body: %s", body)
	}
}

// The classification is per catalog entry, keyed by internal code, so two internal
// codes sharing one public code can still carry different values.
//
// This used to be demonstrated with CONFLICT_IN_PROGRESS and CONFLICT_ALREADY_SETTLED,
// which is no longer a valid example: those two now carry their own public codes,
// because "still running" and "already paid" are the two answers a caller most needs
// to tell apart and one shared code made that impossible. SERVICE_BUSY is the
// remaining honest case, where the caller's action really is the same either way.
func TestToErrorResponse_ClassificationIsPerInternalEntry(t *testing.T) {
	unavailable := New("SERVICE_UNAVAILABLE", "x", "r", SchemaJsonDomainPAYMENTGATEWAY, nil).ToErrorResponse()
	atCapacity := New("SETTLER_GATEWAY_AT_CAPACITY", "x", "r", SchemaJsonDomainSETTLERGATEWAY, nil).ToErrorResponse()

	// Same public code, different advice.
	if unavailable.Code != "SERVICE_BUSY" || atCapacity.Code != "SERVICE_BUSY" {
		t.Fatalf("public codes = %q and %q, want SERVICE_BUSY for both", unavailable.Code, atCapacity.Code)
	}
	if unavailable.RetryClassification != RetryAfterDelay {
		t.Fatalf("service-unavailable = %q, want %q", unavailable.RetryClassification, RetryAfterDelay)
	}
	if atCapacity.RetryClassification != RetryWithNewIdentifier {
		t.Fatalf("at-capacity = %q, want %q", atCapacity.RetryClassification, RetryWithNewIdentifier)
	}
}

// The five conditions that used to share the public code CONFLICT now each name
// themselves, because they demand different actions: start over with a new id, poll,
// read the result, or stop and reconcile. A caller branching on the code could not
// tell any of them apart before.
func TestConflictConditionsAreNamedSeparately(t *testing.T) {
	want := map[string]string{
		"CONFLICT_REQUEST_ID_OWNED":          "REQUEST_ID_TAKEN",
		"CONFLICT_IN_PROGRESS":               "PAYMENT_IN_PROGRESS",
		"CONFLICT_ALREADY_SETTLED":           "ALREADY_SETTLED",
		"CONFLICT_DUPLICATE_INTENT":          "DUPLICATE_INTENT",
		"CONFLICT_DUPLICATE_INTENT_RECOVERY": "DUPLICATE_INTENT",
	}
	for internal, publicCode := range want {
		got := New(Code(internal), "x", "r", SchemaJsonDomainPAYMENTGATEWAY, nil).ToErrorResponse()
		if got.Code != publicCode {
			t.Errorf("%s -> %q, want %q", internal, got.Code, publicCode)
		}
		if got.Code == "CONFLICT" {
			t.Errorf("%s still answers to the generic CONFLICT", internal)
		}
	}
}

// Money may have moved is the one settlement answer a caller must be able to see, and
// it used to arrive as the same INTERNAL_ERROR as ten faults where nothing happened.
func TestSettlementOutcomeUnknownIsNotGenericInternalError(t *testing.T) {
	got := New("SETTLER_GATEWAY_INTERNAL_ERROR", "x", "r", SchemaJsonDomainSETTLERGATEWAY, nil).ToErrorResponse()
	if got.Code == "INTERNAL_ERROR" {
		t.Fatal("a settlement whose outcome is unknown must not look like a generic internal error")
	}
	if got.Code != "SETTLEMENT_OUTCOME_UNKNOWN" {
		t.Errorf("public code = %q, want SETTLEMENT_OUTCOME_UNKNOWN", got.Code)
	}
	if got.RetryClassification != ReconcileThenDecide {
		t.Errorf("classification = %q, want %q", got.RetryClassification, ReconcileThenDecide)
	}
}

// A deposit the payer could not fund moved no money, so it must not read as a
// settlement failure to reconcile. The id is spent because the payment exists.
func TestDepositFundingFailuresAreNamedFixRequests(t *testing.T) {
	want := map[Code]string{
		CodeDepositInsufficientFunds:    "INSUFFICIENT_FUNDS",
		CodeDepositMissingTokenApproval: "MISSING_TOKEN_APPROVAL",
	}
	for internal, publicCode := range want {
		got := New(internal, "x", "r", SchemaJsonDomainSETTLERAGENT, nil).ToErrorResponse()
		if got.Code != publicCode {
			t.Errorf("%s -> %q, want %q", internal, got.Code, publicCode)
		}
		if got.RetryClassification != NotRetryableFixRequest {
			t.Errorf("%s: classification = %q, want %q", internal, got.RetryClassification, NotRetryableFixRequest)
		}
		if got.RequestIdReusable == nil || *got.RequestIdReusable {
			t.Errorf("%s: the payment exists, so the request_id must be stated as spent", internal)
		}
	}
}

// An uncatalogued code falls back to INTERNAL_ERROR. The fallback carries no
// classification, so the field must be absent rather than inherited.
func TestToErrorResponse_FallbackIsUnclassified(t *testing.T) {
	withClassified(t, "TX_REVERTED", ReconcileThenDecide)

	pub := New("NO_SUCH_CODE", "x", "r", SchemaJsonDomainSETTLERAGENT, nil).ToErrorResponse()
	if pub.Code != "INTERNAL_ERROR" {
		t.Fatalf("code = %q, want the INTERNAL_ERROR fallback", pub.Code)
	}
	if pub.RetryClassification != "" {
		t.Fatalf("fallback inherited a classification: %q", pub.RetryClassification)
	}
}

// Guards the surface CORE-2223 lands on: a typo in catalog.json would otherwise
// ship to integrators as a classification nothing recognises.
func TestCatalogClassificationsAreKnownValues(t *testing.T) {
	known := map[RetryClassification]bool{
		RetryAfterDelay: true, ReconcileThenDecide: true,
		RetryWithNewIdentifier: true, PollForCompletion: true, NotRetryableFixRequest: true,
		AlreadyDone: true, ContactSupport: true,
	}
	check := func(name string, e catalogEntry) {
		if e.RetryClassification == "" {
			return
		}
		if !known[e.RetryClassification] {
			t.Errorf("%s: retry_classification %q is not one of the published values", name, e.RetryClassification)
		}
	}
	for code, e := range catalog.Entries {
		check(code, e)
	}
	check("fallback", catalog.Fallback)
}

// The ticket's load-bearing criterion: every condition where a retry could
// duplicate a payment must be conservative. These are the codes where our own
// records cannot rule out that funds moved, so none of them may ever be marked
// safe to submit a fresh request_id against.
func TestDuplicatePaymentConditionsAreConservative(t *testing.T) {
	// The published meaning of the value constrains what may carry it: "only
	// meaningful alongside a payment_id, since you cannot reconcile a payment you
	// cannot name." So a code reachable on a path that names no payment does not
	// belong here however uncertain its outcome is, because the advice it gives is
	// one the caller has no way to act on.
	mustReconcile := map[string]string{
		// Settlement: the on-chain outcome is not knowable from our side. Both the
		// Tron duplicate-broadcast and the cross-env nonce-collision RCAs are cases
		// where a "failed" step had a sibling that landed.
		"TX_REVERTED":                  "a revert can mean the work already landed",
		"NONCE_TOO_LOW":                "another transaction consumed the nonce, possibly our own",
		"BROADCAST_REJECTED":           "what a rejected duplicate looks like while the first lands",
		"FULFILLMENT_DEADLINE_EXPIRED": "reachable for a payment that actually delivered",
		// The PSP may have acted before the webhook failed.
		"COUNTERPARTY_WEBHOOK_ERROR":            "the PSP returned non-200, so it received the request",
		"COUNTERPARTY_WEBHOOK_CONNECTION_ERROR": "conservative: treat an unreached PSP as unknown",
		// Duplicate intent: the idempotency key includes request_id, so a fresh id
		// does not collide and the sibling payment that owns the intent proceeds.
		// The refusal site reads no status, so it cannot assert nothing was awarded.
		"CONFLICT_DUPLICATE_INTENT":          "the owning payment's state is never read",
		"CONFLICT_DUPLICATE_INTENT_RECOVERY": "a reserve witness may already be published",
		// Five of its raise sites in the settler gateway fire after the escrow
		// deposit is confirmed or the destination leg delivered, so funds have
		// moved by the time the caller sees it.
		"SETTLER_GATEWAY_INTERNAL_ERROR": "reachable after the deposit is confirmed or the fulfillment delivered",
		// A conflict we could not name. The refusal reads no status, so whatever
		// the request collided with is in an unknown state.
		"CONFLICT": "the colliding payment's state is never read",
		// The PSP may have acted and answered late. This is the deferral CORE-1691
		// was holding open: unknown is the answer, not a missing one.
		"COUNTERPARTY_TIMEOUT": "silence does not say whether the PSP acted",
		// Fires on a status GET once the record has aged out. The lookup will never
		// succeed again, and the payment's outcome is no longer readable from us.
		"PAYMENT_EXPIRED": "the record is gone, so we cannot assert it did not settle",
		// The settler said a settlement failed without saying where it stopped, so a
		// deposit or a fulfillment may already have landed.
		"SETTLER_REPORTED_ERROR": "the settler reports the failure without naming the step it reached",
	}
	for code, why := range mustReconcile {
		e, ok := catalog.Entries[code]
		if !ok {
			t.Errorf("%s: no catalog entry, has it been renamed?", code)
			continue
		}
		if e.RetryClassification != ReconcileThenDecide {
			t.Errorf("%s: classified %q, want %q (%s)", code, e.RetryClassification, ReconcileThenDecide, why)
		}
	}
	// The other direction, so the list cannot silently fall behind the catalog:
	// anything classified RECONCILE_THEN_DECIDE must be listed above with a
	// reason. REQUEST_TIMEOUT was missing from an earlier version of this list.
	for code, e := range catalog.Entries {
		if e.RetryClassification != ReconcileThenDecide {
			continue
		}
		if _, listed := mustReconcile[code]; !listed {
			t.Errorf("%s: classified %q but not in mustReconcile. Add it with the reason it cannot be ruled out.", code, ReconcileThenDecide)
		}
	}
}

// This change makes the relation load-bearing: the docs generator renders one
// page per public code and keys it by docs_slug, so two public codes sharing a
// slug would silently give one of them the other's page.
func TestDocsSlugMapsOneToOneWithPublicCode(t *testing.T) {
	byCode := map[string]string{}
	bySlug := map[string]string{}
	check := func(name string, e catalogEntry) {
		if prev, ok := byCode[e.PublicCode]; ok && prev != e.DocsSlug {
			t.Errorf("%s: public code %s has two slugs, %q and %q", name, e.PublicCode, prev, e.DocsSlug)
		}
		if prev, ok := bySlug[e.DocsSlug]; ok && prev != e.PublicCode {
			t.Errorf("%s: slug %q is claimed by both %s and %s", name, e.DocsSlug, prev, e.PublicCode)
		}
		byCode[e.PublicCode] = e.DocsSlug
		bySlug[e.DocsSlug] = e.PublicCode
	}
	for code, e := range catalog.Entries {
		check(code, e)
	}
	check("fallback", catalog.Fallback)
}

// Every entry must carry an answer. An unclassified entry reaches the caller
// with the key omitted, which reads as "we have no guidance" and is never what
// we mean: even a pure server fault has a correct answer (contact support, or
// reconcile before re-sending). The fallback is the one exception, covered by
// TestToErrorResponse_FallbackIsUnclassified.
func TestEveryEntryIsClassified(t *testing.T) {
	for code, e := range catalog.Entries {
		if e.RetryClassification == "" {
			t.Errorf("%s: no retry_classification", code)
		}
	}
}
