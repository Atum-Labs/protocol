import { describe, it, expect } from "vitest";
import { Wallet, SigningKey, getBytes } from "ethers";

import { signPaymentRequest, signPaymentRequestWithSigner } from "./sign.js";
import { signerFromEthersWallet, type DeclarationSigner } from "./signer.js";
import { verifyPaymentRequest } from "./verify.js";
import type { PaymentRequest } from "@atum-labs/schema-declarations/PaymentRequest/v1/bindings/typescript";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// proof.created is inside the signed payload, so it is pinned rather than left to the clock.
const CREATED = "2026-04-01T00:00:00.000Z";

function request(): PaymentRequest {
  return {
    version: "1.0",
    request_id: "req-signer-1",
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

const wallet = new Wallet(KEY);

describe("signPaymentRequestWithSigner — positive", () => {
  it("produces byte-identical output to the private-key path", async () => {
    const viaKey = await signPaymentRequest(request(), KEY, { chainId: 1, created: CREATED });
    const viaSigner = await signPaymentRequestWithSigner(
      request(),
      signerFromEthersWallet(wallet),
      { chainId: 1, created: CREATED },
    );
    // The key path is implemented over the signer path, so this is the guard that the
    // refactor did not change what gets signed.
    expect(JSON.stringify(viaSigner)).toBe(JSON.stringify(viaKey));
  });

  it("produces a proof that verifies and recovers the signer's own address", async () => {
    const signed = await signPaymentRequestWithSigner(
      request(),
      signerFromEthersWallet(wallet),
      { chainId: 1, created: CREATED },
    );
    const res = await verifyPaymentRequest(signed as unknown as Record<string, unknown>);
    expect(res.signerAddress).toBe(wallet.address.toLowerCase());
  });

  it("accepts an asynchronous signer, which is what a custodian looks like", async () => {
    const remote: DeclarationSigner = {
      getAddress: async () => wallet.address,
      signDigest: async (digest) => {
        await new Promise((r) => setTimeout(r, 1));
        const sig = wallet.signingKey.sign(digest);
        const out = new Uint8Array(65);
        out.set(getBytes(sig.r), 0);
        out.set(getBytes(sig.s), 32);
        out[64] = sig.yParity;
        return out;
      },
    };
    const signed = await signPaymentRequestWithSigner(request(), remote, { chainId: 1, created: CREATED });
    const res = await verifyPaymentRequest(signed as unknown as Record<string, unknown>);
    expect(res.signerAddress).toBe(wallet.address.toLowerCase());
  });

  it("is handed a 32-byte digest, not the document", async () => {
    let seen: number | undefined;
    const spy: DeclarationSigner = {
      getAddress: () => wallet.address,
      signDigest: (digest) => {
        seen = digest.length;
        const sig = wallet.signingKey.sign(digest);
        const out = new Uint8Array(65);
        out.set(getBytes(sig.r), 0);
        out.set(getBytes(sig.s), 32);
        out[64] = sig.yParity;
        return out;
      },
    };
    await signPaymentRequestWithSigner(request(), spy, { chainId: 1, created: CREATED });
    // A custodian's policy engine can only reason about what it is asked to sign. 32 bytes is
    // a digest; anything else would mean the seam is handing over something else.
    expect(seen).toBe(32);
  });

  it("never receives the key: the signer is the only thing holding one", async () => {
    // Structural, not behavioural — the seam takes an interface with two methods and no key
    // accessor, so there is nothing for the library to read even by accident.
    const signer = signerFromEthersWallet(wallet);
    expect(Object.keys(signer).sort()).toEqual(["getAddress", "signDigest"]);
  });
});

describe("signPaymentRequestWithSigner — adversarial", () => {
  const goodSig = (digest: Uint8Array) => {
    const sig = wallet.signingKey.sign(digest);
    const out = new Uint8Array(65);
    out.set(getBytes(sig.r), 0);
    out.set(getBytes(sig.s), 32);
    out[64] = sig.yParity;
    return out;
  };

  // The dangerous one: applying +27 twice yields a valid-looking signature that recovers a
  // DIFFERENT address. Rejecting beats emitting a proof that verifies as somebody else.
  it("refuses a signer that pre-applied the +27 alignment", async () => {
    const preApplied: DeclarationSigner = {
      getAddress: () => wallet.address,
      signDigest: (d) => {
        const out = goodSig(d);
        out[64] = out[64] + 27;
        return out;
      },
    };
    await expect(
      signPaymentRequestWithSigner(request(), preApplied, { chainId: 1, created: CREATED }),
    ).rejects.toThrow(/must not pre-apply/);
  });

  it.each([
    ["too short", 64],
    ["too long", 66],
    ["empty", 0],
  ])("refuses a %s signature", async (_label, length) => {
    const bad: DeclarationSigner = {
      getAddress: () => wallet.address,
      signDigest: () => new Uint8Array(length),
    };
    await expect(
      signPaymentRequestWithSigner(request(), bad, { chainId: 1, created: CREATED }),
    ).rejects.toThrow(/want 65/);
  });

  it("refuses a non-Uint8Array signature", async () => {
    const bad = {
      getAddress: () => wallet.address,
      signDigest: () => "0xdeadbeef" as unknown as Uint8Array,
    } as DeclarationSigner;
    await expect(
      signPaymentRequestWithSigner(request(), bad, { chainId: 1, created: CREATED }),
    ).rejects.toThrow(/non-Uint8Array/);
  });

  it.each([
    ["not hex", "nonsense"],
    ["too short", "0x1234"],
    ["missing 0x", "f39fd6e51aad88f6f4ce6ab8827279cfffb92266"],
    ["empty", ""],
  ])("refuses a malformed address (%s) before asking for a signature", async (_l, address) => {
    let asked = false;
    const bad: DeclarationSigner = {
      getAddress: () => address,
      signDigest: (d) => {
        asked = true;
        return goodSig(d);
      },
    };
    await expect(
      signPaymentRequestWithSigner(request(), bad, { chainId: 1, created: CREATED }),
    ).rejects.toThrow(/malformed address/);
    expect(asked).toBe(false);
  });

  it.each([
    ["missing signDigest", { getAddress: () => wallet.address }],
    ["missing getAddress", { signDigest: () => new Uint8Array(65) }],
    ["empty object", {}],
    ["null", null],
  ])("refuses an incomplete signer (%s)", async (_l, signer) => {
    await expect(
      signPaymentRequestWithSigner(request(), signer as unknown as DeclarationSigner, {
        chainId: 1,
        created: CREATED,
      }),
    ).rejects.toThrow(/must implement getAddress and signDigest/);
  });

  it("propagates a signer refusal without emitting a document", async () => {
    // A custodian's policy engine declining is a normal outcome, and it must not produce a
    // half-built document.
    const refuses: DeclarationSigner = {
      getAddress: () => wallet.address,
      signDigest: () => {
        throw new Error("policy: signing denied for this payload");
      },
    };
    await expect(
      signPaymentRequestWithSigner(request(), refuses, { chainId: 1, created: CREATED }),
    ).rejects.toThrow(/policy: signing denied/);
  });

  // A signer naming an address it does not control cannot be caught at signing time — the
  // library has no way to check a claim about a key it never sees. What matters is that the
  // resulting proof does not verify, so the lie cannot travel.
  it("a signer claiming somebody else's address produces a proof that will not verify", async () => {
    const impostor = Wallet.createRandom();
    const lying: DeclarationSigner = {
      getAddress: () => impostor.address,
      signDigest: (d) => goodSig(d),
    };
    const signed = await signPaymentRequestWithSigner(request(), lying, {
      chainId: 1,
      created: CREATED,
    });

    // Signing succeeds: the claim is unverifiable here.
    expect(signed.proof.verificationMethod.toLowerCase()).toContain(
      impostor.address.toLowerCase(),
    );

    // Verification refuses it, because the recovered signer is the real key, not the claim.
    await expect(
      verifyPaymentRequest(signed as unknown as Record<string, unknown>),
    ).rejects.toThrow(/has been altered since it was signed/);
  });

  it("refuses a wallet-like object that cannot sign a raw digest", () => {
    // A JsonRpcSigner or a hardware signer has no signingKey. Failing here with a directive
    // beats failing later inside canonicalization.
    expect(() => signerFromEthersWallet({ address: wallet.address } as never)).toThrow(
      /has no signingKey/,
    );
  });

  it("signs a raw digest rather than an EIP-191 message", async () => {
    // signMessage would prefix the payload and produce a signature that does not verify as a
    // Data Integrity proof. This pins that the adapter took the raw path.
    const signed = await signPaymentRequestWithSigner(
      request(),
      signerFromEthersWallet(wallet),
      { chainId: 1, created: CREATED },
    );
    const res = await verifyPaymentRequest(signed as unknown as Record<string, unknown>);
    expect(res.signerAddress).toBe(wallet.address.toLowerCase());

    // And the counterexample: the same digest signed WITH the prefix recovers a different
    // address, so the distinction is load-bearing rather than stylistic.
    const digest = new Uint8Array(32).fill(7);
    const rawSigner = new SigningKey(KEY).sign(digest).serialized;
    const prefixed = await wallet.signMessage(digest);
    expect(prefixed).not.toBe(rawSigner);
  });
});
