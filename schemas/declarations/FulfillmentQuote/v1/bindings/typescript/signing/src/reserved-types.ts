// Reserved credential types are matched on what a credential's `type`
// MEANS, not on how it is spelled. Mirror of the Go canonical's
// reservedTypeMatcher (reserved_types.go); both verifiers must classify
// every credential the same way.
//
// JSON-LD gives one type many spellings: the known-to-atum context maps
// `KnownToAtumVerifiableCredential` to `kta:KnownToAtumVerifiableCredential`,
// so the full IRI, the compact `kta:` form and any context term aliasing
// that IRI are the same credential type to every JSON-LD reader. Matching
// the raw strings alone would let any of those spellings skip the issuer
// check.
//
// A credential is RESERVED, and so walks every per-VC check, when any of
// these holds:
//
//   - one of its `type` strings is a reserved name, or ends in one after its
//     last '#', '/' or ':' (the lexical net);
//   - one of its types, expanded with JSON-LD exactly as it sits in the
//     presentation (the presentation's @context, then the credential's own),
//     is an IRI a reserved name expands to under Atum's bundled credential
//     contexts, or ends in a reserved name;
//   - its types cannot be resolved: expansion fails, a type expands to
//     something that is not an absolute IRI, or the expanded count differs
//     from the declared count.
//
// Everything else is passed through. Expansion uses the per-call loader and
// never the network.

import jsonld from "jsonld";
import type { JsonLdDocument } from "jsonld";

import { W3C_VC_V1_CONTEXT_URL, KNOWN_TO_ATUM_V1_CONTEXT_URL } from "@atum-labs/ld-data-integrity";

import { fqLoader } from "./canonicalize.js";

type JsonldLoader = ReturnType<typeof fqLoader.toJsonldLoader>;

// Mirrors of the Go lddataintegrity constants the reserved names expand
// under.
const KNOWN_TO_ATUM_V2_CONTEXT_URL = "https://schemas.atum.xyz/credentials/known-to-atum/v2";
const KYC_V1_CONTEXT_URL = "https://schemas.atum.xyz/credentials/kyc/v1";
const SENDER_COMPLIANCE_V1_CONTEXT_URL = "https://schemas.atum.xyz/credentials/sender-compliance/v1";

// The contexts a reserved name is expanded under to find the IRIs it stands
// for. Only the bundled loader is used, so a caller-supplied context can
// never change what a reserved name means. Mirror of Go reservedTypeContexts.
const RESERVED_TYPE_CONTEXTS: string[][] = [
  [W3C_VC_V1_CONTEXT_URL],
  [W3C_VC_V1_CONTEXT_URL, KNOWN_TO_ATUM_V1_CONTEXT_URL],
  [W3C_VC_V1_CONTEXT_URL, KNOWN_TO_ATUM_V2_CONTEXT_URL],
  [W3C_VC_V1_CONTEXT_URL, KYC_V1_CONTEXT_URL],
  [W3C_VC_V1_CONTEXT_URL, SENDER_COMPLIANCE_V1_CONTEXT_URL],
];

const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function isAbsoluteIRI(s: string): boolean {
  return !s.startsWith("_:") && ABSOLUTE_IRI.test(s);
}

// typeLocalName is what follows a type's last '#', '/' or ':'.
export function typeLocalName(s: string): string {
  const i = Math.max(s.lastIndexOf("#"), s.lastIndexOf("/"), s.lastIndexOf(":"));
  return i >= 0 ? s.slice(i + 1) : s;
}

async function expandForTypes(doc: Record<string, unknown>, loader: JsonldLoader): Promise<unknown[]> {
  // base: null keeps a relative type relative, as json-gold's empty base
  // does in Go, so an undefined short name is unresolved on both sides.
  return (await jsonld.expand(doc as JsonLdDocument, {
    documentLoader: loader,
    base: null,
    processingMode: "json-ld-1.1",
  } as unknown as Parameters<typeof jsonld.expand>[1])) as unknown[];
}

