#!/usr/bin/env node
// Snapshots the canonical PaymentRequest JSON-LD context into
// dist/contexts/ (and dist-cjs/contexts/) so it can be embedded by the
// runtime canonicalizer. The signer module reads from these snapshots via
// __dirname-relative path resolution; bundling them here keeps the lib
// self-contained and avoids fragile paths into the schemas/ tree at
// runtime.
//
// Each row in PAIRS is [source, destination-basename]. Sources are
// resolved relative to this script's directory; destinations land flat
// under dist/contexts/.
//
// Pass --check to fail non-zero if any snapshot is stale instead of
// refreshing it (used in CI to detect drift).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Source-of-truth file lives in the schemas/ tree. The generic JSON-LD
// contexts (W3C VC v1, secp256k1recovery-2020-v2, ed25519-2020-v1,
// known-to-atum-v1) are owned by the shared TS lib and resolved through its
// DocumentLoader; this package only snapshots the PaymentRequest
// declaration-specific context here.
const PAIRS = [
  ["../../../../context.jsonld", "payment-request-context.jsonld"],
];

// Two destination dirs: the ESM dist/ output and the CJS dist-cjs/ output
// (esbuild-bundled for CJS consumers). Both must contain the same context
// so each runtime path resolves it locally.
const DST_DIRS = [
  resolve(__dirname, "../dist/contexts"),
  resolve(__dirname, "../dist-cjs/contexts"),
];
const DST_DIR = DST_DIRS[0];
const GENERATED_TS = resolve(__dirname, "../src/contexts.generated.ts");

// renderGeneratedModule inlines each snapshot as JSON so the contexts travel with the code
// through any bundler. A path relative to this module resolves against a CONSUMER's output
// once re-bundled, and the shim needed to locate the files made one downstream ESM bundle
// unloadable. JSON.parse keeps the output canonical rather than pasting upstream formatting.
function renderGeneratedModule() {
  const entries = PAIRS.map(([srcRel, dstName]) => {
    const parsed = JSON.parse(readFileSync(resolve(__dirname, srcRel), "utf-8"));
    return `  ${JSON.stringify(dstName)}: ${JSON.stringify(parsed, null, 2).replace(/\n/g, "\n  ")} as unknown as JsonLdDocument,`;
  });
  return [
    "// GENERATED FILE — DO NOT EDIT.",
    "//",
    "// Written by scripts/copy-context.mjs from the canonical context.jsonld files. Run",
    "// `npm run prebuild` in this package to regenerate; `npm run verify-context` fails if it",
    "// has drifted.",
    "//",
    "// Inlined rather than read from disk so the contexts survive being re-bundled: nothing",
    "// here touches the filesystem or the network at resolution time.",
    "",
    'import type { JsonLdDocument } from "jsonld";',
    "",
    "export const EMBEDDED_CONTEXTS: Record<string, JsonLdDocument> = {",
    ...entries,
    "};",
    "",
  ].join("\n");
}

const checkOnly = process.argv.includes("--check");
const PKG_DIR =
  "schemas/declarations/PaymentRequest/v1/signing/typescript";

if (checkOnly) {
  for (const [srcRel, dstName] of PAIRS) {
    const src = resolve(__dirname, srcRel);
    const dst = resolve(DST_DIR, dstName);
    if (!existsSync(dst)) {
      process.stderr.write(
        `context snapshot missing (${dstName}); run 'npm run prebuild' inside ${PKG_DIR}\n`
      );
      process.exit(1);
    }
    if (!readFileSync(dst).equals(readFileSync(src))) {
      process.stderr.write(
        `context snapshot is stale (${dstName}); run 'npm run prebuild' inside ${PKG_DIR}\n`
      );
      process.exit(1);
    }
  }
  if (!existsSync(GENERATED_TS)) {
    process.stderr.write(`generated contexts module missing; run 'npm run prebuild'\n`);
    process.exit(1);
  }
  if (readFileSync(GENERATED_TS, "utf-8") !== renderGeneratedModule()) {
    process.stderr.write(`generated contexts module is stale (src/contexts.generated.ts); run 'npm run prebuild'\n`);
    process.exit(1);
  }
  process.exit(0);
}

// Snapshot to both ESM (dist/contexts) and CJS (dist-cjs/contexts).
for (const dstDir of DST_DIRS) {
  mkdirSync(dstDir, { recursive: true });
  for (const [srcRel, dstName] of PAIRS) {
    writeFileSync(resolve(dstDir, dstName), readFileSync(resolve(__dirname, srcRel)));
  }
}

writeFileSync(GENERATED_TS, renderGeneratedModule());
