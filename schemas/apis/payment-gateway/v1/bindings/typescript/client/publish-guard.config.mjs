// Package-specific inputs for the shared release tooling (@atum-labs/publish-guard).
// The checks themselves live in tooling/publish-guard; this file carries only what
// differs between packages.
export default {
  displayName: '@atumlabs/payment-gateway-client',
  // Reproduced verbatim in the notices header. The published artifact bundles the
  // in-repo @atum-labs/* libraries and their transitive dependencies, but keeps
  // these packages external, so they are not redistributed with it. Keep this list
  // in step with `dependencies`.
  externalDepsNote: `as dependencies of this package (for example @solana/web3.js, axios, ethers, bs58,
commander, dotenv, jsonld, tweetnacl, and zod)`,
  // docs/idempotency.md is linked from the README, so it must reach the tarball.
  requiredFiles: [
    'LICENSE',
    'NOTICE',
    'README.md',
    'THIRD-PARTY-NOTICES.txt',
    'package.json',
    'docs/idempotency.md',
    'docs/signing.md',
    'docs/awarding.md',
  ],
  consumer: {
    moduleFormat: 'cjs',
    // The README's TypeScript, compiled against the packed tarball so a documented example
    // cannot drift from the published types.
    snippetFiles: ['readme-snippets.ts', 'signing-snippets.ts', 'awarding-snippets.ts'],
    // The snippets use `process`, which no shipped type brings in on its own. It resolves without
    // this today only because ethers happens to carry @types/node as a runtime dependency; that is
    // not ours to rely on, and losing it would fail the README examples for an unrelated reason.
    // Pinned to the Node major the guard runs on rather than left floating. Unpinned, npm
    // resolves whatever is latest, which type-checks the consumer against typings for a
    // runtime nothing here uses, and takes every PR down when a publish lands broken:
    // 26.6.0 resolves but its tarball 404s.
    extraInstalls: ['@types/node@22'],
    // The README shows the npm name; the tarball installs under the manifest name, because the
    // publish workflow relabels the scope. Rewritten so the snippets resolve either way.
    selfSpecifierAliases: ['@atumlabs/payment-gateway-client'],
    // skipLibCheck stays OFF, deliberately: that is what catches a shipped .d.ts importing a
    // file the tarball does not include. Only `target` is lifted off the tsc CLI default of
    // ES5, which no consumer of this package could actually be on -- the shipped .d.ts now
    // references ethers' types (via the approval helper's signer AND the signing subpath's),
    // and ethers' own declarations use private identifiers and BigInt, so ES5 fails on ethers'
    // hygiene rather than on ours (TS18028). docs/signing.md tells customers to hold keys in an
    // ethers Wallet, so compiling that advice at all means compiling it the way an ethers
    // consumer must. `module: commonjs` is pinned with it because tsc's default module follows
    // the target, and this package ships CJS.
    tsconfig: {
      target: 'es2022',
      module: 'commonjs',
      moduleResolution: 'node',
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    },
    typeCheckLabel: 'es2022 target, skipLibCheck OFF',
    imports: {
      // The symbols used by the README examples, so a break in the public surface
      // fails this check.
      '.': [
        'PERMIT2_CONTRACT_ADDRESS',
        'PaymentGatewayClient',
        'encodeU64LE',
        'normalizeAddress',
        'createSenderSigner',
        'signPaymentRequest',
        'getErrorResponse',
        'isGatewayTimeoutError',
        'waitForStatus',
        'waitForTerminalStatus',
        'isTerminalStatus',
        'OpenAPI',
        // Re-exported from an inlined workspace sibling, so this is the check that proves it
        // resolves from the packed tarball rather than only inside the workspace.
        'InvalidAccountError',
        // Same reason: these come from the shared token-approval sibling, inlined at build
        // time, so this is what proves the re-export resolves from the packed tarball.
        'ensureSourceApproval',
        'needsSourceApproval',
        'isUnconfirmed',
      ],
      // The signing surface moved to its own subpath so the JSON-LD stack is opt-in. Checking it
      // HERE is what proves the subpath actually resolves from the packed tarball -- an exports
      // map that names a file tsup did not emit fails only at a consumer's install, not ours.
      // The libraries behind these read JSON-LD contexts at runtime, so this also fails if
      // dist/contexts or the prologue that points at it goes missing.
      './signing': [
        'signDeclaration',
        'verifyDeclaration',
        'computeRequestHash',
        'signerFromEthersWallet',
        'buildEnvelope',
        'buildEnvelopeForAccount',
        'verifyPaymentRequest',
        'verifyFulfillmentQuote',
        'signSessionPresentation',
        'requestSessionToken',
        'createSessionTokenSource',
        'createDPoPKey',
        'createDPoPProof',
        'SessionTokenError',
      ],
    },
  },
};
