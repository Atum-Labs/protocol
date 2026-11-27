package ldverification

import (
	"encoding/json"
	"regexp"
	"strings"
	"sync"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/piprate/json-gold/ld"
)

// Reserved credential types are matched on what a credential's `type`
// MEANS, not on how it is spelled. JSON-LD gives one type many spellings:
// the known-to-atum context maps `KnownToAtumVerifiableCredential` to
// `kta:KnownToAtumVerifiableCredential`, so the full IRI
// `https://schemas.atum.xyz/credentials/known-to-atum/v1#KnownToAtumVerifiableCredential`,
// the compact `kta:` form and any context term aliasing that IRI are the
// same credential type to every JSON-LD reader. Matching the raw strings
// alone would let any of those spellings skip the issuer check.
//
// A credential is RESERVED, and so walks every per-VC check, when any of
// these holds:
//
//   - one of its `type` strings is a reserved name, or ends in one after
//     its last '#', '/' or ':' (the lexical net: an unknown prefix such as
//     `kta:KnownToAtumVerifiableCredential` without the known-to-atum
//     context still counts);
//   - one of its types, expanded with JSON-LD exactly as it sits in the
//     presentation (the presentation's @context, then the credential's
//     own), is an IRI a reserved name expands to under Atum's bundled
//     credential contexts, so a term in a supplied context that aliases a
//     reserved IRI is caught;
//   - its types cannot be resolved: expansion fails (an unknown context, a
//     redefinition of one of Atum's protected terms), a type expands to
//     something that is not an absolute IRI (an undefined short name, a
//     blank node), or the expanded count differs from the declared count.
//     A type nothing defines is not passed through on the assumption that
//     it is harmless: it is checked.
//
// Everything else is passed through. Expansion uses the per-call loader
// (bundled contexts plus the caller's ExtraEnvelopeContexts and
// ExtraCredentialContexts) and never the network. Mirror of the TypeScript
// verifier's reserved-type matching; both must classify every credential
// the same way.
type reservedTypeMatcher struct {
	names        map[string]bool
	iris         map[string]bool
	loader       *lddataintegrity.DocumentLoader
	vpContext    any
	hasVPContext bool
}

