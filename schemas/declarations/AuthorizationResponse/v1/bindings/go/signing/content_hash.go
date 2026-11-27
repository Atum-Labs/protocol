package authorizationresponse

import (
	"encoding/json"
	"errors"
	"fmt"

	. "github.com/atum-labs/protocol/schemas/declarations/AuthorizationResponse/v1/bindings/go/generated"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// ErrMalformedResponse is returned when the bytes handed to ComputeResponseHash
// don't parse as an AuthorizationResponse document.
var ErrMalformedResponse = errors.New("malformed AuthorizationResponse")

// ComputeResponseHash returns the content-addressed identifier for an inner
// AuthorizationResponse, used as the AuthorizationResponseEnvelope (ARE)
// holder-VP `challenge`:
//
//	response_hash = "0x" + hex(keccak256(DocHash))
//
// DocHash is keccak256 of the URDNA2015 n-quads of the AuthorizationResponse
// with its proof block and verifiableCredential array stripped and the
// canonical [AuthorizationResponseContextURL, suite-context] @context injected.
// The double-keccak (keccak256 over the keccak256 DocHash) yields a uniform
// 32-byte identifier matching request_hash / payment_id width — full digest,
// no truncation.
//
// PURE CONTENT: like ld-verification's ComputeRequestHash, response_hash strips
// the inner response's own top-level `proof` ENTIRELY (so re-signing the same
// content with a new proof.created / jws yields the SAME response_hash) and
// strips verifiableCredential (credentials ride ONLY in the holder-signed
// envelope, never the inner response). It is therefore derivable from an
// unsigned response — its value must not depend on whether/how it's signed.
//
// REPLAY SAFETY: response_hash is safe as the anti-replay challenge ONLY
// because payment_id (the per-payment correlation key) is part of the canonical
// content — distinct payments get distinct hashes, so a captured ARE can't be
// lifted onto a different payment's response. This mirrors request_hash's
// reliance on request_id being content-borne (pinned by the tests below).
//
// Determinism contract: callers MUST pass the VERBATIM inner-response JSON
// bytes. Do NOT re-marshal a typed SchemaJson first — the typed round trip is
// lossy (normalizes timestamps, optional nulls, number formatting) and would
// diverge the producer's hash from the verifier's. The typed parse below is
// used ONLY for required-field validation; the hashed document comes from a
// generic-map parse of the original bytes.
//
// SECURITY: this does NOT verify any signature. An equal response_hash does NOT
// imply a valid signature; callers MUST verify independently
// (VerifyAuthorizationResponse).
//
// This is the response-side analog of the request-side ComputeRequestHash; the
// ARE binds its holder-VP challenge to the AuthorizationResponse's own content
// hash exactly as the PRE binds its challenge to the PaymentRequest's
// request_hash.
func ComputeResponseHash(innerResponseJSON []byte) (string, error) {
	// Required-field validation only (content well-formedness). NO proof
	// requirement: response_hash is pure content and is derivable from an
	// unsigned response.
	var typed SchemaJson
	if err := json.Unmarshal(innerResponseJSON, &typed); err != nil {
		return "", fmt.Errorf("failed to parse AuthorizationResponse: %w", errors.Join(ErrMalformedResponse, err))
	}

	// Hash the VERBATIM bytes via a generic map (never the typed struct).
	var doc map[string]any
	if err := json.Unmarshal(innerResponseJSON, &doc); err != nil {
		return "", fmt.Errorf("failed to parse AuthorizationResponse document: %w", errors.Join(ErrMalformedResponse, err))
	}

	// Same derivation as every other declaration content hash; see lddataintegrity.ComputeContentHash.
	return lddataintegrity.ComputeContentHash(doc, AuthorizationResponseContextURL, docLoader)
}
