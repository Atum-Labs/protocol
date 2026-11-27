// Verifier for FulfillmentQuoteEnvelope-shaped W3C VerifiablePresentations.
// Mirror of the Go canonical at
// schemas/declarations/FulfillmentQuote/v1/signing/go/verify_vp.go;
// any divergence in dispatch order, error-fail-closed posture, or
// per-cryptosuite rules would let one verifier on the network accept a
// VP the other rejects — the failure mode this symmetry contract pins.
//
// The signing-input reconstruction goes through hashQuote with
// keepVerifiableCredential: true and the envelope+cryptosuite multi-
// context for the proof block — see sign-vp.ts for the signer side of
// the same contract.
//
// SECURITY NOTE:
//
// verifyVP cryptographically verifies the OUTER VP holder signature
// and applies POLICY checks on each embedded VerifiableCredential
// (date window, issuer-in-trust-anchors, required types, and — when
// it lands cross-language — the subject-holder binding).
//
// When the caller supplies a `verifyVCProofs` resolver (parity with
// the Go canonical's `VerifyVCProofs IssuerKeyResolver`),
// verifyVP ALSO cryptographically verifies each embedded VC's own
// `proof` block (`jws` for secp256k1, `proofValue` for ed25519)
// against the issuer's published `verificationMethod` key resolved
// via `did:web`. Without the resolver, the trust gate is the
// the earlier string-match-on-issuer-DID only.
//
// Residual threat-model with the resolver in place:
//   - The combined gate is: string-match on `vc.issuer` against
//     trust anchors AND cryptographic verification of the VC's own
//     proof under the resolved issuer key. Both must pass.
//   - Forging new VCs under a trusted issuer DID requires direct
//     compromise of the issuer's KMS signing key — the issuer-side
//     trust contract Atum-ID inherently rests on. Cross-holder VC
//     theft is closed once the subject-holder binding
//     lands cross-language.
//   - did:web resolution trusts DNS + TLS + the issuer's web origin.
//     Operators SHOULD pin the highest-trust issuer DIDs via the
//     `DID_WEB_RESOLVER_OVERRIDES` env-var mechanism in
//     `did-web-resolver.ts` for production deployments.
//   - Audit mode (`vc_signature_verification.mode=audit` on the
//     verifier side; the TS verifier's parallel is opting OUT of
//     `verifyVCProofs`) is the canonical pre-rollout safety valve.

import bs58 from "bs58";
import nacl from "tweetnacl";

import {
  PAYMENT_REQUEST_ENVELOPE_TYPE,
  paymentRequestEnvelopeProofTypedDigest,
  recoverSecp256k1ProofSignerFrom,
  settlerProofTypedDigest,
  type TypedProofDigest,
} from "@atum-labs/ld-data-integrity";
import { firstAmbiguousMember } from "@atum-labs/payment-request-sender-auth";

import { hashQuote, type Cryptosuite } from "./hash.js";
import { parseDetachedJws } from "./jws.js";
import { decodeStellarAccount, encodeStellarAccount } from "./strkey.js";
import { verifyVCProof, type IssuerKeyResolver } from "./verify-vc.js";
import { newReservedTypeMatcher } from "./reserved-types.js";
import {
  assertDeclarationContextSupplied,
  fqLoader,
  FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
  SECP256K1_RECOVERY_CONTEXT_URL,
  ED25519_2020_CONTEXT_URL,
} from "./canonicalize.js";

// W3C VC Data Model v1.1 §5.6 mandates "authentication" for
// VerifiablePresentation proofs — the holder is authenticating themselves
// as the presenter, distinct from the "assertionMethod" the inner FQ
// proof uses.
const expectedVPProofPurpose = "authentication";

const multibaseBase58btcPrefix = "z";

// IsIssuerTrustedFunc is the trust-anchor probe verifyVP calls for each
// embedded VC's issuer DID. Returns (allowed, enforced) — verifyVP
// rejects when allowed=false AND enforced=true (strict mode); other
// combinations are pass-through. Mirrors trustedissuers.Service.IsTrusted
// (the trusted-issuers service).
export type IsIssuerTrustedFunc = (issuerDID: string) => {
  allowed: boolean;
  enforced: boolean;
};

