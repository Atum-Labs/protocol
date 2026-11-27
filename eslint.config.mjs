// Lint configuration for the packages an external integrator depends on: the published SDKs, the
// shared sender_auth library they bundle, and the guard that decides whether they are safe to publish.
//
// Most rules are the non-type-aware `recommended` sets. Three type-aware rules
// (`no-floating-promises`, `no-misused-promises`, `await-thenable`) also run on `src/`, which is
// why this config fails loudly when the @atum-labs/* siblings are unbuilt: without their compiled
// output those rules would find nothing while still exiting 0.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The packages that ship to external integrators, and the sender_auth library they bundle.
const SDK_PACKAGES = [
  'schemas/apis/payment-gateway/v1/bindings/typescript/client',
  'schemas/apis/payment-gateway/v1/bindings/typescript/mppx-atum-escrow',
  'schemas/apis/x402/v1/bindings/x402-atum-escrow',
  'schemas/declarations/PaymentRequest/v1/bindings/typescript/sender-auth',
];

// Everything linted. publish-guard is not an SDK, but it decides whether one is safe to publish:
// a truthy non-boolean or an unawaited promise there would let a broken tarball ship.
const LINTED_PACKAGES = [...SDK_PACKAGES, 'tooling/publish-guard'];

// Linted by a root script instead of their own. Other repositories build these as workspace
// members without this repository's root dependencies, where a package `lint` script cannot load
// this config.
const ROOT_LINTED_PACKAGES = [
  'schemas/declarations/PaymentRequest/v1/bindings/typescript/sender-auth',
];

// Prettier takes its scope from the `format` / `format:check` globs in the root
// package.json, not from the list above, and nothing else cross-checks the two -- so a
// package added here but not there would be linted and never format-checked. Asserted
// rather than written down as a note, for the same reason as the lint-script agreement
// further below. (`lint` itself needs no such check: it runs `pnpm -r run lint`, so a
// package is linted exactly when it declares a `lint` script.)
//
// The brace list is parsed rather than substring-matched: `glob.includes('foo')` would
// also pass on a glob that only mentions `foo-bar`.
const formatScript = JSON.parse(readFileSync(`${import.meta.dirname}/package.json`, 'utf8')).scripts
  .format;
const formatScope = new Set(
  (formatScript.match(/\{([^}]*)\}\/\*\*/)?.[1] ?? '').split(',').map((name) => name.trim()),
);
const unformatted = LINTED_PACKAGES.filter((pkg) => !formatScope.has(pkg));
if (unformatted.length > 0) {
  throw new Error(
    'LINTED_PACKAGES and the root `format` glob disagree, so a package would be linted ' +
      `but never format-checked: ${unformatted.join(', ')}`,
  );
}

// The type-aware rules below read the in-repo @atum-labs/* siblings through their
// COMPILED output. With those unbuilt, the imports resolve to `any` and the rules
// quietly stop detecting while still exiting 0 -- a green run that verified less than
// it appears to. That is the same silent-gate failure the drift guard in schemas/
// exists to prevent, so it fails loudly here rather than being written down and
// remembered.
//
// The siblings are discovered rather than listed: each package's workspace deps are
// symlinked into its own node_modules, so their build output is visible without
// needing to know where the source lives. `pnpm install` runs their `prepare` (tsc),
// so this is satisfied by a normal install and only trips after `pnpm run clean` or an
// --ignore-scripts install.
const unbuilt = SDK_PACKAGES.flatMap((pkg) => {
  const manifest = JSON.parse(readFileSync(`${import.meta.dirname}/${pkg}/package.json`, 'utf8'));
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  return Object.entries(deps)
    .filter(
      ([name, spec]) => name.startsWith('@atum-labs/') && String(spec).startsWith('workspace:'),
    )
    .filter(([name]) => {
      // Ask each sibling where its types are rather than assuming a dist/ directory:
      // some export .ts or .mjs straight from source and have no build output at all,
      // and those are never "unbuilt".
      const root = `${import.meta.dirname}/${pkg}/node_modules/${name}`;
      let entry;
      try {
        entry = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).types;
      } catch {
        return false; // not installed the way we expect; not this check's business
      }
      return typeof entry === 'string' && !existsSync(`${root}/${entry}`);
    })
    .map(([name]) => name);
});
if (unbuilt.length > 0) {
  throw new Error(
    'Build the workspace before linting -- the type-aware rules silently stop working ' +
      `without it. Run: pnpm -r build\n  missing dist: ${[...new Set(unbuilt)].sort().join(', ')}`,
  );
}

