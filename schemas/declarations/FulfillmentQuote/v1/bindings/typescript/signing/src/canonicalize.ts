// FQ TS canonicalize shim. Delegates URDNA2015 +
// strict-no-network loading to @atum-labs/ld-data-integrity (the
// shared TS lib mirroring the Go data-integrity lib). FQ keeps only
// its declaration-specific contexts here — fulfillment-quote-context
// and fulfillment-quote-envelope-context — overlaid via the lib's
// `extra` parameter.

import { readFileSync } from "fs";
import { resolve } from "path";

import type { JsonLdDocument } from "jsonld";

import { EMBEDDED_CONTEXTS } from "./contexts.generated.js";

import {
  canonicalize as libCanonicalize,
  newDocumentLoader,
  W3C_VC_V1_CONTEXT_URL as LIB_W3C_VC_V1_CONTEXT_URL,
  SECP256K1_RECOVERY_2020_V2_CTX_URL,
  ED25519_SIGNATURE_2020_V1_CTX_URL,
  KNOWN_TO_ATUM_V1_CONTEXT_URL as LIB_KNOWN_TO_ATUM_V1_CONTEXT_URL,
} from "@atum-labs/ld-data-integrity";

// Resolve the directory containing FQ-specific JSON-LD context
// snapshots. ESM path derives from `import.meta.url`; CJS path
// (the esbuild bundle for jest in tests/e2e) reads
// _LD_SIGNING_CONTEXTS_DIR set by the bundle wrapper.
// Contexts resolve from the generated module, so they travel with the code through any
// bundler; a path relative to this module would resolve against a consumer's own output once
// re-bundled. The env-var override still reads from disk for anyone pointing this at a
// different snapshot, and is unused in normal operation.
//
// Neither path reaches the network: canonicalization always runs through the shared loader,
// which is handed to jsonld in place of its built-in fetcher.
const loadJsonContext = (name: string): JsonLdDocument => {
  const fromEnv = process.env._LD_SIGNING_CONTEXTS_DIR;
  if (fromEnv) {
    return JSON.parse(readFileSync(resolve(fromEnv, name), "utf-8")) as JsonLdDocument;
  }
  const embedded = EMBEDDED_CONTEXTS[name];
  if (!embedded) {
    throw new Error(
      `canonicalize: context ${name} is not embedded; run 'npm run prebuild' in this package`
    );
  }
  return embedded;
};

// FQ-canonical context URLs. Re-exported from / aliased to the lib's
// where the URL is library-owned; defined here for FQ-specific URLs.
export const FULFILLMENT_QUOTE_CONTEXT_URL =
  "https://schemas.atum.network/declarations/FulfillmentQuote/v1/context.jsonld";
export const FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL =
  "https://schemas.atum.network/declarations/FulfillmentQuoteEnvelope/v1/context.jsonld";
export const W3C_VC_V1_CONTEXT_URL = LIB_W3C_VC_V1_CONTEXT_URL;
export const KNOWN_TO_ATUM_V1_CONTEXT_URL = LIB_KNOWN_TO_ATUM_V1_CONTEXT_URL;
export const SECP256K1_RECOVERY_CONTEXT_URL = SECP256K1_RECOVERY_2020_V2_CTX_URL;
export const ED25519_2020_CONTEXT_URL = ED25519_SIGNATURE_2020_V1_CTX_URL;

// The declaration type the default (FQE) envelope context defines. Any OTHER
// declaration type only canonicalizes its rdf:type n-quad when its own
// declaration context is supplied to the strict loader.
export const FULFILLMENT_QUOTE_ENVELOPE_TYPE = "FulfillmentQuoteEnvelope";

// assertDeclarationContextSupplied guards the declaration-type
// binding against a silent downgrade: with `safe: false` canonicalization, a
// `declarationType` whose context isn't on the loader is dropped without error,
// so the signer would mint an UNBOUND VerifiablePresentation that no
// declaration-type-checking verifier accepts. Called by signVP / signVPEd25519
// before signing. A non-FQE declaration type therefore REQUIRES both
// `envelopeContextUrl` (its declaration @context URL) and an
// `extraEnvelopeContexts` entry that supplies it. The FQE type (or no type) is
// always fine — its context is on the base loader.
export function assertDeclarationContextSupplied(
  declarationType: string | undefined,
  envelopeContextUrl: string,
  extraEnvelopeContexts: Record<string, unknown> | undefined,
): void {
  if (!declarationType || declarationType === FULFILLMENT_QUOTE_ENVELOPE_TYPE) {
    return;
  }
  const supplied =
    envelopeContextUrl !== FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL &&
    !!extraEnvelopeContexts &&
    Object.prototype.hasOwnProperty.call(extraEnvelopeContexts, envelopeContextUrl);
  if (!supplied) {
    throw new Error(
      `declarationType ${JSON.stringify(declarationType)} requires its declaration context: ` +
        `set envelopeContextUrl to the declaration's @context URL and supply that URL via ` +
        `extraEnvelopeContexts, otherwise the type term is silently dropped and the envelope ` +
        `is not type-bound`,
    );
  }
}

// fqLoader is the process-level strict-no-network document loader for
// FQ canonicalization. Built once at module load from the shared lib's
// generic-context base, with FQ-specific contexts overlaid via the
// `extra` map. Concurrency-safe by construction — the underlying
// contexts map is immutable after newDocumentLoader returns.
//
// Exported so hash.ts can reuse the same instance rather than
// constructing a parallel loader from the same on-disk snapshots —
// avoids both the wasted file-read at module load and the latent
// drift risk of two contexts maps that could diverge if maintained
// separately.
export const fqLoader = newDocumentLoader({
  [FULFILLMENT_QUOTE_CONTEXT_URL]: loadJsonContext("fulfillment-quote-context.jsonld"),
  [FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL]: loadJsonContext(
    "fulfillment-quote-envelope-context.jsonld"
  ),
});

// canonicalize is the FQ-public URDNA2015 canonicalization function.
// Thin wrapper over the lib's canonicalize with FQ's
// declaration-specific contexts overlaid. Public signature unchanged
// from the earlier shim so callers (sign.ts, sign-vp.ts, hash.ts, etc.)
// keep compiling.
export async function canonicalize(doc: object): Promise<string> {
  return libCanonicalize(doc, fqLoader);
}
