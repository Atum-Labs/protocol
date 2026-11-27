// W3C Data Integrity signer for a FulfillmentQuoteEnvelope under the
// EcdsaSecp256k1RecoverySignature2020 cryptosuite. Co-located with the
// FulfillmentQuote signer because the LD canonicalization, hash
// construction (hashQuote), and detached-JWS primitives are shared
// infrastructure — a new envelope-only package would be ~95% copy of
// what already exists.
//
// VP semantics diverge from FQ in three places:
//   1. @context is a VC-v1 + envelope + cryptosuite triple, not a
//      schema + cryptosuite pair.
//   2. The signed body MUST retain its verifiableCredential array
//      (the array IS the payload being attested); hashQuote is invoked
//      with keepVerifiableCredential: true.
//   3. proof.proofPurpose is "authentication" and the proof block carries
//      challenge + domain fields that bind the VP to a specific request
//      and verifier service (replay defense per W3C VC §5.6).
//
// LAYERED THREAT MODEL (the contract this signer pins):
//
// The VP holder's signature binds WHO is presenting WHICH VCs — by
// IDENTITY (id / issuer / issuanceDate / type:VerifiableCredential +
// inner proof block). It does NOT bind the VC's claim VALUES
// (credentialSubject.* beyond `id`, custom VC types like
// `KnownToAtumVerifiableCredential`, or any term not in the active
// JSON-LD context). With `safe: false` in canonicalize.ts, jsonld
// silently drops unmapped terms; this is intentional and a property of
// the layered W3C VC model — the VC ISSUER's signature is what binds
// claim values, and per-VC issuer-proof verification at the verifier
// layer is the gate that re-verifies them. The VP holder doesn't
// re-sign claims they didn't originate.
//
// Once the issuer's published credential context is vendored into
// LOCAL_CONTEXTS, claim terms WILL resolve and the VP signature
// WILL also cover them — at that point the test in sign-vp.test.ts
// pinning "claim mutations do NOT change the VP signature" inverts
// (becomes "claim mutations DO change the VP signature") and the
// inversion is the operational signal that the context vendoring
// landed correctly.

import { SigningKey, getBytes } from "ethers";
import {
  PAYMENT_REQUEST_ENVELOPE_TYPE,
  paymentRequestEnvelopeProofTypedData,
  signTypedProof,
  type TypedDataSigner,
} from "@atum-labs/ld-data-integrity";
import {
  assertDeclarationContextSupplied,
  FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
  SECP256K1_RECOVERY_CONTEXT_URL,
  W3C_VC_V1_CONTEXT_URL,
} from "./canonicalize.js";
import { hashQuote } from "./hash.js";
import { createDetachedJws } from "./jws.js";
import type {
  FulfillmentQuoteEnvelope,
  VerifiableCredential,
} from "@atum-labs/schema-declarations/FulfillmentQuoteEnvelope/v1/bindings/typescript";

interface VPProofOptions {
  type: "EcdsaSecp256k1RecoverySignature2020";
  created: string;
  verificationMethod: string;
  proofPurpose: "authentication";
  challenge: string;
  domain: string;
}

interface VPDataIntegrityProofWithJws extends VPProofOptions {
  jws: string;
}

// SignedFulfillmentQuoteEnvelope relaxes the schema's tuple-typed
// verifiableCredential ([VC, ...VC[]]) to a plain array for ergonomic
// construction; the runtime guard in signVP enforces length >= 1.
export interface SignedFulfillmentQuoteEnvelope
  extends Omit<
    FulfillmentQuoteEnvelope,
    "proof" | "verifiableCredential" | "@context" | "type"
  > {
  "@context": string[];
  type: string[];
  verifiableCredential: VerifiableCredential[];
  proof: VPDataIntegrityProofWithJws;
}

export interface SignVPOptions {
  // did:pkh URI of the entity presenting the credentials. MUST match
  // the recovered signer of the inner FulfillmentQuote — verifier
  // asserts this equality after recovering both signatures.
  holder: string;
  // Full DID URL identifying the signing key, embedded into
  // proof.verificationMethod (e.g. did:pkh:eip155:1:0x..#blockchainAccountId).
  verificationMethod: string;
  // Replay binding to the bid: verifier requires this to equal the
  // bid's request_id.
  challenge: string;
  // Replay binding to the verifier service identifier (e.g.
  // did:web:settler.atum.network).
  domain: string;
  // ISO 8601 timestamp; defaults to now. Surface knob primarily for
  // fixture pinning and deterministic tests.
  created?: string;
  // When set, appended to the signed envelope's `type` array (e.g.
  // "FulfillmentQuoteEnvelope"). The declaration term is
  // type-mapped in the declaration context (@type:@id), so it emits an
  // rdf:type n-quad and is COVERED BY THE SIGNATURE — binding the envelope
  // kind into the proof so a verifier can reject a relabeled envelope.
  // Empty preserves the earlier wire shape exactly. Mirror of the Go
  // SignVPOptions.DeclarationType field; the two signers MUST stay in
  // lock-step or the cross-language VP conformance suite breaks.
  declarationType?: string;
  // Overrides the declaration context URL written into the
  // envelope's top-level @context AND the proof block. Empty uses the
  // FulfillmentQuoteEnvelope URL (the default — settler side). A
  // PaymentRequestEnvelope (PRE) producer passes the PRE context URL so
  // the originator-side envelope carries its own declaration context.
  // Mirror of Go SignVPOptions.EnvelopeContextURL.
  envelopeContextUrl?: string;
  // Overlays additional context URL → parsed-content pairs onto
  // the loader for the sign-time canonicalization. REQUIRED when
  // envelopeContextUrl is a non-FQE URL the shared loader doesn't know (the
  // PRE URL) — without it canonicalization fails closed at sign time.
  // Omitted for the default FQE path. Mirror of Go
  // SignVPOptions.ExtraEnvelopeContexts.
  extraEnvelopeContexts?: Record<string, unknown>;
}

