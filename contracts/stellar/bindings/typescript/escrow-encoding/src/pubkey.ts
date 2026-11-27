import { Address, ACCOUNT_ADDRESS } from './address';
import { InvalidHexError, InvalidPubkeyLengthError, UnsupportedAddressError } from './errors';

/**
 * Pubkey represents a raw 32-byte ed25519 public key: the bytes behind a G... strkey. The delegate signer,
 * reserver and releaser are Pubkeys, not Addresses: the contract verifies their signatures itself and
 * never calls require_auth for them. Mirrors the Go Pubkey type for consistency.
 */
export class Pubkey {
  private readonly data: Uint8Array;

  private constructor(data: Uint8Array) {
    if (data.length !== 32) {
      throw new InvalidPubkeyLengthError();
    }
    this.data = data;
  }

  /** Parses a G... strkey into the key behind it. A C... contract address has no signing key. */
  static fromStrkey(s: string): Pubkey {
    const a = Address.fromStrkey(s);
    if (a.type !== ACCOUNT_ADDRESS) throw new UnsupportedAddressError();
    return new Pubkey(a.toBytes());
  }

  /**
   * Creates a Pubkey from a hex-encoded string.
   * Accepts with or without "0x" prefix.
   */
  static fromHex(s: string): Pubkey {
    let hex = s;
    if (hex.startsWith('0x') || hex.startsWith('0X')) {
      hex = hex.slice(2);
    }
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
      throw new InvalidHexError();
    }
    if (hex.length !== 64) {
      throw new InvalidPubkeyLengthError();
    }
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return new Pubkey(bytes);
  }

  /** Creates a Pubkey from raw bytes. */
  static fromBytes(bytes: Uint8Array): Pubkey {
    if (bytes.length !== 32) {
      throw new InvalidPubkeyLengthError();
    }
    return new Pubkey(new Uint8Array(bytes));
  }

  /** Returns the key as a byte array. */
  toBytes(): Uint8Array {
    return new Uint8Array(this.data);
  }

  /** Returns the G... strkey of the key. */
  toString(): string {
    return Address.account(this.data).toString();
  }

  /** Returns the hex encoding of the key (without 0x prefix). */
  toHex(): string {
    return Array.from(this.data)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** Returns true if the key is all zeros. */
  isZero(): boolean {
    return this.data.every((b) => b === 0);
  }

  /** Returns true if this key equals another. */
  equals(other: Pubkey): boolean {
    return this.data.every((b, i) => b === other.data[i]);
  }
}
