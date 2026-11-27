import { describe, expect, it } from 'vitest';

import { encodePayload } from './solana';

// The invariant that makes the encoding choice safe: whichever encoding is chosen, Turnkey must
// reconstruct the exact bytes the caller passed. Ed25519 signs verbatim, so a mismatch here would
// mean signing something other than what was asked for.
function reconstruct(r: { payload: string; encoding: string }): Buffer {
  return r.encoding === 'PAYLOAD_ENCODING_TEXT_UTF8'
    ? Buffer.from(r.payload, 'utf8')
    : Buffer.from(r.payload, 'hex');
}

describe('encodePayload', () => {
  it('sends the gateway handshake as readable text', () => {
    const bytes = Buffer.from('settler-agent:gw-handshake:v1\n' + 'ab'.repeat(32), 'utf8');
    const r = encodePayload(bytes);

    expect(r.encoding).toBe('PAYLOAD_ENCODING_TEXT_UTF8');
    expect(r.payload).toContain('settler-agent:gw-handshake:v1');
    expect(reconstruct(r).equals(bytes)).toBe(true);
  });

  it('keeps a W3C proof preimage binary', () => {
    // proofHash || docHash, two 32-byte digests. Not valid UTF-8, so it must stay hex.
    const bytes = Buffer.alloc(64);
    for (let i = 0; i < 64; i++) bytes[i] = (i * 37 + 200) & 0xff;
    const r = encodePayload(bytes);

    expect(r.encoding).toBe('PAYLOAD_ENCODING_HEXADECIMAL');
    expect(reconstruct(r).equals(bytes)).toBe(true);
  });

  it('reconstructs the exact input for every payload, which is what keeps the choice safe', () => {
    const cases: Buffer[] = [
      Buffer.from('plain ascii', 'utf8'),
      Buffer.from('unicode ✓ é 日本語', 'utf8'),
      Buffer.alloc(0),
      Buffer.from([0x00, 0x01, 0x02]),
      Buffer.from([0xff, 0xfe, 0xfd]), // invalid UTF-8, must not be sent as text
      Buffer.from([0xed, 0xa0, 0x80]), // lone surrogate, decodes lossily
    ];
    // UTF-8 validity boundaries, where a decoder may substitute U+FFFD. These carry the real
    // coverage: a linear stride over 0..255 hits some incidentally but none deliberately.
    cases.push(
      Buffer.from([0x80]), // bare continuation byte
      Buffer.from([0xc2]), // truncated two-byte lead
      Buffer.from([0xe2, 0x82]), // truncated three-byte lead
      Buffer.from([0xf0, 0x9f, 0x92]), // truncated four-byte lead
      Buffer.from([0xf4, 0x90, 0x80, 0x80]), // past U+10FFFF
      Buffer.from([0xc0, 0xaf]), // overlong encoding of '/'
      Buffer.from([0xe0, 0x80, 0xaf]), // overlong three-byte
      Buffer.from([0xed, 0xa0, 0x80]), // lone high surrogate
      Buffer.from([0xed, 0xbf, 0xbf]), // lone low surrogate
      Buffer.from([0xfe, 0xff]), // never valid in UTF-8
    );
    for (let i = 0; i < 200; i++) {
      const b = Buffer.alloc(32);
      for (let j = 0; j < 32; j++) b[j] = (i * 31 + j * 17) & 0xff;
      cases.push(b);
    }

    for (const bytes of cases) {
      const r = encodePayload(bytes);
      expect(reconstruct(r).equals(bytes), `failed for ${bytes.toString('hex')}`).toBe(true);
    }
  });

  it('keeps a valid-UTF-8 binary payload on the hex path', () => {
    // A proof preimage could in principle decode cleanly. Requiring textual bytes, not merely
    // decodable ones, is what stops such a payload being treated as a message.
    const bytes = Buffer.alloc(64);
    for (let i = 0; i < 64; i++) bytes[i] = i % 0x20; // valid UTF-8, all control characters

    const r = encodePayload(bytes);

    expect(r.encoding).toBe('PAYLOAD_ENCODING_HEXADECIMAL');
    expect(reconstruct(r).equals(bytes)).toBe(true);
  });

  it('rejects every UTF-8 boundary sequence as text', () => {
    for (const bytes of [
      Buffer.from([0x80]),
      Buffer.from([0xe2, 0x82]),
      Buffer.from([0xf4, 0x90, 0x80, 0x80]),
      Buffer.from([0xc0, 0xaf]),
      Buffer.from([0xed, 0xa0, 0x80]),
    ]) {
      const r = encodePayload(bytes);
      expect(r.encoding, bytes.toString('hex')).toBe('PAYLOAD_ENCODING_HEXADECIMAL');
      expect(reconstruct(r).equals(bytes)).toBe(true);
    }
  });

  it('never claims text for bytes that do not survive a UTF-8 round trip', () => {
    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from([0xc0, 0x80]),
      Buffer.from([0xed, 0xa0, 0x80]),
    ]) {
      expect(encodePayload(bytes).encoding).toBe('PAYLOAD_ENCODING_HEXADECIMAL');
    }
  });
});
