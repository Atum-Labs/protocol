#!/usr/bin/env node
// gen-conformance-fixtures generates the TS-signed halves of the cross-
// language conformance fixture set:
//
//   FQ side:
//     - secp256k1-ts-signed.json
//     - ed25519-ts-signed.json
//
//   VP side:
//     - secp256k1-ts-vp.json
//     - ed25519-ts-vp.json
//     - secp256k1-ts-vp-null-issuance-date.json  (negative: verifyVP must refuse)
//     - ed25519-ts-vp-null-issuance-date.json    (negative: verifyVP must refuse)
//
//   VC-proof side:
//     - secp256k1-ts-vc-proof.json
//     - ed25519-ts-vc-proof.json
//     - {secp256k1,ed25519}-ts-vc-proof-kta-v2-{quote-awarder,merchant}.json
//
// The JWK sidecars (vc-issuer-{secp256k1,ed25519}.jwk.json) are
// single-source-of-truth and emitted only by the Go generator — both
// languages pin the same keys so re-emitting from the TS side would
// only invite drift.
//
// Pinned to the same key set + timestamp + document shape as the Go
// generator (cmd/gen-conformance-fixtures/main.go) so a verifier on
// either side can read either signer's output. The ed25519 halves
// (FQ + VP) MUST byte-match their Go counterparts — RFC 8032 is
// deterministic.
//
// Run via `npm run gen-conformance-fixtures --workspace=@atum-labs/ld-signing`
// or directly with `node scripts/gen-conformance-fixtures.mjs` from the
// package dir.

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Wallet } from "ethers";
import nacl from "tweetnacl";
import bs58 from "bs58";

// Import the built dist (so this script doesn't need a TS runner). The
// `prebuild` hook already runs copy-context.mjs; the parent `build`
// target ensures dist/ exists before this runs.
import {
  signQuote,
  signQuoteEd25519,
  signVP,
  signVPEd25519,
  signVPWithTypedDataSigner,
  signVCProofSecp256k1,
  signVCProofEd25519,
} from "../dist/lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "../../../../conformance/fixtures");

// Hardhat account #0 — well-known test key, ONLY used here to pin a
// deterministic signing identity for the fixture. Not appropriate for
// any production purpose.
const HARDHAT_PRIVKEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const PINNED_CREATED = "2026-04-01T00:00:00.000Z";

// VP-side pinned bindings. MUST exactly match the Go generator's
// constants (cmd/gen-conformance-fixtures/main.go) — drift here breaks
// the ed25519 byte-identity invariant.
const PINNED_VP_CHALLENGE = "req-fixture-1";
const PINNED_VP_DOMAIN = "did:web:settler.atum.network";
const PINNED_VC_ISSUER = "did:web:atumlabs.xyz";
const PINNED_VC_ISSUANCE_DATE = "2026-01-01T00:00:00Z";
const PINNED_VC_ID = "urn:uuid:5b5d7e0e-9d27-4f1f-a5db-3a52cfb24d2f";
const W3C_VC_V1_CONTEXT = "https://www.w3.org/2018/credentials/v1";
// known-to-atum/v1 context URL — binds the
// `KnownToAtumVerifiableCredential` type alias so jsonld.js emits the same
// canonical n-quad as Go's json-gold.
const KNOWN_TO_ATUM_V1_CONTEXT =
  "https://schemas.atum.xyz/credentials/known-to-atum/v1";
// known-to-atum/v2 context URL: v1's terms plus the quoteAwarder and
// merchant roles.
const KNOWN_TO_ATUM_V2_CONTEXT =
  "https://schemas.atum.xyz/credentials/known-to-atum/v2";
// The known-to-atum v2 fixtures carry an expirationDate, 60 days after
// issuance. MUST match the Go generator's pinnedVCExpirationDate.
const PINNED_VC_EXPIRATION_DATE = "2026-03-02T00:00:00Z";
// One credential per role v2 adds, signed under both cryptosuites. MUST
// match the Go generator's knownToAtumV2Fixtures.
const KNOWN_TO_ATUM_V2_FIXTURES = [
  { name: "kta-v2-quote-awarder", role: "quoteAwarder" },
  { name: "kta-v2-merchant", role: "merchant" },
];

