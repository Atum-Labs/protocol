import { describe, it, expect, vi } from "vitest";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import jsonld from "jsonld";
import type { JsonLdDocument, Options } from "jsonld";
import rdfCanonize from "rdf-canonize";
import type { Quad } from "rdf-canonize";

import {
  AdmissionError,
  checkCanonicalizable,
  canonicalize,
  DocumentLoader,
  newDocumentLoader,
  UnknownContextError,
  W3C_VC_V1_CONTEXT_URL,
} from "./index.js";
import type { AdmissionRule } from "./index.js";

// The shared vector file lives beside the language directories, so the Go
// and TypeScript halves are held to the same bytes rather than to two copies.
const VECTORS_PATH = fileURLToPath(
  new URL("../../conformance/admission-vectors.json", import.meta.url)
);

// The budgets as the contract states them, restated rather than imported so
// the fixtures are checked against the contract and not against whatever the
// implementation happens to use.
const BYTE_BUDGET = 128 * 1024;
const BLANK_NODE_BUDGET = 1024;
const OUTPUT_BUDGET = 128 * 1024;
// No object or array may sit deeper than this, the root being at depth 1.
const DEPTH_BUDGET = 32;

// A refusal of a pathological dataset must come before canonicalization
// starts; unguarded, some of these documents take far longer than this.
const REFUSAL_CEILING_MS = 100;

const PAYMENT_REQUEST_CONTEXT_URL =
  "https://schemas.atum.network/declarations/PaymentRequest/v1/context.jsonld";

// The optional fields are an accept vector's expected canonical output,
// shared by every implementation: `nquads` verbatim, or `nquads_sha256` and
// `nquads_length` when the output is too long to carry, or
// `known_divergence`, the reason a vector has no expected output.
interface AdmissionVector {
  name: string;
  rule: string | null;
  path: string | null;
  doc: unknown;
  nquads?: string;
  nquads_sha256?: string;
  nquads_length?: number;
  known_divergence?: string;
}

interface GeneratedVector extends AdmissionVector {
  bytes: number;
}

interface VectorFile {
  accept: AdmissionVector[];
  refuse: AdmissionVector[];
  generated: { accept: GeneratedVector[]; refuse: GeneratedVector[] };
  dataset: {
    contexts: Record<string, string>;
    accept: AdmissionVector[];
    refuse: AdmissionVector[];
  };
}

function loadVectors(): VectorFile {
  const f = JSON.parse(readFileSync(VECTORS_PATH, "utf-8")) as VectorFile;
  // An emptied section would otherwise let every loop below pass vacuously.
  for (const [name, list] of [
    ["accept", f.accept],
    ["refuse", f.refuse],
    ["generated.accept", f.generated?.accept],
    ["generated.refuse", f.generated?.refuse],
    ["dataset.accept", f.dataset?.accept],
    ["dataset.refuse", f.dataset?.refuse],
  ] as const) {
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`admission vectors: section ${name} is missing or empty`);
    }
  }
  return f;
}

const VECTORS = loadVectors();

class TemplateError extends Error {
  constructor(message: string) {
    super(`malformed admission template: ${message}`);
    this.name = "TemplateError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// defineProperty rather than assignment: a key such as "__proto__" must
// become an own member, as JSON.parse makes it, not reset the prototype.
function setMember(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// expandTemplate implements the vector file's template grammar and nothing
// more. It is strict on purpose: a malformed template must fail the run, not
// silently become a small literal document that proves nothing about the
// byte budget.
function expandTemplate(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(expandTemplate);
  }
  if (!isPlainObject(v)) {
    return v;
  }
  const keys = Object.keys(v);
  if (Object.hasOwn(v, "$repeat")) {
    const s = v["$repeat"];
    const n = v["$times"];
    if (
      keys.length !== 2 ||
      !Object.hasOwn(v, "$times") ||
      typeof s !== "string" ||
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < 0
    ) {
      throw new TemplateError(`$repeat ${JSON.stringify(v).slice(0, 80)}`);
    }
    return s.repeat(n);
  }
  if (Object.hasOwn(v, "$object")) {
    const pairs = v["$object"];
    if (keys.length !== 1 || !Array.isArray(pairs)) {
      throw new TemplateError(`$object ${JSON.stringify(v).slice(0, 80)}`);
    }
    const out: Record<string, unknown> = {};
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new TemplateError(`$object member is not a [key, value] pair`);
      }
      const k = expandTemplate(pair[0]);
      if (typeof k !== "string") {
        throw new TemplateError(`$object key does not expand to a string`);
      }
      if (Object.hasOwn(out, k)) {
        throw new TemplateError(`duplicate $object key of ${utf8Bytes(k)} bytes`);
      }
      setMember(out, k, expandTemplate(pair[1]));
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k.startsWith("$")) {
      throw new TemplateError(`literal key ${JSON.stringify(k)} begins with "$"`);
    }
    setMember(out, k, expandTemplate(v[k]));
  }
  return out;
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

// The test's own oracle for the byte budget: UTF-8 length of every string
// value and every object key, at any depth.
function countBytes(v: unknown): number {
  if (typeof v === "string") return utf8Bytes(v);
  if (Array.isArray(v)) return v.reduce((n: number, c) => n + countBytes(c), 0);
  if (isPlainObject(v)) {
    let n = 0;
    for (const k of Object.keys(v)) n += utf8Bytes(k) + countBytes(v[k]);
    return n;
  }
  return 0;
}

// The test's own oracle for the value budget: the root and every object,
// array and scalar is one value; keys are not.
function countValues(v: unknown): number {
  if (Array.isArray(v)) return 1 + v.reduce((n: number, c) => n + countValues(c), 0);
  if (isPlainObject(v)) {
    let n = 1;
    for (const k of Object.keys(v)) n += countValues(v[k]);
    return n;
  }
  return 1;
}

// The test's own oracle for the depth budget: the root object or array is at
// depth 1, each nested object or array one deeper, and scalars add nothing,
// so a scalar document has depth 0.
function jsonDepth(v: unknown): number {
  if (Array.isArray(v)) return 1 + v.reduce((d: number, c) => Math.max(d, jsonDepth(c)), 0);
  if (isPlainObject(v)) return 1 + Object.values(v).reduce((d: number, c) => Math.max(d, jsonDepth(c)), 0);
  return 0;
}

function expandGenerated(list: GeneratedVector[]): GeneratedVector[] {
  return list.map((g) => ({ ...g, doc: expandTemplate(g.doc) }));
}

function copyDoc<T>(doc: T): T {
  return structuredClone(doc);
}

function datasetLoader(): DocumentLoader {
  const dir = dirname(VECTORS_PATH);
  const extra: Record<string, JsonLdDocument> = {};
  for (const [url, rel] of Object.entries(VECTORS.dataset.contexts)) {
    extra[url] = JSON.parse(readFileSync(resolve(dir, rel), "utf-8")) as JsonLdDocument;
  }
  if (!Object.hasOwn(extra, PAYMENT_REQUEST_CONTEXT_URL)) {
    throw new Error(`dataset.contexts does not name ${PAYMENT_REQUEST_CONTEXT_URL}`);
  }
  return newDocumentLoader(extra);
}

type CanonizeOptions = Options.Normalize & { safe?: boolean };

// The one-call jsonld.js normalization every admitted document must
// reproduce byte for byte: admission may refuse a document but must never
// change what an admitted one canonicalizes to.
async function referenceCanonize(doc: unknown, loader: DocumentLoader): Promise<string> {
  const options: CanonizeOptions = {
    algorithm: "URDNA2015",
    format: "application/n-quads",
    documentLoader: loader.toJsonldLoader(),
    safe: false,
  };
  return (await jsonld.canonize(copyDoc(doc) as JsonLdDocument, options)) as string;
}

type Outcome = { ok: true; value: string } | { ok: false; error: unknown };

async function settle(p: Promise<string>): Promise<Outcome> {
  return p.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error })
  );
}

function refusedWith(outcome: Outcome): AdmissionError {
  if (outcome.ok) {
    throw new Error(
      `canonicalize resolved with ${outcome.value.length} bytes of N-Quads; want an AdmissionError`
    );
  }
  expect(outcome.error).toBeInstanceOf(AdmissionError);
  return outcome.error as AdmissionError;
}

