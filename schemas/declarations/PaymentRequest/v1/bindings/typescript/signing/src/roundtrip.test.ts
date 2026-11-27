import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { signPaymentRequest } from "./sign.js";
import { signPaymentRequestEd25519 } from "./sign-ed25519.js";
import { verifyPaymentRequest } from "./verify.js";

const PINNED_CREATED = "2026-04-01T00:00:00.000Z";

function secpDoc(senderAddr: string): Record<string, unknown> {
  return {
    version: "1.0",
    request_id: "req-pr-1",
    source: {
      asset_identifier: "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A",
      account: senderAddr,
    },
    destination: [
      { asset_identifier: "eip155:1/erc20:0xbbb", account: "0x2" },
    ],
    fulfillment_amount: "1000000",
    sender_auth: {
      message_scheme: "EVM_PERMIT2",
      signed_messages: [{ message: "0xdead", signature: "0xbeef" }],
    },
  };
}

function ed25519Doc(senderAddr: string): Record<string, unknown> {
  return {
    version: "1.0",
    request_id: "req-pr-sol-1",
    source: {
      asset_identifier:
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/spltoken:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      account: senderAddr,
    },
    destination: [{ asset_identifier: "eip155:1/erc20:0xbbb", account: "0x2" }],
    fulfillment_amount: "1000000",
    sender_auth: {
      message_scheme: "SOLANA",
      signed_messages: [{ message: "0xdead", signature: "0xbeef" }],
    },
  };
}

describe("signPaymentRequest (secp256k1) → verifyPaymentRequest roundtrip", () => {
  it("recovers the signer address", async () => {
    const wallet = Wallet.createRandom();
    const signed = await signPaymentRequest(
      secpDoc(wallet.address.toLowerCase()) as never,
      wallet.privateKey,
      { chainId: 1, created: PINNED_CREATED }
    );

    const res = await verifyPaymentRequest(JSON.stringify(signed));
    expect(res.cryptosuite).toBe("EcdsaSecp256k1RecoverySignature2020");
    expect(res.signerAddress).toBe(wallet.address.toLowerCase());
    expect(res.created.toISOString()).toBe(PINNED_CREATED);
  });

  it("rejects a tampered document (recovers a different address)", async () => {
    const wallet = Wallet.createRandom();
    const expected = wallet.address.toLowerCase();
    const signed = await signPaymentRequest(
      secpDoc(expected) as never,
      wallet.privateKey,
      { chainId: 1, created: PINNED_CREATED }
    );

    const tampered = { ...signed, fulfillment_amount: "999999999" };

    // CONTRACT CHANGE. This used to assert only that recovery yields a DIFFERENT signer:
    // recovery cannot fail, so a tampered document verified "successfully" and it was the
    // caller's job to compare the recovered address against the one the document claims.
    // verifyPaymentRequest now performs that binding itself and refuses the mismatch, because
    // the result carried the claimed DID next to the recovered address with nothing marking
    // which was which — and the DID is the field a caller naturally trusts.
    await expect(verifyPaymentRequest(JSON.stringify(tampered))).rejects.toThrow(
      /has been altered since it was signed/
    );
  });

  it("still recovers the honest signer when nothing was tampered with", async () => {
    // The other half of the contract change: binding must not reject legitimate documents.
    const wallet = Wallet.createRandom();
    const expected = wallet.address.toLowerCase();
    const signed = await signPaymentRequest(secpDoc(expected) as never, wallet.privateKey, {
      chainId: 1,
      created: PINNED_CREATED,
    });
    const res = await verifyPaymentRequest(JSON.stringify(signed));
    expect(res.signerAddress).toBe(expected);
  });

  it("rejects an unsupported cryptosuite", async () => {
    const wallet = Wallet.createRandom();
    const signed = await signPaymentRequest(
      secpDoc(wallet.address.toLowerCase()) as never,
      wallet.privateKey,
      { chainId: 1, created: PINNED_CREATED }
    );
    const mutated = {
      ...signed,
      proof: { ...signed.proof, type: "BbsBlsSignature2020" },
    };
    await expect(verifyPaymentRequest(JSON.stringify(mutated))).rejects.toThrow();
  });

  it("rejects a non-assertionMethod proofPurpose", async () => {
    const wallet = Wallet.createRandom();
    const signed = await signPaymentRequest(
      secpDoc(wallet.address.toLowerCase()) as never,
      wallet.privateKey,
      { chainId: 1, created: PINNED_CREATED }
    );
    const mutated = {
      ...signed,
      proof: { ...signed.proof, proofPurpose: "authentication" },
    };
    await expect(verifyPaymentRequest(JSON.stringify(mutated))).rejects.toThrow();
  });
});

describe("signPaymentRequestEd25519 → verifyPaymentRequest roundtrip", () => {
  it("recovers the ed25519 public key", async () => {
    const seed = nacl.randomBytes(32);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const pubBase58 = bs58.encode(kp.publicKey);

    const signed = await signPaymentRequestEd25519(
      ed25519Doc(pubBase58) as never,
      kp.secretKey,
      {
        verificationMethod: `did:pkh:solana:devnet:${pubBase58}#blockchainAccountId`,
        created: PINNED_CREATED,
      }
    );

    const res = await verifyPaymentRequest(JSON.stringify(signed));
    expect(res.cryptosuite).toBe("Ed25519Signature2020");
    expect(res.ed25519PublicKey).not.toBeNull();
    expect(bs58.encode(res.ed25519PublicKey as Uint8Array)).toBe(pubBase58);
    expect(res.didNetwork).toBe("devnet");
  });

  it("rejects a tampered proofValue", async () => {
    const seed = nacl.randomBytes(32);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const pubBase58 = bs58.encode(kp.publicKey);

    const signed = await signPaymentRequestEd25519(
      ed25519Doc(pubBase58) as never,
      kp.secretKey,
      {
        verificationMethod: `did:pkh:solana:devnet:${pubBase58}#blockchainAccountId`,
        created: PINNED_CREATED,
      }
    );
    const pv = signed.proof.proofValue;
    const mutated = {
      ...signed,
      proof: { ...signed.proof, proofValue: pv.slice(0, -3) + "111" },
    };
    await expect(verifyPaymentRequest(JSON.stringify(mutated))).rejects.toThrow();
  });

  it("rejects a non-z multibase prefix", async () => {
    const seed = nacl.randomBytes(32);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const pubBase58 = bs58.encode(kp.publicKey);

    const signed = await signPaymentRequestEd25519(
      ed25519Doc(pubBase58) as never,
      kp.secretKey,
      {
        verificationMethod: `did:pkh:solana:devnet:${pubBase58}#blockchainAccountId`,
        created: PINNED_CREATED,
      }
    );
    const mutated = {
      ...signed,
      proof: { ...signed.proof, proofValue: "m" + signed.proof.proofValue.slice(1) },
    };
    await expect(verifyPaymentRequest(JSON.stringify(mutated))).rejects.toThrow();
  });
});
