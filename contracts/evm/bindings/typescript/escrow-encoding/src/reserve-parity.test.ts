import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { computePaymentIdV2 } from './payment-id';

// Cross-side parity: the TS deposit id reproduces the committed vectors the Go encoder is pinned to
// (../../go/encoding/reserve_parity_test.go asserts the same file).

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectorsPath = resolve(__dirname, '../../../../conformance/vectors.json');

interface PaymentIdVector {
  name: string;
  depositor: string;
  signature: string;
  nonce: string;
  expectedPaymentId: string;
}

const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as { paymentId: PaymentIdVector[] };

describe('EVM cross-side parity (committed vectors)', () => {
  it('has a non-empty vector set', () => {
    expect(vectors.paymentId.length).toBeGreaterThan(0);
  });

  it.each(vectors.paymentId)('deposit id matches Go: $name', (v) => {
    const id = computePaymentIdV2(v.depositor, v.signature, v.nonce);
    expect(id.toLowerCase()).toBe(v.expectedPaymentId.toLowerCase());
  });
});
