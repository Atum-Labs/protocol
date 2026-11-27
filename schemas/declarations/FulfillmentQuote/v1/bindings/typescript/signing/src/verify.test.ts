import { describe, it, expect } from "vitest";
import { type BaseWallet, SigningKey, Wallet } from "ethers";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { settlerProofTypedDigest } from "@atum-labs/ld-data-integrity";

import { signQuote } from "./sign.js";
import { signQuoteEd25519 } from "./sign-ed25519.js";
import { verifyQuote } from "./verify.js";
import { encodeStellarAccount } from "./strkey.js";
import { recoverSigner } from "./recover.js";
import { hashQuote } from "./hash.js";
import { createDetachedJws } from "./jws.js";
import {
  FULFILLMENT_QUOTE_CONTEXT_URL,
  SECP256K1_RECOVERY_CONTEXT_URL,
} from "./canonicalize.js";

// Mirror fixture of the Go side's signFixtureDoc — same field set so a
// future cross-language fixture lock doesn't need shape
// reconciliation. settler_address gets filled in per-test once the
// wallet has materialized.
function fixtureQuote(settlerAddress: string): Record<string, unknown> {
  return {
    version: "1.0",
    source_amount: "1000000",
    award_deadline: "2030-01-01T00:00:00Z",
    source: { id: "eip155:1/erc20:0xaaa", account: "eip155:1:0x1" },
    destination: { id: "eip155:1/erc20:0xbbb", account: "eip155:1:0x2" },
    settler_address: settlerAddress,
    payment_request_json: '{"request_id":"req-1"}',
  };
}

