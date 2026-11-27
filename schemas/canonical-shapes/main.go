// Command canonical-shapes regenerates the shared component schemas in an OpenAPI spec
// from the canonical declaration that defines them.
//
// A handful of shapes -- PaymentRequest and the types it is built from -- describe data
// that is cryptographically signed. The definition signing and verification use lives in
// schemas/declarations, and the HTTP contract needs the same shapes for its request and
// response bodies. Holding one shape in two hand-edited places cannot be kept true by
// review alone, so the declaration is the only place these are written and the spec's
// copy is generated from it.
//
// The generated blocks are written back into the spec and committed, exactly like the
// other generated artifacts in this repository, so the spec stays a single
// self-contained file that every downstream generator reads unchanged.
//
// Usage:
//
//	canonical-shapes -manifest schemas/apis/payment-gateway/v1/canonical-shapes.yaml
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

func main() {
	manifestPath := flag.String("manifest", "", "path to a canonical-shapes.yaml manifest")
	flag.Parse()

	if *manifestPath == "" {
		fmt.Fprintln(os.Stderr, "canonical-shapes: -manifest is required")
		flag.Usage()
		os.Exit(2)
	}
	if err := run(*manifestPath); err != nil {
		fmt.Fprintf(os.Stderr, "canonical-shapes: %v\n", err)
		os.Exit(1)
	}
}

// writeFileAtomic replaces a file in one step: write a temporary file beside it, then
// rename over the target. A rename within a directory is atomic, so an interrupted run
// leaves the previous content rather than a half-written one.
//
// These files are read by people and parsed by several downstream generators. A truncated
// spec is worse than an unchanged one: the next generator either fails somewhere confusing
// or, at the wrong moment, emits bindings from a torn document.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename below has succeeded

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func run(manifestPath string) error {
	m, err := LoadManifest(manifestPath)
	if err != nil {
		return err
	}

	sourceRaw, err := os.ReadFile(m.SourcePath())
	if err != nil {
		return err
	}
	// JSON is a subset of YAML, so the canonical .json parses straight into a node tree
	// with its key order intact.
	var source yaml.Node
	if err := yaml.Unmarshal(sourceRaw, &source); err != nil {
		return fmt.Errorf("%s: %w", m.SourcePath(), err)
	}

	target, err := os.ReadFile(m.TargetPath())
	if err != nil {
		return err
	}

	conv := &converter{}
	for _, shape := range m.Shapes {
		node, err := resolve(&source, shape.From)
		if err != nil {
			return fmt.Errorf("%s (from %q): %w", shape.Name, shape.From, err)
		}
		// Either way `body` must be a tree of its own: the remove and overlay passes below
		// edit in place, and `node` still belongs to the source document that every later
		// shape in this run reads from.
		//
		// The dialect conversion exists to move a shape from JSON Schema 2020-12 into the
		// OpenAPI 3.0.3 Schema Object, which cannot express every keyword and drops what it
		// cannot. It also returns a fresh tree, so it serves as the copy on that path. A
		// declaration is already 2020-12, and converting into one would strip validation
		// from a schema that signatures are checked against, so that path copies instead.
		var body *yaml.Node
		if m.TargetIsDeclaration() {
			body = deepCopy(node)
		} else {
			body = conv.convert(node, shape.Name)
		}
		if err := applyRemove(body, shape.Name, shape.Remove); err != nil {
			return err
		}
		if err := applyOverlay(body, &shape.Overlay); err != nil {
			return fmt.Errorf("%s: %w", shape.Name, err)
		}

		if m.TargetIsDeclaration() {
			target, err = spliceDef(target, shape.Name, body)
		} else {
			target, err = spliceComponent(target, shape.Name, body)
		}
		if err != nil {
			return err
		}
	}

	// Fail before writing: a spec that could not be fully converted must not reach disk
	// half-translated.
	if err := conv.Err(); err != nil {
		return err
	}
	if err := conv.CheckDrops(m.ExpectedDrops); err != nil {
		return err
	}

	if err := writeFileAtomic(m.TargetPath(), target); err != nil {
		return err
	}

	fmt.Printf("canonical-shapes: generated %d shape(s) in %s from %s\n",
		len(m.Shapes), m.Target, m.Source)

	if drops := conv.sortedDrops(); len(drops) > 0 {
		fmt.Printf("canonical-shapes: %d validation keyword(s) have no OpenAPI 3.0.3 equivalent and were not carried over:\n", len(drops))
		for _, d := range drops {
			fmt.Printf("    %s\n", d)
		}
	}
	return nil
}
