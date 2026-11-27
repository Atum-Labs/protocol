import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import { getBytes, sha256 } from 'ethers';
import { base58ToHex, normalizeAddress } from './tron-address';

describe('base58ToHex', () => {
  it('converts a known Tron base58 address to 41-prefixed hex', () => {
    const result = base58ToHex('T9yD14NjG6wxkArbchsTBKawgUVqYww3tQ');
    expect(result).toMatch(/^41[0-9a-f]{40}$/);
    expect(result.toLowerCase()).toBe('41000000000022d473030f116ddee9f6b43ac78ba3');
  });

  it('throws for invalid base58 addresses', () => {
    expect(() => base58ToHex('invalid')).toThrow('Invalid Tron base58 address');
    expect(() => base58ToHex('')).toThrow('Invalid Tron base58 address');
    expect(() => base58ToHex('0x1234')).toThrow('Invalid Tron base58 address');
  });
});

describe('normalizeAddress', () => {
  it('returns 0x-prefixed 20-byte hex from base58', () => {
    expect(normalizeAddress('T9yD14NjG6wxkArbchsTBKawgUVqYww3tQ'))
      .toBe('0x000000000022d473030f116ddee9f6b43ac78ba3');
  });

  it('strips 0x and 41 prefixes', () => {
    expect(normalizeAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3'))
      .toBe('0x000000000022d473030f116ddee9f6b43ac78ba3');
    expect(normalizeAddress('41000000000022D473030F116dDEE9F6B43aC78BA3'))
      .toBe('0x000000000022d473030f116ddee9f6b43ac78ba3');
    expect(normalizeAddress('000000000022d473030f116ddee9f6b43ac78ba3'))
      .toBe('0x000000000022d473030f116ddee9f6b43ac78ba3');
  });

  it('throws value-free for invalid input, matching the gateway messages', () => {
    expect(() => normalizeAddress('')).toThrow('Empty address');
    expect(() => normalizeAddress('0x123')).toThrow('Invalid address length');
  });
});

// Rejection parity with the Go gateway NormalizeAddress: any address the
// verifier rejects must be rejected here too, or a malformed address gets signed
// on the originator side and only fails downstream.
describe('normalizeAddress / base58ToHex — gateway rejection parity', () => {
  it('rejects a corrupted base58check checksum', () => {
    const badChecksum = 'TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4qS';
    expect(() => base58ToHex(badChecksum)).toThrow();
    expect(() => normalizeAddress(badChecksum)).toThrow();
  });

  it('accepts a 20-byte hex address whose first byte is 0x41', () => {
    expect(normalizeAddress('0x41aabbccddeeff00112233445566778899aabbcc'))
      .toBe('0x41aabbccddeeff00112233445566778899aabbcc');
  });

  it('rejects an uppercase 0X prefix (gateway TrimPrefix is case-sensitive)', () => {
    expect(() => normalizeAddress('0X000000000022d473030f116ddee9f6b43ac78ba3')).toThrow();
  });

  it('accepts every valid form of the same address (regression)', () => {
    const want = '0x2e9fbe1886fa094573e3bd25c554e827873bb9fc';
    expect(normalizeAddress('TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py')).toBe(want);
    expect(normalizeAddress('0x412e9fbe1886fa094573e3bd25c554e827873bb9fc')).toBe(want);
    expect(normalizeAddress('0x2e9fbe1886fa094573e3bd25c554e827873bb9fc')).toBe(want);
  });
});

// The two bodies every case below is paired over: one whose first byte collides
// with the Tron mainnet marker, one ordinary. Shared rather than redeclared per
// block — the pairing only means anything while both blocks exercise the same
// two values, and a copy that drifted would quietly weaken one of them.
const AFFECTED_BODY = '4100112233445566778899aabbccddeeff001122';
const CONTROL_BODY = 'e96051e8da2f0cc02c372252dfacfdb129b5d4d6';

// A Tron address whose 20-byte body happens to begin with byte 0x41 is an
// ordinary address: 0x41 is a *base58check envelope* marker, not part of the
// body, so it may only be stripped from the 21-byte spelling. Stripping it from
// a bare 20-byte body truncates a real address to 19 bytes. These cases pin
// that distinction on both sides — every 0x41-leading assertion is paired with
// an ordinary body, so the two are visibly required to behave identically.
describe('normalizeAddress — bodies beginning with byte 0x41', () => {
  // Tron base58check envelope: 0x41 ‖ 20-byte body ‖ 4-byte checksum, where the
  // checksum is the first 4 bytes of the double SHA-256 of the 21-byte payload.
  // Derived rather than pasted so a typo cannot be pinned as expected output.
  const toBase58 = (body: string): string => {
    const payload = getBytes('0x41' + body);
    const checksum = getBytes(sha256(sha256(payload))).slice(0, 4);
    const envelope = new Uint8Array(payload.length + checksum.length);
    envelope.set(payload);
    envelope.set(checksum, payload.length);
    return bs58.encode(envelope);
  };

  const spellings = (body: string): Array<{ form: string; input: string }> => [
    { form: 'bare 40-char hex', input: body },
    { form: '0x-prefixed 40-char hex', input: `0x${body}` },
    { form: '42-char hex (41 + body)', input: `41${body}` },
    { form: '0x-prefixed 42-char hex', input: `0x41${body}` },
    { form: 'base58check', input: toBase58(body) },
  ];

  it('returns the body unchanged for a bare 40-char hex whose first byte is 0x41', () => {
    expect(normalizeAddress(AFFECTED_BODY)).toBe(`0x${AFFECTED_BODY}`);
    expect(normalizeAddress(CONTROL_BODY)).toBe(`0x${CONTROL_BODY}`);
  });

  it('lowercases a mixed-case bare 40-char hex whose first byte is 0x41', () => {
    expect(normalizeAddress(AFFECTED_BODY.toUpperCase())).toBe(`0x${AFFECTED_BODY}`);
    expect(normalizeAddress(CONTROL_BODY.toUpperCase())).toBe(`0x${CONTROL_BODY}`);
  });

  it.each(spellings(AFFECTED_BODY))(
    'canonicalizes the 0x41-leading address from its $form spelling',
    ({ input }) => {
      expect(normalizeAddress(input)).toBe(`0x${AFFECTED_BODY}`);
    },
  );

  it.each(spellings(CONTROL_BODY))(
    'canonicalizes the ordinary address from its $form spelling',
    ({ input }) => {
      expect(normalizeAddress(input)).toBe(`0x${CONTROL_BODY}`);
    },
  );

  it('agrees across every spelling of the 0x41-leading address', () => {
    const results = spellings(AFFECTED_BODY).map(({ input }) => normalizeAddress(input));
    expect(new Set(results).size).toBe(1);
  });

  it('agrees across every spelling of the ordinary address', () => {
    const results = spellings(CONTROL_BODY).map(({ input }) => normalizeAddress(input));
    expect(new Set(results).size).toBe(1);
  });

  // Guards the off-by-one in both directions: stripping two 41s yields 38 hex
  // characters, stripping none yields 42. Only one may be removed.
  it('removes exactly one 41 marker from a 42-char hex whose body starts with 41', () => {
    const normalized = normalizeAddress(`41${AFFECTED_BODY}`);
    expect(normalized).toHaveLength(42);
    expect(normalized).toBe(`0x${AFFECTED_BODY}`);
  });

  it('removes exactly one 41 marker from a 42-char hex with an ordinary body', () => {
    const normalized = normalizeAddress(`41${CONTROL_BODY}`);
    expect(normalized).toHaveLength(42);
    expect(normalized).toBe(`0x${CONTROL_BODY}`);
  });
});

describe('normalizeAddress — hex length and marker validation', () => {
  // Only 40 (bare body) and 42 (41 ‖ body) hex characters are legal after any
  // 0x prefix is removed. Anything else is a typo, not a shorter address.
  it.each([
    { name: '38 chars (a 0x41-leading body double-stripped)', input: AFFECTED_BODY.slice(2) },
    { name: '38 chars (ordinary body, two bytes short)', input: CONTROL_BODY.slice(2) },
    { name: '39 chars (0x41-leading body, one nibble short)', input: AFFECTED_BODY.slice(1) },
    { name: '39 chars (ordinary body, one nibble short)', input: CONTROL_BODY.slice(1) },
    { name: '41 chars (0x41-leading body, one nibble over)', input: `4${AFFECTED_BODY}` },
    { name: '41 chars (ordinary body, one nibble over)', input: `4${CONTROL_BODY}` },
    { name: '44 chars (0x41-leading body, doubly marked)', input: `4141${AFFECTED_BODY}` },
    { name: '44 chars (ordinary body, doubly marked)', input: `4141${CONTROL_BODY}` },
    { name: '0x-prefixed 38 chars', input: `0x${AFFECTED_BODY.slice(2)}` },
    { name: '0x-prefixed 44 chars', input: `0x4141${CONTROL_BODY}` },
  ])('rejects hex of $name', ({ input }) => {
    expect(() => normalizeAddress(input)).toThrow();
  });

  // A 42-char hex spelling is only valid when its leading byte is exactly 0x41.
  // The three difference classes are listed separately because a marker check
  // that compares one nibble, or that compares case-insensitively on the wrong
  // half, passes some of them and fails others.
  const wrongMarkers = [
    { marker: 'a1', klass: 'first digit differs' },
    { marker: '01', klass: 'first digit differs' },
    { marker: '42', klass: 'second digit differs' },
    { marker: '4f', klass: 'second digit differs' },
    { marker: '40', klass: 'second digit differs' },
    { marker: '00', klass: 'both digits differ' },
    { marker: 'ff', klass: 'both digits differ' },
  ];

  it.each(wrongMarkers)(
    'rejects a 42-char hex whose leading byte is $marker ($klass)',
    ({ marker }) => {
      expect(() => normalizeAddress(`${marker}${CONTROL_BODY}`)).toThrow();
      expect(() => normalizeAddress(`${marker}${AFFECTED_BODY}`)).toThrow();
    },
  );

  it.each([
    { marker: 'a1', klass: 'first digit differs' },
    { marker: '4f', klass: 'second digit differs' },
    { marker: 'ff', klass: 'both digits differ' },
  ])(
    'rejects a 0x-prefixed 42-char hex whose leading byte is $marker ($klass)',
    ({ marker }) => {
      expect(() => normalizeAddress(`0x${marker}${CONTROL_BODY}`)).toThrow();
      expect(() => normalizeAddress(`0x${marker}${AFFECTED_BODY}`)).toThrow();
    },
  );

  // An interior `0x` is address data, not a prefix. Only a leading one comes off,
  // so these stay 42 characters and are refused. A strip that matched `0x`
  // anywhere would delete the pair and leave 40 valid hex characters.
  //
  // Index 1 and 2 carry the information: a strip scanning a leading window is
  // indistinguishable from a correctly anchored one at index 20 or 38. Index 2 of
  // the 0x41-leading body is also where the two strips meet — the marker comes
  // off and the `0x` must stay, leaving 40 characters that fail the hex check.
  it.each([
    { at: 1, where: 'index 1' },
    { at: 2, where: 'index 2' },
    { at: 20, where: 'mid-body' },
    { at: 38, where: 'near the end' },
  ])('rejects a 42-char hex with an interior 0x at $where', ({ at }) => {
    for (const body of [CONTROL_BODY, AFFECTED_BODY]) {
      expect(() => normalizeAddress(body.slice(0, at) + '0x' + body.slice(at))).toThrow();
    }
  });

  // Exactly one leading prefix comes off, not a run of them. A loop would take
  // both pairs and read a 44-character string as a 20-byte address.
  it('rejects a repeated 0x prefix', () => {
    for (const body of [CONTROL_BODY, AFFECTED_BODY]) {
      expect(() => normalizeAddress(`0x0x${body}`)).toThrow();
    }
  });
});