// PaymentRequestEnvelope (PRE) bindings for the declarationType-set
// conformance fixtures. MUST match the Go generator's preContextURL /
// preEnvelopeType AND the canonical PRE binding consts
// (PaymentRequestEnvelope/v1/bindings/{go,typescript}/version) — drift here
// breaks the PRE ed25519 byte-identity invariant.
const PRE_CONTEXT_URL =
  "https://schemas.atum.network/declarations/PaymentRequestEnvelope/v1/context.jsonld";
const PRE_ENVELOPE_TYPE = "PaymentRequestEnvelope";
// The canonical PRE declaration context, loaded from the schema source and
// overlaid per-call (extraEnvelopeContexts) so the strict no-network loader
// resolves the PRE URL. Path: fixturesDir → declarations → PaymentRequestEnvelope.
const PRE_CONTEXT = JSON.parse(
  readFileSync(
    resolve(fixturesDir, "../../../../PaymentRequestEnvelope/v1/context.jsonld"),
    "utf-8",
  ),
);

async function main() {
  mkdirSync(fixturesDir, { recursive: true });
  await genSecp256k1();
  await genEd25519();
  await genSecp256k1VP("secp256k1-ts-vp.json", PINNED_VC_ISSUANCE_DATE);
  await genEd25519VP("ed25519-ts-vp.json", PINNED_VC_ISSUANCE_DATE);
  // Negative fixtures: the same envelopes with the credential's
  // issuanceDate set to JSON null. The holder signature verifies; the
  // verifiers on both sides must refuse the credential.
  await genSecp256k1VP("secp256k1-ts-vp-null-issuance-date.json", null);
  await genEd25519VP("ed25519-ts-vp-null-issuance-date.json", null);
  await genSecp256k1PREVP();
  await genEd25519PREVP();
  await genSecp256k1TypedPREVP();
  await genVCProofSecp256k1(buildPinnedVCBody(), "secp256k1-ts-vc-proof.json");
  await genVCProofEd25519(buildPinnedVCBody(), "ed25519-ts-vc-proof.json");
  for (const f of KNOWN_TO_ATUM_V2_FIXTURES) {
    await genKnownToAtumV2VCProofs(f);
  }
  console.log(`wrote ${11 + 2 * KNOWN_TO_ATUM_V2_FIXTURES.length} fixtures to ${fixturesDir}`);
}

async function genSecp256k1() {
  const wallet = new Wallet(HARDHAT_PRIVKEY);
  const address = wallet.address.toLowerCase();

  const doc = {
    version: "1.0",
    source_amount: "1000000",
    award_deadline: "2030-01-01T00:00:00Z",
    source: { id: "eip155:1/erc20:0xaaa", account: "eip155:1:0x1" },
    destination: { id: "eip155:1/erc20:0xbbb", account: "eip155:1:0x2" },
    settler_address: address,
    payment_request_json: '{"request_id":"req-1"}',
  };

  const signed = await signQuote(doc, HARDHAT_PRIVKEY, {
    chainId: 1,
    created: PINNED_CREATED,
  });
  const sortedSigned = sortKeysRecursively(signed);
  const out = JSON.stringify(sortedSigned) + "\n";
  writeFileSync(resolve(fixturesDir, "secp256k1-ts-signed.json"), out);
}

async function genEd25519() {
  // 32 zero bytes as the seed → deterministic keypair. Matches the Go
  // generator's `var seed [32]byte`.
  const seed = new Uint8Array(32);
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const pub = keyPair.publicKey;
  const priv = keyPair.secretKey; // 64-byte expanded form, what tweetnacl uses
  const pubBase58 = bs58.encode(pub);

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

  const signed = await signQuoteEd25519(doc, priv, {
    verificationMethod: `did:pkh:solana:devnet:${pubBase58}#blockchainAccountId`,
    created: PINNED_CREATED,
  });

  const sortedSigned = sortKeysRecursively(signed);
  const out = JSON.stringify(sortedSigned) + "\n";
  writeFileSync(resolve(fixturesDir, "ed25519-ts-signed.json"), out);
}

