// Admission rules applied before canonicalization. Mirror of the Go lib's
// admission.go: both languages refuse the same documents with the same rule
// and path, which the shared conformance vectors pin.

// AdmissionRule names the rule a refused document broke. The values are wire
// strings shared with the Go implementation.
export type AdmissionRule =
  // More JSON values than MAX_ADMITTED_VALUES.
  | "value-budget"
  // More string bytes, counting values and keys, than MAX_ADMITTED_BYTES.
  | "byte-budget"
  // A JSON-LD keyword other than @context used as a key, such as @id or
  // @graph, which would let a document name and interlink its own blank nodes.
  | "reserved-key"
  // A key containing ":", which mints a predicate the published context does
  // not define.
  | "compact-iri-key"
  // An @context that is not a URL or a list of URLs. An inline context would
  // let a document redefine its own terms.
  | "context-shape"
  // A string value in blank-node label syntax, through which a document would
  // reference blank nodes by name.
  | "blank-node-label"
  // An object or array nested deeper than MAX_ADMITTED_DEPTH. JSON-LD
  // processors expand documents recursively, and jsonld.js exhausts its stack
  // well inside the value budget.
  | "depth-budget"
  // A string value containing a TAB. json-gold escapes it in an N-Quads
  // literal and rdf-canonize writes it raw, so the Go and TypeScript canonical
  // forms of such a document differ.
  | "tab-character"
  // A key or string value that is not well-formed Unicode: it holds a lone
  // surrogate. JSON.parse keeps one, where Go's JSON decoder would replace it
  // with U+FFFD; the Go library refuses the same rule for invalid UTF-8.
  | "ill-formed-string"
  // More blank nodes in the expanded dataset than MAX_ADMITTED_BLANK_NODES.
  | "blank-node-budget"
  // An expanded dataset whose canonical N-Quads would exceed
  // MAX_ADMITTED_OUTPUT_BYTES.
  | "output-budget"
  // Two blank nodes in the expanded dataset share their first-degree quads, so
  // canonicalization would have to search permutations to tell them apart.
  | "indistinguishable-blank-nodes";

// MAX_ADMITTED_VALUES bounds the JSON values a document may carry, and with
// them the number of statements expansion can produce.
export const MAX_ADMITTED_VALUES = 1024;

// MAX_ADMITTED_BYTES bounds the UTF-8 bytes of every string value and key, and
// with them the length of the canonical output.
export const MAX_ADMITTED_BYTES = 128 * 1024;

// MAX_ADMITTED_DEPTH bounds how deeply objects and arrays may nest, the root
// being at depth 1. Signed protocol documents nest a handful of levels.
export const MAX_ADMITTED_DEPTH = 32;

// MAX_ADMITTED_BLANK_NODES bounds the distinct blank nodes in the expanded
// dataset. The value budget does not bound them on its own: a term whose
// context declares a graph container expands one JSON object into both a node
// and the graph holding it.
export const MAX_ADMITTED_BLANK_NODES = 1024;

// MAX_ADMITTED_OUTPUT_BYTES bounds the canonical N-Quads a dataset may
// produce. The JSON budgets do not bound it: every statement repeats its
// subject in full, so one long IRI shared by many statements multiplies into
// the output. It matches the Go bound, which keeps json-gold's output assembly
// cheap, so both languages admit the same documents.
export const MAX_ADMITTED_OUTPUT_BYTES = 128 * 1024;

// AdmissionError reports which rule refused a document, and where. `path` is an
// RFC 6901 JSON Pointer to the offending value, or "" for a document refused
// as a whole. It is thrown as is, never wrapped, because `instanceof` does not
// follow `cause`.
export class AdmissionError extends Error {
  readonly rule: AdmissionRule;
  readonly path: string;

  constructor(rule: AdmissionRule, path: string) {
    super(
      path === ""
        ? `document not canonicalizable: ${rule}`
        : `document not canonicalizable: ${rule} at ${JSON.stringify(path)}`
    );
    this.name = "AdmissionError";
    this.rule = rule;
    this.path = path;
  }
}

// checkCanonicalizable refuses a document that is too large, or that uses
// JSON-LD features that would let it define its own terms or name its own
// blank nodes, and admits every other document without changing it. It does
// not apply the dataset rules, which need the expanded dataset.
//
// Object members are visited in Unicode code point order, so that a rule
// broken by several sibling keys is reported at the same key as in Go, whose
// string order is UTF-8 byte order. JavaScript's default sort compares UTF-16
// code units, which orders characters above U+FFFF before U+E000-U+FFFF.
export function checkCanonicalizable(doc: unknown): void {
  new AdmissionCheck().walk(doc, "", 0);
}

const utf8 = new TextEncoder();

class AdmissionCheck {
  private values = 0;
  private bytes = 0;

  private countBytes(s: string): void {
    this.bytes += utf8.encode(s).length;
    if (this.bytes > MAX_ADMITTED_BYTES) {
      throw new AdmissionError("byte-budget", "");
    }
  }

  // walk checks v, found at path inside depth enclosing objects and arrays. A
  // container is refused on entry, before anything inside it is visited, so
  // that the check never recurses deeper than the budget.
  walk(v: unknown, path: string, depth: number): void {
    this.values++;
    if (this.values > MAX_ADMITTED_VALUES) {
      throw new AdmissionError("value-budget", "");
    }
    if (v !== null && typeof v === "object") {
      depth++;
      if (depth > MAX_ADMITTED_DEPTH) {
        throw new AdmissionError("depth-budget", path);
      }
    }

    if (Array.isArray(v)) {
      v.forEach((e, i) => this.walk(e, `${path}/${i}`, depth));
      return;
    }
    if (typeof v === "string") {
      this.countBytes(v);
      if (!isWellFormed(v)) {
        throw new AdmissionError("ill-formed-string", path);
      }
      if (v.includes("\t")) {
        throw new AdmissionError("tab-character", path);
      }
      if (v.startsWith("_:")) {
        throw new AdmissionError("blank-node-label", path);
      }
      return;
    }
    if (v === null || typeof v !== "object") {
      return;
    }

    const obj = v as Record<string, unknown>;
    for (const k of Object.keys(obj).sort(compareCodePoints)) {
      this.countBytes(k);
      const child = `${path}/${escapePointerToken(k)}`;
      // Checked before the key's syntax rules, which would otherwise
      // interpret text that is not valid Unicode. The byte budget has already
      // counted the key, as Go does after its decoder repairs the text.
      if (!isWellFormed(k)) {
        throw new AdmissionError("ill-formed-string", child);
      }
      if (k === "@context") {
        if (!isContextReference(obj[k])) {
          throw new AdmissionError("context-shape", child);
        }
      } else if (k.startsWith("@")) {
        throw new AdmissionError("reserved-key", child);
      } else if (k.includes(":")) {
        throw new AdmissionError("compact-iri-key", child);
      }
      this.walk(obj[k], child, depth);
    }
  }
}

// isWellFormed reports whether s holds no lone surrogate: every high
// surrogate is followed by a low one, and every low one follows a high one.
function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

// isContextReference reports whether an @context value only names contexts by
// URL, as a string or a list of strings.
function isContextReference(v: unknown): boolean {
  if (typeof v === "string") return true;
  return Array.isArray(v) && v.every((e) => typeof e === "string");
}

export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) return ca - cb;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return a.length - i - (b.length - j);
}

// escapePointerToken applies RFC 6901 escaping: "~" before "/", since "/"
// escapes to a sequence containing "~".
function escapePointerToken(s: string): string {
  return s.replaceAll("~", "~0").replaceAll("/", "~1");
}
