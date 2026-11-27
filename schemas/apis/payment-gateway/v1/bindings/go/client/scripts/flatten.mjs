#!/usr/bin/env node
// Regenerate schemas/apis/payment-gateway/v1/bindings/go/client/internal/ from the canonical packages in this repo.
//
//   node scripts/flatten.mjs            # regenerate
//   node scripts/flatten.mjs --check    # fail if the committed tree has drifted
//
// WHY THIS EXISTS. The module is documented as our Go SDK, but it could not be `go get`-ed: its
// siblings were required at v0.0.0 and resolved only through relative `replace` directives, and a
// CONSUMING module's replaces are ignored by Go. So the one command every Go developer runs
// failed, and the only way in was to vendor this repo and hand-write a dozen replace lines.
//
// WHY GENERATED RATHER THAN COPIED BY HAND. Copying these packages in by hand would remove the
// replace directives and reintroduce exactly the failure this PR exists to remove: it deleted
// three drifted copies of a JSON-LD context, each of which had silently diverged from the
// canonical file. A hand-maintained copy of fourteen packages would drift the same way, just more
// slowly and with more at stake. Here the canonical package stays the only place anyone edits,
// this script reproduces the copy, and --check fails CI the moment the two disagree.
//
// The copies live under internal/ so they are unimportable from outside this module. That is
// deliberate: a consumer must not build against our vendored copy of a package that also exists
// canonically elsewhere in the repo. Where a consumer legitimately needs to NAME one of these
// types -- the two signer interfaces they have to implement -- alias.go re-exports it.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));          // bindings/go/client/scripts
const MODULE_DIR = resolve(HERE, '..');                        // bindings/go/client
const REPO = resolve(MODULE_DIR, '../../../../../../..');      // protocol
const MODULE_PATH = 'github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client';

// The transitive set of in-repo packages this module needs, from `go list -deps ./...`.
// Adding an import from a new in-repo package means adding it here; the build fails until you do,
// because the flattened module has no replace directives left to fall back on.
const PACKAGES = [
  'contracts/evm/bindings/go/escrow-encoding/encoding',
  'contracts/evm/bindings/go/escrow-encoding/generated',
  'contracts/stellar/bindings/go/escrow-encoding/encoding',
  'contracts/svm/bindings/go/escrow-encoding/encoding',
  'contracts/tvm/bindings/go/escrow-encoding/encoding',
  'contracts/tvm/bindings/go/escrow-encoding/generated',
  'schemas/declarations/FulfillmentQuote/v1/bindings/go/generated',
  'schemas/declarations/FulfillmentQuote/v1/bindings/go/signing',
  'schemas/declarations/FulfillmentQuoteEnvelope/v1/bindings/go/generated',
  'schemas/declarations/PaymentRequest/v1/bindings/go/generated',
  'schemas/declarations/PaymentRequest/v1/bindings/go/jsonmembers',
  'schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/senderauth',
  'schemas/declarations/PaymentRequest/v1/bindings/go/signing',
  'schemas/declarations/PaymentRequestEnvelope/v1/bindings/go',
  'schemas/declarations/PaymentRequestEnvelope/v1/bindings/go/signing',
  'schemas/declarations/common/ld-data-integrity/go',
];

/** Rewrite in-repo imports to their flattened location. One mechanical prefix substitution. */
function rewrite(source) {
  return source.replaceAll(
    /github\.com\/atum-labs\/protocol\/(?!schemas\/apis\/payment-gateway\/v1\/bindings\/go\/client\/)/g,
    `${MODULE_PATH}/internal/`,
  );
}

function generateInto(root) {
  for (const pkg of PACKAGES) {
    const src = join(REPO, pkg);
    if (!existsSync(src)) throw new Error(`flatten: source package missing: ${pkg}`);
    const dst = join(root, 'internal', pkg);
    mkdirSync(dst, { recursive: true });

    for (const name of readdirSync(src)) {
      const from = join(src, name);
      // Tests stay with the canonical package. They are what proves the ORIGINAL correct; copying
      // them here would double the runtime and, worse, let a copied test pass while the canonical
      // one fails.
      if (name.endsWith('_test.go')) continue;
      if (name.endsWith('.go')) {
        writeFileSync(join(dst, name), rewrite(readFileSync(from, 'utf8')));
        continue;
      }
      // go:embed reaches only inside its own package directory, so embedded assets have to travel
      // with the sources. Every embed in these packages is a contexts/ tree.
      if (statSync(from).isDirectory() && name === 'contexts') {
        cpSync(from, join(dst, name), { recursive: true });
      }
    }
  }
  // Rewriting the import paths lengthens them, which changes how gofmt aligns the import block.
  // Format the output rather than leaving files that fail `gofmt -l`: these are checked byte-for-byte
  // by --check, so an unformatted copy would be a permanent diff nobody can fix by hand.
  execFileSync('gofmt', ['-w', join(root, 'internal')], { stdio: 'inherit' });

  writeFileSync(
    join(root, 'internal', 'GENERATED.md'),
    [
      '# Generated — do not edit',
      '',
      'Every file under `internal/` is copied from the canonical package elsewhere in this repo by',
      '`scripts/flatten.mjs`. Edit the canonical package and re-run the script; `--check` fails CI if',
      'the two disagree.',
      '',
      'This exists so the module can be `go get`-ed: it has no `replace` directives and no',
      'dependency on sibling modules that are not separately tagged.',
      '',
      'Canonical sources:',
      '',
      ...PACKAGES.map((p) => `- \`${p}\``),
      '',
    ].join('\n'),
  );
}

/** Every file under a directory, as repo-relative path → contents. */
function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(root, p), readFileSync(p, 'utf8'));
    }
  };
  walk(join(root, 'internal'));
  return out;
}

const checkOnly = process.argv.includes('--check');

if (checkOnly) {
  const tmp = mkdtempSync(join(tmpdir(), 'pgc-flatten-'));
  try {
    generateInto(tmp);
    const want = snapshot(tmp);
    const got = snapshot(MODULE_DIR);

    const problems = [];
    for (const [path, contents] of want) {
      if (!got.has(path)) problems.push(`missing: ${path}`);
      else if (got.get(path) !== contents) problems.push(`drifted: ${path}`);
    }
    for (const path of got.keys()) if (!want.has(path)) problems.push(`stale (no canonical source): ${path}`);

    if (problems.length) {
      process.stderr.write(
        'internal/ has drifted from its canonical sources:\n' +
          problems.map((p) => `  ${p}`).join('\n') +
          "\n\nRun: node scripts/flatten.mjs\nEdit the CANONICAL package, never internal/.\n",
      );
      process.exit(1);
    }
    process.stdout.write(`OK: internal/ matches all ${PACKAGES.length} canonical packages.\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  rmSync(join(MODULE_DIR, 'internal'), { recursive: true, force: true });
  generateInto(MODULE_DIR);
  process.stdout.write(`Regenerated internal/ from ${PACKAGES.length} canonical packages.\n`);
}
