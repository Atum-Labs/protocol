import bs58 from 'bs58';
import { InvalidPubkeyLengthError, InvalidBase58Error, InvalidHexError } from './errors';

/**
 * Pubkey represents a 32-byte Solana public key.
 * Mirrors the Go Pubkey type for consistency.
 */
export class Pubkey {
  private readonly data: Uint8Array;

  private constructor(data: Uint8Array) {
    if (data.length !== 32) {
      throw new InvalidPubkeyLengthError();
    }
    this.data = data;
  }

  /**
   * Creates a Pubkey from a Base58-encoded string.
   * This is the standard format for Solana public keys.
   */
  static fromBase58(s: string): Pubkey {
    try {
      const decoded = bs58.decode(s);
      if (decoded.length !== 32) {
        throw new InvalidPubkeyLengthError();
      }
      return new Pubkey(decoded);
    } catch (e) {
      if (e instanceof InvalidPubkeyLengthError) {
        throw e;
      }
      throw new InvalidBase58Error();
    }
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

    if (hex.length !== 64) {
      throw new InvalidPubkeyLengthError();
    }

    try {
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        if (isNaN(bytes[i])) {
          throw new InvalidHexError();
        }
      }
      return new Pubkey(bytes);
    } catch (e) {
      if (e instanceof InvalidPubkeyLengthError || e instanceof InvalidHexError) {
        throw e;
      }
      throw new InvalidHexError();
    }
  }

  /**
   * Creates a Pubkey from raw bytes.
   */
  static fromBytes(bytes: Uint8Array): Pubkey {
    if (bytes.length !== 32) {
      throw new InvalidPubkeyLengthError();
    }
    return new Pubkey(new Uint8Array(bytes));
  }

  /**
   * Returns the pubkey as a byte array.
   */
  toBytes(): Uint8Array {
    return new Uint8Array(this.data);
  }

  /**
   * Returns the Base58 encoding of the pubkey.
   */
  toString(): string {
    return bs58.encode(this.data);
  }

  /**
   * Returns the hex encoding of the pubkey (without 0x prefix).
   */
  toHex(): string {
    return Array.from(this.data)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Returns true if the pubkey is all zeros.
   */
  isZero(): boolean {
    return this.data.every(b => b === 0);
  }

  /**
   * Returns true if this pubkey equals another.
   */
  equals(other: Pubkey): boolean {
    return this.data.every((b, i) => b === other.data[i]);
  }
}
