// Stellar account id (`G...` strkey) validation for policy emitters. Kept free of the Stellar SDK so
// `@atum-labs/turnkey-signer/admin` loads without its optional peer dependency.
//
// A strkey is base32 (RFC 4648, no padding) of: 1 version byte (0x30 for an ed25519 public key),
// the 32-byte key, and a 2-byte CRC16-XModem of the first 33 bytes, little endian.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ED25519_PUBLIC_KEY_VERSION = 6 << 3;

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function base32Decode(s: string): Uint8Array | null {
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  // 56 chars carry 280 bits = 35 bytes exactly, so no padding bits are left over.
  return bits === 0 ? Uint8Array.from(out) : null;
}

/**
 * True for a well-formed `G...` ed25519 account id with a valid checksum. The all-zero key is
 * refused: it is the placeholder a config example uses, and nobody holds its secret.
 */
export function isStellarAccountId(value: string): boolean {
  if (typeof value !== 'string' || !/^G[A-Z2-7]{55}$/.test(value)) return false;
  const raw = base32Decode(value);
  if (!raw || raw.length !== 35 || raw[0] !== ED25519_PUBLIC_KEY_VERSION) return false;
  const crc = crc16Xmodem(raw.subarray(0, 33));
  if (raw[33] !== (crc & 0xff) || raw[34] !== crc >> 8) return false;
  return raw.subarray(1, 33).some((b) => b !== 0);
}
