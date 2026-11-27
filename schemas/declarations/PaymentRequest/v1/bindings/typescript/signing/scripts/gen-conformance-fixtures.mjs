#!/usr/bin/env node
// gen-conformance-fixtures generates the TS-signed halves of the cross-
// language conformance fixture set for the inner PaymentRequest signer:
//
//   - secp256k1-ts-signed.json
//   - ed25519-ts-signed.json
//   - ed25519-stellar-ts-signed.json
//   - secp256k1-typed-ts-signed.json
//
// Pinned to the same key set + timestamp + document shape as the Go
// generator (cmd/gen-conformance-fixtures/main.go) so a verifier on
// either side can read either signer's output. The ed25519 half MUST
// byte-match its Go counterpart — RFC 8032 is deterministic.
//
// Run via `npm run gen-conformance-fixtures --workspace=@atum-labs/payment-request-ld-signing`
// or directly with `node scripts/gen-conformance-fixtures.mjs` from the
// package dir.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Wallet } from "ethers";
import nacl from "tweetnacl";
import bs58 from "bs58";

// Import the built dist (so this script doesn't need a TS runner). The
// `prebuild` hook already runs copy-context.mjs; the parent `build`
// target ensures dist/ exists before this runs.
import {
  signPaymentRequest,
  signPaymentRequestEd25519,
  signPaymentRequestWithTypedDataSigner,
} from "../dist/lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../../../../conformance/fixtures");

// Hardhat account #0 — well-known test key, ONLY used here to pin a
// deterministic signing identity for the fixture. Not appropriate for any
// production purpose.
const HARDHAT_PRIVKEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const PINNED_CREATED = "2026-04-01T00:00:00.000Z";

// pinnedSecp256k1Doc MUST exactly mirror the Go generator's
// pinnedSecp256k1Doc — drift between the two unsigned docs changes the
// canonical n-quads and breaks cross-language verification.
function pinnedSecp256k1Doc(senderAddr) {
  return {
    version: "1.0",
    request_id: "req-pr-secp-1",
    source: {
      asset_identifier: "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A",
      account: senderAddr,
    },
    destination: [
      {
        asset_identifier: "eip155:1/erc20:0xbbb",
        account: "0x0000000000000000000000000000000000000002",
      },
    ],
    fulfillment_amount: "1000000",
    quote_deadline: "2030-01-01T00:00:00Z",
    fulfillment_deadline: "2030-01-02T00:00:00Z",
    escrow_contract_address: "0x0000000000000000000000000000000000000003",
    fulfillment_verifier: {
      account: "0x0000000000000000000000000000000000000004",
      endpoint: "https://veri-fill.example.com",
    },
    sender_auth: {
      message_scheme: "EVM_PERMIT2",
      signed_messages: [
        {
          message:
            "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
          message_prehash: "{}",
          signature: "0xabcdef1234567890",
        },
      ],
    },
  };
}

// pinnedEd25519Doc MUST exactly mirror the Go generator's pinnedEd25519Doc.
function pinnedEd25519Doc(senderAddr) {
  return {
    version: "1.0",
    request_id: "req-pr-sol-1",
    source: {
      asset_identifier:
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/spltoken:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      account: senderAddr,
    },
    destination: [
      {
        asset_identifier: "eip155:1/erc20:0xbbb",
        account: "0x0000000000000000000000000000000000000002",
      },
    ],
    fulfillment_amount: "1000000",
    quote_deadline: "2030-01-01T00:00:00Z",
    fulfillment_deadline: "2030-01-02T00:00:00Z",
    escrow_contract_address: "11111111111111111111111111111111",
    fulfillment_verifier: {
      account: "0x0000000000000000000000000000000000000004",
      endpoint: "https://veri-fill.example.com",
    },
    sender_auth: {
      message_scheme: "SOLANA",
      signed_messages: [
        {
          message: "0xdeadbeef",
          message_prehash: "{}",
          signature: "0xfeedface",
        },
      ],
    },
  };
}