export interface VerifyVPOptions {
  // ExpectedChallenge MUST equal proof.challenge. Cross-auction replay
  // binding: the bid's request_id propagated by the requester perimeter
  // → downstream verifier → settler.
  expectedChallenge: string;
  // ExpectedDomain MUST equal proof.domain. Cross-environment replay
  // binding: the verifier's configured service identifier (e.g.
  // did:web:settler.atum.network).
  expectedDomain: string;
  // ExpectedHolder MUST equal envelope.holder. The caller derives this
  // from the inner FQ verifier's recovered signer (chain-canonical
  // did:pkh form).
  expectedHolder: string;
  // Freshness anchor — REQUIRED. Tests pin a fixed instant; production
  // passes new Date(). verifyVP throws when this is undefined. The
  // previous "undefined disables the check" semantic was a fail-open
  // hazard: a caller forgetting `now` silently disabled freshness with
  // no signal.
  now: Date;
  // Upper bound on (now - proof.created) in ms. Zero or undefined
  // disables the past-freshness check (audit-only callers may
  // legitimately accept arbitrarily old proofs).
  maxProofAgeMs?: number;
  // Upper bound on (proof.created - now) in ms. Default 0 means
  // "reject any future-dated proof" — the safe posture for a forgery
  // indicator. Widening requires an explicit clock-skew budget.
  // Asymmetric with maxProofAgeMs by design.
  maxFutureSkewMs?: number;
  // VC types at least one verified VC must declare. Empty disables the
  // type check.
  requiredVCTypes?: string[];
  // Credential types only trusted issuers may issue. A VC declaring one of
  // them, or one of requiredVCTypes, walks every per-VC check:
  // subject-holder binding, date window, issuer trust and, when
  // verifyVCProofs is supplied, its own proof. A VC claiming a reserved
  // type from an issuer outside the trust list is refused as before.
  //
  // Any other VC is the counterparties' to judge: the presentation carries
  // it to the parties who decide whom they trust as an issuer. It is passed
  // through untouched (no issuer-trust check, no issuer resolution or proof
  // verification, no subject-holder binding, no date-window check),
  // returned in VPResult.passThroughClaims and never in attestedClaims, and
  // it never satisfies requiredVCTypes. The holder's signature over the
  // whole presentation still covers it.
  //
  // The reserved set is reservedVCTypes together with requiredVCTypes.
  // Undefined or empty, it is requiredVCTypes alone; when both are empty
  // every VC walks every check, as before. Mirror of Go
  // VerifyVPOptions.ReservedVCTypes.
  //
  // Types are matched on what they mean, not on how they are spelled: a VC
  // whose type is a reserved name, a JSON-LD spelling of the IRI a reserved
  // name stands for (the full IRI, a compact `prefix:` form, a context term
  // aliasing it), or a type that can't be resolved to an absolute IRI at
  // all, is reserved and checked. See reserved-types.ts.
  reservedVCTypes?: string[];
  // Cap on envelope.verifiableCredential length. Schema enforces
  // minItems: 1 but no maxItems; an attacker submitting a 10k-VC bid
  // would amplify URDNA2015 cost into a DoS. Zero or undefined disables
  // the bound (production callers SHOULD set this — recommend ~16).
  maxVerifiableCredentials?: number;
  // Trust-anchor gate. Undefined disables the check (matches
  // trustedissuers.ModeDisabled). enforced=true rejects untrusted
  // issuers; enforced=false is audit/permissive pass-through.
  isIssuerTrusted?: IsIssuerTrustedFunc;
  // Optional correlation identifier echoed in error messages so an
  // operator triaging "VP verification failed" at 3am can tie the
  // failure back to a specific bid without log diving. Sourced by the
  // perimeter from the bid's payment_id. Not used in any
  // cryptographic computation — pure log-correlation.
  requestId?: string;
  // When supplied, verifyVP cryptographically verifies
  // each embedded VC's own proof block against the issuer's
  // published verificationMethod key (resolved via this resolver).
  // Undefined opts out — matches the Go canonical's
  // `VerifyVCProofs IssuerKeyResolver` contract. Production callers
  // wire `did-web-resolver.ts`'s `DIDWebResolver` instance here.
  verifyVCProofs?: IssuerKeyResolver;
  // When non-empty, assert the signed envelope's `type` array
  // contains this declaration term (e.g. "PaymentRequestEnvelope") so a
  // relabeled envelope is rejected. Empty keeps the earlier behavior.
  // Mirror of Go VerifyVPOptions.ExpectedDeclarationType.
  expectedDeclarationType?: string;
  // The declaration context URL the proof was canonicalized
  // under, used as the default when proof.@context is absent. Empty uses the
  // FulfillmentQuoteEnvelope URL; a PRE verifier passes the PRE URL. Mirror
  // of Go VerifyVPOptions.EnvelopeContextURL.
  envelopeContextUrl?: string;
  // Per-call loader overlay (URL → parsed context) so a non-FQE
  // declaration context (the PRE context) resolves under the strict
  // no-network loader. REQUIRED when verifying an envelope whose context the
  // shared loader doesn't know. Mirror of Go VerifyVPOptions.ExtraEnvelopeContexts.
  extraEnvelopeContexts?: Record<string, unknown>;
  // The JSON-LD contexts of credentials that are not Atum's, so a
  // presentation can carry them to the counterparties: context URL → parsed
  // context document. The loader never fetches a context, so a credential
  // whose @context names a URL that is neither bundled nor supplied here makes
  // the whole presentation fail canonicalization. The caller supplies each
  // document as content it holds and pins, never as a URL to fetch.
  //
  // Overlaid on the per-call loader together with extraEnvelopeContexts, for
  // the holder signature and for reserved-type matching. A key that equals a
  // bundled context URL or an extraEnvelopeContexts key is refused before
  // anything is verified, so a supplied context can never replace one of
  // Atum's; a term it defines that stands for a reserved type's IRI makes the
  // credential reserved. Mirror of Go VerifyVPOptions.ExtraCredentialContexts.
  extraCredentialContexts?: Record<string, unknown>;
  // Also accept a secp256k1 holder proof in the typed form a payer's wallet signs: a signature
  // over the EIP-712 digest of PaymentRequestEnvelopeProof{proofHash, docHash}, the same two
  // hashes the raw form signs as keccak256(proofHash || docHash), so it binds the same challenge,
  // domain, holder and credentials. Taken only for an envelope whose signed `type` declares
  // PaymentRequestEnvelope, and only when it recovers the holder. Off, a PaymentRequestEnvelope's
  // holder proof verifies only in the raw form. An envelope that doesn't declare it takes the raw
  // form or `SettlerProof`, as before. A verifier of originator envelopes sets it; nothing else
  // should. Mirror of Go VerifyVPOptions.AcceptPaymentRequestEnvelopeTypedProof.
  acceptPaymentRequestEnvelopeTypedProof?: boolean;
}

export interface VPResult {
  // Bare did:pkh URI parsed from envelope.holder (no #fragment).
  holder: string;
  // Verified proof type.
  cryptosuite: Cryptosuite;
  // 0x-prefixed lowercase EVM-style address recovered from the JWS
  // when cryptosuite is EcdsaSecp256k1RecoverySignature2020; "" for
  // ed25519.
  signerAddress: string;
  // 32-byte ed25519 public key parsed from the verificationMethod when
  // cryptosuite is Ed25519Signature2020; null for secp256k1.
  ed25519PublicKey: Uint8Array | null;
  // Network segment of the holder DID ("namespace:reference" form, e.g.
  // "eip155:1", "tron:mainnet", "solana:devnet"). Caller-side chain-
  // canonical comparison reads this rather than re-parsing the holder.
  didNetwork: string;
  // proof.created as parsed by the Date constructor.
  created: Date;
  // VCs that passed verifyVP's policy checks. See the top-of-file
  // SECURITY NOTE — when the caller supplied a `verifyVCProofs`
  // resolver, every VC in this slice ALSO had its proof
  // cryptographically verified against the issuer's published key.
  attestedClaims: unknown[];
  // VCs passed through unchecked because they declare none of the reserved
  // types (see VerifyVPOptions.reservedVCTypes), in envelope order and as
  // they arrived. Nothing about them was verified beyond the holder's
  // signature over the presentation. Empty when there is no reserved set or
  // every VC declares a reserved type. Mirror of Go VPResult.PassThroughClaims.
  passThroughClaims: unknown[];
  // Count of VCs whose cryptographic proof was verified.
  // Zero indicates the verifyVCProofs path did not run (caller
  // opted out by leaving the resolver undefined). Non-zero is a
  // positive signal: crypto verification was exercised. Mirrors
  // the Go canonical's `VCProofsVerifiedCount` field.
  vcProofsVerifiedCount: number;
}

