// Package-specific inputs for the shared release tooling (@atum-labs/publish-guard).
// The checks themselves live in tooling/publish-guard; this file carries only what
// differs between packages.
export default {
  displayName: '@atumlabs/x402-atum-escrow',
  requiredFiles: ['LICENSE', 'NOTICE', 'README.md', 'THIRD-PARTY-NOTICES.txt', 'package.json'],
  // Reproduced verbatim in the notices header. This package externalizes its whole
  // third-party stack (nothing is a peer dependency), so the wording names the
  // dependencies npm installs alongside the tarball.
  externalDepsNote: `as dependencies of this package (for example @x402/core, @x402/fetch, ethers,
ajv, bs58, tweetnacl, and zod)`,
  consumer: {
    moduleFormat: 'esm',
    typeCheckLabel: 'nodenext, exports map',
    // Every third-party library this package uses is a real `dependency`, so npm
    // installs them transitively from the tarball; nothing extra is needed for the
    // shipped .d.ts to resolve.
    extraInstalls: [],
    // nodenext so the ESM `exports` map (the four role subpaths) is exercised for
    // real rather than resolved the CJS way.
    tsconfig: {
      module: 'nodenext',
      moduleResolution: 'nodenext',
      target: 'es2022',
      strict: true,
      noEmit: true,
      // Realistic consumer setting. `false` would type-check the @x402/* .d.ts, which
      // reference x402's own optional peers that a scheme consumer never installs —
      // that tests x402's hygiene, not ours. tsup dts.resolve inlines our bundled
      // siblings, so our shipped .d.ts carries no dangling relative imports.
      skipLibCheck: true,
    },
    // One representative class plus the registrar per role, plus any name whose resolution
    // the representative does not prove: if a role's public surface breaks, the guard fails
    // before the tarball is published.
    imports: {
      // ensureSourceApproval/needsSourceApproval come from an inlined workspace sibling
      // (the shared token-approval package), so listing them here is what proves the
      // re-export still resolves from the packed tarball rather than only in the workspace.
      './client': [
        'AtumEscrowClientScheme',
        'registerAtumEscrowScheme',
        'withPaymentIdentifier',
        'ensureSourceApproval',
        'needsSourceApproval',
        'isUnconfirmed',
        // The trust source and cap bound are what a payer off Atum's production gateways
        // must configure, so a release that dropped them would break those payers.
        'AtumEscrowTrustError',
        'ATUM_DEFAULT_TRUST_GATEWAYS',
        'atumGatewayTrust',
        'DEFAULT_MAX_MARKUP_BPS',
        'DEFAULT_PEG_GROUPS',
      ],
      // Every route must be priced with atumEscrowPrice and every boot failure is an
      // AtumEscrowConfigError, so a release that dropped either would break every merchant.
      './server': [
        'AtumEscrowServerScheme',
        'registerAtumEscrowScheme',
        'atumEscrowPrice',
        'AtumEscrowConfigError',
        'DEFAULT_PEG_GROUPS',
      ],
      // The trust API is re-exported here from the client's code, across bundle entries, so
      // listing it is what proves that re-export resolves from the packed tarball.
      './facilitator': [
        'AtumEscrowFacilitatorScheme',
        'registerAtumEscrowScheme',
        'AtumEscrowTrustError',
        'ATUM_DEFAULT_TRUST_GATEWAYS',
        'atumGatewayTrust',
      ],
      './fetch': ['wrapFetchWithAtumPayment'],
    },
    subpaths: ['./client', './server', './facilitator', './fetch'],
  },
};
