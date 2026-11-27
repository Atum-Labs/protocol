// Settler identity EIP-712 domain and typed digests. Mirror of the Go lib's settler_identity.go.
// The domain carries no chainId, so the digest is identical on EVM and Tron.

import { getBytes, hexlify, TypedDataEncoder, type TypedDataField } from "ethers";

import { MalformedProofError } from "./errors.js";
import { recoverSecp256k1ProofSignerFrom } from "./payment-request-proof.js";

// verifyingContract is a sentinel with no code: the last 20 bytes of
// keccak256("atum.settler.identity.v1").
export const SETTLER_IDENTITY_DOMAIN = Object.freeze({
  name: "Atum Settler Identity",
  version: "1",
  verifyingContract: "0x1238944D14f50709Cc27101B2746fDeFCE08B37e",
});

export const SETTLER_PROOF_TYPES: Record<string, TypedDataField[]> = Object.freeze({
  SettlerProof: [
    { name: "proofHash", type: "bytes32" },
    { name: "docHash", type: "bytes32" },
  ],
}) as Record<string, TypedDataField[]>;

export const WALLET_PROOF_TYPES: Record<string, TypedDataField[]> = Object.freeze({
  WalletProof: [{ name: "digest", type: "bytes32" }],
}) as Record<string, TypedDataField[]>;

function bytes32(value: Uint8Array, field: string): string {
  if (value.length !== 32) {
    throw new MalformedProofError(`${field} must be 32 bytes, got ${value.length}`);
  }
  return hexlify(value);
}

// settlerProofTypedDigest returns the EIP-712 digest of SettlerProof{proofHash, docHash}, the
// 32-byte hashes hashDocument returns.
export function settlerProofTypedDigest(proofHash: Uint8Array, docHash: Uint8Array): Uint8Array {
  const message = {
    proofHash: bytes32(proofHash, "proofHash"),
    docHash: bytes32(docHash, "docHash"),
  };
  return getBytes(TypedDataEncoder.hash(SETTLER_IDENTITY_DOMAIN, SETTLER_PROOF_TYPES, message));
}

// walletProofTypedDigest returns the EIP-712 digest of WalletProof{digest}, the settler to
// gateway handshake wallet proof.
export function walletProofTypedDigest(digest: Uint8Array): Uint8Array {
  const message = { digest: bytes32(digest, "digest") };
  return getBytes(TypedDataEncoder.hash(SETTLER_IDENTITY_DOMAIN, WALLET_PROOF_TYPES, message));
}

export interface Secp256k1ProofHashes {
  signingInput: Uint8Array;
  proofHash: Uint8Array;
  docHash: Uint8Array;
}

// recoverSecp256k1ProofSigner recovers an EcdsaSecp256k1RecoverySignature2020 signer, accepting
// the legacy signingInput or the SettlerProof typed digest. The typed digest is tried only when
// the legacy signer fails `matches`; if neither matches, the legacy address is returned so the
// caller's mismatch handling is unchanged.
export function recoverSecp256k1ProofSigner(
  hashes: Secp256k1ProofHashes,
  signature: Uint8Array,
  matches: (address: string) => boolean
): string {
  return recoverSecp256k1ProofSignerFrom(hashes, signature, matches, [settlerProofTypedDigest]);
}
