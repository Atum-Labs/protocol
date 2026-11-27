// Tests for verifyVCProof + DIDWebResolver. Mirror of the
// Go canonical's verify_vc_test.go. Coverage:
//   - Happy path: signed VC verifies against a mock resolver
//     (both secp256k1 + ed25519).
//   - Tampered proof (jws or proofValue) rejects with signatureInvalid.
//   - Wrong issuer key (resolver returns a different pubkey under the
//     same VM URL) rejects with signatureInvalid.
//   - Resolver throws → issuerUnresolvable.
//   - Resolver returns empty set → issuerUnresolvable.
//   - VM URL absent from set → issuerKeyMismatch.
//   - Unsupported VM type → unsupportedProofType.
//   - Malformed JWK (kty / crv / x errors) → malformedQuote.
//   - proof.@context mismatched cryptosuite → unsupportedProofType.
//   - DIDWebResolver: did:web URL derivation, override handling,
//     cache TTL semantics, malformed DID rejection, parse failures,
//     emptyVMSet, MRU eviction on LRU bound.

import { describe, it, expect } from "vitest";
import { Wallet, SigningKey, keccak256, getBytes } from "ethers";
import bs58 from "bs58";
import nacl from "tweetnacl";

import { hashQuote } from "./hash.js";
import { createDetachedJws } from "./jws.js";
import {
  verifyVCProof,
  VPVCProofError,
  type IssuerKeyResolver,
  type VerificationMethodSet,
} from "./verify-vc.js";
import {
  DIDWebResolver,
  DIDWebResolverError,
  loadOverridesFromEnv,
} from "./did-web-resolver.js";

const ISSUER_DID = "did:web:atumlabs.test";
const VM_URL_SECP = `${ISSUER_DID}#issuer-key-secp-1`;
const VM_URL_ED25519 = `${ISSUER_DID}#issuer-key-ed25519-1`;

const W3C_VC_V1 = "https://www.w3.org/2018/credentials/v1";
const SECP_CTX = "https://w3id.org/security/suites/secp256k1recovery-2020/v2";
const ED25519_CTX = "https://w3id.org/security/suites/ed25519-2020/v1";

// Hardhat account #0 — pinned test key used elsewhere in the conformance
// suite. Same key here so a future cross-language fixture can re-mint
// the same VC byte-for-byte from either side.
const HARDHAT_PRIV =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// RFC 8032 zero-seed ed25519 key. Deterministic across both languages
// for the same reason.
function rfc8032ZeroSeedKey(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const seed = new Uint8Array(32); // all-zero
  return nacl.sign.keyPair.fromSeed(seed);
}

// Mints a signed VC under the secp256k1 cryptosuite using the same
// primitives the production issuer would (hashQuote + signing + JWS).
async function mintSignedVCSecp(opts?: { tamperBody?: boolean }): Promise<{
  vc: Record<string, unknown>;
  vmSet: VerificationMethodSet;
}> {
  const created = "2026-01-01T00:00:00Z";
  const wallet = new Wallet(HARDHAT_PRIV);

  const body: Record<string, unknown> = {
    "@context": [W3C_VC_V1],
    id: "urn:uuid:vc-1737-secp-test",
    type: ["VerifiableCredential"],
    issuer: ISSUER_DID,
    issuanceDate: created,
    credentialSubject: {
      id: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      role: "settler",
    },
  };

  const { signingInput } = await hashQuote(body, {
    cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
    proofOptions: {
      type: "EcdsaSecp256k1RecoverySignature2020",
      created,
      verificationMethod: VM_URL_SECP,
      proofPurpose: "assertionMethod",
    },
    keepVerifiableCredential: false,
    proofContext: SECP_CTX,
  });

  const signingKey = new SigningKey(HARDHAT_PRIV);
  const sig = signingKey.sign(signingInput);
  const sigBytes = Buffer.from(sig.serialized.slice(2), "hex");
  const jws = createDetachedJws(sigBytes);

  if (opts?.tamperBody) body.credentialSubject = { ...(body.credentialSubject as object), tampered: true };

  body.proof = {
    "@context": SECP_CTX,
    type: "EcdsaSecp256k1RecoverySignature2020",
    created,
    verificationMethod: VM_URL_SECP,
    proofPurpose: "assertionMethod",
    jws,
  };

  // Issuer-side JWK. Mirrors the Go `jwkSecp256k1ToAddress` shape:
  // {kty: "EC", crv: "secp256k1", x: <base64url(X)>, y: <base64url(Y)>}.
  // Derive X/Y from the same private key by getting the uncompressed
  // pubkey via ethers.
  const pubKeyHex = signingKey.publicKey.slice(2); // drop 0x
  const x = Buffer.from(pubKeyHex.slice(2, 66), "hex");
  const y = Buffer.from(pubKeyHex.slice(66), "hex");
  const vmSet: VerificationMethodSet = [
    {
      id: VM_URL_SECP,
      type: "JsonWebKey2020",
      publicKeyJwk: {
        kty: "EC",
        crv: "secp256k1",
        x: x.toString("base64url"),
        y: y.toString("base64url"),
      },
    },
  ];
  void wallet;
  return { vc: body, vmSet };
}

