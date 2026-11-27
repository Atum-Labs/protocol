// Package verifill provides a high-level client for the Veri-Fill API with retry logic.
// This package wraps the auto-generated client code and adds production-ready features
// like exponential backoff, polling, and request validation.
package verifill

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	gen "github.com/atum-labs/protocol/schemas/apis/veri-fill/v1/bindings/go/generated"
)

// ErrVerdictPending means veri-fill could not determine the outcome yet. It is NOT a finding
// about the payment: a caller must keep the payment pending and re-ask, and must never map it
// to a terminal state. Test for it with errors.Is.
var ErrVerdictPending = errors.New("fulfillment outcome not yet determined")

// ErrFulfillmentNotDelivered means veri-fill established that the payment was NOT delivered.
// Terminal, and the only sentinel here that reports a proven negative. Test for it with
// errors.Is rather than matching on message text.
//
// It exists because the pending case had a sentinel and this one did not, which left a caller
// wanting the difference with nothing but a string to match on — the same failure this client
// already had once, when a substring match on text no value in the enum contains meant nothing
// was ever retried.
var ErrFulfillmentNotDelivered = errors.New("fulfillment was established as not delivered")

// ErrDeadlineExceeded means the payment WAS delivered and landed outside the window the caller
// asked about. Terminal, and NOT a negative: the recipient has the funds.
//
// Kept distinct from ErrFulfillmentNotDelivered on purpose. Folding the two would hand a caller
// one sentinel covering both "nobody was paid" and "the recipient was paid", and a refund on the
// second is a double payout.
var ErrDeadlineExceeded = errors.New("fulfillment was delivered after the deadline")

// verdictSentinelFor maps a terminal response code to its sentinel, so the wrapping happens in
// one place and a code without a sentinel is wrapped as itself rather than silently losing its
// meaning.
func verdictSentinelFor(code VerifyFulfillmentResponseError) error {
	switch code {
	case VerifyFulfillmentResponseErrorFULFILLMENTNOTDELIVERED:
		return ErrFulfillmentNotDelivered
	case VerifyFulfillmentResponseErrorDEADLINEEXCEEDED:
		return ErrDeadlineExceeded
	}
	return nil
}

// retryableVerifyErrors are the response error codes that mean veri-fill could not reach a
// conclusion, so asking again may succeed. Every other code is permanent.
//
// This is keyed off the enum rather than the message text because the text is not a contract:
// an earlier version matched on the substring "not found", which no value in the enum contains,
// so nothing was ever retried.
var retryableVerifyErrors = map[VerifyFulfillmentResponseError]bool{
	VerifyFulfillmentResponseErrorVERIFICATIONERROR:  true,
	VerifyFulfillmentResponseErrorVERIFICATIONFAILED: true,

	// Listed explicitly at false rather than left to the zero value, because these two are
	// the codes most likely to be mistaken for transient: both report a conclusion, and
	// DEADLINE_EXCEEDED arrives alongside a delivered verdict, so asking again returns the
	// same answer forever.
	VerifyFulfillmentResponseErrorDEADLINEEXCEEDED:        false,
	VerifyFulfillmentResponseErrorFULFILLMENTNOTDELIVERED: false,
}

// codeSignatureGenerationFailed is the shared public error code veri-fill returns
// (see schemas/apis/error/v1/catalog.json) when signing fails. A signing failure
// is deterministic, so callers must treat it as non-retryable.
const codeSignatureGenerationFailed = "SIGNATURE_GENERATION_FAILED"

// sharedErrorCode reads the public "code" from veri-fill's shared ErrorResponse
// body, which is returned on every 4xx/5xx. Empty string if the body is not that shape.
func sharedErrorCode(body []byte) string {
	var e struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(body, &e)
	return e.Code
}