// verifyVP cryptographically verifies a FulfillmentQuoteEnvelope's holder
// signature and applies replay-binding, freshness, and VC-policy checks.
// Dispatches on proof.type; secp256k1 + ed25519 paths are handled in
// parallel to the Go canonical.
export async function verifyVP(
  signedEnvelope: string | Record<string, unknown>,
  options: VerifyVPOptions
): Promise<VPResult> {
  // Correlation-ID rewrap. The format of requestId is the CALLER's
  // responsibility — this library doesn't own the requester's id schema,
  // and a malformed-format failure here would surface as a misleading
  // proof-malformed reason at the operator dashboard. Callers MUST
  // validate the charset/length at their perimeter before invoking
  // verifyVP (the gRPC bid perimeter does this at the downstream verifier).
  try {
    return await verifyVPInner(signedEnvelope, options);
  } catch (e) {
    // Rewrap: when requestId is set, prefix the error so an operator
    // can tie failures back to a specific bid. Preserve the original
    // via `cause` so callers can still inspect / errors.Is-equivalent.
    if (options.requestId) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`[request_id=${options.requestId}] ${msg}`, {
        cause: e,
      });
    }
    throw e;
  }
}

async function verifyVPInner(
  signedEnvelope: string | Record<string, unknown>,
  options: VerifyVPOptions
): Promise<VPResult> {
  if (!options.expectedChallenge) {
    throw new Error("verifyVP: options.expectedChallenge is required");
  }
  if (!options.expectedDomain) {
    throw new Error("verifyVP: options.expectedDomain is required");
  }
  if (!options.expectedHolder) {
    throw new Error("verifyVP: options.expectedHolder is required");
  }
  checkExtraCredentialContexts(options);

  // Refused before anything reads the envelope, as Go's VerifyVP refuses it.
  // A member named twice, exactly or under the case folding Go's encoding/json
  // applies, would have the two verifiers read different members, and only the
  // exact names a context defines are signed. The text is scanned before
  // JSON.parse, which keeps only the last of two exact duplicates.
  const text = typeof signedEnvelope === "string" ? signedEnvelope : JSON.stringify(signedEnvelope);
  const ambiguous = firstAmbiguousMember(text);
  if (ambiguous !== undefined) {
    throw new Error(
      `verifyVP: the envelope names a member twice, exactly or differing only in letter case, at ${ambiguous}`
    );
  }

  const doc =
    typeof signedEnvelope === "string"
      ? (JSON.parse(signedEnvelope) as Record<string, unknown>)
      : signedEnvelope;

  const proof = doc.proof as Record<string, unknown> | undefined;
  if (!proof) {
    throw new Error("verifyVP: missing proof block");
  }

  const proofPurpose = stringField(proof, "proofPurpose");
  if (proofPurpose !== expectedVPProofPurpose) {
    throw new Error(
      `verifyVP: proof.proofPurpose = ${JSON.stringify(proofPurpose)}, want ${JSON.stringify(expectedVPProofPurpose)}`
    );
  }

  const holder = stringField(doc, "holder");
  if (!holderEquals(holder, options.expectedHolder)) {
    // Split-aware compare — case-insensitive on did:pkh:<namespace>:<reference>
    // prefix, exact on the address segment. Flat toLowerCase would silently
    // match different Solana / Tron accounts (base58 IS case-sensitive); see
    // holderEquals' doc.
    throw new Error(
      `verifyVP: envelope.holder ${JSON.stringify(holder)} does not match ExpectedHolder ${JSON.stringify(options.expectedHolder)}`
    );
  }

  const challenge = stringField(proof, "challenge");
  if (challenge !== options.expectedChallenge) {
    throw new Error(
      `verifyVP: proof.challenge ${JSON.stringify(challenge)} does not match ExpectedChallenge ${JSON.stringify(options.expectedChallenge)} (cross-auction replay binding)`
    );
  }
  const domain = stringField(proof, "domain");
  if (domain !== options.expectedDomain) {
    throw new Error(
      `verifyVP: proof.domain ${JSON.stringify(domain)} does not match ExpectedDomain ${JSON.stringify(options.expectedDomain)} (cross-environment replay binding)`
    );
  }

  const createdStr = stringField(proof, "created");
  const created = new Date(createdStr);
  if (Number.isNaN(created.getTime())) {
    throw new Error(`verifyVP: proof.created not parseable as a date: ${JSON.stringify(createdStr)}`);
  }
  // Now is REQUIRED — see the field doc. Previous `if (options.now)`
  // skip-on-undefined was a fail-open hazard.
  if (!options.now) {
    throw new Error("verifyVP: options.now is required (fail-closed freshness)");
  }
  const ageMs = options.now.getTime() - created.getTime();
  if ((options.maxProofAgeMs ?? 0) > 0 && ageMs > (options.maxProofAgeMs ?? 0)) {
    throw new Error(`verifyVP: proof.created ${created.toISOString()} older than maxProofAgeMs=${options.maxProofAgeMs}`);
  }
  // maxFutureSkewMs always fires — default 0 = strict (any future proof rejected).
  const skewMs = -ageMs;
  if (skewMs > (options.maxFutureSkewMs ?? 0)) {
    throw new Error(`verifyVP: proof.created ${created.toISOString()} exceeds maxFutureSkewMs=${options.maxFutureSkewMs ?? 0}`);
  }

  // VC array cap — gated BEFORE canonicalization. An attacker submitting
  // a 10k-VC envelope would amplify URDNA2015 cost into a DoS. Reject
  // early.
  const vcs = doc.verifiableCredential;
  // Default cap when caller passes 0/undefined — mirrors the Go
  // canonical's defaultMaxVerifiableCredentials = 16. Operators that
  // genuinely need a higher cap raise this explicitly; the previous
  // "zero = unlimited" posture was a fail-open foot-gun.
  const maxVCs = (options.maxVerifiableCredentials ?? 0) > 0 ? options.maxVerifiableCredentials! : 16;
  if (Array.isArray(vcs) && vcs.length > maxVCs) {
    throw new Error(
      `verifyVP: envelope.verifiableCredential length ${vcs.length} exceeds maxVerifiableCredentials ${maxVCs}`
    );
  }

  // `type` is an array of strings, or null. Go decodes it as a []string and refuses any other
  // shape while decoding, a bare string included. JSON-LD reads a bare string like a one-element
  // array, so both forms sign the same hash, but the declaration checks below and the choice of
  // typed holder proof read only the array. Refusing the other shapes here keeps the two
  // verifiers on the same envelopes.
  if (
    !("type" in doc) ||
    (doc.type !== null &&
      !(Array.isArray(doc.type) && (doc.type as unknown[]).every((t) => typeof t === "string")))
  ) {
    throw new Error("verifyVP: envelope.type must be an array of strings");
  }

  // Declaration-type binding. When the caller expects a specific
  // envelope kind (e.g. "PaymentRequestEnvelope"), the signed `type` array
  // MUST carry it. The term is signature-covered (an rdf:type n-quad), so
  // this rejects an envelope relabeled after signing. Empty keeps the
  // earlier behavior. Mirror of Go verifyVP's ExpectedDeclarationType.
  if (options.expectedDeclarationType) {
    const declTypes = Array.isArray(doc.type) ? (doc.type as unknown[]) : [];
    if (!declTypes.includes(options.expectedDeclarationType)) {
      throw new Error(
        `verifyVP: envelope.type ${JSON.stringify(doc.type)} does not contain expectedDeclarationType ${JSON.stringify(options.expectedDeclarationType)} (declaration-type binding)`
      );
    }
    // A non-FQE expected type needs its declaration context overlaid, or
    // canonicalization fails downstream with an opaque jsonld "Dereferencing a
    // URL" error. Surface a clear precondition instead (fails closed either
    // way; this only improves the diagnostic).
    assertDeclarationContextSupplied(
      options.expectedDeclarationType,
      options.envelopeContextUrl ?? FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
      options.extraEnvelopeContexts,
    );
  }

  const proofType = stringField(proof, "type");
  if (proofType === "EcdsaSecp256k1RecoverySignature2020") {
    return await verifyVPSecp256k1(doc, proof, holder, created, options);
  }
  if (proofType === "Ed25519Signature2020") {
    return await verifyVPEd25519(doc, proof, holder, created, options);
  }
  throw new Error(`verifyVP: unsupported proof.type ${JSON.stringify(proofType)}`);
}

