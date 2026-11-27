// Lint for the Stellar deploy scripts. They are not an SDK shipped to integrators, so they sit outside
// the root config's LINTED_PACKAGES (which also prunes every `source/` directory); this is a
// package-local config on the same eslint + typescript-eslint the root installs.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'vitest.config.ts'],
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
