import nacl from 'tweetnacl';

/** The ed25519 group order. */
const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n;

/**
 * The y-coordinates, as the 32-byte little-endian encodings with the sign bit cleared, of every
 * ed25519 point whose order divides 8, canonical and not (y = p and y = p + 1). For such a public
 * key or signature R, a signature can be made without the private key. Mirrors the Go
 * `smallOrderEncodings`.
 */
const SMALL_ORDER_ENCODINGS = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
];

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** ed25519 verification that, like Go's, refuses a non-canonical S. */
export function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(signature[i]!);
  if (s >= ED25519_L) return false;
  try {
    return nacl.sign.detached.verify(message, signature, publicKey);
  } catch {
    return false;
  }
}

/** Whether a 32-byte point encoding, with either sign bit, is a point whose order divides 8. */
export function isSmallOrderEncoding(point: Uint8Array): boolean {
  if (point.length !== 32) return false;
  const masked = Uint8Array.from(point);
  masked[31]! &= 0x7f;
  return SMALL_ORDER_ENCODINGS.includes(hex(masked));
}

/**
 * ed25519 verification as the Solana ed25519 program performs it (verify_strict):
 * {@link verifyEd25519}, which refuses a non-canonical S, plus a refusal of a small-order public
 * key or signature R. Mirrors the Go `VerifyEd25519Strict`.
 */
export function verifyEd25519Strict(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  if (isSmallOrderEncoding(publicKey) || isSmallOrderEncoding(signature.subarray(0, 32))) {
    return false;
  }
  return verifyEd25519(publicKey, message, signature);
}