// Re-export all generated types for convenience so consumers don't need to import generated package
type (
	// Request types

	// VerifyFulfillmentRequest re-exports [gen.VerifyFulfillmentRequest].
	VerifyFulfillmentRequest = gen.VerifyFulfillmentRequest
	// RefundSignatureRequest re-exports [gen.RefundSignatureRequest].
	RefundSignatureRequest = gen.RefundSignatureRequest
	// ReserveLocation re-exports [gen.ReserveLocation].
	ReserveLocation = gen.ReserveLocation
	// FulfillmentAuthorization re-exports [gen.FulfillmentAuthorization].
	FulfillmentAuthorization = gen.FulfillmentAuthorization
	// SignatureValidityRequest re-exports [gen.SignatureValidityRequest].
	SignatureValidityRequest = gen.SignatureValidityRequest
	// ReserveSignatureValidityRequest re-exports [gen.ReserveSignatureValidityRequest].
	ReserveSignatureValidityRequest = gen.ReserveSignatureValidityRequest

	// Response types

	// VerifyFulfillmentResponse re-exports [gen.VerifyFulfillmentResponse].
	VerifyFulfillmentResponse = gen.VerifyFulfillmentResponse
	// RefundSignatureResponse re-exports [gen.RefundSignatureResponse].
	RefundSignatureResponse = gen.RefundSignatureResponse
	// VerificationDetails re-exports [gen.VerificationDetails].
	VerificationDetails = gen.VerificationDetails
	// FulfillmentVerdict re-exports [gen.FulfillmentVerdict].
	FulfillmentVerdict = gen.FulfillmentVerdict
	// DepositVerdict re-exports [gen.DepositVerdict].
	DepositVerdict = gen.DepositVerdict
	// HealthResponse re-exports [gen.HealthResponse].
	HealthResponse = gen.HealthResponse
	// HealthResponseStatus re-exports [gen.HealthResponseStatus].
	HealthResponseStatus = gen.HealthResponseStatus
	// HealthResponseChains re-exports [gen.HealthResponseChains].
	HealthResponseChains = gen.HealthResponseChains
	// ErrorResponse re-exports [gen.ErrorResponse].
	ErrorResponse = gen.ErrorResponse
	// PublicKeyResponse re-exports [gen.PublicKeyResponse].
	PublicKeyResponse = gen.PublicKeyResponse
	// PublicKeysResponse re-exports [gen.PublicKeysResponse].
	PublicKeysResponse = gen.PublicKeysResponse
	// SignatureValidityResponse re-exports [gen.SignatureValidityResponse].
	SignatureValidityResponse = gen.SignatureValidityResponse

	// Generated client (re-exported so consumers can build their own client without importing the gen subpackage)

	// ClientWithResponses re-exports [gen.ClientWithResponses].
	ClientWithResponses = gen.ClientWithResponses

	// Verdict enums

	// FulfillmentVerdictOutcome re-exports [gen.FulfillmentVerdictOutcome].
	FulfillmentVerdictOutcome = gen.FulfillmentVerdictOutcome
	// DepositVerdictOutcome re-exports [gen.DepositVerdictOutcome].
	DepositVerdictOutcome = gen.DepositVerdictOutcome
	// VerdictSignatureScheme re-exports [gen.VerdictSignatureScheme].
	VerdictSignatureScheme = gen.VerdictSignatureScheme

	// Signature-validity enums

	// SignatureValidityPath re-exports [gen.SignatureValidityPath].
	SignatureValidityPath = gen.SignatureValidityPath
	// SignatureValidityReason re-exports [gen.SignatureValidityReason].
	SignatureValidityReason = gen.SignatureValidityReason

	// Error enums

	// VerifyFulfillmentResponseError re-exports [gen.VerifyFulfillmentResponseError].
	VerifyFulfillmentResponseError = gen.VerifyFulfillmentResponseError
	// RefundSignatureResponseError re-exports [gen.RefundSignatureResponseError].
	RefundSignatureResponseError = gen.RefundSignatureResponseError

	// HTTP response types (for advanced usage)

	// VerifyFulfillmentHTTPResponse re-exports [gen.VerifyFulfillmentHTTPResponse].
	VerifyFulfillmentHTTPResponse = gen.VerifyFulfillmentHTTPResponse
	// GenerateRefundSignatureHTTPResponse re-exports [gen.GenerateRefundSignatureHTTPResponse].
	GenerateRefundSignatureHTTPResponse = gen.GenerateRefundSignatureHTTPResponse
	// CheckSignatureValidityHTTPResponse re-exports [gen.CheckSignatureValidityHTTPResponse].
	CheckSignatureValidityHTTPResponse = gen.CheckSignatureValidityHTTPResponse
	// CheckReserveSignatureValidityHTTPResponse re-exports [gen.CheckReserveSignatureValidityHTTPResponse].
	CheckReserveSignatureValidityHTTPResponse = gen.CheckReserveSignatureValidityHTTPResponse
	// GetHealthHTTPResponse re-exports [gen.GetHealthHTTPResponse].
	GetHealthHTTPResponse = gen.GetHealthHTTPResponse

	// Server interface

	// ServerInterface re-exports [gen.ServerInterface].
	ServerInterface = gen.ServerInterface
)

