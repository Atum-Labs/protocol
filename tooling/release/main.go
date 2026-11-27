// Command release plans and cuts the Go module tags for this repository.
//
// A module in a subdirectory is published by a tag prefixed with its directory:
// schemas/declarations/PaymentRequest/v1/bindings/go/v0.1.0. There is no registry; the tag
// is the publication. So a release is a set of tags, and the job here is working out which
// ones -- tagging every module on every release would churn versions for consumers who
// import one package and never see the rest.
//
// Two things make that more than a diff:
//
//   - A module's directory contains its nested modules. A change under bindings/go/signing/
//     is not a change to bindings/go/, so nested module directories are excluded.
//   - Intra-repo dependencies propagate. If a leaf changes, every module that requires it
//     needs a new version too, or consumers resolve the dependent at a version whose go.mod
//     still names the old leaf. That is a silently stale graph, so dependents are pulled in
//     transitively.
//
// A release is two steps, because every change to main here is squash-merged:
//
//	release plan      # what would be tagged, and why. Writes nothing.
//	release prepare   # rewrite intra-repo requires and commit them, for a normal PR
//	release tag       # on main after that PR merges: tag, verify, print the push command
//
// Tagging happens on main, not on the prepare branch. Tags created before the merge would
// point at the pre-squash commit, outside main's history: review fixes pushed afterwards would
// diverge from what was tagged, and a PR that never merged would leave published tags for code
// main never received.
//
// Every module is tagged at the one commit that already names the sibling versions. That is
// sound because a require only needs its version to exist when a consumer RESOLVES it: the
// consumer lands on the commit, reads a go.mod naming the sibling version, and that sibling's
// tag points at the same commit.
package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/mod/modfile"
	"golang.org/x/mod/semver"
)

type module struct {
	dir     string   // repo-relative directory
	path    string   // go module path
	deps    []string // dirs of intra-repo modules it requires
	nested  []string // dirs of modules underneath it, excluded from its own diff
	current string   // highest existing tag version, empty if never tagged
	next    string   // version to publish, empty if not being tagged
	reason  string
}

