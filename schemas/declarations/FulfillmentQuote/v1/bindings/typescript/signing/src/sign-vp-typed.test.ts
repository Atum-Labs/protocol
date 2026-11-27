import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JsonRpcProvider, JsonRpcSigner, Wallet, getAddress, getBytes } from "ethers";
import {
  paymentRequestEnvelopeProofTypedDigest,
  paymentRequestProofTypedDigest,
  settlerProofTypedDigest,
} from "@atum-labs/ld-data-integrity";
import type { VerifiableCredential } from "@atum-labs/schema-declarations/FulfillmentQuoteEnvelope/v1/bindings/typescript";

import { signVP, signVPWithTypedDataSigner } from "./sign-vp.js";
import { verifyVP, type VerifyVPOptions } from "./verify-vp.js";
import { hashQuote } from "./hash.js";
import { createDetachedJws } from "./jws.js";
import { SECP256K1_RECOVERY_CONTEXT_URL, W3C_VC_V1_CONTEXT_URL } from "./canonicalize.js";

// The typed form of the PaymentRequestEnvelope holder proof, what a payer's wallet signs: an
// EIP-712 signature over PaymentRequestEnvelopeProof{proofHash, docHash}.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRE_CONTEXT_URL = "https://schemas.atum.network/declarations/PaymentRequestEnvelope/v1/context.jsonld";
const PRE_CONTEXT = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../../../PaymentRequestEnvelope/v1/context.jsonld"), "utf-8")
) as Record<string, unknown>;

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const wallet = new Wallet(KEY);
const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;
const CREATED = "2026-04-01T00:00:00.000Z";

function credentials(): VerifiableCredential[] {
  return [
    {
      "@context": [W3C_VC_V1_CONTEXT_URL, "https://schemas.atum.xyz/credentials/known-to-atum/v1"],
      id: "urn:uuid:5b5d7e0e-9d27-4f1f-a5db-3a52cfb24d2f",
      type: ["VerifiableCredential", "KnownToAtumVerifiableCredential"],
      issuer: "did:web:atumlabs.xyz",
      issuanceDate: "2026-01-01T00:00:00Z",
      credentialSubject: { id: holder, role: "psp" },
      proof: {
        type: "EcdsaSecp256k1RecoverySignature2020",
        created: "2026-01-01T00:00:00Z",
        verificationMethod: "did:web:atumlabs.xyz#key-1",
        proofPurpose: "assertionMethod",
      },
    } as unknown as VerifiableCredential,
  ];
}

const signOptions = {
  holder,
  verificationMethod: `${holder}#blockchainAccountId`,
  challenge: "0x" + "ab".repeat(32),
  domain: "did:web:devnet.atum.network",
  created: CREATED,
  declarationType: "PaymentRequestEnvelope",
  envelopeContextUrl: PRE_CONTEXT_URL,
  extraEnvelopeContexts: { [PRE_CONTEXT_URL]: PRE_CONTEXT },
};

function verifyOptions(accept: boolean): VerifyVPOptions {
  return {
    expectedChallenge: signOptions.challenge,
    expectedDomain: signOptions.domain,
    expectedHolder: holder,
    now: new Date("2026-04-01T00:00:30Z"),
    maxProofAgeMs: 60 * 60 * 1000,
    expectedDeclarationType: "PaymentRequestEnvelope",
    envelopeContextUrl: PRE_CONTEXT_URL,
    extraEnvelopeContexts: { [PRE_CONTEXT_URL]: PRE_CONTEXT },
    acceptPaymentRequestEnvelopeTypedProof: accept,
  };
}

// A browser wallet behind ethers' JsonRpcSigner, answering eth_signTypedData_v4.
function browserWallet() {
  const methods: string[] = [];
  const provider = new JsonRpcProvider("http://127.0.0.1:0", 1, { staticNetwork: true });
  provider._send = (async (payload: Parameters<JsonRpcProvider["_send"]>[0]) => {
    const calls = Array.isArray(payload) ? payload : [payload];
    return Promise.all(
      calls.map(async ({ id, method, params }) => {
        methods.push(method);
        if (method !== "eth_signTypedData_v4") return { id, error: { code: -32601, message: method } };
        const [from, json] = params as [string, string];
        if (getAddress(from) !== wallet.address) return { id, error: { code: 4100, message: "unknown account" } };
        const { domain, types, message } = JSON.parse(json);
        delete types.EIP712Domain;
        return { id, result: await wallet.signTypedData(domain, types, message) };
      })
    );
  }) as unknown as JsonRpcProvider["_send"];
  return { signer: new JsonRpcSigner(provider, wallet.address), methods };
}

