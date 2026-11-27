package main

import (
	"bytes"
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// componentIndent is the column components.schemas entries sit at in these specs:
// two for `components:`, two more for `schemas:`.
const componentIndent = 4

// spliceComponent replaces one component block in an OpenAPI document, leaving every
// other byte of the file untouched.
//
// The replacement is textual rather than a parse-and-re-emit of the whole document, for
// two reasons. Re-emitting would reformat all 2500 lines -- every quote style, every
// folded description -- burying the real change in noise and colliding with anything
// else in flight. And key order in components.schemas is load-bearing: the TypeScript
// SDK names anonymous enum types after the order it meets them (status2, status3, ...),
// so a pass that reordered schemas would silently change exported type names.
func spliceComponent(spec []byte, name string, body *yaml.Node) ([]byte, error) {
	lines := strings.Split(string(spec), "\n")
	lo, hi, err := schemasSection(lines)
	if err != nil {
		return nil, err
	}
	start, end, err := componentBlock(lines, lo, hi, name)
	if err != nil {
		return nil, err
	}

	rendered, err := renderComponent(name, body)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}

	// Preserve the blank lines that separated this block from the next one, so the
	// file's existing spacing survives a regeneration.
	trailing := 0
	for i := end - 1; i > start && strings.TrimSpace(lines[i]) == ""; i-- {
		trailing++
	}

	out := make([]string, 0, len(lines))
	out = append(out, lines[:start]...)
	out = append(out, rendered...)
	for i := 0; i < trailing; i++ {
		out = append(out, "")
	}
	out = append(out, lines[end:]...)
	return []byte(strings.Join(out, "\n")), nil
}

// schemasSection returns the half-open line range covering the body of
// components.schemas. Searching the whole file for a component name would be ambiguous:
// `paths:` nests HTTP methods at the same indent, so a component named `get` or `post`
// would match there too.
func schemasSection(lines []string) (lo, hi int, err error) {
	components := -1
	for i, line := range lines {
		if line == "components:" {
			components = i
			break
		}
	}
	if components == -1 {
		return 0, 0, fmt.Errorf("the spec has no top-level components section")
	}
	schemas := -1
	for i := components + 1; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			continue
		}
		if indentOf(line) == 0 {
			break // left components entirely
		}
		if line == "  schemas:" {
			schemas = i
			break
		}
	}
	if schemas == -1 {
		return 0, 0, fmt.Errorf("the spec has no components.schemas section")
	}
	for i := schemas + 1; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			continue
		}
		if indentOf(line) <= 2 {
			return schemas + 1, i, nil
		}
	}
	return schemas + 1, len(lines), nil
}

// componentBlock locates `    <name>:` within the schemas section and the line after its
// last line. The block runs until the next line that is non-blank and no more deeply
// indented, which is the next sibling component or the end of the section.
func componentBlock(lines []string, lo, hi int, name string) (start, end int, err error) {
	prefix := strings.Repeat(" ", componentIndent) + name + ":"
	start = -1
	for i := lo; i < hi; i++ {
		line := lines[i]
		if line == prefix || strings.HasPrefix(line, prefix+" ") {
			if start != -1 {
				return 0, 0, fmt.Errorf("%q appears twice at the component level", name)
			}
			start = i
		}
	}
	if start == -1 {
		return 0, 0, fmt.Errorf("no component named %q in components.schemas", name)
	}
	for i := start + 1; i < hi; i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			continue
		}
		if indentOf(line) <= componentIndent {
			return start, i, nil
		}
	}
	return start, hi, nil
}

func indentOf(line string) int {
	return len(line) - len(strings.TrimLeft(line, " "))
}

// renderComponent emits `    <name>:` followed by the body, indented to match.
func renderComponent(name string, body *yaml.Node) ([]string, error) {
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(body); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}

	out := []string{strings.Repeat(" ", componentIndent) + name + ":"}
	pad := strings.Repeat(" ", componentIndent+2)
	for _, line := range strings.Split(strings.TrimRight(buf.String(), "\n"), "\n") {
		if line == "" {
			out = append(out, "")
			continue
		}
		out = append(out, pad+line)
	}
	return out, nil
}