// recoverHolder is the thin convenience wrapper for callers that only
// want the recovered holder DID (e.g. for trust-anchor lookups). All
// VPResult fields are still produced internally; the wrapper just
// projects.
export async function recoverHolder(
  signedEnvelope: string | Record<string, unknown>,
  options: VerifyVPOptions
): Promise<string> {
  const res = await verifyVP(signedEnvelope, options);
  return res.holder;
}

async function verifyVPSecp256k1(
  doc: Record<string, unknown>,
  proof: Record<string, unknown>,
  holder: string,
  created: Date,
  options: VerifyVPOptions
): Promise<VPResult> {
  const jws = stringField(proof, "jws");
  const verificationMethod = stringField(proof, "verificationMethod");

  const hashes = await hashQuote(stripProof(doc), {
    cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
    proofOptions: {
      type: "EcdsaSecp256k1RecoverySignature2020",
      created: stringField(proof, "created"),
      verificationMethod,
      proofPurpose: expectedVPProofPurpose,
      challenge: stringField(proof, "challenge"),
      domain: stringField(proof, "domain"),
    },
    keepVerifiableCredential: true,
    extraEnvelopeContexts: verifyContexts(options),
    proofContext: proof["@context"] ?? [
      options.envelopeContextUrl ?? FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
      SECP256K1_RECOVERY_CONTEXT_URL,
    ],
  });

  const { signature } = parseDetachedJws(jws);
  if (signature.length !== 65) {
    throw new Error(`verifyVP: JWS signature length = ${signature.length}, want 65`);
  }
  // The raw form, and one typed form at most, chosen by what the envelope declares. A settler's
  // envelope may be signed in the settler identity form. An originator's, one declaring
  // PaymentRequestEnvelope, never is: it takes only the payer's PaymentRequestEnvelopeProof form,
  // and only where the caller accepts it. Mirror of the Go verifyVPSecp256k1.
  const declared = Array.isArray(doc.type) && (doc.type as unknown[]).includes(PAYMENT_REQUEST_ENVELOPE_TYPE);
  const typed: TypedProofDigest[] = !declared
    ? [settlerProofTypedDigest]
    : options.acceptPaymentRequestEnvelopeTypedProof === true
      ? [paymentRequestEnvelopeProofTypedDigest]
      : [];
  const recovered = recoverSecp256k1ProofSignerFrom(hashes, signature, (a) =>
    matchesSecp256k1DID(a, holder), typed
  ).toLowerCase();

  // Bind the recovered
  // signer to envelope.Holder. Without this, the only identity check
  // is two caller-supplied labels (envelope.Holder vs ExpectedHolder),
  // which an attacker controls both sides of.
  signerMatchesHolderSecp256k1(recovered, holder);

  const { accepted, passThrough, vcProofsVerifiedCount } = await applyVCPolicies(doc, options, holder);

  return {
    holder: stripDIDFragment(holder),
    cryptosuite: "EcdsaSecp256k1RecoverySignature2020",
    signerAddress: recovered,
    ed25519PublicKey: null,
    didNetwork: parseDIDNetwork(holder),
    created,
    attestedClaims: accepted,
    passThroughClaims: passThrough,
    vcProofsVerifiedCount,
  };
}

