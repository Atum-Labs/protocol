package authorizationresponse

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	. "github.com/atum-labs/protocol/schemas/declarations/AuthorizationResponse/v1/bindings/go/generated"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// VerifyError is the typed error returned by [VerifyAuthorizationResponse].
// Status carries the suggested HTTP response code; Reason is a low-cardinality
// tag suitable for OTel span attributes and Prometheus label values without
// further classification at the call site.
type VerifyError struct {
	Status int
	Reason string
	Err    error
}

// Error implements error.
func (e *VerifyError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %v", e.Reason, e.Err)
	}
	return e.Reason
}

// Unwrap returns the underlying cause, if any.
func (e *VerifyError) Unwrap() error { return e.Err }

// HTTPStatus returns the suggested HTTP response code; convenience for
// payment-gw handlers writing a single switch statement.
func (e *VerifyError) HTTPStatus() int { return e.Status }

// VerifyOptions controls the freshness window. Both Max* values default
// to 0 meaning "no check" — handy for unit tests that don't care about
// the clock. Production payment-gw configures both from
// MaxAuthorizationProofAge / MaxAuthorizationProofFutureSkew.
type VerifyOptions struct {
	// Now is the reference instant for freshness comparisons. Zero
	// means "use time.Now()" (production); tests inject a fixed time.
	Now time.Time
	// MaxPastAge rejects proofs whose `created` is older than now - MaxPastAge.
	MaxPastAge time.Duration
	// MaxFutureSkew rejects proofs whose `created` is newer than now + MaxFutureSkew.
	MaxFutureSkew time.Duration
}

// Reason tags emitted by VerifyError. Kept as exported constants so the
// payment-gw handler maps switch cases without repeating string literals.
const (
	ReasonContextMissing         = "context_missing"
	ReasonMissingPaymentID       = "missing_payment_id"
	ReasonMissingCounterpartyDID = "missing_counterparty_did"
	ReasonMissingProof           = "missing_proof"
	ReasonProofMalformed         = "proof_malformed"
	ReasonUnsupportedDIDMethod   = "unsupported_did_method"
	ReasonUnsupportedSuite       = "unsupported_suite"
	ReasonVerifyFailed           = "verify_failed"
	ReasonDIDMismatch            = "did_mismatch"
	ReasonProofStale             = "proof_stale"
	ReasonProofFuture            = "proof_future"
)

