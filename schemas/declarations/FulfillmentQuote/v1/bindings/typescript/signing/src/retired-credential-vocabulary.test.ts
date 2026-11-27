// Credentials signed before the credential contexts moved off
// schemas.atum.network. Mirror of the Go package's
// retired_credential_vocabulary_test.go, reading the same legacy testdata.
//
// The move changed both the known-to-atum context URL and the vocabulary its
// terms expand to (the kta: prefix). A signature covers the vocabulary and not
// the URL: URDNA2015 writes term IRIs into the canonical N-Quads, never a
// context URL. These tests pin the move from both sides:
//
//   - A credential that still names the retired URL is refused as an unknown
//     context, before any signature is checked.
//   - A credential whose URL is rewritten to the current one resolves, but its
//     signature covers the retired term IRIs, so it fails on the signature.
//     For secp256k1 the tests also recover the signer and check it is NOT the
//     signer of record. Recovery over a changed digest returns a valid-looking
//     wrong address, not an error, so a rejection alone cannot tell this apart
//     from any other failure.
//
// Both rest on a positive control: under the retired context document each
// legacy credential still verifies, in this language too. That proves the
// Go-signed testdata is intact, and that the failures come from the
// vocabulary alone.
//
// The testdata lives in the Go module (go/signing/testdata/legacy-atum-network)
// because that module's tests must find it inside their own directory. It is a
// record, not generated output; never regenerate it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { SigningKey } from "ethers";
import nacl from "tweetnacl";
import {
  decodeEd25519ProofValue,
  recoverSecp256k1ProofSigner,
  UnknownContextError,
} from "@atum-labs/ld-data-integrity";

import { hashQuote, type Cryptosuite, type HashResult } from "./hash.js";
import { parseDetachedJws } from "./jws.js";
import {
  verifyVCProof,
  VPVCProofError,
  type IssuerKeyResolver,
} from "./verify-vc.js";
import { verifyVP, type VerifyVPOptions } from "./verify-vp.js";
import {
  ED25519_2020_CONTEXT_URL,
  FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
  KNOWN_TO_ATUM_V1_CONTEXT_URL,
  SECP256K1_RECOVERY_CONTEXT_URL,
} from "./canonicalize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const legacyDir = resolve(__dirname, "../../../go/signing/testdata/legacy-atum-network");

const RETIRED_KNOWN_TO_ATUM_CONTEXT_URL =
  "https://schemas.atum.network/credentials/known-to-atum/v1";
const RETIRED_KYC_CONTEXT_URL = "https://schemas.atum.network/credentials/kyc/v1";
const RETIRED_SENDER_COMPLIANCE_CONTEXT_URL =
  "https://schemas.atum.network/credentials/sender-compliance/v1";

const ISSUER_KEY_ID = "did:web:atumlabs.xyz#key-1";
const HOLDER_SECP256K1 = "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const HOLDER_ED25519 = "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS";

// Hardhat account #0: the conformance generators' pinned secp256k1 key, which
// signed both the legacy credential and the legacy presentation.
const HARDHAT_PRIVKEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const HARDHAT_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

// The RFC 8032 zero-seed key: the generators' pinned ed25519 issuer and holder.
const ED25519_PUBLIC_KEY = nacl.sign.keyPair.fromSeed(new Uint8Array(32)).publicKey;

function readLegacy(name: string): string {
  return readFileSync(resolve(legacyDir, name), "utf-8");
}

