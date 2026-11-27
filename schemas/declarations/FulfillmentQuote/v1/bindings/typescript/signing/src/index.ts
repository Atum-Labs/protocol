#!/usr/bin/env node
// CLI: sign-quote [--ed25519] <key>
//
// Generates a sample FulfillmentQuote, signs it, and prints the signed
// document to stdout. Two modes:
//   - default (secp256k1): <key> is a hex-encoded secp256k1 private key.
//     Signs with EcdsaSecp256k1RecoverySignature2020 (detached JWS).
//   - --ed25519:           <key> is the base58-encoded 64-byte ed25519
//                          secret key (Solana Keypair.secretKey form,
//                          base58 here for CLI ergonomics).
//                          Signs with Ed25519Signature2020 (multibase z-base58btc proofValue).
//
// Intended for ad-hoc debugging. A cross-language harness pipes signed
// output into the Go verifier's recover-signer binary; this CLI is a
// producer-only convenience.
import { signQuote } from "./sign.js";
import { signQuoteEd25519 } from "./sign-ed25519.js";
import type { FulfillmentQuote } from "@atum-labs/schema-declarations/FulfillmentQuote/v1/bindings/typescript";
import { VERSION } from "@atum-labs/schema-declarations/FulfillmentQuote/v1/bindings/typescript/version";

function createSampleQuote(settlerAddress: string): FulfillmentQuote {
  return {
    version: VERSION,
    source_amount: "1000000",
    award_deadline: new Date(Date.now() + 3600000).toISOString(),
    source: {
      id: "USDC",
      account: "eip155:1:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    },
    destination: {
      id: "USDC",
      account: "eip155:137:0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    },
    payment_request_json: JSON.stringify({ id: "test-payment-request" }),
    settler_address: settlerAddress,
  };
}

async function signSecp256k1(privateKey: string): Promise<unknown> {
  const normalizedKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const { Wallet } = await import("ethers");
  const wallet = new Wallet(normalizedKey);
  const quote = createSampleQuote(wallet.address.toLowerCase());
  return signQuote(quote, normalizedKey);
}

async function signEd25519FromBase58Secret(secretBase58: string): Promise<unknown> {
  const [{ default: bs58 }, naclModule] = await Promise.all([
    import("bs58"),
    import("tweetnacl"),
  ]);
  const nacl = naclModule.default;
  const secretKey = bs58.decode(secretBase58);
  if (secretKey.length !== 64) {
    throw new Error(
      `Ed25519 secret key must be 64 bytes after base58-decode (got ${secretKey.length}); pass the full Solana Keypair secret`
    );
  }
  // Sanity-check that the secret/public halves agree before signing.
  // Producer-side errors (e.g. concatenated random bytes) should fail
  // here, not silently produce a signature for the wrong key.
  const derivedPub = nacl.sign.keyPair.fromSecretKey(secretKey).publicKey;
  const pubBase58 = bs58.encode(Buffer.from(derivedPub));
  const quote = createSampleQuote(pubBase58);
  return signQuoteEd25519(quote, secretKey, {
    verificationMethod: `did:pkh:solana:devnet:${pubBase58}#blockchainAccountId`,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const ed25519Idx = args.indexOf("--ed25519");
  const isEd25519 = ed25519Idx >= 0;
  if (isEd25519) {
    args.splice(ed25519Idx, 1);
  }
  const key = args[0];

  if (!key) {
    console.error("Usage: sign-quote [--ed25519] <key>");
    console.error("  default (secp256k1): hex-encoded private key (with or without 0x prefix)");
    console.error("  --ed25519:           base58-encoded 64-byte ed25519 secret key (Solana Keypair format)");
    process.exit(1);
  }

  const signed = isEd25519
    ? await signEd25519FromBase58Secret(key)
    : await signSecp256k1(key);

  console.log(JSON.stringify(signed, null, 2));
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("Error:", msg);
  process.exit(1);
});
