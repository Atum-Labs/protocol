import { describe, it, expect } from 'vitest';
import { SCHEME_RAW_HASH, WitnessKind, acceptedForms, signingBytes } from './scheme';

const hash = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

describe('signingBytes', () => {
  it.each([
    ['raw deposit', WitnessKind.Deposit],
    ['raw reserve', WitnessKind.Reserve],
    ['raw release', WitnessKind.Release],
    ['raw refund', WitnessKind.Refund],
  ])('%s returns the hash', (_name, kind) => {
    const got = signingBytes(SCHEME_RAW_HASH, kind, hash);
    expect(got).toEqual(hash);
    expect(got).not.toBe(hash);
  });

  it.each([
    ['unknown scheme', 'text', WitnessKind.Release, hash, 'unknown message scheme "text"'],
    ['scheme of one space', ' ', WitnessKind.Release, hash, 'unknown message scheme'],
    ['kind zero', SCHEME_RAW_HASH, 0 as WitnessKind, hash, 'unknown witness kind 0'],
    ['kind past refund', SCHEME_RAW_HASH, 5 as WitnessKind, hash, 'unknown witness kind 5'],
    ['fractional kind', SCHEME_RAW_HASH, 1.5 as WitnessKind, hash, 'unknown witness kind'],
    ['31 byte hash', SCHEME_RAW_HASH, WitnessKind.Release, hash.subarray(1), 'must be 32 bytes'],
    ['33 byte hash', SCHEME_RAW_HASH, WitnessKind.Release, new Uint8Array(33), 'must be 32 bytes'],
  ])('%s throws', (_name, scheme, kind, h, want) => {
    expect(() => signingBytes(scheme, kind, h)).toThrow(want);
  });
});

describe('acceptedForms', () => {
  it('raw accepts raw only', () => {
    expect(acceptedForms(SCHEME_RAW_HASH)).toEqual([SCHEME_RAW_HASH]);
  });
  it('unknown scheme throws', () => {
    expect(() => acceptedForms('text')).toThrow('unknown message scheme');
  });
});