function expandedTypeStrings(node: Record<string, unknown>): string[] | null {
  if (!("@type" in node)) return [];
  const raw = node["@type"];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") return null;
    out.push(v);
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// nestedCredentialNode digs the one credential node out of the expanded
// probe. Mirror of the Go canonical's nestedCredentialNode.
function nestedCredentialNode(out: unknown[]): Record<string, unknown> | null {
  if (out.length !== 1 || !isPlainObject(out[0])) return null;
  const top = out[0];
  const keys = Object.keys(top).filter((k) => !k.startsWith("@"));
  if (keys.length !== 1) return null;
  const values = top[keys[0]];
  if (!Array.isArray(values) || values.length !== 1 || !isPlainObject(values[0])) return null;
  let elem: Record<string, unknown> = values[0];
  if ("@graph" in elem) {
    const nodes = elem["@graph"];
    if (!Array.isArray(nodes) || nodes.length !== 1 || !isPlainObject(nodes[0])) return null;
    elem = nodes[0];
  }
  return elem;
}

const reservedTypeIRICache = new Map<string, string[]>();

// reservedTypeIRIs returns the absolute IRIs a reserved name expands to
// under RESERVED_TYPE_CONTEXTS, plus the name itself when it already is one.
async function reservedTypeIRIs(name: string): Promise<string[]> {
  const cached = reservedTypeIRICache.get(name);
  if (cached) return cached;
  const iris: string[] = [];
  const add = (iri: string) => {
    if (isAbsoluteIRI(iri) && !iris.includes(iri)) iris.push(iri);
  };
  add(name);
  const loader = fqLoader.toJsonldLoader();
  for (const ctx of RESERVED_TYPE_CONTEXTS) {
    let out: unknown[];
    try {
      out = await expandForTypes({ "@context": ctx, "@type": [name] }, loader);
    } catch {
      continue;
    }
    if (out.length !== 1 || !isPlainObject(out[0])) continue;
    const types = expandedTypeStrings(out[0]);
    if (!types) continue;
    types.forEach(add);
  }
  reservedTypeIRICache.set(name, iris);
  return iris;
}

export interface ReservedTypeMatcher {
  reserved(vc: unknown): Promise<boolean>;
}

// newReservedTypeMatcher returns null when there is no reserved set, which
// checks every credential. presentationContext is the presentation's
// @context (undefined when it has none).
export async function newReservedTypeMatcher(
  reservedNames: string[],
  presentationContext: unknown,
  loader: JsonldLoader
): Promise<ReservedTypeMatcher | null> {
  if (reservedNames.length === 0) return null;
  const names = new Set(reservedNames);
  const iris = new Set<string>();
  for (const name of reservedNames) {
    for (const iri of await reservedTypeIRIs(name)) iris.add(iri);
  }
  const lexical = (t: string) => names.has(t) || names.has(typeLocalName(t));

  return {
    async reserved(vc: unknown): Promise<boolean> {
      if (!isPlainObject(vc)) return false;
      const types = vc.type;
      if (!Array.isArray(types)) return false;
      const declared = types.filter((t): t is string => typeof t === "string");
      if (declared.some(lexical)) return true;

      const probe: Record<string, unknown> = { type: declared };
      if ("@context" in vc) probe["@context"] = vc["@context"];
      const doc: Record<string, unknown> = { verifiableCredential: [probe] };
      if (presentationContext !== undefined) doc["@context"] = presentationContext;
      let out: unknown[];
      try {
        out = await expandForTypes(doc, loader);
      } catch {
        return true;
      }
      const node = nestedCredentialNode(out);
      if (!node) return true;
      const expanded = expandedTypeStrings(node);
      if (!expanded || expanded.length !== declared.length) return true;
      return expanded.some((iri) => !isAbsoluteIRI(iri) || iris.has(iri) || lexical(iri));
    },
  };
}
