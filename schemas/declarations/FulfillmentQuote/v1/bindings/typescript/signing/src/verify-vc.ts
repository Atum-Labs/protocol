// Cryptographic verification of each embedded VC's own proof block.
// Canonical mirror of the Go canonical at
// schemas/declarations/FulfillmentQuote/v1/signing/go/verify_vc.go;
// any divergence in dispatch order, JWK-shape parsing, or per-cryptosuite
// composition would produce signature mismatches across the two
// languages. Cross-language conformance is byte-pinned by the
// vc-proof fixtures under conformance.test.ts.
//
// Lands the TS-side mirror of per-VC issuer-proof verification. Pairs with
// verifyVP's per-VC POLICY checks (date window, issuer-trust string
// match, subject-holder binding, required types) to close the
// residual threat-model gap: a compromised holder forging new VPs
// whose embedded VCs claim any trusted issuer DID. After this gate,
// a holder-key compromise downgrades to a stolen-key incident
// contained to the holder's own DID — the attacker cannot synthesise
// new VCs without the issuer's signing key.
//
// Scope (matches the Go canonical):
//   - EcdsaSecp256k1RecoverySignature2020 — recover via ethers'
//     recoverAddress, compare to the EVM-style address derived from
//     the issuer's JWK (kty=EC, crv=secp256k1, x, y).
//   - Ed25519Signature2020 — tweetnacl detached-verify against the
//     issuer's JWK (kty=OKP, crv=Ed25519, x).
//   - Any other proof.type routes to unsupportedProofType so the
//     compliance-class signal stays accurate at the perimeter.
//
// CONTRACT WITH ISSUER SIGNING: this is the verifier mirror of the
// issuer's proof-application logic. The canonicalization, hash
// composition, and signature recovery MUST stay in lockstep — any
// divergence here corrupts every signature.

import { keccak256, getBytes } from "ethers";

import {
  decodeEd25519ProofValue,
  recoverSecp256k1ProofSigner,
  verifyEd25519,
} from "@atum-labs/ld-data-integrity";

import { firstAmbiguousMember } from "@atum-labs/payment-request-sender-auth";

import { hashQuote } from "./hash.js";
import { parseDetachedJws } from "./jws.js";

// IssuerKeyResolver returns the verificationMethod set published by an
// issuer DID. Implementations are expected to cache; verifyVCProof
// calls Resolve once per VC verified.
//
// Mirror of the Go IssuerKeyResolver interface in verify_vc.go. Returns
// a non-empty VerificationMethodSet on success; an empty set or thrown
// error both route to VPVCProofError(issuerUnresolvable).
export interface IssuerKeyResolver {
  resolve(issuerDID: string): Promise<VerificationMethodSet>;
}

// VerificationMethod is a single parsed entry from a DID document's
// verificationMethod array. Order-preserved across the set so the
// first lookup hits the most-recently-published key under standard
// issuer key-rotation discipline.
export interface VerificationMethod {
  // The DID URL identifying this key — exactly the string verifyVCProof
  // matches against the VC proof's verificationMethod field
  // (e.g. "did:web:atumlabs.xyz#issuer-key-1").
  id: string;
  // JSON-LD type. MVP recognises "JsonWebKey2020" only.
  type: string;
  // JWK form of the public key. For secp256k1:
  // {kty: "EC", crv: "secp256k1", x: <base64url>, y: <base64url>}.
  // For ed25519:
  // {kty: "OKP", crv: "Ed25519", x: <base64url(32-byte pubkey)>}.
  publicKeyJwk?: Record<string, unknown>;
}

export type VerificationMethodSet = VerificationMethod[];

// VerifyVCProofOptions carries the per-call inputs verifyVCProof needs
// that aren't already on the VerificationMethod itself. The shape
// exists so future per-call options can be added without an API break.
export interface VerifyVCProofOptions {
  // Optional resolver context. The Go side requires a context.Context;
  // the TS side defers to the runtime's fetch + AbortSignal for
  // cancellation. Reserved for future per-call options.
}

// VPVCProofErrorReason mirrors the Go sentinel set in verify_vc.go.
// The perimeter-side reason-tag mapping routes each value
// to a metric label; same names, same compliance/ops bucket
// assignments. Update both sides together when adding a new reason.
export type VPVCProofErrorReason =
  | "signatureInvalid" // ErrVPVCSignatureInvalid — compliance
  | "issuerUnresolvable" // ErrVPVCIssuerUnresolvable — ops
  | "issuerKeyMismatch" // ErrVPVCIssuerKeyMismatch — compliance
  | "unsupportedProofType" // ErrVPVCUnsupportedProofType — compliance
  | "malformedQuote" // ErrMalformedQuote — input shape errors
  | "missingSignatureMaterial" // ErrMissingSignatureMaterial
  | "malformedSignatureMaterial" // ErrMalformedSignatureMaterial
  | "ambiguousMember"; // ErrAmbiguousMember — a member named twice