async function mintSignedVCEd25519(opts?: { tamperBody?: boolean }): Promise<{
  vc: Record<string, unknown>;
  vmSet: VerificationMethodSet;
}> {
  const created = "2026-01-01T00:00:00Z";
  const { publicKey, secretKey } = rfc8032ZeroSeedKey();

  const body: Record<string, unknown> = {
    "@context": [W3C_VC_V1],
    id: "urn:uuid:vc-1737-ed25519-test",
    type: ["VerifiableCredential"],
    issuer: ISSUER_DID,
    issuanceDate: created,
    credentialSubject: {
      id: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      role: "settler",
    },
  };

  const { signingInput } = await hashQuote(body, {
    cryptosuite: "Ed25519Signature2020",
    proofOptions: {
      type: "Ed25519Signature2020",
      created,
      verificationMethod: VM_URL_ED25519,
      proofPurpose: "assertionMethod",
    },
    keepVerifiableCredential: false,
    proofContext: ED25519_CTX,
  });

  const sig = nacl.sign.detached(signingInput, secretKey);
  const proofValue = "z" + bs58.encode(sig);

  if (opts?.tamperBody) body.credentialSubject = { ...(body.credentialSubject as object), tampered: true };

  body.proof = {
    "@context": ED25519_CTX,
    type: "Ed25519Signature2020",
    created,
    verificationMethod: VM_URL_ED25519,
    proofPurpose: "assertionMethod",
    proofValue,
  };

  const vmSet: VerificationMethodSet = [
    {
      id: VM_URL_ED25519,
      type: "JsonWebKey2020",
      publicKeyJwk: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(publicKey).toString("base64url"),
      },
    },
  ];
  return { vc: body, vmSet };
}

class MockResolver implements IssuerKeyResolver {
  constructor(
    private readonly vmSet: VerificationMethodSet,
    private readonly opts: { issuerDID?: string; throws?: Error; emptySet?: boolean } = {}
  ) {}
  async resolve(issuerDID: string): Promise<VerificationMethodSet> {
    if (this.opts.throws) throw this.opts.throws;
    if (this.opts.emptySet) return [];
    if (this.opts.issuerDID && issuerDID !== this.opts.issuerDID) {
      throw new Error(`unknown issuer ${issuerDID}`);
    }
    return this.vmSet;
  }
}