async function verifyVPEd25519(
  doc: Record<string, unknown>,
  proof: Record<string, unknown>,
  holder: string,
  created: Date,
  options: VerifyVPOptions
): Promise<VPResult> {
  const proofValue = stringField(proof, "proofValue");
  const verificationMethod = stringField(proof, "verificationMethod");

  if (!proofValue.startsWith(multibaseBase58btcPrefix)) {
    throw new Error(
      `verifyVP: proof.proofValue prefix = ${JSON.stringify(proofValue.slice(0, 1))}, want ${JSON.stringify(multibaseBase58btcPrefix)}`
    );
  }
  const sig = bs58.decode(proofValue.slice(1));
  if (sig.length !== 64) {
    throw new Error(`verifyVP: ed25519 signature length = ${sig.length}, want 64`);
  }

  const { pubkey } = parseEd25519DIDPKH(verificationMethod);

  const { signingInput } = await hashQuote(stripProof(doc), {
    cryptosuite: "Ed25519Signature2020",
    proofOptions: {
      type: "Ed25519Signature2020",
      created: stringField(proof, "created"),
      verificationMethod,
      proofPurpose: expectedVPProofPurpose,
      challenge: stringField(proof, "challenge"),
      domain: stringField(proof, "domain"),
    },
    keepVerifiableCredential: true,
    extraEnvelopeContexts: verifyContexts(options),
    proofContext: proof["@context"] ?? [
      options.envelopeContextUrl ?? FULFILLMENT_QUOTE_ENVELOPE_CONTEXT_URL,
      ED25519_2020_CONTEXT_URL,
    ],
  });

  if (!nacl.sign.detached.verify(signingInput, sig, pubkey)) {
    throw new Error("verifyVP: ed25519 signature verification failed");
  }

  // Bind the recovered
  // pubkey to envelope.Holder. parseEd25519DIDPKH extracted the pubkey
  // from a wire field — without this check it authenticates the
  // verificationMethod field, not the holder.
  signerMatchesHolderEd25519(pubkey, holder);

  const { accepted, passThrough, vcProofsVerifiedCount } = await applyVCPolicies(doc, options, holder);

  return {
    holder: stripDIDFragment(holder),
    cryptosuite: "Ed25519Signature2020",
    signerAddress: "",
    ed25519PublicKey: pubkey,
    didNetwork: parseDIDNetwork(holder),
    created,
    attestedClaims: accepted,
    passThroughClaims: passThrough,
    vcProofsVerifiedCount,
  };
}

// applyVCPolicies runs the per-VC checks from design doc §5 (date window),
// §6 (trust anchors), and §8 (RequiredVCTypes). Returns the VCs that
// passed and the VCs it passed through unchecked; throws on any failure
// that makes the envelope unacceptable.
//
// RESERVED AND PASS-THROUGH VCs: when the reserved set (reservedVCTypes
// together with requiredVCTypes) is non-empty, a VC that declares none of
// its types is passed through for the counterparties to judge, with no
// check at all. The checks below apply to every other VC, and to every VC
// when the reserved set is empty.
//
// TWO-TIER POLICY MODEL:
//
// The asymmetry between the date-window / issuer-trust checks (which
// reject the whole envelope on any single-VC failure) and the
// required-type check (which passes when at least one VC matches) is
// intentional. They answer different questions:
//
//   - per-VC VALIDITY tier (date window, issuer trust): every VC the
//     producer chose to include MUST be individually valid. Including
//     a VC is the producer's explicit assertion of intent to present
//     it — the verifier doesn't drop VCs it finds inconvenient.
//   - per-policy POLICY tier (required-type): the verifier's operator
//     declares "at least one VC of type X must be present." A coverage
//     check, not a per-VC predicate.
//
// `attestedClaims` returns every VC examined (the full input set when
// all VALIDITY checks pass), NOT just the required-type matches.
// Callers that need the matching subset filter downstream — the
// contract is "the set of VCs this verifier examined and accepted."
//
// SCOPE NOTE: when `options.verifyVCProofs` is supplied,
// each embedded VC's own cryptographic proof is verified against the
// issuer's published key. Undefined opts out — matches the Go
// canonical's `VerifyVCProofs IssuerKeyResolver` contract. The
// per-VC subject-holder binding is always enforced;
// holder is threaded in from the caller after the OUTER VP
// signer→holder check.
async function applyVCPolicies(
  doc: Record<string, unknown>,
  options: VerifyVPOptions,
  holder: string
): Promise<{ accepted: unknown[]; passThrough: unknown[]; vcProofsVerifiedCount: number }> {
  const vcs = doc.verifiableCredential;
  if (!Array.isArray(vcs) || vcs.length === 0) {
    throw new Error("verifyVP: envelope.verifiableCredential is missing or empty");
  }

  const matcher = await newReservedTypeMatcher(
    reservedVCTypes(options),
    "@context" in doc ? doc["@context"] : undefined,
    verifyLoader(options).toJsonldLoader()
  );
  let matchedRequired = !options.requiredVCTypes || options.requiredVCTypes.length === 0;
  const accepted: unknown[] = [];
  const passThrough: unknown[] = [];
  let vcProofsVerifiedCount = 0;
  for (let i = 0; i < vcs.length; i++) {
    const vc = vcs[i] as Record<string, unknown>;
    // Pass-through. A VC that declares no reserved type is for the
    // counterparties to judge: no check here, and it never reaches
    // attestedClaims or the coverage gate. A VC declaring any reserved
    // type, in any spelling, or a type that can't be resolved, is checked
    // (see reserved-types.ts), so one claiming a reserved type from an
    // untrusted issuer is still refused. A pass-through VC's issuer is
    // never resolved: resolving an arbitrary issuer's DID would let any
    // presenter make the verifier fetch a host of its choosing. A null
    // matcher means no reserved set: every VC is checked. Mirror of the Go
    // canonical.
    if (matcher && !(await matcher.reserved(vcs[i]))) {
      passThrough.push(vc);
      continue;
    }
    // Subject-holder is the cheapest check (single did:pkh segment
    // compare, no allocations, no callback) AND the most diagnostic
    // when an attacker is trying to attach a captured VC, so it fires
    // first to keep the rejection reason informative under multi-
    // violation attacks. Mirror of the Go canonical's policy-loop
    // order — divergence would let one verifier accept a VP the other
    // rejects on multi-fault inputs.
    checkVCSubjectMatchesHolder(vc, i, holder);
    checkVCDateWindow(vc, i, options.now);
    checkVCIssuerTrust(vc, i, options.isIssuerTrusted);
    if (options.verifyVCProofs) {
      // Surface the resolver's error verbatim — VPVCProofError
      // already carries the reason tag the perimeter taxonomy
      // routes to a per-reason metric.
      await verifyVCProof(vc, options.verifyVCProofs);
      vcProofsVerifiedCount++;
    }
    if (!matchedRequired && vcSatisfiesRequiredTypes(vc, options.requiredVCTypes!)) {
      matchedRequired = true;
    }
    accepted.push(vc);
  }
  if (!matchedRequired) {
    throw new Error(
      `verifyVP: no VC declared all requiredVCTypes ${JSON.stringify(options.requiredVCTypes)}`
    );
  }
  return { accepted, passThrough, vcProofsVerifiedCount };
}

