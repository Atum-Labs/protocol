import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import nacl from "tweetnacl";

import { signQuote } from "./sign.js";
import { signQuoteEd25519 } from "./sign-ed25519.js";

// Mirror of the Go signFixtureDoc / verify.test.ts fixtureQuote so the base
// signer sees a well-formed quote and the only trigger under test is the
// caller-supplied verifiableCredential.
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

const sampleVC = [
  { type: ["VerifiableCredential"], issuer: "did:example:issuer" },
];

// The base signer covers quote terms only, so a non-empty verifiableCredential
// must be rejected rather than silently dropped. Both cryptosuites share the
// guard.
describe("base signer rejects caller-supplied verifiableCredential", () => {
  it("signQuote throws on a non-empty verifiableCredential", async () => {
    const wallet = Wallet.createRandom();
    const quote = {
      ...fixtureQuote(wallet.address.toLowerCase()),
      verifiableCredential: sampleVC,
    };
    await expect(signQuote(quote as never, wallet.privateKey)).rejects.toThrow(
      /does not carry verifiableCredential/
    );
  });

  it("signQuoteEd25519 throws on a non-empty verifiableCredential", async () => {
    const wallet = Wallet.createRandom();
    const { secretKey } = nacl.sign.keyPair();
    const quote = {
      ...fixtureQuote(wallet.address.toLowerCase()),
      verifiableCredential: sampleVC,
    };
    await expect(
      signQuoteEd25519(quote as never, secretKey, {
        verificationMethod: "did:pkh:solana:devnet:abc#blockchainAccountId",
      })
    ).rejects.toThrow(/does not carry verifiableCredential/);
  });
});
