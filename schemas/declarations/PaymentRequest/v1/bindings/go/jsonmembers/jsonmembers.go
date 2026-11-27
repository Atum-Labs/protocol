// Package jsonmembers refuses JSON documents whose sibling members fold to one name.
//
// It lives in the PaymentRequest bindings rather than in any one validator because every
// declaration that reads a signed document needs the same refusal, and two copies of a scanner
// are two chances to disagree: the sender-auth commitment checks, the FulfillmentAuthorization
// validator and the PaymentRequest rules all call these functions.
package jsonmembers

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// MaxJSONDepth is the deepest nesting FirstAmbiguousMember reads. It is the limit encoding/json
// applies, so a document refused here is one encoding/json refuses too.
const MaxJSONDepth = 10000

// ErrInvalidJSON is returned by FirstAmbiguousMember when the document is not exactly one valid
// JSON value, or nests deeper than MaxJSONDepth. Treat it as a refusal.
var ErrInvalidJSON = errors.New("not valid JSON")

// FirstAmbiguousMember returns the path (for example "$.destination[0].Account") of the first
// member whose name equals another member name of the same object under Unicode simple folding,
// exact duplicates included, or "" when there is none.
//
// Readers disagree on such a document: encoding/json matches member names case-insensitively and
// keeps the last match, while JSON.parse and map decodes keep every spelling apart. Two parties
// reading the same bytes can therefore see different payments, so the document must be refused.
//
// The value of an "@context" member is not inspected, because JSON-LD contexts legitimately define
// terms that differ only in case. The member name itself is still checked. A document that is not
// valid UTF-8 is refused: decoders replace invalid bytes inconsistently, so names could differ.
func FirstAmbiguousMember(document []byte) (string, error) {
	return firstAmbiguousMember(document, true, nil)
}

// FirstAmbiguousMemberIn is FirstAmbiguousMember limited to what a reader of the root object uses:
// every member name of the root is checked, but only the values of the root members named in read
// (matched under the same folding) are inspected. Other root values are still parsed, so a document
// that is not valid JSON is refused, but a twin inside them is not reported. A root that is not an
// object is scanned in full. An empty read checks the root's member names only.
//
// Use it where part of the document is carried for others and never read, so a twin there cannot
// make the reader refuse what it does not act on.
func FirstAmbiguousMemberIn(document []byte, read []string) (string, error) {
	inspect := make(map[string]struct{}, len(read))
	for _, name := range read {
		inspect[FoldMemberName(name)] = struct{}{}
	}
	return firstAmbiguousMember(document, true, inspect)
}

// FirstAmbiguousMemberStrict is FirstAmbiguousMember with no "@context" exemption, for a document
// that carries no JSON-LD: a signed EIP-3009 prehash, or a Permit2 one.
func FirstAmbiguousMemberStrict(document []byte) (string, error) {
	return firstAmbiguousMember(document, false, nil)
}

