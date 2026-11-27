// The signing seam for PaymentRequest documents.
//
// WHY AN INTERFACE AND NOT A PRIVATE KEY. A signing API that takes a hex private key forces
// every caller to hold raw key material in a JavaScript string, which cannot be zeroized, is
// copied by the runtime on assignment, and lands in heap snapshots, core dumps and any log line
// that stringifies the surrounding object. It also excludes every custodian outright: a holder
// whose key sits in a KMS, an HSM, or a provider like Turnkey or Fireblocks has no private key
// to pass, so the only way to use such an API is to stop using the custodian.
//
// So the library asks for the one capability it actually needs — "sign this 32-byte digest" —
// and never sees key material. This mirrors the Go half's Secp256k1Signer, and the SenderSigner
// seam the payment-gateway client already uses for the transfer authorization.
//
// A local key is still supported, through ethers' own Wallet. That keeps key handling inside a
// library built for it rather than in our call signatures.

import { SigningKey, getBytes, type Wallet, type HDNodeWallet } from "ethers";

/**
 * Signs a 32-byte digest with the holder's secp256k1 key.
 *
 * Implement this over a KMS, an HSM, or a custodial provider to sign without the key ever
 * reaching this process. `signerFromEthersWallet` covers the local-key case.
 */
export interface DeclarationSigner {
  /**
   * The 0x-prefixed address this signer's key derives to.
   *
   * It becomes the `did:pkh` verificationMethod, and the verifier recovers the signer from the
   * signature and binds it back to this address — so returning an address the key does not
   * control produces a proof that fails verification rather than one that lies.
   */
  getAddress(): Promise<string> | string;

  /**
   * Signs a 32-byte digest, returning 65 bytes of `r || s || v` with **v ∈ {0, 1}**.
   *
   * v is the raw recovery id. The library applies the +27 alignment the W3C secp256k1recovery
   * suite expects exactly once, and REFUSES a signature whose v is already 27 or 28 — double
   * applying it would corrupt the recovery id and produce a proof that recovers the wrong
   * address. The Go half fails closed on the same condition.
   */
  signDigest(digest: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

/** The subset of an ethers wallet this adapter needs, so any compatible object works. */
export interface EthersWalletLike {
  readonly address: string;
  readonly signingKey: SigningKey;
}

/**
 * Adapts an ethers `Wallet` (or `HDNodeWallet`) to {@link DeclarationSigner}.
 *
 * Use this for a local key: ethers owns the key material and this adapter only borrows the
 * digest-signing capability. Note it signs a RAW digest, which is deliberate — the proof is over
 * a canonicalized document hash, so `signMessage` would be wrong here: it applies the EIP-191
 * prefix and the resulting signature would not verify as a Data Integrity proof.
 */
export function signerFromEthersWallet(
  wallet: EthersWalletLike | Wallet | HDNodeWallet,
): DeclarationSigner {
  const w = wallet as EthersWalletLike;
  if (!w?.signingKey) {
    throw new Error(
      "signerFromEthersWallet: wallet has no signingKey. A JsonRpcSigner or a hardware " +
        "signer cannot sign a raw digest; implement DeclarationSigner over its native " +
        "digest-signing call instead.",
    );
  }
  return {
    getAddress: () => w.address,
    signDigest: (digest: Uint8Array) => {
      const sig = w.signingKey.sign(digest);
      // r || s || yParity. yParity is already the raw recovery id, so the +27 the suite wants
      // is applied by the library and not here — see DeclarationSigner.signDigest.
      const out = new Uint8Array(65);
      out.set(getBytes(sig.r), 0);
      out.set(getBytes(sig.s), 32);
      out[64] = sig.yParity;
      return out;
    },
  };
}