// newReservedTypeMatcher returns nil when there is no reserved set, which
// checks every credential. envelopeJSON supplies the presentation's
// @context, under which every embedded credential is expanded.
func newReservedTypeMatcher(reserved []string, envelopeJSON []byte, loader *lddataintegrity.DocumentLoader) *reservedTypeMatcher {
	if len(reserved) == 0 {
		return nil
	}
	m := &reservedTypeMatcher{
		names:  make(map[string]bool, len(reserved)),
		iris:   map[string]bool{},
		loader: loader,
	}
	for _, name := range reserved {
		m.names[name] = true
		for _, iri := range reservedTypeIRIs(name) {
			m.iris[iri] = true
		}
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(envelopeJSON, &envelope); err == nil {
		if raw, ok := envelope["@context"]; ok {
			var ctx any
			if err := json.Unmarshal(raw, &ctx); err == nil {
				m.vpContext, m.hasVPContext = ctx, true
			}
		}
	}
	return m
}

// reserved reports whether a credential with these declared types (and
// this wire JSON, for its own @context) must walk every per-VC check.
func (m *reservedTypeMatcher) reserved(types []string, rawVC json.RawMessage) bool {
	for _, t := range types {
		if m.lexical(t) {
			return true
		}
	}
	expanded, ok := m.expandTypes(types, rawVC)
	if !ok || len(expanded) != len(types) {
		return true
	}
	for _, iri := range expanded {
		if !isAbsoluteIRI(iri) || m.iris[iri] {
			return true
		}
	}
	return false
}

func (m *reservedTypeMatcher) lexical(t string) bool {
	return m.names[t] || m.names[typeLocalName(t)]
}

// expandTypes expands the credential's types with JSON-LD, nesting the
// credential under the presentation's verifiableCredential member exactly
// as it is signed, so the presentation's context applies and then the
// credential's own. ok is false when expansion fails or the result isn't
// the single nested node it must be.
func (m *reservedTypeMatcher) expandTypes(types []string, rawVC json.RawMessage) ([]string, bool) {
	typesAny := make([]any, len(types))
	for i, t := range types {
		typesAny[i] = t
	}
	probe := map[string]any{"type": typesAny}
	var vcMembers map[string]json.RawMessage
	if err := json.Unmarshal(rawVC, &vcMembers); err != nil {
		return nil, false
	}
	if raw, ok := vcMembers["@context"]; ok {
		var ctx any
		if err := json.Unmarshal(raw, &ctx); err != nil {
			return nil, false
		}
		probe["@context"] = ctx
	}
	doc := map[string]any{"verifiableCredential": []any{probe}}
	if m.hasVPContext {
		doc["@context"] = m.vpContext
	}
	out, err := expandForTypes(doc, m.loader)
	if err != nil {
		return nil, false
	}
	node, ok := nestedCredentialNode(out)
	if !ok {
		return nil, false
	}
	return expandedTypeStrings(node)
}

// nestedCredentialNode digs the one credential node out of the expanded
// probe: the top node's single property, holding one value that is either
// the node itself or a @graph holding it.
func nestedCredentialNode(out []any) (map[string]any, bool) {
	if len(out) != 1 {
		return nil, false
	}
	top, ok := out[0].(map[string]any)
	if !ok {
		return nil, false
	}
	var values []any
	found := 0
	for k, v := range top {
		if strings.HasPrefix(k, "@") {
			continue
		}
		found++
		values, ok = v.([]any)
		if !ok {
			return nil, false
		}
	}
	if found != 1 || len(values) != 1 {
		return nil, false
	}
	elem, ok := values[0].(map[string]any)
	if !ok {
		return nil, false
	}
	if graph, isGraph := elem["@graph"]; isGraph {
		nodes, ok := graph.([]any)
		if !ok || len(nodes) != 1 {
			return nil, false
		}
		elem, ok = nodes[0].(map[string]any)
		if !ok {
			return nil, false
		}
	}
	return elem, true
}

func expandedTypeStrings(node map[string]any) ([]string, bool) {
	raw, ok := node["@type"]
	if !ok {
		return nil, true
	}
	list, ok := raw.([]any)
	if !ok {
		return nil, false
	}
	types := make([]string, 0, len(list))
	for _, v := range list {
		s, ok := v.(string)
		if !ok {
			return nil, false
		}
		types = append(types, s)
	}
	return types, true
}

func expandForTypes(doc map[string]any, loader *lddataintegrity.DocumentLoader) ([]any, error) {
	opts := ld.NewJsonLdOptions("")
	opts.DocumentLoader = loader
	opts.ProcessingMode = ld.JsonLd_1_1
	return ld.NewJsonLdProcessor().Expand(doc, opts)
}

// absoluteIRI matches an IRI with a scheme. A blank node identifier ("_:")
// is not one.
var absoluteIRI = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.\-]*:`)

func isAbsoluteIRI(s string) bool {
	return !strings.HasPrefix(s, "_:") && absoluteIRI.MatchString(s)
}

// typeLocalName is what follows a type's last '#', '/' or ':'.
func typeLocalName(s string) string {
	if i := strings.LastIndexAny(s, "#/:"); i >= 0 {
		return s[i+1:]
	}
	return s
}

// reservedTypeContexts are the contexts a reserved name is expanded under
// to find the IRIs it stands for: the W3C credentials context alone, and
// with each of Atum's bundled credential contexts. Only the bundled loader
// is used, so a caller-supplied context can never change what a reserved
// name means. Mirror of the TypeScript RESERVED_TYPE_CONTEXTS.
var reservedTypeContexts = [][]any{
	{lddataintegrity.W3CVCV1ContextURL},
	{lddataintegrity.W3CVCV1ContextURL, lddataintegrity.KnownToAtumV1ContextURL},
	{lddataintegrity.W3CVCV1ContextURL, lddataintegrity.KnownToAtumV2ContextURL},
	{lddataintegrity.W3CVCV1ContextURL, lddataintegrity.KYCV1ContextURL},
	{lddataintegrity.W3CVCV1ContextURL, lddataintegrity.SenderComplianceV1ContextURL},
}

var reservedTypeIRICache sync.Map // reserved name -> []string

// reservedTypeIRIs returns the absolute IRIs a reserved name expands to
// under reservedTypeContexts, plus the name itself when it already is one.
// The bundled contexts never change, so the result is cached.
func reservedTypeIRIs(name string) []string {
	if cached, ok := reservedTypeIRICache.Load(name); ok {
		return cached.([]string)
	}
	seen := map[string]bool{}
	var iris []string
	add := func(iri string) {
		if isAbsoluteIRI(iri) && !seen[iri] {
			seen[iri] = true
			iris = append(iris, iri)
		}
	}
	add(name)
	for _, ctx := range reservedTypeContexts {
		out, err := expandForTypes(map[string]any{"@context": ctx, "@type": []any{name}}, fqLoader)
		if err != nil || len(out) != 1 {
			continue
		}
		node, ok := out[0].(map[string]any)
		if !ok {
			continue
		}
		types, ok := expandedTypeStrings(node)
		if !ok {
			continue
		}
		for _, t := range types {
			add(t)
		}
	}
	reservedTypeIRICache.Store(name, iris)
	return iris
}
