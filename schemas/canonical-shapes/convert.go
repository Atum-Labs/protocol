package main

import (
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// The canonical declarations are JSON Schema 2020-12; the API specs are OpenAPI 3.0.3,
// whose Schema Object is a different dialect. Converting between them is mechanical, but
// three classes of keyword need attention and each is handled below:
//
//   - meta keywords that describe the declaration document itself and have no meaning
//     once the shape is inlined into a spec ($id, $schema, $defs, title)
//   - keywords OAS 3.0.3 simply does not define. Carrying them would be silently
//     ignored by some tools and rejected by others, so they are dropped and REPORTED --
//     dropping a validation rule without saying so is how a contract quietly loosens
//   - keywords that exist in both dialects under different spellings (examples/example,
//     const/enum, type arrays/nullable)
//
// Anything not named here passes through untouched, so a keyword the two dialects share
// needs no entry and a new one fails loudly rather than being silently mangled.

// Keywords describing the declaration document, meaningless inside a spec.
var metaKeywords = map[string]bool{
	"$schema": true, "$id": true, "$anchor": true, "$comment": true,
	"title": true, "$defs": true, "definitions": true,
}

// Keywords with no OpenAPI 3.0.3 equivalent. Dropping one changes what the contract
// validates, so every drop is collected and surfaced to the caller.
var unsupportedKeywords = map[string]bool{
	"contains": true, "minContains": true, "maxContains": true,
	"unevaluatedProperties": true, "unevaluatedItems": true,
	"prefixItems": true, "dependentSchemas": true, "dependentRequired": true,
	"if": true, "then": true, "else": true,
	"patternProperties": true, "propertyNames": true,
}

// Drop records one validation keyword that did not survive the dialect conversion.
type Drop struct {
	Path    string // e.g. "VerifiableCredential.properties.@context"
	Keyword string
}

func (d Drop) String() string { return d.Path + "." + d.Keyword }

// converter walks a canonical schema node tree and rewrites it into the OpenAPI 3.0.3
// dialect. It works on yaml.Node rather than map[string]any because Go maps have no
// order: the SDK generator derives public type names from the order it meets schemas in
// (status2, status3, ...), so a reordering pass would silently rename exported types.
// yaml.Node parses JSON too -- JSON is a subset of YAML -- so canonical is read, walked
// and written without ever losing key order.
type converter struct {
	drops []Drop
	// errs collects constructs that cannot be expressed in OpenAPI 3.0.3 at all, as
	// opposed to validation keywords that are merely dropped. Emitting a best guess for
	// one of these would put an invalid or wrong schema into a published contract, so the
	// run fails instead.
	errs []string
}

// convert returns a new node tree in the OpenAPI dialect. The input is not modified.
func (c *converter) convert(n *yaml.Node, path string) *yaml.Node {
	if n == nil {
		return nil
	}
	switch n.Kind {
	case yaml.DocumentNode:
		out := shallowCopy(n)
		for _, child := range n.Content {
			out.Content = append(out.Content, c.convert(child, path))
		}
		return out
	case yaml.SequenceNode:
		out := shallowCopy(n)
		for i, child := range n.Content {
			out.Content = append(out.Content, c.convert(child, fmt.Sprintf("%s[%d]", path, i)))
		}
		return out
	case yaml.MappingNode:
		return c.convertMapping(n, path)
	default:
		return shallowCopy(n)
	}
}

func (c *converter) convertMapping(n *yaml.Node, path string) *yaml.Node {
	out := shallowCopy(n)
	for i := 0; i+1 < len(n.Content); i += 2 {
		key, val := n.Content[i], n.Content[i+1]
		name := key.Value
		child := path
		if name != "" {
			child = strings.TrimPrefix(path+"."+name, ".")
		}

		switch {
		case metaKeywords[name]:
			// Nothing to record: these never carried validation meaning.
			continue

		case unsupportedKeywords[name]:
			c.drops = append(c.drops, Drop{Path: path, Keyword: name})
			continue

		case name == "$ref":
			// Canonical points inside its own document; the spec namespace is flat.
			out.Content = append(out.Content, shallowCopy(key), scalar(
				strings.Replace(val.Value, "#/$defs/", "#/components/schemas/", 1)))

		case name == "examples" && val.Kind == yaml.SequenceNode:
			// 2020-12 takes an array; the OAS 3.0 Schema Object takes a single `example`.
			if len(val.Content) > 0 {
				out.Content = append(out.Content, scalar("example"), c.convert(val.Content[0], child))
			}

		case name == "const":
			// OAS 3.0 has no `const`; a single-valued enum is the exact equivalent.
			seq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
			seq.Content = append(seq.Content, shallowCopy(val))
			out.Content = append(out.Content, scalar("enum"), seq)

		case name == "type" && val.Kind == yaml.SequenceNode:
			// 2020-12 spells an optional value as type: [x, "null"]; OAS 3.0 uses nullable.
			concrete, nullable, count := splitNullable(val)
			switch {
			case count == 0:
				// type: ["null"] means the value must literally be null. OAS 3.0.3 has no
				// null type, so there is nothing faithful to emit.
				c.errs = append(c.errs, fmt.Sprintf(
					"%s: type allows only null, which OpenAPI 3.0.3 cannot express; give the "+
						"property a concrete type in the declaration, or drop it from the spec",
					child))
				continue
			case count > 1:
				// A union of two concrete types has no OAS 3.0 `type` spelling. It needs a
				// oneOf in the declaration, which is a decision for whoever owns that
				// schema, not something to guess at here.
				c.errs = append(c.errs, fmt.Sprintf(
					"%s: type is a union of concrete types, which OpenAPI 3.0.3 cannot express; "+
						"model it as oneOf in the declaration", child))
				continue
			}
			out.Content = append(out.Content, shallowCopy(key), scalar(concrete))
			if nullable {
				out.Content = append(out.Content, scalar("nullable"), boolScalar(true))
			}

		default:
			out.Content = append(out.Content, shallowCopy(key), c.convert(val, child))
		}
	}
	return out
}

// A note on $ref siblings, so the next person does not spend the afternoon twice.
//
// JSON Schema lets a $ref carry siblings, and the declarations use that to hang a
// description or a deprecation on a referenced shape. The OpenAPI 3.0.3 Reference Object
// does not: anything beside a $ref "SHALL be ignored", so those annotations reach some
// readers and not others. Today @hey-api/openapi-ts renders them and oapi-codegen does
// not, which is why a field can be marked deprecated in the signed format and show up
// deprecated in the TypeScript SDK but not in the Go bindings.
//
// The portable 3.0 spelling is allOf with a single member, and it does fix both
// generators. It is deliberately NOT done here: oasdiff does not merge allOf when it
// resolves a schema, so wrapping a $ref makes the compatibility gate report every property
// of the referenced shape as removed. Trading a cosmetic gap in one generator for phantom
// breaking changes on the public contract is the wrong trade. Siblings therefore pass
// through unchanged, and the limitation is documented where it bites.

// splitNullable reduces a 2020-12 type array to the single OAS 3.0 type plus a nullable
// flag. count is how many concrete (non-null) types the array held: the caller needs to
// tell "only null" from "more than one concrete type" because they are different problems
// with different advice, and neither can be guessed at.
func splitNullable(seq *yaml.Node) (concrete string, nullable bool, count int) {
	var types []string
	for _, t := range seq.Content {
		if t.Value == "null" {
			nullable = true
			continue
		}
		types = append(types, t.Value)
	}
	if len(types) != 1 {
		return "", nullable, len(types)
	}
	return types[0], nullable, 1
}

// deepCopy duplicates a node and everything under it.
//
// Shapes are resolved out of one parsed source document, and the remove/overlay pass edits
// the node it is given in place. Handing it a node that still belongs to the source would
// edit the source, so every later shape in the same run would read a tree that had already
// been altered -- silently, and into a schema that signatures are checked against. The
// OpenAPI path gets a fresh tree from the dialect conversion; the declaration path has no
// conversion, so it copies here instead.
func deepCopy(n *yaml.Node) *yaml.Node {
	if n == nil {
		return nil
	}
	c := *n
	c.Content = nil
	for _, child := range n.Content {
		c.Content = append(c.Content, deepCopy(child))
	}
	return &c
}

// shallowCopy duplicates a node without its children and, importantly, without its
// style. The canonical declarations are JSON, which yaml.v3 reads as flow-style nodes
// with double-quoted scalars; carrying that style through would emit JSON-looking blocks
// into a hand-readable YAML spec. Clearing it lets the encoder pick block style and plain
// scalars, and quote only where a value would otherwise change type.
//
// Multi-line strings are the one case worth steering: the descriptions in these specs are
// the integrator-facing documentation, and a literal block keeps them legible instead of
// one long line of \n escapes.
func shallowCopy(n *yaml.Node) *yaml.Node {
	c := *n
	c.Content = nil
	c.Style = 0
	if c.Kind == yaml.ScalarNode && c.Tag == "!!str" && strings.Contains(c.Value, "\n") {
		c.Value = dedent(c.Value)
		c.Style = yaml.LiteralStyle
	}
	return &c
}

// dedent removes indentation that a multi-line string carries from the document it was
// written in. Leading spaces inside a description are part of its value, so a description
// authored as an indented YAML block keeps them; re-homed into a spec they turn a bullet
// list into an indented block, which renderers show as preformatted code. The published
// documentation then reads as a code sample rather than the list it is.
//
// Declarations hold their descriptions as JSON strings, where such indentation is easy to
// introduce and invisible until it is rendered, so it is normalised on the way through.
//
// The first line is left alone: in a block scalar it carries no indentation to begin with.
func dedent(v string) string {
	lines := strings.Split(v, "\n")
	if len(lines) < 2 {
		return v
	}
	common := -1
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "" {
			continue
		}
		n := len(line) - len(strings.TrimLeft(line, " "))
		if common == -1 || n < common {
			common = n
		}
	}
	if common <= 0 {
		return strings.Join(rstripAll(lines), "\n")
	}
	for i, line := range lines[1:] {
		if len(line) >= common {
			lines[i+1] = line[common:]
		} else {
			lines[i+1] = strings.TrimLeft(line, " ")
		}
	}
	return strings.Join(rstripAll(lines), "\n")
}

