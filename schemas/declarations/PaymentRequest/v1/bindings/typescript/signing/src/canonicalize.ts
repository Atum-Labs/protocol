// PaymentRequest TS canonicalize shim. Delegates URDNA2015 +
// strict-no-network loading to @atum-labs/ld-data-integrity (the shared
// TS lib mirroring its Go counterpart). PaymentRequest keeps only
// its declaration-specific context here — payment-request-context —
// overlaid via the lib's `extra` parameter.

import { readFileSync } from "fs";
import { resolve } from "path";

import type { JsonLdDocument } from "jsonld";

import { EMBEDDED_CONTEXTS } from "./contexts.generated.js";

import {
  canonicalize as libCanonicalize,
  newDocumentLoader,
  SECP256K1_RECOVERY_2020_V2_CTX_URL,
  ED25519_SIGNATURE_2020_V1_CTX_URL,
} from "@atum-labs/ld-data-integrity";

// Resolve the directory containing the PaymentRequest JSON-LD context
// snapshot. ESM path derives from `import.meta.url`; CJS path (the
// esbuild bundle) reads _PR_LD_SIGNING_CONTEXTS_DIR set by the bundle
// wrapper.
// Contexts resolve from the generated module, so they travel with the code through any
// bundler; a path relative to this module would resolve against a consumer's own output once
// re-bundled. The env-var override still reads from disk for anyone pointing this at a
// different snapshot, and is unused in normal operation.
//
// Neither path reaches the network: canonicalization always runs through the shared loader,
// which is handed to jsonld in place of its built-in fetcher.
// Announced once per process, not silently. The override decides what a signature COVERS, and
// taking it without a trace is how a machine ends up signing under terms nobody chose. It stays
// available because it is deliberate, but it should never be invisible.
let announcedOverride = false;

const loadJsonContext = (name: string): JsonLdDocument => {
  const fromEnv = process.env._PR_LD_SIGNING_CONTEXTS_DIR;
  if (fromEnv) {
    if (!announcedOverride) {
      announcedOverride = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[payment-request-ld-signing] _PR_LD_SIGNING_CONTEXTS_DIR is set (${fromEnv}); JSON-LD ` +
          "contexts are being read from disk INSTEAD OF the embedded copies. This changes what " +
          "signatures cover. Unset it unless you meant to.",
      );
    }
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

// PaymentRequest-canonical context URLs. Re-exported from / aliased to
// the lib's where the URL is library-owned; defined here for the
// PaymentRequest-specific URL.
export const PAYMENT_REQUEST_CONTEXT_URL =
  "https://schemas.atum.network/declarations/PaymentRequest/v1/context.jsonld";
export const SECP256K1_RECOVERY_CONTEXT_URL = SECP256K1_RECOVERY_2020_V2_CTX_URL;
export const ED25519_2020_CONTEXT_URL = ED25519_SIGNATURE_2020_V1_CTX_URL;

// prLoader is the process-level strict-no-network document loader for
// PaymentRequest canonicalization. Built once at module load from the
// shared lib's generic-context base, with the PaymentRequest context
// overlaid via the `extra` map. Concurrency-safe by construction — the
// underlying contexts map is immutable after newDocumentLoader returns.
//
// Exported so hash.ts can reuse the same instance rather than
// constructing a parallel loader from the same on-disk snapshot.
export const prLoader = newDocumentLoader({
  [PAYMENT_REQUEST_CONTEXT_URL]: loadJsonContext("payment-request-context.jsonld"),
});

// canonicalize is the PaymentRequest-public URDNA2015 canonicalization
// function. Thin wrapper over the lib's canonicalize with the
// PaymentRequest declaration-specific context overlaid.
export async function canonicalize(doc: object): Promise<string> {
  return libCanonicalize(doc, prLoader);
}