describe("PaymentRequestEnvelope typed holder proof", () => {
  it("verifies a browser wallet's eth_signTypedData_v4 where the typed form is accepted", async () => {
    const { signer, methods } = browserWallet();
    const envelope = await signVPWithTypedDataSigner(credentials(), signer, signOptions);
    expect(methods).toEqual(["eth_signTypedData_v4"]);
    const res = await verifyVP(JSON.stringify(envelope), verifyOptions(true));
    expect(res.signerAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(res.holder).toBe(holder);
  });

  it("is refused where the typed form is not accepted", async () => {
    const envelope = await signVPWithTypedDataSigner(credentials(), wallet, signOptions);
    await expect(verifyVP(JSON.stringify(envelope), verifyOptions(false))).rejects.toThrow();
  });

  it("signs only a PaymentRequestEnvelope", async () => {
    await expect(
      signVPWithTypedDataSigner(credentials(), wallet, { ...signOptions, declarationType: undefined as never })
    ).rejects.toThrow(/PaymentRequestEnvelope/);
  });

  it("differs from the raw form only in its signature", async () => {
    const typed = await signVPWithTypedDataSigner(credentials(), wallet, signOptions);
    const raw = await signVP(credentials(), KEY, signOptions);
    expect(typed.proof.jws).not.toBe(raw.proof.jws);
    expect({ ...typed, proof: { ...typed.proof, jws: "" } }).toEqual({ ...raw, proof: { ...raw.proof, jws: "" } });
  });

  const tampers: [string, (m: Record<string, any>, o: VerifyVPOptions) => void][] = [
    ["challenge", (m, o) => (m.proof.challenge = o.expectedChallenge = "0x" + "cd".repeat(32))],
    ["domain", (m, o) => (m.proof.domain = o.expectedDomain = "did:web:other.atum.network")],
    ["created", (m) => (m.proof.created = "2026-04-01T00:00:01.000Z")],
    ["credential id", (m) => (m.verifiableCredential[0].id = "urn:uuid:00000000-0000-0000-0000-000000000000")],
  ];
  for (const [name, tamper] of tampers) {
    it(`binds the ${name}`, async () => {
      const envelope = JSON.parse(JSON.stringify(await signVPWithTypedDataSigner(credentials(), wallet, signOptions)));
      const opts = verifyOptions(true);
      tamper(envelope, opts);
      await expect(verifyVP(JSON.stringify(envelope), opts)).rejects.toThrow();
    });
  }

  // An envelope that does not declare PaymentRequestEnvelope, signed over the same typed struct, is
  // refused even where the typed form is accepted. Built by hand, as signVP builds an envelope, and
  // the raw-signed twin of the same hand-built envelope is the control that verifies.
  it("is accepted only for an envelope that declares PaymentRequestEnvelope", async () => {
    const vpBody = {
      "@context": [W3C_VC_V1_CONTEXT_URL, PRE_CONTEXT_URL, SECP256K1_RECOVERY_CONTEXT_URL],
      type: ["VerifiablePresentation"],
      holder,
      verifiableCredential: credentials(),
    };
    const proofOptions = {
      type: "EcdsaSecp256k1RecoverySignature2020" as const,
      created: CREATED,
      verificationMethod: `${holder}#blockchainAccountId`,
      proofPurpose: "authentication" as const,
      challenge: signOptions.challenge,
      domain: signOptions.domain,
    };
    const hashes = await hashQuote(vpBody, {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions,
      keepVerifiableCredential: true,
      extraEnvelopeContexts: signOptions.extraEnvelopeContexts,
      proofContext: [PRE_CONTEXT_URL, SECP256K1_RECOVERY_CONTEXT_URL],
    });
    const envelopeSignedOver = (digest: Uint8Array) =>
      JSON.stringify({
        ...vpBody,
        proof: { ...proofOptions, jws: createDetachedJws(getBytes(wallet.signingKey.sign(digest).serialized)) },
      });
    const opts = { ...verifyOptions(true), expectedDeclarationType: undefined };

    await expect(verifyVP(envelopeSignedOver(hashes.signingInput), opts)).resolves.toBeDefined();
    await expect(
      verifyVP(envelopeSignedOver(paymentRequestEnvelopeProofTypedDigest(hashes.proofHash, hashes.docHash)), opts)
    ).rejects.toThrow();
  });

  // A PaymentRequestEnvelope signed over some digest of its own hashes, built as signVP builds one, so
  // a refusal below can only come from the form of the signature, or from `type` where a test passes
  // its own. The raw-signed one is the control.
  async function preSignedOver(
    digestOf: (h: { signingInput: Uint8Array; proofHash: Uint8Array; docHash: Uint8Array }) => Uint8Array,
    type: unknown = ["VerifiablePresentation", "PaymentRequestEnvelope"]
  ) {
    const vpBody = {
      "@context": [W3C_VC_V1_CONTEXT_URL, PRE_CONTEXT_URL, SECP256K1_RECOVERY_CONTEXT_URL],
      type,
      holder,
      verifiableCredential: credentials(),
    };
    const proofOptions = {
      type: "EcdsaSecp256k1RecoverySignature2020" as const,
      created: CREATED,
      verificationMethod: `${holder}#blockchainAccountId`,
      proofPurpose: "authentication" as const,
      challenge: signOptions.challenge,
      domain: signOptions.domain,
    };
    const hashes = await hashQuote(vpBody, {
      cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
      proofOptions,
      keepVerifiableCredential: true,
      extraEnvelopeContexts: signOptions.extraEnvelopeContexts,
      proofContext: [PRE_CONTEXT_URL, SECP256K1_RECOVERY_CONTEXT_URL],
    });
    const signature = getBytes(wallet.signingKey.sign(digestOf(hashes)).serialized);
    return JSON.stringify({ ...vpBody, proof: { ...proofOptions, jws: createDetachedJws(signature) } });
  }

  it("refuses a PaymentRequestEnvelope signed as the inner request's PaymentRequestProof", async () => {
    await expect(verifyVP(await preSignedOver((h) => h.signingInput), verifyOptions(true))).resolves.toBeDefined();
    const signed = await preSignedOver((h) => paymentRequestProofTypedDigest(h.proofHash, h.docHash));
    await expect(verifyVP(signed, verifyOptions(true))).rejects.toThrow(/signer\/holder mismatch/);
  });

  // JSON-LD reads `"type": "PaymentRequestEnvelope"` like the one-element array, so the bare string
  // signs the same hash. Go decodes `type` as a []string and refuses the string while decoding, so
  // verifyVP refuses it too, before the declaration checks, in whichever form the holder signed it.
  const bareStringForms: [string, (h: { signingInput: Uint8Array; proofHash: Uint8Array; docHash: Uint8Array }) => Uint8Array][] = [
    ["raw", (h) => h.signingInput],
    ["SettlerProof", (h) => settlerProofTypedDigest(h.proofHash, h.docHash)],
  ];
  for (const [form, digestOf] of bareStringForms) {
    it(`refuses an envelope whose type is a bare string, as Go does while decoding (${form})`, async () => {
      const signed = await preSignedOver(digestOf, "PaymentRequestEnvelope");
      const opts = { ...verifyOptions(true), expectedDeclarationType: undefined };
      await expect(verifyVP(signed, opts)).rejects.toThrow(/envelope\.type must be an array of strings/);
    });
  }

  it("refuses a PaymentRequestEnvelope signed in the settler identity form, whether or not the payer's form is accepted", async () => {
    const signed = await preSignedOver((h) => settlerProofTypedDigest(h.proofHash, h.docHash));
    for (const accept of [false, true]) {
      await expect(verifyVP(signed, verifyOptions(accept))).rejects.toThrow(/signer\/holder mismatch/);
    }
  });
});
