// Package-specific inputs for the shared release tooling (@atum-labs/publish-guard).
// The checks themselves live in tooling/publish-guard; this file carries only what
// differs between packages.
export default {
  displayName: '@atumlabs/mppx-atum-escrow',
  requiredFiles: ['LICENSE', 'NOTICE', 'README.md', 'THIRD-PARTY-NOTICES.txt', 'package.json'],
  // Reproduced verbatim in the notices header. This package keeps mppx and zod as
  // peer dependencies, so the wording differs from payment-gateway-client's.
  externalDepsNote: `as (peer)dependencies of this package (for example @solana/web3.js, ethers, bs58,
tweetnacl, zod, and mppx)`,
  consumer: {
    moduleFormat: 'esm',
    typeCheckLabel: 'nodenext, exports map',
    // The shipped .d.ts keeps imports to the mppx/zod peers (they stay external),
    // so a consumer type-check needs them installed alongside the package. ethers
    // (a real dependency of the tarball) is installed transitively from the tgz.
    // viem is mppx's unbounded peer (>=2.54.0); from 2.57.16 viem declares an
    // optional peer on mppx >=0.17.0, which no mppx 0.8.x satisfies, so npm
    // refuses the tree. The bound matches the one the README tells consumers to use.
    extraInstalls: ['mppx@^0.8.12', 'zod@^4.4.3', 'viem@>=2.54.0 <2.57.16'],
    // nodenext so the ESM `exports` map (root + ./client + ./server) is exercised
    // for real rather than resolved the CJS way.
    tsconfig: {
      module: 'nodenext',
      moduleResolution: 'nodenext',
      target: 'es2022',
      strict: true,
      noEmit: true,
      // Realistic consumer setting. `false` would type-check mppx's own .d.ts,
      // which reference mppx's OPTIONAL peers (@modelcontextprotocol/sdk, elysia,
      // …) that a charge-only consumer never installs — that tests mppx's hygiene,
      // not ours. tsup dts.resolve inlines our bundled siblings, so our shipped
      // .d.ts carries no dangling relative imports.
      skipLibCheck: true,
    },
    imports: {
      // ensureSourceApproval/needsSourceApproval come from an inlined workspace sibling
      // (the shared token-approval package), so these are the check that proves the
      // re-export still resolves from the packed tarball rather than only in the workspace.
      '.': [
        'registerClient',
        'registerServer',
        'buildChargeRequest',
        'METHOD_NAME',
        'ensureSourceApproval',
        'needsSourceApproval',
        'isUnconfirmed',
        'PaymentRetryableError',
        'isPaymentRetryable',
        'gatewayRefusalOf',
      ],
      './client': [
        'registerClient',
        'ensureSourceApproval',
        'needsSourceApproval',
        'isUnconfirmed',
      ],
      './server': [
        'registerServer',
        'PaymentRetryableError',
        'isPaymentRetryable',
        'gatewayRefusalOf',
      ],
    },
    subpaths: ['.', './client', './server'],
  },
};
