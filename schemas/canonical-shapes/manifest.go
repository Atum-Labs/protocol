package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Manifest binds components in one OpenAPI spec to the canonical declarations they are
// generated from. It lives beside the spec it describes so the binding is visible to
// anyone reading that directory, rather than buried in a build script.
type Manifest struct {
	// Target is the file whose shapes are generated, relative to the manifest. An OpenAPI
	// spec (.yaml) has them under components.schemas; a declaration (.json) under $defs.
	Target string `yaml:"target"`
	// Source is the canonical declaration, relative to the manifest.
	Source string `yaml:"source"`
	// Shapes are the components to generate, in no particular order.
	Shapes []Shape `yaml:"shapes"`
	// ExpectedDrops lists validation keywords that the target's dialect cannot express,
	// in "<path>.<keyword>" form. A drop means the generated contract validates less than
	// the source does, so each one is listed here deliberately and a new one fails the
	// build rather than being printed and scrolled past.
	ExpectedDrops []string `yaml:"expected_drops"`

	dir string // directory the manifest was loaded from, for resolving relative paths
}

// Shape is one generated component.
type Shape struct {
	// Name is the component name as components.schemas spells it.
	Name string `yaml:"name"`
	// From is a JSON pointer into the canonical document: "$defs/SignedMessage", or "."
	// for the declaration root.
	From string `yaml:"from"`
	// Remove deletes nodes by dotted path: "properties.presentation" drops a property,
	// "properties.fulfillment_amount.pattern" drops one constraint from one property.
	Remove []string `yaml:"remove"`
	// Overlay is deep-merged onto the converted shape. It carries the differences this
	// API keeps on purpose: integrator examples, ingress constraints, and any field the
	// endpoint requires that the declaration leaves optional.
	//
	// A value rather than a pointer: yaml.v3 fills a yaml.Node field in place but only
	// allocates a *yaml.Node, leaving it zeroed, which reads as "no overlay" and silently
	// drops everything written here. HasOverlay reports whether one was given.
	Overlay yaml.Node `yaml:"overlay"`
	// Reason explains, for a reader of this manifest, why Remove and Overlay are here.
	// Required whenever either is set, so a divergence cannot be added without saying why.
	Reason string `yaml:"reason"`
}

func LoadManifest(path string) (*Manifest, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := yaml.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if m.Target == "" {
		return nil, fmt.Errorf("%s: 'target' is required", path)
	}
	if ext := filepath.Ext(m.Target); ext != ".yaml" && ext != ".json" {
		return nil, fmt.Errorf("%s: target %q must be an OpenAPI .yaml or a declaration .json", path, m.Target)
	}
	if m.Source == "" {
		return nil, fmt.Errorf("%s: 'source' is required", path)
	}
	if len(m.Shapes) == 0 {
		return nil, fmt.Errorf("%s: no shapes listed, so this manifest would generate nothing", path)
	}
	seen := map[string]bool{}
	for _, s := range m.Shapes {
		if s.Name == "" || s.From == "" {
			return nil, fmt.Errorf("%s: every shape needs both 'name' and 'from'", path)
		}
		if seen[s.Name] {
			return nil, fmt.Errorf("%s: %q is listed twice", path, s.Name)
		}
		seen[s.Name] = true
		if (len(s.Remove) > 0 || s.HasOverlay()) && s.Reason == "" {
			return nil, fmt.Errorf("%s: %s diverges from canonical but gives no 'reason'; "+
				"a deliberate difference has to say why it is deliberate", path, s.Name)
		}
	}
	m.dir = filepath.Dir(path)
	return &m, nil
}

// HasOverlay reports whether the manifest gave an overlay for this shape.
func (s Shape) HasOverlay() bool { return s.Overlay.Kind != 0 }

func (m *Manifest) TargetPath() string { return filepath.Join(m.dir, m.Target) }

// TargetIsDeclaration reports whether shapes go into a declaration's $defs rather than an
// OpenAPI spec's components.schemas.
func (m *Manifest) TargetIsDeclaration() bool { return filepath.Ext(m.Target) == ".json" }

func (m *Manifest) SourcePath() string { return filepath.Join(m.dir, m.Source) }

// resolve follows a manifest 'from' pointer into the canonical document. It deliberately
// supports only "." and "$defs/<name>": those are the two shapes canonical actually
// takes, and accepting arbitrary pointers would invite references into parts of a
// declaration that are not self-contained.
func resolve(doc *yaml.Node, from string) (*yaml.Node, error) {
	root := doc
	if root.Kind == yaml.DocumentNode {
		if len(root.Content) == 0 {
			return nil, fmt.Errorf("empty document")
		}
		root = root.Content[0]
	}
	if from == "." {
		return root, nil
	}
	name, ok := strings.CutPrefix(from, "$defs/")
	if !ok {
		return nil, fmt.Errorf("unsupported pointer %q: expected \".\" or \"$defs/<name>\"", from)
	}
	defs := mappingValue(root, "$defs")
	if defs == nil {
		return nil, fmt.Errorf("the canonical document has no $defs")
	}
	node := mappingValue(defs, name)
	if node == nil {
		return nil, fmt.Errorf("the canonical document has no $defs/%s", name)
	}
	return node, nil
}

// mappingValue returns the value node for key, or nil.
func mappingValue(n *yaml.Node, key string) *yaml.Node {
	if n == nil || n.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(n.Content); i += 2 {
		if n.Content[i].Value == key {
			return n.Content[i+1]
		}
	}
	return nil
}
