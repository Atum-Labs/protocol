package main

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// The canonical declaration and the HTTP contract are not the same document, and a few
// differences between them are deliberate rather than drift:
//
//   - the declaration describes a signed object that also carries its JSON-LD envelope;
//     the API serves a subset and has no business publishing those fields
//   - the API requires a field the declaration leaves optional, because the endpoint that
//     accepts it always has it by then
//   - the API documents itself for integrators, with examples and ingress-validation
//     notes that the declaration has no reason to carry
//
// Those are expressed here, per shape, so each one is a reviewed line in the manifest
// rather than an invisible divergence. Everything not named is taken from canonical.

// applyRemove deletes nodes the API does not serve, addressed by dotted path into the
// converted shape: "properties.presentation" drops a property, and
// "properties.fulfillment_amount.pattern" drops a single constraint from one.
//
// Removing a path that is not there is an error rather than a no-op. A stale entry means
// the declaration has moved on, and the whole point of this file is that a difference
// between the two documents is visible; an entry that quietly does nothing hides one.
//
// Dropping a property also drops it from `required`, since a required property that does
// not exist is not a schema anyone meant to write.
func applyRemove(node *yaml.Node, shape string, paths []string) error {
	for _, path := range paths {
		segments := strings.Split(path, ".")
		parent := node
		for _, seg := range segments[:len(segments)-1] {
			parent = mappingValue(parent, seg)
			if parent == nil {
				return fmt.Errorf("%s: remove lists %q, but %q is not there; "+
					"the declaration no longer matches this manifest", shape, path, seg)
			}
		}
		leaf := segments[len(segments)-1]
		if mappingValue(parent, leaf) == nil {
			return fmt.Errorf("%s: remove lists %q, which the canonical declaration does not define; "+
				"drop the entry or update the manifest", shape, path)
		}
		removeKey(parent, leaf)
		if len(segments) == 2 && segments[0] == "properties" {
			removeFromSequence(mappingValue(node, "required"), leaf)
		}
	}
	return nil
}

// checkOverlayKeys rejects a mapping that lists the same key twice.
//
// yaml.v3 keeps both pairs when it decodes into a yaml.Node, and the merge below then
// applies them in order, so a duplicate appears to work here while every conventional YAML
// reader takes the last one and silently discards the first. An overlay written twice is
// always a mistake, and it is the same class as listing a shape twice, which the manifest
// already refuses.
func checkOverlayKeys(n *yaml.Node, path string) error {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	seen := map[string]bool{}
	for i := 0; i+1 < len(n.Content); i += 2 {
		key := n.Content[i].Value
		where := key
		if path != "" {
			where = path + "." + key
		}
		if seen[key] {
			return fmt.Errorf("overlay lists %q twice; merge the two blocks into one, or a "+
				"reader that takes the last wins will drop the first", where)
		}
		seen[key] = true
		if err := checkOverlayKeys(n.Content[i+1], where); err != nil {
			return err
		}
	}
	return nil
}

// applyOverlay deep-merges a manifest fragment onto the converted shape. Mappings merge
// key by key so an overlay can reach a single property without restating its siblings;
// scalars and sequences replace outright, because a half-replaced `required` list or
// `enum` would be a surprising thing to write.
func applyOverlay(node *yaml.Node, overlay *yaml.Node) error {
	if overlay == nil || overlay.Kind == 0 {
		return nil
	}
	if overlay.Kind != yaml.MappingNode {
		// Silently ignoring this is how an overlay that was written but never applied
		// goes unnoticed, which is exactly the failure this file exists to prevent.
		return fmt.Errorf("overlay must be a mapping, got %v", overlay.Kind)
	}
	if err := checkOverlayKeys(overlay, ""); err != nil {
		return err
	}
	for i := 0; i+1 < len(overlay.Content); i += 2 {
		key, val := overlay.Content[i], unalias(overlay.Content[i+1])
		existing := mappingValue(node, key.Value)
		if existing != nil && existing.Kind == yaml.MappingNode && val.Kind == yaml.MappingNode {
			if err := applyOverlay(existing, val); err != nil {
				return err
			}
			continue
		}
		setKey(node, key.Value, val)
	}
	return nil
}

// unalias returns a copy of n with every alias replaced by what it names and every anchor
// dropped, so a manifest can write a block once, anchor it, and alias it from another shape,
// and the generated spec carries the content, never the YAML reference.
func unalias(n *yaml.Node) *yaml.Node {
	if n == nil {
		return nil
	}
	for n.Kind == yaml.AliasNode && n.Alias != nil {
		n = n.Alias
	}
	c := *n
	c.Anchor = ""
	c.Content = nil
	for _, child := range n.Content {
		c.Content = append(c.Content, unalias(child))
	}
	return &c
}

// setKey replaces the value for key, or appends the pair when the key is new. Appending
// keeps overlay-only keys in a predictable place: at the end of the mapping, in manifest
// order.
func setKey(node *yaml.Node, key string, val *yaml.Node) {
	if node.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key {
			node.Content[i+1] = val
			return
		}
	}
	node.Content = append(node.Content, scalar(key), val)
}

func removeKey(node *yaml.Node, key string) {
	if node == nil || node.Kind != yaml.MappingNode {
		return
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key {
			node.Content = append(node.Content[:i], node.Content[i+2:]...)
			return
		}
	}
}

func removeFromSequence(seq *yaml.Node, value string) {
	if seq == nil || seq.Kind != yaml.SequenceNode {
		return
	}
	for i, item := range seq.Content {
		if item.Value == value {
			seq.Content = append(seq.Content[:i], seq.Content[i+1:]...)
			return
		}
	}
}
