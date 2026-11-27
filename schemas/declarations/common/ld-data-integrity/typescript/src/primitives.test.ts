import { describe, it, expect } from "vitest";

import bs58 from "bs58";
import {
  Wallet,
  keccak256,
  getBytes,
  hexlify,
  computeAddress,
  SigningKey,
} from "ethers";
import nacl from "tweetnacl";

import {
  newDocumentLoader,
  W3C_VC_V1_CONTEXT_URL,
  SECP256K1_RECOVERY_2020_V2_CTX_URL,
  ED25519_SIGNATURE_2020_V1_CTX_URL,
} from "./documentLoader.js";
import { canonicalize } from "./canonicalize.js";
import {
  hashDocument,
  CRYPTOSUITE_SECP256K1_RECOVERY_2020,
  CRYPTOSUITE_ED25519_SIGNATURE_2020,
} from "./hash.js";
import { buildSecp256k1JWS, parseSecp256k1JWS } from "./jws.js";
import {
  recoverSecp256k1Signer,
  secp256k1ESRecoveryFromDER,
} from "./recovery.js";
import {
  encodeEd25519ProofValue,
  decodeEd25519ProofValue,
  signEd25519,
  verifyEd25519,
} from "./ed25519.js";
import {
  UnknownContextError,
  MalformedProofError,
  SignatureRecoveryError,
  Ed25519VerifyError,
  UnsupportedProofTypeError,
} from "./errors.js";

describe("DocumentLoader", () => {
  it("resolves W3C VC v1 to the inline minimal twin", () => {
    const loader = newDocumentLoader();
    const doc = loader.load(W3C_VC_V1_CONTEXT_URL);
    expect(doc).toBeDefined();
    expect((doc as Record<string, unknown>)["@context"]).toBeDefined();
  });

  it("resolves secp256k1recovery-2020-v2 from the vendored snapshot", () => {
    const loader = newDocumentLoader();
    const doc = loader.load(SECP256K1_RECOVERY_2020_V2_CTX_URL);
    expect(doc).toBeDefined();
  });

  it("resolves ed25519-2020-v1 from the vendored snapshot", () => {
    const loader = newDocumentLoader();
    const doc = loader.load(ED25519_SIGNATURE_2020_V1_CTX_URL);
    expect(doc).toBeDefined();
  });

  it("throws UnknownContextError for unregistered URLs", () => {
    const loader = newDocumentLoader();
    expect(() =>
      loader.load("https://example.com/unknown-context")
    ).toThrow(UnknownContextError);
  });

  it("overlays caller-supplied extra contexts", () => {
    const customCtx = {
      "@context": { example: "http://example.com/" },
    };
    const loader = newDocumentLoader({
      "https://example.com/x/v1": customCtx,
    });
    const doc = loader.load("https://example.com/x/v1");
    expect(doc).toEqual(customCtx);
  });

  it("withExtraContexts overlays onto a copy without mutating the base", () => {
    const base = newDocumentLoader();
    const extraUrl = "https://example.com/declaration/v1";
    const extraCtx = { "@context": { example: "http://example.com/" } };

    const overlaid = base.withExtraContexts({ [extraUrl]: extraCtx });

    // The overlay resolves on the derived loader, and the base + generic
    // contexts still resolve through it.
    expect(overlaid.load(extraUrl)).toEqual(extraCtx);
    expect(overlaid.load(W3C_VC_V1_CONTEXT_URL)).toBeDefined();
    // The base loader is untouched — the overlay never leaks into it.
    expect(() => base.load(extraUrl)).toThrow(UnknownContextError);
  });
});

