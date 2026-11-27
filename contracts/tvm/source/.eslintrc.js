module.exports = {
  env: {
    browser: false,
    es2021: true,
    node: true,
    mocha: true
  },
  extends: [
    'standard'
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  globals: {
    // TronBox/Truffle globals
    artifacts: 'readonly',
    contract: 'readonly',
    assert: 'readonly',
    web3: 'readonly',
    BigInt: 'readonly'
  },
  rules: {
    // Customize rules for your project
    'semi': ['error', 'always'],  // Require semicolons
    'quotes': ['error', 'single', { avoidEscape: true }],
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'space-before-function-paren': ['error', {
      anonymous: 'always',
      named: 'never',
      asyncArrow: 'always'
    }],
    'object-curly-spacing': ['error', 'always'],
    'array-bracket-spacing': ['error', 'never'],
    'comma-dangle': ['error', 'never'],
    'no-multiple-empty-lines': ['error', { max: 1, maxEOF: 0 }],
    'eol-last': ['error', 'always'],
    'no-console': 'off',  // Allow console.log in tests
    'max-len': ['warn', {
      code: 120,
      ignoreComments: true,
      ignoreStrings: true,
      ignoreTemplateLiterals: true
    }]
  }
};