// Re-export error constants
const (
	// VerifyFulfillmentResponse errors
	VerifyFulfillmentResponseErrorINVALIDREQUEST     = gen.VerifyFulfillmentResponseErrorINVALIDREQUEST
	VerifyFulfillmentResponseErrorUNSUPPORTEDCHAIN   = gen.VerifyFulfillmentResponseErrorUNSUPPORTEDCHAIN
	VerifyFulfillmentResponseErrorINVALIDAMOUNT      = gen.VerifyFulfillmentResponseErrorINVALIDAMOUNT
	VerifyFulfillmentResponseErrorVERIFICATIONERROR  = gen.VerifyFulfillmentResponseErrorVERIFICATIONERROR
	VerifyFulfillmentResponseErrorVERIFICATIONFAILED = gen.VerifyFulfillmentResponseErrorVERIFICATIONFAILED
	VerifyFulfillmentResponseErrorSIGNATUREERROR     = gen.VerifyFulfillmentResponseErrorSIGNATUREERROR

	// The only value that reports a proven negative. VERIFICATION_FAILED means verification
	// could not be completed, which is the undetermined case.
	VerifyFulfillmentResponseErrorFULFILLMENTNOTDELIVERED = gen.VerifyFulfillmentResponseErrorFULFILLMENTNOTDELIVERED

	// Terminal, and the recipient WAS paid: it accompanies a delivered verdict and reports
	// that the delivery fell outside the window the caller asked about. Never a negative.
	VerifyFulfillmentResponseErrorDEADLINEEXCEEDED = gen.VerifyFulfillmentResponseErrorDEADLINEEXCEEDED

	// RefundSignatureResponse errors
	RefundSignatureResponseErrorINVALIDREQUEST   = gen.RefundSignatureResponseErrorINVALIDREQUEST
	RefundSignatureResponseErrorUNSUPPORTEDCHAIN = gen.RefundSignatureResponseErrorUNSUPPORTEDCHAIN
	RefundSignatureResponseErrorSIGNATUREERROR   = gen.RefundSignatureResponseErrorSIGNATUREERROR

	// Terminal, and accompanied by a deposit verdict whose outcome is not_held. It says there
	// is nothing here to refund, NOT that the payment failed: the same escrow answer covers a
	// deposit already released, which means the recipient was paid.
	RefundSignatureResponseErrorDEPOSITNOTHELD = gen.RefundSignatureResponseErrorDEPOSITNOTHELD

	// FulfillmentVerdict outcomes. Only the first two are terminal: Undetermined is a
	// signed answer about a named block, not a failure, and negating Delivered collapses
	// the two apart.
	FulfillmentVerdictOutcomeDelivered    = gen.FulfillmentVerdictOutcomeDelivered
	FulfillmentVerdictOutcomeNotDelivered = gen.FulfillmentVerdictOutcomeNotDelivered
	FulfillmentVerdictOutcomeUndetermined = gen.FulfillmentVerdictOutcomeUndetermined

	// DepositVerdict outcomes. Only the first two are terminal, and NotHeld says nothing
	// about why: the escrow answers the same for never deposited, already released and
	// already refunded, and one of those means the recipient was paid.
	DepositVerdictOutcomeHeld         = gen.DepositVerdictOutcomeHeld
	DepositVerdictOutcomeNotHeld      = gen.DepositVerdictOutcomeNotHeld
	DepositVerdictOutcomeUndetermined = gen.DepositVerdictOutcomeUndetermined

	// Verdict signature schemes, one per chain family. Shared by every attestation kind
	// this service signs, because the scheme follows from the chain and not from the kind.
	VerdictSignatureSchemeEip712Secp256k1 = gen.VerdictSignatureSchemeEip712Secp256k1
	VerdictSignatureSchemeTip191Secp256k1 = gen.VerdictSignatureSchemeTip191Secp256k1
	VerdictSignatureSchemeEd25519Raw      = gen.VerdictSignatureSchemeEd25519Raw

	// SignatureValidityPath values: the branch of the verifying contract's rule (Permit2 or the
	// escrow) a verdict was reached on.
	SignatureValidityPathEoa      = gen.SignatureValidityPathEoa
	SignatureValidityPathContract = gen.SignatureValidityPathContract
	SignatureValidityPathNone     = gen.SignatureValidityPathNone

	// SignatureValidityReason values. The two rejections and Malformed are refusals: Unverifiable
	// and UnsupportedChain say veri-fill could not answer, and an unlisted value is no refusal either.
	SignatureValidityReasonVerified                  = gen.SignatureValidityReasonVerified
	SignatureValidityReasonSignerMismatch            = gen.SignatureValidityReasonSignerMismatch
	SignatureValidityReasonContractSignatureRejected = gen.SignatureValidityReasonContractSignatureRejected
	SignatureValidityReasonSignatureUnverifiable     = gen.SignatureValidityReasonSignatureUnverifiable
	SignatureValidityReasonUnsupportedChain          = gen.SignatureValidityReasonUnsupportedChain
	SignatureValidityReasonMalformed                 = gen.SignatureValidityReasonMalformed

	// HealthResponseStatus values
	HealthResponseStatusHealthy   = gen.HealthResponseStatusHealthy
	HealthResponseStatusDegraded  = gen.HealthResponseStatusDegraded
	HealthResponseStatusUnhealthy = gen.HealthResponseStatusUnhealthy

	// HealthResponseChains values
	HealthResponseChainsHealthy   = gen.HealthResponseChainsHealthy
	HealthResponseChainsUnhealthy = gen.HealthResponseChainsUnhealthy
)