describe("verifyVCProof — secp256k1", () => {
  it("happy path: signed VC verifies against the issuer's JWK", async () => {
    const { vc, vmSet } = await mintSignedVCSecp();
    const resolver = new MockResolver(vmSet);
    await expect(verifyVCProof(vc, resolver)).resolves.toBeUndefined();
  });

  it("tampered proof.jws → signatureInvalid", async () => {
    const { vc, vmSet } = await mintSignedVCSecp();
    const proof = vc.proof as Record<string, unknown>;
    const jws = proof.jws as string;
    const [hdr, , sig] = jws.split(".");
    // Flip the last byte of the signature payload.
    const decoded = Buffer.from(sig, "base64url");
    decoded[decoded.length - 1] ^= 0xff;
    proof.jws = `${hdr}..${decoded.toString("base64url")}`;
    const resolver = new MockResolver(vmSet);
    await expect(verifyVCProof(vc, resolver)).rejects.toThrow(VPVCProofError);
  });

  it("wrong issuer key → signatureInvalid", async () => {
    const { vc } = await mintSignedVCSecp();
    // Resolver returns a fresh, unrelated key under the same VM URL.
    const otherKey = new SigningKey(
      "0xb71c71a67e1177ad4e901695e1b4b9ee17ae16c6668d313eac2f96dbcda3f291"
    );
    const pubHex = otherKey.publicKey.slice(2);
    const x = Buffer.from(pubHex.slice(2, 66), "hex");
    const y = Buffer.from(pubHex.slice(66), "hex");
    const wrong: VerificationMethodSet = [
      {
        id: VM_URL_SECP,
        type: "JsonWebKey2020",
        publicKeyJwk: {
          kty: "EC",
          crv: "secp256k1",
          x: x.toString("base64url"),
          y: y.toString("base64url"),
        },
      },
    ];
    const resolver = new MockResolver(wrong);
    await expect(verifyVCProof(vc, resolver)).rejects.toMatchObject({
      reason: "signatureInvalid",
    });
  });

  it("resolver throws → issuerUnresolvable", async () => {
    const { vc } = await mintSignedVCSecp();
    const resolver = new MockResolver([], { throws: new Error("DNS down") });
    await expect(verifyVCProof(vc, resolver)).rejects.toMatchObject({
      reason: "issuerUnresolvable",
    });
  });

  it("resolver returns empty set → issuerUnresolvable", async () => {
    const { vc } = await mintSignedVCSecp();
    const resolver = new MockResolver([], { emptySet: true });
    await expect(verifyVCProof(vc, resolver)).rejects.toMatchObject({
      reason: "issuerUnresolvable",
    });
  });

  it("VM URL absent from set → issuerKeyMismatch", async () => {
    const { vc } = await mintSignedVCSecp();
    const otherUrl: VerificationMethodSet = [
      {
        id: `${ISSUER_DID}#some-other-key`,
        type: "JsonWebKey2020",
        publicKeyJwk: { kty: "EC", crv: "secp256k1", x: "AAAA", y: "BBBB" },
      },
    ];
    const resolver = new MockResolver(otherUrl);
    await expect(verifyVCProof(vc, resolver)).rejects.toMatchObject({
      reason: "issuerKeyMismatch",
    });
  });

  it("unsupported VM type → unsupportedProofType", async () => {
    const { vc, vmSet } = await mintSignedVCSecp();
    vmSet[0]!.type = "Ed25519VerificationKey2020";
    const resolver = new MockResolver(vmSet);
    await expect(verifyVCProof(vc, resolver)).rejects.toMatchObject({
      reason: "unsupportedProofType",
    });
  });

  it("proof.@context swapped to ed25519 suite URL → unsupportedProofType", async () => {
    const { vc, vmSet } = await mintSignedVCSecp();
    (vc.proof as Record<string, unknown>)["@context"] = ED25519_CTX;
    const resolver = new MockResolver(vmSet);
    await expect(verifyVCProof(vc, resolver)).rejects.toMatchObject({
      reason: "unsupportedProofType",
    });
  });
});

