package authorizationresponse

import (
	"crypto/ecdsa"
	"encoding/json"
	"strings"
	"testing"
	"time"

	. "github.com/atum-labs/protocol/schemas/declarations/AuthorizationResponse/v1/bindings/go/generated"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// testSecp256k1Signer satisfies [ProofSigner] by signing the Data Integrity
// digest with a secp256k1 key via the shared ld-data-integrity primitives
// (crypto.Sign + BuildSecp256k1JWS), plus the DID-URL and suite-identifier
// bookkeeping BuildAuthorizationResponse expects.
type testSecp256k1Signer struct {
	priv *ecdsa.PrivateKey
	did  string // bare did:pkh, lowercased
}

func (s *testSecp256k1Signer) Sign(digest []byte) (string, error) {
	sig, err := crypto.Sign(digest, s.priv)
	if err != nil {
		return "", err
	}
	sig[64] += 27 // go-ethereum v {0,1} -> W3C/EIP-191 {27,28}
	return lddataintegrity.BuildSecp256k1JWS(sig)
}
func (s *testSecp256k1Signer) VerificationMethod() string { return s.did + "#blockchainAccountId" }
func (s *testSecp256k1Signer) SuiteType() string {
	return string(DataIntegrityProofTypeEcdsaSecp256K1RecoverySignature2020)
}

// newTestSigner builds a deterministic ECDSA signer + the matching
// did:pkh DID (secp256k1 exponent 1 — a well-known test key).
func newTestSigner(t *testing.T) *testSecp256k1Signer {
	t.Helper()
	key, err := crypto.HexToECDSA("0000000000000000000000000000000000000000000000000000000000000001")
	require.NoError(t, err)
	addr := strings.ToLower(crypto.PubkeyToAddress(key.PublicKey).Hex())
	did := "did:pkh:eip155:1:" + addr
	return &testSecp256k1Signer{priv: key, did: did}
}

// TestBuildAuthorizationResponse_AuthorizedRoundTrip is the load-bearing
// correctness test for the sign side. We do NOT call VerifyAuthorizationResponse
// here; instead we recompute combinedHash from the produced response and verify
// the JWS against it directly via the shared ld-data-integrity verifier. Catches
// every layer of the build pipeline: schema population, doc canonicalization,
// proof-options canonicalization, hash composition, signing, JWS attachment.
func TestBuildAuthorizationResponse_AuthorizedRoundTrip(t *testing.T) {
	signer := newTestSigner(t)
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)

	resp, err := BuildAuthorizationResponse(
		SchemaJsonStatusAuthorized,
		"pay-12345",
		signer.did,
		nil, // no reason for authorized
		signer,
		now,
	)
	require.NoError(t, err)
	require.NotNil(t, resp)
	require.NotNil(t, resp.Proof)
	require.NotNil(t, resp.Proof.Jws, "ECDSA proof must populate jws")
	require.True(t, strings.Contains(*resp.Proof.Jws, ".."),
		"jws must be a detached JWS (header..signature)")

	assert.Equal(t, []string{
		AuthorizationResponseContextURL,
		lddataintegrity.Secp256k1Recovery2020V2CtxURL,
	}, resp.Context, "@context must list both message and suite contexts")
	assert.Equal(t, SchemaJsonStatusAuthorized, resp.Status)
	assert.Equal(t, "pay-12345", resp.PaymentId)
	assert.Equal(t, signer.did, resp.CounterpartyDid)
	assert.Equal(t, signer.VerificationMethod(), resp.Proof.VerificationMethod)
	assert.Equal(t, DataIntegrityProofProofPurposeAssertionMethod, resp.Proof.ProofPurpose)
	assert.Equal(t, now, resp.Proof.Created, "Created should be the truncated `now`")
	assert.Nil(t, resp.Proof.ProofValue, "ECDSA path must not populate proofValue")

	// Recompute combinedHash from the produced response and verify the JWS
	// against it. If the verifier-side computation diverges from the
	// signer's, this assertion fails — the same code path verification.go uses.
	docMap, err := responseToMap(resp)
	require.NoError(t, err)
	digest, err := combinedHashFromMap(docMap, lddataintegrity.Secp256k1Recovery2020V2CtxURL)
	require.NoError(t, err)

	_, sig, err := lddataintegrity.ParseSecp256k1JWS(*resp.Proof.Jws)
	require.NoError(t, err)
	addr, err := lddataintegrity.RecoverSecp256k1Signer(digest, sig)
	require.NoError(t, err, "JWS must verify against the recomputed combinedHash")
	assert.Equal(t, crypto.PubkeyToAddress(signer.priv.PublicKey), addr,
		"recovered address must equal the signer's address")
}

