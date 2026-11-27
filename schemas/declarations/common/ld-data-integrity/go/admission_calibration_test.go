package lddataintegrity

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// calibrationShape is one of the costliest documents the admission rules
// still admit. Shape (a)'s entry count, shape (c)'s value count and shape
// (e)'s statement count are derived from the JSON budgets in admission.go, so
// a change to those budgets moves them and the ceiling below is re-checked at
// the new limit. Shape (b)'s and (c)'s literal lengths and shape (e)'s IRI
// length are fitted to the output budget as the contract states it, which
// binds before the byte budget for any document whose strings reach the
// output. Shape (b)'s entry count and shape (d)'s proof count are fixed; the
// checks pin each shape to the budget it is named for, so a budget change
// makes them fail loudly rather than move.
type calibrationShape struct {
	name string
	doc  map[string]any
	// check asserts the shape sits where its name says, given its measured
	// JSON value count, string byte count and dataset.
	check func(t *testing.T, values, bytes int, s datasetShape)
	// allocCeiling bounds the bytes one Canonicalize call on the shape may
	// allocate; zero means worstAdmittedAllocCeiling.
	allocCeiling uint64
}

// distinctLiteral is a string of exactly n bytes, unique per i, so that no
// two literals built from it coincide and every node carrying one is told
// apart at first degree.
func distinctLiteral(i, n int) string {
	p := fmt.Sprintf("%05d", i)
	if n < len(p) {
		panic(fmt.Sprintf("literal length %d is shorter than its %d-byte index prefix", n, len(p)))
	}
	return p + strings.Repeat("x", n-len(p))
}

// longestLiteralWithinOutputBudget is the longest literal length at which
// build(length) is estimated within the output budget: every literal of the
// shapes it serves appears once in the output, so the estimate grows by a
// fixed step per byte of literal length, and the result is fitted from two
// measurements and confirmed from both sides.
func longestLiteralWithinOutputBudget(build func(lit int) map[string]any, loader *DocumentLoader) (int, error) {
	const base = 5
	e0, err := outputEstimate(build(base), loader)
	if err != nil {
		return 0, err
	}
	e1, err := outputEstimate(build(base+1), loader)
	if err != nil {
		return 0, err
	}
	step := e1 - e0
	if step <= 0 || e0 > datasetOutputBudget {
		return 0, fmt.Errorf("estimate %d at literal length %d grows by %d per byte; cannot fit %d", e0, base, step, datasetOutputBudget)
	}
	lit := base + (datasetOutputBudget-e0)/step
	at, err := outputEstimate(build(lit), loader)
	if err != nil {
		return 0, err
	}
	over, err := outputEstimate(build(lit+1), loader)
	if err != nil {
		return 0, err
	}
	if at > datasetOutputBudget || over <= datasetOutputBudget {
		return 0, fmt.Errorf("literal length %d is estimated at %d and %d at one byte longer; want within and over %d", lit, at, over, datasetOutputBudget)
	}
	return lit, nil
}