// NewClientWithResponses re-exports the generated client constructor so consumers
// can build a low-level client without importing the gen subpackage directly.
var NewClientWithResponses = gen.NewClientWithResponses

// VerifillHTTPClient extends the generated client with retry logic and polling.
// This maintains the same name as the settler gateway's existing client for compatibility.
type VerifillHTTPClient struct {
	client *gen.ClientWithResponses
	config *ClientConfig
}

// ClientConfig holds configuration for the Veri-Fill client
type ClientConfig struct {
	// HTTPClient to use for requests (optional, defaults to http.DefaultClient)
	HTTPClient *http.Client

	// Retry configuration
	InitialBackoff time.Duration
	MaxBackoff     time.Duration
	BackoffFactor  float64

	// Polling configuration for fulfillment verification
	PollingInterval time.Duration
	MaxPollingTime  time.Duration
}

// DefaultConfig returns a ClientConfig with sensible defaults
func DefaultConfig() *ClientConfig {
	return &ClientConfig{
		HTTPClient:      &http.Client{Timeout: 30 * time.Second},
		InitialBackoff:  2 * time.Second,
		MaxBackoff:      30 * time.Second,
		BackoffFactor:   1.5,
		PollingInterval: 5 * time.Second,
		MaxPollingTime:  10 * time.Minute,
	}
}

// ClientOption allows customizing the client configuration
type ClientOption func(*ClientConfig)

// WithHTTPClient sets a custom HTTP client
func WithHTTPClient(client *http.Client) ClientOption {
	return func(c *ClientConfig) {
		c.HTTPClient = client
	}
}