// issuanceDate is the embedded credential's issuanceDate (null writes JSON
// null).
async function genSecp256k1VP(fileName, issuanceDate) {
  const wallet = new Wallet(HARDHAT_PRIVKEY);
  const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;

  const signed = await signVP(pinnedVCsFor(holder, "EcdsaSecp256k1RecoverySignature2020", issuanceDate), HARDHAT_PRIVKEY, {
    holder,
    verificationMethod: `${holder}#blockchainAccountId`,
    challenge: PINNED_VP_CHALLENGE,
    domain: PINNED_VP_DOMAIN,
    created: PINNED_CREATED,
  });
  const sortedSigned = sortKeysRecursively(signed);
  const out = JSON.stringify(sortedSigned) + "\n";
  writeFileSync(resolve(fixturesDir, fileName), out);
}

// issuanceDate is the embedded credential's issuanceDate (null writes JSON
// null).
async function genEd25519VP(fileName, issuanceDate) {
  const seed = new Uint8Array(32);
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const pub = keyPair.publicKey;
  const priv = keyPair.secretKey; // 64-byte expanded form (matches Go's ed25519.NewKeyFromSeed output)
  const pubBase58 = bs58.encode(pub);
  const holder = `did:pkh:solana:devnet:${pubBase58}`;

  const signed = await signVPEd25519(pinnedVCsFor(holder, "Ed25519Signature2020", issuanceDate), priv, {
    holder,
    verificationMethod: `${holder}#blockchainAccountId`,
    challenge: PINNED_VP_CHALLENGE,
    domain: PINNED_VP_DOMAIN,
    created: PINNED_CREATED,
  });
  const sortedSigned = sortKeysRecursively(signed);
  const out = JSON.stringify(sortedSigned) + "\n";
  writeFileSync(resolve(fixturesDir, fileName), out);
}

// genSecp256k1PREVP signs a PaymentRequestEnvelope (the originator-side
// holder VP) under EcdsaSecp256k1RecoverySignature2020. Same
// shape as genSecp256k1VP but threads the declarationType-set seam —
// declarationType=PaymentRequestEnvelope, envelopeContextUrl=PRE URL, and
// extraEnvelopeContexts overlaying the canonical PRE context onto the
// strict loader. The Go verifier reads this with ExpectedDeclarationType +
// ExtraEnvelopeContexts and MUST accept it.
async function genSecp256k1PREVP() {
  const wallet = new Wallet(HARDHAT_PRIVKEY);
  const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;

  const signed = await signVP(pinnedVCsFor(holder, "EcdsaSecp256k1RecoverySignature2020", PINNED_VC_ISSUANCE_DATE), HARDHAT_PRIVKEY, {
    holder,
    verificationMethod: `${holder}#blockchainAccountId`,
    challenge: PINNED_VP_CHALLENGE,
    domain: PINNED_VP_DOMAIN,
    created: PINNED_CREATED,
    declarationType: PRE_ENVELOPE_TYPE,
    envelopeContextUrl: PRE_CONTEXT_URL,
    extraEnvelopeContexts: { [PRE_CONTEXT_URL]: PRE_CONTEXT },
  });
  const sortedSigned = sortKeysRecursively(signed);
  const out = JSON.stringify(sortedSigned) + "\n";
  writeFileSync(resolve(fixturesDir, "secp256k1-ts-pre-vp.json"), out);
}

// genSecp256k1TypedPREVP signs the same PaymentRequestEnvelope as genSecp256k1PREVP, in the typed
// form a payer's wallet produces, through ethers' Wallet.signTypedData (what eth_signTypedData_v4
// computes): an EIP-712 signature over PaymentRequestEnvelopeProof{proofHash, docHash}. The Go
// verifier MUST accept it where it accepts that form, and refuse it otherwise.
async function genSecp256k1TypedPREVP() {
  const wallet = new Wallet(HARDHAT_PRIVKEY);
  const holder = `did:pkh:eip155:1:${wallet.address.toLowerCase()}`;

  const signed = await signVPWithTypedDataSigner(pinnedVCsFor(holder, "EcdsaSecp256k1RecoverySignature2020", PINNED_VC_ISSUANCE_DATE), wallet, {
    holder,
    verificationMethod: `${holder}#blockchainAccountId`,
    challenge: PINNED_VP_CHALLENGE,
    domain: PINNED_VP_DOMAIN,
    created: PINNED_CREATED,
    declarationType: PRE_ENVELOPE_TYPE,
    envelopeContextUrl: PRE_CONTEXT_URL,
    extraEnvelopeContexts: { [PRE_CONTEXT_URL]: PRE_CONTEXT },
  });
  const out = JSON.stringify(sortKeysRecursively(signed)) + "\n";
  writeFileSync(resolve(fixturesDir, "secp256k1-typed-ts-pre-vp.json"), out);
}

