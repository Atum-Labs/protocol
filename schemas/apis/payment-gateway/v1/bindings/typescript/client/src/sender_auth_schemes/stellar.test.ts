import {
  deterministicStellarNonce,
  generateStellarNonce,
  STELLAR_MAX_DEPOSIT_VALIDITY_SECS,
} from './stellar';

describe('stellar deposit helpers', () => {
  it('bounds a deposit at the escrow one day validity', () => {
    expect(STELLAR_MAX_DEPOSIT_VALIDITY_SECS).toBe(86400);
  });

  it('derives the nonce from the request id and depositor, as an unsigned 64-bit integer', () => {
    const depositor = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37';
    const a = deterministicStellarNonce({ requestId: 'req-1', depositor });
    expect(a).toBe(deterministicStellarNonce({ requestId: 'req-1', depositor }));
    expect(a).not.toBe(deterministicStellarNonce({ requestId: 'req-2', depositor }));
    expect(a).toBeGreaterThanOrEqual(0n);
    expect(a).toBeLessThan(1n << 64n);
  });

  it('generates distinct random u64 nonces', () => {
    const nonces = new Set(Array.from({ length: 16 }, () => generateStellarNonce()));
    expect(nonces.size).toBe(16);
    for (const n of nonces) expect(n).toBeLessThan(1n << 64n);
  });
});
