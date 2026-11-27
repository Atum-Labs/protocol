import { requirePinnedSender } from './pinned-address';

// The guard both providers share. Its contract is narrow on purpose: absent means the caller
// opted out of the sender check, and anything present has to name an address.
describe('requirePinnedSender', () => {
  const BLANK = /must be a non-empty address/;

  it('treats undefined and null as an omitted pin', () => {
    expect(requirePinnedSender(undefined)).toBeUndefined();
    expect(requirePinnedSender(null)).toBeUndefined();
  });

  it.each(['', ' ', '   ', '\t', '\n', ' \t\n '])('rejects a blank pin (%j)', (value) => {
    expect(() => requirePinnedSender(value)).toThrow(BLANK);
  });

  it('rejects a non-string pin with the same message rather than a TypeError', () => {
    // Reachable from an untyped caller, where 0 and false would previously have counted as
    // omitting the pin and skipped the sender check.
    for (const value of [0, 1, false, true, {}, []]) {
      expect(() => requirePinnedSender(value as never)).toThrow(BLANK);
    }
  });

  it('returns an address verbatim, without trimming it', () => {
    // Trimming here would accept a padded address that the rest of the request still carries
    // padded. A padded value stays a mismatch, reported against what the caller passed.
    expect(requirePinnedSender('0xF0D0')).toBe('0xF0D0');
    expect(requirePinnedSender(' 0xF0D0 ')).toBe(' 0xF0D0 ');
  });
});
