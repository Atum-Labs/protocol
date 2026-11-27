// Generates the closed set of error-code constants from catalog.json:
//   bindings/go/codes.go            Go `Code` constants
//   bindings/typescript/src/codes.ts  TS `ErrorCode` string-literal union
// Run by `make generate-error` (mirror-error-catalog), which then runs `gofmt -w`
// on codes.go (this script emits unaligned Go). DO NOT hand-edit the output.
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const catalog = JSON.parse(fs.readFileSync(path.join(dir, 'catalog.json'), 'utf8'));
const keys = Object.keys(catalog.entries).sort();

// filter(Boolean) tolerates doubled/trailing underscores rather than crashing.
const camel = (k) =>
  k.split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('');

const header = '// Code generated from apis/error/v1/catalog.json by make generate-error. DO NOT EDIT.\n';

const goOut =
  header +
  'package atumerror\n\n' +
  'const (\n' +
  keys.map((k) => `\tCode${camel(k)} Code = "${k}"`).join('\n') +
  '\n)\n';
fs.writeFileSync(path.join(dir, 'bindings/go/codes.go'), goOut);

const tsOut =
  header +
  'export type ErrorCode =\n' +
  keys.map((k) => `  | "${k}"`).join('\n') +
  ';\n';
fs.writeFileSync(path.join(dir, 'bindings/typescript/src/codes.ts'), tsOut);
