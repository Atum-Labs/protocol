import { describe, it, expect } from 'vitest';

import { sameAddress, sameAssetIdentifier } from './internal.js';

// verify() compares the payer's destination asset against the merchant's advertised one, and the
// deposit signature does not bind that field. So folding case where case is significant would
// accept a byte-distinct token, which is what these rows pin.
const EVM_CHECKSUMMED = 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const TRON = 'tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const SOLANA =
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/spl:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('sameAddress', () => {
  // Every caller compares a payer supplied field, and those arrive untyped, so a wrong type has to
  // read as not equal rather than throwing out of the comparison.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', {}],
  ])('treats %s as not the same address', (_label, wrongType) => {
    expect(
      sameAddress(wrongType as unknown as string, '0x0000000000000000000000000000000000000001'),
    ).toBe(false);
    expect(
      sameAddress('0x0000000000000000000000000000000000000001', wrongType as unknown as string),
    ).toBe(false);
  });

  it('still folds EVM case and still compares base58 exactly', () => {
    expect(
      sameAddress(
        '0xAbC0000000000000000000000000000000000001',
        '0xabc0000000000000000000000000000000000001',
      ),
    ).toBe(true);
    expect(
      sameAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t'),
    ).toBe(false);
  });
});

describe('sameAssetIdentifier', () => {
  it.each([
    ['identical', EVM_CHECKSUMMED, EVM_CHECKSUMMED],
    [
      'EVM token case, which EIP-55 makes non-semantic',
      EVM_CHECKSUMMED,
      EVM_CHECKSUMMED.toLowerCase(),
    ],
    ['a shouted chain namespace, which CAIP pins lowercase', TRON, TRON.replace('tron:', 'TRON:')],
    ['a shouted asset namespace', TRON, TRON.replace('trc20:', 'TRC20:')],
    [
      'a tron cluster name, an ASCII label the payment client folds',
      TRON,
      TRON.replace('mainnet', 'MAINNET'),
    ],
  ])('matches on %s', (_label, a, b) => {
    expect(sameAssetIdentifier(a, b)).toBe(true);
  });

  it.each([
    // Base58 encodes case, so a fold names a value the encoding never calls equal. Whether the
    // folded form decodes at all varies: Tron carries a checksum that a fold breaks, while a
    // Solana pubkey carries none, so there a fold can be another valid key.
    ['a folded tron token reference', TRON, TRON.toLowerCase()],
    ['a folded solana mint', SOLANA, SOLANA.toLowerCase()],
    [
      'a folded solana chain reference',
      SOLANA,
      SOLANA.replace('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', '5eykt4usfv8p8njdtrepy1vzqkqzkvdp'),
    ],
    [
      'a different token entirely',
      EVM_CHECKSUMMED,
      'eip155:42161/erc20:0x0000000000000000000000000000000000000001',
    ],
    ['a different chain', TRON, TRON.replace('mainnet', 'shasta')],
  ])('refuses %s', (_label, a, b) => {
    expect(sameAssetIdentifier(a, b)).toBe(false);
  });

  it.each(['', 'eip155:42161', 'eip155:42161/erc20', 'no-slash-or-colon'])(
    'refuses the malformed identifier %j rather than guessing',
    (malformed) => {
      expect(sameAssetIdentifier(malformed, EVM_CHECKSUMMED)).toBe(false);
    },
  );

  // The payer's value is untyped at the call site, so a non string has to come back as a mismatch
  // rather than a type error. verify() then reports the destination the way it reports any other.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a boolean', true],
    ['an object', {}],
    ['an array whose elements would otherwise parse', [':', '/', ':']],
  ])('refuses the non string identifier %s rather than throwing', (_label, wrongType) => {
    expect(sameAssetIdentifier(wrongType as unknown as string, EVM_CHECKSUMMED)).toBe(false);
  });
});