describe("verifyVCProof — ed25519", () => {
  it("happy path: signed VC verifies against the issuer's OKP/Ed25519 JWK", async () => {
    const { vc, vmSet } = await mintSignedVCEd25519();
    const resolver = new MockResolver(vmSet);
    await expect(verifyVCProof(vc, resolver)).resolves.toBeUndefined();
  });

  it("tampered proof.proofValue → signatureInvalid", async () => {
    const { vc, vmSet } = await mintSignedVCEd25519();
    const proof = vc.proof as Record<string, unknown>;
    const pv = proof.proofValue as string;
    const sig = bs58.decode(pv.slice(1));
    sig[0] ^= 0xff;
    proof.proofValue = "z" + bs58.encode(sig);
    const resolver = new MockResolver(vmSet);
    await expect(verifyVCProof(vc, resolver)).rejects.toMatchObject({
      reason: "signatureInvalid",
    });
  });

  it("wrong issuer key → signatureInvalid", async () => {
    const { vc } = await mintSignedVCEd25519();
    // Build a different-seed ed25519 key.
    const otherSeed = new Uint8Array(32);
    otherSeed[0] = 1;
    const other = nacl.sign.keyPair.fromSeed(otherSeed);
    const wrong: VerificationMethodSet = [
      {
        id: VM_URL_ED25519,
        type: "JsonWebKey2020",
        publicKeyJwk: {
          kty: "OKP",
          crv: "Ed25519",
          x: Buffer.from(other.publicKey).toString("base64url"),
        },
      },
    ];
    const resolver = new MockResolver(wrong);
    await expect(verifyVCProof(vc, resolver)).rejects.toMatchObject({
      reason: "signatureInvalid",
    });
  });

  it("malformed JWK (wrong kty) → malformedQuote", async () => {
    const { vc, vmSet } = await mintSignedVCEd25519();
    (vmSet[0]!.publicKeyJwk as Record<string, unknown>).kty = "EC";
    const resolver = new MockResolver(vmSet);
    await expect(verifyVCProof(vc, resolver)).rejects.toMatchObject({
      reason: "malformedQuote",
    });
  });

  it("malformed JWK (short x) → malformedQuote", async () => {
    const { vc, vmSet } = await mintSignedVCEd25519();
    (vmSet[0]!.publicKeyJwk as Record<string, unknown>).x = Buffer.from([1, 2, 3]).toString("base64url");
    const resolver = new MockResolver(vmSet);
    await expect(verifyVCProof(vc, resolver)).rejects.toMatchObject({
      reason: "malformedQuote",
    });
  });

  it("proofValue without 'z' prefix → malformedSignatureMaterial", async () => {
    const { vc, vmSet } = await mintSignedVCEd25519();
    const proof = vc.proof as Record<string, unknown>;
    proof.proofValue = (proof.proofValue as string).slice(1); // drop the 'z'
    const resolver = new MockResolver(vmSet);
    await expect(verifyVCProof(vc, resolver)).rejects.toMatchObject({
      reason: "malformedSignatureMaterial",
    });
  });

  it("proofValue with valid 'z' prefix but wrong length → malformedSignatureMaterial", async () => {
    const { vc, vmSet } = await mintSignedVCEd25519();
    const proof = vc.proof as Record<string, unknown>;
    // 32 bytes base58btc-encodes fine but is not a 64-byte ed25519 sig;
    // exercises the decodeEd25519ProofValue length-invariant wrap.
    proof.proofValue = "z" + bs58.encode(new Uint8Array(32));
    const resolver = new MockResolver(vmSet);
    await expect(verifyVCProof(vc, resolver)).rejects.toMatchObject({
      reason: "malformedSignatureMaterial",
    });
  });
});