// TestBuildAuthorizationResponse_DeclinedRequiresReason exercises the
// contract that a declined response must carry a reason string —
// otherwise the originator has no information to surface to the merchant.
func TestBuildAuthorizationResponse_DeclinedRequiresReason(t *testing.T) {
	signer := newTestSigner(t)
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)

	_, err := BuildAuthorizationResponse(
		SchemaJsonStatusDeclined,
		"pay-12345",
		signer.did,
		nil, // missing reason
		signer,
		now,
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "reason required when status=declined")

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
	require.NotNil(t, resp.Reason)
	assert.Equal(t, "insufficient_funds", *resp.Reason)
	assert.Equal(t, SchemaJsonStatusDeclined, resp.Status)
}

// TestBuildAuthorizationResponse_NilSigner_FailsClosed asserts the input
// validation gate. A misconfigured caller must not silently produce an
// unsigned response.
func TestBuildAuthorizationResponse_NilSigner_FailsClosed(t *testing.T) {
	_, err := BuildAuthorizationResponse(
		SchemaJsonStatusAuthorized,
		"pay-1",
		"did:pkh:eip155:1:0xabc",
		nil,
		nil,
		time.Now(),
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "signer is required")
}

// TestBuildAuthorizationResponse_RequiredFields covers the empty-string
// guards on paymentID and counterpartyDID. SI-5 fail-closed pattern at
// the build boundary — keeps malformed inputs from producing canonically
// "valid but useless" signed responses.
func TestBuildAuthorizationResponse_RequiredFields(t *testing.T) {
	signer := newTestSigner(t)
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)

	_, err := BuildAuthorizationResponse(
		SchemaJsonStatusAuthorized, "", signer.did, nil, signer, now,
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "paymentID is required")

	_, err = BuildAuthorizationResponse(
		SchemaJsonStatusAuthorized, "pay-1", "", nil, signer, now,
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "counterpartyDID is required")
}

// TestBuildAuthorizationResponse_UnsupportedSuite_FailsClosed asserts
// the suite-dispatch gate rejects suites the build path does not yet
// support (Ed25519 in this commit). Confirms the error message is
// directive — operators reading logs see WHY the build refused.
func TestBuildAuthorizationResponse_UnsupportedSuite_FailsClosed(t *testing.T) {
	bad := &fakeSigner{suite: string(DataIntegrityProofTypeEd25519Signature2020)}
	_, err := BuildAuthorizationResponse(
		SchemaJsonStatusAuthorized,
		"pay-1",
		"did:pkh:solana:mainnet:abc",
		nil,
		bad,
		time.Now(),
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "Ed25519Signature2020 not yet supported")

	worse := &fakeSigner{suite: "Bogus2099"}
	_, err = BuildAuthorizationResponse(
		SchemaJsonStatusAuthorized,
		"pay-1",
		"did:pkh:eip155:1:0xabc",
		nil,
		worse,
		time.Now(),
	)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "unsupported suite type")
}

// fakeSigner is a no-op ProofSigner used to exercise dispatch errors —
// it never actually signs because the build path errors out at suite
// resolution before reaching Sign().
type fakeSigner struct{ suite string }

func (f *fakeSigner) Sign([]byte) (string, error) { return "", nil }
func (f *fakeSigner) VerificationMethod() string  { return "" }
func (f *fakeSigner) SuiteType() string           { return f.suite }

// TestResponseToMap_RoundTrip is a low-level guarantee: marshaling the
// SchemaJson and unmarshaling into map[string]any must preserve the
// shape the canonicalizer expects (proof is an object, @context is an
// array, created is a string after the JSON round-trip).
func TestResponseToMap_RoundTrip(t *testing.T) {
	signer := newTestSigner(t)
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	resp, err := BuildAuthorizationResponse(
		SchemaJsonStatusAuthorized, "pay-1", signer.did, nil, signer, now,
	)
	require.NoError(t, err)

	m, err := responseToMap(resp)
	require.NoError(t, err)

	ctx, ok := m["@context"].([]any)
	require.True(t, ok, "@context must round-trip as []any")
	require.Len(t, ctx, 2)

	proof, ok := m["proof"].(map[string]any)
	require.True(t, ok, "proof must round-trip as map[string]any")

	createdStr, ok := proof["created"].(string)
	require.True(t, ok, "proof.created must round-trip as string (not time.Time)")
	require.True(t, strings.HasSuffix(createdStr, "Z"),
		"proof.created should be RFC 3339 UTC with Z suffix; got %q", createdStr)

	// Confirm the marshaled JSON is what we expect (round-trip stability):
	// re-marshaling the map should produce a JSON document identical to
	// json.Marshal(resp). Catches subtle drift if responseToMap ever
	// changes shape.
	a, _ := json.Marshal(resp)
	b, _ := json.Marshal(m)
	assert.JSONEq(t, string(a), string(b))
}
