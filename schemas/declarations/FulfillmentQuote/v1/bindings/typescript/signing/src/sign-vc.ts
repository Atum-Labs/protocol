// W3C Data Integrity signer for a bare VerifiableCredential under
// either EcdsaSecp256k1RecoverySignature2020 or Ed25519Signature2020.
// Canonical mirror of the Go canonical at
// schemas/declarations/FulfillmentQuote/v1/signing/go/sign_vc.go.
//
// The verifier-side verifyVCProof is the production crypto gate; these
// helpers exist so the conformance fixture generator + any future
// cross-package consumer can mint a signed VC the way the issuer
// would, without copying the canonicalization recipe out of the test
// helpers (verify-vc.test.ts's mintSignedVC{Secp,Ed25519}).
//
// CONTRACT WITH ISSUER SIGNING: this is the verifier-package mirror
// of the issuer's proof-application logic. The canonicalization, hash
// composition, and signature recovery MUST stay in lockstep across
// both packages and both languages.

import { SigningKey } from "ethers";
import nacl from "tweetnacl";

import { encodeEd25519ProofValue } from "@atum-labs/ld-data-integrity";

import { hashQuote } from "./hash.js";
import { createDetachedJws } from "./jws.js";

const SECP256K1_RECOVERY_2020_V2_CTX =
  "https://w3id.org/security/suites/secp256k1recovery-2020/v2";
const ED25519_2020_V1_CTX = "https://w3id.org/security/suites/ed25519-2020/v1";

export interface SignVCProofSecp256k1Options {
  // Full DID URL the proof block references — e.g.
  // `did:web:atumlabs.xyz#key-1`. The verifier's resolver MUST
  // advertise this exact URL in its returned verificationMethodSet.
  verificationMethod: string;
  // Typically `"assertionMethod"` for VC proofs.
  proofPurpose: string;
  // Verbatim timestamp; canonical W3C form is "YYYY-MM-DDTHH:MM:SSZ".
  created: string;
}

export interface SignVCProofEd25519Options {
  verificationMethod: string;
  proofPurpose: string;
  created: string;
}

// signVCProofSecp256k1 attaches a detached-ES256K-R JWS proof to a
// VC body. Returns a new object with the proof attached; the input
// vcBody is unchanged.
export async function signVCProofSecp256k1(
  vcBody: Record<string, unknown>,
  privateKey: string,
  opts: SignVCProofSecp256k1Options
): Promise<Record<string, unknown>> {
  if (!vcBody) throw new Error("signVCProofSecp256k1: vcBody is required");
  if ("proof" in vcBody) {
    throw new Error(
      "signVCProofSecp256k1: vcBody already has a proof field; refusing to overwrite"
    );
  }
  if (!opts.verificationMethod) {
    throw new Error("signVCProofSecp256k1: verificationMethod is required");
  }

  const { signingInput } = await hashQuote(vcBody, {
    cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
    proofOptions: {
      type: "EcdsaSecp256k1RecoverySignature2020",
      created: opts.created,
      verificationMethod: opts.verificationMethod,
      proofPurpose: opts.proofPurpose,
    },
    keepVerifiableCredential: false,
    proofContext: SECP256K1_RECOVERY_2020_V2_CTX,
  });

  const signingKey = new SigningKey(privateKey);
  const sig = signingKey.sign(signingInput);
  const sigBytes = Buffer.from(sig.serialized.slice(2), "hex");
  const jws = createDetachedJws(sigBytes);

  return {
    ...vcBody,
    proof: {
      "@context": SECP256K1_RECOVERY_2020_V2_CTX,
      type: "EcdsaSecp256k1RecoverySignature2020",
      created: opts.created,
      verificationMethod: opts.verificationMethod,
      proofPurpose: opts.proofPurpose,
      jws,
    },
  };
}

// signVCProofEd25519 attaches a multibase-base58btc proofValue to a
// VC body. RFC 8032 deterministic — the same (key, body, options)
// pair produces a byte-identical proofValue every time, and the Go
// counterpart MUST byte-match.
export async function signVCProofEd25519(
  vcBody: Record<string, unknown>,
  privateKey: Uint8Array,
  opts: SignVCProofEd25519Options
): Promise<Record<string, unknown>> {
  if (!vcBody) throw new Error("signVCProofEd25519: vcBody is required");
  if ("proof" in vcBody) {
    throw new Error(
      "signVCProofEd25519: vcBody already has a proof field; refusing to overwrite"
    );
  }
  if (!opts.verificationMethod) {
    throw new Error("signVCProofEd25519: verificationMethod is required");
  }

  const { signingInput } = await hashQuote(vcBody, {
    cryptosuite: "Ed25519Signature2020",
    proofOptions: {
      type: "Ed25519Signature2020",
      created: opts.created,
      verificationMethod: opts.verificationMethod,
      proofPurpose: opts.proofPurpose,
    },
    keepVerifiableCredential: false,
    proofContext: ED25519_2020_V1_CTX,
  });

  const sig = nacl.sign.detached(signingInput, privateKey);
  const proofValue = encodeEd25519ProofValue(sig);

  return {
    ...vcBody,
    proof: {
      "@context": ED25519_2020_V1_CTX,
      type: "Ed25519Signature2020",
      created: opts.created,
      verificationMethod: opts.verificationMethod,
      proofPurpose: opts.proofPurpose,
      proofValue,
    },
  };
}