describe("DIDWebResolver", () => {
  it("derives canonical URL for did:web:host", () => {
    // Use an injected fetch to capture the URL the resolver requests.
    let capturedURL = "";
    const resolver = new DIDWebResolver({
      fetch: ((url: string) => {
        capturedURL = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "did:web:atumlabs.test",
              verificationMethod: [
                {
                  id: "did:web:atumlabs.test#key-1",
                  type: "JsonWebKey2020",
                  publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" },
                },
              ],
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch,
    });
    return resolver.resolve("did:web:atumlabs.test").then(() => {
      expect(capturedURL).toBe("https://atumlabs.test/.well-known/did.json");
    });
  });

  it("derives URL with path segments for did:web:host:path:tail", () => {
    let capturedURL = "";
    const resolver = new DIDWebResolver({
      fetch: ((url: string) => {
        capturedURL = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "did:web:atumlabs.test:users:alice",
              verificationMethod: [
                {
                  id: "did:web:atumlabs.test:users:alice#k",
                  type: "JsonWebKey2020",
                  publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" },
                },
              ],
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch,
    });
    return resolver.resolve("did:web:atumlabs.test:users:alice").then(() => {
      expect(capturedURL).toBe(
        "https://atumlabs.test/users/alice/.well-known/did.json"
      );
    });
  });

  it("applies override map for matching host", async () => {
    let capturedURL = "";
    const overrides = new Map([["atumlabs.test", "http://issuer:8080"]]);
    const resolver = new DIDWebResolver({
      overrides,
      fetch: ((url: string) => {
        capturedURL = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "did:web:atumlabs.test",
              verificationMethod: [
                {
                  id: "did:web:atumlabs.test#k",
                  type: "JsonWebKey2020",
                  publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" },
                },
              ],
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch,
    });
    await resolver.resolve("did:web:atumlabs.test");
    expect(capturedURL).toBe("http://issuer:8080/.well-known/did.json");
  });

  it("rejects non-did:web DIDs", async () => {
    const resolver = new DIDWebResolver();
    await expect(resolver.resolve("did:key:z6Mki")).rejects.toMatchObject({
      reason: "unsupportedDIDMethod",
    });
  });

  it("rejects DID document whose id doesn't match the request", async () => {
    const resolver = new DIDWebResolver({
      fetch: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "did:web:evil.test",
              verificationMethod: [],
            }),
            { status: 200 }
          )
        )) as unknown as typeof fetch,
    });
    await expect(resolver.resolve("did:web:atumlabs.test")).rejects.toMatchObject({
      reason: "parseFailed",
    });
  });

  it("rejects empty verificationMethod array", async () => {
    const resolver = new DIDWebResolver({
      fetch: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "did:web:atumlabs.test",
              verificationMethod: [],
            }),
            { status: 200 }
          )
        )) as unknown as typeof fetch,
    });
    await expect(resolver.resolve("did:web:atumlabs.test")).rejects.toMatchObject({
      reason: "emptyVMSet",
    });
  });

  it("filters out non-JsonWebKey2020 verificationMethod entries", async () => {
    const resolver = new DIDWebResolver({
      fetch: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "did:web:atumlabs.test",
              verificationMethod: [
                {
                  id: "did:web:atumlabs.test#k1",
                  type: "Ed25519VerificationKey2020",
                  publicKeyMultibase: "z6Mki",
                },
              ],
            }),
            { status: 200 }
          )
        )) as unknown as typeof fetch,
    });
    await expect(resolver.resolve("did:web:atumlabs.test")).rejects.toMatchObject({
      reason: "unsupportedVMType",
    });
  });

  it("caches resolution within TTL; refetches after TTL", async () => {
    let calls = 0;
    let now = 1000;
    const resolver = new DIDWebResolver({
      cacheTTLMs: 500,
      clock: () => now,
      fetch: (() => {
        calls++;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "did:web:atumlabs.test",
              verificationMethod: [
                {
                  id: "did:web:atumlabs.test#k",
                  type: "JsonWebKey2020",
                  publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" },
                },
              ],
            }),
            { status: 200 }
          )
        );
      }) as unknown as typeof fetch,
    });
    await resolver.resolve("did:web:atumlabs.test");
    await resolver.resolve("did:web:atumlabs.test");
    expect(calls).toBe(1); // cached
    now += 600;
    await resolver.resolve("did:web:atumlabs.test");
    expect(calls).toBe(2); // refetched after TTL
  });
});

describe("loadOverridesFromEnv", () => {
  it("returns empty map when env var unset", () => {
    expect(loadOverridesFromEnv({}).size).toBe(0);
  });

  it("parses comma-separated host=URL pairs", () => {
    const result = loadOverridesFromEnv({
      DID_WEB_RESOLVER_OVERRIDES:
        "atumlabs.test=http://issuer:8080,other.test=https://other:9090",
    });
    expect(result.get("atumlabs.test")).toBe("http://issuer:8080");
    expect(result.get("other.test")).toBe("https://other:9090");
  });

  it("rejects malformed entries", () => {
    expect(() =>
      loadOverridesFromEnv({ DID_WEB_RESOLVER_OVERRIDES: "no-equals" })
    ).toThrow(/malformed entry/);
  });

  it("rejects duplicate host entries", () => {
    expect(() =>
      loadOverridesFromEnv({
        DID_WEB_RESOLVER_OVERRIDES: "atumlabs.test=a,atumlabs.test=b",
      })
    ).toThrow(/duplicate override/);
  });
});

// Re-export to silence unused-import warnings when typescript is strict.
void DIDWebResolverError;
