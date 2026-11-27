// Dataset-level admission. Mirror of the Go lib's dataset_admission.go.

import rdfCanonize from "rdf-canonize";
import type { Quad, Term } from "rdf-canonize";

import {
  AdmissionError,
  MAX_ADMITTED_BLANK_NODES,
  MAX_ADMITTED_OUTPUT_BYTES,
} from "./admission.js";

// checkDataset refuses an expanded dataset whose canonicalization could reach
// the Hash N-Degree Quads step of URDNA2015 (RDFC-1.0 section 4.8), the only
// step whose cost grows faster than polynomially. That step runs only for
// blank nodes whose first-degree hashes collide, so a dataset in which every
// blank node's first-degree quads are unique is canonicalized by the
// first-degree pass alone.
//
// It groups blank nodes exactly as rdf-canonize's hashFirstDegreeQuads does:
// each blank node's quads are the distinct quads that mention it as subject,
// object or graph name, each serialized with rdf-canonize's own N-Quads
// serializer, with the node as _:a and every other blank node as _:z.
// Comparing the sorted, joined quads rather than their digests refuses the
// same datasets, since equal inputs are the only way the digests can be equal
// short of a SHA-256 collision.
export function checkDataset(dataset: Quad[]): void {
  const mentions = new Map<string, Set<Quad>>();
  for (const quad of dataset) {
    for (const term of [quad.subject, quad.object, quad.graph]) {
      if (term.termType !== "BlankNode") continue;
      let quads = mentions.get(term.value);
      if (!quads) {
        quads = new Set();
        mentions.set(term.value, quads);
      }
      quads.add(quad);
    }
  }
  if (mentions.size > MAX_ADMITTED_BLANK_NODES) {
    throw new AdmissionError("blank-node-budget", "");
  }

  // Every blank-node mention is counted at the width of the longest label
  // canonicalization can issue, _:c14n followed by the highest index, so that
  // the estimate never falls below the output whatever labels the nodes
  // receive. The sum is checked as each quad is serialized, so a dataset far
  // over the budget is refused without rendering the rest of it.
  const labelWidth =
    mentions.size > 0 ? "_:c14n".length + String(mentions.size - 1).length : 0;
  let estimate = 0;
  for (const quad of dataset) {
    estimate += utf8Length(rdfCanonize.NQuads.serializeQuad(quad));
    for (const term of [quad.subject, quad.object, quad.graph]) {
      if (term.termType === "BlankNode") {
        estimate += labelWidth - utf8Length(term.value);
      }
    }
    if (estimate > MAX_ADMITTED_OUTPUT_BYTES) {
      throw new AdmissionError("output-budget", "");
    }
  }

  const seen = new Set<string>();
  for (const [ref, quads] of mentions) {
    const lines = [...quads].map((q) =>
      rdfCanonize.NQuads.serializeQuad({
        subject: firstDegreeTerm(q.subject, ref),
        predicate: q.predicate,
        object: firstDegreeTerm(q.object, ref),
        graph: firstDegreeTerm(q.graph, ref),
      })
    );
    lines.sort();
    const key = lines.join("");
    if (seen.has(key)) {
      throw new AdmissionError("indistinguishable-blank-nodes", "");
    }
    seen.add(key);
  }
}

// utf8Length is the UTF-8 byte length of s, which is how the Go library, and
// the canonical output's consumers, measure it. A lone surrogate, which the
// JSON pre-check refuses, would count as the three bytes of U+FFFD.
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 4;
        i++;
      } else {
        n += 3;
      }
    } else n += 3;
  }
  return n;
}

function firstDegreeTerm(term: Term, ref: string): Term {
  if (term.termType !== "BlankNode") return term;
  return { termType: "BlankNode", value: term.value === ref ? "_:a" : "_:z" };
}
