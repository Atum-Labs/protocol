package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/mod/modfile"
)

// fixture is a working clone plus a bare "origin", so the tool sees real git history and a
// real remote. The tool is mostly git behaviour; mocking git would test nothing.
type fixture struct {
	t     *testing.T
	root  string
	clone string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	// Isolate from the developer's git config -- tag.gpgSign in particular makes `git tag` fail.
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "t")
	t.Setenv("GIT_AUTHOR_EMAIL", "t@t")
	t.Setenv("GIT_COMMITTER_NAME", "t")
	t.Setenv("GIT_COMMITTER_EMAIL", "t@t")

	root := t.TempDir()
	origin := filepath.Join(root, "origin.git")
	clone := filepath.Join(root, "work")
	f := &fixture{t: t, root: root, clone: clone}
	f.git(root, "init", "--quiet", "--bare", "-b", "main", origin)
	f.git(root, "init", "--quiet", "-b", "main", clone)
	f.git(clone, "remote", "add", "origin", origin)
	t.Chdir(clone)
	return f
}

func (f *fixture) git(dir string, args ...string) string {
	f.t.Helper()
	c := exec.Command("git", args...)
	c.Dir = dir
	out, err := c.CombinedOutput()
	if err != nil {
		f.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// module writes a go.mod at dir requiring each sibling at the zero placeholder version,
// the same shape the repo's real modules have before they are published.
func (f *fixture) module(dir string, requires ...string) {
	f.t.Helper()
	var b strings.Builder
	b.WriteString("module example.com/r/" + dir + "\n\ngo 1.25\n")
	for _, r := range requires {
		b.WriteString("\nrequire example.com/r/" + r + " v0.0.0\n")
	}
	f.write(filepath.Join(dir, "go.mod"), b.String())
	f.write(filepath.Join(dir, "doc.go"), "package x\n")
}

func (f *fixture) write(path, content string) {
	f.t.Helper()
	p := filepath.Join(f.clone, path)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) commit(msg string) {
	f.t.Helper()
	f.git(f.clone, "add", "-A")
	f.git(f.clone, "commit", "--quiet", "-m", msg)
}

// publish tags and pushes, which is what makes a version visible to the tool's origin check.
func (f *fixture) publish(tags ...string) {
	f.t.Helper()
	for _, tag := range tags {
		f.git(f.clone, "tag", "-m", tag, tag)
		f.git(f.clone, "push", "--quiet", "origin", tag)
	}
}

func (f *fixture) pushMain() {
	f.t.Helper()
	f.git(f.clone, "push", "--quiet", "origin", "main")
}

// gate stands in for tooling/verify-standalone-modules.sh. The passing stub also asserts it was
// told to check the tags as written.
func (f *fixture) gate(pass bool) {
	f.t.Helper()
	body := "#!/bin/sh\nexit 1\n"
	if pass {
		body = "#!/bin/sh\n[ \"$VERIFY_AS_TAGGED\" = 1 ] || exit 3\nexit 0\n"
	}
	f.write(verifyScript, body)
	if err := os.Chmod(filepath.Join(f.clone, verifyScript), 0o755); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) head() string { return f.git(f.clone, "rev-parse", "HEAD") }

func (f *fixture) plan() (map[string]*module, []string) {
	f.t.Helper()
	mods, releasing, err := planRelease(f.clone, "v0.1.0", "patch")
	if err != nil {
		f.t.Fatalf("planRelease: %v", err)
	}
	return mods, releasing
}

func TestNeverTaggedModulesGetTheInitialVersion(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.module("b", "a")
	f.commit("init")

	mods, releasing := f.plan()

	if got := strings.Join(releasing, ","); got != "a,b" {
		t.Fatalf("releasing = %s, want a,b (dependency first)", got)
	}
	for _, d := range releasing {
		if mods[d].next != "v0.1.0" || mods[d].reason != "never tagged" {
			t.Errorf("%s: next=%q reason=%q, want v0.1.0 / never tagged", d, mods[d].next, mods[d].reason)
		}
	}
}

func TestUnchangedModulesAreNotReleased(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.module("b", "a")
	f.commit("init")
	f.publish("a/v0.1.0", "b/v0.1.0")

	if _, releasing := f.plan(); len(releasing) != 0 {
		t.Fatalf("releasing = %v, want nothing", releasing)
	}
}

// A dependent whose own files did not change still needs a new version, or consumers resolve
// it at a version whose go.mod names the old leaf.
func TestDependentsAreReleasedWhenALeafChanges(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.module("b", "a")
	f.module("c")
	f.commit("init")
	f.publish("a/v0.1.0", "b/v0.1.0", "c/v0.1.0")

	f.write("a/new.go", "package x\n")
	f.commit("change a")

	mods, releasing := f.plan()

	if got := strings.Join(releasing, ","); got != "a,b" {
		t.Fatalf("releasing = %s, want a,b -- c did not change and depends on nothing", got)
	}
	if mods["a"].next != "v0.1.1" || !strings.HasPrefix(mods["a"].reason, "files changed") {
		t.Errorf("a: next=%q reason=%q", mods["a"].next, mods["a"].reason)
	}
	if mods["b"].next != "v0.1.1" || mods["b"].reason != "depends on a" {
		t.Errorf("b: next=%q reason=%q, want v0.1.1 / depends on a", mods["b"].next, mods["b"].reason)
	}
}

// A module's directory contains the modules nested under it; a change there is theirs alone.
func TestANestedModuleChangeDoesNotReleaseItsParent(t *testing.T) {
	f := newFixture(t)
	f.module("p")
	f.module("p/child")
	f.commit("init")
	f.publish("p/v0.1.0", "p/child/v0.1.0")

	f.write("p/child/new.go", "package x\n")
	f.commit("change child only")

	if _, releasing := f.plan(); strings.Join(releasing, ",") != "p/child" {
		t.Fatalf("releasing = %v, want only p/child", releasing)
	}
}

// Go ignores replace directives in a dependency's go.mod, so a replace must not create an edge.
func TestAReplaceWithoutARequireIsNotADependency(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.module("b")
	f.write("b/go.mod", "module example.com/r/b\n\ngo 1.25\n\nreplace example.com/r/a => ../a\n")
	f.commit("init")

	if mods, _ := f.plan(); len(mods["b"].deps) != 0 {
		t.Fatalf("b.deps = %v, want none", mods["b"].deps)
	}
}

func TestToolingIsNeverPublished(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.module("tooling/release")
	f.commit("init")

	if mods, _ := f.plan(); mods["tooling/release"] != nil {
		t.Fatal("tooling/release was discovered as a publishable module")
	}
}

// Semver, not lexical: v0.10.0 is newer than v0.9.0.
func TestTheHighestSemverTagWins(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.commit("init")
	f.publish("a/v0.9.0", "a/v0.10.0")
	f.write("a/new.go", "package x\n")
	f.commit("change a")

	if mods, _ := f.plan(); mods["a"].current != "v0.10.0" || mods["a"].next != "v0.10.1" {
		t.Fatalf("a: current=%q next=%q, want v0.10.0 -> v0.10.1", mods["a"].current, mods["a"].next)
	}
}

// Go's major-version convention puts v2 of a module in a p/v2 subdirectory, tagged
// p/v2/v2.0.0. The parent's p/v* glob matches that tag, so it must not be read as p's version.
func TestAMajorVersionSubdirectorysTagIsNotItsParents(t *testing.T) {
	f := newFixture(t)
	f.module("p")
	f.module("p/v2")
	f.commit("init")
	f.publish("p/v2/v2.0.0")

	if mods, _ := f.plan(); mods["p"].current != "" {
		t.Fatalf("p.current = %q, want none -- only p/v2 was ever tagged", mods["p"].current)
	}
}

// A clone that never fetched tags would otherwise plan a version origin already published.
func TestAVersionOnlyOnOriginIsCountedAndDemandsAFetch(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.commit("init")
	f.publish("a/v0.1.0")
	f.git(f.clone, "tag", "-d", "a/v0.1.0") // origin has it, this clone does not

	_, _, err := planRelease(f.clone, "v0.1.0", "patch")
	if err == nil || !strings.Contains(err.Error(), "git fetch --tags") {
		t.Fatalf("err = %v, want a request to run git fetch --tags", err)
	}
}

func TestRequiresAreRewrittenToTheVersionsBeingPublished(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.module("b", "a")
	f.commit("init")

	mods, releasing := f.plan()
	_, touched, err := rewriteRequires(mods, releasing, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(touched, ",") != filepath.Join("b", "go.mod") {
		t.Fatalf("touched = %v, want only b/go.mod", touched)
	}

	b, _ := os.ReadFile(filepath.Join(f.clone, "b", "go.mod"))
	mf, err := modfile.Parse("go.mod", b, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(mf.Require) != 1 || mf.Require[0].Mod.Version != "v0.1.0" {
		t.Fatalf("b requires %v, want example.com/r/a v0.1.0", mf.Require)
	}
}

func TestADependencyCycleIsRejected(t *testing.T) {
	mods := map[string]*module{
		"a": {dir: "a", deps: []string{"b"}},
		"b": {dir: "b", deps: []string{"a"}},
	}
	if _, err := topo(mods); err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Fatalf("err = %v, want a cycle error", err)
	}
}

func TestBumpVersion(t *testing.T) {
	for _, tc := range []struct{ in, kind, want string }{
		{"v0.1.0", "patch", "v0.1.1"},
		{"v0.1.9", "patch", "v0.1.10"},
		{"v0.1.3", "minor", "v0.2.0"},
		{"v1.2.3", "patch", "v1.2.4"},
		{"v1.2.3", "minor", "v1.3.0"},
	} {
		if got := bumpVersion(tc.in, tc.kind); got != tc.want {
			t.Errorf("bumpVersion(%s, %s) = %s, want %s", tc.in, tc.kind, got, tc.want)
		}
	}
}

func TestPrepareCommitsOnlyTheRewrittenGoMods(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.module("b", "a")
	f.write("notes.txt", "unrelated\n")
	f.commit("init")

	if err := run("prepare", "v0.1.0", "patch"); err != nil {
		t.Fatal(err)
	}
	if got := f.git(f.clone, "show", "--name-only", "--format=", "HEAD"); got != "b/go.mod" {
		t.Fatalf("prepare commit touched %q, want only b/go.mod", got)
	}
}

func TestPrepareWithNothingToRewriteMakesNoCommit(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.commit("init")
	before := f.head()

	if err := run("prepare", "v0.1.0", "patch"); err != nil {
		t.Fatal(err)
	}
	if f.head() != before {
		t.Fatal("prepare committed although no go.mod needed changing")
	}
}

// Tagging before the requires name the published versions would publish modules whose go.mod
// still points at placeholders.
func TestTagRefusesUntilThePrepareCommitHasLanded(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.module("b", "a")
	f.gate(true)
	f.commit("init")
	f.pushMain()

	err := run("tag", "v0.1.0", "patch")
	if err == nil || !strings.Contains(err.Error(), "release prepare") {
		t.Fatalf("err = %v, want a pointer to release prepare", err)
	}
	if tags := f.git(f.clone, "tag"); tags != "" {
		t.Fatalf("tags created anyway: %s", tags)
	}
}

// After a squash merge only origin's tip is in main's history; tagging anything else publishes
// a commit main never contains.
func TestTagRefusesAnythingButOriginsTip(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.gate(true)
	f.commit("init")
	f.pushMain()
	f.write("a/new.go", "package x\n")
	f.commit("local only")

	err := run("tag", "v0.1.0", "patch")
	if err == nil || !strings.Contains(err.Error(), "origin's default branch") {
		t.Fatalf("err = %v, want a refusal to tag off origin's tip", err)
	}
	if tags := f.git(f.clone, "tag"); tags != "" {
		t.Fatalf("tags created anyway: %s", tags)
	}
}

func TestTagCreatesTheTagsWhenTheCheckPasses(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.module("b", "a")
	f.gate(true)
	f.commit("init")
	if err := run("prepare", "v0.1.0", "patch"); err != nil {
		t.Fatal(err)
	}
	f.pushMain()

	if err := run("tag", "v0.1.0", "patch"); err != nil {
		t.Fatal(err)
	}
	if got := f.git(f.clone, "tag"); got != "a/v0.1.0\nb/v0.1.0" {
		t.Fatalf("tags = %q, want a/v0.1.0 and b/v0.1.0", got)
	}
	if remote := f.git(f.clone, "ls-remote", "--tags", "origin"); remote != "" {
		t.Fatalf("tags were pushed; pushing must stay a manual step:\n%s", remote)
	}
}

func TestTagRemovesItsTagsWhenTheCheckFails(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.module("b", "a")
	f.gate(false)
	f.commit("init")
	if err := run("prepare", "v0.1.0", "patch"); err != nil {
		t.Fatal(err)
	}
	f.pushMain()

	err := run("tag", "v0.1.0", "patch")
	if err == nil || !strings.Contains(err.Error(), "standalone check failed") {
		t.Fatalf("err = %v, want the check failure", err)
	}
	if tags := f.git(f.clone, "tag"); tags != "" {
		t.Fatalf("tags left behind after a failed check: %s", tags)
	}
}

// The guard that keeps unrelated work out of the prepare commit and off main's tagged commit.
func TestPrepareAndTagRefuseADirtyTree(t *testing.T) {
	for _, cmd := range []string{"prepare", "tag"} {
		t.Run(cmd, func(t *testing.T) {
			f := newFixture(t)
			f.module("a")
			f.module("b", "a")
			f.commit("init")
			f.write("stray.txt", "work in progress\n")
			before := f.head()

			err := run(cmd, "v0.1.0", "patch")
			if err == nil || !strings.Contains(err.Error(), "dirty") {
				t.Fatalf("err = %v, want a dirty-tree refusal", err)
			}
			if f.head() != before {
				t.Fatal("a commit was made on a dirty tree")
			}
		})
	}
}

// An interrupted `tag` leaves unchecked, unpushed local tags. They must not read as released.
func TestALocalOnlyTagIsNotARelease(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.commit("init")
	f.git(f.clone, "tag", "-m", "left over", "a/v0.1.0") // never pushed

	mods, releasing := f.plan()
	if strings.Join(releasing, ",") != "a" || mods["a"].current != "" || mods["a"].next != "v0.1.0" {
		t.Fatalf("a: current=%q next=%q releasing=%v, want an unreleased module planned at v0.1.0", mods["a"].current, mods["a"].next, releasing)
	}
}

// The next run after an interruption has to succeed, replacing the leftovers rather than
// failing on "tag already exists" -- and the new tags have to point at the tip, not wherever the
// interrupted run left them.
func TestTagRecoversFromAnInterruptedRun(t *testing.T) {
	f := newFixture(t)
	f.module("a")
	f.module("b", "a")
	f.gate(true)
	f.commit("init")
	if err := run("prepare", "v0.1.0", "patch"); err != nil {
		t.Fatal(err)
	}
	f.pushMain()
	for _, tag := range []string{"a/v0.1.0", "b/v0.1.0"} {
		f.git(f.clone, "tag", "-m", "left over", tag, "HEAD~1")
	}

	if err := run("tag", "v0.1.0", "patch"); err != nil {
		t.Fatal(err)
	}
	head := f.head()
	for _, tag := range []string{"a/v0.1.0", "b/v0.1.0"} {
		if got := f.git(f.clone, "rev-parse", tag+"^{commit}"); got != head {
			t.Errorf("%s points at %.8s, want the tip %.8s", tag, got, head)
		}
	}
}
