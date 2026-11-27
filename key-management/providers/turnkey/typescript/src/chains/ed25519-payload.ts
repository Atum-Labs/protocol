// Shared by the ed25519 chain signers (Solana, Stellar). Kept free of chain SDK imports so
// neither signer pulls in the other's optional peer dependency.

/**
 * Choose the Turnkey payload encoding for `bytes`.
 *
 * Ed25519 signs the bytes verbatim, so both encodings yield the same signature over the same bytes.
 * Sending text as TEXT_UTF8 makes the payload legible in Turnkey's activity log and in any approval
 * UI, instead of an opaque hex blob.
 *
 * Two conditions gate the text path, and both matter:
 *
 * 1. An exact re-encode. Decoding and re-encoding must reproduce the input, so Turnkey can never be
 *    handed different bytes than the caller passed. A validity check alone would not give that,
 *    since a lossy decode substitutes U+FFFD and still "succeeds".
 * 2. Printable ASCII plus tab, newline and carriage return. Close to the range Solana's own
 *    off-chain message spec uses for its hardware-wallet-displayable format, widened only by the
 *    whitespace the gateway handshake actually contains: its domain prefix ends in a newline. This
 *    keeps a payload that merely happens to decode from being treated as a message. A W3C proof
 *    preimage is two concatenated digests, so it fails on both counts rather than only on the
 *    first.
 *
 * KNOWN LIMITATION, and it is the reason this is not an authorization boundary: the choice is a
 * property of the VALUE, not of the call site. A policy that permitted message signing and refused
 * binary would be keying on something this function infers rather than something the caller
 * declared. Treat the encoding as a legibility improvement, not a security control.
 */
export function encodePayload(bytes: Uint8Array): {
  payload: string;
  encoding: 'PAYLOAD_ENCODING_TEXT_UTF8' | 'PAYLOAD_ENCODING_HEXADECIMAL';
} {
  const buf = Buffer.from(bytes);
  const text = buf.toString('utf8');
  const textual = buf.every(
    (b) => (b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d,
  );
  if (textual && Buffer.from(text, 'utf8').equals(buf)) {
    return { payload: text, encoding: 'PAYLOAD_ENCODING_TEXT_UTF8' };
  }
  return { payload: buf.toString('hex'), encoding: 'PAYLOAD_ENCODING_HEXADECIMAL' };
}