// WithRetryConfig sets custom retry parameters
func WithRetryConfig(initialBackoff, maxBackoff time.Duration, backoffFactor float64) ClientOption {
	return func(c *ClientConfig) {
		c.InitialBackoff = initialBackoff
		c.MaxBackoff = maxBackoff
		c.BackoffFactor = backoffFactor
	}
}

// WithPollingConfig sets custom polling parameters for fulfillment verification
func WithPollingConfig(interval, maxTime time.Duration) ClientOption {
	return func(c *ClientConfig) {
		c.PollingInterval = interval
		c.MaxPollingTime = maxTime
	}
}

// NewVerifillHTTPClient creates a new Veri-Fill client with the given endpoint.
// This name matches the settler gateway's existing client for drop-in compatibility.
// The endpoint should be the base URL of the veri-fill service (e.g., "https://veri-fill.example.com")
func NewVerifillHTTPClient(endpoint string, opts ...ClientOption) (*VerifillHTTPClient, error) {
	config := DefaultConfig()
	for _, opt := range opts {
		opt(config)
	}

	// Create the generated client with our HTTP client
	genClient, err := gen.NewClientWithResponses(endpoint, gen.WithHTTPClient(config.HTTPClient))
	if err != nil {
		return nil, fmt.Errorf("failed to create veri-fill client: %w", err)
	}

	return &VerifillHTTPClient{
		client: genClient,
		config: config,
	}, nil
}

