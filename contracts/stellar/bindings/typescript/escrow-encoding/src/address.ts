import { InvalidPubkeyLengthError, InvalidStrkeyError, UnsupportedAddressError } from './errors';

/** The XDR ScAddressType byte that leads an addr33. */
export const ACCOUNT_ADDRESS = 0;
export const CONTRACT_ADDRESS = 1;
export type AddressType = typeof ACCOUNT_ADDRESS | typeof CONTRACT_ADDRESS;

// strkey version bytes: the version number shifted left three bits, so the first base32 character is the
// letter. Only the two address types the layout can represent are decoded to an Address.
const VERSION_ACCOUNT = 6 << 3;
const VERSION_CONTRACT = 2 << 3;
const VERSION_MUXED_ACCOUNT = 12 << 3;
const VERSION_CLAIMABLE_BALANCE = 1 << 3;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STRKEY_CHARS = /^[A-Z2-7]+$/;

/**
 * A Soroban address as the layout encodes it: one type byte and 32 bytes. Mirrors the Go Address type.
 */
export class Address {
  private constructor(
    readonly type: AddressType,
    private readonly data: Uint8Array,
  ) {}

  /** Wraps a raw ed25519 public key as a G... address. */
  static account(key: Uint8Array): Address {
    return new Address(ACCOUNT_ADDRESS, copy32(key));
  }

  /** Wraps a 32-byte contract id hash as a C... address. */
  static contract(id: Uint8Array): Address {
    return new Address(CONTRACT_ADDRESS, copy32(id));
  }

  /**
   * Parses a G... or C... strkey. Muxed (M...) and claimable-balance (B...) addresses are well-formed but
   * have no 33-byte form and throw UnsupportedAddressError, as the contract does.
   */
  static fromStrkey(s: string): Address {
    const { version, payload } = decodeStrkey(s);
    switch (version) {
      case VERSION_ACCOUNT:
      case VERSION_CONTRACT:
        if (payload.length !== 32) {
          throw new InvalidStrkeyError(`payload is ${payload.length} bytes, want 32`);
        }
        return new Address(version === VERSION_ACCOUNT ? ACCOUNT_ADDRESS : CONTRACT_ADDRESS, payload);
      case VERSION_MUXED_ACCOUNT:
      case VERSION_CLAIMABLE_BALANCE:
        throw new UnsupportedAddressError();
      default:
        // Includes secret seeds (S...): never decoded, and the input is not echoed back
        throw new InvalidStrkeyError('not an account or contract address');
    }
  }

  /** The 32-byte key or contract id hash. */
  toBytes(): Uint8Array {
    return new Uint8Array(this.data);
  }

  /** The addr33 encoding: the type byte then the 32-byte key. */
  toBytes33(): Uint8Array {
    const out = new Uint8Array(33);
    out[0] = this.type;
    out.set(this.data, 1);
    return out;
  }

  /** The strkey (G... or C...). */
  toString(): string {
    return encodeStrkey(this.type === ACCOUNT_ADDRESS ? VERSION_ACCOUNT : VERSION_CONTRACT, this.data);
  }

  isZero(): boolean {
    return this.data.every((b) => b === 0);
  }

  equals(other: Address): boolean {
    return this.type === other.type && this.data.every((b, i) => b === other.data[i]);
  }
}

function copy32(b: Uint8Array): Uint8Array {
  if (b.length !== 32) throw new InvalidPubkeyLengthError();
  return new Uint8Array(b);
}

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Uint8Array | null {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >> (bits - 8)) & 0xff);
      bits -= 8;
    }
    acc &= (1 << bits) - 1;
  }
  return new Uint8Array(out);
}

/** CRC-16/XMODEM (polynomial 0x1021, initial value 0): the strkey checksum. */
function crc16XModem(data: Uint8Array): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function encodeStrkey(version: number, payload: Uint8Array): string {
  const body = new Uint8Array(1 + payload.length + 2);
  body[0] = version;
  body.set(payload, 1);
  const crc = crc16XModem(body.subarray(0, 1 + payload.length));
  body[body.length - 2] = crc & 0xff;
  body[body.length - 1] = crc >> 8;
  return base32Encode(body);
}

/** Checks base32, canonical form and checksum, and returns the version byte and payload. */
function decodeStrkey(s: string): { version: number; payload: Uint8Array } {
  // Alphabet first, matching the Go decoder: Go's base32 decoder drops \r and \n, so a length or checksum
  // check run before this would let a line break through, and both languages word the refusal the same
  if (typeof s !== 'string' || !STRKEY_CHARS.test(s)) {
    throw new InvalidStrkeyError('expected upper-case base32');
  }
  const raw = base32Decode(s);
  if (raw === null || raw.length < 3) throw new InvalidStrkeyError('bad base32');
  // Re-encoding rejects whatever a lenient base32 decoder skips or ignores (Go's drops \r and \n; other
  // decoders accept non-zero trailing bits), so one strkey has exactly one spelling
  if (base32Encode(raw) !== s) throw new InvalidStrkeyError('non-canonical base32');
  const body = raw.subarray(0, raw.length - 2);
  const crc = raw[raw.length - 2] | (raw[raw.length - 1] << 8);
  if (crc16XModem(body) !== crc) throw new InvalidStrkeyError('bad checksum');
  return { version: body[0], payload: body.slice(1) };
}
