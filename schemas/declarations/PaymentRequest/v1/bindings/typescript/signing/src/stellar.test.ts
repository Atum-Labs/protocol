import { describe, it, expect } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";

import { signPaymentRequestEd25519 } from "./sign-ed25519.js";
import { encodeStellarAccount } from "./strkey.js";
import { matchesChain, verifyPaymentRequest } from "./verify.js";

const PINNED_CREATED = "2026-04-01T00:00:00.000Z";

// The shared strkey vectors' account and contract entries (contracts/stellar/conformance/strkey-vectors.json).
const ACCOUNT_G = "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH";
const CONTRACT_C = "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5";

function stellarDoc(account: string): Record<string, unknown> {
  return {
    version: "1.0",
    request_id: "req-pr-stellar-1",
    source: { asset_identifier: `stellar:pubnet/sep41:${CONTRACT_C}`, account },
    destination: [{ asset_identifier: "eip155:1/erc20:0xbbb", account: "0x2" }],
    fulfillment_amount: "1000000",
  };
}

// A Stellar originator signs as the schema describes; the verifier resolves the key out of the
// did:pkh:stellar verificationMethod and surfaces the network. Mirror of stellar_test.go.
describe("verifyPaymentRequest: stellar ed25519 round-trip", () => {
  it.each(["pubnet", "testnet"])("verifies a request signed under did:pkh:stellar:%s", async (network) => {
    const { publicKey, secretKey } = nacl.sign.keyPair();
    const account = encodeStellarAccount(publicKey);
    const signed = await signPaymentRequestEd25519(stellarDoc(account) as never, secretKey, {
      verificationMethod: `did:pkh:stellar:${network}:${account}#blockchainAccountId`,
      created: PINNED_CREATED,
    });

    const res = await verifyPaymentRequest(JSON.stringify(signed));
    expect(res.cryptosuite).toBe("Ed25519Signature2020");
    expect(Buffer.from(res.ed25519PublicKey!).equals(Buffer.from(publicKey))).toBe(true);
    expect(res.didNamespace).toBe("stellar");
    expect(res.didNetwork).toBe(network);
    expect(res.signerDID).toBe(`did:pkh:stellar:${network}:${account}`);
  });

  it("keeps the namespace distinct from a solana DID with the same reference and key", async () => {
    const { publicKey, secretKey } = nacl.sign.keyPair();
    const stellar = await signPaymentRequestEd25519(stellarDoc(encodeStellarAccount(publicKey)) as never, secretKey, {
      verificationMethod: `did:pkh:stellar:devnet:${encodeStellarAccount(publicKey)}`,
      created: PINNED_CREATED,
    });
    const solana = await signPaymentRequestEd25519(stellarDoc("x") as never, secretKey, {
      verificationMethod: `did:pkh:solana:devnet:${bs58.encode(publicKey)}`,
      created: PINNED_CREATED,
    });
    const a = await verifyPaymentRequest(JSON.stringify(stellar));
    const b = await verifyPaymentRequest(JSON.stringify(solana));
    expect(a.didNetwork).toBe(b.didNetwork);
    expect(a.didNamespace).toBe("stellar");
    expect(b.didNamespace).toBe("solana");
  });

  it("lower-cases a mixed-case namespace in the verificationMethod", async () => {
    const { publicKey, secretKey } = nacl.sign.keyPair();
    const account = encodeStellarAccount(publicKey);
    const signed = await signPaymentRequestEd25519(stellarDoc(account) as never, secretKey, {
      verificationMethod: `did:pkh:STELLAR:devnet:${account}`,
      created: PINNED_CREATED,
    });
    const res = await verifyPaymentRequest(JSON.stringify(signed));
    expect(res.didNamespace).toBe("stellar");
    expect(() => matchesChain(res, "stellar:devnet")).not.toThrow();
  });

  it.each([
    ["a contract strkey", `did:pkh:stellar:pubnet:${CONTRACT_C}`, /G account/],
    ["a bad checksum", `did:pkh:stellar:pubnet:${ACCOUNT_G.slice(0, 55)}G`, /checksum/],
    ["a lowercase account", `did:pkh:stellar:pubnet:${ACCOUNT_G.toLowerCase()}`, /upper-case/],
    ["an empty network", `did:pkh:stellar::${ACCOUNT_G}`, /network segment empty/],
    ["another namespace", `did:pkh:aptos:mainnet:${ACCOUNT_G}`, /must be solana or stellar/],
  ])("refuses %s as the verificationMethod", async (_name, verificationMethod, message) => {
    const { publicKey, secretKey } = nacl.sign.keyPair();
    const signed = await signPaymentRequestEd25519(stellarDoc(encodeStellarAccount(publicKey)) as never, secretKey, {
      verificationMethod: `did:pkh:stellar:pubnet:${encodeStellarAccount(publicKey)}`,
      created: PINNED_CREATED,
    });
    (signed as unknown as { proof: { verificationMethod: string } }).proof.verificationMethod = verificationMethod;
    await expect(verifyPaymentRequest(JSON.stringify(signed))).rejects.toThrow(message);
  });
});

// matchesChain binds the namespace as well as the network: a request whose source is a Solana asset
// cannot be satisfied by a Stellar DID with the same reference and key, nor the reverse. Mirror of
// TestRecoverSignerIdentity_NamespaceBinding and TestSignerMatchesChain_MalformedChain in stellar_test.go.
describe("matchesChain", () => {
  async function verified(verificationMethod: (pub: Uint8Array) => string) {
    const { publicKey, secretKey } = nacl.sign.keyPair();
    const signed = await signPaymentRequestEd25519(stellarDoc(encodeStellarAccount(publicKey)) as never, secretKey, {
      verificationMethod: verificationMethod(publicKey),
      created: PINNED_CREATED,
    });
    return verifyPaymentRequest(JSON.stringify(signed));
  }
  const stellarDevnet = (pub: Uint8Array) => `did:pkh:stellar:devnet:${encodeStellarAccount(pub)}`;
  const solanaDevnet = (pub: Uint8Array) => `did:pkh:solana:devnet:${bs58.encode(pub)}`;

  it.each([
    ["stellar DID, stellar chain", stellarDevnet, "stellar:devnet"],
    ["solana DID, solana chain", solanaDevnet, "solana:devnet"],
    ["chain casing", stellarDevnet, "STELLAR:Devnet"],
  ])("accepts %s", async (_name, method, chain) => {
    const res = await verified(method);
    expect(() => matchesChain(res, chain)).not.toThrow();
  });

  it.each([
    ["stellar DID with a solana reference", stellarDevnet, "solana:devnet", /namespace "stellar" does not match/],
    ["solana DID with a stellar reference", solanaDevnet, "stellar:devnet", /namespace "solana" does not match/],
    ["stellar DID, wrong stellar network", stellarDevnet, "stellar:pubnet", /network "devnet" does not match/],
  ])("refuses %s", async (_name, method, chain, message) => {
    const res = await verified(method);
    expect(() => matchesChain(res, chain)).toThrow(message);
  });

  it.each(["devnet", "stellar:", ":devnet", ""])("refuses the malformed chain %j", async (chain) => {
    const res = await verified(stellarDevnet);
    expect(() => matchesChain(res, chain)).toThrow(/not a CAIP-2 identifier/);
  });

  it("refuses a secp256k1 result, which carries a recovered address rather than a self-asserted key", () => {
    expect(() =>
      matchesChain({ cryptosuite: "EcdsaSecp256k1RecoverySignature2020", didNamespace: "eip155", didNetwork: "eip155" }, "eip155:1")
    ).toThrow(/applies to ed25519/);
  });
});
