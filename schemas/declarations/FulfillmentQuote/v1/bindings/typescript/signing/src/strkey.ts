import { Address, Pubkey, UnsupportedAddressError } from "@atum-labs/stellar-escrow-encoding";

// A Stellar account is a strkey: base32 of a version byte, the 32-byte ed25519 public key and a
// CRC-16/XMODEM checksum stored little-endian. Only the G (ed25519 public key) form can sign, so it
// is the only one accepted here. Mirror of strkey.go.
//
// The strkey rules themselves (alphabet first, canonical base32, checksum, payload size) live in one
// place, the Stellar escrow-encoding package, which chain-address and the escrow encoders call too.
// This file adds only what a signer needs: the G type and the raw key bytes.

/**
 * Returns the public key of a G... strkey. Refuses any other strkey type (a C contract cannot
 * sign, an S seed is a secret), lowercase, and a bad checksum.
 */
export function decodeStellarAccount(strkey: string): Uint8Array {
  try {
    return Pubkey.fromStrkey(strkey).toBytes();
  } catch (e) {
    if (e instanceof UnsupportedAddressError) {
      throw new Error("stellar account strkey must be a G account", { cause: e });
    }
    throw e;
  }
}

/**
 * Renders a public key as its G... strkey. A key that is not 32 bytes renders as the empty string, which no
 * holder address or verificationMethod equals (mirrors strkey.go).
 */
export function encodeStellarAccount(pub: Uint8Array): string {
  if (pub.length !== 32) return "";
  return Address.account(pub).toString();
}