export class VPVCProofError extends Error {
  reason: VPVCProofErrorReason;
  constructor(reason: VPVCProofErrorReason, message: string) {
    super(message);
    this.name = "VPVCProofError";
    this.reason = reason;
  }
}

// SECP256K1_RECOVERY_CONTEXT_URL and ED25519_2020_CONTEXT_URL must
// match the canonicalize.ts exports byte-for-byte — duplicated here
// only to keep verify-vc.ts importable without circular dependencies
// when the file lands on a branch that pre-dates canonicalize.ts's
// matching exports. canonicalize.ts is the single source of truth.
const SECP256K1_RECOVERY_2020_V2_CONTEXT_URL =
  "https://w3id.org/security/suites/secp256k1recovery-2020/v2";
const ED25519_2020_V1_CONTEXT_URL =
  "https://w3id.org/security/suites/ed25519-2020/v1";

const ProofTypeSecp256k1Recovery2020 = "EcdsaSecp256k1RecoverySignature2020";
const ProofTypeEd25519Signature2020 = "Ed25519Signature2020";

// verifyVCProof cryptographically verifies a VC's proof block against
// the issuer's published key, resolved via the supplied
// IssuerKeyResolver. Dispatches on proof.type; reuses the existing
// hashQuote primitive for canonicalization.
//
// `vc` is the parsed wire JSON of the VC — the marshal source of
// truth for canonicalization. Pass the verbatim wire bytes (parsed
// once) so the canonicalization input never round-trips through a
// typed binding's marshal output (which can introduce silent drift
// — same constraint the Go canonical pins via the rawVC parameter).
//
// Resolves on a passing signature. Throws VPVCProofError otherwise.
//
// SCOPE — what this function does and does NOT verify (mirror of the Go
// canonical's same SECURITY NOTE):
//
// verifyVCProof verifies cryptographic integrity over the canonical
// n-quads produced by URDNA2015. It does NOT verify claim-binding
// completeness — whether every JSON field in the VC actually appears
// in the signed n-quads. That's a separate property owned by the VC's
// @context array and the issuer's contract on which terms are bound.
//
// The asymmetry between the document-loader's strictness
// (canonicalize.ts rejects unknown CONTEXT URLs — strict-fail-closed)
// and JSON-LD expansion's silent-drop of unknown TERMS inside a known
// context is load-bearing: a producer can attach a claim field under
// a context that doesn't bind it; URDNA2015 silently elides the
// field; the signed n-quads cover the BOUND terms only. The signature
// mathematically verifies; an attacker flipping an unbound field
// produces a still-mathematically-valid VC. The verifier cannot
// detect that — it has no way to distinguish "field was dropped
// during expansion" from "field was absent in the first place."
//
// The known-to-atum context closes this gap for the terms atum-issued
// credentials actually use:
//
//   - `KnownToAtumVerifiableCredential` @type alias — bound to a
//     stable IRI in the known-to-atum v1 context. Before it was bound
//     this diverged cross-language (json-gold vs jsonld.js handled the
//     unbound alias differently); once bound it appears in the
//     canonical n-quads on both sides identically.
//   - `role` term + role values (`settler`, `psp`,
//     `atumOperatedService`) — the actual claim the production
//     issuer emits on credentialSubject. Bound under `kta:` so a
//     role-flip is signature-detectable. The known-to-atum v2
//     context also binds `quoteAwarder` and `merchant`, which v1
//     does not: under v1 those two roles are outside the signed
//     bytes, so a caller should trust either only from a v2
//     credential. verifyVCProof does not check this.
//   - `knownToAtum` boolean field — defensively bound (xsd:boolean).
//     Production credentials don't emit this field today; the
//     binding is future-proofing so an issuer code change that does
//     start emitting it won't silently un-attest the claim.
//
// Residual: a future producer that introduces a NEW claim field
// under a context that doesn't bind it (e.g. a brand-new attribute
// not yet vendored into known-to-atum v1) is still subject to the
// silent-drop semantic. The mitigation is the same as for any
// schema-evolution event: extend the context binding alongside the
// issuer-code change. The `knownToAtum field binding`
// describe block (TS + Go twin) and the conformance tests' load-
// bearing-predicate-presence assertions catch any binding regression
// at CI time before it ships to production.
export async function verifyVCProof(
  vc: Record<string, unknown>,
  resolver: IssuerKeyResolver,
  _opts: VerifyVCProofOptions = {}
): Promise<void> {
  // Refused before any read, as Go's VerifyVCProof refuses it.
  const ambiguous = firstAmbiguousMember(JSON.stringify(vc));
  if (ambiguous !== undefined) {
    throw new VPVCProofError(
      "ambiguousMember",
      `verifyVCProof: the credential names a member twice, differing only in letter case, at ${ambiguous}`
    );
  }
  if (!resolver) {
    throw new VPVCProofError(
      "malformedQuote",
      "verifyVCProof: resolver is required"
    );
  }

  const proof = vc.proof;
  if (!proof || typeof proof !== "object") {
    throw new VPVCProofError(
      "malformedQuote",
      "verifyVCProof: vc.proof is missing or not an object"
    );
  }
  const proofObj = proof as Record<string, unknown>;

  const issuerDID = vcIssuerDID(vc);
  let vmSet: VerificationMethodSet;
  try {
    vmSet = await resolver.resolve(issuerDID);
  } catch (err) {
    throw new VPVCProofError(
      "issuerUnresolvable",
      `verifyVCProof: resolver: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!vmSet || vmSet.length === 0) {
    throw new VPVCProofError(
      "issuerUnresolvable",
      `verifyVCProof: resolver returned empty verificationMethod set for ${JSON.stringify(issuerDID)}`
    );
  }

  const proofType = stringField(proofObj, "type");
  const verificationMethodURL = stringField(proofObj, "verificationMethod");

  const vm = vmSet.find((entry) => entry.id === verificationMethodURL);
  if (!vm) {
    throw new VPVCProofError(
      "issuerKeyMismatch",
      `verifyVCProof: proof.verificationMethod ${JSON.stringify(verificationMethodURL)} not in issuer ${JSON.stringify(issuerDID)}'s published key set`
    );
  }

  // Mirrored from the Go side:
  // validate proof.@context matches the proof.type cryptosuite before
  // invoking the canonicalizer. The proof.@context value comes
  // verbatim off the wire; URDNA2015 only validates that the URL
  // resolves to a registered context, NOT that the context is the
  // *right* one for the proof type. An attacker pairing a secp256k1
  // proof.type with the ed25519 cryptosuite @context could canonical-
  // ize under different term bindings — defeated today by the
  // verificationMethod URL gate, but pinning the suite/@context
  // coherence makes the contract explicit and grep-able.
  requireProofContextMatchesSuite(proofType, proofObj);

  if (proofType === ProofTypeSecp256k1Recovery2020) {
    return await verifyVCProofSecp256k1(vc, proofObj, vm);
  }
  if (proofType === ProofTypeEd25519Signature2020) {
    return await verifyVCProofEd25519(vc, proofObj, vm);
  }
  throw new VPVCProofError(
    "unsupportedProofType",
    `verifyVCProof: proof.type ${JSON.stringify(proofType)} not supported`
  );
}