// pinnedStellarDoc MUST exactly mirror the Go generator's pinnedStellarDoc.
function pinnedStellarDoc(senderAddr) {
  return {
    version: "1.0",
    request_id: "req-pr-stellar-1",
    source: {
      asset_identifier: "stellar:testnet/sep41:CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
      account: senderAddr,
    },
    destination: [
      {
        asset_identifier: "eip155:1/erc20:0xbbb",
        account: "0x0000000000000000000000000000000000000002",
      },
    ],
    fulfillment_amount: "1000000",
    quote_deadline: "2030-01-01T00:00:00Z",
    fulfillment_deadline: "2030-01-02T00:00:00Z",
    escrow_contract_address: "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5",
    fulfillment_verifier: {
      account: "0x0000000000000000000000000000000000000004",
      endpoint: "https://veri-fill.example.com",
    },
    sender_auth: {
      message_scheme: "STELLAR",
      signed_messages: [
        {
          message: "0xdeadbeef",
          message_prehash: "{}",
          signature: "0xfeedface",
        },
      ],
    },
  };
}

async function main() {
  mkdirSync(fixturesDir, { recursive: true });
  await genSecp256k1();
  await genEd25519();
  await genEd25519Stellar();
  await genSecp256k1Typed();
  console.log(`wrote 4 fixtures to ${fixturesDir}`);
}

// The all-zero seed of the Solana fixture; its account is the shared strkey vectors' GA5WUJ54... entry.
async function genEd25519Stellar() {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32));
  const account = "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH";
  const signed = await signPaymentRequestEd25519(pinnedStellarDoc(account), kp.secretKey, {
    verificationMethod: `did:pkh:stellar:testnet:${account}#blockchainAccountId`,
    created: PINNED_CREATED,
  });
  const out = JSON.stringify(sortKeysRecursively(signed)) + "\n";
  writeFileSync(resolve(fixturesDir, "ed25519-stellar-ts-signed.json"), out);
}

async function genSecp256k1() {
  const wallet = new Wallet(HARDHAT_PRIVKEY);
  const address = wallet.address.toLowerCase();

  const doc = pinnedSecp256k1Doc(address);

  const signed = await signPaymentRequest(doc, HARDHAT_PRIVKEY, {
    chainId: 1,
    created: PINNED_CREATED,
  });
  const out = JSON.stringify(sortKeysRecursively(signed)) + "\n";
  writeFileSync(resolve(fixturesDir, "secp256k1-ts-signed.json"), out);
}

// genSecp256k1Typed signs the secp256k1 document in the typed form a wallet produces, through
// ethers' Wallet.signTypedData (what eth_signTypedData_v4 computes): an EIP-712 signature over
// PaymentRequestProof{proofHash, docHash}. The Go verifier MUST recover Hardhat #0 from it.
async function genSecp256k1Typed() {
  const wallet = new Wallet(HARDHAT_PRIVKEY);
  const signed = await signPaymentRequestWithTypedDataSigner(
    pinnedSecp256k1Doc(wallet.address.toLowerCase()),
    wallet,
    { chainId: 1, created: PINNED_CREATED }
  );
  const out = JSON.stringify(sortKeysRecursively(signed)) + "\n";
  writeFileSync(resolve(fixturesDir, "secp256k1-typed-ts-signed.json"), out);
}

async function genEd25519() {
  // 32 zero bytes as the seed → deterministic keypair. Matches the Go
  // generator's `var seed [32]byte`.
  const seed = new Uint8Array(32);
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const pub = keyPair.publicKey;
  const priv = keyPair.secretKey; // 64-byte expanded form, what tweetnacl uses
  const pubBase58 = bs58.encode(pub);

  const doc = pinnedEd25519Doc(pubBase58);

  const signed = await signPaymentRequestEd25519(doc, priv, {
    verificationMethod: `did:pkh:solana:devnet:${pubBase58}#blockchainAccountId`,
    created: PINNED_CREATED,
  });

  const out = JSON.stringify(sortKeysRecursively(signed)) + "\n";
  writeFileSync(resolve(fixturesDir, "ed25519-ts-signed.json"), out);
}

// sortKeysRecursively normalizes the JSON object so the on-disk output has
// deterministic key order. Go's json.Marshal sorts map keys
// alphabetically; JS object iteration preserves insertion order. Forcing
// alphabetical sort here makes the TS-signed fixture diff-friendly against
// the Go-signed one (for the ed25519 case where the signed bytes ARE
// supposed to match).
function sortKeysRecursively(value) {
  if (Array.isArray(value)) return value.map(sortKeysRecursively);
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysRecursively(value[key]);
    }
    return sorted;
  }
  return value;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