// VerifyAuthorizationResponse verifies that the proof on doc was produced
// by the holder of expectedSignerDID's private key, then enforces the
// freshness window in opts. Returns nil on success or *VerifyError on
// any failure.
//
// Algorithm:
//
//  1. Fail-closed (SI-5) on missing @context / payment_id / counterparty_did / proof.
//  2. Validate proof shape and reject unsupported suite types.
//  3. Recompute combinedHash from the raw doc map (SI-6 — proof.created
//     is read verbatim from the wire bytes).
//  4. Recover signer address from proof.jws (ECDSA path).
//  5. Build recoveredDID from the namespace+chainRef the proof CLAIMED
//     plus the address actually recovered; compare to expectedSignerDID.
//  6. Apply freshness window if configured.
//
// SI-4 NOTE: this function proves only that the holder of expectedSignerDID's
// key signed THIS specific document. Cross-checking the doc's payment_id
// and counterparty_did against the originating PaymentRequest is the
// payment-gw handler's responsibility (one layer up).
//
// SI-6 NOTE: doc must be the wire-form map[string]any. Do NOT round-trip
// it through *SchemaJson before calling — Go's time.Time MarshalJSON
// can normalize "Z" vs "+00:00" and silently change the canonical bytes.
func VerifyAuthorizationResponse(
	doc map[string]any,
	expectedSignerDID string,
	opts VerifyOptions,
) error {
	if doc == nil {
		return verifyErr(http.StatusBadRequest, ReasonProofMalformed, errors.New("doc is nil"))
	}

	// SI-5: explicit fail-closed checks on the raw map. These run BEFORE
	// the typed schema decode so each reason tag stays precise.
	ctxArr, ok := doc["@context"].([]any)
	if !ok || len(ctxArr) == 0 {
		return verifyErr(http.StatusBadRequest, ReasonContextMissing,
			errors.New("@context missing or empty"))
	}
	if s, ok := doc["payment_id"].(string); !ok || s == "" {
		return verifyErr(http.StatusBadRequest, ReasonMissingPaymentID,
			errors.New("payment_id missing or empty"))
	}
	if s, ok := doc["counterparty_did"].(string); !ok || s == "" {
		return verifyErr(http.StatusBadRequest, ReasonMissingCounterpartyDID,
			errors.New("counterparty_did missing or empty"))
	}
	proofRaw, ok := doc["proof"].(map[string]any)
	if !ok {
		// Distinguishes "no proof field" from "proof is the wrong type".
		if _, present := doc["proof"]; !present {
			return verifyErr(http.StatusBadRequest, ReasonMissingProof,
				errors.New("proof field is missing"))
		}
		return verifyErr(http.StatusBadRequest, ReasonProofMalformed,
			errors.New("proof field is not a JSON object"))
	}

	// SI-4 (DID half): expectedSignerDID must be a bare did:pkh DID
	// targeting the eip155 namespace (only suite supported in this build).
	expectedChainID, _, err := ParseDIDPKH(expectedSignerDID)
	if err != nil {
		return verifyErr(http.StatusBadRequest, ReasonUnsupportedDIDMethod,
			fmt.Errorf("expectedSignerDID: %w", err))
	}
	expectedNamespace, _, _ := strings.Cut(expectedChainID, ":")
	if !strings.EqualFold(expectedNamespace, "eip155") {
		return verifyErr(http.StatusBadRequest, ReasonUnsupportedDIDMethod,
			fmt.Errorf("only eip155 supported in this build, got %q", expectedNamespace))
	}

	// Suite dispatch.
	proofType, _ := proofRaw["type"].(string)
	switch proofType {
	case string(DataIntegrityProofTypeEcdsaSecp256K1RecoverySignature2020):
		if err := verifyECDSA(doc, proofRaw, expectedSignerDID); err != nil {
			return err
		}
	case string(DataIntegrityProofTypeEd25519Signature2020):
		return verifyErr(http.StatusBadRequest, ReasonUnsupportedSuite,
			errors.New("Ed25519Signature2020 not yet supported (follow-up commit)"))
	case "":
		return verifyErr(http.StatusBadRequest, ReasonProofMalformed,
			errors.New("proof.type missing"))
	default:
		return verifyErr(http.StatusBadRequest, ReasonUnsupportedSuite,
			fmt.Errorf("unknown suite type: %q", proofType))
	}

	// Freshness check is the last gate — runs after cryptographic
	// verification so a stale-but-valid proof reports proof_stale, not
	// verify_failed. Order matters for OTel reason cardinality.
	if opts.MaxPastAge > 0 || opts.MaxFutureSkew > 0 {
		if err := checkFreshness(proofRaw, opts); err != nil {
			return err
		}
	}
	return nil
}