async function verifyVCProofSecp256k1(
  vc: Record<string, unknown>,
  proof: Record<string, unknown>,
  vm: VerificationMethod
): Promise<void> {
  if (vm.type !== "JsonWebKey2020") {
    throw new VPVCProofError(
      "unsupportedProofType",
      `verifyVCProofSecp256k1: verificationMethod.type ${JSON.stringify(vm.type)} not supported (want JsonWebKey2020)`
    );
  }

  const jwsRaw = stringField(proof, "jws");
  const { signature } = parseDetachedJws(jwsRaw);
  if (signature.length !== 65) {
    throw new VPVCProofError(
      "malformedSignatureMaterial",
      `verifyVCProofSecp256k1: JWS signature length = ${signature.length}, want 65`
    );
  }

  const hashes = await hashQuote(stripProof(vc), {
    cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
    proofOptions: {
      type: ProofTypeSecp256k1Recovery2020,
      created: stringField(proof, "created"),
      verificationMethod: stringField(proof, "verificationMethod"),
      proofPurpose: stringField(proof, "proofPurpose"),
    },
    keepVerifiableCredential: false,
    proofContext:
      proof["@context"] ?? SECP256K1_RECOVERY_2020_V2_CONTEXT_URL,
  });

  const expected = jwkSecp256k1ToAddress(vm.publicKeyJwk);
  let recovered: string;
  try {
    recovered = recoverSecp256k1ProofSigner(
      hashes,
      signature,
      (a) => a.toLowerCase() === expected
    ).toLowerCase();
  } catch (err) {
    throw new VPVCProofError(
      "signatureInvalid",
      `verifyVCProofSecp256k1: signature recovery failed: ${String(err)}`
    );
  }

  if (recovered !== expected) {
    throw new VPVCProofError(
      "signatureInvalid",
      `verifyVCProofSecp256k1: recovered signer ${recovered} != issuer key ${expected}`
    );
  }
}

