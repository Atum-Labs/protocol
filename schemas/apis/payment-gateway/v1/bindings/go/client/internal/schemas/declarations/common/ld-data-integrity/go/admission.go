package lddataintegrity

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ErrNotCanonicalizable reports a document refused before canonicalization. Every
// *AdmissionError matches it.
var ErrNotCanonicalizable = errors.New("lddataintegrity: document not canonicalizable")

// AdmissionRule names the rule a refused document broke. The values are wire strings,
// shared with the TypeScript implementation through the conformance vectors, so both
// languages refuse the same documents for the same reason.
type AdmissionRule string

const (
	// RuleValueBudget: more JSON values than maxAdmittedValues.
	RuleValueBudget AdmissionRule = "value-budget"
	// RuleByteBudget: more string bytes, counting values and keys, than maxAdmittedBytes.
	RuleByteBudget AdmissionRule = "byte-budget"
	// RuleReservedKey: a JSON-LD keyword other than @context used as a key, such as @id or
	// @graph, which would let a document name and interlink its own blank nodes.
	RuleReservedKey AdmissionRule = "reserved-key"
	// RuleCompactIRIKey: a key containing ":", which mints a predicate the published
	// context does not define.
	RuleCompactIRIKey AdmissionRule = "compact-iri-key"
	// RuleContextShape: an @context that is not a URL or a list of URLs. An inline
	// context would let a document redefine its own terms.
	RuleContextShape AdmissionRule = "context-shape"
	// RuleBlankNodeLabel: a string value in blank-node label syntax, through which a
	// document would reference blank nodes by name.
	RuleBlankNodeLabel AdmissionRule = "blank-node-label"
	// RuleDepthBudget: an object or array nested deeper than maxAdmittedDepth. JSON-LD
	// processors expand documents recursively, and jsonld.js exhausts its stack well
	// inside the value budget.
	RuleDepthBudget AdmissionRule = "depth-budget"
	// RuleTabCharacter: a string value containing a TAB. json-gold escapes it in an
	// N-Quads literal and rdf-canonize writes it raw, so the Go and TypeScript
	// canonical forms of such a document differ.
	RuleTabCharacter AdmissionRule = "tab-character"
	// RuleIllFormedString: a key or string value that is not valid UTF-8. A document
	// decoded by encoding/json cannot hold one, since the decoder replaces invalid
	// bytes with U+FFFD; one built in code can.
	RuleIllFormedString AdmissionRule = "ill-formed-string"
	// RuleBlankNodeBudget: more blank nodes in the expanded dataset than
	// maxAdmittedBlankNodes.
	RuleBlankNodeBudget AdmissionRule = "blank-node-budget"
	// RuleOutputBudget: an expanded dataset whose canonical N-Quads would exceed
	// maxAdmittedOutputBytes.
	RuleOutputBudget AdmissionRule = "output-budget"
	// RuleIndistinguishableBlankNodes: two blank nodes in the expanded dataset share
	// their first-degree quads, so canonicalization would have to search permutations
	// to tell them apart.
	RuleIndistinguishableBlankNodes AdmissionRule = "indistinguishable-blank-nodes"
)

// maxAdmittedValues bounds the JSON values a document may carry, and with them the
// number of statements expansion can produce. The schemas do not bound a document's
// size, so this is a policy limit set with measured headroom: the largest document in
// the conformance corpus has about 40 values, and a synthetic request with every schema
// array at its maxItems about 280.
const maxAdmittedValues = 1024

// maxAdmittedBytes bounds the string bytes a document may carry, keys included, and with
// them the length of the canonical output. Like maxAdmittedValues it is a policy limit:
// the same synthetic request carries about 50 KiB.
const maxAdmittedBytes = 128 << 10

// maxAdmittedDepth bounds how deeply objects and arrays may nest, the root being at
// depth 1. Signed protocol documents nest a handful of levels.
const maxAdmittedDepth = 32

// maxAdmittedBlankNodes bounds the distinct blank nodes in the expanded dataset. The
// value budget does not bound them on its own: a term whose context declares a graph
// container expands one JSON object into both a node and the graph holding it.
const maxAdmittedBlankNodes = 1024

// maxAdmittedOutputBytes bounds the canonical N-Quads a dataset may produce. The JSON
// budgets do not bound it: every statement repeats its subject in full, so one long
// IRI shared by many statements multiplies into the output. json-gold appends each
// statement to the output built so far, copying it every time, so the bytes it
// allocates grow with the output length times the statement count. The largest honest
// documents are a FulfillmentQuote embedding a full PaymentRequest and a
// PaymentRequestEnvelope presentation carrying 16 credentials, at about 32 to 34 KB;
// sender_auth.signed_messages has no schema maximum, and sixteen of them take the quote
// to about 63 KB. This bound leaves room for those while keeping the costliest
// admitted output to tens of megabytes of allocation.
const maxAdmittedOutputBytes = 128 << 10

