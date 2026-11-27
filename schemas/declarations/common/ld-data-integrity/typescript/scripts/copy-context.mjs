#!/usr/bin/env node
// Snapshots the vendored generic JSON-LD contexts (see SNAPSHOTS) from the Go
// lib's contexts/ tree into dist/contexts/ (and dist-cjs/contexts/).
// The TS lib uses the Go lib's contexts as the source of truth so
// both halves canonicalize byte-identically — same vendored W3C VC v1
// snapshot, same secp256k1recovery-2020-v2, same ed25519-2020-v1,
// same known-to-atum-v1 and v2.
//
// It ALSO generates src/contexts.generated.ts, which inlines the same snapshots as a TS
// module. That generated module — not the files — is what the loader resolves at runtime.
//
// WHY BOTH. Reading the .jsonld files from a directory beside the module works when Node loads
// this package directly, and breaks the moment a consumer re-bundles it: the path resolves
// against the consumer's own output. One such consumer ships ESM while the payment-gateway
// client ships CJS, and the CJS shim needed to locate the files made the module format
// ambiguous, so Node refused to load the bundle at all. Inlined contexts travel wherever the
// code travels, through any bundler, with no filesystem and no env-var override.
//
// The files are still emitted for the env-var escape hatch and for anything reading them
// directly.
//
// Pass --check to fail non-zero if any snapshot is stale instead of
// refreshing it (used in CI to detect drift).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Source-of-truth: the Go lib's contexts/ tree (../../go/contexts).
// Both halves stay in lockstep by sharing the same on-disk snapshots.
const SRC_DIR = resolve(__dirname, "../../go/contexts");

const SNAPSHOTS = [
  "credentials-v1.jsonld",
  "secp256k1recovery-2020-v2.jsonld",
  "ed25519-2020-v1.jsonld",
  "known-to-atum-v1.jsonld",
  "known-to-atum-v2.jsonld",
  "kyc-v1.jsonld",
  "sender-compliance-v1.jsonld",
];

const DST_DIRS = [
  resolve(__dirname, "../dist/contexts"),
  resolve(__dirname, "../dist-cjs/contexts"),
];

const GENERATED_TS = resolve(__dirname, "../src/contexts.generated.ts");

// renderGeneratedModule inlines each snapshot as JSON. JSON.parse of the source keeps the
// output canonical rather than pasting the file's own formatting, so the generated module is
// stable across whitespace-only edits upstream.
function renderGeneratedModule() {
  const entries = SNAPSHOTS.map((name) => {
    const parsed = JSON.parse(readFileSync(resolve(SRC_DIR, name), "utf-8"));
    return `  ${JSON.stringify(name)}: ${JSON.stringify(parsed, null, 2).replace(/\n/g, "\n  ")} as unknown as JsonLdDocument,`;
  });
  return [
    "// GENERATED FILE — DO NOT EDIT.",
    "//",
    "// Written by scripts/copy-context.mjs from the Go lib's contexts/ tree, which is the",
    "// source of truth for both language halves. Run `npm run prebuild` in this package to",
    "// regenerate; `npm run verify-context` fails if it has drifted.",
    "//",
    "// Inlined rather than read from disk so the contexts survive being re-bundled by a",
    "// consumer: a path relative to this module resolves against the consumer's output, and the",
    "// shim needed to find it made one downstream ESM bundle unloadable.",
    "",
    'import type { JsonLdDocument } from "jsonld";',
    "",
    "// DEEP-FROZEN, and not as a formality. These are module-level objects: genericContexts()",
    "// runs on every `new DocumentLoader(...)`, so the SAME object is shared by every loader in",
    "// the process, and load(url) hands it straight out. Anything that mutates one changes what",
    "// every later signature in that process is computed over -- silently, because the document",
    "// still looks right and only the signed bytes differ. Freezing makes that a thrown error",
    "// instead. The generated PRE context does the same, for the same reason.",
    "function deepFreeze<T>(value: T): T {",
    "  if (value && typeof value === 'object') {",
    "    for (const key of Object.getOwnPropertyNames(value)) {",
    "      deepFreeze((value as Record<string, unknown>)[key]);",
    "    }",
    "    Object.freeze(value);",
    "  }",
    "  return value;",
    "}",
    "",
    "export const EMBEDDED_CONTEXTS: Record<string, JsonLdDocument> = deepFreeze({",
    ...entries,
    "});",
    "",
  ].join("\n");
}

const checkOnly = process.argv.includes("--check");
const PKG_DIR = "schemas/declarations/common/ld-data-integrity/typescript";

if (checkOnly) {
  // Drift check runs against the ESM dist/ output only — the CJS
  // copy is identical by construction (we copy the same files to
  // both directories below).
  const DST_DIR = DST_DIRS[0];
  for (const name of SNAPSHOTS) {
    const src = resolve(SRC_DIR, name);
    const dst = resolve(DST_DIR, name);
    if (!existsSync(dst)) {
      process.stderr.write(
        `context snapshot missing (${name}); run 'npm run prebuild' inside ${PKG_DIR}\n`
      );
      process.exit(1);
    }
    if (!readFileSync(dst).equals(readFileSync(src))) {
      process.stderr.write(
        `context snapshot is stale (${name}); run 'npm run prebuild' inside ${PKG_DIR}\n`
      );
      process.exit(1);
    }
  }
  if (!existsSync(GENERATED_TS)) {
    process.stderr.write(
      `generated contexts module missing; run 'npm run prebuild' inside ${PKG_DIR}\n`
    );
    process.exit(1);
  }
  if (readFileSync(GENERATED_TS, "utf-8") !== renderGeneratedModule()) {
    process.stderr.write(
      `generated contexts module is stale (src/contexts.generated.ts); run 'npm run prebuild' inside ${PKG_DIR}\n`
    );
    process.exit(1);
  }
  process.exit(0);
}

for (const dstDir of DST_DIRS) {
  mkdirSync(dstDir, { recursive: true });
  for (const name of SNAPSHOTS) {
    writeFileSync(resolve(dstDir, name), readFileSync(resolve(SRC_DIR, name)));
  }
}

writeFileSync(GENERATED_TS, renderGeneratedModule());
