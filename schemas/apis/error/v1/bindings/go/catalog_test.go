package atumerror

import (
	"regexp"
	"sort"
	"testing"
)

// publicCodePattern is the pattern the OpenAPI ErrorResponse publishes for `code`.
var publicCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]*$`)

// TestCatalogIntegrity fails on a broken catalog entry (bad public_code, empty
// message, out-of-range status, missing docs_slug) that would otherwise only
// surface to an integrator.
func TestCatalogIntegrity(t *testing.T) {
	check := func(name string, e catalogEntry) {
		if !publicCodePattern.MatchString(e.PublicCode) {
			t.Errorf("%s: public_code %q does not match the published pattern %s", name, e.PublicCode, publicCodePattern)
		}
		if e.PublicMessage == "" {
			t.Errorf("%s: empty public_message", name)
		}
		if e.HTTPStatus < 400 || e.HTTPStatus > 599 {
			t.Errorf("%s: http_status %d is not a 4xx/5xx", name, e.HTTPStatus)
		}
		// A missing docs_slug silently yields an empty docs_url, so require it.
		if e.DocsSlug == "" {
			t.Errorf("%s: empty docs_slug", name)
		}
	}

	check("fallback", catalog.Fallback)
	if len(catalog.Entries) == 0 {
		t.Fatal("catalog has no entries")
	}
	for code, e := range catalog.Entries {
		check(code, e)
	}
	if catalog.DocsBaseURL == "" {
		t.Error("empty docs_base_url")
	}
}

// TestPublicCodeCarriesOneStatus pins the property the README publishes to
// integrators: a public code always arrives with the same HTTP status, whatever
// internal condition produced it.
//
// Several internal reasons deliberately collapse onto one public code — the
// distinction between them is not the caller's to act on. That is only safe while
// the status agrees too. A code that arrived as 502 from one path and 422 from
// another would make it impossible to decide from the response alone whether a
// request may be retried, which is the first thing client code does with an error.
func TestPublicCodeCarriesOneStatus(t *testing.T) {
	// Sorted so a failure names the same reference entry on every run. Go map order
	// is randomised, so an unsorted walk reports one of the two colliding entries at
	// random and the message changes between runs of the same broken catalog.
	names := make([]string, 0, len(catalog.Entries))
	for name := range catalog.Entries {
		names = append(names, name)
	}
	sort.Strings(names)

	statuses := map[string]int{}
	sources := map[string]string{}
	for _, name := range names {
		e := catalog.Entries[name]
		if seen, ok := statuses[e.PublicCode]; ok {
			if seen != e.HTTPStatus {
				t.Errorf("public_code %q maps to HTTP %d via %s but HTTP %d via %s; "+
					"one public code must always carry one status",
					e.PublicCode, seen, sources[e.PublicCode], e.HTTPStatus, name)
			}
			continue
		}
		statuses[e.PublicCode] = e.HTTPStatus
		sources[e.PublicCode] = name
	}
}

// TestPublicMessagesRevealNoInternals pins the other half of what the README
// promises: a public message is safe to show a person and safe to log.
//
// Messages are the one part of an error that is written by hand, so they are where
// an internal detail is most likely to escape. A component name tells an attacker
// how the system is decomposed and tells an integrator to depend on something they
// cannot see; a raw address or hash in a shared message is almost always a value
// pasted from one incident and wrong for every other caller.
func TestPublicMessagesRevealNoInternals(t *testing.T) {
	// Two separate detectors, because the two things being kept out of a message
	// look nothing alike.
	//
	// Component names are a fixed list: it cannot be widened much without false
	// positives, since role words that legitimately appear in messages ("settler")
	// and short names that occur inside longer words are indistinguishable from a
	// leak by pattern alone.
	//
	// Addresses and hashes, by contrast, are recognisable by SHAPE — a long
	// unbroken run of hex or base58 with no word boundaries. The threshold sits
	// above the longest token any real message uses, so it catches an EVM, Solana
	// or Tron address without needing to know which chain it came from.
	components := regexp.MustCompile(`(?i)kafka|postgres|goroutine|nil pointer`)
	addresses := regexp.MustCompile(`0x[0-9a-fA-F]{6,}|[1-9A-HJ-NP-Za-km-z]{26,}`)

	check := func(name, msg string) {
		if m := components.FindString(msg); m != "" {
			t.Errorf("%s: public_message names the component %q — messages are shown to "+
				"callers and must not describe how the system is built", name, m)
		}
		if m := addresses.FindString(msg); m != "" {
			t.Errorf("%s: public_message embeds the address or hash %q — a value pasted from "+
				"one request is wrong for every other caller that reads this message", name, m)
		}
	}
	check("fallback", catalog.Fallback.PublicMessage)
	for name, e := range catalog.Entries {
		check(name, e.PublicMessage)
	}
}
