import { describe, it, expect } from "vitest";
import { JsonRpcProvider, JsonRpcSigner, SigningKey, Wallet, getAddress, getBytes, hexlify } from "ethers";
import {
  paymentRequestEnvelopeProofTypedDigest,
  paymentRequestProofTypedDigest,
  settlerProofTypedDigest,
  type TypedProofDigest,
} from "@atum-labs/ld-data-integrity";

import { signPaymentRequest, signPaymentRequestWithSigner, signPaymentRequestWithTypedDataSigner } from "./sign.js";
import { verifyPaymentRequest } from "./verify.js";
import { createDetachedJws, parseDetachedJws } from "./jws.js";
import { computeRequestHash } from "./request-hash.js";
import { hashPaymentRequest } from "./hash.js";
import type { PaymentRequest } from "@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript";

// The typed form of the inner PaymentRequest proof, what a payer's wallet signs: an EIP-712
// signature over PaymentRequestProof{proofHash, docHash}. These pin that it verifies, that a
// browser wallet's eth_signTypedData_v4 answer verifies, and that it binds exactly what the raw
// form binds.

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CREATED = "2026-04-01T00:00:00.000Z";

function doc(account: string): PaymentRequest {
  return {
    version: "1.0",
    request_id: "req-pr-typed-1",
    source: { asset_identifier: "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A", account },
    destination: [{ asset_identifier: "eip155:1/erc20:0xbbb", account: "0x0000000000000000000000000000000000000002" }],
    fulfillment_amount: "1000000",
    quote_deadline: "2030-01-01T00:00:00Z",
    fulfillment_deadline: "2030-01-02T00:00:00Z",
    escrow_contract_address: "0x0000000000000000000000000000000000000003",
    fulfillment_verifier: { account: "0x0000000000000000000000000000000000000004", endpoint: "https://veri-fill.example.com" },
    sender_auth: {
      message_scheme: "EVM_PERMIT2",
      signed_messages: [
        {
          message: "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
          message_prehash: "{}",
          signature: "0xabcdef1234567890",
        },
      ],
    },
  } as unknown as PaymentRequest;
}

// A browser wallet behind ethers' JsonRpcSigner, answering eth_signTypedData_v4 from the JSON
// payload alone, as the wallet does.
function browserWallet(wallet: Wallet) {
  const payloads: { primaryType: string; message: Record<string, string> }[] = [];
  const provider = new JsonRpcProvider("http://127.0.0.1:0", 1, { staticNetwork: true });
  provider._send = (async (payload: Parameters<JsonRpcProvider["_send"]>[0]) => {
    const calls = Array.isArray(payload) ? payload : [payload];
    return Promise.all(
      calls.map(async ({ id, method, params }) => {
        if (method !== "eth_signTypedData_v4") return { id, error: { code: -32601, message: method } };
        const [from, json] = params as [string, string];
        if (getAddress(from) !== wallet.address) return { id, error: { code: 4100, message: "unknown account" } };
        const { domain, types, message, primaryType } = JSON.parse(json);
        payloads.push({ primaryType, message });
        delete types.EIP712Domain;
        return { id, result: await wallet.signTypedData(domain, types, message) };
      })
    );
  }) as unknown as JsonRpcProvider["_send"];
  return { signer: new JsonRpcSigner(provider, wallet.address), payloads };
}

// A verifier of an originator's own payment request, which accepts the typed form.
const ACCEPT_TYPED = { acceptPaymentRequestTypedProof: true };