// The retired known-to-atum URL, registered with the context document the
// legacy credentials were signed under.
function legacyContexts(): Record<string, unknown> {
  return {
    [RETIRED_KNOWN_TO_ATUM_CONTEXT_URL]: JSON.parse(readLegacy("known-to-atum-v1.jsonld")),
  };
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function legacyIssuerResolver(cryptosuite: Cryptosuite): IssuerKeyResolver {
  let publicKeyJwk: Record<string, unknown>;
  if (cryptosuite === "EcdsaSecp256k1RecoverySignature2020") {
    const pub = Buffer.from(new SigningKey(HARDHAT_PRIVKEY).publicKey.slice(4), "hex");
    publicKeyJwk = {
      kty: "EC",
      crv: "secp256k1",
      x: base64url(pub.subarray(0, 32)),
      y: base64url(pub.subarray(32, 64)),
    };
  } else {
    publicKeyJwk = { kty: "OKP", crv: "Ed25519", x: base64url(ED25519_PUBLIC_KEY) };
  }
  return {
    resolve: async () => [{ id: ISSUER_KEY_ID, type: "JsonWebKey2020", publicKeyJwk }],
  };
}

// Replaces the one occurrence of the retired known-to-atum URL. Throws if
// there is not exactly one, so a change to the testdata cannot make a rewrite
// silently do nothing.
function swapContextUrl(raw: string, to: string): string {
  const from = `"${RETIRED_KNOWN_TO_ATUM_CONTEXT_URL}"`;
  const n = raw.split(from).length - 1;
  if (n !== 1) {
    throw new Error(`legacy testdata names ${RETIRED_KNOWN_TO_ATUM_CONTEXT_URL} ${n} times, want 1`);
  }
  return raw.replace(from, `"${to}"`);
}

// The substitution a careless migration (or an attacker) would make: point a
// legacy credential at the current context URL and leave the signed content
// alone.
function rewriteToCurrentContext(raw: string): string {
  return swapContextUrl(raw, KNOWN_TO_ATUM_V1_CONTEXT_URL);
}

function withoutProof(doc: Record<string, unknown>): {
  body: Record<string, unknown>;
  proof: Record<string, unknown>;
} {
  const { proof, ...body } = doc;
  return { body, proof: proof as Record<string, unknown> };
}

// The signing input verifyVCProof checks a credential's proof against.
async function vcSigningInput(
  raw: string,
  extraEnvelopeContexts?: Record<string, unknown>
): Promise<{ hashes: HashResult; proof: Record<string, unknown> }> {
  const { body, proof } = withoutProof(JSON.parse(raw) as Record<string, unknown>);
  const type = proof.type as Cryptosuite;
  const hashes = await hashQuote(body, {
    cryptosuite: type,
    proofOptions: {
      type,
      created: proof.created as string,
      verificationMethod: proof.verificationMethod as string,
      proofPurpose: "assertionMethod",
    },
    keepVerifiableCredential: false,
    proofContext: proof["@context"],
    extraEnvelopeContexts,
  });
  return { hashes, proof };
}

// The signing input verifyVP checks a holder proof against.
async function vpSigningInput(
  raw: string,
  extraEnvelopeContexts?: Record<string, unknown>
): Promise<{ hashes: HashResult; proof: Record<string, unknown> }> {
  const { body, proof } = withoutProof(JSON.parse(raw) as Record<string, unknown>);
  const type = proof.type as Cryptosuite;
  const suiteContext =
    type === "Ed25519Signature2020" ? ED25519_2020_CONTEXT_URL : SECP256K1_RECOVERY_CONTEXT_URL;
  const hashes = await hashQuote(body, {
    cryptosuite: type,
    proofOptions: {
      type,
      created: proof.created as string,
      verificationMethod: proof.verificationMethod as string,
      proofPurpose: proof.proofPurpose as string,
      challenge: proof.challenge as string,
      domain: proof.domain as string,
    },
    keepVerifiableCredential: true,
    proofContext: proof["@context"] ?? [FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL, suiteContext],
    extraEnvelopeContexts,
  });
  return { hashes, proof };
}

// Recovers the secp256k1 signer the way the verifiers do. Recovery itself
// succeeds over a changed digest; it yields a different address.
function recoverSigner(hashes: HashResult, proof: Record<string, unknown>): string {
  const { signature } = parseDetachedJws(proof.jws as string);
  return recoverSecp256k1ProofSigner(
    hashes,
    signature,
    (a) => a.toLowerCase() === HARDHAT_ADDRESS
  ).toLowerCase();
}

function ed25519ProofVerifies(hashes: HashResult, proof: Record<string, unknown>): boolean {
  const signature = decodeEd25519ProofValue(proof.proofValue as string);
  return nacl.sign.detached.verify(hashes.signingInput, signature, ED25519_PUBLIC_KEY);
}

function vpOptions(holder: string): VerifyVPOptions {
  return {
    expectedChallenge: "req-fixture-1",
    expectedDomain: "did:web:settler.atum.network",
    expectedHolder: holder,
    now: new Date("2026-04-01T00:00:30Z"),
    maxProofAgeMs: 60 * 60 * 1000,
    maxFutureSkewMs: 60 * 60 * 1000,
  };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection, but the call resolved");
}

function expectRefusedAsUnknownContext(err: unknown, url: string): void {
  expect(err).toBeInstanceOf(UnknownContextError);
  expect((err as UnknownContextError).url).toBe(url);
  expect(
    err instanceof VPVCProofError && err.reason === "signatureInvalid",
    "refused on the signature; the retired context must be refused before any signature is checked"
  ).toBe(false);
}

describe("legacy credentials: positive control under the retired context", () => {
  it("secp256k1 credential recovers its issuer", async () => {
    const { hashes, proof } = await vcSigningInput(
      readLegacy("secp256k1-go-vc-proof.json"),
      legacyContexts()
    );
    expect(recoverSigner(hashes, proof)).toBe(HARDHAT_ADDRESS);
  });

  it("ed25519 credential verifies", async () => {
    const { hashes, proof } = await vcSigningInput(
      readLegacy("ed25519-go-vc-proof.json"),
      legacyContexts()
    );
    expect(ed25519ProofVerifies(hashes, proof)).toBe(true);
  });

  for (const [name, file, holder] of [
    ["secp256k1", "secp256k1-go-vp.json", HOLDER_SECP256K1],
    ["ed25519", "ed25519-go-vp.json", HOLDER_ED25519],
  ] as const) {
    it(`${name} presentation verifies`, async () => {
      const raw = readLegacy(file);
      const res = await verifyVP(raw, {
        ...vpOptions(holder),
        extraEnvelopeContexts: legacyContexts(),
      });
      expect(res.holder).toBe(holder);

      // The rewrite tests read the holder signature through vpSigningInput,
      // so it must rebuild the input the holder signed: under the retired
      // context it gives the holder back.
      const { hashes, proof } = await vpSigningInput(raw, legacyContexts());
      if (name === "secp256k1") {
        expect(recoverSigner(hashes, proof)).toBe(HARDHAT_ADDRESS);
      } else {
        expect(ed25519ProofVerifies(hashes, proof)).toBe(true);
      }
    });
  }
});

describe("legacy credentials: the retired credential contexts are unknown contexts", () => {
  const secp = readLegacy("secp256k1-go-vc-proof.json");
  for (const [name, raw, suite, url] of [
    [
      "known-to-atum, the legacy secp256k1 credential as signed",
      secp,
      "EcdsaSecp256k1RecoverySignature2020",
      RETIRED_KNOWN_TO_ATUM_CONTEXT_URL,
    ],
    [
      "known-to-atum, the legacy ed25519 credential as signed",
      readLegacy("ed25519-go-vc-proof.json"),
      "Ed25519Signature2020",
      RETIRED_KNOWN_TO_ATUM_CONTEXT_URL,
    ],
    [
      "kyc",
      swapContextUrl(secp, RETIRED_KYC_CONTEXT_URL),
      "EcdsaSecp256k1RecoverySignature2020",
      RETIRED_KYC_CONTEXT_URL,
    ],
    [
      "sender-compliance",
      swapContextUrl(secp, RETIRED_SENDER_COMPLIANCE_CONTEXT_URL),
      "EcdsaSecp256k1RecoverySignature2020",
      RETIRED_SENDER_COMPLIANCE_CONTEXT_URL,
    ],
  ] as const) {
    it(`verifyVCProof refuses ${name}`, async () => {
      const err = await rejection(
        verifyVCProof(JSON.parse(raw) as Record<string, unknown>, legacyIssuerResolver(suite))
      );
      expectRefusedAsUnknownContext(err, url);
    });
  }

  for (const [name, file, holder] of [
    ["secp256k1", "secp256k1-go-vp.json", HOLDER_SECP256K1],
    ["ed25519", "ed25519-go-vp.json", HOLDER_ED25519],
  ] as const) {
    it(`verifyVP refuses the legacy ${name} presentation`, async () => {
      const err = await rejection(verifyVP(readLegacy(file), vpOptions(holder)));
      expectRefusedAsUnknownContext(err, RETIRED_KNOWN_TO_ATUM_CONTEXT_URL);
    });
  }
});

describe("legacy credentials rewritten to the current context fail on the signature", () => {
  it("secp256k1 credential: signatureInvalid, and the recovered signer is not the issuer", async () => {
    const legacy = readLegacy("secp256k1-go-vc-proof.json");
    const raw = rewriteToCurrentContext(legacy);

    const err = await rejection(
      verifyVCProof(
        JSON.parse(raw) as Record<string, unknown>,
        legacyIssuerResolver("EcdsaSecp256k1RecoverySignature2020")
      )
    );
    expect(err).toBeInstanceOf(VPVCProofError);
    expect((err as VPVCProofError).reason).toBe("signatureInvalid");
    expect(err).not.toBeInstanceOf(UnknownContextError);

    const before = await vcSigningInput(legacy, legacyContexts());
    const after = await vcSigningInput(raw);
    expect(
      Buffer.from(after.hashes.signingInput).equals(Buffer.from(before.hashes.signingInput)),
      "the signing input is unchanged by the rewrite: the signature does not cover the credential vocabulary"
    ).toBe(false);
    const recovered = recoverSigner(after.hashes, after.proof);
    expect(recovered).toMatch(/^0x[0-9a-f]{40}$/);
    expect(recovered).not.toBe("0x0000000000000000000000000000000000000000");
    expect(recovered).not.toBe(HARDHAT_ADDRESS);
  });

  it("ed25519 credential: signatureInvalid", async () => {
    const raw = rewriteToCurrentContext(readLegacy("ed25519-go-vc-proof.json"));

    const err = await rejection(
      verifyVCProof(JSON.parse(raw) as Record<string, unknown>, legacyIssuerResolver("Ed25519Signature2020"))
    );
    expect(err).toBeInstanceOf(VPVCProofError);
    expect((err as VPVCProofError).reason).toBe("signatureInvalid");
    expect(err).not.toBeInstanceOf(UnknownContextError);

    const { hashes, proof } = await vcSigningInput(raw);
    expect(ed25519ProofVerifies(hashes, proof)).toBe(false);
  });

  // A presentation's holder signature covers the credentials it embeds
  // (verifiableCredential is an @graph container), so rewriting an embedded
  // legacy credential's context breaks the holder signature as well.
  it("secp256k1 presentation: holder mismatch, and the recovered signer is not the holder", async () => {
    const raw = rewriteToCurrentContext(readLegacy("secp256k1-go-vp.json"));

    const err = await rejection(verifyVP(raw, vpOptions(HOLDER_SECP256K1)));
    expect(String(err)).toMatch(/VP signer\/holder mismatch/);
    expect(err).not.toBeInstanceOf(UnknownContextError);

    const { hashes, proof } = await vpSigningInput(raw);
    const recovered = recoverSigner(hashes, proof);
    expect(recovered).toMatch(/^0x[0-9a-f]{40}$/);
    expect(recovered).not.toBe("0x0000000000000000000000000000000000000000");
    expect(recovered).not.toBe(HARDHAT_ADDRESS);
  });

  it("ed25519 presentation: the holder signature is rejected", async () => {
    const raw = rewriteToCurrentContext(readLegacy("ed25519-go-vp.json"));

    const err = await rejection(verifyVP(raw, vpOptions(HOLDER_ED25519)));
    expect(String(err)).toMatch(/ed25519 signature verification failed/);
    expect(err).not.toBeInstanceOf(UnknownContextError);

    const { hashes, proof } = await vpSigningInput(raw);
    expect(ed25519ProofVerifies(hashes, proof)).toBe(false);
  });
});