func main() {
	log := flag.NewFlagSet("release", flag.ExitOnError)
	initial := log.String("initial", "v0.1.0", "version for modules that have never been tagged")
	bump := log.String("bump", "patch", "bump for modules that have: patch or minor")
	_ = log.Parse(os.Args[min(len(os.Args), 2):])

	cmd := ""
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	if cmd != "plan" && cmd != "prepare" && cmd != "tag" {
		fmt.Fprintln(os.Stderr, "usage: release (plan|prepare|tag) [-initial v0.1.0] [-bump patch|minor]")
		os.Exit(2)
	}
	// Anything unrecognised would otherwise fall through to a patch bump in bumpVersion, so
	// `-bump major` would silently publish patch versions.
	if *bump != "patch" && *bump != "minor" {
		fmt.Fprintf(os.Stderr, "unknown -bump %q: want patch or minor\n", *bump)
		os.Exit(2)
	}

	if err := run(cmd, *initial, *bump); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(cmd, initial, bump string) error {
	root, err := gitOutput("rev-parse", "--show-toplevel")
	if err != nil {
		return err
	}
	if err := os.Chdir(root); err != nil {
		return err
	}

	if cmd != "plan" {
		// Up front, before anything is written. Unrelated local edits would otherwise end up in
		// the prepare commit, or on main's tagged commit.
		status, err := gitOutput("status", "--porcelain")
		if err != nil {
			return err
		}
		if strings.TrimSpace(status) != "" {
			return fmt.Errorf("working tree is dirty; commit or stash first:\n%s", status)
		}
	}

	mods, releasing, err := planRelease(root, initial, bump)
	if err != nil {
		return err
	}

	if len(releasing) == 0 {
		fmt.Println("nothing to release")
		return nil
	}

	fmt.Printf("%d of %d modules to release:\n\n", len(releasing), len(mods))
	for _, dir := range releasing {
		m := mods[dir]
		from := m.current
		if from == "" {
			from = "(none)"
		}
		fmt.Printf("  %s\n      %s -> %s   (%s)\n", dir, from, m.next, m.reason)
	}

	edits, touched, err := rewriteRequires(mods, releasing, cmd == "prepare")
	if err != nil {
		return err
	}
	if len(edits) > 0 {
		fmt.Printf("\nrequire lines to update in %d go.mod files:\n", len(edits))
		for _, e := range edits {
			fmt.Printf("  %s\n", e)
		}
	}

	switch cmd {
	case "plan":
		fmt.Println("\nplan only; nothing written.")
		if len(edits) > 0 {
			fmt.Println("Next: `release prepare`, merge that PR, then `release tag` on main.")
		} else {
			fmt.Println("No require changes needed. Next: `release tag` on main.")
		}
		return nil
	case "prepare":
		return commitPrepared(touched)
	default:
		if len(edits) > 0 {
			return errors.New("these requires do not yet name the versions being published; run `release prepare`, merge that PR, then tag from main")
		}
		if err := requireOriginHead(); err != nil {
			return err
		}
		return tagAndVerify(mods, releasing)
	}
}

func commitPrepared(touched []string) error {
	if len(touched) == 0 {
		fmt.Println("\nno go.mod needs changing; nothing to prepare. Run `release tag` on main.")
		return nil
	}
	if err := git(append([]string{"add"}, touched...)...); err != nil {
		return err
	}
	if err := git("commit", "-m", "chore(release): point intra-repo requires at the versions being published"); err != nil {
		return err
	}
	fmt.Printf("\ncommitted %d go.mod updates. Push this branch, open a PR, and after it merges run `release tag` on main.\n", len(touched))
	return nil
}

// requireOriginHead refuses to tag anything but the tip of origin's default branch, which is
// the only commit guaranteed to be in main's history after a squash merge.
func requireOriginHead() error {
	out, err := gitOutput("ls-remote", "origin", "HEAD")
	if err != nil {
		return err
	}
	remote, _, _ := strings.Cut(out, "\t")
	local, err := gitOutput("rev-parse", "HEAD")
	if err != nil {
		return err
	}
	if remote == "" || local != remote {
		return fmt.Errorf("HEAD is %.8s but origin's default branch is at %.8s; tag only a checkout of origin's tip", local, remote)
	}
	return nil
}

// verifyScript is the same check the standalone-modules lane runs. Here it runs against the
// local tags, so it resolves exactly the modules that are about to be pushed.
const verifyScript = "tooling/verify-standalone-modules.sh"

func tagAndVerify(mods map[string]*module, releasing []string) error {
	var names []string
	for _, dir := range releasing {
		t := mods[dir].next
		if dir != "." {
			t = dir + "/" + mods[dir].next
		}
		names = append(names, t)
	}

	fmt.Println("\ncreating tags")
	var created []string
	for _, tag := range names {
		// Every planned version is newer than anything on origin, so a local tag of the same name
		// can only be left over from an interrupted run. It was never checked or pushed.
		if git("rev-parse", "--verify", "--quiet", "refs/tags/"+tag) == nil {
			if err := git("tag", "-d", tag); err != nil {
				deleteTags(created)
				return fmt.Errorf("remove leftover tag %s: %w", tag, err)
			}
			fmt.Println("  (replacing unpublished leftover " + tag + ")")
		}
		// -m so the tag is annotated: the repo verifies signatures, and a bare `git tag` fails
		// outright under tag.gpgSign rather than falling back to a lightweight ref.
		if err := git("tag", "-m", "release "+tag, tag); err != nil {
			deleteTags(created)
			return fmt.Errorf("tag %s: %w", tag, err)
		}
		created = append(created, tag)
		fmt.Println("  " + tag)
	}

	// A green lane on main vouches for main, not for these tags. Resolving the modules against
	// the tags themselves is the only check on what is actually about to be published.
	fmt.Println("\nverifying the tagged modules resolve as a consumer would")
	c := exec.Command("./" + verifyScript)
	// VERIFY_AS_TAGGED: resolve siblings at the versions the go.mod files name, which are the tags
	// just created, rather than at HEAD as the lane does.
	c.Env = append(os.Environ(), "VERIFY_AS_TAGGED=1")
	c.Stdout, c.Stderr = os.Stdout, os.Stderr
	if err := c.Run(); err != nil {
		deleteTags(created)
		return fmt.Errorf("standalone check failed (%v); the local tags were removed and nothing was pushed", err)
	}

	// Naming each tag rather than --tags, which would also push any unrelated local tag.
	fmt.Printf("\n%d tags created and verified. Push exactly these:\n", len(names))
	fmt.Println("  git push origin " + strings.Join(names, " "))
	return nil
}

func deleteTags(tags []string) {
	for _, t := range tags {
		_ = git("tag", "-d", t)
	}
}

// planRelease decides which modules to release and at what version. It reads origin's tags
// and the local history but writes nothing, so it is the whole of `plan` and the first half
// of `tag`.
func planRelease(root, initial, bump string) (map[string]*module, []string, error) {
	remote, err := remoteTags()
	if err != nil {
		return nil, nil, err
	}

	mods, err := discover(root, remote)
	if err != nil {
		return nil, nil, err
	}
	// A version taken from origin has to be locally resolvable too, because the change
	// detection below diffs against it. Say so once, instead of surfacing a bad-revision error
	// from git for whichever module happens to be visited first.
	var missing []string
	for dir, m := range mods {
		if m.current == "" {
			continue
		}
		tag := m.current
		if dir != "." {
			tag = dir + "/" + m.current
		}
		if err := git("rev-parse", "--verify", "--quiet", tag+"^{commit}"); err != nil {
			missing = append(missing, tag)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, nil, fmt.Errorf("origin publishes %d tag(s) this clone does not have, starting with %s\n  run: git fetch --tags", len(missing), missing[0])
	}

	order, err := topo(mods)
	if err != nil {
		return nil, nil, err
	}

	// A module is released if its own files changed, or if anything it depends on is being
	// released. Walking in topological order means a dependency's decision is always made
	// before the modules that rely on it.
	for _, dir := range order {
		m := mods[dir]
		changed, err := m.changedSinceTag()
		if err != nil {
			return nil, nil, err
		}
		switch {
		case m.current == "":
			m.next, m.reason = initial, "never tagged"
		case changed:
			m.next, m.reason = bumpVersion(m.current, bump), "files changed since "+m.current
		default:
			var via []string
			for _, d := range m.deps {
				if mods[d].next != "" {
					via = append(via, d)
				}
			}
			if len(via) > 0 {
				m.next = bumpVersion(m.current, bump)
				m.reason = "depends on " + strings.Join(via, ", ")
			}
		}
	}

	var releasing []string
	for _, dir := range order {
		if mods[dir].next != "" {
			releasing = append(releasing, dir)
		}
	}

	return mods, releasing, nil
}

// discover walks the repo for go.mod files and builds the intra-repo graph.
func discover(root string, remote map[string]bool) (map[string]*module, error) {
	mods := map[string]*module{}
	byPath := map[string]string{}

	err := filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() && (info.Name() == "node_modules" || info.Name() == ".git") {
			return filepath.SkipDir
		}
		if info.IsDir() || info.Name() != "go.mod" {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		f, err := modfile.Parse(p, b, nil)
		if err != nil {
			return fmt.Errorf("parse %s: %w", p, err)
		}
		dir, err := filepath.Rel(root, filepath.Dir(p))
		if err != nil {
			return err
		}
		dir = filepath.ToSlash(dir)
		// tooling/ is how we build the repo, not part of what it publishes. Tagging it would
		// put an internal command in front of integrators and churn its version alongside the
		// bindings they actually import.
		if dir == "tooling" || strings.HasPrefix(dir, "tooling/") {
			return nil
		}
		mods[dir] = &module{dir: dir, path: f.Module.Mod.Path}
		byPath[f.Module.Mod.Path] = dir
		return nil
	})
	if err != nil {
		return nil, err
	}

	for dir, m := range mods {
		b, err := os.ReadFile(filepath.Join(dir, "go.mod"))
		if err != nil {
			return nil, err
		}
		f, err := modfile.Parse("go.mod", b, nil)
		if err != nil {
			return nil, err
		}
		// Requires only. A replace is deliberately ignored: Go ignores replace directives in
		// a dependency's go.mod, so they say nothing about what a consumer will resolve.
		for _, r := range f.Require {
			if d, ok := byPath[r.Mod.Path]; ok && d != dir {
				m.deps = append(m.deps, d)
			}
		}
		sort.Strings(m.deps)

		for other := range mods {
			if other != dir && strings.HasPrefix(other, dir+"/") {
				m.nested = append(m.nested, other)
			}
		}
		sort.Strings(m.nested)

		if m.current, err = latestTag(dir, remote); err != nil {
			return nil, err
		}
	}
	return mods, nil
}

// topo returns module dirs in dependency order, dependencies first.
func topo(mods map[string]*module) ([]string, error) {
	var order []string
	state := map[string]int{} // 0 unvisited, 1 in progress, 2 done
	var visit func(string, []string) error
	visit = func(dir string, stack []string) error {
		switch state[dir] {
		case 2:
			return nil
		case 1:
			return fmt.Errorf("dependency cycle: %s -> %s", strings.Join(stack, " -> "), dir)
		}
		state[dir] = 1
		for _, d := range mods[dir].deps {
			if err := visit(d, append(stack, dir)); err != nil {
				return err
			}
		}
		state[dir] = 2
		order = append(order, dir)
		return nil
	}
	dirs := make([]string, 0, len(mods))
	for dir := range mods {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)
	for _, dir := range dirs {
		if err := visit(dir, nil); err != nil {
			return nil, err
		}
	}
	return order, nil
}

// remoteTags lists every tag on origin. Version decisions cannot be made from the local
// clone alone: a clone that has never fetched tags would compute a version that already
// exists on origin, and dependents would then be rewritten to require a version that, on
// origin, points at a different commit. `git push --tags` rejects only the colliding tag
// and pushes the rest, so the repo would be left publishing a lie.
func remoteTags() (map[string]bool, error) {
	out, err := gitOutput("ls-remote", "--tags", "origin")
	if err != nil {
		return nil, fmt.Errorf("listing tags on origin (a release cannot be planned offline): %w", err)
	}
	tags := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		_, ref, ok := strings.Cut(line, "refs/tags/")
		if !ok {
			continue
		}
		tags[strings.TrimSuffix(ref, "^{}")] = true
	}
	return tags, nil
}