// rstripAll trims trailing whitespace from every line. A line ending in a space cannot be
// written as a YAML literal block, so the emitter falls back to a double-quoted scalar with
// escaped newlines: it renders the same and reads far worse in a published contract.
func rstripAll(lines []string) []string {
	for i, line := range lines {
		lines[i] = strings.TrimRight(line, " \t")
	}
	return lines
}

func scalar(v string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: v}
}

func boolScalar(v bool) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!bool", Value: fmt.Sprintf("%t", v)}
}

// Err returns the constructs that could not be converted, or nil.
func (c *converter) Err() error {
	if len(c.errs) == 0 {
		return nil
	}
	return fmt.Errorf("%d schema construct(s) cannot be represented in OpenAPI 3.0.3:\n    %s",
		len(c.errs), strings.Join(c.errs, "\n    "))
}

// CheckDrops compares what was actually dropped against what the manifest declared. It
// reports in both directions: an undeclared drop means the contract quietly stopped
// enforcing something, and a declared drop that no longer happens means the manifest is
// stale and would hide the next real one.
func (c *converter) CheckDrops(expected []string) error {
	want := map[string]bool{}
	for _, e := range expected {
		want[e] = true
	}
	got := map[string]bool{}
	var undeclared []string
	for _, d := range c.sortedDrops() {
		got[d.String()] = true
		if !want[d.String()] {
			undeclared = append(undeclared, d.String())
		}
	}
	var stale []string
	for _, e := range expected {
		if !got[e] {
			stale = append(stale, e)
		}
	}
	if len(undeclared) == 0 && len(stale) == 0 {
		return nil
	}
	var b strings.Builder
	if len(undeclared) > 0 {
		b.WriteString(fmt.Sprintf("%d validation keyword(s) were dropped that the manifest does not declare:\n", len(undeclared)))
		for _, u := range undeclared {
			b.WriteString("    " + u + "\n")
		}
		b.WriteString("  The generated contract now validates less than its source does. Either keep the\n")
		b.WriteString("  constraint expressible, or add the entry under 'expected_drops' in the manifest.\n")
	}
	if len(stale) > 0 {
		b.WriteString(fmt.Sprintf("%d entry in 'expected_drops' no longer happens:\n", len(stale)))
		for _, s := range stale {
			b.WriteString("    " + s + "\n")
		}
		b.WriteString("  Remove it, or it will hide the next real drop.\n")
	}
	return fmt.Errorf("%s", strings.TrimRight(b.String(), "\n"))
}

// sortedDrops returns the recorded drops in a stable order for reporting.
func (c *converter) sortedDrops() []Drop {
	out := append([]Drop(nil), c.drops...)
	sort.Slice(out, func(i, j int) bool { return out[i].String() < out[j].String() })
	return out
}
