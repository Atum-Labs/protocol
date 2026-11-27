// Command gen-chains writes chains/*.json from versions.json and the deployments files it cites.
// Run it from contracts/registry: go run ./cmd/gen-chains
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"testing/fstest"

	"github.com/atum-labs/protocol/contracts/registry"
	"github.com/atum-labs/protocol/contracts/registry/internal/chaingen"
)

func main() {
	root := flag.String("root", "../..", "repository root the deployments sources are relative to")
	specPath := flag.String("spec", "versions.json", "the versions spec")
	outDir := flag.String("out", "chains", "directory the chain files are written to")
	flag.Parse()
	if err := run(*root, *specPath, *outDir); err != nil {
		fmt.Fprintln(os.Stderr, "gen-chains:", err)
		os.Exit(1)
	}
}

func run(root, specPath, outDir string) error {
	raw, err := os.ReadFile(specPath)
	if err != nil {
		return err
	}
	spec, err := chaingen.ParseSpec(raw)
	if err != nil {
		return err
	}
	files, err := chaingen.Build(os.DirFS(root), spec)
	if err != nil {
		return err
	}
	// Validate before writing, so a bad spec leaves the committed files as they were.
	check := fstest.MapFS{}
	for name, b := range files {
		check["chains/"+name] = &fstest.MapFile{Data: b}
	}
	if _, err := registry.LoadFS(check); err != nil {
		return err
	}
	old, err := filepath.Glob(filepath.Join(outDir, "*.json"))
	if err != nil {
		return err
	}
	for _, p := range old {
		if _, keep := files[filepath.Base(p)]; !keep {
			if err := os.Remove(p); err != nil {
				return err
			}
		}
	}
	for name, b := range files {
		if err := os.WriteFile(filepath.Join(outDir, name), b, 0o644); err != nil {
			return err
		}
	}
	return nil
}
