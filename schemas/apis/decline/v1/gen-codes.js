// Generates the closed set of decline-reason constants from catalog.json:
//   bindings/go/codes.go              Go `ReasonCode` constants
//   bindings/typescript/src/codes.ts  TS `DeclineReasonCode` string-literal union
// Run by `make generate-decline` (mirror-decline-catalog), which then runs `gofmt -w`
// on codes.go (this script emits unaligned Go). DO NOT hand-edit the output.
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
const keys = Object.keys(catalog.entries).sort();

// filter(Boolean) tolerates doubled/trailing underscores rather than crashing.
const camel = (k) =>
  k.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('');

const header =
  '// Code generated from apis/decline/v1/catalog.json by make generate-decline. DO NOT EDIT.\n';

const goOut =
  header +
  'package atumdecline\n\n' +
  'const (\n' +
  keys.map((k) => `\tReason${camel(k)} ReasonCode = "${k}"`).join('\n') +
  '\n)\n\n' +
  '// AllReasonCodes lists every reason the catalog names, sorted.\n' +
  'var AllReasonCodes = []ReasonCode{\n' +
  keys.map((k) => `\tReason${camel(k)},`).join('\n') +
  '\n}\n';
fs.writeFileSync(path.join(dir, 'bindings/go/codes.go'), goOut);

const tsOut =
  header +
  'export type DeclineReasonCode =\n' +
  keys.map((k) => `  | "${k}"`).join('\n') +
  ';\n\n' +
  '/** Every reason the catalog names, sorted. */\n' +
  'export const ALL_DECLINE_REASON_CODES: DeclineReasonCode[] = [\n' +
  keys.map((k) => `  "${k}",`).join('\n') +
  '\n];\n';
fs.writeFileSync(path.join(dir, 'bindings/typescript/src/codes.ts'), tsOut);
