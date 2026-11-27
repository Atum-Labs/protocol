import { describe, it, expect } from 'vitest';
import { computePaymentIdV2 } from './payment-id';
import { generateNonce } from './nonce-generator';
import { createPermit2Domain } from './permit-types';

describe('computePaymentIdV2', () => {
  const depositor = '0x1234567890abcdef1234567890abcdef12345678';

  it('is a deterministic keccak256 hash', () => {
    const id = computePaymentIdV2(depositor, '0xdeadbeef', '1');
    expect(id).toBe(computePaymentIdV2(depositor, '0xdeadbeef', '1'));
    expect(id).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('changes with the depositor, the signature and the nonce', () => {
    const base = computePaymentIdV2(depositor, '0xaa', '1');
    expect(computePaymentIdV2('0x1111111111111111111111111111111111111111', '0xaa', '1')).not.toBe(base);
    expect(computePaymentIdV2(depositor, '0xbb', '1')).not.toBe(base);
    expect(computePaymentIdV2(depositor, '0xaa', '2')).not.toBe(base);
  });
});

describe('generateNonce', () => {
  it('should produce a 32-byte hex string', () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('should produce unique nonces', () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 50; i++) {
      nonces.add(generateNonce());
    }
    expect(nonces.size).toBe(50);
  });
});

describe('createPermit2Domain', () => {
  it('should create a domain with name Permit2', () => {
    const domain = createPermit2Domain(1, '0xabc');
    expect(domain.name).toBe('Permit2');
    expect(domain.chainId).toBe(1);
    expect(domain.verifyingContract).toBe('0xabc');
  });
});
