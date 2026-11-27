import { describe, it, expect } from 'vitest';
import {
  sameAddress,
  resolvePermitNonce,
  resolvePermitDeadline,
  parseSourceAsset,
} from './utils.js';

describe('sameAddress', () => {
  it('compares EVM addresses case-insensitively', () => {
    expect(sameAddress('0xABCD', '0xabcd')).toBe(true);
  });
  it('compares base58 (non-0x) addresses exactly', () => {
    expect(sameAddress('So1anaAddr', 'So1anaAddr')).toBe(true);
    expect(sameAddress('So1anaAddr', 'so1anaaddr')).toBe(false);
  });
});

describe('resolvePermitNonce / resolvePermitDeadline', () => {
  it('uses the supplied nonce verbatim', () => {
    expect(resolvePermitNonce('42')).toBe(42n);
    expect(resolvePermitNonce(7n)).toBe(7n);
  });
  it('uses the supplied absolute deadline verbatim (no fallback)', () => {
    expect(resolvePermitDeadline(1924991999)).toBe(1924991999n);
    expect(resolvePermitDeadline(1924991999n)).toBe(1924991999n);
    expect(resolvePermitDeadline(Number.MAX_SAFE_INTEGER)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect(() => resolvePermitDeadline(2n ** 53n)).toThrow(
      'sender_auth: permit deadline 9007199254740992 is outside 0..9007199254740991',
    );
    expect(() => resolvePermitDeadline(-1n)).toThrow(/is outside 0\.\./);
  });
});

describe('parseSourceAsset', () => {
  it('accepts exactly <network>/<ns>:<address>', () => {
    expect(parseSourceAsset('eip155:1/erc20:0x5555555555555555555555555555555555555555')).toEqual({
      network: 'eip155:1',
      asset: '0x5555555555555555555555555555555555555555',
    });
  });

  // A second separator is refused, so the two bindings never bind different tokens for one
  // identifier. The Go mirror refuses this exact list with the same message text.
  it.each([
    'eip155:1//erc20:0x5555555555555555555555555555555555555555',
    'eip155:1/erc20::0x5555555555555555555555555555555555555555',
    'eip155:1/erc20:0x5555555555555555555555555555555555555555:0x6666666666666666666666666666666666666666',
    'eip155:1/erc20:',
    'eip155:1/erc20',
    'eip155:1',
    '/erc20:0x1',
    '',
  ])('refuses %s', (identifier) => {
    expect(() => parseSourceAsset(identifier)).toThrow(/invalid source asset/);
  });

  it('refuses the CAIP-19 token-id form by name', () => {
    // The wire schema permits it, but a deposit binds a fungible amount, so reading the
    // collection address as the token would sign a permit this flow cannot settle. The Go mirror
    // refuses the same input with the same wording.
    expect(() =>
      parseSourceAsset('eip155:1/erc721:0x06012c8cf97BEaD5deAe237070F9587f8E7A266d/771769'),
    ).toThrow(/names a token id/);
  });

  it('refuses an empty asset namespace', () => {
    // The schema's namespace pattern does not allow an empty namespace either.
    expect(() => parseSourceAsset('eip155:1/:0x5555555555555555555555555555555555555555')).toThrow(
      /invalid source asset/,
    );
  });

  it('quotes the offending value the way the Go mirror does', () => {
    // Go formats with %q, so the TS message escapes rather than interpolating a raw control
    // character. The two escape syntaxes are not identical for every byte, so a shared reject
    // vector should stay clear of exotic ones.
    expect(() => parseSourceAsset('eip155:1\nerc20')).toThrow(
      /invalid source asset "eip155:1\\nerc20"/,
    );
  });
});