// verifyECDSA recovers the EVM address from proof.jws, builds the
// recovered did:pkh from the namespace+chainRef the proof CLAIMED, and
// compares it to expectedSignerDID via case-insensitive equality
// (CAIP-2 namespaces and EVM addresses are both case-insensitive).
//
// Building the recovered DID from the proof's claimed namespace+chainRef
// (not from expectedSignerDID) means that if the proof was signed under
// a different chain context than what was claimed, recovery still
// produces a non-matching DID — chainRef tampering fails closed.
func verifyECDSA(
	doc map[string]any,
	proofRaw map[string]any,
	expectedSignerDID string,
) error {
	jws, ok := proofRaw["jws"].(string)
	if !ok || jws == "" {
		return verifyErr(http.StatusBadRequest, ReasonProofMalformed,
			errors.New("proof.jws missing for EcdsaSecp256k1RecoverySignature2020"))
	}
	verificationMethod, _ := proofRaw["verificationMethod"].(string)
	if verificationMethod == "" {
		return verifyErr(http.StatusBadRequest, ReasonProofMalformed,
			errors.New("proof.verificationMethod missing"))
	}

	namespace, chainRef, addressClaimed, err := ParsePkhDIDURL(verificationMethod)
	if err != nil {
		return verifyErr(http.StatusBadRequest, ReasonUnsupportedDIDMethod,
			fmt.Errorf("proof.verificationMethod: %w", err))
	}
	if !strings.EqualFold(namespace, "eip155") {
		return verifyErr(http.StatusBadRequest, ReasonUnsupportedDIDMethod,
			fmt.Errorf("expected eip155 in verificationMethod, got %q", namespace))
	}

	digest, err := combinedHashFromMap(doc, lddataintegrity.Secp256k1Recovery2020V2CtxURL)
	if err != nil {
		return verifyErr(http.StatusBadRequest, ReasonProofMalformed, err)
	}

	// Parse the detached ES256K-R JWS then recover the signer address against
	// the digest, via the shared ld-data-integrity primitives (same path
	// FQ/PR verification use). Both failure modes map to verify_failed to
	// preserve the prior single-error verify contract.
	_, sig, err := lddataintegrity.ParseSecp256k1JWS(jws)
	if err != nil {
		return verifyErr(http.StatusUnauthorized, ReasonVerifyFailed, err)
	}
	recoveredAddr, err := lddataintegrity.RecoverSecp256k1Signer(digest, sig)
	if err != nil {
		return verifyErr(http.StatusUnauthorized, ReasonVerifyFailed, err)
	}

	recoveredDID := fmt.Sprintf("did:pkh:%s:%s:%s",
		strings.ToLower(namespace),
		chainRef,
		strings.ToLower(recoveredAddr.Hex()),
	)
	if !strings.EqualFold(recoveredDID, expectedSignerDID) {
		return verifyErr(http.StatusUnauthorized, ReasonDIDMismatch,
			fmt.Errorf("recovered=%s expected=%s", recoveredDID, expectedSignerDID))
	}
	if !strings.EqualFold(addressClaimed, recoveredAddr.Hex()) {
		return verifyErr(http.StatusUnauthorized, ReasonDIDMismatch,
			fmt.Errorf("verificationMethod claimed %s but signature recovered %s",
				addressClaimed, recoveredAddr.Hex()))
	}
	return nil
}

// checkFreshness reads proof.created from the raw map (string form)
// and rejects the proof if it falls outside the configured window.
// time.Parse(time.RFC3339, ...) accepts both Z and ±HH:MM forms — we
// don't care which the signer used, only that we can parse it back to
// a time.Time for arithmetic.
func checkFreshness(proofRaw map[string]any, opts VerifyOptions) error {
	createdStr, ok := proofRaw["created"].(string)
	if !ok || createdStr == "" {
		return verifyErr(http.StatusBadRequest, ReasonProofMalformed,
			errors.New("proof.created missing"))
	}
	created, err := time.Parse(time.RFC3339, createdStr)
	if err != nil {
		return verifyErr(http.StatusBadRequest, ReasonProofMalformed,
			fmt.Errorf("proof.created not RFC 3339: %w", err))
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	delta := now.Sub(created)
	if opts.MaxPastAge > 0 && delta > opts.MaxPastAge {
		return verifyErr(http.StatusUnauthorized, ReasonProofStale,
			fmt.Errorf("proof.created is %s old, max %s",
				delta.Truncate(time.Second), opts.MaxPastAge))
	}
	if opts.MaxFutureSkew > 0 && -delta > opts.MaxFutureSkew {
		return verifyErr(http.StatusUnauthorized, ReasonProofFuture,
			fmt.Errorf("proof.created is %s in the future, max skew %s",
				(-delta).Truncate(time.Second), opts.MaxFutureSkew))
	}
	return nil
}

func verifyErr(status int, reason string, err error) *VerifyError {
	return &VerifyError{Status: status, Reason: reason, Err: err}
}