function thrownBy(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

interface RdfTerm {
  termType: string;
  value: string;
  datatype?: { value: string };
  language?: string;
}

interface RdfQuad {
  subject: RdfTerm;
  predicate: RdfTerm;
  object: RdfTerm;
  graph: RdfTerm;
}

interface DatasetShape {
  blankNodes: number;
  // One entry per group of two or more blank nodes whose first-degree quads
  // coincide.
  duplicateGroups: string[][];
}

// The test's own serialization of one term for first-degree comparison. It
// only has to be injective over the terms toRDF emits, not N-Quads.
function firstDegreeTerm(t: RdfTerm, ref: string): string {
  if (t.termType === "BlankNode") return t.value === ref ? "_:a" : "_:z";
  if (t.termType === "DefaultGraph") return "@default";
  if (t.termType === "Literal") {
    return JSON.stringify(["L", t.value, t.datatype?.value ?? "", t.language ?? ""]);
  }
  return JSON.stringify(["I", t.value]);
}

// An independent reading of what the dataset rules look at: the distinct
// blank nodes of toRDF's output, and the groups whose sorted first-degree
// quads (reference node _:a, every other blank node _:z) are equal. A quad
// mentioning a node in several positions is listed once for that node.
async function toRdf(doc: unknown, loader: DocumentLoader): Promise<RdfQuad[]> {
  return (await jsonld.toRDF(copyDoc(doc) as JsonLdDocument, {
    documentLoader: loader.toJsonldLoader(),
    safe: false,
  } as Options.ToRdf)) as unknown as RdfQuad[];
}

async function measureDataset(doc: unknown, loader: DocumentLoader): Promise<DatasetShape> {
  const quads = await toRdf(doc, loader);
  const mentions = new Map<string, Set<RdfQuad>>();
  for (const q of quads) {
    for (const t of [q.subject, q.object, q.graph]) {
      if (t.termType !== "BlankNode") continue;
      let set = mentions.get(t.value);
      if (!set) {
        set = new Set();
        mentions.set(t.value, set);
      }
      set.add(q);
    }
  }
  const groups = new Map<string, string[]>();
  for (const [ref, qs] of mentions) {
    const lines = [...qs]
      .map((q) =>
        [q.subject, q.predicate, q.object, q.graph].map((t) => firstDegreeTerm(t, ref)).join(" ")
      )
      .sort();
    const sig = lines.join("\n");
    const members = groups.get(sig) ?? [];
    members.push(ref);
    groups.set(sig, members);
  }
  return {
    blankNodes: mentions.size,
    duplicateGroups: [...groups.values()].filter((g) => g.length > 1),
  };
}

// A PaymentRequest-context document with exactly 1024 blank nodes, or 1025
// with `extra`, inside the JSON budgets and with no two blank nodes alike at
// first degree. Only the "proof" graph container yields more blank nodes
// than JSON values (each proof object is both a graph name and the node
// inside it). The proofs are siblings in one array rather than a chain, so
// the document is six levels deep and far inside the depth budget:
//   - root, its @context string, the proof array and an empty "sender_auth"
//     object: 4 values, 2 blank nodes;
//   - three literal-free proof levels, the first holding only the second, the
//     second the third beside an empty "source" object, the third a literal
//     proof beside an empty "payment_request" object: 5 values, 8 blank nodes;
//   - 507 proofs each with its own "account" literal, one inside the third
//     literal-free level and the rest in the array: 2 values, 2 blank nodes
//     each, the literal telling apart the proof's node and its graph;
//   - with `extra`, an empty "destination" on the root: 1 value, 1 blank node.
// That is 1024 blank nodes in 1023 values, or 1025 in 1024. A literal proof
// pays for its two blank nodes with two values and the array costs one, so
// the surplus comes from the literal-free levels, each one value and two
// blank nodes. Each has a shape nothing else shares at first degree: their
// parents' graphs differ, and each empty object hangs under a key used
// nowhere else.
function blankNodeBoundaryDoc(extra: boolean): Record<string, unknown> {
  const literalProofs = 507;
  const third = { proof: { account: "a0" }, payment_request: {} };
  const second = { proof: third, source: {} };
  const proofs: unknown[] = [{ proof: second }];
  for (let i = 1; i < literalProofs; i++) proofs.push({ account: `a${i}` });
  const doc: Record<string, unknown> = {
    "@context": PAYMENT_REQUEST_CONTEXT_URL,
    proof: proofs,
    sender_auth: {},
  };
  if (extra) doc.destination = {};
  return doc;
}

// The fixed part of every label URDNA2015 issues: the n blank nodes of a
// dataset are relabelled _:c14n0 through _:c14n(n-1).
const CANONICAL_LABEL_PREFIX = "_:c14n";

// The test's own computation of the output-budget estimate. Each quad
// contributes the UTF-8 length of its N-Quad line as rdf-canonize serializes
// it, with every blank-node label in the subject, object and graph positions
// counted at the width of the widest canonical label instead of its toRDF
// label. No issued label is wider, so the sum bounds the canonical output
// from above.
async function outputEstimate(doc: unknown, loader: DocumentLoader): Promise<number> {
  const quads = await toRdf(doc, loader);
  const labels = new Set<string>();
  for (const q of quads) {
    for (const t of [q.subject, q.object, q.graph]) {
      if (t.termType === "BlankNode") labels.add(t.value);
    }
  }
  const width =
    labels.size > 0 ? CANONICAL_LABEL_PREFIX.length + String(labels.size - 1).length : 0;
  let total = 0;
  for (const q of quads) {
    total += utf8Bytes(rdfCanonize.NQuads.serializeQuad(q as unknown as Quad));
    for (const t of [q.subject, q.object, q.graph]) {
      if (t.termType === "BlankNode") total += width - utf8Bytes(t.value);
    }
  }
  return total;
}

// Opens the long IRI of outputBudgetDoc; the rest is filler. The scheme is
// not http or https because the Go half's json-gold drops an http(s) IRI of
// 2083 or more characters as invalid, and both halves must read the same
// shape the same way.
const OUTPUT_BUDGET_IRI_PREFIX = "urn:example:";

// The shape the output budget exists for: one node whose IRI is iriLen
// bytes long, typed VerifiableCredential so the credentials context defines
// issuanceDate on it, and the subject of one issuanceDate statement per
// literal. Every statement repeats the IRI in the output while the JSON
// carries it once, so the output grows as statements times iriLen.
//
// `subjects` adds that many credentialSubject entries, each a blank node told
// apart by its own issuanceDate literal, so that blank-node labels occur in
// the subject and object positions. `pad` lengthens the first literal, which
// the output carries once, so an estimate can be moved one byte at a time.
function outputBudgetDoc(
  iriLen: number,
  statements: number,
  subjects: number,
  pad: number
): Record<string, unknown> {
  if (iriLen < OUTPUT_BUDGET_IRI_PREFIX.length || statements < 1) {
    throw new Error(`outputBudgetDoc(${iriLen}, ${statements}): IRI shorter than its prefix or no statements`);
  }
  const dates = Array.from({ length: statements }, (_, i) => String(i).padStart(4, "0"));
  dates[0] += "x".repeat(pad);
  const doc: Record<string, unknown> = {
    "@context": W3C_VC_V1_CONTEXT_URL,
    id: OUTPUT_BUDGET_IRI_PREFIX + "i".repeat(iriLen - OUTPUT_BUDGET_IRI_PREFIX.length),
    type: "VerifiableCredential",
    issuanceDate: dates,
  };
  if (subjects > 0) {
    doc.credentialSubject = Array.from({ length: subjects }, (_, j) => ({
      type: "VerifiableCredential",
      issuanceDate: `s${j}`,
    }));
  }
  return doc;
}

// outputBudgetDoc with an estimate of exactly `target`: the IRI is grown to
// the longest that keeps the estimate within target, and the first literal
// padded by the remainder. It throws rather than return a document that
// misses the target.
async function outputBudgetDocAt(
  statements: number,
  subjects: number,
  target: number,
  loader: DocumentLoader
): Promise<Record<string, unknown>> {
  const base = 100;
  const estimate = (iriLen: number, pad: number): Promise<number> =>
    outputEstimate(outputBudgetDoc(iriLen, statements, subjects, pad), loader);
  const e0 = await estimate(base, 0);
  const step = (await estimate(base + 1, 0)) - e0;
  if (step <= 0 || target < e0) {
    throw new Error(`estimate ${e0} at IRI length ${base} grows by ${step} per byte; cannot reach ${target}`);
  }
  const iriLen = base + Math.floor((target - e0) / step);
  const pad = target - (await estimate(iriLen, 0));
  if (pad < 0) throw new Error(`estimate at IRI length ${iriLen} is over the target ${target}`);
  const doc = outputBudgetDoc(iriLen, statements, subjects, pad);
  const got = await outputEstimate(doc, loader);
  if (got !== target) throw new Error(`built a document estimated at ${got}, want ${target}`);
  return doc;
}

// One character of each UTF-8 width above one byte: é (2 bytes), € (3 bytes)
// and 😀 (4 bytes, a surrogate pair in UTF-16). An estimate that measured a
// line in UTF-16 code units or code points, or mis-sized any one width,
// would count this suffix short. Neither library's N-Quads serializer
// escapes any of them.
const OUTPUT_BUDGET_MULTIBYTE = "é€\u{1F600}";

// outputBudgetDoc widened to the named-graph and non-ASCII cases. The node
// with the iriLen-byte IRI is the subject of `statements` issuanceDate
// statements in the default graph and, when `graphStatements` is positive,
// of that many more inside its proof, which the credentials context declares
// a graph container: those quads sit in a graph named by a blank node, so
// their graph term both lengthens every line and carries a label the
// estimate must widen. With `multibyte`, every literal carries
// OUTPUT_BUDGET_MULTIBYTE. `pad` lengthens the first literal with ASCII so an
// estimate can be moved one byte at a time.
function outputBudgetGraphDoc(
  iriLen: number,
  statements: number,
  graphStatements: number,
  multibyte: boolean,
  pad: number
): Record<string, unknown> {
  if (iriLen < OUTPUT_BUDGET_IRI_PREFIX.length || statements < 1) {
    throw new Error(`outputBudgetGraphDoc(${iriLen}, ${statements}): IRI shorter than its prefix or no statements`);
  }
  const suffix = multibyte ? OUTPUT_BUDGET_MULTIBYTE : "";
  const literals = (prefix: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, "0")}${suffix}`);
  const iri = OUTPUT_BUDGET_IRI_PREFIX + "i".repeat(iriLen - OUTPUT_BUDGET_IRI_PREFIX.length);
  const dates = literals("", statements);
  dates[0] += "x".repeat(pad);
  const doc: Record<string, unknown> = {
    "@context": W3C_VC_V1_CONTEXT_URL,
    id: iri,
    type: "VerifiableCredential",
    issuanceDate: dates,
  };
  if (graphStatements > 0) {
    doc.proof = { id: iri, type: "VerifiableCredential", issuanceDate: literals("g", graphStatements) };
  }
  return doc;
}

// outputBudgetDocAt for outputBudgetGraphDoc: the IRI is grown to the longest
// that keeps the estimate within target and the first literal padded by the
// remainder, or it throws.
async function outputBudgetGraphDocAt(
  statements: number,
  graphStatements: number,
  multibyte: boolean,
  target: number,
  loader: DocumentLoader
): Promise<Record<string, unknown>> {
  const base = 100;
  const estimate = (iriLen: number, pad: number): Promise<number> =>
    outputEstimate(outputBudgetGraphDoc(iriLen, statements, graphStatements, multibyte, pad), loader);
  const e0 = await estimate(base, 0);
  const step = (await estimate(base + 1, 0)) - e0;
  if (step <= 0 || target < e0) {
    throw new Error(`estimate ${e0} at IRI length ${base} grows by ${step} per byte; cannot reach ${target}`);
  }
  const iriLen = base + Math.floor((target - e0) / step);
  const pad = target - (await estimate(iriLen, 0));
  if (pad < 0) throw new Error(`estimate at IRI length ${iriLen} is over the target ${target}`);
  const doc = outputBudgetGraphDoc(iriLen, statements, graphStatements, multibyte, pad);
  const got = await outputEstimate(doc, loader);
  if (got !== target) throw new Error(`built a document estimated at ${got}, want ${target}`);
  return doc;
}

// The test's reading of how much of a dataset the named-graph and non-ASCII
// cases reach: the quads in a graph named by a blank node, the part of the
// estimate they contribute at the dataset's own label width, and the
// literals carrying OUTPUT_BUDGET_MULTIBYTE.
async function measureGraphAndTextShare(
  doc: unknown,
  loader: DocumentLoader
): Promise<{ blankGraphQuads: number; blankGraphEstimate: number; multibyteLiterals: number }> {
  const quads = await toRdf(doc, loader);
  const labels = new Set<string>();
  for (const q of quads) {
    for (const t of [q.subject, q.object, q.graph]) {
      if (t.termType === "BlankNode") labels.add(t.value);
    }
  }
  const width = CANONICAL_LABEL_PREFIX.length + String(labels.size - 1).length;
  let blankGraphQuads = 0;
  let blankGraphEstimate = 0;
  let multibyteLiterals = 0;
  for (const q of quads) {
    if (q.object.termType === "Literal" && q.object.value.includes(OUTPUT_BUDGET_MULTIBYTE)) multibyteLiterals++;
    if (q.graph.termType !== "BlankNode") continue;
    blankGraphQuads++;
    blankGraphEstimate += utf8Bytes(rdfCanonize.NQuads.serializeQuad(q as unknown as Quad));
    for (const t of [q.subject, q.object, q.graph]) {
      if (t.termType === "BlankNode") blankGraphEstimate += width - utf8Bytes(t.value);
    }
  }
  return { blankGraphQuads, blankGraphEstimate, multibyteLiterals };
}

// The "(estimate N bytes)" a dataset vector's name states, or undefined.
function statedEstimate(name: string): number | undefined {
  const m = /\(estimate (\d+) bytes\)/.exec(name);
  return m ? Number(m[1]) : undefined;
}

// m proof objects, each holding the next. The credentials context declares
// proof a graph container, so each level is both a graph name and the node
// inside it: about two blank nodes per JSON value, which puts a document
// over the blank-node budget inside the value budget. The innermost node
// carries a type because jsonld.js drops an empty graph, and with it every
// level enclosing only that graph, where json-gold keeps them.
function nestedProofs(m: number): Record<string, unknown> {
  let next: Record<string, unknown> = { type: "VerifiableCredential" };
  for (let i = 0; i < m; i++) next = { proof: next };
  return next;
}

// k sibling copies of nestedProofs(m), for a value of the credentials
// context's proof term: k(m+1) proof objects, each a graph name and a node,
// in k(m+2)+1 values and m+2 levels below the array's parent.
function proofChains(k: number, m: number): Record<string, unknown>[] {
  return Array.from({ length: k }, () => nestedProofs(m));
}

const ALL_RULES = [
  "value-budget",
  "byte-budget",
  "reserved-key",
  "compact-iri-key",
  "context-shape",
  "blank-node-label",
  "ill-formed-string",
  "blank-node-budget",
  "output-budget",
  "indistinguishable-blank-nodes",
  "depth-budget",
  "tab-character",
] as const;

// Compile-time half of the wire-string check: an object literal typed by
// the union rejects a key the union lacks and requires every key it has.
const RULE_TABLE: Record<AdmissionRule, AdmissionRule> = {
  "value-budget": "value-budget",
  "byte-budget": "byte-budget",
  "reserved-key": "reserved-key",
  "compact-iri-key": "compact-iri-key",
  "context-shape": "context-shape",
  "blank-node-label": "blank-node-label",
  "ill-formed-string": "ill-formed-string",
  "blank-node-budget": "blank-node-budget",
  "output-budget": "output-budget",
  "indistinguishable-blank-nodes": "indistinguishable-blank-nodes",
  "depth-budget": "depth-budget",
  "tab-character": "tab-character",
};

function findVector<T extends AdmissionVector>(list: T[], prefix: string): T {
  const v = list.find((x) => x.name.startsWith(prefix));
  if (!v) throw new Error(`no admission vector named ${JSON.stringify(prefix)}...`);
  return v;
}

describe("AdmissionRule wire strings", () => {
  // The rule ids are a cross-language wire vocabulary compared against the
  // shared vector file, so their spelling is contract, not detail.
  it("reports each rule under exactly its wire string, with no two rules sharing one", async () => {
    expect(Object.keys(RULE_TABLE).sort()).toEqual([...ALL_RULES].sort());
    expect(new Set(ALL_RULES).size).toBe(ALL_RULES.length);

    // Each scenario breaks a different rule, so one scenario per rule, each
    // reporting a distinct string, is what shows no two rules share an id.
    const observed: string[] = [];
    const record = (label: string, err: unknown): void => {
      expect(err, label).toBeInstanceOf(AdmissionError);
      observed.push((err as AdmissionError).rule);
    };
    for (const [prefix, rule] of [
      ["value budget boundary: 1025 values", "value-budget"],
      ["reserved key @id nested in an object", "reserved-key"],
      ["compact IRI key at the root", "compact-iri-key"],
      ["inline @context object at the root", "context-shape"],
      ["blank node label string value", "blank-node-label"],
      ["depth budget boundary: 33 nested objects", "depth-budget"],
      ["tab character in a string value", "tab-character"],
    ] as const) {
      const v = findVector(VECTORS.refuse, prefix);
      const err = thrownBy(() => checkCanonicalizable(v.doc));
      record(prefix, err);
      expect((err as AdmissionError).rule).toBe(rule);
    }
    const overBytes = findVector(
      expandGenerated(VECTORS.generated.refuse),
      "byte budget boundary: 131073 bytes"
    );
    const byteErr = thrownBy(() => checkCanonicalizable(overBytes.doc));
    record("byte budget boundary", byteErr);
    expect((byteErr as AdmissionError).rule).toBe("byte-budget");

    // Built here rather than read from the shared file: Go's decoder repairs
    // lone surrogates, so the file cannot carry one.
    const illErr = thrownBy(() => checkCanonicalizable(JSON.parse(String.raw`{"\ud800x":1}`)));
    record("lone surrogate in a key", illErr);
    expect((illErr as AdmissionError).rule).toBe("ill-formed-string");

    const loader = datasetLoader();
    const dup = findVector(VECTORS.dataset.refuse, "indistinguishable blank nodes: two identical destination");
    const dupErr = refusedWith(await settle(canonicalize(copyDoc(dup.doc) as object, loader)));
    record("identical destination entries", dupErr);
    expect(dupErr.rule).toBe("indistinguishable-blank-nodes");

    const budgetErr = refusedWith(
      await settle(canonicalize(blankNodeBoundaryDoc(true), loader))
    );
    record("1025 blank nodes", budgetErr);
    expect(budgetErr.rule).toBe("blank-node-budget");

    const long = findVector(VECTORS.dataset.refuse, "output budget:");
    const outputErr = refusedWith(await settle(canonicalize(copyDoc(long.doc) as object, loader)));
    record("long-IRI node over the output budget", outputErr);
    expect(outputErr.rule).toBe("output-budget");

    expect(observed).toHaveLength(ALL_RULES.length);
    expect([...new Set(observed)].sort()).toEqual([...ALL_RULES].sort());
  });
});

describe("AdmissionError", () => {
  it("is an Error named AdmissionError carrying the rule and an RFC 6901 path", () => {
    const err = thrownBy(() => checkCanonicalizable({ a: { "@id": "x" } }));
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AdmissionError);
    const ae = err as AdmissionError;
    expect(ae.name).toBe("AdmissionError");
    expect(ae.rule).toBe("reserved-key");
    expect(ae.path).toBe("/a/@id");
  });

  it("uses the empty path for a document-wide refusal", () => {
    const v = findVector(VECTORS.refuse, "value budget boundary: 1025 values");
    const err = thrownBy(() => checkCanonicalizable(v.doc));
    expect(err).toBeInstanceOf(AdmissionError);
    expect((err as AdmissionError).path).toBe("");
  });
});

describe("checkCanonicalizable: shared vectors", () => {
  describe("accept", () => {
    for (const v of VECTORS.accept) {
      it(v.name, () => {
        expect(() => checkCanonicalizable(v.doc)).not.toThrow();
      });
    }
  });

  describe("refuse", () => {
    for (const v of VECTORS.refuse) {
      it(v.name, () => {
        const err = thrownBy(() => checkCanonicalizable(v.doc));
        expect(err).toBeInstanceOf(AdmissionError);
        const ae = err as AdmissionError;
        if (v.rule !== null) expect(ae.rule).toBe(v.rule);
        if (v.rule !== null && v.path !== null) expect(ae.path).toBe(v.path);
      });
    }
  });

  // JavaScript's default string order is UTF-16 code units, which puts
  // U+1F600 (a surrogate pair starting 0xD83D) before U+FF61; the contract
  // is code point order, which puts U+FF61 first. Insertion order also puts
  // U+1F600 first here, so neither shortcut can pass.
  it("reports the first offending sibling key in code point order, not UTF-16 order", () => {
    const v = findVector(VECTORS.refuse, "key order is code point order");
    const keys = Object.keys(v.doc as object);
    expect(keys).toHaveLength(2);
    const utf16First = [...keys].sort()[0];
    const codePointFirst = [...keys].sort((a, b) =>
      (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0)
    )[0];
    expect(utf16First).not.toBe(codePointFirst);
    expect(v.path).toBe(`/${codePointFirst}`);

    const err = thrownBy(() => checkCanonicalizable(v.doc));
    expect(err).toBeInstanceOf(AdmissionError);
    expect((err as AdmissionError).rule).toBe("compact-iri-key");
    expect((err as AdmissionError).path).toBe(`/${codePointFirst}`);
  });

  it("holds the value-budget boundary vectors at exactly 1024 and 1025 values", () => {
    expect(countValues(findVector(VECTORS.accept, "value budget boundary: exactly 1024 values").doc)).toBe(1024);
    expect(countValues(findVector(VECTORS.refuse, "value budget boundary: 1025 values").doc)).toBe(1025);
  });
});

describe("checkCanonicalizable: generated byte-budget vectors", () => {
  // The expander is this suite's reading of a grammar the Go half shares, so
  // every form the file calls a fixture error must be rejected and every
  // allowed form must expand exactly as described.
  describe("template grammar", () => {
    const valid: Array<[string, string, string]> = [
      ["repeat", `{"$repeat":"ab","$times":3}`, `"ababab"`],
      ["repeat zero times", `{"$repeat":"ab","$times":0}`, `""`],
      ["repeat count written with an exponent", `{"$repeat":"a","$times":2e0}`, `"aa"`],
      ["repeat nested in literal object and array", `{"a":[{"$repeat":"x","$times":2}],"b":1}`, `{"a":["xx"],"b":1}`],
      ["object with a templated key and value", `{"$object":[[{"$repeat":"k","$times":2},{"$repeat":"v","$times":2}]]}`, `{"kk":"vv"}`],
      ["empty object template", `{"$object":[]}`, `{}`],
      ["object template may produce a key beginning with $", `{"$object":[["$x",1]]}`, `{"$x":1}`],
      ["object template may produce the key __proto__ as an own member", `{"$object":[["__proto__",1]]}`, `{"__proto__":1}`],
      ["scalars unchanged", `[null,true,1.5,"$repeat"]`, `[null,true,1.5,"$repeat"]`],
    ];
    for (const [name, src, want] of valid) {
      it(`expands: ${name}`, () => {
        const got = expandTemplate(JSON.parse(src));
        expect(got).toStrictEqual(JSON.parse(want));
        expect(JSON.stringify(got)).toBe(JSON.stringify(JSON.parse(want)));
      });
    }
    const invalid: Array<[string, string]> = [
      ["repeat without times", `{"$repeat":"x"}`],
      ["repeat with an extra key", `{"$repeat":"x","$times":1,"a":1}`],
      ["repeat with a non-string s", `{"$repeat":1,"$times":1}`],
      ["repeat with a template as s", `{"$repeat":{"$repeat":"x","$times":1},"$times":1}`],
      ["repeat with a negative count", `{"$repeat":"x","$times":-1}`],
      ["repeat with a fractional count", `{"$repeat":"x","$times":1.5}`],
      ["repeat with a string count", `{"$repeat":"x","$times":"1"}`],
      ["repeat and object keys together", `{"$repeat":"x","$times":1,"$object":[]}`],
      ["object with an extra key", `{"$object":[],"a":1}`],
      ["object whose value is not an array", `{"$object":{"a":1}}`],
      ["object pair that is not an array", `{"$object":["a"]}`],
      ["object pair with one element", `{"$object":[["a"]]}`],
      ["object pair with three elements", `{"$object":[["a",1,2]]}`],
      ["object key that is not a string", `{"$object":[[1,1]]}`],
      ["object key that expands to a non-string", `{"$object":[[{"$object":[]},1]]}`],
      ["duplicate literal object keys", `{"$object":[["a",1],["a",2]]}`],
      ["duplicate expanded object keys", `{"$object":[[{"$repeat":"a","$times":2},1],["aa",2]]}`],
      ["literal key beginning with $", `{"$times":1}`],
      ["literal key beginning with $ nested in an array", `[{"a":{"$x":1}}]`],
      ["malformed template nested in an object value", `{"a":{"$repeat":"x"}}`],
      ["malformed template nested in an object pair value", `{"$object":[["a",{"$repeat":"x"}]]}`],
    ];
    for (const [name, src] of invalid) {
      it(`rejects: ${name}`, () => {
        expect(() => expandTemplate(JSON.parse(src))).toThrow(TemplateError);
      });
    }
  });

  // Expansion runs at collection time, so a malformed template in the file
  // fails the whole run instead of skipping its vector.
  const generatedAccept = expandGenerated(VECTORS.generated.accept);
  const generatedRefuse = expandGenerated(VECTORS.generated.refuse);

  describe("accept", () => {
    for (const g of generatedAccept) {
      it(g.name, () => {
        expect(countBytes(g.doc)).toBe(g.bytes);
        expect(g.bytes).toBeLessThanOrEqual(BYTE_BUDGET);
        expect(() => checkCanonicalizable(g.doc)).not.toThrow();
      });
    }
  });

  describe("refuse", () => {
    for (const g of generatedRefuse) {
      it(g.name, () => {
        expect(countBytes(g.doc)).toBe(g.bytes);
        expect(g.bytes).toBeGreaterThan(BYTE_BUDGET);
        const err = thrownBy(() => checkCanonicalizable(g.doc));
        expect(err).toBeInstanceOf(AdmissionError);
        const ae = err as AdmissionError;
        if (g.rule !== null) expect(ae.rule).toBe(g.rule);
        if (g.rule !== null && g.path !== null) expect(ae.path).toBe(g.path);
      });
    }
  });
});

describe("canonicalize: dataset vectors", () => {
  const loader = datasetLoader();

  // The dataset rules belong to canonicalize alone; every dataset vector is
  // clean JSON, so the pre-check must admit them all, refusals included.
  describe("checkCanonicalizable does not apply the dataset rules", () => {
    for (const v of [...VECTORS.dataset.accept, ...VECTORS.dataset.refuse]) {
      it(v.name, () => {
        expect(() => checkCanonicalizable(v.doc)).not.toThrow();
      });
    }
  });

  describe("accept: admitted and byte-identical to one-call jsonld.canonize", () => {
    for (const v of VECTORS.dataset.accept) {
      it(v.name, async () => {
        const want = await referenceCanonize(v.doc, loader);
        const got = await canonicalize(copyDoc(v.doc) as object, loader);
        expect(got).not.toBe("");
        expect(got).toBe(want);
      });
    }
  });

  describe(`refuse: AdmissionError with the vector's rule and path within ${REFUSAL_CEILING_MS} ms`, () => {
    for (const v of VECTORS.dataset.refuse) {
      it(v.name, async () => {
        expect(v.rule).not.toBeNull();
        expect(v.path).toBe("");
        const doc = copyDoc(v.doc) as object;
        const start = performance.now();
        const outcome = await settle(canonicalize(doc, loader));
        const elapsed = performance.now() - start;
        const ae = refusedWith(outcome);
        expect(ae.rule).toBe(v.rule);
        expect(ae.path).toBe(v.path);
        expect(elapsed).toBeLessThan(REFUSAL_CEILING_MS);
      });
    }
  });
});