// AdmissionError reports which rule refused a document, and where. Path is an RFC 6901
// JSON Pointer to the offending value; it is empty for a document refused as a whole.
type AdmissionError struct {
	Rule AdmissionRule
	Path string
}

func (e *AdmissionError) Error() string {
	if e.Path == "" {
		return fmt.Sprintf("%s: %s", ErrNotCanonicalizable, e.Rule)
	}
	return fmt.Sprintf("%s: %s at %q", ErrNotCanonicalizable, e.Rule, e.Path)
}

func (e *AdmissionError) Is(target error) bool {
	return target == ErrNotCanonicalizable
}

// CheckCanonicalizable refuses a document that is too large, or that uses JSON-LD
// features that would let it define its own terms or name its own blank nodes, and
// admits every other document without changing it.
//
// What it bounds is the size of the document and of what expansion makes of it; it does
// not by itself bound the cost of canonicalizing what remains. doc is a generic JSON
// value, as encoding/json decodes into any.
//
// Object members are visited in Unicode code point order, so that a refused document is
// reported the same way on every run, and a rule broken by several sibling keys is
// reported at the same key in every language. Which rule is reported when a document
// breaks more than one is not part of the contract.
func CheckCanonicalizable(doc any) error {
	c := admissionCheck{}
	return c.walk(doc, "", 0)
}

type admissionCheck struct {
	values int
	bytes  int
}

func (c *admissionCheck) countBytes(s string) error {
	c.bytes += len(s)
	if c.bytes > maxAdmittedBytes {
		return &AdmissionError{Rule: RuleByteBudget, Path: ""}
	}
	return nil
}

// walk checks v, found at path inside depth enclosing objects and arrays. A container
// is refused on entry, before anything inside it is visited, so that the check never
// recurses deeper than the budget.
func (c *admissionCheck) walk(v any, path string, depth int) error {
	c.values++
	if c.values > maxAdmittedValues {
		return &AdmissionError{Rule: RuleValueBudget, Path: ""}
	}
	switch v.(type) {
	case map[string]any, []any:
		depth++
		if depth > maxAdmittedDepth {
			return &AdmissionError{Rule: RuleDepthBudget, Path: path}
		}
	}

	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		// sort.Strings compares UTF-8 bytes, which orders strings by code point.
		sort.Strings(keys)
		for _, k := range keys {
			if err := c.countBytes(k); err != nil {
				return err
			}
			child := path + "/" + escapePointerToken(k)
			// Checked before the key's syntax rules, which would otherwise interpret
			// text that is not valid UTF-8.
			if !utf8.ValidString(k) {
				return &AdmissionError{Rule: RuleIllFormedString, Path: child}
			}
			if k == "@context" {
				if !isContextReference(t[k]) {
					return &AdmissionError{Rule: RuleContextShape, Path: child}
				}
			} else if strings.HasPrefix(k, "@") {
				return &AdmissionError{Rule: RuleReservedKey, Path: child}
			} else if strings.Contains(k, ":") {
				return &AdmissionError{Rule: RuleCompactIRIKey, Path: child}
			}
			if err := c.walk(t[k], child, depth); err != nil {
				return err
			}
		}
	case []any:
		for i, e := range t {
			if err := c.walk(e, path+"/"+strconv.Itoa(i), depth); err != nil {
				return err
			}
		}
	case string:
		if err := c.countBytes(t); err != nil {
			return err
		}
		if !utf8.ValidString(t) {
			return &AdmissionError{Rule: RuleIllFormedString, Path: path}
		}
		if strings.ContainsRune(t, '\t') {
			return &AdmissionError{Rule: RuleTabCharacter, Path: path}
		}
		if strings.HasPrefix(t, "_:") {
			return &AdmissionError{Rule: RuleBlankNodeLabel, Path: path}
		}
	}
	return nil
}

// isContextReference reports whether an @context value only names contexts by URL, as a
// string or a list of strings.
func isContextReference(v any) bool {
	switch t := v.(type) {
	case string:
		return true
	case []any:
		for _, e := range t {
			if _, ok := e.(string); !ok {
				return false
			}
		}
		return true
	}
	return false
}

// escapePointerToken applies RFC 6901 escaping: "~" before "/", since "/" escapes to a
// sequence containing "~".
func escapePointerToken(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~", "~0"), "/", "~1")
}
