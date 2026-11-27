package registry

import (
	"fmt"
	"io/fs"
	"os"
	"strings"
)

// LoadWithOverlay loads the embedded registry plus the chain files (*.json) in dir, such as
// overlays/localnet for a local test chain. An overlay file may only add a chain the embedded set
// lacks, and passes the same checks as an embedded one. An empty dir loads the embedded registry.
func LoadWithOverlay(dir string) (*Registry, error) {
	r, err := Load()
	if err != nil || dir == "" {
		return r, err
	}
	if _, err := os.Stat(dir); err != nil {
		return nil, fmt.Errorf("registry overlay: %w", err)
	}
	extra, err := load(overlayFS{os.DirFS(dir)})
	if err != nil {
		return nil, fmt.Errorf("registry overlay %s: %w", dir, err)
	}
	for _, id := range extra.Chains() {
		if embedded, ok := r.Chain(id); ok {
			return nil, fmt.Errorf("registry overlay %s: chain %s is embedded as %s, an overlay may only add chains", dir, id, embedded.Chain)
		}
		r.chains[id] = extra.chains[id]
		r.folded[strings.ToLower(id)] = id
	}
	return r, nil
}

// overlayFS serves the *.json files of a flat directory as chains/<file>, the layout load reads.
type overlayFS struct{ dir fs.FS }

func (o overlayFS) Open(name string) (fs.File, error) {
	if rest, ok := strings.CutPrefix(name, "chains/"); ok {
		return o.dir.Open(rest)
	}
	return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
}

func (o overlayFS) ReadDir(name string) ([]fs.DirEntry, error) {
	if name != "chains" {
		return nil, &fs.PathError{Op: "readdir", Path: name, Err: fs.ErrNotExist}
	}
	entries, err := fs.ReadDir(o.dir, ".")
	if err != nil {
		return nil, err
	}
	var out []fs.DirEntry
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			out = append(out, e)
		}
	}
	return out, nil
}
