#!/usr/bin/env node
/**
 * Write each program's error table into its doc page from the committed IDL.
 *
 * `--check` instead diffs and exits 1 on drift, which is what CI runs. Without that, a hand-pasted
 * table silently goes stale the next time a variant is appended.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const idlDir = join(here, '..', 'src', 'generated');
const docsDir = join(here, '..', '..', '..', '..', 'source', 'docs', 'programs');

const BEGIN = '<!-- BEGIN GENERATED ERROR TABLE -->';
const END = '<!-- END GENERATED ERROR TABLE -->';

const table = (program) => {
  const idl = JSON.parse(readFileSync(join(idlDir, `${program}.json`), 'utf8'));
  const rows = idl.errors.map(
    (e) =>
      `| \`${e.code}\` | \`${e.name}\` | ${(e.msg ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|')} |`,
  );
  return [BEGIN, '', '| Code | Name | Message |', '| --- | --- | --- |', ...rows, '', END].join('\n');
};

const targets = [
  { program: 'escrow', doc: 'escrow.md' },
  { program: 'fulfillment_proxy', doc: 'fulfillment-proxy.md' },
];

const check = process.argv.includes('--check');
let drifted = false;

for (const { program, doc } of targets) {
  const path = join(docsDir, doc);
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 || end === -1) {
    console.error(`${doc}: missing the generated-table markers`);
    process.exit(1);
  }
  const next = text.slice(0, start) + table(program) + text.slice(end + END.length);
  if (next === text) continue;
  if (check) {
    console.error(`${doc}: error table is stale. Run: pnpm run gen:error-tables`);
    drifted = true;
  } else {
    writeFileSync(path, next);
    console.log(`${doc}: error table written`);
  }
}

if (check && !drifted) console.log('Error tables match the committed IDL.');
process.exit(drifted ? 1 : 0);
