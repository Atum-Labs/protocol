import { describe, it, expect } from "vitest";

import {
  JsonRpcProvider,
  JsonRpcSigner,
  Signature,
  TypedDataEncoder,
  Wallet,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  toUtf8Bytes,
} from "ethers";

import { MalformedProofError, SignatureRecoveryError } from "./errors.js";
import {
  PAYMENT_REQUEST_DOMAIN,
  paymentRequestEnvelopeProofTypedData,
  paymentRequestEnvelopeProofTypedDigest,
  paymentRequestProofTypedData,
  paymentRequestProofTypedDigest,
  recoverSecp256k1ProofSignerFrom,
  signTypedProof,
} from "./payment-request-proof.js";
import { recoverSecp256k1ProofSigner, settlerProofTypedDigest } from "./settler-identity.js";

// Shared payment request vectors, computed with ethers v6 TypedDataEncoder (hashDomain and hash)
// over proofHash = 0x11…11 and docHash = 0x22…22. The Go twin pins the same values, so these are
// what its hand-written encoder is checked against.
const VECTOR_DOMAIN_SEPARATOR = "0x46511acc2ec7ae34fc8dfa9e2f8bfbe3b069a5f382bf745e99792dde537be52f";
const VECTOR_PAYMENT_REQUEST_PROOF = "0x833afd335452f4ec0fb55c8d5604a840e14d3be0b9402b226f56f0c773990bc1";
const VECTOR_PAYMENT_REQUEST_ENVELOPE_PROOF =
  "0x3b2810486db3c482e5ef804385bc5022975680cb8271b4415abca5c912f296ec";

const fill = (byte: number) => new Uint8Array(32).fill(byte);

function hashes() {
  const proofHash = getBytes(keccak256(toUtf8Bytes("proof options")));
  const docHash = getBytes(keccak256(toUtf8Bytes("document")));
  const combined = new Uint8Array(64);
  combined.set(proofHash, 0);
  combined.set(docHash, 32);
  return { signingInput: getBytes(keccak256(combined)), proofHash, docHash };
}

const sign = (wallet: { signingKey: Wallet["signingKey"] }, digest: Uint8Array) =>
  getBytes(wallet.signingKey.sign(digest).serialized);

// A browser wallet behind ethers' JsonRpcSigner: the signer sends eth_signTypedData_v4 with the
// JSON payload a wallet receives, and this answers it the way the wallet's key would, from the
// payload alone (EIP712Domain included, as v4 carries it).
function browserWallet(wallet: Wallet): { signer: JsonRpcSigner; requests: { method: string; params: unknown[] }[] } {
  const requests: { method: string; params: unknown[] }[] = [];
  const provider = new JsonRpcProvider("http://127.0.0.1:0", 1, { staticNetwork: true });
  provider._send = (async (payload: Parameters<JsonRpcProvider["_send"]>[0]) => {
    const calls = Array.isArray(payload) ? payload : [payload];
    return Promise.all(
      calls.map(async ({ id, method, params }) => {
        requests.push({ method, params: params as unknown[] });
        if (method !== "eth_signTypedData_v4") return { id, error: { code: -32601, message: method } };
        const [from, json] = params as [string, string];
        if (getAddress(from) !== wallet.address) return { id, error: { code: 4100, message: "unknown account" } };
        const { domain, types, message, primaryType } = JSON.parse(json);
        expect(types.EIP712Domain).toBeDefined();
        delete types.EIP712Domain;
        expect(Object.keys(types)).toEqual([primaryType]);
        return { id, result: await wallet.signTypedData(domain, types, message) };
      })
    );
  }) as unknown as JsonRpcProvider["_send"];
  return { signer: new JsonRpcSigner(provider, wallet.address), requests };
}

describe("payment request domain", () => {
  it("derives its sentinel verifying contract", () => {
    const derived = getAddress("0x" + keccak256(toUtf8Bytes("atum.payment-request.v1")).slice(-40));
    expect(PAYMENT_REQUEST_DOMAIN.verifyingContract).toBe(derived);
  });

  it("matches the shared vectors", () => {
    expect(TypedDataEncoder.hashDomain(PAYMENT_REQUEST_DOMAIN)).toBe(VECTOR_DOMAIN_SEPARATOR);
    expect(hexlify(paymentRequestProofTypedDigest(fill(0x11), fill(0x22)))).toBe(VECTOR_PAYMENT_REQUEST_PROOF);
    expect(hexlify(paymentRequestEnvelopeProofTypedDigest(fill(0x11), fill(0x22)))).toBe(
      VECTOR_PAYMENT_REQUEST_ENVELOPE_PROOF
    );
  });

  it("gives each proof its own digest, apart from the raw and settler forms", () => {
    const h = hashes();
    const digests = [
      h.signingInput,
      paymentRequestProofTypedDigest(h.proofHash, h.docHash),
      paymentRequestEnvelopeProofTypedDigest(h.proofHash, h.docHash),
      settlerProofTypedDigest(h.proofHash, h.docHash),
    ].map((d) => keccak256(d));
    expect(new Set(digests).size).toBe(4);
  });

  it("refuses a hash that is not 32 bytes", () => {
    expect(() => paymentRequestProofTypedDigest(new Uint8Array(31), fill(0))).toThrow(MalformedProofError);
    expect(() => paymentRequestEnvelopeProofTypedData(fill(0), new Uint8Array(33))).toThrow(MalformedProofError);
  });
});