// calibrationShapes builds the shapes with loader, which must resolve the
// PaymentRequest context that shapes (a) to (c) name.
func calibrationShapes(loader *DocumentLoader) []calibrationShape {
	url := datasetPaymentRequestContextURL

	// (a) The root, its @context string and the destination array are three
	// values; each entry is an object and its account literal, two more.
	valueN := (maxAdmittedValues - 3) / 2
	valueDest := make([]any, valueN)
	for i := range valueDest {
		valueDest[i] = map[string]any{"account": distinctLiteral(i, 6)}
	}

	// (b) Fixed entries, each one long distinct literal on its account. Every
	// literal reaches the output, so the output budget binds before the byte
	// budget: the literals are as long as an estimate within it allows.
	const byteN = 500
	byteDoc := func(lit int) map[string]any {
		dest := make([]any, byteN)
		for i := range dest {
			dest[i] = map[string]any{"account": distinctLiteral(i, lit)}
		}
		return map[string]any{"@context": url, "destination": dest}
	}
	byteLit, err := longestLiteralWithinOutputBudget(byteDoc, loader)
	if err != nil {
		panic(fmt.Sprintf("calibration shape b: %v", err))
	}

	// (c) Every value the budget allows beyond the root, @context string and
	// array is a literal on one property, each as long as an estimate within
	// the output budget allows, which binds before the byte budget because
	// every literal reaches the output. json-gold's node map building adds
	// each value with duplicates disallowed, so it scans the values the
	// property already holds: quadratic in the values per property. Shapes
	// (a) and (b) pay the same cost through their destination arrays; this
	// shape puts the most values on a single property.
	propN := maxAdmittedValues - 3
	propDoc := func(lit int) map[string]any {
		vals := make([]any, propN)
		for i := range vals {
			vals[i] = distinctLiteral(i, lit)
		}
		return map[string]any{"@context": url, "account": vals}
	}
	propLit, err := longestLiteralWithinOutputBudget(propDoc, loader)
	if err != nil {
		panic(fmt.Sprintf("calibration shape c: %v", err))
	}
	// withinOutputBudgetAtItsLongest asserts a fitted shape's estimate is
	// within the output budget and one byte more per literal is over it.
	withinOutputBudgetAtItsLongest := func(t *testing.T, build func(int) map[string]any, lit int) {
		t.Helper()
		if e := measureOutputEstimate(t, build(lit), loader); e > datasetOutputBudget {
			t.Errorf("output estimate %d, over the budget of %d", e, datasetOutputBudget)
		}
		if e := measureOutputEstimate(t, build(lit+1), loader); e <= datasetOutputBudget {
			t.Errorf("output estimate %d with literals one byte longer, want over the budget of %d", e, datasetOutputBudget)
		}
	}

	// (e) The root, its @context, id and type strings and the issuanceDate
	// array are five values; every other value is a statement about the
	// root, whose IRI is as long as the output budget allows. Canonical
	// output is as large as admission lets it be, over as many quads as the
	// value budget allows, each carrying the IRI. The credentials context is
	// vendored, so the bare loader resolves it.
	outN := maxAdmittedValues - 5
	outDoc, err := outputBudgetDocAt(outN, 0, datasetOutputBudget, NewDocumentLoader(nil))
	if err != nil {
		panic(fmt.Sprintf("calibration shape e: %v", err))
	}

	return []calibrationShape{
		{
			name: "a/value budget: destination array of distinct objects",
			doc:  map[string]any{"@context": url, "destination": valueDest},
			check: func(t *testing.T, values, bytes int, s datasetShape) {
				// Values are counted in pairs, so the shape can fall one short.
				if values < maxAdmittedValues-1 {
					t.Errorf("%d JSON values, want at least %d", values, maxAdmittedValues-1)
				}
				if s.blankNodes != valueN+1 || s.quads != 2*valueN {
					t.Errorf("dataset has %d blank nodes and %d quads, want %d and %d", s.blankNodes, s.quads, valueN+1, 2*valueN)
				}
			},
		},
		{
			name: "b/output budget: destination objects each with one distinct literal as long as the output budget allows",
			doc:  byteDoc(byteLit),
			check: func(t *testing.T, values, bytes int, s datasetShape) {
				withinOutputBudgetAtItsLongest(t, byteDoc, byteLit)
				if s.blankNodes != byteN+1 || s.quads != 2*byteN {
					t.Errorf("dataset has %d blank nodes and %d quads, want %d and %d", s.blankNodes, s.quads, byteN+1, 2*byteN)
				}
			},
		},
		{
			name: "c/output budget: one property with every value a distinct literal as long as the output budget allows",
			doc:  propDoc(propLit),
			check: func(t *testing.T, values, bytes int, s datasetShape) {
				if values != maxAdmittedValues {
					t.Errorf("%d JSON values, want %d", values, maxAdmittedValues)
				}
				withinOutputBudgetAtItsLongest(t, propDoc, propLit)
				if s.blankNodes != 1 || s.quads != propN {
					t.Errorf("dataset has %d blank nodes and %d quads, want 1 and %d", s.blankNodes, s.quads, propN)
				}
			},
		},
		{
			name: "d/blank-node budget: sibling proof graphs at exactly the cap",
			doc:  datasetBlankNodeBoundary(false),
			check: func(t *testing.T, values, bytes int, s datasetShape) {
				if s.blankNodes != datasetBlankNodeBudget {
					t.Errorf("dataset has %d blank nodes, want %d", s.blankNodes, datasetBlankNodeBudget)
				}
			},
		},
		{
			name: "e/output budget: one long-IRI node, the subject of every statement, estimated at exactly the cap",
			doc:  outDoc,
			check: func(t *testing.T, values, bytes int, s datasetShape) {
				if values != maxAdmittedValues {
					t.Errorf("%d JSON values, want %d", values, maxAdmittedValues)
				}
				if s.blankNodes != 0 || s.quads != outN+1 {
					t.Errorf("dataset has %d blank nodes and %d quads, want 0 and %d", s.blankNodes, s.quads, outN+1)
				}
				if e := measureOutputEstimate(t, outDoc, NewDocumentLoader(nil)); e != datasetOutputBudget {
					t.Errorf("output estimate %d, want exactly %d", e, datasetOutputBudget)
				}
			},
			allocCeiling: outputBudgetShapeAllocCeiling,
		},
	}
}

