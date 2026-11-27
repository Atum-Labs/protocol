import { describe, expect, it } from 'vitest';

import { createTurnkeyStamper, p1363ToDer } from './stamp';

// Deterministic P-256 test keypair (generated once for these tests; not used elsewhere).
const TEST_PRIV_HEX = '46a9d0f5ea716b8c0d1c1e9a396615404ab6879e517eb6d00c01363aafa4f080';
const TEST_PUB_HEX = '032b01510e9c021a628b035ca480b51a4bc174a5fc670364cdc09810ffa785991e';

describe('createTurnkeyStamper', () => {
  it('rejects a non-32-byte private scalar', async () => {
    await expect(createTurnkeyStamper('ab'.repeat(16), TEST_PUB_HEX)).rejects.toThrow(/32-byte/);
  });

  it('rejects a malformed compressed public key', async () => {
    await expect(createTurnkeyStamper(TEST_PRIV_HEX, '04' + 'ab'.repeat(32))).rejects.toThrow(
      /02\/03 prefix/,
    );
  });

  it('produces a base64url X-Stamp envelope carrying the public key, DER signature, and scheme', async () => {
    const stamper = await createTurnkeyStamper(TEST_PRIV_HEX, TEST_PUB_HEX);
    const stamp = await stamper.stamp('{"hello":"world"}');
    const envelope = JSON.parse(Buffer.from(stamp, 'base64url').toString('utf8'));
    expect(envelope.publicKey).toBe(TEST_PUB_HEX);
    expect(envelope.scheme).toBe('SIGNATURE_SCHEME_TK_API_P256');
    // DER signature: SEQUENCE { INTEGER r, INTEGER s }. Length varies 70-72 bytes typically;
    // encoded hex therefore 140-146 chars.
    expect(envelope.signature).toMatch(/^30[0-9a-f]{2,}$/i);
    expect(envelope.signature.length).toBeGreaterThanOrEqual(140);
    expect(envelope.signature.length).toBeLessThanOrEqual(146);
  });

  it('produces different signatures for different request bodies (no nonce reuse risk)', async () => {
    const stamper = await createTurnkeyStamper(TEST_PRIV_HEX, TEST_PUB_HEX);
    const s1 = await stamper.stamp('{"a":1}');
    const s2 = await stamper.stamp('{"a":2}');
    expect(s1).not.toBe(s2);
  });

  it('exposes publicKeyHex on the stamper instance', async () => {
    const stamper = await createTurnkeyStamper(TEST_PRIV_HEX, TEST_PUB_HEX);
    expect(stamper.publicKeyHex).toBe(TEST_PUB_HEX);
  });
});

describe('p1363ToDer', () => {
  // Degenerate ECDSA signatures (r=0 or s=0) are wire-encodable but cryptographically broken.
  // The guard catches a malformed stamper output at the source so it surfaces as a stamper
  // error rather than masquerading as a Turnkey 401 (TURNKEY_AUTH terminal).
  it('throws on r=0 (all-zero r component)', () => {
    const sig = new ArrayBuffer(64);
    new Uint8Array(sig).set([0x01], 63); // s != 0, r == 0
    expect(() => p1363ToDer(sig)).toThrow(/degenerate ECDSA/);
  });

  it('throws on s=0 (all-zero s component)', () => {
    const sig = new ArrayBuffer(64);
    new Uint8Array(sig).set([0x01], 31); // r != 0, s == 0
    expect(() => p1363ToDer(sig)).toThrow(/degenerate ECDSA/);
  });

  it('accepts legitimate small components (r=1, s=1)', () => {
    const sig = new ArrayBuffer(64);
    const view = new Uint8Array(sig);
    view[31] = 0x01;
    view[63] = 0x01;
    expect(() => p1363ToDer(sig)).not.toThrow();
  });
});