// A package is linted exactly when it declares a `lint` script, because the root
// `lint` script is `pnpm -r run lint`. But ESLint only applies rules to paths matched
// by the `files` patterns below, which are built from LINTED_PACKAGES -- so a package
// that declares the script without being listed here gets walked, matched by nothing,
// linted zero files, and reports success. Assert the two agree, in both directions.
const declaresLint = (dir) => {
  try {
    return (
      typeof JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')).scripts?.lint === 'string'
    );
  } catch {
    return false;
  }
};
// Uncapped on purpose. Workspace packages go as deep as
// schemas/declarations/*/v1/bindings/typescript/signing -- seven levels -- so any depth
// limit would make this check silently miss exactly the packages it exists to catch.
// The pruned directories below keep it cheap (~20ms across the whole repo).
const findPackages = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !['node_modules', 'dist', '.git', 'source'].includes(e.name))
    .flatMap((e) => {
      const full = `${dir}/${e.name}`;
      return [...(declaresLint(full) ? [full] : []), ...findPackages(full)];
    });
};
const listed = new Set(LINTED_PACKAGES.map((p) => `${import.meta.dirname}/${p}`));
const unlisted = findPackages(import.meta.dirname).filter((d) => !listed.has(d));
const rootScripts =
  JSON.parse(readFileSync(`${import.meta.dirname}/package.json`, 'utf8')).scripts ?? {};
const lintedByRoot = (p) =>
  Object.values(rootScripts).some(
    (script) => typeof script === 'string' && /^eslint /.test(script) && script.includes(p),
  );
const scriptless = LINTED_PACKAGES.filter(
  (p) =>
    !declaresLint(`${import.meta.dirname}/${p}`) &&
    !(ROOT_LINTED_PACKAGES.includes(p) && lintedByRoot(p)),
);
const rootLintedWithScript = ROOT_LINTED_PACKAGES.filter((p) =>
  declaresLint(`${import.meta.dirname}/${p}`),
);
if (rootLintedWithScript.length > 0) {
  throw new Error(
    `linted by a root script, so it must not declare its own lint script: ${rootLintedWithScript.join(', ')}`,
  );
}
if (unlisted.length > 0 || scriptless.length > 0) {
  throw new Error(
    'LINTED_PACKAGES and the per-package `lint` scripts disagree, so some package would ' +
      'be linted against no rules and still exit 0.\n' +
      (unlisted.length
        ? `  declares a lint script but is not in LINTED_PACKAGES: ${unlisted
            .map((d) => d.slice(import.meta.dirname.length + 1))
            .join(', ')}\n`
        : '') +
      (scriptless.length
        ? `  in LINTED_PACKAGES but declares no lint script: ${scriptless.join(', ')}\n`
        : ''),
  );
}

/** Expand one glob suffix across every linted package. */
const inPackages = (...suffixes) =>
  LINTED_PACKAGES.flatMap((pkg) => suffixes.map((suffix) => `${pkg}/${suffix}`));