async function verifyVCProofEd25519(
  vc: Record<string, unknown>,
  proof: Record<string, unknown>,
  vm: VerificationMethod
): Promise<void> {
  if (vm.type !== "JsonWebKey2020") {
    throw new VPVCProofError(
      "unsupportedProofType",
      `verifyVCProofEd25519: verificationMethod.type ${JSON.stringify(vm.type)} not supported (want JsonWebKey2020)`
    );
  }

  const pubKey = jwkEd25519ToPublicKey(vm.publicKeyJwk);

  const proofValue = stringField(proof, "proofValue");
  if (!proofValue.startsWith("z")) {
    throw new VPVCProofError(
      "malformedSignatureMaterial",
      `verifyVCProofEd25519: proof.proofValue prefix = ${JSON.stringify(proofValue.slice(0, 1))}, want "z"`
    );
  }
  // decodeEd25519ProofValue enforces the z-prefix, base58 decodability,
  // and the 64-byte length invariant — wrap its MalformedProofError in
  // our domain error so the reason code stays "malformedSignatureMaterial"
  // (the lib throws a typed-but-untagged error otherwise).
  let signature: Uint8Array;
  try {
    signature = decodeEd25519ProofValue(proofValue);
  } catch (err) {
    throw new VPVCProofError(
      "malformedSignatureMaterial",
      `verifyVCProofEd25519: ${String(err)}`
    );
  }

  const { signingInput } = await hashQuote(stripProof(vc), {
    cryptosuite: "Ed25519Signature2020",
    proofOptions: {
      type: ProofTypeEd25519Signature2020,
      created: stringField(proof, "created"),
      verificationMethod: stringField(proof, "verificationMethod"),
      proofPurpose: stringField(proof, "proofPurpose"),
    },
    keepVerifiableCredential: false,
    proofContext: proof["@context"] ?? ED25519_2020_V1_CONTEXT_URL,
  });

  try {
    verifyEd25519(pubKey, signingInput, signature);
  } catch {
    throw new VPVCProofError(
      "signatureInvalid",
      `verifyVCProofEd25519: ed25519 signature rejected for verificationMethod ${JSON.stringify(stringField(proof, "verificationMethod"))}`
    );
  }
}

// jwkSecp256k1ToAddress mirrors verify_vc.go's jwkSecp256k1ToAddress:
// reconstruct the 65-byte uncompressed pubkey (0x04 || X || Y) from
// the JWK, drop the 0x04 prefix, Keccak256 the trailing 64 bytes, take
// the last 20 bytes. Returns the lowercase 0x-prefixed hex form so the
// recovered address (also lowercased) compares directly.
function jwkSecp256k1ToAddress(jwk: Record<string, unknown> | undefined): string {
  if (!jwk) {
    throw new VPVCProofError(
      "malformedQuote",
      "publicKeyJwk is missing"
    );
  }
  if (jwk.kty !== "EC") {
    throw new VPVCProofError(
      "malformedQuote",
      `publicKeyJwk.kty = ${JSON.stringify(jwk.kty)}, want EC`
    );
  }
  if (jwk.crv !== "secp256k1") {
    throw new VPVCProofError(
      "malformedQuote",
      `publicKeyJwk.crv = ${JSON.stringify(jwk.crv)}, want secp256k1`
    );
  }
  const xStr = jwk.x;
  const yStr = jwk.y;
  if (typeof xStr !== "string" || typeof yStr !== "string") {
    throw new VPVCProofError(
      "malformedQuote",
      "publicKeyJwk missing x or y coordinate"
    );
  }
  const x = base64UrlDecode(xStr);
  const y = base64UrlDecode(yStr);
  if (x.length !== 32 || y.length !== 32) {
    throw new VPVCProofError(
      "malformedQuote",
      `publicKeyJwk x/y must be 32 bytes each, got x=${x.length} y=${y.length}`
    );
  }
  const xy = new Uint8Array(64);
  xy.set(x, 0);
  xy.set(y, 32);
  const digest = getBytes(keccak256(xy));
  return "0x" + Buffer.from(digest.slice(12)).toString("hex");
}