describe("recoverSecp256k1ProofSignerFrom", () => {
  const wallet = Wallet.createRandom();
  const is = (a: string) => a === wallet.address;
  const h = hashes();

  it("recovers the raw form whatever typed forms are listed", () => {
    expect(recoverSecp256k1ProofSignerFrom(h, sign(wallet, h.signingInput), is, [paymentRequestProofTypedDigest])).toBe(wallet.address);
  });

  it("recovers a listed typed form", () => {
    const sig = sign(wallet, paymentRequestEnvelopeProofTypedDigest(h.proofHash, h.docHash));
    expect(recoverSecp256k1ProofSignerFrom(h, sig, is, [settlerProofTypedDigest, paymentRequestEnvelopeProofTypedDigest])).toBe(wallet.address);
  });

  it("does not recover an unlisted typed form", () => {
    const sig = sign(wallet, paymentRequestEnvelopeProofTypedDigest(h.proofHash, h.docHash));
    expect(recoverSecp256k1ProofSignerFrom(h, sig, is, [paymentRequestProofTypedDigest])).not.toBe(wallet.address);
    expect(recoverSecp256k1ProofSignerFrom(h, sig, is, [])).not.toBe(wallet.address);
  });

  it("leaves the settler recovery without the payment request forms", () => {
    for (const digestOf of [paymentRequestProofTypedDigest, paymentRequestEnvelopeProofTypedDigest]) {
      const sig = sign(wallet, digestOf(h.proofHash, h.docHash));
      expect(recoverSecp256k1ProofSigner(h, sig, is)).not.toBe(wallet.address);
    }
  });
});

describe("signTypedProof (wallet signatures)", () => {
  const wallet = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  const h = hashes();

  it("takes an ethers Wallet's signTypedData and the digest recovers the wallet", async () => {
    const request = paymentRequestProofTypedData(h.proofHash, h.docHash);
    const { address, signature } = await signTypedProof(wallet, request);
    expect(address).toBe(wallet.address);
    expect(signature[64] === 27 || signature[64] === 28).toBe(true);
    expect(recoverSecp256k1ProofSignerFrom(h, signature, (a) => a === wallet.address, [paymentRequestProofTypedDigest])).toBe(
      wallet.address
    );
  });

  it("takes eth_signTypedData_v4 from a browser wallet", async () => {
    const { signer, requests } = browserWallet(wallet);
    const request = paymentRequestEnvelopeProofTypedData(h.proofHash, h.docHash);
    const { signature } = await signTypedProof(signer, request);
    expect(requests.map((r) => r.method)).toEqual(["eth_signTypedData_v4"]);
    const payload = JSON.parse(requests[0].params[1] as string);
    expect(payload.primaryType).toBe("PaymentRequestEnvelopeProof");
    // The v4 payload spells the address in lower case; it is the same contract.
    expect({ ...payload.domain, verifyingContract: getAddress(payload.domain.verifyingContract) }).toEqual({
      ...PAYMENT_REQUEST_DOMAIN,
    });
    expect(payload.message).toEqual(request.message);
    expect(
      recoverSecp256k1ProofSignerFrom(h, signature, (a) => a === wallet.address, [paymentRequestEnvelopeProofTypedDigest])
    ).toBe(wallet.address);
  });

  it("accepts a wallet that answers v as 0 or 1", async () => {
    const request = paymentRequestProofTypedData(h.proofHash, h.docHash);
    const zeroOne = {
      getAddress: () => wallet.address,
      signTypedData: async (...args: Parameters<Wallet["signTypedData"]>) => {
        const sig = Signature.from(await wallet.signTypedData(...args));
        return sig.r + sig.s.slice(2) + (sig.v - 27).toString(16).padStart(2, "0");
      },
    };
    const { signature } = await signTypedProof(zeroOne, request);
    expect(signature[64] === 27 || signature[64] === 28).toBe(true);
  });

  it("refuses a signature that recovers another key", async () => {
    const other = Wallet.createRandom();
    const impostor = {
      getAddress: () => wallet.address,
      signTypedData: (...args: Parameters<Wallet["signTypedData"]>) => other.signTypedData(...args),
    };
    await expect(signTypedProof(impostor, paymentRequestProofTypedData(h.proofHash, h.docHash))).rejects.toThrow(
      SignatureRecoveryError
    );
  });
});
