import { describe, it, expect } from "vitest";

import { Wallet, getAddress, getBytes, hexlify, keccak256, toUtf8Bytes, TypedDataEncoder } from "ethers";

import { MalformedProofError } from "./errors.js";
import {
  SETTLER_IDENTITY_DOMAIN,
  recoverSecp256k1ProofSigner,
  settlerProofTypedDigest,
  walletProofTypedDigest,
} from "./settler-identity.js";

// Shared settler identity vectors, computed with ethers v6 TypedDataEncoder.hash.
const VECTOR_DOMAIN_SEPARATOR =
  "0xedd0bf5f50d6e9b28d004421809379ed0faf50b860ce2e99d7ba54c0b7badeac";
const VECTOR_SETTLER_PROOF_DIGEST =
  "0x073a9ae5f5f24d3e1e2264d95d0b4721e23c6550288c210e8eb35b0d5869b0e2";
const VECTOR_WALLET_PROOF_DIGEST =
  "0x2504f2b96d7675eaa3b4ea78c60d977a259301bd804e8ad5705efe3bc41b10c6";

const fill = (byte: number) => new Uint8Array(32).fill(byte);

function sign(wallet: Wallet, digest: Uint8Array): Uint8Array {
  return getBytes(wallet.signingKey.sign(digest).serialized);
}

function hashes() {
  const proofHash = getBytes(keccak256(toUtf8Bytes("proof options")));
  const docHash = getBytes(keccak256(toUtf8Bytes("document")));
  const combined = new Uint8Array(64);
  combined.set(proofHash, 0);
  combined.set(docHash, 32);
  return { signingInput: getBytes(keccak256(combined)), proofHash, docHash };
}

describe("settler identity domain", () => {
  it("uses the keccak-derived sentinel as verifyingContract", () => {
    const derived = getAddress("0x" + keccak256(toUtf8Bytes("atum.settler.identity.v1")).slice(-40));
    expect(SETTLER_IDENTITY_DOMAIN.verifyingContract).toBe(derived);
  });

  it("matches the shared test vectors", () => {
    expect(TypedDataEncoder.hashDomain(SETTLER_IDENTITY_DOMAIN)).toBe(VECTOR_DOMAIN_SEPARATOR);
    expect(hexlify(settlerProofTypedDigest(fill(0x11), fill(0x22)))).toBe(VECTOR_SETTLER_PROOF_DIGEST);
    expect(hexlify(walletProofTypedDigest(fill(0x33)))).toBe(VECTOR_WALLET_PROOF_DIGEST);
  });

  it("rejects hashes that are not 32 bytes", () => {
    expect(() => settlerProofTypedDigest(new Uint8Array(31), fill(0))).toThrow(MalformedProofError);
    expect(() => walletProofTypedDigest(new Uint8Array(33))).toThrow(MalformedProofError);
  });
});

describe("recoverSecp256k1ProofSigner", () => {
  const wallet = Wallet.createRandom();
  const want = wallet.address.toLowerCase();
  const matches = (a: string) => a.toLowerCase() === want;
  const h = hashes();

  it("accepts a legacy signature", () => {
    const sig = sign(wallet, h.signingInput);
    expect(recoverSecp256k1ProofSigner(h, sig, matches).toLowerCase()).toBe(want);
  });

  it("accepts a SettlerProof typed signature", () => {
    const sig = sign(wallet, settlerProofTypedDigest(h.proofHash, h.docHash));
    expect(recoverSecp256k1ProofSigner(h, sig, matches).toLowerCase()).toBe(want);
  });

  it("does not match a typed signature by the wrong key", () => {
    const other = Wallet.createRandom();
    const sig = sign(other, settlerProofTypedDigest(h.proofHash, h.docHash));
    const got = recoverSecp256k1ProofSigner(h, sig, matches).toLowerCase();
    expect(got).not.toBe(want);
    // Neither digest matches, so the legacy recovery is returned for the caller to reject.
    expect(got).not.toBe(other.address.toLowerCase());
  });
});
