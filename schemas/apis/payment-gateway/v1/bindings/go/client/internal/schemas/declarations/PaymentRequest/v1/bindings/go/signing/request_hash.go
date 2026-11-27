package ldverification

import (
	"encoding/json"
	"errors"
	"fmt"

	paymentrequest "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/generated"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// requestHashCryptosuite is the FIXED cryptosuite request_hash canonicalizes
// under, regardless of how (or whether) the inner PaymentRequest was actually
// signed. request_hash consumes only HashResult.DocHash, and DocHash's hash
// algorithm is suite-selected (keccak256 for secp256k1, sha256 for ed25519).
// Pinning ONE suite makes request_hash:
//   - suite-independent: a PaymentRequest signed under ed25519 and the same
//     content signed under secp256k1 yield the SAME request_hash;
//   - byte-identical Go↔TS: both sides pin this exact constant.
//
// The document n-quads themselves don't use any suite-specific term (the
// proof is stripped), so this choice only fixes the digest algorithm.
const requestHashCryptosuite = ProofTypeSecp256k1Recovery2020

// ComputeRequestHash returns the content-addressed identifier for an inner
// PaymentRequest, used as the PaymentRequestEnvelope (PRE) holder-VP
// `challenge`:
//
//	request_hash = "0x" + hex(keccak256(DocHash))
//
// DocHash is keccak256 of the URDNA2015 n-quads of the inner PaymentRequest
// with the request_hash strip set removed (see stripDocForRequestHash). The
// double-keccak (keccak256 over a keccak256 DocHash) yields a uniform 32-byte
// identifier matching quote_hash / payment_id width — full digest, no
// truncation.
//
// PURE CONTENT: unlike quote_hash (which folds proof.created /
// verificationMethod into the hash via SigningInput), request_hash strips the
// inner PR's own top-level `proof` ENTIRELY and consumes DocHash, so re-signing
// the same terms (new proof.created / jws) yields the SAME request_hash. This
// is required by the (originator, idempotency_key) generalization —
// retries are content-identical and must collide. It also strips each
// sender_auth.signed_messages[*].signature (a Permit2 proof artifact, replaceable
// / non-deterministic) while PRESERVING message_prehash (the Permit2 nonce =
// content, not a proof artifact).
//
// REPLAY SAFETY: request_hash is safe as an anti-replay challenge ONLY because
// request_id (the idempotency key) is part of the canonical content — distinct
// requests get distinct hashes; an identical request_id IS the same idempotent
// request. The "request_id stays in the canonical content" invariant is pinned
// by TestComputeRequestHash_ChangesOnRequestIDMutation. ORIGINATOR binding is
// likewise content-borne: source.account is hashed; the PRE perimeter separately
// enforces holder == source.account. Stripping the proof therefore
// does NOT weaken request/originator binding.
//
// Determinism contract: callers MUST pass the VERBATIM inner-PR JSON bytes.
// Do NOT re-marshal a typed paymentrequest.SchemaJson first — the typed round
// trip is lossy (normalizes timestamps, optional nulls, number formatting) and
// would diverge the producer's hash from the verifier's. The typed parse below
// is used ONLY for required-field validation; the hashed document comes from a
// generic-map parse of the original bytes.
//
// SECURITY: this does NOT verify any signature. An equal request_hash does NOT
// imply a valid signature; callers MUST verify independently.
//
// Mirror of the TypeScript computeRequestHash(); the two produce the same value
// (pinned by request-hash-golden.json).
func ComputeRequestHash(innerRequestJSON []byte) (string, error) {
	// Required-field validation only (content well-formedness). NO proof
	// requirement: request_hash is pure content and is derivable from an
	// unsigned request — its value must not depend on whether/how it's signed.
	var req paymentrequest.SchemaJson
	if err := json.Unmarshal(innerRequestJSON, &req); err != nil {
		return "", fmt.Errorf("failed to parse PaymentRequest: %w", errors.Join(ErrMalformedRequest, err))
	}

	// Hash the VERBATIM bytes via a generic map (never the typed struct).
	var doc map[string]any
	if err := json.Unmarshal(innerRequestJSON, &doc); err != nil {
		return "", fmt.Errorf("failed to parse PaymentRequest document: %w", errors.Join(ErrMalformedRequest, err))
	}

	stripped := stripDocForRequestHash(doc)

	// HashPaymentRequest additionally strips proof + (defensively)
	// verifiableCredential and injects the canonical [PR-context, suite-context]
	// @context (stripDocForRequestHash removed it). We discard SigningInput /
	// ProofHash and consume only DocHash — the placeholder proof options below
	// never participate in the returned value.
	hash, err := HashPaymentRequest(stripped, HashPaymentRequestOptions{
		Cryptosuite: requestHashCryptosuite,
		ProofOptions: HashableProofOptions{
			Type:               requestHashCryptosuite,
			Created:            "1970-01-01T00:00:00Z",
			VerificationMethod: "did:atum:request-hash#placeholder",
			ProofPurpose:       "assertionMethod",
			Context:            secp256k1Recovery2020V2CtxURL,
		},
	})
	if err != nil {
		return "", err
	}

	return "0x" + common.Bytes2Hex(crypto.Keccak256(hash.DocHash)), nil
}

// stripDocForRequestHash returns doc reduced to the canonical request_hash
// input: the existing inner-PR signing strip (proof, @context, and all
// credential carriers — verifiableCredential / presentation / originator_auth /
// nested sender_auth.verifiable_credential, see stripDocForHash) PLUS the
// request_hash-specific removal of every sender_auth.signed_messages[*].signature.
//
// The signed_messages signatures are Permit2 proof artifacts: replaceable and
// non-deterministic, exactly like proof.jws, so they're excluded from the
// content identity. message_prehash, message, and payload are PRESERVED — they
// carry the authorization payload (incl. the Permit2 nonce), which IS content.
//
// Non-mutating: returns a fresh map; the input is untouched. The TS
// stripDocForRequestHash MUST remove the identical set (pinned by
// request-hash-golden.json) — earlier the TS ld-signing path stripped a smaller
// set than Go, an asymmetry that would diverge request_hash across languages
// once a PRE `presentation` is spliced onto the wire PaymentRequest.
func stripDocForRequestHash(doc map[string]any) map[string]any {
	out := stripDocForHash(doc)
	if sa, ok := out["sender_auth"]; ok {
		out["sender_auth"] = stripSignedMessageSignatures(sa)
	}
	return out
}

// stripSignedMessageSignatures returns sa with the `signature` field removed
// from every element of its `signed_messages` array, WITHOUT mutating the input
// (returns the original when there's nothing to strip). Mirrors the
// non-mutating copy discipline of stripNestedVerifiableCredential.
func stripSignedMessageSignatures(sa any) any {
	m, ok := sa.(map[string]any)
	if !ok {
		return sa
	}
	msgs, ok := m["signed_messages"].([]any)
	if !ok {
		return sa
	}
	strippedMsgs := make([]any, len(msgs))
	for i, msg := range msgs {
		mm, ok := msg.(map[string]any)
		if !ok {
			strippedMsgs[i] = msg
			continue
		}
		if _, has := mm["signature"]; !has {
			strippedMsgs[i] = msg
			continue
		}
		cp := make(map[string]any, len(mm))
		for k, v := range mm {
			if k == "signature" {
				continue
			}
			cp[k] = v
		}
		strippedMsgs[i] = cp
	}
	cp := make(map[string]any, len(m))
	for k, v := range m {
		cp[k] = v
	}
	cp["signed_messages"] = strippedMsgs
	return cp
}