describe("dataset vectors: independent first-degree oracle", () => {
  const loader = datasetLoader();

  it("pairs each refuse vector with an accept counterpart at the same index", () => {
    expect(VECTORS.dataset.accept).toHaveLength(VECTORS.dataset.refuse.length);
  });

  // Each refuse vector must break its own rule and clear every dataset rule
  // applied before it, or it would be refused under that rule instead.
  for (const v of VECTORS.dataset.refuse) {
    if (v.rule === "output-budget") {
      it(`refuse vector is estimated over the output budget: ${v.name}`, async () => {
        expect(await outputEstimate(v.doc, loader)).toBeGreaterThan(OUTPUT_BUDGET);
        const shape = await measureDataset(v.doc, loader);
        expect(shape.blankNodes).toBeLessThanOrEqual(BLANK_NODE_BUDGET);
      });
      continue;
    }
    it(`refuse vector has indistinguishable blank nodes: ${v.name}`, async () => {
      expect(v.rule).toBe("indistinguishable-blank-nodes");
      const shape = await measureDataset(v.doc, loader);
      expect(shape.duplicateGroups.length).toBeGreaterThan(0);
      expect(shape.blankNodes).toBeLessThanOrEqual(BLANK_NODE_BUDGET);
      expect(await outputEstimate(v.doc, loader)).toBeLessThanOrEqual(OUTPUT_BUDGET);
    });
  }

  for (const v of VECTORS.dataset.accept) {
    it(`accept vector has no indistinguishable blank nodes: ${v.name}`, async () => {
      const shape = await measureDataset(v.doc, loader);
      expect(shape.duplicateGroups).toEqual([]);
      expect(shape.blankNodes).toBeLessThanOrEqual(BLANK_NODE_BUDGET);
    });
    it(`accept vector is estimated within the output budget: ${v.name}`, async () => {
      expect(await outputEstimate(v.doc, loader)).toBeLessThanOrEqual(OUTPUT_BUDGET);
    });
  }

  // The output-budget pairs are the file's only coverage of that rule, and
  // must be exactly what outputBudgetDoc builds, so the file and the shape
  // described in their names cannot drift apart.
  it("holds the long-IRI output-budget pairs as outputBudgetDoc builds them", () => {
    const pairs = VECTORS.dataset.refuse
      .map((v, i) => [v, VECTORS.dataset.accept[i]] as const)
      .filter(([v]) => v.rule === "output-budget");
    expect(pairs).toHaveLength(2);
    const [[farRefuse, farAccept], [edgeRefuse, edgeAccept]] = pairs;
    expect(farRefuse.name).toMatch(/^output budget: one node with a 1500-byte IRI, the subject of 600 issuanceDate statements/);
    expect(farAccept.name).toMatch(/^within the output budget: the same 1500-byte IRI, the subject of 60 issuanceDate statements/);
    expect(farRefuse.doc).toStrictEqual(outputBudgetDoc(1500, 600, 0, 0));
    expect(farAccept.doc).toStrictEqual(outputBudgetDoc(1500, 60, 0, 0));
    expect(edgeRefuse.name).toMatch(
      /^output budget, one byte over: one node with a 1500-byte IRI, the subject of 80 issuanceDate statements, the first padded by 819 bytes/
    );
    expect(edgeAccept.name).toMatch(
      /^within the output budget, exactly at it: the same 1500-byte IRI, the subject of 80 issuanceDate statements, the first padded by 818 bytes/
    );
    expect(edgeRefuse.doc).toStrictEqual(outputBudgetDoc(1500, 80, 0, 819));
    expect(edgeAccept.doc).toStrictEqual(outputBudgetDoc(1500, 80, 0, 818));
  });

  // The boundary pair must sit on the budget itself, from both sides, so the
  // file alone pins where the budget is and not only that one exists.
  it(`holds an output-budget pair estimated at exactly ${OUTPUT_BUDGET + 1} and ${OUTPUT_BUDGET} bytes`, async () => {
    const i = VECTORS.dataset.refuse.findIndex((v) => v.name.startsWith("output budget, one byte over:"));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(VECTORS.dataset.refuse[i].rule).toBe("output-budget");
    expect(await outputEstimate(VECTORS.dataset.refuse[i].doc, loader)).toBe(OUTPUT_BUDGET + 1);
    expect(VECTORS.dataset.accept[i].name).toMatch(/^within the output budget, exactly at it:/);
    expect(await outputEstimate(VECTORS.dataset.accept[i].doc, loader)).toBe(OUTPUT_BUDGET);
  });

  // The estimate is defined identically in both languages, so each vector of
  // the output-budget pair is pinned to the exact estimate its name states
  // rather than to a side of the budget: a drift in either language's
  // estimator, or in the vectors, fails at once.
  describe("output-budget pair: estimated at exactly the number each name states", () => {
    const pairs = VECTORS.dataset.refuse
      .map((v, i) => [v, VECTORS.dataset.accept[i]] as const)
      .filter(([v]) => v.rule === "output-budget");

    it("has at least one output-budget pair", () => {
      expect(pairs.length).toBeGreaterThan(0);
    });

    for (const v of pairs.flat()) {
      it(v.name, async () => {
        const want = statedEstimate(v.name);
        expect(want, `${v.name} states no "(estimate N bytes)"`).toBeTypeOf("number");
        expect(await outputEstimate(v.doc, loader)).toBe(want);
      });
    }
  });
});