// reservedVCTypes is the set of credential types only trusted issuers may
// issue: reservedVCTypes together with requiredVCTypes, so a required type
// is always verified. Empty when both are, which checks every VC. Mirror of
// the Go canonical's reservedVCTypes.
function reservedVCTypes(options: VerifyVPOptions): string[] {
  const required = options.requiredVCTypes ?? [];
  if (!options.reservedVCTypes || options.reservedVCTypes.length === 0) {
    return required;
  }
  const reserved = [...options.reservedVCTypes];
  for (const t of required) {
    if (!reserved.includes(t)) reserved.push(t);
  }
  return reserved;
}

// verifyContexts is the caller's extraEnvelopeContexts and
// extraCredentialContexts together: what the per-call loader overlays.
function verifyContexts(options: VerifyVPOptions): Record<string, unknown> | undefined {
  const credential = options.extraCredentialContexts;
  if (!credential || Object.keys(credential).length === 0) return options.extraEnvelopeContexts;
  return { ...(options.extraEnvelopeContexts ?? {}), ...credential };
}

// verifyLoader is the per-call document loader for verification: the shared
// loader overlaid with verifyContexts. The reserved-type matcher expands
// credential types with the same loader the holder signature is canonicalized
// with. Mirror of the Go canonical's verifyLoader.
function verifyLoader(options: VerifyVPOptions): typeof fqLoader {
  const extra = verifyContexts(options);
  if (!extra || Object.keys(extra).length === 0) return fqLoader;
  return fqLoader.withExtraContexts(extra as Parameters<typeof fqLoader.withExtraContexts>[0]);
}

// checkExtraCredentialContexts refuses a supplied credential context whose
// URL is a bundled context or an extraEnvelopeContexts key: a supplied
// context may add a vocabulary, never replace one of Atum's. Mirror of the Go
// canonical's checkExtraCredentialContexts.
function checkExtraCredentialContexts(options: VerifyVPOptions): void {
  for (const url of Object.keys(options.extraCredentialContexts ?? {})) {
    let bundled = true;
    try {
      fqLoader.load(url);
    } catch {
      bundled = false;
    }
    if (bundled) {
      throw new Error(`verifyVP: extraCredentialContexts: ${JSON.stringify(url)} is a bundled context and can't be replaced`);
    }
    if (options.extraEnvelopeContexts && Object.prototype.hasOwnProperty.call(options.extraEnvelopeContexts, url)) {
      throw new Error(`verifyVP: extraCredentialContexts: ${JSON.stringify(url)} is also an extraEnvelopeContexts key`);
    }
  }
}

// ZERO_INSTANT_MS is 0001-01-01T00:00:00Z, the instant Go's zero time.Time
// stands for. Date.UTC(1, 0, 1) would not do: it maps a two-digit year to
// 1901.
const ZERO_INSTANT_MS = Date.parse("0001-01-01T00:00:00Z");

function checkVCDateWindow(vc: Record<string, unknown>, idx: number, now: Date): void {
  // verifyVP enforces options.now != undefined before reaching here.
  const issuanceStr = stringField(vc, "issuanceDate");
  const issuance = new Date(issuanceStr);
  if (Number.isNaN(issuance.getTime())) {
    throw new Error(`verifyVP: verifiableCredential[${idx}].issuanceDate not parseable: ${JSON.stringify(issuanceStr)}`);
  }
  // Go decodes a null issuanceDate to its zero time and so can't tell the
  // two apart; it refuses both. No credential is issued at that instant, so
  // refuse it here too, in any offset spelling, and the verifiers agree.
  if (issuance.getTime() === ZERO_INSTANT_MS) {
    throw new Error(
      `verifyVP: verifiableCredential[${idx}].issuanceDate ${JSON.stringify(issuanceStr)} is the zero instant`
    );
  }
  if (now.getTime() < issuance.getTime()) {
    throw new Error(`verifyVP: verifiableCredential[${idx}].issuanceDate ${issuance.toISOString()} is in the future`);
  }
  // expirationDate is optional: absent or null means no expiry. Any other
  // value must be a date string, as Go's decoder requires, so an empty
  // string or a number is refused rather than read as no expiry.
  const expRaw = vc.expirationDate;
  if (expRaw !== undefined && expRaw !== null) {
    if (typeof expRaw !== "string" || expRaw === "") {
      throw new Error(`verifyVP: verifiableCredential[${idx}].expirationDate is not a date string`);
    }
    const exp = new Date(expRaw);
    if (Number.isNaN(exp.getTime())) {
      throw new Error(`verifyVP: verifiableCredential[${idx}].expirationDate not parseable: ${JSON.stringify(expRaw)}`);
    }
    if (now.getTime() > exp.getTime()) {
      throw new Error(`verifyVP: verifiableCredential[${idx}] expired at ${exp.toISOString()}`);
    }
  }
}

function checkVCIssuerTrust(vc: Record<string, unknown>, idx: number, isTrusted?: IsIssuerTrustedFunc): void {
  if (!isTrusted) return;
  const issuerDID = vcIssuerDID(vc, idx);
  const { allowed, enforced } = isTrusted(issuerDID);
  if (!allowed && enforced) {
    throw new Error(`verifyVP: verifiableCredential[${idx}] issuer ${JSON.stringify(issuerDID)} not in trust anchors`);
  }
}

