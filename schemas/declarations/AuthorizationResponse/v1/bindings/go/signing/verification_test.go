package authorizationresponse

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	. "github.com/atum-labs/protocol/schemas/declarations/AuthorizationResponse/v1/bindings/go/generated"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// signedFixture is the harness used by every verification test that
// needs a "valid response signed by signer X" starting point. Returns
// the produced *SchemaJson and its raw map[string]any form (the wire
// shape verification operates on).
func signedFixture(t *testing.T, now time.Time) (*testSecp256k1Signer, *SchemaJson, map[string]any) {
	t.Helper()
	signer := newTestSigner(t)
	resp, err := BuildAuthorizationResponse(
		SchemaJsonStatusAuthorized,
		"pay-12345",
		signer.did,
		nil,
		signer,
		now,
	)
	require.NoError(t, err)

	raw, err := json.Marshal(resp)
	require.NoError(t, err)
	var docMap map[string]any
	require.NoError(t, json.Unmarshal(raw, &docMap))
	return signer, resp, docMap
}

// asVerifyError unwraps an error to *VerifyError. Helper to keep tests
// readable without mass-cluttering each `require.True(t, errors.As(...))` block.
func asVerifyError(t *testing.T, err error) *VerifyError {
	t.Helper()
	require.Error(t, err)
	var ve *VerifyError
	require.True(t, errors.As(err, &ve), "expected *VerifyError, got %T: %v", err, err)
	return ve
}

// TestVerifyAuthorizationResponse_HappyPath is the round-trip
// correctness test. Build with signer X, Verify with expected=signer X,
// must succeed.
func TestVerifyAuthorizationResponse_HappyPath(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, now)

	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now})
	require.NoError(t, err, "valid round-trip must verify")
}

// TestVerifyAuthorizationResponse_TamperedStatus_FailsClosed mutates
// the status field after signing — the signature now covers a different
// document than what the verifier sees, so canonicalization produces a
// different combinedHash and recovery yields a different address.
func TestVerifyAuthorizationResponse_TamperedStatus_FailsClosed(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, now)

	// Flip authorized → declined post-sign.
	docMap["status"] = string(SchemaJsonStatusDeclined)

	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now})
	ve := asVerifyError(t, err)
	// Tampering breaks the signature → recovery either errors out or
	// recovers a different address. Either path lands as did_mismatch
	// (different recovered DID) — verify_failed only fires when
	// the shared ld-data-integrity verifier itself returns an error.
	assert.Contains(t, []string{ReasonDIDMismatch, ReasonVerifyFailed}, ve.Reason,
		"tampered status must reject; got %s", ve.Reason)
	assert.Equal(t, 401, ve.Status)
}

// TestVerifyAuthorizationResponse_TamperedPaymentID_FailsClosed mutates
// payment_id after signing — same shape as the status test.
func TestVerifyAuthorizationResponse_TamperedPaymentID_FailsClosed(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, now)

	docMap["payment_id"] = "pay-FORGED"

	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now})
	ve := asVerifyError(t, err)
	assert.Contains(t, []string{ReasonDIDMismatch, ReasonVerifyFailed}, ve.Reason,
		"tampered payment_id must reject; got %s", ve.Reason)
	assert.Equal(t, 401, ve.Status)
}

// TestVerifyAuthorizationResponse_TamperedCounterpartyDID_FailsClosed mutates
// counterparty_did after signing. Together with the status / payment_id / reason
// tamper tests this pins that EVERY content field is inside the signed n-quad
// graph — i.e. the WHOLE AuthorizationResponse is signed, exactly like the inner
// FulfillmentQuote / PaymentRequest / BidAward.
func TestVerifyAuthorizationResponse_TamperedCounterpartyDID_FailsClosed(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, now)

	docMap["counterparty_did"] = "did:pkh:eip155:1:0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"

	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now})
	ve := asVerifyError(t, err)
	assert.Contains(t, []string{ReasonDIDMismatch, ReasonVerifyFailed}, ve.Reason,
		"tampered counterparty_did must reject; got %s", ve.Reason)
	assert.Equal(t, 401, ve.Status)
}

// TestVerifyAuthorizationResponse_TamperedReason_FailsClosed mutates the reason
// of a signed DECLINED response. reason is the one content field absent from an
// authorized response, so it gets its own declined fixture — confirming the
// optional field is signed too.
func TestVerifyAuthorizationResponse_TamperedReason_FailsClosed(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer := newTestSigner(t)
	reason := "insufficient_funds"
	resp, err := BuildAuthorizationResponse(
		SchemaJsonStatusDeclined,
		"pay-12345",
		signer.did,
		&reason,
		signer,
		now,
	)
	require.NoError(t, err)
	raw, err := json.Marshal(resp)
	require.NoError(t, err)
	var docMap map[string]any
	require.NoError(t, json.Unmarshal(raw, &docMap))

	// Sanity: the declined response verifies before tampering.
	require.NoError(t, VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now}),
		"signed declined response must verify before tamper")

	docMap["reason"] = "account_suspended"

	verr := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now})
	ve := asVerifyError(t, verr)
	assert.Contains(t, []string{ReasonDIDMismatch, ReasonVerifyFailed}, ve.Reason,
		"tampered reason must reject; got %s", ve.Reason)
	assert.Equal(t, 401, ve.Status)
}