describe("PaymentRequest typed proof", () => {
  const wallet = new Wallet(KEY);
  const account = wallet.address.toLowerCase();

  it("verifies, signed by ethers' Wallet.signTypedData", async () => {
    const signed = await signPaymentRequestWithTypedDataSigner(doc(account), wallet, { chainId: 1, created: CREATED });
    const res = await verifyPaymentRequest(signed as unknown as Record<string, unknown>, ACCEPT_TYPED);
    expect(res.signerAddress).toBe(account);
    expect(res.signerDID).toBe(`did:pkh:eip155:1:${account}`);
  });

  // The default verifier, the published SDKs' included, does not take the typed form: the signature
  // recovers someone else, and the request reads as altered.
  it("is refused by a verifier that does not ask for it", async () => {
    const signed = await signPaymentRequestWithTypedDataSigner(doc(account), wallet, { chainId: 1, created: CREATED });
    await expect(verifyPaymentRequest(signed as unknown as Record<string, unknown>)).rejects.toThrow(/altered/);
  });

  it("verifies, signed by a browser wallet over eth_signTypedData_v4", async () => {
    const { signer, payloads } = browserWallet(wallet);
    const signed = await signPaymentRequestWithTypedDataSigner(doc(account), signer, { chainId: 42161, created: CREATED });
    const res = await verifyPaymentRequest(signed as unknown as Record<string, unknown>, ACCEPT_TYPED);
    expect(res.signerAddress).toBe(account);

    // The wallet was shown the document's own two hashes.
    expect(payloads).toHaveLength(1);
    expect(payloads[0].primaryType).toBe("PaymentRequestProof");
    const { "@context": _c, proof, ...bare } = signed as unknown as Record<string, unknown> & { proof: Record<string, string> };
    void _c;
    const hashes = await hashPaymentRequest(bare, {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions: {
        type: "EcdsaSecp256k1RecoverySignature2020",
        created: proof.created,
        verificationMethod: proof.verificationMethod,
        proofPurpose: proof.proofPurpose,
      },
    });
    expect(payloads[0].message).toEqual({ proofHash: hexlify(hashes.proofHash), docHash: hexlify(hashes.docHash) });
  });

  it("differs from the raw form only in its signature, and shares its request_hash", async () => {
    const typed = await signPaymentRequestWithTypedDataSigner(doc(account), wallet, { chainId: 1, created: CREATED });
    const raw = await signPaymentRequest(doc(account), KEY, { chainId: 1, created: CREATED });
    expect(typed.proof.jws).not.toBe(raw.proof.jws);
    expect({ ...typed, proof: { ...typed.proof, jws: "" } }).toEqual({ ...raw, proof: { ...raw.proof, jws: "" } });
    expect(await computeRequestHash(typed as never)).toBe(await computeRequestHash(raw as never));
  });

  const tampers: [string, (m: Record<string, any>) => void][] = [
    ["request_id", (m) => (m.request_id = "req-pr-typed-2")],
    ["fulfillment_amount", (m) => (m.fulfillment_amount = "1000001")],
    ["destination", (m) => (m.destination[0].account = "0x0000000000000000000000000000000000000008")],
    ["sender_auth signature", (m) => (m.sender_auth.signed_messages[0].signature = "0xabcdef1234567891")],
    ["proof.created", (m) => (m.proof.created = "2026-04-01T00:00:01.000Z")],
  ];
  for (const [name, tamper] of tampers) {
    it(`binds ${name}`, async () => {
      const signed = await signPaymentRequestWithTypedDataSigner(doc(account), wallet, { chainId: 1, created: CREATED });
      const m = JSON.parse(JSON.stringify(signed));
      tamper(m);
      await expect(verifyPaymentRequest(m, ACCEPT_TYPED)).rejects.toThrow(/altered/);
    });
  }

  // The inner proof is taken only as PaymentRequestProof. The same key signing the same two hashes
  // as any other typed struct, the envelope's or a settler's, recovers someone else under every
  // digest this verifier tries, so the request reads as altered even where the typed form is
  // accepted. Mirror of the Go half's TestTypedProof_RefusesOtherTypedStructs.
  const signedOver = async (digestOf: TypedProofDigest) => {
    const hashes = await hashPaymentRequest(doc(account) as unknown as Record<string, unknown>, {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions: {
        type: "EcdsaSecp256k1RecoverySignature2020",
        created: CREATED,
        verificationMethod: `did:pkh:eip155:1:${account}#blockchainAccountId`,
        proofPurpose: "assertionMethod",
      },
    });
    const sig = new SigningKey(KEY).sign(digestOf(hashes.proofHash, hashes.docHash));
    const rsv = new Uint8Array(65);
    rsv.set(getBytes(sig.r), 0);
    rsv.set(getBytes(sig.s), 32);
    rsv[64] = sig.yParity;
    const signer = { getAddress: () => wallet.address, signDigest: async () => rsv };
    return signPaymentRequestWithSigner(doc(account), signer, { chainId: 1, created: CREATED });
  };

  it("takes a signature over PaymentRequestProof, signed outside a wallet the same way", async () => {
    const signed = await signedOver(paymentRequestProofTypedDigest);
    const res = await verifyPaymentRequest(signed as unknown as Record<string, unknown>, ACCEPT_TYPED);
    expect(res.signerAddress).toBe(account);
  });

  const otherStructs: [string, TypedProofDigest][] = [
    ["PaymentRequestEnvelopeProof", paymentRequestEnvelopeProofTypedDigest],
    ["SettlerProof", settlerProofTypedDigest],
  ];
  for (const [name, digestOf] of otherStructs) {
    it(`refuses a ${name} signature as the inner PaymentRequest proof`, async () => {
      const signed = await signedOver(digestOf);
      await expect(verifyPaymentRequest(signed as unknown as Record<string, unknown>, ACCEPT_TYPED)).rejects.toThrow(/altered/);
    });
  }

  it("refuses a typed signature by a key other than the one it names", async () => {
    const other = Wallet.createRandom();
    const impostor = { getAddress: () => wallet.address, signTypedData: other.signTypedData.bind(other) };
    await expect(
      signPaymentRequestWithTypedDataSigner(doc(account), impostor, { chainId: 1, created: CREATED })
    ).rejects.toThrow(/recovers/);
  });
});

// The default verifier recovers through recoverSecp256k1Signer, which takes v ∈ {0, 1, 27, 28} and
// refuses any other v, as Go does. ethers would read 8 or 9 plus 27 as an EIP-155 v, so a raw-signed
// request with its v moved from 27 or 28 to 8 or 9 recovered the signer before.
describe("PaymentRequest recovery byte", () => {
  const wallet = new Wallet(KEY);
  const account = wallet.address.toLowerCase();

  it("refuses a raw-signed request whose v is moved from 27 or 28 to 8 or 9", async () => {
    const signed = await signPaymentRequest(doc(account), KEY, { chainId: 1, created: CREATED });
    const res = await verifyPaymentRequest(signed as unknown as Record<string, unknown>);
    expect(res.signerAddress).toBe(account);

    const { signature } = parseDetachedJws(signed.proof.jws as string);
    expect([27, 28]).toContain(signature[64]);
    const moved = new Uint8Array(signature);
    moved[64] -= 19;
    const m = { ...signed, proof: { ...signed.proof, jws: createDetachedJws(moved) } };
    await expect(verifyPaymentRequest(m as unknown as Record<string, unknown>)).rejects.toThrow(/recovery byte/);
  });
});