// checkVCSubjectMatchesHolder enforces the subject-holder binding: a VC's
// credentialSubject.id MUST equal the VP's holder DID. Mirror of Go
// ld-verification's same-named helper. Prevents the
// "presenter grabs someone else's valid VC and attaches it" attack — the
// VC is well-formed and issuer-signed, but it is not *theirs*.
//
// Comparison uses holderEquals so the case-insensitive did:pkh segment
// rules match what the upstream VP-holder check already enforces.
//
// V1 ASSUMPTION — DELEGATED PRESENTATION FUTURE: this check hard-codes
// the v1 semantic that the settler IS the subject of the VCs they
// present. The design (docs/atum-id/vp-envelope-design.md §1) leaves
// room for a v2 flow where one party makes the quote and another
// presents it — which also implies one party holds the credential and
// another presents it (delegated agent presenting a customer's VC on
// their behalf). When v2 ships, this check MUST become operator-
// configurable (per-tenant policy or a presenter-trust callback) or it
// will silently reject every delegated VP. The v2 follow-up ticket
// should land alongside the delegated-presentation enablement, not in
// advance.
function checkVCSubjectMatchesHolder(vc: Record<string, unknown>, idx: number, holder: string): void {
  const subject = vc.credentialSubject;
  if (!subject || typeof subject !== "object") {
    throw new Error(`verifyVP: verifiableCredential[${idx}].credentialSubject missing or not an object`);
  }
  const subjectID = (subject as Record<string, unknown>).id;
  if (typeof subjectID !== "string" || subjectID === "") {
    throw new Error(`verifyVP: verifiableCredential[${idx}].credentialSubject.id missing or not a string`);
  }
  if (!holderEquals(subjectID, holder)) {
    throw new Error(
      `verifyVP: verifiableCredential[${idx}].credentialSubject.id ${JSON.stringify(subjectID)} does not equal VP holder ${JSON.stringify(holder)}`
    );
  }
}

function vcIssuerDID(vc: Record<string, unknown>, idx: number): string {
  const raw = vc.issuer;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const id = (raw as Record<string, unknown>).id;
    if (typeof id === "string" && id !== "") return id;
  }
  throw new Error(`verifyVP: verifiableCredential[${idx}] issuer field is neither a string nor an object with 'id'`);
}

function vcSatisfiesRequiredTypes(vc: Record<string, unknown>, required: string[]): boolean {
  const types = vc.type;
  if (!Array.isArray(types)) return false;
  const have = new Set<string>(types.filter((t): t is string => typeof t === "string"));
  for (const t of required) {
    if (!have.has(t)) return false;
  }
  return true;
}

function stripProof(doc: Record<string, unknown>): Record<string, unknown> {
  const { proof: _proof, ...rest } = doc;
  void _proof;
  return rest;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v === "") {
    throw new Error(`verifyVP: missing or non-string field ${JSON.stringify(key)}`);
  }
  return v;
}

function stripDIDFragment(did: string): string {
  const i = did.indexOf("#");
  return i === -1 ? did : did.slice(0, i);
}

// holderEquals returns true when two did:pkh URIs identify the same
// chain account. Splits both into 5 segments:
//   did : pkh : <namespace> : <reference> : <address>
// The first four are W3C case-insensitive; the address segment is
// per-namespace case-sensitive (Solana base58 pubkey and Tron base58check
// MUST byte-compare). Flat toLowerCase would silently match
// `did:pkh:solana:devnet:Abc...` against `did:pkh:solana:devnet:abc...`,
// two different accounts. Returns false on malformed input (fewer than 5
// segments) — fail closed.
function holderEquals(a: string, b: string): boolean {
  const aSeg = splitDIDPKH(a);
  const bSeg = splitDIDPKH(b);
  if (!aSeg || !bSeg) return false;
  for (let i = 0; i < 4; i++) {
    if ((aSeg[i] ?? "").toLowerCase() !== (bSeg[i] ?? "").toLowerCase()) return false;
  }
  // Address segment — chain-aware. eip155 is hex;
  // EIP-55 mixed-case is a checksum, not a different address, so
  // case-fold. solana / tron use base58 / base58check which ARE
  // case-sensitive — case-fold there would collapse two distinct
  // accounts. Default to exact compare on unknown namespaces.
  switch (aSeg[2].toLowerCase()) {
    case "eip155":
      return aSeg[4].toLowerCase() === bSeg[4].toLowerCase();
    default:
      return aSeg[4] === bSeg[4];
  }
}

// signerMatchesHolderSecp256k1 ties the recovered EVM-style hex
// address to envelope.Holder under the holder's chain namespace.
// Mirror of Go ld-verification's same-named helper — closes the
// "two text labels" gap: without this check, an attacker writes the victim's DID in
// envelope.Holder, signs with their own key, and the verifier
// accepts because only the caller-supplied ExpectedHolder label is
// checked.
//
// Chain-aware compare:
//
//   - eip155 — case-insensitive hex compare. EIP-55 mixed-case is a
//     checksum, not a different address.
//
//   - tron — exact compare on base58check. The recovered EVM hash is
//     re-encoded as the canonical Tron base58check (0x41 prefix +
//     double-SHA256 4-byte checksum) before compare.
//
// Any other namespace fails closed. New chains add a branch here AND
// in the Go canonical (signerMatchesHolderSecp256k1 in verify_vp.go).
// matchesSecp256k1DID is the boolean form of signerMatchesHolderSecp256k1.
export function matchesSecp256k1DID(recoveredHex: string, did: string): boolean {
  try {
    signerMatchesHolderSecp256k1(recoveredHex, did);
    return true;
  } catch {
    return false;
  }
}