// RequestReleaseSignature polls veri-fill until signature is obtained or timeout occurs.
// This method implements the polling logic that was previously in the settler gateway.
// Retries while veri-fill reports it could not reach a conclusion, and fails immediately on a
// permanent code. Exhausting the budget returns an error wrapping ErrVerdictPending, so a caller
// can tell an undetermined outcome apart from a failed payment. The request names no payment, so
// expectedPaymentID is the deposit the caller funded, and a response or verdict about any other
// payment is refused.
func (c *VerifillHTTPClient) RequestReleaseSignature(ctx context.Context, request *VerifyFulfillmentRequest, expectedPaymentID string) (*VerifyFulfillmentResponse, error) {
	// Validate request
	if err := ValidateVerifyFulfillmentRequest(request); err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}
	if !bytes32HexRegex.MatchString(expectedPaymentID) {
		return nil, fmt.Errorf("invalid request: expected payment id must be a 0x-prefixed 32-byte hex string")
	}
	// The chain a verdict must be about is the destination the quote names.
	quote, err := ReleaseQuote(request)
	if err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}
	destinationChainID, err := DestinationChainID(quote)
	if err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}

	backoff := c.config.InitialBackoff
	startTime := time.Now()

	for {
		// Check context and timeout
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("context canceled: %w", err)
		}

		if time.Since(startTime) > c.config.MaxPollingTime {
			return nil, fmt.Errorf("polling budget %v exhausted while the outcome was undetermined: %w", c.config.MaxPollingTime, ErrVerdictPending)
		}

		// Make request
		resp, err := c.client.VerifyFulfillmentWithResponse(ctx, *request)
		if err != nil {
			// Network error - retry with backoff
			select {
			case <-time.After(backoff):
				backoff = c.nextBackoff(backoff)
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}

		// Check HTTP status
		if resp.StatusCode() != http.StatusOK {
			// Check if retryable based on status and error
			if resp.StatusCode() >= 500 {
				// Server error - retry
				select {
				case <-time.After(backoff):
					backoff = c.nextBackoff(backoff)
					continue
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}

			// 4xx errors are not retryable
			if resp.JSON400 != nil {
				return nil, fmt.Errorf("bad request: %s", sharedErrorCode(resp.Body))
			}
			return nil, fmt.Errorf("veri-fill returned status %d", resp.StatusCode())
		}

		// Success response
		if resp.JSON200 != nil {
			// veri-fill answers 200 only once it has derived the deposit, so every 200 names one.
			if !strings.EqualFold(resp.JSON200.PaymentId, expectedPaymentID) {
				return resp.JSON200, fmt.Errorf("veri-fill answered about payment %q, not %s", resp.JSON200.PaymentId, expectedPaymentID)
			}
			if resp.JSON200.Verified {
				if err := c.checkVerdictAgainstResponse(resp.JSON200, expectedPaymentID, destinationChainID); err != nil {
					return resp.JSON200, fmt.Errorf("veri-fill reported success but its verdict is unusable: %w", err)
				}
				return resp.JSON200, nil
			}

			// Not verified yet - check error type
			if resp.JSON200.Error != nil {
				code := *resp.JSON200.Error
				if retryableVerifyErrors[code] {
					select {
					case <-time.After(c.config.PollingInterval):
						continue
					case <-ctx.Done():
						return nil, ctx.Err()
					}
				}
				// Every other code is permanent. The response is returned alongside the error
				// because it carries the verdict, which a caller needs in order to act.
				if err := c.checkVerdictAgainstResponse(resp.JSON200, expectedPaymentID, destinationChainID); err != nil {
					return resp.JSON200, fmt.Errorf("verification failed: %s, and its verdict is unusable: %w", string(code), err)
				}
				if sentinel := verdictSentinelFor(code); sentinel != nil {
					return resp.JSON200, fmt.Errorf("verification failed: %s: %w", string(code), sentinel)
				}
				return resp.JSON200, fmt.Errorf("verification failed: %s", string(code))
			}

			// No error but not verified - keep polling (transaction might be pending)
			select {
			case <-time.After(c.config.PollingInterval):
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}

		// Unexpected response format - retry
		select {
		case <-time.After(backoff):
			backoff = c.nextBackoff(backoff)
			continue
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// RequestRefundSignature requests a refund signature with retry logic.
// Unlike release signatures, refund signatures don't require polling as there's no blockchain state to verify.
func (c *VerifillHTTPClient) RequestRefundSignature(ctx context.Context, request *RefundSignatureRequest) (*RefundSignatureResponse, error) {
	// Validate request
	if err := ValidateRefundSignatureRequest(request); err != nil {
		return nil, fmt.Errorf("invalid request: %w", err)
	}

	backoff := c.config.InitialBackoff
	attempts := 0
	maxAttempts := 5

	for attempts < maxAttempts {
		// Check context
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("context canceled: %w", err)
		}

		// Make request
		resp, err := c.client.GenerateRefundSignatureWithResponse(ctx, *request)
		if err != nil {
			// Network error - retry with backoff
			attempts++
			select {
			case <-time.After(backoff):
				backoff = c.nextBackoff(backoff)
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}

		// Check HTTP status
		if resp.StatusCode() != http.StatusOK {
			// Check if retryable based on status
			if resp.StatusCode() >= 500 {
				// A signature generation failure is deterministic, so it is not
				// retryable. veri-fill now returns the shared error envelope, so
				// key off its public code rather than the old domain error enum.
				if sharedErrorCode(resp.Body) == codeSignatureGenerationFailed {
					return nil, fmt.Errorf("signature generation failed")
				}

				// Other 5xx errors are retryable
				attempts++
				select {
				case <-time.After(backoff):
					backoff = c.nextBackoff(backoff)
					continue
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}

			// 4xx errors are not retryable
			if resp.JSON400 != nil {
				return nil, fmt.Errorf("bad request: %s", sharedErrorCode(resp.Body))
			}
			return nil, fmt.Errorf("veri-fill returned status %d", resp.StatusCode())
		}

		// Success response
		if resp.JSON200 != nil {
			return resp.JSON200, nil
		}

		// Unexpected response format - retry
		attempts++
		select {
		case <-time.After(backoff):
			backoff = c.nextBackoff(backoff)
			continue
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}

	return nil, fmt.Errorf("max retry attempts (%d) exceeded", maxAttempts)
}

// GetHealth checks the health status of the veri-fill service
func (c *VerifillHTTPClient) GetHealth(ctx context.Context) (*HealthResponse, error) {
	resp, err := c.client.GetHealthWithResponse(ctx)
	if err != nil {
		return nil, fmt.Errorf("health check failed: %w", err)
	}

	if resp.StatusCode() == http.StatusOK && resp.JSON200 != nil {
		return resp.JSON200, nil
	}

	if resp.StatusCode() == http.StatusServiceUnavailable && resp.JSON503 != nil {
		return resp.JSON503, nil
	}

	return nil, fmt.Errorf("unexpected health check response: status %d", resp.StatusCode())
}

// nextBackoff calculates the next backoff duration with exponential increase
func (c *VerifillHTTPClient) nextBackoff(current time.Duration) time.Duration {
	next := time.Duration(float64(current) * c.config.BackoffFactor)
	if next > c.config.MaxBackoff {
		return c.config.MaxBackoff
	}
	return next
}

// GetGeneratedClient returns the underlying generated client for advanced usage
func (c *VerifillHTTPClient) GetGeneratedClient() *gen.ClientWithResponses {
	return c.client
}

// checkVerdictAgainstResponse runs every check on an attached verdict that needs nothing but the
// response and the request that produced it: the member set, the binding to paymentID and the
// chain asked about, the outcome-conditional members, and agreement with the response root.
// RequestReleaseSignature passes the payment id its caller expects.
//
// It deliberately stops short of the signature. That needs the key the payment's verifier
// publishes for the chain and the `domain` derived from the payment's verifier endpoint, so a
// caller MUST also call VerifyVerdictSignature and compare `domain` itself. This
// method returning nil means the verdict is internally coherent and answers the right question,
// NOT that it is authentic.
//
// A response with no verdict passes: absence is not an outcome, and a caller falls back to the
// root members.
func (c *VerifillHTTPClient) checkVerdictAgainstResponse(resp *VerifyFulfillmentResponse, paymentID, destinationChainID string) error {
	if resp == nil || resp.Verdict == nil {
		return nil
	}
	v := resp.Verdict

	// Re-encode and decode so an incomplete verdict is caught the way a wire decode would catch
	// it. By the time it is a struct an omitted member and an empty one are the same value.
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("verdict does not re-encode: %w", err)
	}
	if _, err := DecodeVerdict(raw); err != nil {
		return err
	}

	if err := VerdictBindsTo(v, paymentID, destinationChainID); err != nil {
		return err
	}

	// The root predates the verdict and cannot express a signed claim, so where they disagree
	// something is wrong with the response rather than with the payment. Refuse rather than pick
	// a side: a consumer told to treat a verified verdict as authoritative would otherwise act on
	// a claim the same response contradicts.
	if resp.PaymentId != "" && !strings.EqualFold(resp.PaymentId, v.PaymentId) {
		return fmt.Errorf("verdict is about payment %s but the response root says %s", v.PaymentId, resp.PaymentId)
	}
	if resp.Verified && !VerdictIsDelivered(v) {
		return fmt.Errorf("response root says verified but the verdict outcome is %q", v.Outcome)
	}
	// The converse does NOT hold, and the exception is load-bearing rather than a special case.
	// `verified` reports whether a release signature was issued, not whether delivery happened, and
	// DEADLINE_EXCEEDED is precisely the answer where those differ: the recipient was paid, so the
	// outcome is delivered, and the delivery fell outside the window, so no signature is issued.
	// Treating that as a disagreement would reject the one response the sentinel below exists for,
	// and it would be rejected before ever reaching it.
	if !resp.Verified && VerdictIsDelivered(v) && !deliveredWithoutSignature(resp.Error) {
		return fmt.Errorf("verdict says delivered but the response root neither reports verified nor explains why no signature was issued")
	}
	return nil
}

// deliveredWithoutSignature reports whether a response code legitimately pairs a delivered verdict
// with `verified: false`. Only DEADLINE_EXCEEDED does: the delivery is real and the signature is
// withheld on policy, so the two members disagree by design rather than by fault.
func deliveredWithoutSignature(code *VerifyFulfillmentResponseError) bool {
	return code != nil && *code == VerifyFulfillmentResponseErrorDEADLINEEXCEEDED
}