// Each worst admitted shape must still be admitted, by the JSON pre-check
// and by Canonicalize, and must sit at the budget it is named for. A shape
// that drifts off its budget or starts being refused would silently stop
// calibrating anything, so both fail here.
func TestCanonicalize_WorstAdmittedShapesAreAdmittedAtTheirBudgets(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	for _, c := range calibrationShapes(loader) {
		t.Run(c.name, func(t *testing.T) {
			if err := CheckCanonicalizable(copyJSON(t, c.doc)); err != nil {
				t.Fatalf("CheckCanonicalizable = %v, want nil", err)
			}
			values, bytes := countJSONValues(c.doc), countJSONBytes(c.doc)
			if values > maxAdmittedValues || bytes > maxAdmittedBytes {
				t.Fatalf("%d values and %d bytes, over the budgets of %d and %d", values, bytes, maxAdmittedValues, maxAdmittedBytes)
			}
			s := measureDataset(t, c.doc, loader)
			t.Logf("%d JSON values, %d string bytes, %d quads, %d blank nodes", values, bytes, s.quads, s.blankNodes)
			if len(s.duplicates) != 0 {
				t.Fatalf("shape has indistinguishable blank nodes: %v", s.duplicates)
			}
			if s.blankNodes > datasetBlankNodeBudget {
				t.Fatalf("%d blank nodes, over the budget of %d", s.blankNodes, datasetBlankNodeBudget)
			}
			c.check(t, values, bytes, s)
			if _, err := Canonicalize(copyJSON(t, c.doc), loader); err != nil {
				t.Fatalf("Canonicalize = %v, want admission", err)
			}
		})
	}
}

// calibrationRuns is how many times each shape is timed; the fastest run is
// the one compared, so a scheduler pause or GC cycle in one run cannot fail
// the test on its own.
const calibrationRuns = 3

// A smoke alarm, not a budget: the admission rules exist so that no admitted
// document can drive canonicalization into super-polynomial work, and a
// second is far above what any shape here costs when that holds. The
// measured durations are logged so a slower regression is still visible.
func TestCanonicalize_WorstAdmittedWithinCeiling(t *testing.T) {
	const ceiling = time.Second
	loader := datasetLoader(t, loadDatasetVectors(t))
	for _, c := range calibrationShapes(loader) {
		t.Run(c.name, func(t *testing.T) {
			var best time.Duration
			var got string
			for i := 0; i < calibrationRuns; i++ {
				doc := copyJSON(t, c.doc)
				start := time.Now()
				out, err := Canonicalize(doc, loader)
				elapsed := time.Since(start)
				if err != nil {
					t.Fatalf("Canonicalize = %v, want admission", err)
				}
				if i == 0 || elapsed < best {
					best = elapsed
				}
				if i > 0 && out != got {
					t.Fatalf("Canonicalize output differs between runs (%d and %d bytes)", len(got), len(out))
				}
				got = out
			}
			t.Logf("best of %d runs: %v, %d bytes of N-Quads", calibrationRuns, best, len(got))
			if best >= ceiling {
				t.Errorf("fastest Canonicalize run took %v, want < %v", best, ceiling)
			}
			want, err := referenceNormalize(copyJSON(t, c.doc), loader)
			if err != nil {
				t.Fatalf("reference Normalize: %v", err)
			}
			if got != want {
				t.Errorf("Canonicalize output (%d bytes) differs from json-gold Normalize (%d bytes)", len(got), len(want))
			}
		})
	}
}