// TestVerifyAuthorizationResponse_TamperedProofCreated_FailsClosed is
// the SI-6 regression: mutate proof.created after signing — the new
// timestamp string canonicalizes to different n-quad bytes, breaking
// the combinedHash equality.
func TestVerifyAuthorizationResponse_TamperedProofCreated_FailsClosed(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, now)

	proof := docMap["proof"].(map[string]any)
	proof["created"] = "2026-05-01T13:00:00Z" // shifted forward 1h post-sign

	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now})
	ve := asVerifyError(t, err)
	assert.Contains(t, []string{ReasonDIDMismatch, ReasonVerifyFailed}, ve.Reason)
	assert.Equal(t, 401, ve.Status)
}

// TestVerifyAuthorizationResponse_RFC3339_ZRepresentation_Invariance
// confirms the verifier reads `created` verbatim from the raw map and
// does NOT re-format through time.Time. The signer's truncate-to-second
// produces "...Z"; verifier accepts the same string back.
func TestVerifyAuthorizationResponse_RFC3339_ZRepresentation_Invariance(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, now)

	proof := docMap["proof"].(map[string]any)
	createdStr, _ := proof["created"].(string)
	require.True(t, strings.HasSuffix(createdStr, "Z"),
		"signer should emit Z-suffixed timestamp; got %q", createdStr)

	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now})
	require.NoError(t, err)
}

// TestVerifyAuthorizationResponse_MissingProof_FailsClosed is SI-5.
// A doc with no proof field gets the precise missing_proof reason —
// distinct from proof_malformed (proof present but wrong shape).
func TestVerifyAuthorizationResponse_MissingProof_FailsClosed(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, now)
	delete(docMap, "proof")

	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now})
	ve := asVerifyError(t, err)
	assert.Equal(t, ReasonMissingProof, ve.Reason)
	assert.Equal(t, 400, ve.Status)
}

// TestVerifyAuthorizationResponse_ProofMalformed_FailsClosed asserts
// that a `proof` field of the wrong JSON type (string instead of object)
// gets reported as proof_malformed, not missing_proof. The distinction
// matters for SOC alerts: missing_proof is "PSP misconfigured"; malformed
// is "someone is fuzzing the verifier".
func TestVerifyAuthorizationResponse_ProofMalformed_FailsClosed(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, now)
	docMap["proof"] = "not-an-object"

	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now})
	ve := asVerifyError(t, err)
	assert.Equal(t, ReasonProofMalformed, ve.Reason)
	assert.Equal(t, 400, ve.Status)
}

// TestVerifyAuthorizationResponse_EmptyPaymentID_FailsClosed is SI-5.
func TestVerifyAuthorizationResponse_EmptyPaymentID_FailsClosed(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, now)
	docMap["payment_id"] = ""

	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now})
	ve := asVerifyError(t, err)
	assert.Equal(t, ReasonMissingPaymentID, ve.Reason)
	assert.Equal(t, 400, ve.Status)
}

// TestVerifyAuthorizationResponse_EmptyCounterpartyDID_FailsClosed is SI-5.
func TestVerifyAuthorizationResponse_EmptyCounterpartyDID_FailsClosed(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, now)
	docMap["counterparty_did"] = ""

	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now})
	ve := asVerifyError(t, err)
	assert.Equal(t, ReasonMissingCounterpartyDID, ve.Reason)
	assert.Equal(t, 400, ve.Status)
}

// TestVerifyAuthorizationResponse_EmptyContext_FailsClosed is SI-5.
// Both "missing entirely" and "present but empty array" land as
// context_missing.
func TestVerifyAuthorizationResponse_EmptyContext_FailsClosed(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, now)

	docMap["@context"] = []any{}
	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now})
	ve := asVerifyError(t, err)
	assert.Equal(t, ReasonContextMissing, ve.Reason)
	assert.Equal(t, 400, ve.Status)

	delete(docMap, "@context")
	err = VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{Now: now})
	ve = asVerifyError(t, err)
	assert.Equal(t, ReasonContextMissing, ve.Reason)
}

// TestVerifyAuthorizationResponse_WrongDID_DIDMismatch is SI-4.
// Sign with one key, verify against a different DID — recovery succeeds
// (signature is valid) but the recovered DID does not match expected.
func TestVerifyAuthorizationResponse_WrongDID_DIDMismatch(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	_, _, docMap := signedFixture(t, now)

	otherDID := "did:pkh:eip155:1:0x0000000000000000000000000000000000000099"
	err := VerifyAuthorizationResponse(docMap, otherDID, VerifyOptions{Now: now})
	ve := asVerifyError(t, err)
	assert.Equal(t, ReasonDIDMismatch, ve.Reason)
	assert.Equal(t, 401, ve.Status)
}

