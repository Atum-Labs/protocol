package main

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// defsIndent is the column entries of a declaration's "$defs" object sit at: two for
// "$defs" itself, two more for its members.
const defsIndent = 4

// spliceDef replaces one entry of a declaration's "$defs" object, leaving every other byte
// of the file alone.
//
// Textual for the same reason the OpenAPI side is: these files are hand-formatted, with
// short arrays kept on one line in some places and expanded in others, and re-emitting a
// whole document would reformat all of it and bury the change. Replacing one entry keeps
// the diff to the entry that changed.
func spliceDef(doc []byte, name string, body *yaml.Node) ([]byte, error) {
	lines := strings.Split(string(doc), "\n")
	lo, hi, err := defsSection(lines)
	if err != nil {
		return nil, err
	}
	start, end, err := defEntry(lines, lo, hi, name)
	if err != nil {
		return nil, err
	}

	rendered, err := renderJSON(body, defsIndent)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	// A member that is not the last one in the object keeps its separating comma.
	trailing := ""
	if strings.HasSuffix(strings.TrimSpace(lines[end]), ",") {
		trailing = ","
	}

	replacement := strings.Split(
		strings.Repeat(" ", defsIndent)+jsonKey(name)+": "+rendered+trailing, "\n")

	out := make([]string, 0, len(lines))
	out = append(out, lines[:start]...)
	out = append(out, replacement...)
	out = append(out, lines[end+1:]...)
	return []byte(strings.Join(out, "\n")), nil
}

// defsSection returns the half-open line range covering the members of "$defs". Scoping the
// search matters because a declaration's own properties can carry the same names as the
// shapes in "$defs".
func defsSection(lines []string) (lo, hi int, err error) {
	open := -1
	for i, line := range lines {
		if strings.TrimRight(line, " ") == `  "$defs": {` {
			open = i
			break
		}
	}
	if open == -1 {
		return 0, 0, fmt.Errorf(`the declaration has no "$defs" object`)
	}
	for i := open + 1; i < len(lines); i++ {
		if indentOf(lines[i]) <= 2 && strings.TrimSpace(lines[i]) != "" {
			return open + 1, i, nil
		}
	}
	return open + 1, len(lines), nil
}

// defEntry returns the first and last line of one "$defs" member. The member ends at the
// closing brace sitting at the member's own indent.
func defEntry(lines []string, lo, hi int, name string) (start, end int, err error) {
	prefix := strings.Repeat(" ", defsIndent) + jsonKey(name) + ":"
	start = -1
	for i := lo; i < hi; i++ {
		if strings.HasPrefix(lines[i], prefix) {
			if start != -1 {
				return 0, 0, fmt.Errorf("%q appears twice in $defs", name)
			}
			start = i
		}
	}
	if start == -1 {
		return 0, 0, fmt.Errorf("no $defs entry named %q", name)
	}
	for i := start + 1; i < hi; i++ {
		trimmed := strings.TrimSpace(lines[i])
		if indentOf(lines[i]) == defsIndent && (trimmed == "}" || trimmed == "},") {
			return start, i, nil
		}
	}
	return 0, 0, fmt.Errorf("could not find where the $defs entry %q ends", name)
}

func jsonKey(name string) string { return `"` + name + `"` }
