// Content-addressed request_hash derivation. Mirror of the Go ComputeRequestHash
// (request_hash.go); the two produce the same request_hash value (pinned by
// request-hash-golden.json).

import { keccak256 } from "ethers";

import { hashPaymentRequest, type Cryptosuite } from "./hash.js";
import { SECP256K1_RECOVERY_CONTEXT_URL } from "./canonicalize.js";

// Required top-level PaymentRequest fields, mirroring the Go typed parse
// (SchemaJson `required`) so both languages reject the same malformed docs.
// Presence-only, matching the quote-hash.ts approach (the value-parity contract
// is on the hash, not the reject boundary).
//
// LOCKSTEP WITH THE GO BINDING: this is a hand-maintained
// mirror of the schema's `required` set, which does not include `sender_auth`
// (quote requests and originator-executed deposits carry none).
const REQUIRED_TOP_LEVEL_FIELDS = [
  "version",
  "request_id",
  "source",
  "destination",
  "fulfillment_amount",
  "quote_deadline",
  "fulfillment_deadline",
  "fulfillment_verifier",
  "escrow_contract_address",
] as const;

// request_hash pins ONE cryptosuite for the docHash path regardless of how (or
// whether) the inner PR was signed. docHash's algorithm is suite-selected
// (keccak256 for secp256k1, sha256 for ed25519); pinning secp256k1 makes
// request_hash suite-independent AND byte-identical Go<->TS. Mirror of Go's
// requestHashCryptosuite.
const REQUEST_HASH_CRYPTOSUITE: Cryptosuite =
  "EcdsaSecp256k1RecoverySignature2020";

// computeRequestHash returns the content-addressed identifier for an inner
// PaymentRequest, used as the PaymentRequestEnvelope (PRE) holder-VP challenge:
//
//   request_hash = "0x" + hex(keccak256(docHash))
//
// PURE CONTENT: unlike quote_hash (which folds proof.created into
// the hash via signingInput), request_hash strips the inner PR's own top-level
// proof ENTIRELY (consumes docHash) plus each
// sender_auth.signed_messages[*].signature (a Permit2 proof artifact), so a
// re-signed retry yields the SAME hash — required by the (originator,
// idempotency_key) generalization. PRESERVES message_prehash / message /
// payload (content). See the Go ComputeRequestHash doc comment for the full
// rationale: replay-safety rests on request_id being in the canonical content;
// originator binding rests on source.account + the PRE holder==source.account
// check; the value is suite-independent.
//
// Determinism contract: callers MUST pass the VERBATIM inner-PR bytes/object;
// do not re-marshal through a normalizing typed layer first.
//
// SECURITY: this does NOT verify any signature. An equal request_hash does NOT
// imply a valid signature; callers MUST verify independently.
export async function computeRequestHash(
  innerRequest: string | Record<string, unknown>
): Promise<string> {
  const doc =
    typeof innerRequest === "string"
      ? (JSON.parse(innerRequest) as Record<string, unknown>)
      : innerRequest;

  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (doc[field] === undefined) {
      throw new Error(`computeRequestHash: missing required field ${field}`);
    }
  }

  const stripped = stripDocForRequestHash(doc);

  // hashPaymentRequest additionally strips proof + (defensively)
  // verifiableCredential and injects the canonical [PR, suite] @context
  // (stripDocForRequestHash removed it). We consume ONLY docHash; the
  // placeholder proof options below never participate in the returned value.
  const { docHash } = await hashPaymentRequest(stripped, {
    cryptosuite: REQUEST_HASH_CRYPTOSUITE,
    proofOptions: {
      type: REQUEST_HASH_CRYPTOSUITE,
      created: "1970-01-01T00:00:00Z",
      verificationMethod: "did:atum:request-hash#placeholder",
      proofPurpose: "assertionMethod",
    },
    proofContext: SECP256K1_RECOVERY_CONTEXT_URL,
  });

  return keccak256(docHash);
}

// stripDocForRequestHash mirrors the Go stripDocForRequestHash EXACTLY: the
// inner-PR signing strip set (proof, @context, and ALL credential carriers —
// verifiableCredential / presentation / originator_auth / nested
// sender_auth.verifiable_credential) PLUS every
// sender_auth.signed_messages[*].signature. message_prehash / message / payload
// are preserved.
//
// Closing this full set in TS is load-bearing: the TS ld-signing sign path
// strips only @context + proof (verifiableCredential via the lib option), a
// SMALLER set than Go. request_hash is recomputed by the verifier over the
// RECEIVED inner PR, which by design carries a spliced PRE
// `presentation` — so a smaller TS strip would diverge request_hash across
// languages. Non-mutating.
function stripDocForRequestHash(
  doc: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (
      k === "proof" ||
      k === "@context" ||
      k === "verifiableCredential" ||
      k === "presentation" ||
      k === "originator_auth"
    ) {
      continue;
    }
    out[k] = v;
  }
  if (out.sender_auth && typeof out.sender_auth === "object") {
    out.sender_auth = stripSenderAuth(
      out.sender_auth as Record<string, unknown>
    );
  }
  return out;
}

// stripSenderAuth removes the deprecated nested verifiable_credential and every
// signed_messages[*].signature, preserving the rest of the authorization
// (message_scheme, and each message's message / message_prehash / payload).
// Non-mutating. Combines the two Go helpers (stripNestedVerifiableCredential +
// stripSignedMessageSignatures) that both apply to sender_auth.
function stripSenderAuth(
  sa: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(sa)) {
    if (k === "verifiable_credential") {
      continue;
    }
    out[k] = v;
  }
  if (Array.isArray(out.signed_messages)) {
    out.signed_messages = (out.signed_messages as unknown[]).map((msg) => {
      if (!msg || typeof msg !== "object") {
        return msg;
      }
      const { signature: _signature, ...rest } = msg as Record<string, unknown>;
      return rest;
    });
  }
  return out;
}