// worstAdmittedAllocCeiling bounds what one Canonicalize call may allocate
// on any worst admitted shape. The costliest, a literal-heavy shape bounded
// by the output budget, allocates about 86 MiB, so this leaves margin across
// json-gold versions and alarms on a regression in json-gold or in how the
// output is assembled. It does not guard the budgets themselves: the shapes
// are fitted to this file's budget pins, and a loosened production budget is
// caught by the shared boundary vectors and the one-byte-over refusals.
const worstAdmittedAllocCeiling uint64 = 128 << 20

// outputBudgetShapeAllocCeiling bounds the output-budget shape alone. json-gold
// appends one statement at a time, copying the output built so far, so with
// the statement count fixed by the value budget the shape's allocation grows
// linearly with the output budget, about 70 MiB at 128 KiB. The ceiling
// leaves margin across json-gold versions and alarms on a regression in
// json-gold or in how the output is assembled; a raised production budget is
// caught by the shared boundary vectors and the one-byte-over refusals, since
// the shape is fitted to this file's budget pin.
const outputBudgetShapeAllocCeiling uint64 = 96 << 20

// allocatedByOneCanonicalize is the least TotalAlloc grew across
// calibrationRuns single Canonicalize calls, each on a fresh copy after a
// collection. The least is taken so that an allocation by the runtime
// itself during one call cannot fail the caller on its own.
func allocatedByOneCanonicalize(t *testing.T, doc any, loader *DocumentLoader) uint64 {
	t.Helper()
	var least uint64
	for i := 0; i < calibrationRuns; i++ {
		input := copyJSON(t, doc)
		var before, after runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&before)
		_, err := Canonicalize(input, loader)
		runtime.ReadMemStats(&after)
		if err != nil {
			t.Fatalf("Canonicalize = %v, want admission", err)
		}
		if n := after.TotalAlloc - before.TotalAlloc; i == 0 || n < least {
			least = n
		}
	}
	return least
}

// Admission bounds memory as well as time: canonicalizing the costliest
// document admitted must stay within a fixed allocation, measured per call.
// For the output-budget shape the ceiling only means something if nothing
// costlier is admitted, so the same shape one byte over the budget must be
// refused first.
func TestCanonicalize_WorstAdmittedAllocatesWithinCeiling(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	t.Run("output-budget shape one byte over the budget is refused", func(t *testing.T) {
		over, err := outputBudgetDocAt(maxAdmittedValues-5, 0, datasetOutputBudget+1, loader)
		if err != nil {
			t.Fatalf("outputBudgetDocAt: %v", err)
		}
		got, err := Canonicalize(copyJSON(t, over), loader)
		wantAdmissionRefusal(t, got, err, RuleOutputBudget)
	})
	for _, c := range calibrationShapes(loader) {
		t.Run(c.name, func(t *testing.T) {
			// The race detector instruments allocation, so the figures it
			// yields are not comparable with the ceilings.
			if raceEnabled {
				t.Skip("allocation ceilings are calibrated without the race detector")
			}
			ceiling := c.allocCeiling
			if ceiling == 0 {
				ceiling = worstAdmittedAllocCeiling
			}
			allocated := allocatedByOneCanonicalize(t, c.doc, loader)
			t.Logf("one Canonicalize call allocated %d bytes (%.1f MiB)", allocated, float64(allocated)/(1<<20))
			if allocated > ceiling {
				t.Errorf("one Canonicalize call allocated %d bytes (%.1f MiB), want at most %d (%d MiB)",
					allocated, float64(allocated)/(1<<20), ceiling, ceiling>>20)
			}
		})
	}
}

