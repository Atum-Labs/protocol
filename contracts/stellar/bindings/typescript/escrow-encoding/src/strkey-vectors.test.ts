import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ACCOUNT_ADDRESS, Address, CONTRACT_ADDRESS } from './address';
import { InvalidStrkeyError, UnsupportedAddressError } from './errors';

/**
 * Asserts contracts/stellar/conformance/strkey-vectors.json, the one file every hand-written strkey decoder in
 * this repo is tested against: this package (the single TypeScript decoder), its Go sibling, and the
 * chain-address and FulfillmentQuote signing packages, which call it.
 */
interface StrkeyVectors {
  valid: { name: string; address: string; kind: 'account' | 'contract'; payloadHex: string }[];
  invalid: { name: string; address: string; error: 'invalid_strkey' | 'unsupported_address' }[];
}

const vectors: StrkeyVectors = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', '..', 'conformance', 'strkey-vectors.json'), 'utf8'),
);

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('shared strkey vectors', () => {
  it('has cases to run', () => {
    expect(vectors.valid.length).toBeGreaterThan(0);
    expect(vectors.invalid.length).toBeGreaterThan(0);
  });

  it.each(vectors.valid.map((c) => [c.name, c] as const))('decodes %s', (_name, c) => {
    const addr = Address.fromStrkey(c.address);
    expect(addr.type).toBe(c.kind === 'account' ? ACCOUNT_ADDRESS : CONTRACT_ADDRESS);
    expect(hex(addr.toBytes())).toBe(c.payloadHex);
    expect(addr.toString()).toBe(c.address);
  });

  it.each(vectors.invalid.map((c) => [c.name, c] as const))('refuses %s', (_name, c) => {
    const errorClass = c.error === 'unsupported_address' ? UnsupportedAddressError : InvalidStrkeyError;
    expect(() => Address.fromStrkey(c.address)).toThrow(errorClass);
  });
});