describe("canonicalize: blank-node budget boundary", () => {
  const loader = datasetLoader();

  it(`admits exactly ${BLANK_NODE_BUDGET} blank nodes, byte-identical to jsonld.canonize`, async () => {
    const doc = blankNodeBoundaryDoc(false);
    expect(() => checkCanonicalizable(doc)).not.toThrow();
    expect(jsonDepth(doc)).toBeLessThanOrEqual(DEPTH_BUDGET);
    const shape = await measureDataset(doc, loader);
    expect(shape.blankNodes).toBe(BLANK_NODE_BUDGET);
    expect(shape.duplicateGroups).toEqual([]);

    const want = await referenceCanonize(doc, loader);
    const got = await canonicalize(copyDoc(doc), loader);
    expect(got).toBe(want);
  });

  it(`refuses ${BLANK_NODE_BUDGET + 1} blank nodes with blank-node-budget and the empty path`, async () => {
    const doc = blankNodeBoundaryDoc(true);
    expect(() => checkCanonicalizable(doc)).not.toThrow();
    expect(jsonDepth(doc)).toBeLessThanOrEqual(DEPTH_BUDGET);
    const shape = await measureDataset(doc, loader);
    expect(shape.blankNodes).toBe(BLANK_NODE_BUDGET + 1);
    // With no indistinguishable nodes the only rule this can break is the cap.
    expect(shape.duplicateGroups).toEqual([]);

    const ae = refusedWith(await settle(canonicalize(copyDoc(doc), loader)));
    expect(ae.rule).toBe("blank-node-budget");
    expect(ae.path).toBe("");
  });
});

describe("canonicalize: output budget", () => {
  const loader = datasetLoader();

  // The cap from both sides, for a dataset without blank nodes and for one
  // whose blank-node labels occur as subject and object. Each fixture is
  // built and measured with the test's own estimator, and checked to break
  // no other rule, so the only rule the refused one can break is the cap.
  //
  // Ten blank nodes make every canonical label seven bytes long, where the
  // toRDF labels are four: an estimate that kept toRDF's labels, or sized the
  // canonical ones by the digits of n rather than of n-1, would land off the
  // boundary and flip one of the verdicts.
  describe("boundary", () => {
    for (const [shapeName, statements, subjects] of [
      ["no blank nodes", 500, 0],
      ["ten blank nodes", 500, 10],
    ] as const) {
      it(`${shapeName}: an estimate of exactly ${OUTPUT_BUDGET} bytes is admitted, byte-identical to jsonld.canonize`, async () => {
        const doc = await outputBudgetDocAt(statements, subjects, OUTPUT_BUDGET, loader);
        expect(() => checkCanonicalizable(doc)).not.toThrow();
        const shape = await measureDataset(doc, loader);
        expect(shape.blankNodes).toBe(subjects);
        expect(shape.duplicateGroups).toEqual([]);
        const estimate = await outputEstimate(doc, loader);
        expect(estimate).toBe(OUTPUT_BUDGET);

        const want = await referenceCanonize(doc, loader);
        const got = await canonicalize(copyDoc(doc), loader);
        expect(got).toBe(want);
        expect(utf8Bytes(want)).toBeLessThanOrEqual(estimate);
        // With no blank node to relabel, the canonical output is the
        // dataset's own lines sorted, so the estimate is its exact length;
        // anything else is a fault in the estimator itself.
        if (subjects === 0) expect(utf8Bytes(want)).toBe(estimate);
      });

      it(`${shapeName}: an estimate of ${OUTPUT_BUDGET + 1} bytes is refused with output-budget and the empty path`, async () => {
        const doc = await outputBudgetDocAt(statements, subjects, OUTPUT_BUDGET + 1, loader);
        expect(() => checkCanonicalizable(doc)).not.toThrow();
        const shape = await measureDataset(doc, loader);
        expect(shape.blankNodes).toBe(subjects);
        expect(shape.duplicateGroups).toEqual([]);
        expect(await outputEstimate(doc, loader)).toBe(OUTPUT_BUDGET + 1);

        const ae = refusedWith(await settle(canonicalize(copyDoc(doc), loader)));
        expect(ae.rule).toBe("output-budget");
        expect(ae.path).toBe("");
      });
    }
  });

  // The cap from both sides for the cases the single-graph ASCII fixtures
  // cannot see: quads inside a graph named by a blank node, literals of
  // multi-byte UTF-8 characters, and both at once. Most of the estimate of
  // each named-graph fixture comes from the named graph, so an estimate that
  // kept the graph name's shorter toRDF label would fall short of the refused
  // fixture's and admit it; likewise one that measured the multi-byte
  // characters in UTF-16 code units, or mis-sized any one UTF-8 width.
  describe("boundary: named graphs and multi-byte text", () => {
    for (const [shapeName, statements, graphStatements, multibyte] of [
      ["named graph with a blank name", 100, 400, false],
      ["multi-byte UTF-8 literals", 500, 0, true],
      ["multi-byte UTF-8 literals in a named graph with a blank name", 100, 400, true],
    ] as const) {
      const blankNodes = graphStatements > 0 ? 1 : 0;
      // The proof graph holds each of its statements and the node's type.
      const graphQuads = graphStatements > 0 ? graphStatements + 1 : 0;
      const multibyteLiterals = multibyte ? statements + graphStatements : 0;

      async function checkFixture(doc: Record<string, unknown>, target: number): Promise<void> {
        expect(() => checkCanonicalizable(doc)).not.toThrow();
        const shape = await measureDataset(doc, loader);
        expect(shape.blankNodes).toBe(blankNodes);
        expect(shape.duplicateGroups).toEqual([]);
        const estimate = await outputEstimate(doc, loader);
        expect(estimate).toBe(target);
        const share = await measureGraphAndTextShare(doc, loader);
        expect(share.blankGraphQuads).toBe(graphQuads);
        if (graphStatements > 0) expect(2 * share.blankGraphEstimate).toBeGreaterThan(estimate);
        expect(share.multibyteLiterals).toBe(multibyteLiterals);
      }

      it(`${shapeName}: an estimate of exactly ${OUTPUT_BUDGET} bytes is admitted, byte-identical to jsonld.canonize`, async () => {
        const doc = await outputBudgetGraphDocAt(statements, graphStatements, multibyte, OUTPUT_BUDGET, loader);
        await checkFixture(doc, OUTPUT_BUDGET);

        const want = await referenceCanonize(doc, loader);
        const got = await canonicalize(copyDoc(doc), loader);
        expect(got).toBe(want);
        expect(utf8Bytes(want)).toBeLessThanOrEqual(OUTPUT_BUDGET);
        expect(want.split(OUTPUT_BUDGET_MULTIBYTE).length - 1).toBe(multibyteLiterals);
        // Without a blank node the canonical output is the dataset's own
        // lines sorted, so the estimate is its exact length.
        if (blankNodes === 0) expect(utf8Bytes(want)).toBe(OUTPUT_BUDGET);
      });

      it(`${shapeName}: an estimate of ${OUTPUT_BUDGET + 1} bytes is refused with output-budget and the empty path`, async () => {
        const doc = await outputBudgetGraphDocAt(statements, graphStatements, multibyte, OUTPUT_BUDGET + 1, loader);
        await checkFixture(doc, OUTPUT_BUDGET + 1);

        const ae = refusedWith(await settle(canonicalize(copyDoc(doc), loader)));
        expect(ae.rule).toBe("output-budget");
        expect(ae.path).toBe("");
      });
    }
  });

  // canonicalize applies the dataset rules in a fixed order: the blank-node
  // budget, then the output budget, then indistinguishable blank nodes. Each
  // fixture breaks two of them, measured here so it cannot silently stop
  // breaking either.
  describe("precedence", () => {
    it("reports blank-node-budget for a document over both the blank-node and the output budget", async () => {
      // Many short chains rather than a few long ones, so the document stays
      // inside the depth budget: 25 chains of 21 proofs are 1050 blank nodes
      // in 551 values, nested 23 levels deep.
      const doc = outputBudgetDoc(5000, 400, 0, 0);
      doc.proof = proofChains(25, 20);
      expect(jsonDepth(doc)).toBeLessThanOrEqual(DEPTH_BUDGET);
      expect(() => checkCanonicalizable(doc)).not.toThrow();
      expect((await measureDataset(doc, loader)).blankNodes).toBeGreaterThan(BLANK_NODE_BUDGET);
      expect(await outputEstimate(doc, loader)).toBeGreaterThan(OUTPUT_BUDGET);

      const ae = refusedWith(await settle(canonicalize(copyDoc(doc), loader)));
      expect(ae.rule).toBe("blank-node-budget");
      expect(ae.path).toBe("");
    });

    it("reports output-budget for a document over the output budget with indistinguishable blank nodes", async () => {
      const doc = outputBudgetDoc(1500, 600, 0, 0);
      doc.credentialSubject = [{}, {}];
      expect(() => checkCanonicalizable(doc)).not.toThrow();
      const shape = await measureDataset(doc, loader);
      expect(shape.duplicateGroups.length).toBeGreaterThan(0);
      expect(shape.blankNodes).toBeLessThanOrEqual(BLANK_NODE_BUDGET);
      expect(await outputEstimate(doc, loader)).toBeGreaterThan(OUTPUT_BUDGET);

      const ae = refusedWith(await settle(canonicalize(copyDoc(doc), loader)));
      expect(ae.rule).toBe("output-budget");
      expect(ae.path).toBe("");
    });
  });

  // Serializing the dataset is itself the cost the budget bounds, so a
  // document estimated at many times the budget must be refused without
  // paying it. V8 concatenates strings lazily, so here unguarded
  // canonicalization was measured under this ceiling as well: the ceiling
  // guards against a gross slowdown, and the next test is what shows the
  // refusal stops early. It is looser than REFUSAL_CEILING_MS so that a busy
  // shared CI runner does not fail it.
  const GROSS_SLOWDOWN_CEILING_MS = 1000;
  it(`refuses a document estimated at over 50 times the budget within ${GROSS_SLOWDOWN_CEILING_MS} ms`, async () => {
    const doc = outputBudgetDoc(40000, 1000, 0, 0);
    expect(() => checkCanonicalizable(doc)).not.toThrow();
    expect(await outputEstimate(doc, loader)).toBeGreaterThanOrEqual(50 * OUTPUT_BUDGET);

    const input = copyDoc(doc);
    const start = performance.now();
    const outcome = await settle(canonicalize(input, loader));
    const elapsed = performance.now() - start;
    const ae = refusedWith(outcome);
    expect(ae.rule).toBe("output-budget");
    expect(ae.path).toBe("");
    expect(elapsed).toBeLessThan(GROSS_SLOWDOWN_CEILING_MS);
  });

  // Every N-Quad line rdf-canonize writes goes through
  // serializeQuadComponents, serializeQuad included, so counting its calls
  // counts the lines serialized. Each line of this document carries its
  // 40000-byte IRI, so the running estimate passes the budget within the
  // first 14 lines, where a full pass writes all 1001. Fewer than 100 leaves
  // room for an implementation that serializes a line more than once.
  it("refuses a document estimated at over 50 times the budget having serialized a small fraction of it", async () => {
    const doc = outputBudgetDoc(40000, 1000, 0, 0);
    expect(await toRdf(doc, loader)).toHaveLength(1001);
    expect(await outputEstimate(doc, loader)).toBeGreaterThanOrEqual(50 * OUTPUT_BUDGET);

    const nquads = rdfCanonize.NQuads as unknown as {
      serializeQuadComponents: (...args: unknown[]) => string;
    };
    const spy = vi.spyOn(nquads, "serializeQuadComponents");
    try {
      const ae = refusedWith(await settle(canonicalize(copyDoc(doc), loader)));
      expect(ae.rule).toBe("output-budget");
      expect(ae.path).toBe("");
      expect(spy.mock.calls.length).toBeLessThan(100);
    } finally {
      spy.mockRestore();
    }
  });
});

