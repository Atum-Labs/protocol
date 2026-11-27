package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// renderJSON writes a node tree as indented JSON, preserving key order.
//
// encoding/json cannot be used directly for this: unmarshalling an object into a Go map
// loses the order its keys were written in, and these documents are read by people as well
// as by generators. Walking the node tree keeps the order the source file had, which keeps
// a regenerated block diffable against the one it replaces.
//
// Individual scalars still go through encoding/json so that escaping -- quotes, newlines,
// non-ASCII -- is exactly what a JSON reader expects rather than something hand-rolled.
func renderJSON(n *yaml.Node, indent int) (string, error) {
	var b strings.Builder
	if err := writeJSONNode(&b, n, indent); err != nil {
		return "", err
	}
	return b.String(), nil
}

func writeJSONNode(b *strings.Builder, n *yaml.Node, indent int) error {
	pad := strings.Repeat(" ", indent)
	inner := strings.Repeat(" ", indent+2)

	switch n.Kind {
	case yaml.DocumentNode:
		if len(n.Content) == 0 {
			return fmt.Errorf("empty document")
		}
		return writeJSONNode(b, n.Content[0], indent)

	case yaml.MappingNode:
		if len(n.Content) == 0 {
			b.WriteString("{}")
			return nil
		}
		b.WriteString("{\n")
		for i := 0; i+1 < len(n.Content); i += 2 {
			key, err := jsonScalar(n.Content[i])
			if err != nil {
				return err
			}
			b.WriteString(inner)
			b.WriteString(key)
			b.WriteString(": ")
			if err := writeJSONNode(b, n.Content[i+1], indent+2); err != nil {
				return err
			}
			if i+2 < len(n.Content)-1 {
				b.WriteString(",")
			}
			b.WriteString("\n")
		}
		b.WriteString(pad)
		b.WriteString("}")
		return nil

	case yaml.SequenceNode:
		if len(n.Content) == 0 {
			b.WriteString("[]")
			return nil
		}
		b.WriteString("[\n")
		for i, item := range n.Content {
			b.WriteString(inner)
			if err := writeJSONNode(b, item, indent+2); err != nil {
				return err
			}
			if i < len(n.Content)-1 {
				b.WriteString(",")
			}
			b.WriteString("\n")
		}
		b.WriteString(pad)
		b.WriteString("]")
		return nil

	case yaml.ScalarNode:
		s, err := jsonScalar(n)
		if err != nil {
			return err
		}
		b.WriteString(s)
		return nil

	case yaml.AliasNode:
		// These documents are JSON, which has no anchors, so an alias means the input was
		// not what this tool expects. Failing is better than silently expanding it.
		return fmt.Errorf("YAML aliases cannot be represented in JSON")
	}
	return fmt.Errorf("unsupported node kind %v", n.Kind)
}

// jsonScalar renders one scalar with the type its YAML tag gives it. A JSON document read
// through yaml.v3 carries accurate tags, so a string that looks like a number stays a
// string and a genuine number is not quoted back into one.
func jsonScalar(n *yaml.Node) (string, error) {
	switch n.Tag {
	case "!!null":
		return "null", nil
	case "!!bool":
		v, err := strconv.ParseBool(n.Value)
		if err != nil {
			return "", fmt.Errorf("value %q is tagged bool but does not parse", n.Value)
		}
		return strconv.FormatBool(v), nil
	case "!!int", "!!float":
		// Emitted verbatim so a number keeps the form it was written in rather than being
		// re-rendered through a float and gaining or losing digits.
		return n.Value, nil
	default:
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(n.Value); err != nil {
			return "", err
		}
		return strings.TrimRight(buf.String(), "\n"), nil
	}
}