// genEd25519PREVP signs a PaymentRequestEnvelope under Ed25519Signature2020.
// RFC 8032 deterministic — the Go-generated counterpart MUST byte-match
// (pinned by TestConformance_Ed25519PREVPFixturesAreByteIdentical on both
// sides), which is the strongest proof the declarationType-set canonical
// form agrees across languages.
async function genEd25519PREVP() {
  const seed = new Uint8Array(32);
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const pub = keyPair.publicKey;
  const priv = keyPair.secretKey; // 64-byte expanded form (matches Go's ed25519.NewKeyFromSeed output)
  const pubBase58 = bs58.encode(pub);
  const holder = `did:pkh:solana:devnet:${pubBase58}`;

  const signed = await signVPEd25519(pinnedVCsFor(holder, "Ed25519Signature2020", PINNED_VC_ISSUANCE_DATE), priv, {
    holder,
    verificationMethod: `${holder}#blockchainAccountId`,
    challenge: PINNED_VP_CHALLENGE,
    domain: PINNED_VP_DOMAIN,
    created: PINNED_CREATED,
    declarationType: PRE_ENVELOPE_TYPE,
    envelopeContextUrl: PRE_CONTEXT_URL,
    extraEnvelopeContexts: { [PRE_CONTEXT_URL]: PRE_CONTEXT },
  });
  const sortedSigned = sortKeysRecursively(signed);
  const out = JSON.stringify(sortedSigned) + "\n";
  writeFileSync(resolve(fixturesDir, "ed25519-ts-pre-vp.json"), out);
}

// genVCProofSecp256k1 signs vcBody under
// EcdsaSecp256k1RecoverySignature2020 with the pinned Hardhat key and
// writes it to fixturesDir/fileName. Cross-language fixture: the Go
// verifier reads the file and verifies it via VerifyVCProof + a mock
// resolver returning the JWK from vc-issuer-secp256k1.jwk.json (single
// source of truth, emitted by the Go generator).
//
// Cross-language byte equality is NOT asserted for the secp256k1
// fixtures. The signature is deterministic today: ethers'
// SigningKey.sign and go-ethereum's crypto.Sign both derive the nonce
// per RFC 6979, so each file regenerates byte-identically and matches
// its Go counterpart. ECDSA promises no such equality across
// implementations, though, so each language generates its own and the
// other side verifies it and checks the recovered signer (see
// conformance/README.md, "Determinism invariants").
async function genVCProofSecp256k1(vcBody, fileName) {
  const signed = await signVCProofSecp256k1(vcBody, HARDHAT_PRIVKEY, {
    verificationMethod: `${PINNED_VC_ISSUER}#key-1`,
    proofPurpose: "assertionMethod",
    created: PINNED_VC_ISSUANCE_DATE,
  });
  const out = JSON.stringify(sortKeysRecursively(signed)) + "\n";
  writeFileSync(resolve(fixturesDir, fileName), out);
}

// genVCProofEd25519 signs vcBody under Ed25519Signature2020 with the
// RFC 8032 zero-seed key and writes it to fixturesDir/fileName. Ed25519
// IS deterministic — the Go counterpart's proof.proofValue MUST
// byte-match.
async function genVCProofEd25519(vcBody, fileName) {
  const seed = new Uint8Array(32);
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const priv = keyPair.secretKey;

  const signed = await signVCProofEd25519(vcBody, priv, {
    verificationMethod: `${PINNED_VC_ISSUER}#key-1`,
    proofPurpose: "assertionMethod",
    created: PINNED_VC_ISSUANCE_DATE,
  });
  const out = JSON.stringify(sortKeysRecursively(signed)) + "\n";
  writeFileSync(resolve(fixturesDir, fileName), out);
}