describe("canonicalize", () => {
  it("URDNA2015-canonicalizes a minimal VC and produces n-quads", async () => {
    const loader = newDocumentLoader();
    const doc = {
      "@context": [W3C_VC_V1_CONTEXT_URL],
      id: "urn:uuid:test-canonical",
      type: ["VerifiableCredential"],
      issuer: "did:web:test.atumlabs.xyz",
      issuanceDate: "2026-06-15T00:00:00Z",
      credentialSubject: {
        id: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      },
    };
    const nquads = await canonicalize(doc, loader);
    expect(nquads).toContain("urn:uuid:test-canonical");
    expect(nquads).toContain("VerifiableCredential");
  });

  it("rejects an unknown @context URL", async () => {
    const loader = newDocumentLoader();
    const doc = {
      "@context": ["https://example.com/unknown-context"],
      foo: "bar",
    };
    await expect(canonicalize(doc, loader)).rejects.toThrow();
  });
});

describe("buildSecp256k1JWS / parseSecp256k1JWS", () => {
  it("roundtrips a 65-byte signature through build + parse", () => {
    const sig = new Uint8Array(65);
    for (let i = 0; i < 65; i++) sig[i] = i;
    const jws = buildSecp256k1JWS(sig);
    expect(jws).toContain("..");
    const { header, signature } = parseSecp256k1JWS(jws);
    expect(header.alg).toBe("ES256K-R");
    expect(header.b64).toBe(false);
    expect(header.crit).toEqual(["b64"]);
    expect(signature).toEqual(sig);
  });

  it("rejects non-65-byte signatures on build", () => {
    expect(() => buildSecp256k1JWS(new Uint8Array(64))).toThrow(
      MalformedProofError
    );
  });

  it("rejects wrong alg", () => {
    const headerB64 = Buffer.from(
      JSON.stringify({ alg: "RS256", b64: false, crit: ["b64"] })
    ).toString("base64url");
    const sigB64 = Buffer.from(new Uint8Array(65)).toString("base64url");
    expect(() => parseSecp256k1JWS(`${headerB64}..${sigB64}`)).toThrow(
      /unsupported alg/
    );
  });

  it("rejects b64=true", () => {
    const headerB64 = Buffer.from(
      JSON.stringify({ alg: "ES256K-R", b64: true, crit: ["b64"] })
    ).toString("base64url");
    const sigB64 = Buffer.from(new Uint8Array(65)).toString("base64url");
    expect(() => parseSecp256k1JWS(`${headerB64}..${sigB64}`)).toThrow(
      /b64=false/
    );
  });

  it("rejects unrecognized crit entries", () => {
    const headerB64 = Buffer.from(
      JSON.stringify({ alg: "ES256K-R", b64: false, crit: ["b64", "evil"] })
    ).toString("base64url");
    const sigB64 = Buffer.from(new Uint8Array(65)).toString("base64url");
    expect(() => parseSecp256k1JWS(`${headerB64}..${sigB64}`)).toThrow(
      /unrecognized crit/
    );
  });
});