// A real loader that counts every URL jsonld.js asks it for, so a test can
// observe whether JSON-LD processing started at all.
class CountingLoader extends DocumentLoader {
  requests = 0;
  override toJsonldLoader(): Options.DocLoader["documentLoader"] {
    const inner = super.toJsonldLoader() as unknown as (url: string) => Promise<unknown>;
    return (async (url: string) => {
      this.requests++;
      return inner(url);
    }) as unknown as Options.DocLoader["documentLoader"];
  }
}

describe("canonicalize applies the JSON pre-check first", () => {
  const exact = [...VECTORS.refuse, ...expandGenerated(VECTORS.generated.refuse)].filter(
    (v) => v.rule !== null && v.path !== null
  );

  // canonicalize must hand back the pre-check's own verdict, not a wrapped or
  // re-derived one; only single-rule, single-location vectors are compared.
  describe("rejects with the same AdmissionError checkCanonicalizable reports", () => {
    for (const v of exact) {
      it(v.name, async () => {
        const ae = refusedWith(await settle(canonicalize(v.doc as object, newDocumentLoader())));
        expect(ae.rule).toBe(v.rule);
        expect(ae.path).toBe(v.path);
      });
    }
  });

  it("refuses the multi-rule clique vector with an AdmissionError", async () => {
    const v = findVector(VECTORS.refuse, "clique:");
    refusedWith(await settle(canonicalize(v.doc as object, newDocumentLoader())));
  });

  // If JSON-LD processing ran, the strict loader would fail on the unknown
  // URL; getting the admission error instead shows the check came first.
  it("reports AdmissionError, not UnknownContextError, for a refused document naming an unregistered context", async () => {
    const doc = { "@context": "https://unregistered.example/context.jsonld", a: "_:b0" };
    const outcome = await settle(canonicalize(doc, newDocumentLoader()));
    const ae = refusedWith(outcome);
    expect(outcome.ok ? undefined : outcome.error).not.toBeInstanceOf(UnknownContextError);
    expect(ae.rule).toBe("blank-node-label");
    expect(ae.path).toBe("/a");
  });

  it("asks the loader for no context when the JSON pre-check refuses", async () => {
    const loader = new CountingLoader();
    const doc = { "@context": W3C_VC_V1_CONTEXT_URL, "atum:k": 1 };
    const ae = refusedWith(await settle(canonicalize(doc, loader)));
    expect(ae.rule).toBe("compact-iri-key");
    expect(ae.path).toBe("/atum:k");
    expect(loader.requests).toBe(0);
  });

  // Where jsonld.js normalizes an accept vector, canonicalize must return the
  // same bytes; where jsonld.js fails (a context no loader resolves),
  // canonicalize must fail too, and not by calling the document inadmissible.
  for (const [loaderName, makeLoader] of [
    ["vendored loader", () => newDocumentLoader()],
    ["loader with the PaymentRequest context", datasetLoader],
  ] as const) {
    describe(`accept vectors under the ${loaderName}`, () => {
      for (const v of [...VECTORS.accept, ...expandGenerated(VECTORS.generated.accept)]) {
        it(v.name, async () => {
          const loader = makeLoader();
          const want = await settle(referenceCanonize(v.doc, loader));
          const got = await settle(canonicalize(copyDoc(v.doc) as object, loader));
          if (!want.ok) {
            expect(got.ok).toBe(false);
            expect(got.ok ? undefined : got.error).not.toBeInstanceOf(AdmissionError);
            return;
          }
          expect(got).toEqual({ ok: true, value: want.value });
        });
      }
    });
  }
});

// A lone surrogate is a UTF-16 code unit in U+D800-U+DFFF not paired into a
// code point. With the u flag a valid pair is one code point and does not
// match, so this is the test's own oracle for ill-formed text, independent of
// String.prototype.isWellFormed.
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDFFF]/u.test(s);
}

// Every string in the parsed document, keys included, for guarding fixtures.
function allStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  if (isPlainObject(v)) return Object.keys(v).flatMap((k) => [k, ...allStrings(v[k])]);
  return [];
}

// JSON text is how untrusted input arrives, and JSON.parse keeps a lone
// surrogate escape as a lone code unit. Go cannot observe these documents,
// because encoding/json replaces lone surrogates with U+FFFD while decoding,
// so they live here and not in the shared vector file.
describe("checkCanonicalizable: ill-formed strings", () => {
  // [name, JSON text, rule, path]. Paths hold the offending key verbatim, lone
  // surrogate included, escaped per RFC 6901 like any other key.
  const refused: Array<[string, string, AdmissionRule, string]> = [
    ["lone high surrogate in a root key", String.raw`{"\ud800x":1}`, "ill-formed-string", "/\ud800x"],
    ["lone low surrogate in a nested key", String.raw`{"a":{"b\udc00":1}}`, "ill-formed-string", "/a/b\udc00"],
    ["lone surrogate in a key inside an array element", String.raw`{"a":[{"k\udbff":1}]}`, "ill-formed-string", "/a/0/k\udbff"],
    ["lone surrogate in a key needing JSON Pointer escaping", String.raw`{"a/b~\ud800":1}`, "ill-formed-string", "/a~1b~0\ud800"],
    ["lone surrogate in a key whose value is empty", String.raw`{"\ud800":""}`, "ill-formed-string", "/\ud800"],
    ["lone low surrogate at the end of a nested string value", String.raw`{"a":{"b":"x\udc00"}}`, "ill-formed-string", "/a/b"],
    ["lone high surrogate at the end of a string value", String.raw`{"a":"x\ud83d"}`, "ill-formed-string", "/a"],
    ["lone surrogate string as an array element", String.raw`{"a":[1,"ok","\ud800"]}`, "ill-formed-string", "/a/2"],
    ["surrogates in reversed order, low before high", String.raw`{"a":"\ude00\ud83d"}`, "ill-formed-string", "/a"],
    ["lone surrogate beside a valid pair", String.raw`{"a":"\ud83d\ude00\ud800"}`, "ill-formed-string", "/a"],
    ["lone surrogate in the @context string", String.raw`{"@context":"https://www.w3.org/2018/credentials/v1\udfff"}`, "ill-formed-string", "/@context"],
    ["lone surrogate in a string of an @context array", String.raw`{"@context":["https://www.w3.org/2018/credentials/v1","\ud800"]}`, "ill-formed-string", "/@context/1"],
    ["lone surrogate string as the whole document", String.raw`"\ud800"`, "ill-formed-string", ""],
    ["lone surrogate string inside a root array", String.raw`[{"a":1},"\udc00"]`, "ill-formed-string", "/1"],
  ];

  for (const [name, text, rule, path] of refused) {
    it(`refuses: ${name}`, () => {
      const doc: unknown = JSON.parse(text);
      expect(allStrings(doc).some(hasLoneSurrogate), "fixture must hold a lone surrogate").toBe(true);
      const err = thrownBy(() => checkCanonicalizable(doc));
      expect(err).toBeInstanceOf(AdmissionError);
      expect((err as AdmissionError).rule).toBe(rule);
      expect((err as AdmissionError).path).toBe(path);
    });
  }

  // Valid pairs are single code points and must not be mistaken for lone
  // surrogates; U+FFFD is what Go sees after repair, so TypeScript must admit
  // it too or the two halves would disagree on a document both can observe.
  const admitted: Array<[string, string]> = [
    ["emoji key and value", String.raw`{"\ud83d\ude00":"\ud83d\ude00"}`],
    ["highest code point as an array element string", String.raw`{"a":["\udbff\udfff"]}`],
    ["lowest supplementary code point as a key", String.raw`{"\ud800\udc00":1}`],
    ["emoji inside a nested string value", String.raw`{"a":{"b":["x\ud83d\ude00y"]}}`],
    ["replacement character U+FFFD in a key and a value", String.raw`{"\ufffd":"\ufffd"}`],
    ["characters just outside the surrogate range", String.raw`{"\ud7ff":"\ue000"}`],
  ];

  for (const [name, text] of admitted) {
    it(`admits: ${name}`, () => {
      const doc: unknown = JSON.parse(text);
      expect(allStrings(doc).some(hasLoneSurrogate), "fixture must be well-formed").toBe(false);
      expect(() => checkCanonicalizable(doc)).not.toThrow();
    });
  }

  // Precedence follows the walk: an object member's key bytes are counted,
  // then its key is judged, then its value is walked; a string value's bytes
  // are counted, then it is judged. Well-formedness is judged first among a
  // string's own rules, since the syntax rules read text that is not valid.
  describe("precedence", () => {
    const cases: Array<[string, () => unknown, AdmissionRule, string]> = [
      [
        "an ill-formed key is reported before a reserved-key violation in the same key",
        () => JSON.parse(String.raw`{"@\ud800":1}`),
        "ill-formed-string",
        "/@\ud800",
      ],
      [
        "an ill-formed key is reported before a compact-iri-key violation in the same key",
        () => JSON.parse(String.raw`{"a:\ud800":1}`),
        "ill-formed-string",
        "/a:\ud800",
      ],
      [
        "an ill-formed string value is reported before its blank-node-label violation",
        () => JSON.parse(String.raw`{"a":"_:\ud800"}`),
        "ill-formed-string",
        "/a",
      ],
      [
        "an ill-formed key is reported before any violation in its value",
        () => JSON.parse(String.raw`{"\ud800":{"@id":"_:b0"}}`),
        "ill-formed-string",
        "/\ud800",
      ],
      [
        "an inline @context object is refused by shape before its ill-formed contents are walked",
        () => JSON.parse(String.raw`{"@context":{"x":"\ud800"}}`),
        "context-shape",
        "/@context",
      ],
      [
        "a reserved key is reported before the ill-formed string it holds",
        () => JSON.parse(String.raw`{"@id":"\ud800"}`),
        "reserved-key",
        "/@id",
      ],
      [
        "a compact IRI key is reported before the ill-formed string it holds",
        () => JSON.parse(String.raw`{"ex:p":"\ud800"}`),
        "compact-iri-key",
        "/ex:p",
      ],
      [
        "an earlier sibling in code point order is reported first: ill-formed before blank-node-label",
        () => JSON.parse(String.raw`{"b":"_:b0","a":"\ud800"}`),
        "ill-formed-string",
        "/a",
      ],
      [
        "an earlier sibling in code point order is reported first: blank-node-label before ill-formed",
        () => JSON.parse(String.raw`{"b":"\ud800","a":"_:b0"}`),
        "blank-node-label",
        "/a",
      ],
      [
        "an earlier array element is reported first",
        () => JSON.parse(String.raw`{"a":["_:b0","\ud800"]}`),
        "blank-node-label",
        "/a/0",
      ],
      // The ASCII run alone exceeds the budget, so this holds whatever width
      // the lone surrogate is counted at.
      [
        "the byte budget is counted before an ill-formed string value is judged",
        () => JSON.parse(`{"a":"${"x".repeat(BYTE_BUDGET + 1)}\\ud800"}`),
        "byte-budget",
        "",
      ],
      [
        "the byte budget is counted before an ill-formed key is judged",
        () => JSON.parse(`{"${"k".repeat(BYTE_BUDGET + 1)}\\udc00":1}`),
        "byte-budget",
        "",
      ],
      [
        "the value budget is reached before a later ill-formed string",
        () => JSON.parse(`{"a":[${Array.from({ length: 1023 }, () => "0").join(",")}],"b":"\\ud800"}`),
        "value-budget",
        "",
      ],
    ];

    for (const [name, build, rule, path] of cases) {
      it(name, () => {
        const doc = build();
        expect(allStrings(doc).some(hasLoneSurrogate), "fixture must hold a lone surrogate").toBe(true);
        const err = thrownBy(() => checkCanonicalizable(doc));
        expect(err).toBeInstanceOf(AdmissionError);
        expect((err as AdmissionError).rule).toBe(rule);
        expect((err as AdmissionError).path).toBe(path);
      });
    }
  });

  describe("canonicalize rejects with the same AdmissionError, before JSON-LD processing", () => {
    // canonicalize takes an object or array; jsonld.js would read a bare
    // string document as a URL to fetch.
    for (const [name, text, rule, path] of refused.filter(([, t]) => !t.startsWith('"'))) {
      it(name, async () => {
        const loader = new CountingLoader();
        const ae = refusedWith(await settle(canonicalize(JSON.parse(text) as object, loader)));
        expect(ae.rule).toBe(rule);
        expect(ae.path).toBe(path);
        expect(loader.requests).toBe(0);
      });
    }

    it("asks the loader for no context when a registered @context sits beside an ill-formed value", async () => {
      const loader = new CountingLoader();
      const doc = JSON.parse(
        `{"@context":${JSON.stringify(W3C_VC_V1_CONTEXT_URL)},"type":"VerifiableCredential","issuer":"did:web:x\\ud800"}`
      ) as object;
      const ae = refusedWith(await settle(canonicalize(doc, loader)));
      expect(ae.rule).toBe("ill-formed-string");
      expect(ae.path).toBe("/issuer");
      expect(loader.requests).toBe(0);
    });

    // An unregistered context would make the strict loader fail if JSON-LD
    // processing ran, so the admission error shows the check came first.
    it("reports AdmissionError, not UnknownContextError, for an ill-formed document naming an unregistered context", async () => {
      const doc = JSON.parse(
        String.raw`{"@context":"https://unregistered.example/context.jsonld","a":"\ud800"}`
      ) as object;
      const outcome = await settle(canonicalize(doc, newDocumentLoader()));
      const ae = refusedWith(outcome);
      expect(outcome.ok ? undefined : outcome.error).not.toBeInstanceOf(UnknownContextError);
      expect(ae.rule).toBe("ill-formed-string");
      expect(ae.path).toBe("/a");
    });
  });
});