// firstAmbiguousMember is FirstAmbiguousMember with the "@context" exemption made optional. A
// signed prehash carries no JSON-LD, so it is scanned with no exemption at all. A non-nil inspect
// holds the folded names of the root members whose values are inspected.
func firstAmbiguousMember(document []byte, exemptContext bool, inspect map[string]struct{}) (string, error) {
	if !utf8.Valid(document) {
		return "", fmt.Errorf("%w: not valid UTF-8", ErrInvalidJSON)
	}
	dec := json.NewDecoder(bytes.NewReader(document))
	dec.UseNumber()

	type frame struct {
		object bool
		seen   map[string]struct{} // folded member names of this object
		key    string              // member whose value is being read (objects)
		named  bool                // a member name was read and its value was not
		index  int                 // element being read (arrays)
	}
	var stack []*frame
	values := 0

	// The path is assembled only when a twin is found, so memory stays linear in the document.
	pathOf := func(name string) string {
		var b strings.Builder
		b.WriteString("$")
		for _, f := range stack[:len(stack)-1] {
			if f.object {
				b.WriteString("." + f.key)
			} else {
				b.WriteString("[" + strconv.Itoa(f.index) + "]")
			}
		}
		b.WriteString("." + name)
		return b.String()
	}
	valueDone := func() {
		if len(stack) == 0 {
			values++
			return
		}
		top := stack[len(stack)-1]
		if top.object {
			top.named = false
		} else {
			top.index++
		}
	}

	for {
		tok, err := dec.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", fmt.Errorf("%w: %v", ErrInvalidJSON, err)
		}
		if len(stack) == 0 && values > 0 {
			return "", fmt.Errorf("%w: more than one top-level value", ErrInvalidJSON)
		}

		if len(stack) > 0 {
			top := stack[len(stack)-1]
			if top.object && !top.named {
				if delim, ok := tok.(json.Delim); ok && delim == '}' {
					stack = stack[:len(stack)-1]
					valueDone()
					continue
				}
				name, ok := tok.(string)
				if !ok {
					return "", fmt.Errorf("%w: member name is %T", ErrInvalidJSON, tok)
				}
				folded := FoldMemberName(name)
				if _, dup := top.seen[folded]; dup {
					return pathOf(name), nil
				}
				top.seen[folded] = struct{}{}
				top.key = name
				top.named = true
				if (exemptContext && name == "@context") || (inspect != nil && len(stack) == 1 && !inspected(inspect, folded)) {
					if err := skipJSONValue(dec, len(stack)); err != nil {
						return "", fmt.Errorf("%w: %v", ErrInvalidJSON, err)
					}
					valueDone()
				}
				continue
			}
		}

		switch t := tok.(type) {
		case json.Delim:
			switch t {
			case '{', '[':
				if len(stack) >= MaxJSONDepth {
					return "", fmt.Errorf("%w: nested more than %d levels deep", ErrInvalidJSON, MaxJSONDepth)
				}
				f := &frame{object: t == '{'}
				if f.object {
					f.seen = map[string]struct{}{}
				}
				stack = append(stack, f)
			case ']':
				stack = stack[:len(stack)-1]
				valueDone()
			}
		default:
			valueDone()
		}
	}
	if values != 1 || len(stack) != 0 {
		return "", fmt.Errorf("%w: the document is not exactly one complete value", ErrInvalidJSON)
	}
	return "", nil
}

func inspected(inspect map[string]struct{}, folded string) bool {
	_, ok := inspect[folded]
	return ok
}

// foldMemberName maps a name to the least rune of each rune's simple-folding orbit, so two names
// fold equal exactly when strings.EqualFold (the relation encoding/json matches by) holds.
// FoldMemberName is the folded form two member names share when encoding/json would treat
// them as the same member. A caller that compares member names itself must fold the same way,
// or it will disagree with the scan about what counts as a twin.
func FoldMemberName(name string) string {
	var b strings.Builder
	b.Grow(len(name))
	for _, r := range name {
		b.WriteRune(leastFold(r))
	}
	return b.String()
}

// leastFold is the least rune of r's Unicode simple-folding orbit.
func leastFold(r rune) rune {
	least := r
	for f := unicode.SimpleFold(r); f != r; f = unicode.SimpleFold(f) {
		if f < least {
			least = f
		}
	}
	return least
}

// skipJSONValue consumes one complete value without inspecting it. open is the number of containers
// already open around it, so the depth limit counts the whole document.
func skipJSONValue(dec *json.Decoder, open int) error {
	depth := 0
	for {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		if delim, ok := tok.(json.Delim); ok {
			switch delim {
			case '{', '[':
				if open+depth >= MaxJSONDepth {
					return fmt.Errorf("nested more than %d levels deep", MaxJSONDepth)
				}
				depth++
			case '}', ']':
				depth--
			}
		}
		if depth == 0 {
			return nil
		}
	}
}