// A leading underscore marks a binding that is intentionally unused: a positional
// parameter kept so a signature still matches the interface it implements, or a
// key named only to drop it from a rest spread. The repo already relies on this
// convention — see `_context` in x402's facilitator and `_derived` in the Turnkey
// signer — so the linter is told to honour it rather than the code being changed
// to suit the linter.
const noUnusedVars = [
  'error',
  {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      // Generated from schemas/apis/payment-gateway/v1/openapi.yaml and committed.
      // Linting it would put this config in a fight with the drift guard that
      // regenerates it (schemas/Makefile: check-openapi-ts-clients): any fix the
      // linter wanted would be erased by the next `pnpm run generate`.
      'schemas/apis/payment-gateway/v1/bindings/typescript/client/src/generated/',
      'schemas/apis/payment-gateway/v1/bindings/typescript/client/src/hosts.generated.ts',
      'schemas/apis/payment-gateway/v1/bindings/typescript/mppx-atum-escrow/src/hosts.generated.ts',
      'schemas/apis/x402/v1/bindings/x402-atum-escrow/src/hosts.generated.ts',
      // Vendored snapshots of upstream contract repos. They carry their own
      // ESLint configs and their own lockfiles, and are not workspace members.
      'contracts/*/source/**',
      // Generated from Go's Unicode tables and pinned by a Go drift test.
      'schemas/declarations/PaymentRequest/v1/bindings/typescript/sender-auth/src/simple-fold.gen.ts',
    ],
  },

  // TypeScript sources, including the packages' root-level .ts files
  // (tsup.config.ts, readme-snippets.ts).
  {
    files: inPackages('**/*.ts'),
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: { '@typescript-eslint/no-unused-vars': noUnusedVars },
  },

  // Release tooling: scripts/*.mjs and publish-guard.config.mjs. Always ESM.
  {
    files: inPackages('**/*.mjs'),
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node }, sourceType: 'module' },
    rules: { 'no-unused-vars': noUnusedVars },
  },

  // payment-gateway-client is CommonJS (no "type" field), so its jest.config.js
  // uses require()/module.exports. The other two packages are "type": "module"
  // and have no .js files.
  {
    files: inPackages('**/*.js'),
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node }, sourceType: 'commonjs' },
    rules: { 'no-unused-vars': noUnusedVars },
  },

  // ── Type-aware rules ──────────────────────────────────────────────────────
  //
  // Everything above works file-by-file. These three need the TypeScript type
  // checker, because deciding whether an expression is a Promise means knowing what
  // the function it came from returns.
  //
  // Scoped to `src/` only, and to these three rules only. Deliberately NOT
  // `recommendedTypeChecked`: that adds 188 findings here, ~101 of them the
  // `no-unsafe-*` family reporting `any` at generated and JSON-parsing boundaries
  // where the dynamism is the point. `require-await` is left off for the same
  // reason — 86 findings, 78 of them in tests, almost all deliberate (an async
  // function with no await, matching an interface).
  //
  // These three currently find NOTHING. That is the reason to enable them rather
  // than an argument against: there is no cleanup to do, so the cost is config
  // alone, and the rule is in place before the first missing `await` is written.
  // In a payments SDK that is the failure worth pre-empting — code that compiles,
  // passes tests, and submits a payment whose signing never completed.
  //
  // One caveat worth knowing: this reads the @atum-labs/* siblings through their
  // compiled output. If they have not been built, those imports resolve to `any`
  // and these rules quietly stop detecting rather than failing. CI builds the
  // workspace in the same lane; locally, run `pnpm --filter "<pkg>^..." run build`
  // first if you are relying on them.
  {
    files: SDK_PACKAGES.map((pkg) => `${pkg}/src/**/*.ts`),
    languageOptions: {
      parserOptions: {
        // tsconfig.test.json rather than tsconfig.json: the latter excludes
        // *.test.ts, which would leave the test suites unanalysed.
        project: SDK_PACKAGES.map((pkg) => `./${pkg}/tsconfig.test.json`),
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
    },
  },

  // Tests and their helpers. `test-helpers.ts` / `test-support.ts` are included
  // because they are test code that happens not to carry the `.test` infix, and
  // they hold as much of the `any` usage as the specs do.
  {
    files: inPackages('**/*.test.ts', '**/test-helpers.ts', '**/test-support.ts'),
    rules: {
      // Test doubles reach into partial shapes and deliberately malformed
      // fixtures; naming a real type for each would obscure what is asserted.
      // Same relaxation as contracts/svm/source/eslint.config.js.
      '@typescript-eslint/no-explicit-any': 'off',
      // Conflicts with TypeScript's definite-assignment analysis. Several tests
      // write `let msg = ''` before a try/catch and assign inside the catch;
      // ESLint calls the initialiser useless, but dropping it makes `tsc` fail
      // with "used before being assigned". The compiler wins.
      'no-useless-assignment': 'off',
    },
  },
);