function signerMatchesHolderSecp256k1(recoveredHex: string, holderDID: string): void {
  const seg = splitDIDPKH(holderDID);
  if (!seg) {
    throw new Error(
      `verifyVP: malformed holder DID ${JSON.stringify(holderDID)} (expected did:pkh:...)`
    );
  }
  const namespace = seg[2].toLowerCase();
  const holderAddr = seg[4];
  switch (namespace) {
    case "eip155": {
      if (recoveredHex.toLowerCase() !== holderAddr.toLowerCase()) {
        throw new Error(
          `verifyVP: recovered secp256k1 signer ${recoveredHex} does not match eip155 holder address ${holderAddr} (VP signer/holder mismatch)`
        );
      }
      return;
    }
    case "tron": {
      const wantTron = evmHexToTronBase58(recoveredHex);
      if (wantTron !== holderAddr) {
        throw new Error(
          `verifyVP: recovered signer (tron: ${wantTron}) does not match holder address ${holderAddr} (VP signer/holder mismatch)`
        );
      }
      return;
    }
    default:
      throw new Error(
        `verifyVP: namespace ${JSON.stringify(namespace)} is not supported for secp256k1 VP holder binding (only eip155 and tron)`
      );
  }
}

// signerMatchesHolderEd25519 ties the ed25519 public key (extracted
// from proof.verificationMethod) to envelope.Holder. Mirror of
// signerMatchesHolderSecp256k1; see that helper's comment for the
// threat model.
function signerMatchesHolderEd25519(pubkey: Uint8Array, holderDID: string): void {
  const seg = splitDIDPKH(holderDID);
  if (!seg) {
    throw new Error(
      `verifyVP: malformed holder DID ${JSON.stringify(holderDID)} (expected did:pkh:...)`
    );
  }
  const namespace = seg[2].toLowerCase();
  const holderAddr = seg[4];
  if (namespace !== "solana" && namespace !== "stellar") {
    throw new Error(
      `verifyVP: namespace ${JSON.stringify(namespace)} is not supported for ed25519 VP holder binding (only solana and stellar)`
    );
  }
  const want = namespace === "stellar" ? encodeStellarAccount(pubkey) : bs58.encode(pubkey);
  if (want !== holderAddr) {
    throw new Error(
      `verifyVP: recovered ed25519 pubkey ${want} does not match ${namespace} holder address ${holderAddr} (VP signer/holder mismatch)`
    );
  }
}

// evmHexToTronBase58 mirrors the Go evmHashToTronBase58 inline. Takes
// a 0x-prefixed 20-byte EVM hex address, prepends Tron's 0x41 mainnet
// prefix, appends 4 bytes of double-SHA256 checksum, and base58-encodes.
function evmHexToTronBase58(hex: string): string {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length !== 40) {
    throw new Error(`verifyVP: evmHexToTronBase58: expected 20-byte hex, got ${stripped.length / 2} bytes`);
  }
  const evmBytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    evmBytes[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  payload.set(evmBytes, 1);
  // Two-pass SHA-256 over the payload, take first 4 bytes as checksum.
  const crypto = require("crypto");
  const h1 = crypto.createHash("sha256").update(payload).digest();
  const h2 = crypto.createHash("sha256").update(h1).digest();
  const out = new Uint8Array(25);
  out.set(payload, 0);
  out.set(h2.subarray(0, 4), 21);
  return bs58.encode(out);
}

function splitDIDPKH(did: string): [string, string, string, string, string] | null {
  const bare = stripDIDFragment(did);
  // Mirror Go's SplitN(.., ":", 5): cap segment count at 5 so any
  // colons inside the address payload stay glued to segment 4.
  const idx: number[] = [];
  for (let i = 0; i < bare.length && idx.length < 4; i++) {
    if (bare[i] === ":") idx.push(i);
  }
  const [i0, i1, i2, i3] = idx;
  if (i0 === undefined || i1 === undefined || i2 === undefined || i3 === undefined) return null;
  return [
    bare.slice(0, i0),
    bare.slice(i0 + 1, i1),
    bare.slice(i1 + 1, i2),
    bare.slice(i2 + 1, i3),
    bare.slice(i3 + 1),
  ];
}

// parseDIDNetwork returns "namespace:reference" from a did:pkh URI.
// Mirrors the Go didNetwork helper for symmetry — both verifiers return
// this form so callers don't have to dispatch on a per-language convention.
//
// The output is always lowercased: W3C says the DID method + namespace
// + reference are case-insensitive, but the verifier's wire input may
// arrive in any case. Lowercasing keeps consumer compares
// (`if (res.didNetwork === "eip155:1")`) reliable regardless of wire
// shape. The address segment is dropped before lowercasing — see
// holderEquals for the address-segment compare.
function parseDIDNetwork(did: string): string {
  const bare = stripDIDFragment(did);
  const prefix = "did:pkh:";
  if (!bare.toLowerCase().startsWith(prefix)) return "";
  const parts = bare.slice(prefix.length).split(":");
  if (parts.length < 2) return "";
  return `${(parts[0] ?? "").toLowerCase()}:${(parts[1] ?? "").toLowerCase()}`;
}

// parseEd25519DIDPKH extracts the ed25519 public key from a
// did:pkh:solana:<network>:<base58-pubkey>#<fragment>-shaped DID, or a
// did:pkh:stellar:<network>:<G-account>#<fragment> one.
// Strict on namespace=solana|stellar — secp256k1 verification can't run
// on this path.
function parseEd25519DIDPKH(vm: string): { pubkey: Uint8Array; network: string } {
  const bare = stripDIDFragment(vm);
  if (!bare.toLowerCase().startsWith("did:pkh:")) {
    throw new Error(`verifyVP: verificationMethod not did:pkh: ${vm}`);
  }
  const parts = bare.slice("did:pkh:".length).split(":");
  if (parts.length !== 3) {
    throw new Error(`verifyVP: ed25519 verificationMethod must be did:pkh:<ns>:<network>:<pk>, got ${vm}`);
  }
  const namespace = parts[0]?.toLowerCase();
  if (namespace !== "solana" && namespace !== "stellar") {
    throw new Error(`verifyVP: ed25519 namespace must be solana or stellar, got ${parts[0]}`);
  }
  const network = parts[1] ?? "";
  if (network === "") {
    throw new Error("verifyVP: ed25519 did:pkh network segment empty");
  }
  const address = parts[2] ?? "";
  const pubkey = namespace === "stellar" ? decodeStellarAccount(address) : bs58.decode(address);
  if (pubkey.length !== 32) {
    throw new Error(`verifyVP: ed25519 pubkey length = ${pubkey.length}, want 32`);
  }
  return { pubkey, network };
}