// genKnownToAtumV2VCProofs mints the two signed credentials for one
// known-to-atum v2 role, one per cryptosuite, through the v1 VC-proof
// generators, so they share the pinned keys, issuer and dates. The Go
// verifier reads them; the ed25519 one MUST byte-match its Go counterpart.
async function genKnownToAtumV2VCProofs({ name, role }) {
  await genVCProofSecp256k1(
    buildKnownToAtumV2VCBody(name, role),
    `secp256k1-ts-vc-proof-${name}.json`,
  );
  await genVCProofEd25519(
    buildKnownToAtumV2VCBody(name, role),
    `ed25519-ts-vc-proof-${name}.json`,
  );
}

// buildKnownToAtumV2VCBody is the unsigned credential for a known-to-atum
// v2 role: the shape the issuer emits, with an expirationDate as every
// credential carries. MUST mirror the Go generator's
// buildKnownToAtumV2VCBody.
function buildKnownToAtumV2VCBody(name, role) {
  return {
    "@context": [W3C_VC_V1_CONTEXT, KNOWN_TO_ATUM_V2_CONTEXT],
    id: `urn:uuid:vc-${name}-conformance`,
    type: ["VerifiableCredential", "KnownToAtumVerifiableCredential"],
    issuer: PINNED_VC_ISSUER,
    issuanceDate: PINNED_VC_ISSUANCE_DATE,
    expirationDate: PINNED_VC_EXPIRATION_DATE,
    credentialSubject: {
      id: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      role,
    },
  };
}

// buildPinnedVCBody returns the unsigned VC the two VC-proof generators
// share. MUST exactly mirror the Go generator's buildPinnedVCBody —
// drift here breaks the ed25519 byte-identity invariant on the VC-proof
// halves. Includes the known-to-atum context URL so the
// `KnownToAtumVerifiableCredential` type alias binds to a stable IRI on both
// json-gold and jsonld.js.
function buildPinnedVCBody() {
  return {
    "@context": [W3C_VC_V1_CONTEXT, KNOWN_TO_ATUM_V1_CONTEXT],
    id: "urn:uuid:vc-1737-conformance",
    type: ["VerifiableCredential", "KnownToAtumVerifiableCredential"],
    issuer: PINNED_VC_ISSUER,
    issuanceDate: PINNED_VC_ISSUANCE_DATE,
    credentialSubject: {
      id: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      role: "settler",
    },
  };
}

// pinnedVCsFor returns the canonical single-VC slice every VP fixture
// embeds. MUST exactly mirror the Go generator's pinnedVCsFor — drift
// here breaks the ed25519 byte-identity invariant on the VP halves.
// Includes the known-to-atum context URL + the
// `KnownToAtumVerifiableCredential` type alias (the alias binds to a stable IRI
// on both libraries, so json-gold + jsonld.js emit the same canonical
// n-quad). Earlier this was single-type to dodge the
// cross-language divergence; that workaround is now removed.
//
// issuanceDate is the VC's issuanceDate member: PINNED_VC_ISSUANCE_DATE for
// the fixtures that verify, null for the negative fixtures. MUST match the Go
// generator's pinnedVCsFor. The stub proof's created stays
// PINNED_VC_ISSUANCE_DATE either way.
function pinnedVCsFor(holder, cryptosuite, issuanceDate) {
  return [
    {
      "@context": [W3C_VC_V1_CONTEXT, KNOWN_TO_ATUM_V1_CONTEXT],
      id: PINNED_VC_ID,
      type: ["VerifiableCredential", "KnownToAtumVerifiableCredential"],
      issuer: PINNED_VC_ISSUER,
      issuanceDate,
      credentialSubject: {
        id: holder,
        role: "settler",
      },
      proof: {
        type: cryptosuite,
        created: PINNED_VC_ISSUANCE_DATE,
        verificationMethod: `${PINNED_VC_ISSUER}#key-1`,
        proofPurpose: "assertionMethod",
      },
    },
  ];
}

// sortKeysRecursively normalizes the JSON object so the on-disk output
// has deterministic key order. Go's json.Marshal sorts map keys
// alphabetically; JS object iteration preserves insertion order. Forcing
// alphabetical sort here makes the TS-signed fixture diff-friendly
// against the Go-signed one (for the ed25519 case where the signed
// bytes ARE supposed to match).
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
