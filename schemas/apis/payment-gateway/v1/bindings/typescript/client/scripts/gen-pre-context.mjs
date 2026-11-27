#!/usr/bin/env node
// Inlines the PaymentRequestEnvelope JSON-LD @context into src/pre-context.generated.ts.
//
// buildEnvelope must hand the signer this context: the PRE context is deliberately NOT
// registered on the FulfillmentQuote signer's global loader (that would cross a layering
// boundary), so every producer and verifier supplies it per call.
//
// Inlined rather than read from disk for the reason the signing libraries were: a path
// relative to this module resolves against a CONSUMER's output once re-bundled, and this
// package is itself bundled into an ESM package. Nothing here touches the filesystem or the
// network.
//
// Pass --check to verify instead of write.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
// This package sits at schemas/apis/payment-gateway/v1/bindings/typescript/client,
// so the repository root is seven levels above the package directory.
const REPO_ROOT = resolve(scriptDir, '..', '../../../../../../..');
const SRC = resolve(REPO_ROOT, 'schemas/declarations/PaymentRequestEnvelope/v1/context.jsonld');
// The canonical home of the two constants bound into every envelope signature. Reading them here
// rather than retyping them in envelope-signing.ts means one source of truth: the Go binding reads
// the same file's siblings, so if the URL ever moves, both halves move together instead of this
// client quietly signing under the old terms.
const VERSION_TS = resolve(
  REPO_ROOT,
  'schemas/declarations/PaymentRequestEnvelope/v1/bindings/typescript/version.ts',
);

/** Pull an `export const NAME = "value"` out of the canonical version module. */
function canonicalConstant(name) {
  const source = readFileSync(VERSION_TS, 'utf-8');
  const m = source.match(new RegExp(`export const ${name}\\s*=\\s*\n?\\s*"([^"]+)"`));
  if (!m) {
    throw new Error(`gen-pre-context: ${name} not found in ${VERSION_TS}`);
  }
  return m[1];
}
const OUT = resolve(scriptDir, '../src/pre-context.generated.ts');

function render() {
  const parsed = JSON.parse(readFileSync(SRC, 'utf-8'));
  return [
    '// GENERATED FILE — DO NOT EDIT.',
    '//',
    '// Written by scripts/gen-pre-context.mjs from',
    '// schemas/declarations/PaymentRequestEnvelope/v1/context.jsonld. Run `pnpm run prebuild`',
    '// to regenerate; `pnpm run check:pre-context` fails if it has drifted.',
    '',
    '// Deep-frozen at module load. This object is shared by every call, so a caller (or a',
    '// library reaching into it) that mutated it would change what this package SIGNS for the',
    '// rest of the process — silently, because the document still looks right and only the',
    '// signature differs. Freezing makes that mutation fail instead of succeeding quietly.',
    '//',
    '// Consumers that need a mutable copy get one from structuredClone at the point of use;',
    '// the JSON-LD processor is handed a clone for exactly that reason.',
    'function deepFreeze<T>(value: T): T {',
    "  if (value && typeof value === 'object') {",
    '    for (const key of Object.getOwnPropertyNames(value)) {',
    '      deepFreeze((value as Record<string, unknown>)[key]);',
    '    }',
    '    Object.freeze(value);',
    '  }',
    '  return value;',
    '}',
    '',
    'export const PAYMENT_REQUEST_ENVELOPE_CONTEXT: Record<string, unknown> = deepFreeze(',
    `  ${JSON.stringify(parsed, null, 2).replace(/\n/g, '\n  ')},`,
    ');',
    '',
    '// Copied from the canonical version module, NOT retyped. Both are bound into the holder',
    '// signature, so a client carrying a stale copy would keep signing under terms the verifier',
    '// has already moved on from -- and nothing would fail loudly.',
    `export const PAYMENT_REQUEST_ENVELOPE_CONTEXT_URL = ${JSON.stringify(canonicalConstant('CONTEXT_URL'))};`,
    `export const PAYMENT_REQUEST_ENVELOPE_TYPE = ${JSON.stringify(canonicalConstant('ENVELOPE_TYPE'))};`,
    '',
  ].join('\n');
}

if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) {
    process.stderr.write(
      "generated PRE context missing; run 'pnpm run prebuild' in payment-gateway-client\n",
    );
    process.exit(1);
  }
  if (readFileSync(OUT, 'utf-8') !== render()) {
    process.stderr.write(
      "generated PRE context is stale; run 'pnpm run prebuild' in payment-gateway-client\n",
    );
    process.exit(1);
  }
  process.exit(0);
}

writeFileSync(OUT, render());
process.stdout.write('✅ inlined the PaymentRequestEnvelope context\n');
