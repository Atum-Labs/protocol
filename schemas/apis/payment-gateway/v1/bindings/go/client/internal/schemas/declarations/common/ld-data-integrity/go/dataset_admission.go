package lddataintegrity

import (
	"sort"
	"strconv"
	"strings"

	"github.com/piprate/json-gold/ld"
)

// checkDataset refuses an expanded dataset whose canonicalization could reach the
// Hash N-Degree Quads step of URDNA2015 (RDFC-1.0 section 4.8), the only step whose
// cost grows faster than polynomially. That step runs only for blank nodes whose
// first-degree hashes collide, so a dataset in which every blank node's first-degree
// quads are unique is canonicalized by the first-degree pass alone.
//
// It groups blank nodes exactly as json-gold's Hash First Degree Quads does: each blank
// node's quads are those that mention it as subject, object or graph name, once per
// position, each serialized as an N-Quad with the node as _:a and every other blank
// node as _:z. Comparing the sorted, joined quads rather than their digests refuses the
// same datasets, since equal inputs are the only way the digests can be equal short of
// a SHA-256 collision.
//
// Nodes are only read, never constructed, and only through accessors whose types agree
// across json-gold releases, since a consumer's build may select a newer release than
// this module requires.
func checkDataset(ds *ld.RDFDataset) error {
	mentions := map[string][]*firstDegreeQuad{}
	var quads []*firstDegreeQuad
	for graph, triples := range ds.Graphs {
		for _, q := range triples {
			fq := &firstDegreeQuad{quad: q, graph: graph}
			quads = append(quads, fq)
			for _, n := range []ld.Node{q.Subject, q.Object, q.Graph} {
				if n != nil && ld.IsBlankNode(n) {
					label := n.GetValue()
					mentions[label] = append(mentions[label], fq)
				}
			}
		}
	}
	if len(mentions) > maxAdmittedBlankNodes {
		return &AdmissionError{Rule: RuleBlankNodeBudget, Path: ""}
	}

	// Every blank-node mention is counted at the width of the longest label
	// canonicalization can issue, _:c14n followed by the highest index, so that the
	// estimate never falls below the output whatever labels the nodes receive. The
	// sum is checked as each quad is serialized, so a dataset far over the budget is
	// refused without rendering the rest of it.
	labelWidth := 0
	if len(mentions) > 0 {
		labelWidth = len("_:c14n") + len(strconv.Itoa(len(mentions)-1))
	}
	estimate := 0
	for _, fq := range quads {
		if err := fq.serialize(); err != nil {
			return err
		}
		estimate += fq.outputLength(labelWidth)
		if estimate > maxAdmittedOutputBytes {
			return &AdmissionError{Rule: RuleOutputBudget, Path: ""}
		}
	}
	seen := make(map[string]struct{}, len(mentions))
	for ref, fqs := range mentions {
		lines := make([]string, len(fqs))
		for i, fq := range fqs {
			lines[i] = fq.relabel(ref)
		}
		sort.Strings(lines)
		key := strings.Join(lines, "")
		if _, dup := seen[key]; dup {
			return &AdmissionError{Rule: RuleIndistinguishableBlankNodes, Path: ""}
		}
		seen[key] = struct{}{}
	}
	return nil
}

// firstDegreeQuad holds a quad's N-Quad serialization split around the positions a blank
// node can take, so that it can be rewritten for each reference node without
// re-serializing it.
type firstDegreeQuad struct {
	quad  *ld.Quad
	graph string
	// core is the quad serialized without its graph name: subject, predicate and
	// object, with no terminator.
	core string
	// graphTerm is what the serializer appends for the graph name, leading space
	// included, or "" in the default graph.
	graphTerm string
}

const nquadTerminator = " .\n"

// serialize renders the quad through json-gold's own N-Quads serializer, the same
// function its hash uses, so that literal and IRI escaping cannot drift from it. The
// quad is serialized once in the default graph and once in its own, and the graph term
// is what the second adds to the first.
func (fq *firstDegreeQuad) serialize() error {
	plain, err := serializeQuad(fq.quad, "@default")
	if err != nil {
		return err
	}
	fq.core = strings.TrimSuffix(plain, nquadTerminator)
	if fq.graph == "@default" {
		return nil
	}
	named, err := serializeQuad(fq.quad, fq.graph)
	if err != nil {
		return err
	}
	fq.graphTerm = strings.TrimSuffix(strings.TrimPrefix(named, fq.core), nquadTerminator)
	return nil
}

// relabel returns the quad's N-Quad with ref written as _:a and every other blank node as
// _:z. A blank subject opens the line and a blank object closes the core: of the object
// forms, only a literal is followed by anything, its datatype or language tag, and a
// literal is not a blank node.
func (fq *firstDegreeQuad) relabel(ref string) string {
	core := fq.core
	if n := fq.quad.Subject; n != nil && ld.IsBlankNode(n) {
		label := n.GetValue()
		core = firstDegreeLabel(label, ref) + core[len(label):]
	}
	if n := fq.quad.Object; n != nil && ld.IsBlankNode(n) {
		label := n.GetValue()
		core = core[:len(core)-len(label)] + firstDegreeLabel(label, ref)
	}
	graphTerm := fq.graphTerm
	if n := fq.quad.Graph; n != nil && ld.IsBlankNode(n) {
		graphTerm = " " + firstDegreeLabel(n.GetValue(), ref)
	}
	return core + graphTerm + nquadTerminator
}

// outputLength is the length of the quad's canonical N-Quad with every blank node
// label written at labelWidth bytes.
func (fq *firstDegreeQuad) outputLength(labelWidth int) int {
	n := len(fq.core) + len(fq.graphTerm) + len(nquadTerminator)
	for _, node := range []ld.Node{fq.quad.Subject, fq.quad.Object, fq.quad.Graph} {
		if node != nil && ld.IsBlankNode(node) {
			n += labelWidth - len(node.GetValue())
		}
	}
	return n
}

func firstDegreeLabel(label, ref string) string {
	if label == ref {
		return "_:a"
	}
	return "_:z"
}

func serializeQuad(q *ld.Quad, graph string) (string, error) {
	one := &ld.RDFDataset{Graphs: map[string][]*ld.Quad{graph: {q}}}
	out, err := (&ld.NQuadRDFSerializer{}).Serialize(one)
	if err != nil {
		return "", err
	}
	line, _ := out.(string)
	return line, nil
}