// TestVerifyAuthorizationResponse_MixedCaseExpectedDID_Succeeds confirms
// EVM hex addresses and CAIP-2 namespaces compare case-insensitively.
// Without this, an upstream caller passing the DID with a mixed-case
// hex address (e.g., from EIP-55 checksum form) would silently fail
// against a lowercase recovered address — false-negative attack vector.
func TestVerifyAuthorizationResponse_MixedCaseExpectedDID_Succeeds(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, now)

	// Uppercase the address half of the bare DID; namespace+chainRef
	// stay lowercase. EqualFold should accept this.
	parts := strings.Split(signer.did, ":")
	require.Len(t, parts, 5)
	parts[4] = strings.ToUpper(parts[4])
	mixedCaseDID := strings.Join(parts, ":")

	err := VerifyAuthorizationResponse(docMap, mixedCaseDID, VerifyOptions{Now: now})
	require.NoError(t, err, "mixed-case expected DID must match recovered lowercase DID")
}

// TestVerifyAuthorizationResponse_NonEVMExpectedDID_Unsupported asserts
// the eip155-only gate. did:key, did:web, did:pkh:solana etc. report
// unsupported_did_method without attempting recovery.
func TestVerifyAuthorizationResponse_NonEVMExpectedDID_Unsupported(t *testing.T) {
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	_, _, docMap := signedFixture(t, now)

	tests := []string{
		"did:key:z6MkpzExampleKey",
		"did:pkh:solana:mainnet:GjP8WyQyiAH4uPDvQqQDvKtBxxx",
		"did:web:example.com",
		"not-a-did",
		"",
	}
	for _, badDID := range tests {
		t.Run(badDID, func(t *testing.T) {
			err := VerifyAuthorizationResponse(docMap, badDID, VerifyOptions{Now: now})
			ve := asVerifyError(t, err)
			assert.Equal(t, ReasonUnsupportedDIDMethod, ve.Reason)
			assert.Equal(t, 400, ve.Status)
		})
	}
}

// TestVerifyAuthorizationResponse_StaleProof_FailsClosed exercises the
// freshness window's past-edge. proof.created at signTime; verify at
// signTime + 10min with MaxPastAge = 5min → reject.
func TestVerifyAuthorizationResponse_StaleProof_FailsClosed(t *testing.T) {
	signTime := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, signTime)

	verifyTime := signTime.Add(10 * time.Minute)
	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{
		Now:        verifyTime,
		MaxPastAge: 5 * time.Minute,
	})
	ve := asVerifyError(t, err)
	assert.Equal(t, ReasonProofStale, ve.Reason)
	assert.Equal(t, 401, ve.Status)
}

// TestVerifyAuthorizationResponse_FutureSkew_FailsClosed exercises the
// freshness window's future-edge. proof.created in the verifier's
// future beyond MaxFutureSkew → reject.
func TestVerifyAuthorizationResponse_FutureSkew_FailsClosed(t *testing.T) {
	signTime := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, signTime)

	verifyTime := signTime.Add(-2 * time.Minute) // verifier's clock 2min behind signer's
	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{
		Now:           verifyTime,
		MaxFutureSkew: 60 * time.Second,
	})
	ve := asVerifyError(t, err)
	assert.Equal(t, ReasonProofFuture, ve.Reason)
	assert.Equal(t, 401, ve.Status)
}

// TestVerifyAuthorizationResponse_FreshnessWithinWindow_Succeeds asserts
// the boundary holds open: created exactly within the window passes.
func TestVerifyAuthorizationResponse_FreshnessWithinWindow_Succeeds(t *testing.T) {
	signTime := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	signer, _, docMap := signedFixture(t, signTime)

	verifyTime := signTime.Add(4 * time.Minute) // < MaxPastAge
	err := VerifyAuthorizationResponse(docMap, signer.did, VerifyOptions{
		Now:           verifyTime,
		MaxPastAge:    5 * time.Minute,
		MaxFutureSkew: 60 * time.Second,
	})
	require.NoError(t, err)
}

// TestVerifyAuthorizationResponse_NilDoc_FailsClosed confirms the
// no-panic guard at the top of the function. nil doc → proof_malformed,
// not panic.
func TestVerifyAuthorizationResponse_NilDoc_FailsClosed(t *testing.T) {
	err := VerifyAuthorizationResponse(nil, "did:pkh:eip155:1:0xabc", VerifyOptions{})
	ve := asVerifyError(t, err)
	assert.Equal(t, ReasonProofMalformed, ve.Reason)
}

// TestVerifyError_HTTPStatusAndUnwrap confirms the error carries the
// status and wraps the inner error for `errors.Is`/`errors.As` chains.
func TestVerifyError_HTTPStatusAndUnwrap(t *testing.T) {
	inner := errors.New("inner cause")
	ve := &VerifyError{Status: 401, Reason: "x", Err: inner}
	assert.Equal(t, 401, ve.HTTPStatus())
	assert.True(t, errors.Is(ve, inner), "errors.Is must traverse Unwrap")
	assert.Contains(t, ve.Error(), "x")
	assert.Contains(t, ve.Error(), "inner cause")
}