// The length in UTF-8 bytes up to which the vector file carries an expected
// output verbatim; a longer one is carried as its SHA-256 and length.
// Restated from the file's comment rather than derived from the file, so the
// guard checks the file against the contract.
const GOLDEN_INLINE_LIMIT = 4096;

function hasGolden(v: AdmissionVector): boolean {
  return v.nquads !== undefined || v.nquads_sha256 !== undefined || v.nquads_length !== undefined;
}

function expectGolden(got: string, v: AdmissionVector): void {
  if (v.nquads !== undefined) {
    expect(got).toBe(v.nquads);
    return;
  }
  expect({
    sha256: createHash("sha256").update(got, "utf8").digest("hex"),
    length: utf8Bytes(got),
  }).toEqual({ sha256: v.nquads_sha256, length: v.nquads_length });
}

// The accept vectors by the section of the file they come from, with the
// flag set where the file's comment requires an expected output.
const GOLDEN_SECTIONS: ReadonlyArray<readonly [string, AdmissionVector[], boolean]> = [
  ["accept", VECTORS.accept, false],
  ["generated.accept", expandGenerated(VECTORS.generated.accept), false],
  ["dataset.accept", VECTORS.dataset.accept, true],
];

describe("accept vectors: the expected output shared with Go", () => {
  // Guards the expected outputs themselves: each is in exactly one of the two
  // forms, the form its length calls for; every dataset accept vector carries
  // one; and every other accept vector carries one or a known-divergence
  // reason exactly when jsonld.js canonicalizes it under the richer of the two
  // loaders. A vector that stopped carrying its expected output would
  // otherwise drop out of the cross-language comparison unnoticed.
  describe("each expected output follows the file's format", () => {
    for (const [section, list, required] of GOLDEN_SECTIONS) {
      for (const v of list) {
        it(`${section}: ${v.name}`, async () => {
          if (v.nquads !== undefined) {
            expect(typeof v.nquads).toBe("string");
            expect(v.nquads_sha256).toBeUndefined();
            expect(v.nquads_length).toBeUndefined();
            expect(utf8Bytes(v.nquads)).toBeLessThanOrEqual(GOLDEN_INLINE_LIMIT);
          } else if (v.nquads_sha256 !== undefined || v.nquads_length !== undefined) {
            expect(v.nquads_sha256).toMatch(/^[0-9a-f]{64}$/);
            expect(Number.isInteger(v.nquads_length)).toBe(true);
            expect(v.nquads_length).toBeGreaterThan(GOLDEN_INLINE_LIMIT);
          }
          if (v.known_divergence !== undefined) {
            expect(hasGolden(v)).toBe(false);
            expect(v.known_divergence.trim()).not.toBe("");
            expect(v.known_divergence).not.toContain("\n");
          }
          if (required) {
            expect(hasGolden(v), "a dataset accept vector must carry an expected output").toBe(true);
            expect(v.known_divergence).toBeUndefined();
            return;
          }
          const reference = await settle(referenceCanonize(v.doc, datasetLoader()));
          const marked = hasGolden(v) || v.known_divergence !== undefined;
          expect(marked, `jsonld.js canonicalizes the vector: ${reference.ok}`).toBe(reference.ok);
        });
      }
    }

    it("carries at least one expected output, and none on a refuse vector", () => {
      expect(GOLDEN_SECTIONS.flatMap(([, list]) => list).filter(hasGolden).length).toBeGreaterThan(0);
      for (const v of [...VECTORS.refuse, ...VECTORS.generated.refuse, ...VECTORS.dataset.refuse]) {
        expect(hasGolden(v) || v.known_divergence !== undefined, v.name).toBe(false);
      }
    });
  });

  // The expected outputs are what every implementation must produce, so a
  // byte of difference between the languages fails in at least one of them.
  // The vendored loader alone resolves only some vectors' contexts; the loader
  // with the PaymentRequest context must resolve every one.
  for (const [loaderName, makeLoader, mustResolve] of [
    ["vendored loader", () => newDocumentLoader(), false],
    ["loader with the PaymentRequest context", datasetLoader, true],
  ] as const) {
    describe(`canonicalize returns the expected output under the ${loaderName}`, () => {
      for (const [section, list] of GOLDEN_SECTIONS) {
        for (const v of list.filter(hasGolden)) {
          it(`${section}: ${v.name}`, async () => {
            const loader = makeLoader();
            const reference = await settle(referenceCanonize(v.doc, loader));
            if (!reference.ok) {
              expect(mustResolve, "jsonld.js cannot canonicalize a vector carrying an expected output").toBe(false);
              return;
            }
            expectGolden(await canonicalize(copyDoc(v.doc) as object, loader), v);
          });
        }
      }
    });
  }

  describe("a vector with a known divergence is still admitted", () => {
    for (const [section, list] of GOLDEN_SECTIONS) {
      for (const v of list.filter((x) => x.known_divergence !== undefined)) {
        it(`${section}: ${v.name}`, async () => {
          const outcome = await settle(canonicalize(copyDoc(v.doc) as object, datasetLoader()));
          expect(outcome.ok ? undefined : outcome.error).toBeUndefined();
        });
      }
    }
  });

  // The vectors the file's comment names as known to canonicalize
  // differently, restated rather than derived from the markers so a marker
  // added to or dropped from any other vector fails, each with this side's
  // own output: its length and SHA-256 and the lines whose presence
  // (`contains`) or absence (`lacks`) makes it differ from json-gold's. Pinning
  // it is what makes the marker fail once the implementations agree, instead
  // of skipping the comparison for good. `datasetContextsOnly` marks a vector
  // naming a context only the file's dataset.contexts supplies, which must
  // fail under the vendored loader alone instead of canonicalizing.
  interface KnownDivergence {
    length: number;
    sha256: string;
    contains: string[];
    lacks: string[];
    datasetContextsOnly: boolean;
  }

  const httpsIriOfLength = (n: number): string => {
    const prefix = "https://e.x/";
    return prefix + "a".repeat(n - prefix.length);
  };

  // The credential's type statement alone: what jsonld.js leaves of every
  // vector whose proof graph container holds nothing it turns into a
  // statement, or holds a scalar, which it drops.
  const TYPE_ONLY = {
    length: 119,
    sha256: "9cd1c6821d482f5047b0438a2658dea5c1c27b89b252a9415496064e59c6d1fe",
  };
  const EMPTY_OUTPUT_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const PROOF_PREDICATE = "<https://w3id.org/security#proof>";
  const droppedProofGraph: KnownDivergence = {
    ...TYPE_ONLY,
    contains: [],
    lacks: [PROOF_PREDICATE],
    datasetContextsOnly: false,
  };
  // jsonld.js keeps the issuer statement json-gold's IRI check drops.
  const keptIssuer = (length: number, sha256: string, iri: string): KnownDivergence => ({
    length,
    sha256,
    contains: [`<urn:x> <https://www.w3.org/2018/credentials#issuer> <${iri}> .`],
    lacks: [],
    datasetContextsOnly: false,
  });
  // jsonld.js keeps the node whose id json-gold judges an invalid http(s) IRI.
  const keptHttpsId = (length: number, sha256: string, iri: string): KnownDivergence => ({
    length,
    sha256,
    contains: [`<${iri}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> `],
    lacks: [],
    datasetContextsOnly: false,
  });

  const KNOWN_DIVERGENCES: Record<string, KnownDivergence> = {
    "verifiable presentation embedding one credential as an array element": {
      length: 707,
      sha256: "1f19861ebf609aa7f22500ac22b0bff044d094dc5648098e619bfcc8a19b781d",
      // jsonld.js drops the undefined proof type terms, where json-gold
      // keeps them as relative-IRI rdf:type objects.
      contains: [],
      lacks: [
        "<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <Ed25519Signature2020> ",
        "<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <EcdsaSecp256k1RecoverySignature2020> ",
      ],
      datasetContextsOnly: false,
    },

    "hollow graph container: an empty proof object": droppedProofGraph,
    "hollow graph container: a proof holding only an empty proof": droppedProofGraph,
    "hollow graph container: a proof holding only a term the context does not define": droppedProofGraph,
    "hollow graph container: a proof holding only an id": droppedProofGraph,
    "hollow graph container: a proof that is an IRI string": droppedProofGraph,

    // jsonld.js drops the statement as an invalid IRI, leaving nothing.
    "IRI with a space: a credential id holding U+0020": {
      length: 0,
      sha256: EMPTY_OUTPUT_SHA256,
      contains: [],
      lacks: ["<urn:a b>"],
      datasetContextsOnly: false,
    },

    // rdf-canonize writes the IRI's backslash and double quote as they are,
    // where json-gold escapes them with a backslash.
    "IRI escaping: a credential id holding a backslash": {
      length: 121,
      sha256: "ce29ca136677a4af909efc912cf69f32646fcd1a86bdb7e6a8123e3a51d2068d",
      contains: ["<urn:a\\b> "],
      lacks: ["<urn:a\\\\b>"],
      datasetContextsOnly: false,
    },
    "IRI escaping: a credential id holding a double quote": {
      length: 121,
      sha256: "d3ff0ccd45557a0cb71ac0d6bc0976ea2c1822be79b75d1b7e96b3e2e966b5fe",
      contains: ['<urn:a"b> '],
      lacks: ['<urn:a\\"b>'],
      datasetContextsOnly: false,
    },

    "http(s) IRI json-gold rejects: a credential id with an invalid percent-escape (https://e.x/a%zz)": keptHttpsId(
      130,
      "c7784def89bd783d53cc21a2795131198e7ba38f41d432545811f8009d203588",
      "https://e.x/a%zz"
    ),
    "http(s) IRI json-gold rejects: a credential id with an empty host (https:///a)": keptHttpsId(
      124,
      "4b17888846f3a11b848ef28678bef97e94a76d9a76d595e659475fc459a41b73",
      "https:///a"
    ),
    "http(s) IRI json-gold rejects: a credential id of 2083 code points": keptHttpsId(
      2197,
      "93ab00636086f9c857e254288171983459e8e5b568d683250576d8f334667d11",
      httpsIriOfLength(2083)
    ),

    "url.Parse class: an issuer IRI with an invalid percent-escape in a non-http scheme (foo:/a%zz)": keptIssuer(
      186,
      "99a57aec60e6b2ac6b742807b6ce4b8b37625649e38ae751dab40cf36b021f61",
      "foo:/a%zz"
    ),
    "url.Parse class: an issuer IRI holding U+0001": keptIssuer(
      184,
      "24f0a7102e3ff19999213e61289f13f35f08af355005a813cc67cb308a4b1978",
      "urn:a\u0001b"
    ),
    "url.Parse class: an issuer IRI with a non-numeric port (foo://a:b/)": keptIssuer(
      187,
      "ecd57d4982f3b05fe73d9fd79883fa5a43ef16096452410f2f30511515c922fd",
      "foo://a:b/"
    ),

    "string in a graph container: a proof that is a plain string": droppedProofGraph,

    // json-gold cannot process these, so Go refuses them; jsonld.js admits
    // them and drops the value.
    "scalar in a graph container: a proof that is the number 5": droppedProofGraph,
    "scalar in a graph container: a proof that is true": droppedProofGraph,

    // The shape an Ed25519 settler's presentation takes around a
    // secp256k1-signed credential. jsonld.js drops the credential's
    // undefined proof type, where json-gold keeps it as a relative-IRI
    // rdf:type object.
    "mixed-suite envelope: an Ed25519Signature2020 presentation under the FulfillmentQuoteEnvelope context embedding a credential whose proof type EcdsaSecp256k1RecoverySignature2020 no loaded context defines": {
      length: 2634,
      sha256: "08508059d698e917d19ba635c93276a490f7a7c6fc197f6a47a06c1430edf31f",
      contains: ["<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/security#Ed25519Signature2020> "],
      lacks: ["<http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <EcdsaSecp256k1RecoverySignature2020> "],
      datasetContextsOnly: true,
    },
  };

  // Guards the pins themselves, so a half-filled one cannot pass vacuously.
  it("pins a well-formed digest and at least one differing line for every known divergence", () => {
    for (const [name, pin] of Object.entries(KNOWN_DIVERGENCES)) {
      expect(pin.sha256, name).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isInteger(pin.length) && pin.length >= 0, name).toBe(true);
      expect(pin.contains.length + pin.lacks.length, name).toBeGreaterThan(0);
    }
  });

  it("carries known_divergence on exactly the vectors the file's comment names", () => {
    const marked = [
      ...GOLDEN_SECTIONS.flatMap(([, list]) => list),
      ...VECTORS.refuse,
      ...VECTORS.generated.refuse,
      ...VECTORS.dataset.refuse,
    ]
      .filter((v) => v.known_divergence !== undefined)
      .map((v) => v.name);
    const named = Object.keys(KNOWN_DIVERGENCES);
    expect([...marked].sort()).toEqual([...named].sort());
    const comment: unknown = (JSON.parse(readFileSync(VECTORS_PATH, "utf-8")) as { _comment?: unknown })._comment;
    expect(typeof comment).toBe("string");
    for (const name of named) {
      expect(comment as string, `_comment names ${name}`).toContain(`'${name}'`);
    }
  });

  // rdf-canonize's side of each declared divergence, under every loader that
  // resolves the vector's contexts. It fails the day this output changes,
  // including the day it starts agreeing with json-gold, which is when the
  // marker must give way to a shared expected output.
  describe("a vector with a known divergence keeps rdf-canonize's side of the difference", () => {
    const named = VECTORS.accept.filter((v) => Object.hasOwn(KNOWN_DIVERGENCES, v.name));

    it("finds every named vector among the accept vectors", () => {
      expect(named.map((v) => v.name).sort()).toEqual(Object.keys(KNOWN_DIVERGENCES).sort());
    });

    for (const [loaderName, makeLoader] of [
      ["vendored loader", () => newDocumentLoader()],
      ["loader with the PaymentRequest context", datasetLoader],
    ] as const) {
      for (const v of named) {
        it(`${loaderName}: ${v.name}`, async () => {
          const pin = KNOWN_DIVERGENCES[v.name]!;
          if (pin.datasetContextsOnly && loaderName === "vendored loader") {
            // jsonld.js's own context loading fails on it too, and that
            // failure is not an admission refusal.
            const loader = makeLoader();
            expect((await settle(referenceCanonize(v.doc, loader))).ok).toBe(false);
            const outcome = await settle(canonicalize(copyDoc(v.doc) as object, loader));
            expect(outcome.ok, "canonicalize must fail on a context only dataset.contexts supplies").toBe(false);
            expect(outcome.ok ? undefined : outcome.error).not.toBeInstanceOf(AdmissionError);
            return;
          }
          const got = await canonicalize(copyDoc(v.doc) as object, makeLoader());
          for (const quad of pin.contains) {
            expect(got).toContain(quad);
          }
          for (const quad of pin.lacks) {
            expect(got).not.toContain(quad);
          }
          expect({
            sha256: createHash("sha256").update(got, "utf8").digest("hex"),
            length: utf8Bytes(got),
          }).toEqual({ sha256: pin.sha256, length: pin.length });
        });
      }
    }
  });
});