// Literal content is reproduced in the output, with each statement's subject,
// predicate and punctuation on top, so a document whose strings are all
// literals reaching the output passes the output budget before it can spend
// the byte budget: it is refused under output-budget, not admitted, and not
// under byte-budget. The byte budget still binds what never reaches the
// output, such as member names.
func TestCanonicalize_LiteralHeavyDocumentAtTheByteBudgetIsRefusedByTheOutputBudget(t *testing.T) {
	loader := datasetLoader(t, loadDatasetVectors(t))
	const entries = 500
	url := datasetPaymentRequestContextURL
	fixed := len("@context") + len(url) + len("destination") + entries*len("account")
	lit := (maxAdmittedBytes - fixed) / entries
	dest := make([]any, entries)
	for i := range dest {
		dest[i] = map[string]any{"account": distinctLiteral(i, lit)}
	}
	// The division's remainder goes to the first literal, so the strings
	// spend the byte budget exactly.
	dest[0] = map[string]any{"account": distinctLiteral(0, lit+(maxAdmittedBytes-fixed)%entries)}
	doc := map[string]any{"@context": url, "destination": dest}

	if b := countJSONBytes(doc); b != maxAdmittedBytes {
		t.Fatalf("fixture has %d string bytes, want exactly the byte budget of %d", b, maxAdmittedBytes)
	}
	if v := countJSONValues(doc); v > maxAdmittedValues {
		t.Fatalf("fixture has %d JSON values, over the budget of %d", v, maxAdmittedValues)
	}
	if err := CheckCanonicalizable(copyJSON(t, doc)); err != nil {
		t.Fatalf("CheckCanonicalizable = %v, want nil: the byte budget must admit the fixture", err)
	}
	s := measureDataset(t, doc, loader)
	if s.blankNodes > datasetBlankNodeBudget {
		t.Fatalf("fixture has %d blank nodes, over the budget of %d", s.blankNodes, datasetBlankNodeBudget)
	}
	if len(s.duplicates) != 0 {
		t.Fatalf("fixture has indistinguishable blank nodes: %v", s.duplicates)
	}
	if e := measureOutputEstimate(t, doc, loader); e <= datasetOutputBudget {
		t.Fatalf("fixture is estimated at %d bytes, want more than the output budget of %d", e, datasetOutputBudget)
	}
	got, err := Canonicalize(copyJSON(t, doc), loader)
	wantAdmissionRefusal(t, got, err, RuleOutputBudget)
}

// calibrationBenchLoader builds the same loader as datasetLoader: every
// context the vector file's dataset section names, read from the path the
// file gives relative to its own directory. The shared helpers report
// through *testing.T, which a benchmark does not have, so this one takes a
// testing.TB and repeats their resolution.
func calibrationBenchLoader(tb testing.TB) *DocumentLoader {
	tb.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		tb.Fatalf("cwd: %v", err)
	}
	vectors := filepath.Join(cwd, "..", "conformance", "admission-vectors.json")
	raw, err := os.ReadFile(vectors)
	if err != nil {
		tb.Fatalf("read admission vectors: %v", err)
	}
	var f datasetVectorFile
	if err := json.Unmarshal(raw, &f); err != nil {
		tb.Fatalf("parse admission vectors: %v", err)
	}
	if _, ok := f.Dataset.Contexts[datasetPaymentRequestContextURL]; !ok {
		tb.Fatalf("dataset.contexts does not name %s", datasetPaymentRequestContextURL)
	}
	dir := filepath.Dir(vectors)
	extra := map[string]any{}
	for url, rel := range f.Dataset.Contexts {
		raw, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil {
			tb.Fatalf("dataset context %s: %v", url, err)
		}
		var ctx any
		if err := json.Unmarshal(raw, &ctx); err != nil {
			tb.Fatalf("dataset context %s: %v", url, err)
		}
		extra[url] = ctx
	}
	return NewDocumentLoader(extra)
}

// Each iteration canonicalizes a fresh decode of the shape, decoded with the
// timer stopped, so the figures are Canonicalize's alone and no iteration
// sees a document an earlier one processed.
func BenchmarkCanonicalize_WorstAdmitted(b *testing.B) {
	loader := calibrationBenchLoader(b)
	for _, c := range calibrationShapes(loader) {
		raw, err := json.Marshal(c.doc)
		if err != nil {
			b.Fatalf("%s: marshal: %v", c.name, err)
		}
		b.Run(c.name, func(b *testing.B) {
			b.ReportAllocs()
			for i := 0; i < b.N; i++ {
				b.StopTimer()
				var doc any
				if err := json.Unmarshal(raw, &doc); err != nil {
					b.Fatalf("unmarshal: %v", err)
				}
				b.StartTimer()
				if _, err := Canonicalize(doc, loader); err != nil {
					b.Fatalf("Canonicalize = %v, want admission", err)
				}
			}
		})
	}
}
