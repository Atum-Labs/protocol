module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // uuid (pulled in transitively via @solana/web3.js) ships ESM that jest's
  // CommonJS loader cannot parse. Pin all uuid imports to a single CJS entry.
  moduleNameMapper: {
    '^uuid$': require.resolve('uuid'),
    // The shared PaymentRequest validator is TypeScript source that imports its siblings with ESM
    // `.js` specifiers; map them back to the `.ts` files ts-jest compiles.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Resolves the in-repo @atum-labs/* packages from their compiled output, so run
  // `pnpm run build:deps` first; a bare `jest` may otherwise run against a stale build.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.gen.ts',
    // Test scaffolding, not shipped code: src/test-support holds the contract-driven fake gateway
    // the CLI tests run against. It is covered by its own suite, not by this figure.
    '!src/test-support/**',
    '!src/index.ts',
  ],
};
