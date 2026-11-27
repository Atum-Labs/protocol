import { defineConfig } from 'tsup';

// The published package must be self-contained: it cannot reference the in-repo
// @atum-labs/* sibling packages (they are not on the registry). tsup inlines those
// first-party siblings into dist.
//
// IMPORTANT — how externalization actually works here: tsup/esbuild treats a package
// as external ONLY if it is declared in this package's `dependencies` or
// `peerDependencies` (or listed in `external` below). Everything else — including the
// transitive third-party deps of the bundled @atum-labs/* siblings — is STATICALLY
// INLINED into dist and thus redistributed in the tarball. So the externals are exactly
// the `dependencies` (@x402/core, @x402/fetch, ajv, ajv-formats, bs58, ethers,
// tweetnacl, zod, zod-validation-error). Anything inlined must be covered by
// THIRD-PARTY-NOTICES.txt; keep the dependency list and that file in sync
// (regenerate with `pnpm gen:notices`).
//
// Output is ESM only: the @x402/* packages are ESM, this package is "type": "module",
// and its consumers are x402 integrations, which are ESM too.
export default defineConfig({
  // One entry per role. There is deliberately no root entry: a payer must not pull the
  // facilitator's code (or vice versa) just by importing the package name.
  entry: {
    client: 'src/client/index.ts',
    server: 'src/server/index.ts',
    facilitator: 'src/facilitator/index.ts',
    fetch: 'src/fetch/index.ts',
  },
  outDir: 'dist',
  format: ['esm'],
  target: 'node18',
  // resolve: true makes the .d.ts bundler follow ALL imports and inline the relative
  // re-exports inside the bundled @atum-labs/* siblings — including the generated types
  // src/contract re-exports from the schema binding packages. Without it those relative
  // imports dangle in the shipped .d.ts and break consumers on the default skipLibCheck.
  dts: { resolve: true },
  // No sourcemaps: tsup sourcemaps embed the original TypeScript source of this package
  // and every bundled sibling, which would ship that source to consumers.
  sourcemap: false,
  clean: true,
  // Bundle the first-party monorepo siblings so no @atum-labs/* import survives in the
  // output. Everything in `dependencies` stays external.
  noExternal: [/^@atum-labs\//],
  // The bundled @atum-labs/* siblings are CJS and call require("ethers"). In an ESM
  // bundle esbuild rewrites those to a shim that throws "Dynamic require of ... is not
  // supported" at runtime, so the shipped ESM package could not load ethers on the main
  // signing path. Provide a real require via createRequire so external requires resolve
  // in ESM. (The unit tests run src, not dist, so only an end-to-end run against the
  // built package surfaces this — see scripts/check-publishable.mjs.)
  banner: {
    // The banner is applied to EVERY emitted file — entry points AND the dependency
    // chunks, which embed third-party OSS (@noble/hashes, …). So the banner carries ONLY
    // the functional createRequire shim; the Apache-2.0 SOURCE-HEADER must NOT land on
    // third-party code (Legal: "do not add it to third-party code, generated files,
    // lockfiles, or dependency code"). That header is stamped onto the Atum-authored
    // entry files only, afterwards, by scripts/stamp-entry-headers.mjs (wired into the
    // `build` script).
    js: `import { createRequire as __atumCreateRequire } from 'module'; const require = __atumCreateRequire(import.meta.url);`,
  },
});
