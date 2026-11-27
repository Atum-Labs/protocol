import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyRequestCommitment } from './commitment.js';
import { verifyPaymentRequestJSON } from './verify.js';

// The readme tells integrators to copy example.json, so it must pass every check a verifier runs.
describe('example.json', () => {
  const raw = readFileSync(resolve(__dirname, '../../../../example.json'), 'utf8');

  it('passes the payee check', () => {
    expect(verifyRequestCommitment(raw).outcome).toBe('verified');
  });

  it('passes the JSON entry point', () => {
    const result = verifyPaymentRequestJSON(raw, { nowSec: 1700000000 });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.amount).toBe('1000001');
  });
});