// signVP builds a W3C VerifiablePresentation around the supplied VCs,
// canonicalizes the document + proof options under the FulfillmentQuote
// envelope cryptosuite, and signs the resulting keccak256(proofHash ||
// docHash) digest with secp256k1. Returns the wire-shape envelope with
// a detached ES256K-R JWS in proof.jws.
//
// Holder/key relationship: the caller is responsible for ensuring the
// privateKey corresponds to options.holder and options.verificationMethod
// — signVP does NOT derive these. The verifier checks consistency.
/**
 * Signs a 32-byte digest with the holder's secp256k1 key.
 *
 * The envelope signer takes this rather than a private key so a holder whose key sits in a KMS,
 * an HSM, or a custodial provider can sign without the key entering this process. A hex key
 * would also force raw key material into a string that cannot be zeroized and is copied on
 * assignment. Mirrors the Go half's lddataintegrity.Secp256k1Signer.
 *
 * Returns 65 bytes of `r || s || v` with **v ∈ {0, 1}** — the raw recovery id. The +27
 * alignment the W3C suite expects is applied once here, and a signature whose v is already 27
 * or 28 is REFUSED: applying it twice recovers a different address, producing an envelope that
 * verifies as somebody else.
 */
export interface VPDigestSigner {
  signDigest(digest: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

export async function signVP(
  verifiableCredentials: VerifiableCredential[],
  privateKey: string,
  options: SignVPOptions
): Promise<SignedFulfillmentQuoteEnvelope> {
  // Retained for existing callers and implemented over the signer path, so both emit identical
  // bytes. Prefer signVPWithSigner.
  return signVPWithSigner(
    verifiableCredentials,
    { signDigest: (digest) => {
        const sig = new SigningKey(privateKey).sign(digest);
        const out = new Uint8Array(65);
        out.set(getBytes(sig.r), 0);
        out.set(getBytes(sig.s), 32);
        out[64] = sig.yParity;
        return out;
      } },
    options
  );
}

/**
 * Signs a VerifiablePresentation envelope with an injected signer, so the key never reaches
 * this library.
 */
export async function signVPWithSigner(
  verifiableCredentials: VerifiableCredential[],
  signer: VPDigestSigner,
  options: SignVPOptions
): Promise<SignedFulfillmentQuoteEnvelope> {
  if (!signer || typeof signer.signDigest !== "function") {
    throw new Error("signVPWithSigner: signer must implement signDigest");
  }
  return signVPWith(verifiableCredentials, options, async (hashes) =>
    normalizeVPRecoveryByte(await signer.signDigest(hashes.signingInput))
  );
}

/**
 * Signs a PaymentRequestEnvelope's holder proof in the typed form a payer's wallet produces: the
 * signer is asked for an EIP-712 signature over PaymentRequestEnvelopeProof{proofHash, docHash}
 * (`paymentRequestEnvelopeProofTypedData`), the two hashes whose keccak256(proofHash || docHash)
 * the raw form signs, so the challenge, domain, holder and credentials are bound exactly as they
 * are there. The proof options and the wire shape are the raw form's. verifyVP accepts it under
 * `acceptPaymentRequestEnvelopeTypedProof`.
 *
 * Only a PaymentRequestEnvelope is signed this way, so `options.declarationType` must name it.
 * Pass a browser wallet as an ethers `JsonRpcSigner` (eth_signTypedData_v4), or anything with the
 * same `getAddress` and `signTypedData`; its address must be the holder's. Mirrors the Go half's
 * SignVPTypedWithSigner.
 */
export async function signVPWithTypedDataSigner(
  verifiableCredentials: VerifiableCredential[],
  signer: TypedDataSigner,
  options: SignVPOptions
): Promise<SignedFulfillmentQuoteEnvelope> {
  if (!signer || typeof signer.signTypedData !== "function" || typeof signer.getAddress !== "function") {
    throw new Error("signVPWithTypedDataSigner: signer must implement getAddress and signTypedData");
  }
  if (options.declarationType !== PAYMENT_REQUEST_ENVELOPE_TYPE) {
    throw new Error(
      `signVPWithTypedDataSigner: the typed holder proof is a ${PAYMENT_REQUEST_ENVELOPE_TYPE}'s; declarationType is ${JSON.stringify(options.declarationType)}`
    );
  }
  return signVPWith(verifiableCredentials, options, async (hashes) => {
    const { signature } = await signTypedProof(
      signer,
      paymentRequestEnvelopeProofTypedData(hashes.proofHash, hashes.docHash)
    );
    return signature;
  });
}

// signVPWith is the core both forms share: `signature` returns the 65-byte r || s || v,
// v ∈ {27, 28}, over whichever digest of the envelope's hashes its form signs.
async function signVPWith(
  verifiableCredentials: VerifiableCredential[],
  options: SignVPOptions,
  signature: (hashes: { signingInput: Uint8Array; proofHash: Uint8Array; docHash: Uint8Array }) => Promise<Uint8Array>
): Promise<SignedFulfillmentQuoteEnvelope> {
  if (verifiableCredentials.length === 0) {
    throw new Error(
      "signVP: verifiableCredentials must contain at least one credential"
    );
  }
  if (!options.holder) {
    throw new Error("SignVPOptions.holder is required");
  }
  if (!options.verificationMethod) {
    throw new Error("SignVPOptions.verificationMethod is required");
  }
  if (!options.challenge) {
    throw new Error("SignVPOptions.challenge is required");
  }
  if (!options.domain) {
    throw new Error("SignVPOptions.domain is required");
  }

  const proofOptions: VPProofOptions = {
    type: "EcdsaSecp256k1RecoverySignature2020",
    created: options.created ?? new Date().toISOString(),
    verificationMethod: options.verificationMethod,
    proofPurpose: "authentication",
    challenge: options.challenge,
    domain: options.domain,
  };

  // The declaration context written into both the body and the
  // proof. Defaults to the FQE URL (settler side); a PRE producer overrides
  // it (with extraEnvelopeContexts supplying the parsed PRE context so the
  // URL resolves on the loader).
  const envelopeContextUrl =
    options.envelopeContextUrl ?? FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL;

  // Fail loudly rather than silently mint an unbound VP when a non-FQE
  // declaration type is requested without its declaration context.
  assertDeclarationContextSupplied(
    options.declarationType,
    envelopeContextUrl,
    options.extraEnvelopeContexts,
  );

  const vpBody = {
    "@context": [
      W3C_VC_V1_CONTEXT_URL,
      envelopeContextUrl,
      SECP256K1_RECOVERY_CONTEXT_URL,
    ],
    type: options.declarationType
      ? ["VerifiablePresentation", options.declarationType]
      : ["VerifiablePresentation"],
    holder: options.holder,
    verifiableCredential: verifiableCredentials,
  };

  const hashes = await hashQuote(vpBody as Record<string, unknown>, {
    cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
    proofOptions,
    keepVerifiableCredential: true,
    extraEnvelopeContexts: options.extraEnvelopeContexts,
    // The cryptosuite context alone doesn't define challenge / domain;
    // without the envelope context those replay-binding fields would
    // be silently dropped from the canonical proof n-quads, defeating
    // the whole point of the VP wrapper. Order is envelope-first so
    // its @protected definitions win over the cryptosuite's overlapping
    // (and identically-valued) entries for created / verificationMethod /
    // proofPurpose.
    proofContext: [envelopeContextUrl, SECP256K1_RECOVERY_CONTEXT_URL],
  });

  const jws = createDetachedJws(await signature(hashes));

  return {
    ...vpBody,
    proof: { ...proofOptions, jws },
  };
}

// normalizeVPRecoveryByte enforces the VPDigestSigner contract and applies the W3C
// secp256k1recovery alignment exactly once. Fails closed on a v that is already 27 or 28: a
// signer that pre-applied it would otherwise have it applied twice, and the envelope would
// recover a DIFFERENT holder — one that verifies as somebody else. The Go half rejects the
// same condition.
function normalizeVPRecoveryByte(raw: Uint8Array): Uint8Array {
  if (!(raw instanceof Uint8Array)) {
    throw new Error("signVP: signer returned a non-Uint8Array signature");
  }
  if (raw.length !== 65) {
    throw new Error(`signVP: signer returned ${raw.length} bytes, want 65 (r || s || v)`);
  }
  if (raw[64] > 1) {
    throw new Error(
      `signVP: signer returned v=${raw[64]}, want 0 or 1 (must not pre-apply the +27 alignment)`
    );
  }
  const out = Uint8Array.from(raw);
  out[64] = raw[64] + 27;
  return out;
}
