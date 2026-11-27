import { describe, expect, it } from 'vitest';

import { depositsAsOriginator, fulfillsAsOriginator } from './eip3009.js';

// Mirrors TestFulfillsAsOriginator and TestDepositsAsOriginator in bindings/go/eip3009_test.go.
describe('fulfillsAsOriginator', () => {
  it.each([
    ['absent', undefined, false],
    ['settler', 'settler', false],
    ['originator', 'originator', true],
    [
      'split originator fulfill',
      { deposit: 'settler', reserve: 'settler', fulfill: 'originator' },
      true,
    ],
    [
      'split settler fulfill',
      { deposit: 'originator', reserve: 'originator', fulfill: 'settler' },
      false,
    ],
    ['unknown type', 1, false],
  ])('%s', (_name, executor, want) => {
    expect(fulfillsAsOriginator(executor)).toBe(want);
  });
});

describe('depositsAsOriginator', () => {
  it.each([
    ['absent', undefined, false],
    ['settler', 'settler', false],
    ['originator', 'originator', true],
    [
      'split originator deposit',
      { deposit: 'originator', reserve: 'settler', fulfill: 'originator' },
      true,
    ],
    [
      'split settler deposit',
      { deposit: 'settler', reserve: 'settler', fulfill: 'originator' },
      false,
    ],
    ['unknown type', 1, false],
  ])('%s', (_name, executor, want) => {
    expect(depositsAsOriginator(executor)).toBe(want);
  });
});
