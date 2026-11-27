import { defineConfig } from 'tsup';

// The published package must be self-contained: it cannot reference the in-repo
// @atum-labs/* sibling packages (they are not on the registry). tsup inlines
// those first-party siblings into dist.
//
// IMPORTANT — how externalization actually works here: tsup/esbuild treats a
// package as external ONLY if it is declared in this package's `dependencies` or
// `peerDependencies` (or listed in `external` below). Everything else — including
// the transitive third-party deps of the bundled @atum-labs/* siblings — is
// STATICALLY INLINED into dist and thus redistributed in the tarball. So the
// externals are exactly: dependencies (@solana/web3.js, bs58, ethers, tweetnacl)
// + peers (mppx, zod) + the `external` list. Anything inlined must be covered by
// THIRD-PARTY-NOTICES.txt; keep the dep/peer/external lists in sync accordingly.
//
// Output is ESM (not the cjs that payment-gateway-client ships): mppx is
// ESM-only, so a require()-based bundle could not load it. This package is
// "type": "module" and its consumers are mppx integrations, which are ESM too.
export default defineConfig({
  entry: ['src/index.ts', 'src/client.ts', 'src/server.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node18',
  // resolve: true makes the .d.ts bundler follow ALL imports and inline the
  // relative re-exports inside the bundled @atum-labs/* siblings. Third-party
  // types that stay external (mppx, zod) remain `import`s the consumer resolves.
  dts: { resolve: true },
  // No sourcemaps: tsup sourcemaps embed the original TypeScript source of this
  // package and every bundled sibling, which would ship that source to consumers.
  sourcemap: false,
  clean: true,
  // Keep @solana/web3.js external (it is a declared dependency). It is only
  // reached through the optional Turnkey Solana signer inside the bundled
  // siblings, and inlining it would drag in its transitive rpc-websockets
  // (LGPL-3.0) plus the whole @solana/* tree. Externalizing it — as
  // payment-gateway-client already does — keeps that subtree out of the
  // published bytes; the consumer installs @solana/web3.js itself (rpc-websockets
  // rides along as its dependency, not something we redistribute).
  // @stellar/stellar-sdk is external for the same reason: payment-gateway-client loads it with a
  // dynamic import, only to read a Stellar delegate epoch when the caller supplied none, and
  // bundling it would redistribute its whole dependency tree. It is an optional peer there, so a
  // consumer that reads the epoch installs it itself.
  external: ['@solana/web3.js', '@stellar/stellar-sdk'],
  // Bundle the first-party monorepo siblings so no @atum-labs/* import survives
  // in the output. ethers (dependency) and mppx/zod (peers) stay external.
  noExternal: [/^@atum-labs\//],
  // The bundled @atum-labs/* siblings are CJS and call require("ethers"). In an ESM
  // bundle esbuild rewrites those to a shim that throws "Dynamic require of ... is not
  // supported" at runtime, so the shipped ESM package cannot load ethers on the main
  // createCredential path. Provide a real require via createRequire so external
  // requires resolve in ESM. (The unit tests run src, not dist, so only an end-to-end
  // run against the built package surfaces this.)
  banner: {
    // The banner is applied to EVERY emitted file — entry points AND the
    // dependency chunks, which embed third-party OSS (axios, @noble, …). So the
    // banner carries ONLY the functional createRequire shim; the Apache-2.0
    // SOURCE-HEADER must NOT land on third-party code (Legal: "do not add it to
    // third-party code, generated files, lockfiles, or dependency code"). That
    // header is stamped onto the Atum-authored entry files only, afterwards, by
    // scripts/stamp-entry-headers.mjs (wired into the `build` script).
    js: `import { createRequire as __atumCreateRequire } from 'module'; const require = __atumCreateRequire(import.meta.url);`,
  },
});