// The oracles below are the test's own reading of the depth and tab rules,
// written independently of admission.ts.
function pointerToken(k: string): string {
  return k.replaceAll("~", "~0").replaceAll("/", "~1");
}

// An object's members in code point order, the walk order.
function walkOrderKeys(o: Record<string, unknown>): string[] {
  const points = (s: string): number[] => [...s].map((c) => c.codePointAt(0)!);
  return Object.keys(o).sort((a, b) => {
    const x = points(a);
    const y = points(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] !== y[i]) return x[i] - y[i];
    }
    return x.length - y.length;
  });
}

// The pointer of the first object or array at depth `want` in walk order,
// the root being at depth 1, or undefined if none is that deep.
function firstContainerAtDepth(doc: unknown, want: number): string | undefined {
  const find = (v: unknown, path: string, depth: number): string | undefined => {
    if (Array.isArray(v)) {
      if (depth === want) return path;
      for (let i = 0; i < v.length; i++) {
        const p = find(v[i], `${path}/${i}`, depth + 1);
        if (p !== undefined) return p;
      }
    } else if (isPlainObject(v)) {
      if (depth === want) return path;
      for (const k of walkOrderKeys(v)) {
        const p = find(v[k], `${path}/${pointerToken(k)}`, depth + 1);
        if (p !== undefined) return p;
      }
    }
    return undefined;
  };
  return find(doc, "", 1);
}

// The pointer of the first string value holding U+0009 in walk order, keys
// not considered, or undefined.
function firstTabValue(doc: unknown): string | undefined {
  const find = (v: unknown, path: string): string | undefined => {
    if (typeof v === "string") return v.includes("\t") ? path : undefined;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const p = find(v[i], `${path}/${i}`);
        if (p !== undefined) return p;
      }
    } else if (isPlainObject(v)) {
      for (const k of walkOrderKeys(v)) {
        const p = find(v[k], `${path}/${pointerToken(k)}`);
        if (p !== undefined) return p;
      }
    }
    return undefined;
  };
  return find(doc, "");
}

// The 1-based position of the value at `ptr` among the values the walk
// visits, counted as the value budget counts them.
function walkPosition(doc: unknown, ptr: string): number | undefined {
  let n = 0;
  const visit = (v: unknown, path: string): boolean => {
    n++;
    if (path === ptr) return true;
    if (Array.isArray(v)) return v.some((c, i) => visit(c, `${path}/${i}`));
    if (isPlainObject(v)) return walkOrderKeys(v).some((k) => visit(v[k], `${path}/${pointerToken(k)}`));
    return false;
  };
  return visit(doc, "") ? n : undefined;
}

// Whether every object or array in `v` is of the one kind named.
function holdsOnly(v: unknown, kind: "object" | "array"): boolean {
  if (Array.isArray(v)) return kind === "array" && v.every((c) => holdsOnly(c, kind));
  if (isPlainObject(v)) return kind === "object" && Object.values(v).every((c) => holdsOnly(c, kind));
  return true;
}

function keysHoldTab(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(keysHoldTab);
  if (isPlainObject(v)) return Object.keys(v).some((k) => k.includes("\t") || keysHoldTab(v[k]));
  return false;
}

// The document with every member whose key holds U+0009 removed, at any
// depth.
function withoutTabKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutTabKeys);
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(v)) {
    if (!k.includes("\t")) setMember(out, k, withoutTabKeys(c));
  }
  return out;
}

// n objects, each but the innermost holding the next under `key`; the
// innermost is `inner`, or empty.
function nestedObjects(n: number, key: string, inner: Record<string, unknown> = {}): Record<string, unknown> {
  let v: Record<string, unknown> = inner;
  for (let i = 1; i < n; i++) v = { [key]: v };
  return v;
}

// n arrays, each but the innermost holding the next; the innermost holds
// `inner`.
function nestedArrays(n: number, ...inner: unknown[]): unknown[] {
  let v: unknown[] = [...inner];
  for (let i = 1; i < n; i++) v = [v];
  return v;
}

function datasetContexts(): Record<string, JsonLdDocument> {
  const dir = dirname(VECTORS_PATH);
  const extra: Record<string, JsonLdDocument> = {};
  for (const [url, rel] of Object.entries(VECTORS.dataset.contexts)) {
    extra[url] = JSON.parse(readFileSync(resolve(dir, rel), "utf-8")) as JsonLdDocument;
  }
  return extra;
}

// Guards the depth and tab vectors of the shared file, as the Go suite does:
// each depth-budget refusal points at the first object or array at depth 33
// in walk order, and each tab-character refusal at the first string value
// holding a tab; the boundary vectors sit at exactly 32 and 33 levels and are
// built of the one kind of container their names say; the value-budget
// precedence pair puts that object at exactly the 1025th and 1024th value;
// and the tab-key vector holds tabs in keys only.
describe("depth and tab vectors sit where their names say", () => {
  const exact = VECTORS.refuse.filter((v) => v.rule !== null && v.path !== null);
  const depthVectors = exact.filter((v) => v.rule === "depth-budget");
  const tabVectors = exact.filter((v) => v.rule === "tab-character");

  it("has depth-budget and tab-character refuse vectors with exact paths", () => {
    expect(depthVectors.length).toBeGreaterThan(0);
    expect(tabVectors.length).toBeGreaterThan(0);
  });

  for (const v of depthVectors) {
    it(`depth-budget refusal points at the first object or array at depth ${DEPTH_BUDGET + 1}: ${v.name}`, () => {
      expect(jsonDepth(v.doc)).toBeGreaterThan(DEPTH_BUDGET);
      expect(firstContainerAtDepth(v.doc, DEPTH_BUDGET + 1)).toBe(v.path);
    });
  }

  for (const v of tabVectors) {
    it(`tab-character refusal points at the first tab-holding string value: ${v.name}`, () => {
      expect(firstTabValue(v.doc)).toBe(v.path);
    });
  }

  for (const [list, prefix, depth, kind] of [
    [VECTORS.accept, "depth budget boundary: 32 nested objects", DEPTH_BUDGET, "object"],
    [VECTORS.accept, "depth budget boundary: 32 nested arrays", DEPTH_BUDGET, "array"],
    [VECTORS.refuse, "depth budget boundary: 33 nested objects", DEPTH_BUDGET + 1, "object"],
    [VECTORS.refuse, "depth budget boundary: 33 nested arrays", DEPTH_BUDGET + 1, "array"],
  ] as const) {
    it(`${prefix} is ${depth} levels of ${kind}s only`, () => {
      const v = findVector(list, prefix);
      expect(jsonDepth(v.doc)).toBe(depth);
      expect(holdsOnly(v.doc, kind)).toBe(true);
    });
  }

  for (const prefix of [
    "depth budget boundary: 32 levels alternating objects and arrays",
    "depth budget: scalars add no depth (32 nested objects",
    "depth budget: scalars add no depth (32 nested arrays",
  ]) {
    it(`${prefix} is ${DEPTH_BUDGET} levels deep`, () => {
      expect(jsonDepth(findVector(VECTORS.accept, prefix).doc)).toBe(DEPTH_BUDGET);
    });
  }

  for (const [prefix, position] of [
    ["depth budget: the value budget wins when the object at depth 33 is the 1025th value", 1025],
    ["depth budget: the object at depth 33 as the 1024th value", 1024],
  ] as const) {
    it(`${prefix}: the object at depth ${DEPTH_BUDGET + 1} is value ${position} in walk order`, () => {
      const v = findVector(VECTORS.refuse, prefix);
      const p = firstContainerAtDepth(v.doc, DEPTH_BUDGET + 1);
      expect(p).toBeTypeOf("string");
      expect(walkPosition(v.doc, p!)).toBe(position);
      expect(countValues(v.doc)).toBe(position);
    });
  }

  it("holds tabs in keys only in the tab-key accept vector, and in no other accept vector's strings", () => {
    const keys = findVector(VECTORS.accept, "tab character: keys are not checked");
    expect(keysHoldTab(keys.doc)).toBe(true);
    expect(firstTabValue(keys.doc)).toBeUndefined();
    for (const v of [...VECTORS.accept, ...expandGenerated(VECTORS.generated.accept)]) {
      if (v !== keys) expect(firstTabValue(v.doc), v.name).toBeUndefined();
      expect(jsonDepth(v.doc), v.name).toBeLessThanOrEqual(DEPTH_BUDGET);
    }
  });
});