describe("verifyQuote: secp256k1 round-trip", () => {
  it("verifies a freshly-signed quote and returns the recovered address", async () => {
    const wallet = Wallet.createRandom();
    const signed = await signQuote(
      fixtureQuote(wallet.address.toLowerCase()) as never,
      wallet.privateKey,
      { chainId: 1 }
    );

    const result = await verifyQuote(signed as unknown as Record<string, unknown>);
    expect(result.cryptosuite).toBe("EcdsaSecp256k1RecoverySignature2020");
    expect(result.signerAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(result.ed25519PublicKey).toBeNull();
    expect(result.signerDID).toBe(
      `did:pkh:eip155:1:${wallet.address.toLowerCase()}`
    );
  });

  // Round-trip through the JSON-string overload of verifyQuote so the
  // public API is exercised both ways (parsed object + raw string).
  // A regression that only handled one of the two would slip past a
  // single-form test.
  it("accepts a JSON string input", async () => {
    const wallet = Wallet.createRandom();
    const signed = await signQuote(
      fixtureQuote(wallet.address.toLowerCase()) as never,
      wallet.privateKey
    );
    const result = await verifyQuote(JSON.stringify(signed));
    expect(result.signerAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});

// Pins full-precision (h/m/s/ms) recovery of proof.created — the midnight
// conformance fixtures can't exercise it. Kept local so the shared fixtures
// (a cross-service contract consumed by verifiers) stay untouched. Mirror of
// Go's TestVerify_RecoversFullPrecisionCreated.
describe("verifyQuote: recovers full-precision created", () => {
  it("round-trips a non-zero hour/min/sec/millis created", async () => {
    const wallet = Wallet.createRandom();
    // Non-zero in every component so a truncating parse can't pass.
    const created = "2026-04-01T13:37:42.123Z";
    const signed = await signQuote(
      fixtureQuote(wallet.address.toLowerCase()) as never,
      wallet.privateKey,
      { chainId: 1, created }
    );
    const result = await verifyQuote(signed as unknown as Record<string, unknown>);
    expect(result.created.toISOString()).toBe(created);
  });
});

describe("verifyQuote: ed25519 round-trip", () => {
  it("verifies a freshly-signed ed25519 quote and returns the public key", async () => {
    const { publicKey, secretKey } = nacl.sign.keyPair();
    const pubBase58 = bs58.encode(publicKey);
    const verificationMethod = `did:pkh:solana:devnet:${pubBase58}#blockchainAccountId`;
    const doc = {
      version: "1.0",
      source_amount: "1000000",
      award_deadline: "2030-01-01T00:00:00Z",
      source: {
        id: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        account: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:${pubBase58}`,
      },
      destination: { id: "eip155:1/erc20:0xbbb", account: "eip155:1:0x2" },
      settler_address: pubBase58,
      payment_request_json: '{"request_id":"req-sol-1"}',
    };

    const signed = await signQuoteEd25519(doc as never, secretKey, {
      verificationMethod,
    });

    const result = await verifyQuote(signed as unknown as Record<string, unknown>);
    expect(result.cryptosuite).toBe("Ed25519Signature2020");
    expect(result.signerAddress).toBe("");
    expect(result.ed25519PublicKey).not.toBeNull();
    expect(Buffer.from(result.ed25519PublicKey!).equals(Buffer.from(publicKey))).toBe(true);
    expect(result.didNetwork).toBe("devnet");
    expect(result.signerDID).toBe(`did:pkh:solana:devnet:${pubBase58}`);
  });
});

// The chain-address package's stellar vectors (see strkey.test.ts).
const ACCOUNT_G = "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH";
const CONTRACT_C = "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5";

// A quote signed by a Stellar settler: the ed25519 proof resolves the public key out of a
// did:pkh:stellar verificationMethod and surfaces the network for the caller's CAIP-2 binding.
describe("verifyQuote: stellar ed25519 round-trip", () => {
  function stellarDoc(settler: string) {
    return {
      version: "1.0",
      source_amount: "1000000",
      award_deadline: "2030-01-01T00:00:00Z",
      source: { id: "eip155:1/erc20:0xaaa", account: "eip155:1:0x1" },
      destination: { id: `stellar:testnet/sep41:${CONTRACT_C}`, account: settler },
      settler_address: settler,
      payment_request_json: '{"request_id":"req-stellar-1"}',
    };
  }

  it.each(["pubnet", "testnet"])("verifies a quote signed under did:pkh:stellar:%s", async (network) => {
    const { publicKey, secretKey } = nacl.sign.keyPair();
    const account = encodeStellarAccount(publicKey);
    const signed = await signQuoteEd25519(stellarDoc(account) as never, secretKey, {
      verificationMethod: `did:pkh:stellar:${network}:${account}#blockchainAccountId`,
    });

    const result = await verifyQuote(signed as unknown as Record<string, unknown>);
    expect(result.cryptosuite).toBe("Ed25519Signature2020");
    expect(Buffer.from(result.ed25519PublicKey!).equals(Buffer.from(publicKey))).toBe(true);
    expect(result.didNetwork).toBe(network);
    expect(result.signerDID).toBe(`did:pkh:stellar:${network}:${account}`);
  });

  it.each([
    ["a contract strkey", `did:pkh:stellar:pubnet:${CONTRACT_C}`, /G account/],
    ["a bad checksum", `did:pkh:stellar:pubnet:${ACCOUNT_G.slice(0, 55)}G`, /checksum/],
    ["a lowercase account", `did:pkh:stellar:pubnet:${ACCOUNT_G.toLowerCase()}`, /upper-case/],
    ["an empty network", `did:pkh:stellar::${ACCOUNT_G}`, /network segment empty/],
    ["another namespace", `did:pkh:aptos:mainnet:${ACCOUNT_G}`, /must be solana or stellar/],
    ["a newline in a 31-byte payload", "did:pkh:stellar:pubnet:GA5WUJ54Z23KILLCUOUN\nAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ", /upper-case/],
    ["a trailing newline on a 55-character string", "did:pkh:stellar:pubnet:GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNL4ZQ\n", /upper-case/],
  ])("refuses %s as the verificationMethod", async (_name, verificationMethod, message) => {
    const { publicKey, secretKey } = nacl.sign.keyPair();
    const signed = await signQuoteEd25519(stellarDoc(encodeStellarAccount(publicKey)) as never, secretKey, {
      verificationMethod: `did:pkh:stellar:pubnet:${encodeStellarAccount(publicKey)}`,
    });
    (signed as unknown as { proof: { verificationMethod: string } }).proof.verificationMethod = verificationMethod;
    await expect(verifyQuote(signed as unknown as Record<string, unknown>)).rejects.toThrow(message);
  });
});

describe("verifyQuote: error paths", () => {
  it("rejects a missing proof block", async () => {
    await expect(
      verifyQuote({ source_amount: "1000000" } as Record<string, unknown>)
    ).rejects.toThrow(/missing proof/);
  });

  it("rejects an unsupported proof.type", async () => {
    await expect(
      verifyQuote({ proof: { type: "EcdsaSecp256k1Signature2019" } } as Record<string, unknown>)
    ).rejects.toThrow(/unsupported proof\.type/);
  });

  // Tamper-detection: mutating any byte of the signature flips the
  // result to a verify error rather than returning a stale success.
  // Mirrors hash_test.go's TestHashQuote_TamperingChangesHash + the
  // TestVerify_Ed25519_RejectsBadProofValue case on the Go side.
  it("tampered secp256k1 JWS recovers a different address (caller must compare)", async () => {
    // ECDSA recovery has no per-signature failure mode — any 65-byte
    // signature recovers SOME address. verifyQuote's contract is recover-
    // not-authorize: the verifier returns the recovered address, the
    // caller compares against the trust anchor (settler_address,
    // trustedissuers list, etc.). An earlier version of this test relied
    // on an internal lowercase-equality check that was strictly stricter
    // than the Go verifier AND wrong for Tron; that check is gone, so
    // the assertion changes from "throws" to "recovers, but not to the
    // original signer."
    const wallet = Wallet.createRandom();
    const signed = (await signQuote(
      fixtureQuote(wallet.address.toLowerCase()) as never,
      wallet.privateKey
    )) as Record<string, unknown> & { proof: { jws: string } };
    const parts = signed.proof.jws.split("..");
    parts[1] = parts[1].slice(0, -10) + "AAAAAAAAAA";
    signed.proof.jws = parts.join("..");

    const result = await verifyQuote(signed);
    expect(result.signerAddress.toLowerCase()).not.toBe(wallet.address.toLowerCase());
  });

  it("rejects a tampered ed25519 proofValue", async () => {
    const { publicKey, secretKey } = nacl.sign.keyPair();
    const pubBase58 = bs58.encode(publicKey);
    const signed = (await signQuoteEd25519(
      {
        version: "1.0",
        source_amount: "1000000",
        award_deadline: "2030-01-01T00:00:00Z",
        source: { id: "x", account: `solana:devnet:${pubBase58}` },
        destination: { id: "y", account: "eip155:1:0x2" },
        settler_address: pubBase58,
        payment_request_json: '{"request_id":"x"}',
      } as never,
      secretKey,
      { verificationMethod: `did:pkh:solana:devnet:${pubBase58}#blockchainAccountId` }
    )) as Record<string, unknown> & { proof: { proofValue: string } };
    const pv = signed.proof.proofValue;
    signed.proof.proofValue = pv.slice(0, -3) + "111";
    await expect(verifyQuote(signed)).rejects.toThrow(/verification failed|signature/);
  });

  it("rejects an ed25519 proofValue with a non-z multibase prefix", async () => {
    const { publicKey, secretKey } = nacl.sign.keyPair();
    const pubBase58 = bs58.encode(publicKey);
    const signed = (await signQuoteEd25519(
      {
        version: "1.0",
        source_amount: "1000000",
        award_deadline: "2030-01-01T00:00:00Z",
        source: { id: "x", account: `solana:devnet:${pubBase58}` },
        destination: { id: "y", account: "eip155:1:0x2" },
        settler_address: pubBase58,
        payment_request_json: '{"request_id":"x"}',
      } as never,
      secretKey,
      { verificationMethod: `did:pkh:solana:devnet:${pubBase58}#blockchainAccountId` }
    )) as Record<string, unknown> & { proof: { proofValue: string } };
    // Replace the leading 'z' with 'm' (base64 multibase) — even if the
    // remainder happens to base64-decode, the prefix check must fail
    // closed before we even attempt to decode.
    signed.proof.proofValue = "m" + signed.proof.proofValue.slice(1);
    await expect(verifyQuote(signed)).rejects.toThrow(/prefix/);
  });

  it("rejects a malformed verificationMethod", async () => {
    const wallet = Wallet.createRandom();
    const signed = (await signQuote(
      fixtureQuote(wallet.address.toLowerCase()) as never,
      wallet.privateKey
    )) as Record<string, unknown> & { proof: { verificationMethod: string } };
    signed.proof.verificationMethod = "not-a-did";
    await expect(verifyQuote(signed)).rejects.toThrow(/not did:pkh/);
  });
});

describe("recoverSigner: thin wrapper", () => {
  it("returns the did:pkh URI without the fragment", async () => {
    const wallet = Wallet.createRandom();
    const signed = await signQuote(
      fixtureQuote(wallet.address.toLowerCase()) as never,
      wallet.privateKey,
      { chainId: 1 }
    );
    const did = await recoverSigner(signed as unknown as Record<string, unknown>);
    expect(did).toBe(`did:pkh:eip155:1:${wallet.address.toLowerCase()}`);
    expect(did.includes("#")).toBe(false);
  });

  it("propagates verifyQuote errors fail-closed", async () => {
    await expect(recoverSigner({ source_amount: "1000000" })).rejects.toThrow();
  });
});

// Symmetry pins: the TS verifier MUST be symmetric with
// the Go side — no internal EVM-only equality check, and proof.@context is
// forwarded verbatim into canonicalization.
describe("verifyQuote: symmetry review pins", () => {
  it("accepts a Tron-shaped did:pkh:tron verificationMethod (no EVM-only equality check)", async () => {
    // ECDSA recovery is chain-agnostic; the recovered hex won't match a
    // Tron base58check address, so a previous lowercase-equality check
    // rejected every valid Tron signature. Post-review, verifyQuote
    // returns the recovered address + parsed didNetwork and lets the
    // caller compare via chain-canonical derivation (the Go verifier's
    // existing posture).
    //
    // Re-implements signQuote's body with a Tron-shaped verificationMethod
    // baked in from the start. We can't sign-then-mutate the VM: VM is
    // canonicalized into the proof block, so changing it after signing
    // shifts the signing input and recovery yields a different address.
    const wallet = Wallet.createRandom();
    const tronVM =
      "did:pkh:tron:mainnet:TFakeAddressForCORE1078ReviewPin#blockchainAccountId";
    const proofOptions = {
      type: "EcdsaSecp256k1RecoverySignature2020" as const,
      created: new Date().toISOString(),
      verificationMethod: tronVM,
      proofPurpose: "assertionMethod",
    };
    const doc = fixtureQuote(wallet.address.toLowerCase());
    const { signingInput } = await hashQuote(doc, {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions,
    });
    const sig = new SigningKey(wallet.privateKey).sign(signingInput);
    const jws = createDetachedJws(Buffer.from(sig.serialized.slice(2), "hex"));
    const signed: Record<string, unknown> = {
      "@context": [FULFILLMENT_QUOTE_CONTEXT_URL, SECP256K1_RECOVERY_CONTEXT_URL],
      ...doc,
      verifiableCredential: [],
      proof: { ...proofOptions, jws },
    };

    const result = await verifyQuote(signed);
    expect(result.cryptosuite).toBe("EcdsaSecp256k1RecoverySignature2020");
    expect(result.didNetwork).toBe("tron");
    // The recovered EVM-style hex is what the wallet signed — independent
    // of what the verificationMethod's address segment says.
    expect(result.signerAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("forwards proof['@context'] verbatim into canonicalization (mirrors Go verify.go:142)", async () => {
    // The signer doesn't currently emit proof['@context'] on the wire,
    // so this test SIMULATES a future signer that does — and uses a
    // context URL the local store cannot resolve. If the verifier hard-
    // coded SECP256K1_RECOVERY_CONTEXT_URL (the pre-review behavior),
    // canonicalization would succeed against the local context and
    // recovery would silently produce a "valid" result; the assertion
    // here is that the wire value reaches URDNA2015 and surfaces as an
    // explicit "unknown context" error. Same inverse-pin pattern used
    // in hash.test.ts's "proofContext override preserves byte identity"
    // suite.
    const wallet = Wallet.createRandom();
    const signed = (await signQuote(
      fixtureQuote(wallet.address.toLowerCase()) as never,
      wallet.privateKey
    )) as unknown as Record<string, unknown> & { proof: Record<string, unknown> };
    signed.proof["@context"] = "https://w3id.org/security/v2";

    await expect(verifyQuote(signed)).rejects.toThrow(/w3id\.org\/security\/v2/);
  });
});

describe("verifyQuote: SettlerProof typed signature", () => {
  async function signTypedQuote(identity: BaseWallet, signer: BaseWallet) {
    const address = identity.address.toLowerCase();
    const proofOptions = {
      type: "EcdsaSecp256k1RecoverySignature2020" as const,
      created: new Date().toISOString(),
      verificationMethod: `did:pkh:eip155:1:${address}#blockchainAccountId`,
      proofPurpose: "assertionMethod",
    };
    const doc = fixtureQuote(address);
    const { proofHash, docHash } = await hashQuote(doc, {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions,
    });
    const sig = signer.signingKey.sign(settlerProofTypedDigest(proofHash, docHash));
    const jws = createDetachedJws(Buffer.from(sig.serialized.slice(2), "hex"));
    return {
      "@context": [FULFILLMENT_QUOTE_CONTEXT_URL, SECP256K1_RECOVERY_CONTEXT_URL],
      ...doc,
      verifiableCredential: [],
      proof: { ...proofOptions, jws },
    } as Record<string, unknown>;
  }

  it("recovers the settler from a typed signature", async () => {
    const wallet = Wallet.createRandom();
    const result = await verifyQuote(await signTypedQuote(wallet, wallet));
    expect(result.signerAddress).toBe(wallet.address.toLowerCase());
  });

  it("does not recover the settler from a typed signature by another key", async () => {
    const wallet = Wallet.createRandom();
    const result = await verifyQuote(await signTypedQuote(wallet, Wallet.createRandom()));
    expect(result.signerAddress).not.toBe(wallet.address.toLowerCase());
  });
});
