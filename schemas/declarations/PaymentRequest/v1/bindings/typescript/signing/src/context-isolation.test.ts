import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";

import { signPaymentRequest } from "./sign.js";
import { signerFromEthersWallet } from "./signer.js";
import { signPaymentRequestWithSigner } from "./sign.js";
import { verifyPaymentRequest } from "./verify.js";
import type { PaymentRequest } from "@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript";

// JSON-LD contexts are resolved from local copies ONLY. Nothing here may reach the network,
// and that is a security property rather than an optimization: the @context decides what each
// term in the document MEANS, so a context an attacker can serve is a context that can change
// what a signature covers — dropping a term from canonicalization makes the field it names
// unsigned while the document still looks signed.
//
// The libraries make this structural: neither half has an HTTP client, and jsonld is always
// handed our loader in place of its built-in fetcher. These tests pin the observable behaviour,
// so a future change that reintroduces a fetch fails here.

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CREATED = "2026-04-01T00:00:00.000Z";
const wallet = new Wallet(KEY);

function request(): PaymentRequest {
  return {
    version: "1.0",
    request_id: "req-ctx-1",
    source: {
      account: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      asset_identifier: "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A",
    },
    destination: [
      { account: "0x0000000000000000000000000000000000000002", asset_identifier: "eip155:1/erc20:0xbbb" },
    ],
    fulfillment_amount: "1000000",
    quote_deadline: "2030-01-01T00:00:00Z",
    fulfillment_deadline: "2030-01-02T00:00:00Z",
    sender_auth: {
      message_scheme: "EVM_PERMIT2",
      signed_messages: [{ message: "0xaa", signature: "0xbb" }],
    },
  } as unknown as PaymentRequest;
}

async function signed() {
  return signPaymentRequestWithSigner(request(), signerFromEthersWallet(wallet), {
    chainId: 1,
    created: CREATED,
  });
}

describe("JSON-LD contexts resolve locally only", () => {
  it("signing replaces any caller-supplied @context rather than honouring it", async () => {
    const hostile = {
      ...request(),
      "@context": ["https://attacker.example/context.jsonld"],
    } as unknown as PaymentRequest;

    const out = await signPaymentRequest(hostile, KEY, { chainId: 1, created: CREATED });

    // The signer emits the canonical pair and discards what came in. If it merged instead,
    // a caller could introduce term definitions into the document it then signs.
    expect(out["@context"]).not.toContain("https://attacker.example/context.jsonld");
    expect(out["@context"][0]).toContain("/declarations/PaymentRequest/v1/context.jsonld");
  });

  it.each([
    ["an attacker-controlled host", "https://attacker.example/context.jsonld"],
    ["a look-alike of ours", "https://schemas.atum.network.attacker.example/declarations/PaymentRequest/v1/context.jsonld"],
    ["a one-character typo of ours", "https://schemas.atum.netwerk/declarations/PaymentRequest/v1/context.jsonld"],
    ["plain http instead of https", "http://schemas.atum.network/declarations/PaymentRequest/v1/context.jsonld"],
    ["a file:// URL", "file:///etc/passwd"],
  ])("verification refuses a document whose @context is %s", async (_label, url) => {
    const doc = (await signed()) as unknown as Record<string, unknown>;
    doc["@context"] = [url, "https://w3id.org/security/suites/secp256k1recovery-2020/v2"];

    // Fails closed on an unresolvable context. It does NOT hang on a fetch, and it does not
    // silently canonicalize without the terms.
    await expect(
      verifyPaymentRequest(doc),
    ).rejects.toThrow(/unknown JSON-LD context|loading remote context failed|Dereferencing a URL did not result/i);
  });

  it("refuses an unregistered context even when the rest of the document is untouched", async () => {
    const doc = (await signed()) as unknown as Record<string, unknown>;
    const original = doc["@context"] as string[];
    doc["@context"] = [...original, "https://attacker.example/extra.jsonld"];

    await expect(verifyPaymentRequest(doc)).rejects.toThrow(
      /unknown JSON-LD context|loading remote context failed|Dereferencing a URL did not result/i,
    );
  });

  // Idempotence of the supported re-sign flow (fresh deadlines, same content). Worth pinning
  // in its own right, but note what it does NOT show: this held before @context was stripped
  // too, because an already-signed document carries the CANONICAL context, so the default and
  // the supplied value coincide. The divergence only surfaces for a context that changes how
  // the document's own terms expand — the attacker case above — and not for a different SUITE
  // context either, since the proof block is hashed separately from the document.
  it("re-signing a signed document yields the same proof as signing the bare one", async () => {
    const first = await signed();
    const again = await signPaymentRequestWithSigner(
      first as unknown as PaymentRequest,
      signerFromEthersWallet(wallet),
      { chainId: 1, created: CREATED },
    );
    expect(again.proof.jws).toBe(first.proof.jws);
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
  });

  it("a stale proof on the input does not become part of what is signed", async () => {
    const withStaleProof = {
      ...request(),
      proof: { type: "EcdsaSecp256k1RecoverySignature2020", jws: "not-a-real-signature" },
    } as unknown as PaymentRequest;

    const out = await signPaymentRequestWithSigner(
      withStaleProof,
      signerFromEthersWallet(wallet),
      { chainId: 1, created: CREATED },
    );
    const bare = await signed();
    expect(out.proof.jws).toBe(bare.proof.jws);
  });

  it("resolves the canonical contexts without any network access", async () => {
    // The positive half: with only local copies present, signing and verifying both complete.
    // Read together with the rejections above, this is the whole property — the registered set
    // works, everything else fails closed.
    const doc = await signed();
    const res = await verifyPaymentRequest(doc as unknown as Record<string, unknown>);
    expect(res.signerAddress).toBe(wallet.address.toLowerCase());
  });

  it("still fails closed when a global fetch exists and would have succeeded", async () => {
    // If a fetch were ever reintroduced, this hostile context would resolve and the assertion
    // below would flip. Installing a fetch that WOULD serve a valid context is what makes this
    // a real check rather than a restatement of "the network is unavailable in CI".
    const globalRef = globalThis as { fetch?: unknown };
    const saved = globalRef.fetch;
    let fetched = false;
    globalRef.fetch = async () => {
      fetched = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({ "@context": { evil: "https://attacker.example/#evil" } }),
        text: async () => '{"@context":{"evil":"https://attacker.example/#evil"}}',
        headers: new Map([["content-type", "application/ld+json"]]),
      } as unknown as Response;
    };
    try {
      const doc = (await signed()) as unknown as Record<string, unknown>;
      doc["@context"] = ["https://attacker.example/context.jsonld"];
      await expect(verifyPaymentRequest(doc)).rejects.toThrow(
        /unknown JSON-LD context|loading remote context failed|Dereferencing a URL did not result/i,
      );
      expect(fetched).toBe(false);
    } finally {
      if (saved === undefined) delete globalRef.fetch;
      else globalRef.fetch = saved;
    }
  });
});