describe("checkCanonicalizable: depth budget", () => {
  // The budget from both sides for each shape of nesting, at the root and
  // below it. Deeper documents are reported at the same pointer, the first
  // object or array past the budget, because the walk does not go further.
  const alternating = (n: number): unknown => {
    let v: unknown = n % 2 === 1 ? {} : [];
    for (let level = n - 1; level >= 1; level--) v = level % 2 === 1 ? { a: v } : [v];
    return v;
  };
  const shapes: Array<[string, (n: number) => unknown, string]> = [
    ["nested objects", (n) => nestedObjects(n, "a"), "/a".repeat(DEPTH_BUDGET)],
    ["nested arrays", (n) => nestedArrays(n), "/0".repeat(DEPTH_BUDGET)],
    ["alternating objects and arrays", alternating, "/a/0".repeat(DEPTH_BUDGET / 2)],
    [
      "objects under a root object with a scalar sibling",
      (n) => ({ x: 1, k: nestedObjects(n - 1, "k", { s: "v" }) }),
      "/k".repeat(DEPTH_BUDGET),
    ],
    [
      "arrays holding scalars under a root array",
      (n) => ["x", nestedArrays(n - 1, 1, "s", null, true)],
      "/1" + "/0".repeat(DEPTH_BUDGET - 1),
    ],
  ];

  for (const [name, build, path] of shapes) {
    it(`${name}: ${DEPTH_BUDGET} levels are admitted`, () => {
      const doc = build(DEPTH_BUDGET);
      expect(jsonDepth(doc)).toBe(DEPTH_BUDGET);
      expect(() => checkCanonicalizable(doc)).not.toThrow();
    });
    for (const depth of [DEPTH_BUDGET + 1, DEPTH_BUDGET + 2, 100]) {
      it(`${name}: ${depth} levels are refused at the first object or array at depth ${DEPTH_BUDGET + 1}`, () => {
        const doc = build(depth);
        expect(jsonDepth(doc)).toBe(depth);
        expect(firstContainerAtDepth(doc, DEPTH_BUDGET + 1)).toBe(path);
        const err = thrownBy(() => checkCanonicalizable(doc));
        expect(err).toBeInstanceOf(AdmissionError);
        expect((err as AdmissionError).rule).toBe("depth-budget");
        expect((err as AdmissionError).path).toBe(path);
      });
    }
  }

  // Precedence cases only TypeScript can build, because JSON.parse keeps a
  // lone surrogate that Go's decoder would repair. The key rules judge a key
  // before the walk enters its value; a value the walk never enters is never
  // judged.
  const prefix = "/k".repeat(DEPTH_BUDGET - 1);
  const deep = (inner: Record<string, unknown>): Record<string, unknown> => nestedObjects(DEPTH_BUDGET, "k", inner);
  const precedence: Array<[string, () => unknown, AdmissionRule, string]> = [
    [
      "an ill-formed key holding the too-deep object is reported by the key rule",
      () => deep(JSON.parse(String.raw`{"\ud800":{}}`) as Record<string, unknown>),
      "ill-formed-string",
      `${prefix}/\ud800`,
    ],
    [
      "an ill-formed string visited before the too-deep object is reported first",
      () => ({ a: JSON.parse(String.raw`"\ud800"`) as string, b: deep({}) }),
      "ill-formed-string",
      "/a",
    ],
    [
      "an ill-formed string inside the too-deep object is never judged",
      () => deep({ x: { s: JSON.parse(String.raw`"\udc00"`) as string } }),
      "depth-budget",
      `${prefix}/x`,
    ],
  ];
  for (const [name, build, rule, path] of precedence) {
    it(name, () => {
      const doc = build();
      expect(allStrings(doc).some(hasLoneSurrogate), "fixture must hold a lone surrogate").toBe(true);
      expect(jsonDepth(doc)).toBeGreaterThan(DEPTH_BUDGET);
      const err = thrownBy(() => checkCanonicalizable(doc));
      expect(err).toBeInstanceOf(AdmissionError);
      expect((err as AdmissionError).rule).toBe(rule);
      expect((err as AdmissionError).path).toBe(path);
    });
  }
});

describe("canonicalize: depth budget, before JSON-LD processing", () => {
  // jsonld.js expands nested graph containers recursively, so a deep enough
  // chain of them would exhaust the stack. The chain must be refused by the
  // pre-check instead, with the loader never asked for the context it names.
  it("refuses 600 nested proof graph containers under the PaymentRequest context with depth-budget, not a RangeError", async () => {
    const v = findVector(VECTORS.refuse, "depth budget: 600 nested proof graph containers");
    expect(jsonDepth(v.doc)).toBe(601);
    const loader = new CountingLoader(datasetContexts());
    const outcome = await settle(canonicalize(copyDoc(v.doc) as object, loader));
    expect(outcome.ok ? undefined : outcome.error).not.toBeInstanceOf(RangeError);
    const ae = refusedWith(outcome);
    expect(ae.rule).toBe("depth-budget");
    expect(ae.path).toBe("/proof".repeat(DEPTH_BUDGET));
    expect(loader.requests).toBe(0);
  });

  // An unregistered context would make the strict loader fail if JSON-LD
  // processing ran, so the admission error shows the check came first.
  it("reports AdmissionError, not UnknownContextError, for a too-deep document naming an unregistered context", async () => {
    const doc = { "@context": "https://unregistered.example/context.jsonld", a: nestedObjects(DEPTH_BUDGET, "a") };
    const outcome = await settle(canonicalize(doc, newDocumentLoader()));
    expect(outcome.ok ? undefined : outcome.error).not.toBeInstanceOf(UnknownContextError);
    const ae = refusedWith(outcome);
    expect(ae.rule).toBe("depth-budget");
    expect(ae.path).toBe("/a".repeat(DEPTH_BUDGET));
  });
});

describe("checkCanonicalizable: tab character", () => {
  // Only U+0009 is refused, wherever it sits in a string value.
  const refused: Array<[string, unknown, string]> = [
    ["at the start of a value", { a: "\tx" }, "/a"],
    ["at the end of a value", { a: "x\t" }, "/a"],
    ["between multi-byte characters", { a: "é\t\u{1F600}" }, "/a"],
    ["several in one value", { a: "\t\t" }, "/a"],
    ["in a value under a key needing JSON Pointer escaping", { "a/b~c": "\t" }, "/a~1b~0c"],
    ["as the whole document", "\t", ""],
    ["inside a root array", [1, "\t"], "/1"],
    ["in the second string of an @context array", { "@context": [W3C_VC_V1_CONTEXT_URL, "x\ty"] }, "/@context/1"],
  ];
  for (const [name, doc, path] of refused) {
    it(`refuses a tab ${name}`, () => {
      expect(firstTabValue(doc)).toBe(path);
      const err = thrownBy(() => checkCanonicalizable(doc));
      expect(err).toBeInstanceOf(AdmissionError);
      expect((err as AdmissionError).rule).toBe("tab-character");
      expect((err as AdmissionError).path).toBe(path);
    });
  }

  // Every other whitespace and control character, and a backslash followed
  // by t, is admitted, as are tabs in keys.
  const admitted: Array<[string, unknown]> = [
    ["a backslash followed by t", { a: String.raw`x\ty` }],
    ["LF, CR, VT, FF and space", { a: "\n\r\v\f " }],
    ["NUL, backspace, U+001F and DEL", { a: "\u0000\b\u001f\u007f" }],
    ["NEL, no-break space, thin space and ideographic space", { a: "\u0085  　" }],
    ["a tab in a root key", { "\t": "x" }],
    ["a tab in a nested key holding an array", { a: { "b\tc": ["x"] } }],
  ];
  for (const [name, doc] of admitted) {
    it(`admits ${name}`, () => {
      expect(firstTabValue(doc)).toBeUndefined();
      expect(() => checkCanonicalizable(doc)).not.toThrow();
    });
  }

  // Within one string value its bytes are counted, then it is judged
  // well-formed, then tab-character applies, then blank-node-label. The
  // ill-formed cases exist only in TypeScript, as JSON.parse keeps a lone
  // surrogate; the tab's position in the value must not matter.
  const precedence: Array<[string, string, AdmissionRule, string]> = [
    ["an ill-formed value is reported before its tab when the tab comes first", String.raw`{"a":"\t\ud800"}`, "ill-formed-string", "/a"],
    ["an ill-formed value is reported before its tab when the tab comes last", String.raw`{"a":"\udc00\t"}`, "ill-formed-string", "/a"],
    ["an ill-formed blank-node label with a tab is reported as ill-formed", String.raw`{"a":"_:\t\ud800"}`, "ill-formed-string", "/a"],
    ["an ill-formed key holding a tab value is reported at the key", String.raw`{"\ud800":"\t"}`, "ill-formed-string", "/\ud800"],
    ["a tab value before an ill-formed sibling in code point order is reported first", String.raw`{"b":"\ud800","a":"\t"}`, "tab-character", "/a"],
  ];
  for (const [name, text, rule, path] of precedence) {
    it(name, () => {
      const doc: unknown = JSON.parse(text);
      expect(allStrings(doc).some(hasLoneSurrogate), "fixture must hold a lone surrogate").toBe(true);
      const err = thrownBy(() => checkCanonicalizable(doc));
      expect(err).toBeInstanceOf(AdmissionError);
      expect((err as AdmissionError).rule).toBe(rule);
      expect((err as AdmissionError).path).toBe(path);
    });
  }
});

describe("canonicalize: tab character", () => {
  it("refuses a credential whose literal holds a tab without asking the loader for its context", async () => {
    const v = findVector(VECTORS.refuse, "tab character in a credential literal that would otherwise canonicalize");
    const loader = new CountingLoader();
    const ae = refusedWith(await settle(canonicalize(copyDoc(v.doc) as object, loader)));
    expect(ae.rule).toBe("tab-character");
    expect(ae.path).toBe("/issuanceDate");
    expect(loader.requests).toBe(0);
  });

  it("reports AdmissionError, not UnknownContextError, for a tab beside an unregistered context", async () => {
    const doc = { "@context": "https://unregistered.example/context.jsonld", a: "x\ty" };
    const outcome = await settle(canonicalize(doc, newDocumentLoader()));
    expect(outcome.ok ? undefined : outcome.error).not.toBeInstanceOf(UnknownContextError);
    const ae = refusedWith(outcome);
    expect(ae.rule).toBe("tab-character");
    expect(ae.path).toBe("/a");
  });

  // The reason for the rule, pinned on the TypeScript side: rdf-canonize
  // writes a TAB in a literal as the character itself, where the Go suite
  // pins that json-gold writes the two-character escape. An rdf-canonize
  // release that began escaping it would fail here, and the rule could be
  // revisited.
  // The tab rule leaves keys unchecked on the premise that a key reaches the
  // output only through a term its context defines. Under a real context
  // that defines no such term, the output must be exactly what the document
  // gives without the tab-holding key, and so hold no TAB for the
  // serializers to write differently.
  it("drops a tab-holding key under a real context that defines no term for it", async () => {
    const v = findVector(VECTORS.accept, "tab character: a key holding U+0009 under the W3C credentials v1 context");
    expect(keysHoldTab(v.doc)).toBe(true);
    expect(firstTabValue(v.doc)).toBeUndefined();
    expect(typeof v.nquads).toBe("string");
    expect(v.nquads).not.toBe("");
    const loader = newDocumentLoader();
    const got = await canonicalize(copyDoc(v.doc) as object, loader);
    expect(got).toBe(v.nquads);
    expect(got).not.toContain("\t");
    const stripped = withoutTabKeys(copyDoc(v.doc));
    expect(keysHoldTab(stripped)).toBe(false);
    expect(await canonicalize(stripped as object, loader)).toBe(got);
  });

  it("jsonld.canonize writes a TAB in a literal as the raw character", async () => {
    const doc = { "@context": W3C_VC_V1_CONTEXT_URL, type: "VerifiableCredential", issuanceDate: "a\tb" };
    const out = await referenceCanonize(doc, newDocumentLoader());
    expect(out).toContain('"a\tb"');
    expect(out).not.toContain(String.raw`\t`);
  });
});

describe("rdf-canonize dependency pin", () => {
  // canonicalize calls rdf-canonize directly and jsonld.js calls it for the
  // reference normalization; two copies could disagree on output, so the
  // package must resolve the very version jsonld.js does.
  it("resolves rdf-canonize 3.4.0 both from this package and from jsonld's own location", () => {
    const here = createRequire(import.meta.url);
    const fromPackage = here.resolve("rdf-canonize/package.json");
    const jsonldManifest = here.resolve("jsonld/package.json");
    const fromJsonld = createRequire(jsonldManifest).resolve("rdf-canonize/package.json");

    const version = (p: string): string =>
      (JSON.parse(readFileSync(p, "utf-8")) as { version: string }).version;
    expect(version(fromPackage)).toBe("3.4.0");
    expect(version(fromJsonld)).toBe("3.4.0");

    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf-8")
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["rdf-canonize"]).toBe("3.4.0");
  });
});
