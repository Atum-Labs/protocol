import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import { computePaymentId } from './payment-id';

// Oracle: Go-produced depositId from tvm EscrowPaymentIdEncoder.Digest, frozen
// in the sibling Go package's testdata/reserve_parity_vectors.json.
const SIG65 =
  '0x' +
  '1111111111111111111111111111111111111111111111111111111111111111' +
  '2222222222222222222222222222222222222222222222222222222222222222' +
  '1b';

// TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py == 0x41 + 2e9fbe…b9fc.
const ADDR_B58 = 'TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py';
const ADDR_41HEX = '0x412e9fbe1886fa094573e3bd25c554e827873bb9fc';
const ADDR_PLAINHEX = '0x2e9fbe1886fa094573e3bd25c554e827873bb9fc';
const ORACLE = '0xcade6a330b88306b3b597d8b848129b5892ec9388bb17b68a4736cb925cc03b4';

describe('computePaymentId (TVM)', () => {
  it('matches the Go encoder on a known-good base58 depositor', () => {
    expect(computePaymentId(ADDR_B58, SIG65, '1')).toBe(ORACLE);
  });

  it('is form-invariant: base58, 41-hex, and plain hex derive the same depositId', () => {
    const b58 = computePaymentId(ADDR_B58, SIG65, '1');
    const hex41 = computePaymentId(ADDR_41HEX, SIG65, '1');
    const plain = computePaymentId(ADDR_PLAINHEX, SIG65, '1');
    expect(hex41).toBe(b58);
    expect(plain).toBe(b58);
  });

  it('returns a 0x-prefixed 32-byte hex value', () => {
    expect(computePaymentId(ADDR_B58, SIG65, '1')).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('changes with the nonce', () => {
    expect(computePaymentId(ADDR_B58, SIG65, '1')).not.toBe(
      computePaymentId(ADDR_B58, SIG65, '2'),
    );
  });
});

// Reject paths. normalizeTronAddress decides whether a wrong-address signature
// gets produced, so each rejection is part of the parity contract with Go's
// NormalizeAddress (empty / bad checksum / wrong length / non-hex all error).
describe('computePaymentId — rejected inputs (parity with Go NormalizeAddress)', () => {
  it('rejects an empty depositor', () => {
    expect(() => computePaymentId('', SIG65, '1')).toThrow();
  });

  it('rejects a base58 address with a bad checksum (Go validates it; TS must too)', () => {
    // Corrupt the 4-byte base58check checksum but keep the 25-byte length, so
    // only the checksum is wrong — the exact typo case Go rejects.
    const raw = Uint8Array.from(bs58.decode(ADDR_B58));
    raw[raw.length - 1] ^= 0xff;
    const badChecksum = bs58.encode(raw);
    expect(() => computePaymentId(badChecksum, SIG65, '1')).toThrow();
  });

  it('rejects a base58 string with non-base58 characters', () => {
    expect(() => computePaymentId('T0OIl0OIl0OIl0OIl0OIl0OIl0OIl', SIG65, '1')).toThrow();
  });

  it('rejects a hex address of the wrong length', () => {
    expect(() => computePaymentId('0x1234', SIG65, '1')).toThrow();
  });

  it('rejects a hex address with non-hex characters', () => {
    expect(() =>
      computePaymentId('0xzzzzbe1886fa094573e3bd25c554e827873bb9fc', SIG65, '1'),
    ).toThrow();
  });

  it('rejects an uppercase 0X prefix (Go strips only lowercase 0x)', () => {
    expect(() =>
      computePaymentId('0X2e9fbe1886fa094573e3bd25c554e827873bb9fc', SIG65, '1'),
    ).toThrow();
  });

  it('rejects a hex-string nonce (Go encoder parses nonce base-10 only)', () => {
    // '0x1a' would be 26 to ethers but unparseable as decimal to Go — a radix
    // mismatch that must not silently diverge. Accept decimal only.
    expect(() => computePaymentId(ADDR_B58, SIG65, '0x1a')).toThrow();
  });
});
