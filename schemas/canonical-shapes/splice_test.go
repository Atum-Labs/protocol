package main

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

const specFixture = `openapi: 3.0.3
paths:
  /x:
    get:
      responses:
        "200":
          description: ok
components:
  schemas:
    Alpha:
      type: object
      properties:
        a:
          type: string

    Target:
      type: object
      description: the block under test
      properties:
        old:
          type: string

    Omega:
      type: string
`

func bodyNode(t *testing.T, src string) *yaml.Node {
	t.Helper()
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(src), &doc); err != nil {
		t.Fatalf("parsing body: %v", err)
	}
	c := &converter{}
	return c.convert(doc.Content[0], "Target")
}

func TestSpliceReplacesOnlyTheNamedBlock(t *testing.T) {
	out, err := spliceComponent([]byte(specFixture), "Target", bodyNode(t, `{"type":"object","properties":{"new":{"type":"integer"}}}`))
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	got := string(out)

	if strings.Contains(got, "old:") {
		t.Error("the previous body survived the splice")
	}
	if !strings.Contains(got, "new:") {
		t.Error("the new body is missing")
	}
	// Neighbours must be untouched, including the paths section above them.
	for _, keep := range []string{"    Alpha:\n", "    Omega:\n", "        a:\n", "          description: ok\n"} {
		if !strings.Contains(got, keep) {
			t.Errorf("splice disturbed unrelated content: %q is gone", keep)
		}
	}
}

// The TypeScript SDK names anonymous enum types after the order it meets schemas in
// (status2, status3, ...). A splice that reordered components.schemas would silently
// change those exported names, so ordering is asserted rather than assumed.
func TestSplicePreservesComponentOrder(t *testing.T) {
	out, err := spliceComponent([]byte(specFixture), "Target", bodyNode(t, `{"type":"object"}`))
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	lines := strings.Split(string(out), "\n")
	lo, hi, err := schemasSection(lines)
	if err != nil {
		t.Fatalf("locating schemas section: %v", err)
	}
	var order []string
	for _, line := range lines[lo:hi] {
		if strings.HasSuffix(line, ":") && indentOf(line) == componentIndent {
			order = append(order, strings.TrimSpace(strings.TrimSuffix(line, ":")))
		}
	}
	want := []string{"Alpha", "Target", "Omega"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Errorf("component order is %v, want %v", order, want)
	}
}

func TestSplicePreservesBlankLineSpacing(t *testing.T) {
	out, err := spliceComponent([]byte(specFixture), "Target", bodyNode(t, `{"type":"object"}`))
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	if !strings.Contains(string(out), "      type: object\n\n    Omega:") {
		t.Errorf("the blank line before the next component was lost:\n%s", out)
	}
}

func TestSpliceRejectsAnUnknownComponent(t *testing.T) {
	_, err := spliceComponent([]byte(specFixture), "Missing", bodyNode(t, `{"type":"object"}`))
	if err == nil {
		t.Fatal("want an error naming the missing component")
	}
	if !strings.Contains(err.Error(), "Missing") {
		t.Errorf("error %q does not name the component", err)
	}
}

// A name that also appears more nested -- as a property, say -- must not be mistaken for
// the component block.
func TestSpliceIgnoresDeeperOccurrencesOfTheName(t *testing.T) {
	spec := `components:
  schemas:
    Wrapper:
      properties:
        Target:
          type: string
    Target:
      type: object
`
	out, err := spliceComponent([]byte(spec), "Target", bodyNode(t, `{"type":"integer"}`))
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	if !strings.Contains(string(out), "        Target:\n          type: string") {
		t.Errorf("the nested property named Target was rewritten:\n%s", out)
	}
	if !strings.Contains(string(out), "    Target:\n      type: integer") {
		t.Errorf("the component was not replaced:\n%s", out)
	}
}

func TestRenderIndentsBodyUnderTheComponentKey(t *testing.T) {
	lines, err := renderComponent("Target", bodyNode(t, `{"type":"object","required":["a"]}`))
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	want := []string{"    Target:", "      type: object", "      required:", "        - a"}
	if strings.Join(lines, "\n") != strings.Join(want, "\n") {
		t.Errorf("\n got:\n%s\nwant:\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
}

// `paths:` nests HTTP methods at the component indent, so a component whose name collides
// with one must still resolve to the component.
func TestSpliceIgnoresIdenticallyIndentedPathItems(t *testing.T) {
	spec := `openapi: 3.0.3
paths:
  /x:
    get:
      responses:
        "200":
          description: ok
components:
  schemas:
    get:
      type: object
`
	out, err := spliceComponent([]byte(spec), "get", bodyNode(t, `{"type":"integer"}`))
	if err != nil {
		t.Fatalf("splice: %v", err)
	}
	if !strings.Contains(string(out), "    get:\n      responses:") {
		t.Errorf("the path item named get was rewritten:\n%s", out)
	}
	if !strings.Contains(string(out), "    get:\n      type: integer") {
		t.Errorf("the component was not replaced:\n%s", out)
	}
}