// jwkEd25519ToPublicKey mirrors verify_vc.go's jwkEd25519ToPublicKey.
// JWK shape per RFC 8037 §2: kty=OKP, crv=Ed25519, x=base64url-encoded
// 32-byte pubkey.
function jwkEd25519ToPublicKey(jwk: Record<string, unknown> | undefined): Uint8Array {
  if (!jwk) {
    throw new VPVCProofError("malformedQuote", "publicKeyJwk is missing");
  }
  if (jwk.kty !== "OKP") {
    throw new VPVCProofError(
      "malformedQuote",
      `publicKeyJwk.kty = ${JSON.stringify(jwk.kty)}, want OKP`
    );
  }
  if (jwk.crv !== "Ed25519") {
    throw new VPVCProofError(
      "malformedQuote",
      `publicKeyJwk.crv = ${JSON.stringify(jwk.crv)}, want Ed25519`
    );
  }
  const xStr = jwk.x;
  if (typeof xStr !== "string" || xStr === "") {
    throw new VPVCProofError(
      "malformedQuote",
      "publicKeyJwk missing x coordinate"
    );
  }
  const x = base64UrlDecode(xStr);
  if (x.length !== 32) {
    throw new VPVCProofError(
      "malformedQuote",
      `publicKeyJwk.x must be 32 bytes, got ${x.length}`
    );
  }
  return x;
}

// requireProofContextMatchesSuite asserts the wire VC's proof.@context
// resolves to the cryptosuite expected for the declared proof.type.
// Mirror of verify_vc.go's requireProofContextMatchesSuite.
function requireProofContextMatchesSuite(
  proofType: string,
  proof: Record<string, unknown>
): void {
  const wanted = suiteContextURL(proofType);
  if (!wanted) {
    throw new VPVCProofError(
      "unsupportedProofType",
      `verifyVCProof: cannot derive cryptosuite context for proof.type ${JSON.stringify(proofType)}`
    );
  }
  const ctx = proof["@context"];
  if (ctx === undefined || ctx === null) {
    return; // hashQuote's suite-default applies; safe.
  }
  if (typeof ctx === "string") {
    if (ctx !== wanted) {
      throw new VPVCProofError(
        "unsupportedProofType",
        `verifyVCProof: proof.@context ${JSON.stringify(ctx)} does not match cryptosuite ${JSON.stringify(proofType)} (expected ${JSON.stringify(wanted)})`
      );
    }
    return;
  }
  if (Array.isArray(ctx)) {
    for (const entry of ctx) {
      if (entry === wanted) return;
    }
    throw new VPVCProofError(
      "unsupportedProofType",
      `verifyVCProof: proof.@context array does not include cryptosuite ${JSON.stringify(proofType)} (expected ${JSON.stringify(wanted)})`
    );
  }
  throw new VPVCProofError(
    "unsupportedProofType",
    `verifyVCProof: proof.@context has unexpected JSON-LD shape ${typeof ctx}`
  );
}

function suiteContextURL(proofType: string): string {
  switch (proofType) {
    case ProofTypeSecp256k1Recovery2020:
      return SECP256K1_RECOVERY_2020_V2_CONTEXT_URL;
    case ProofTypeEd25519Signature2020:
      return ED25519_2020_V1_CONTEXT_URL;
    default:
      return "";
  }
}

function vcIssuerDID(vc: Record<string, unknown>): string {
  const issuer = vc.issuer;
  if (typeof issuer === "string" && issuer !== "") return issuer;
  if (issuer && typeof issuer === "object" && !Array.isArray(issuer)) {
    const id = (issuer as Record<string, unknown>).id;
    if (typeof id === "string" && id !== "") return id;
  }
  throw new VPVCProofError(
    "malformedQuote",
    "vc.issuer is missing or not a string/object-with-id"
  );
}

function stripProof(vc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(vc)) {
    if (key === "proof") continue;
    out[key] = vc[key];
  }
  return out;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v === "") {
    throw new VPVCProofError(
      "malformedQuote",
      `field ${JSON.stringify(key)} is missing or not a non-empty string`
    );
  }
  return v;
}

function base64UrlDecode(s: string): Uint8Array {
  // Node 16+ Buffer supports "base64url"; fall back via padding if not.
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const normal = padded.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(normal, "base64"));
}