// latestTag returns the highest semver tag published for this module, or "".
//
// Published means on origin. Local tags are deliberately ignored: `tag` creates its tags
// before the slow verification, so an interrupted run -- Ctrl+C, a crash, a closed laptop --
// leaves unchecked, unpushed tags behind. Counting those would make the next run report
// "nothing to release" for modules that were never checked or published.
func latestTag(dir string, remote map[string]bool) (string, error) {
	prefix := "v"
	if dir != "." {
		prefix = dir + "/v"
	}
	var seen []string
	for t := range remote {
		if strings.HasPrefix(t, prefix) {
			seen = append(seen, t)
		}
	}
	best := ""
	for _, line := range seen {
		if line == "" {
			continue
		}
		v := strings.TrimPrefix(line, strings.TrimSuffix(prefix, "v"))
		// Also what rejects a nested module's tag sharing this prefix: a module at p/v2 is tagged
		// p/v2/v2.0.0, which the p/v* glob matches as "v2/v2.0.0" -- not valid semver.
		if !semver.IsValid(v) {
			continue
		}
		if best == "" || semver.Compare(v, best) > 0 {
			best = v
		}
	}
	return best, nil
}

// changedSinceTag reports whether the module's own files changed since its last tag,
// ignoring anything belonging to a module nested inside it.
func (m *module) changedSinceTag() (bool, error) {
	if m.current == "" {
		return true, nil
	}
	tag := m.current
	if m.dir != "." {
		tag = m.dir + "/" + m.current
	}
	args := []string{"diff", "--name-only", tag + "..HEAD", "--", m.dir}
	for _, n := range m.nested {
		args = append(args, ":(exclude)"+n+"/**")
	}
	out, err := gitOutput(args...)
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(out) != "", nil
}