describe("recoverSecp256k1Signer", () => {
  it("roundtrips: sign with ethers, recover via the lib", () => {
    const wallet = Wallet.createRandom();
    const digest = getBytes(keccak256(Buffer.from("test")));
    // ethers' signingKey.sign returns a Signature with v ∈ {27, 28}.
    const sig = wallet.signingKey.sign(digest);
    const sigBytes = new Uint8Array(65);
    sigBytes.set(getBytes(sig.r), 0);
    sigBytes.set(getBytes(sig.s), 32);
    sigBytes[64] = sig.v; // v=27 or 28

    const recovered = recoverSecp256k1Signer(digest, sigBytes);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("rejects bad lengths with MalformedProofError", () => {
    expect(() =>
      recoverSecp256k1Signer(new Uint8Array(16), new Uint8Array(65))
    ).toThrow(MalformedProofError);
    expect(() =>
      recoverSecp256k1Signer(new Uint8Array(32), new Uint8Array(64))
    ).toThrow(MalformedProofError);
  });

  it("rejects the high-s malleable twin (matches the Go sibling)", () => {
    const wallet = Wallet.createRandom();
    const digest = getBytes(keccak256(Buffer.from("high-s twin test")));
    const sig = wallet.signingKey.sign(digest); // canonical low-s, v ∈ {27,28}

    // Build the high-s twin: s' = N - s, flip the recovery bit. ethers'
    // Signature.from rejects high-s, so recoverSecp256k1Signer throws —
    // pinning Go/TS agreement. The Go sibling has the matching guard.
    const N = BigInt(
      "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
    );
    const twinS = N - BigInt(sig.s);
    const twin = new Uint8Array(65);
    twin.set(getBytes(sig.r), 0);
    twin.set(getBytes("0x" + twinS.toString(16).padStart(64, "0")), 32);
    twin[64] = sig.v === 27 ? 28 : 27;

    expect(() => recoverSecp256k1Signer(digest, twin)).toThrow(
      SignatureRecoveryError
    );
  });

  // Only v in {0, 1, 27, 28} recovers. ethers reads a v of 35 or more as an
  // EIP-155 v, so without the check 8 to 26 (35 to 53 after the +27) and 35
  // and above recovered the signer too. The Go sibling refuses the same set.
  it("refuses every recovery byte but 0, 1, 27 and 28 (matches the Go sibling)", () => {
    const wallet = Wallet.createRandom();
    const digest = getBytes(keccak256(Buffer.from("v-byte walk")));
    const sig = wallet.signingKey.sign(digest);
    const base = new Uint8Array(65);
    base.set(getBytes(sig.r), 0);
    base.set(getBytes(sig.s), 32);
    for (let v = 0; v <= 255; v++) {
      const withV = new Uint8Array(base);
      withV[64] = v;
      if (v === sig.yParity || v === sig.yParity + 27) {
        expect(recoverSecp256k1Signer(digest, withV).toLowerCase(), `v=${v}`).toBe(
          wallet.address.toLowerCase()
        );
      } else if (v === 0 || v === 1 || v === 27 || v === 28) {
        // The other parity is a well-formed signature by some other key.
        expect(recoverSecp256k1Signer(digest, withV).toLowerCase(), `v=${v}`).not.toBe(
          wallet.address.toLowerCase()
        );
      } else {
        expect(() => recoverSecp256k1Signer(digest, withV), `v=${v}`).toThrow(SignatureRecoveryError);
      }
    }
  });
});

describe("secp256k1ESRecoveryFromDER", () => {
  function derEncodeRS(r: bigint, s: bigint): Uint8Array {
    function intBytes(n: bigint): Uint8Array {
      let hex = n.toString(16);
      if (hex.length % 2 !== 0) hex = "0" + hex;
      const buf = Buffer.from(hex, "hex");
      // Prepend 0x00 if the high bit is set (DER INTEGER signed-encoding).
      if (buf[0] & 0x80) {
        return new Uint8Array([0x00, ...buf]);
      }
      return new Uint8Array(buf);
    }
    const rBytes = intBytes(r);
    const sBytes = intBytes(s);
    const body = new Uint8Array(2 + rBytes.length + 2 + sBytes.length);
    body[0] = 0x02; // INTEGER
    body[1] = rBytes.length;
    body.set(rBytes, 2);
    body[2 + rBytes.length] = 0x02;
    body[3 + rBytes.length] = sBytes.length;
    body.set(sBytes, 4 + rBytes.length);
    const out = new Uint8Array(2 + body.length);
    out[0] = 0x30; // SEQUENCE
    out[1] = body.length;
    out.set(body, 2);
    return out;
  }

  it("roundtrip: KMS-shape DER → 65-byte ES256K-R that recovers to expectedPub", () => {
    const wallet = Wallet.createRandom();
    const signingKey = new SigningKey(wallet.privateKey);
    const expectedPub = getBytes(signingKey.publicKey);
    const digest = getBytes(keccak256(Buffer.from("test-message")));

    // Sign + DER-encode r and s.
    const sig = signingKey.sign(digest);
    const r = BigInt(sig.r);
    const s = BigInt(sig.s);
    const der = derEncodeRS(r, s);

    const sig65 = secp256k1ESRecoveryFromDER(der, expectedPub, digest);
    expect(sig65.length).toBe(65);
    expect(sig65[64]).toBeLessThanOrEqual(1);

    // The recovered sig must reproduce expectedPub's address.
    const recovered = recoverSecp256k1Signer(digest, sig65);
    expect(recovered.toLowerCase()).toBe(
      computeAddress(hexlify(expectedPub)).toLowerCase()
    );
  });

  it("rejects bad inputs with MalformedProofError", () => {
    const wallet = Wallet.createRandom();
    const signingKey = new SigningKey(wallet.privateKey);
    const expectedPub = getBytes(signingKey.publicKey);
    const digest = getBytes(keccak256(Buffer.from("ok")));

    // Short digest.
    expect(() =>
      secp256k1ESRecoveryFromDER(new Uint8Array(8), expectedPub, digest.slice(0, 16))
    ).toThrow(MalformedProofError);

    // Wrong-shape pub.
    expect(() =>
      secp256k1ESRecoveryFromDER(new Uint8Array(8), expectedPub.slice(0, 32), digest)
    ).toThrow(MalformedProofError);

    // Malformed DER.
    expect(() =>
      secp256k1ESRecoveryFromDER(new Uint8Array([0x30, 0x00]), expectedPub, digest)
    ).toThrow(MalformedProofError);
  });

  it("normalizes high-s back to low-s and still recovers expectedPub", () => {
    // ethers.SigningKey.sign always produces low-s; pre-flip s to
    // (N - s) by hand to construct a DER with guaranteed-high s + the
    // same elliptic point. The helper MUST re-flip back and still
    // recover. Cloud KMS backends (AWS, GCP) produce non-normalized s
    // ~50% of the time — this branch matters in production.
    const SECP256K1_N = BigInt(
      "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
    );
    const SECP256K1_HALF_N = SECP256K1_N >> 1n;

    const wallet = Wallet.createRandom();
    const signingKey = new SigningKey(wallet.privateKey);
    const expectedPub = getBytes(signingKey.publicKey);
    const digest = getBytes(keccak256(Buffer.from("high-s-fixture")));

    const sig = signingKey.sign(digest);
    const r = BigInt(sig.r);
    const sLow = BigInt(sig.s);
    // ethers normalizes to low-s; sanity-check then flip.
    if (sLow > SECP256K1_HALF_N) {
      throw new Error("test setup: ethers did not return low-s");
    }
    const sHigh = SECP256K1_N - sLow;
    if (sHigh <= SECP256K1_HALF_N) {
      throw new Error("test setup: flipped s is not > N/2");
    }
    const derHighS = derEncodeRS(r, sHigh);

    const sig65 = secp256k1ESRecoveryFromDER(derHighS, expectedPub, digest);
    expect(sig65.length).toBe(65);

    // s in the output MUST be normalized back to low-s.
    const sOutHex = Buffer.from(sig65.slice(32, 64)).toString("hex");
    const sOut = BigInt("0x" + sOutHex);
    expect(sOut <= SECP256K1_HALF_N).toBe(true);

    // And recovery must reproduce expectedPub.
    const recovered = recoverSecp256k1Signer(digest, sig65);
    expect(recovered.toLowerCase()).toBe(
      computeAddress(hexlify(expectedPub)).toLowerCase()
    );
  });

  it("rejects DER with long-form length encoding", () => {
    const wallet = Wallet.createRandom();
    const signingKey = new SigningKey(wallet.privateKey);
    const expectedPub = getBytes(signingKey.publicKey);
    const digest = getBytes(keccak256(Buffer.from("long-form-fixture")));

    // Construct a DER with the SEQUENCE length encoded in long form
    // (0x81 indicator byte + 1-byte length). Real secp256k1 sigs
    // always fit in short form; the parser must explicitly reject
    // long-form to surface a clear error rather than a misleading
    // length-mismatch downstream.
    const sig = signingKey.sign(digest);
    const validDer = derEncodeRS(BigInt(sig.r), BigInt(sig.s));
    const longFormDer = new Uint8Array(validDer.length + 1);
    longFormDer[0] = 0x30;
    longFormDer[1] = 0x81; // long-form indicator
    longFormDer[2] = validDer.length - 2; // payload length
    longFormDer.set(validDer.slice(2), 3);

    expect(() => secp256k1ESRecoveryFromDER(longFormDer, expectedPub, digest))
      .toThrow(/long-form/);
  });

  it("rejects r or s ≥ N with MalformedProofError", () => {
    const wallet = Wallet.createRandom();
    const signingKey = new SigningKey(wallet.privateKey);
    const expectedPub = getBytes(signingKey.publicKey);
    const digest = getBytes(keccak256(Buffer.from("oob-fixture")));

    const SECP256K1_N = BigInt(
      "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"
    );

    const cases: Array<{ name: string; r: bigint; s: bigint }> = [
      { name: "r == N", r: SECP256K1_N, s: 1n },
      { name: "s == N", r: 1n, s: SECP256K1_N },
      { name: "r > N", r: SECP256K1_N + 1n, s: 1n },
      { name: "s > N", r: 1n, s: SECP256K1_N + 1n },
    ];
    for (const tc of cases) {
      const der = derEncodeRS(tc.r, tc.s);
      expect(
        () => secp256k1ESRecoveryFromDER(der, expectedPub, digest),
        tc.name
      ).toThrow(MalformedProofError);
      expect(
        () => secp256k1ESRecoveryFromDER(der, expectedPub, digest),
        tc.name
      ).toThrow(/out of range/);
    }
  });

  it("rejects wrong key with SignatureRecoveryError", () => {
    const signer = Wallet.createRandom();
    const wrong = Wallet.createRandom();
    const signingKey = new SigningKey(signer.privateKey);
    const wrongPub = getBytes(new SigningKey(wrong.privateKey).publicKey);
    const digest = getBytes(keccak256(Buffer.from("test-message")));

    const sig = signingKey.sign(digest);
    const der = derEncodeRS(BigInt(sig.r), BigInt(sig.s));

    expect(() => secp256k1ESRecoveryFromDER(der, wrongPub, digest)).toThrow(
      SignatureRecoveryError
    );
  });
});

describe("encodeEd25519ProofValue / decodeEd25519ProofValue", () => {
  it("roundtrips a 64-byte signature through encode + decode", () => {
    const sig = new Uint8Array(64);
    for (let i = 0; i < 64; i++) sig[i] = i;
    const encoded = encodeEd25519ProofValue(sig);
    expect(encoded[0]).toBe("z");
    const decoded = decodeEd25519ProofValue(encoded);
    expect(decoded).toEqual(sig);
  });

  it("rejects non-64-byte sig on encode", () => {
    expect(() => encodeEd25519ProofValue(new Uint8Array(63))).toThrow(
      MalformedProofError
    );
  });

  it("rejects non-z prefix on decode", () => {
    expect(() => decodeEd25519ProofValue("mAAA")).toThrow(MalformedProofError);
    expect(() => decodeEd25519ProofValue("")).toThrow(MalformedProofError);
  });

  it("rejects wrong decoded length", () => {
    const shortSig = new Uint8Array(63);
    // Manually construct: 'z' + base58(63 bytes) → wrong length on decode.
    const encoded = "z" + bs58.encode(shortSig);
    expect(() => decodeEd25519ProofValue(encoded)).toThrow(MalformedProofError);
  });
});

describe("signEd25519 / verifyEd25519", () => {
  it("roundtrips: sign with tweetnacl, verify via the lib", () => {
    const kp = nacl.sign.keyPair();
    const msg = new Uint8Array([1, 2, 3, 4, 5]);
    const sig = signEd25519(kp.secretKey, msg);
    expect(sig.length).toBe(64);
    expect(() => verifyEd25519(kp.publicKey, msg, sig)).not.toThrow();
  });

  it("rejects a wrong sig with Ed25519VerifyError", () => {
    const kp = nacl.sign.keyPair();
    const msg = new Uint8Array([1, 2, 3]);
    const sig = signEd25519(kp.secretKey, msg);
    sig[0] ^= 0xff; // flip a byte
    expect(() => verifyEd25519(kp.publicKey, msg, sig)).toThrow(
      Ed25519VerifyError
    );
  });

  it("rejects a wrong pubkey", () => {
    const kp = nacl.sign.keyPair();
    const otherKp = nacl.sign.keyPair();
    const msg = new Uint8Array([1, 2, 3]);
    const sig = signEd25519(kp.secretKey, msg);
    expect(() => verifyEd25519(otherKp.publicKey, msg, sig)).toThrow(
      Ed25519VerifyError
    );
  });

  it("rejects wrong-shape priv/pub", () => {
    expect(() => signEd25519(new Uint8Array(32), new Uint8Array([1]))).toThrow(
      MalformedProofError
    );
    expect(() =>
      verifyEd25519(new Uint8Array(16), new Uint8Array([1]), new Uint8Array(64))
    ).toThrow(MalformedProofError);
  });
});

describe("hashDocument", () => {
  it("composes a 32-byte signing input for secp256k1", async () => {
    const loader = newDocumentLoader();
    const doc = {
      "@context": [W3C_VC_V1_CONTEXT_URL],
      id: "urn:uuid:hash-test-secp",
      type: ["VerifiableCredential"],
      issuer: "did:web:test",
      issuanceDate: "2026-06-15T00:00:00Z",
      credentialSubject: { id: "did:test:x" },
    };
    const result = await hashDocument(
      doc,
      {
        cryptosuite: CRYPTOSUITE_SECP256K1_RECOVERY_2020,
        proofOptions: {
          type: CRYPTOSUITE_SECP256K1_RECOVERY_2020,
          created: "2026-06-15T00:00:00Z",
          verificationMethod: "did:web:test#key-1",
          proofPurpose: "assertionMethod",
        },
      },
      loader
    );
    expect(result.signingInput.length).toBe(32);
    expect(result.docHash.length).toBe(32);
    expect(result.proofHash.length).toBe(32);
  });

  it("composes a 64-byte signing input for ed25519", async () => {
    const loader = newDocumentLoader();
    const doc = {
      "@context": [W3C_VC_V1_CONTEXT_URL],
      id: "urn:uuid:hash-test-ed",
      type: ["VerifiableCredential"],
      issuer: "did:web:test",
      issuanceDate: "2026-06-15T00:00:00Z",
      credentialSubject: { id: "did:test:x" },
    };
    const result = await hashDocument(
      doc,
      {
        cryptosuite: CRYPTOSUITE_ED25519_SIGNATURE_2020,
        proofOptions: {
          type: CRYPTOSUITE_ED25519_SIGNATURE_2020,
          created: "2026-06-15T00:00:00Z",
          verificationMethod: "did:web:test#key-1",
          proofPurpose: "assertionMethod",
        },
      },
      loader
    );
    expect(result.signingInput.length).toBe(64);
    expect(result.docHash.length).toBe(32);
    expect(result.proofHash.length).toBe(32);
  });

  it("rejects an unsupported cryptosuite", async () => {
    const loader = newDocumentLoader();
    await expect(
      hashDocument(
        { "@context": [W3C_VC_V1_CONTEXT_URL] },
        {
          // @ts-expect-error — testing runtime guard
          cryptosuite: "EcdsaSecp256k1Signature2019",
          proofOptions: {
            // @ts-expect-error
            type: "EcdsaSecp256k1Signature2019",
            created: "",
            verificationMethod: "",
            proofPurpose: "",
          },
        },
        loader
      )
    ).rejects.toThrow(UnsupportedProofTypeError);
  });

  it("rejects type/cryptosuite mismatch", async () => {
    const loader = newDocumentLoader();
    await expect(
      hashDocument(
        { "@context": [W3C_VC_V1_CONTEXT_URL] },
        {
          cryptosuite: CRYPTOSUITE_SECP256K1_RECOVERY_2020,
          proofOptions: {
            type: CRYPTOSUITE_ED25519_SIGNATURE_2020,
            created: "",
            verificationMethod: "",
            proofPurpose: "",
          },
        },
        loader
      )
    ).rejects.toThrow(MalformedProofError);
  });
});