// rewriteRequires points every intra-repo require at the version its dependency is being
// published as. Without this a dependent ships a go.mod naming the previous version.
func rewriteRequires(mods map[string]*module, releasing []string, write bool) (edits, touched []string, err error) {
	for _, dir := range releasing {
		m := mods[dir]
		if len(m.deps) == 0 {
			continue
		}
		p := filepath.Join(dir, "go.mod")
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, nil, err
		}
		f, err := modfile.Parse(p, b, nil)
		if err != nil {
			return nil, nil, err
		}
		dirty := false
		for _, d := range m.deps {
			dep := mods[d]
			want := dep.next
			if want == "" {
				want = dep.current
			}
			if want == "" {
				return nil, nil, fmt.Errorf("%s requires %s, which has no version", dir, d)
			}
			for _, r := range f.Require {
				if r.Mod.Path != dep.path || r.Mod.Version == want {
					continue
				}
				// The directory, not path.Base -- almost every module's last path element is
				// "go", so the basename identifies nothing.
				edits = append(edits, fmt.Sprintf("%s\n      requires %s: %s -> %s", p, dep.dir, r.Mod.Version, want))
				if err := f.AddRequire(dep.path, want); err != nil {
					return nil, nil, err
				}
				dirty = true
			}
		}
		if !dirty {
			continue
		}
		touched = append(touched, p)
		if write {
			f.Cleanup()
			out, err := f.Format()
			if err != nil {
				return nil, nil, err
			}
			if err := os.WriteFile(p, out, 0o644); err != nil {
				return nil, nil, err
			}
		}
	}
	return edits, touched, nil
}

func bumpVersion(v, kind string) string {
	maj, minor, patch := 0, 0, 0
	fmt.Sscanf(strings.TrimPrefix(semver.Canonical(v), "v"), "%d.%d.%d", &maj, &minor, &patch)
	if kind == "minor" {
		return fmt.Sprintf("v%d.%d.0", maj, minor+1)
	}
	return fmt.Sprintf("v%d.%d.%d", maj, minor, patch+1)
}

func gitOutput(args ...string) (string, error) {
	var out, errb bytes.Buffer
	c := exec.Command("git", args...)
	c.Stdout, c.Stderr = &out, &errb
	if err := c.Run(); err != nil {
		return "", errors.New("git " + strings.Join(args, " ") + ": " + strings.TrimSpace(errb.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

func git(args ...string) error {
	_, err := gitOutput(args...)
	return err
}
