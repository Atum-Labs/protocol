package verifill

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestNewVerifillHTTPClient(t *testing.T) {
	tests := []struct {
		name     string
		endpoint string
		opts     []ClientOption
		wantErr  bool
	}{
		{
			name:     "valid endpoint with defaults",
			endpoint: "https://veri-fill.example.com",
			opts:     nil,
			wantErr:  false,
		},
		{
			name:     "with custom HTTP client",
			endpoint: "https://veri-fill.example.com",
			opts: []ClientOption{
				WithHTTPClient(&http.Client{Timeout: 5 * time.Second}),
			},
			wantErr: false,
		},
		{
			name:     "with custom retry config",
			endpoint: "https://veri-fill.example.com",
			opts: []ClientOption{
				WithRetryConfig(1*time.Second, 10*time.Second, 2.0),
			},
			wantErr: false,
		},
		{
			name:     "with custom polling config",
			endpoint: "https://veri-fill.example.com",
			opts: []ClientOption{
				WithPollingConfig(2*time.Second, 5*time.Minute),
			},
			wantErr: false,
		},
		{
			name:     "with all options",
			endpoint: "https://veri-fill.example.com",
			opts: []ClientOption{
				WithHTTPClient(&http.Client{Timeout: 5 * time.Second}),
				WithRetryConfig(1*time.Second, 10*time.Second, 2.0),
				WithPollingConfig(2*time.Second, 5*time.Minute),
			},
			wantErr: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client, err := NewVerifillHTTPClient(tt.endpoint, tt.opts...)
			if (err != nil) != tt.wantErr {
				t.Errorf("NewVerifillHTTPClient() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if !tt.wantErr && client == nil {
				t.Error("Expected non-nil client")
			}
		})
	}
}

func TestRequestReleaseSignature_Success(t *testing.T) {
	// Create mock handler that returns success on first try
	handler := NewMockHTTPHandler(t).
		AddResponse(http.StatusOK, CreateVerifyFulfillmentResponse(true, nil), 0)

	server := CreateMockHTTPServer(t, handler.ServeHTTP)
	defer server.Close()

	client, err := NewVerifillHTTPClient(server.URL)
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	ctx := context.Background()
	request := CreateValidVerifyFulfillmentRequest()

	resp, err := client.RequestReleaseSignature(ctx, request, TestPaymentID)
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if resp == nil || !resp.Verified {
		t.Error("Expected verified response")
	}

	handler.AssertRequestCount(1)
}

func TestRequestReleaseSignature_UndeterminedThenVerified(t *testing.T) {
	// An undetermined outcome must be re-asked, not treated as a failure. Driven with a real
	// enum value: the API cannot send anything else, so a test using free text proves nothing.
	undetermined := VerifyFulfillmentResponseErrorVERIFICATIONERROR
	handler := NewMockHTTPHandler(t).
		AddResponse(http.StatusOK, &VerifyFulfillmentResponse{
			Verified:  false,
			PaymentId: TestPaymentID,
			Error:     &undetermined,
		}, 0).
		AddResponse(http.StatusOK, CreateVerifyFulfillmentResponse(true, nil), 0)

	server := CreateMockHTTPServer(t, handler.ServeHTTP)
	defer server.Close()

	client, err := NewVerifillHTTPClient(server.URL,
		WithPollingConfig(100*time.Millisecond, 5*time.Second))
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	resp, err := client.RequestReleaseSignature(context.Background(), CreateValidVerifyFulfillmentRequest(), TestPaymentID)
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if resp == nil || !resp.Verified {
		t.Error("Expected verified response after retry")
	}

	handler.AssertRequestCount(2)
}

func TestRequestReleaseSignature_PermanentCodeIsNotRetried(t *testing.T) {
	// A permanent code must stop the loop on the first answer rather than burn the budget.
	permanent := VerifyFulfillmentResponseErrorFULFILLMENTNOTDELIVERED
	handler := NewMockHTTPHandler(t).
		AddResponse(http.StatusOK, &VerifyFulfillmentResponse{
			Verified:  false,
			PaymentId: TestPaymentID,
			Error:     &permanent,
		}, 0)

	server := CreateMockHTTPServer(t, handler.ServeHTTP)
	defer server.Close()

	client, err := NewVerifillHTTPClient(server.URL,
		WithPollingConfig(10*time.Millisecond, 5*time.Second))
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	resp, err := client.RequestReleaseSignature(context.Background(), CreateValidVerifyFulfillmentRequest(), TestPaymentID)
	if err == nil || !strings.Contains(err.Error(), string(permanent)) {
		t.Fatalf("Expected a terminal error for a permanent code, got %v", err)
	}
	if errors.Is(err, ErrVerdictPending) {
		t.Error("A permanent code must not be reported as pending")
	}
	if resp == nil {
		t.Error("The response must be returned alongside the error, since it carries the verdict")
	}

	handler.AssertRequestCount(1)
}

func TestRequestReleaseSignature_Timeout(t *testing.T) {
	// Create mock handler that always returns not verified
	handler := NewMockHTTPHandler(t).
		AddResponse(http.StatusOK, CreateVerifyFulfillmentResponse(false, nil), 50*time.Millisecond)

	server := CreateMockHTTPServer(t, handler.ServeHTTP)
	defer server.Close()

	client, err := NewVerifillHTTPClient(server.URL,
		WithPollingConfig(100*time.Millisecond, 200*time.Millisecond))
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	ctx := context.Background()
	request := CreateValidVerifyFulfillmentRequest()

	start := time.Now()
	_, err = client.RequestReleaseSignature(ctx, request, TestPaymentID)
	duration := time.Since(start)

	if err == nil {
		t.Error("Expected timeout error")
	}
	// An exhausted budget is an undetermined outcome, not a failed payment. A caller that
	// cannot tell the two apart is the bug this sentinel exists to prevent.
	if !errors.Is(err, ErrVerdictPending) {
		t.Errorf("Expected an error wrapping ErrVerdictPending, got: %v", err)
	}
	// Should timeout after ~200ms
	if duration < 200*time.Millisecond || duration > 500*time.Millisecond {
		t.Errorf("Unexpected timeout duration: %v", duration)
	}
}

func TestRequestReleaseSignature_ContextCancellation(t *testing.T) {
	// Create mock handler with delay
	handler := NewMockHTTPHandler(t).
		AddResponse(http.StatusOK, CreateVerifyFulfillmentResponse(false, nil), 100*time.Millisecond)

	server := CreateMockHTTPServer(t, handler.ServeHTTP)
	defer server.Close()

	client, err := NewVerifillHTTPClient(server.URL)
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	request := CreateValidVerifyFulfillmentRequest()

	// Cancel context after short delay
	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	_, err = client.RequestReleaseSignature(ctx, request, TestPaymentID)
	if err == nil {
		t.Error("Expected context cancellation error")
	}
	if !strings.Contains(err.Error(), "context") {
		t.Errorf("Expected context error, got: %v", err)
	}
}

func TestRequestReleaseSignature_ServerError(t *testing.T) {
	// Create mock handler that returns 500 errors then success
	handler := NewMockHTTPHandler(t).
		AddResponse(http.StatusInternalServerError, nil, 0).
		AddResponse(http.StatusInternalServerError, nil, 0).
		AddResponse(http.StatusOK, CreateVerifyFulfillmentResponse(true, nil), 0)

	server := CreateMockHTTPServer(t, handler.ServeHTTP)
	defer server.Close()

	client, err := NewVerifillHTTPClient(server.URL,
		WithRetryConfig(10*time.Millisecond, 100*time.Millisecond, 1.5))
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	ctx := context.Background()
	request := CreateValidVerifyFulfillmentRequest()

	resp, err := client.RequestReleaseSignature(ctx, request, TestPaymentID)
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if resp == nil || !resp.Verified {
		t.Error("Expected verified response after retries")
	}

	// Should have made 3 requests
	handler.AssertRequestCount(3)
}

func TestRequestReleaseSignature_ClientError(t *testing.T) {
	// veri-fill returns the shared ErrorResponse envelope on 4xx and the client
	// reads the public code from it. Mock the real shape so the code parsing is
	// actually exercised on the release path.
	handler := NewMockHTTPHandler(t).
		AddResponse(http.StatusBadRequest, map[string]string{
			"code":    "INVALID_REQUEST",
			"message": "The request was malformed or missing required fields.",
		}, 0)

	server := CreateMockHTTPServer(t, handler.ServeHTTP)
	defer server.Close()

	client, err := NewVerifillHTTPClient(server.URL)
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	ctx := context.Background()
	request := CreateValidVerifyFulfillmentRequest()

	_, err = client.RequestReleaseSignature(ctx, request, TestPaymentID)
	if err == nil {
		t.Error("Expected error for 400 response")
	}
	if !strings.Contains(err.Error(), "bad request") {
		t.Errorf("Expected bad request error, got: %v", err)
	}
	// The public code is parsed from the shared envelope and surfaced.
	if !strings.Contains(err.Error(), "INVALID_REQUEST") {
		t.Errorf("Expected the shared error code in the message, got: %v", err)
	}

	// Should have made only 1 request (no retry for 4xx)
	handler.AssertRequestCount(1)
}

func TestRequestReleaseSignature_InvalidRequest(t *testing.T) {
	client, err := NewVerifillHTTPClient("https://example.com")
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	ctx := context.Background()
	request := &VerifyFulfillmentRequest{} // Invalid request

	_, err = client.RequestReleaseSignature(ctx, request, TestPaymentID)
	if err == nil {
		t.Error("Expected validation error")
	}
	if !strings.Contains(err.Error(), "invalid request") {
		t.Errorf("Expected validation error, got: %v", err)
	}
}

// A quote whose signed payment request names no destination chain leaves nothing to bind a verdict to, so the request
// is refused before it is sent.
func TestRequestReleaseSignature_QuoteWithoutDestinationChain(t *testing.T) {
	handler := NewMockHTTPHandler(t).AddResponse(http.StatusOK, CreateVerifyFulfillmentResponse(true, nil), 0)
	server := CreateMockHTTPServer(t, handler.ServeHTTP)
	defer server.Close()

	client, err := NewVerifillHTTPClient(server.URL)
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	request := CreateValidVerifyFulfillmentRequest()
	request.FulfillmentQuote = ptr(`{"version":"1.0"}`)

	_, err = client.RequestReleaseSignature(context.Background(), request, TestPaymentID)
	if err == nil || !strings.Contains(err.Error(), "invalid request") {
		t.Fatalf("expected the request to be refused, got: %v", err)
	}
	handler.AssertRequestCount(0)
}

func TestRequestRefundSignature_Success(t *testing.T) {
	// Create mock handler that returns success
	handler := NewMockHTTPHandler(t).
		AddResponse(http.StatusOK, CreateRefundSignatureResponse("0xsignature", nil), 0)

	server := CreateMockHTTPServer(t, handler.ServeHTTP)
	defer server.Close()

	client, err := NewVerifillHTTPClient(server.URL)
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	ctx := context.Background()
	request := CreateValidRefundSignatureRequest()

	resp, err := client.RequestRefundSignature(ctx, request)
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if resp == nil || resp.Signature == nil || *resp.Signature == "" {
		t.Error("Expected signature in response")
	}

	handler.AssertRequestCount(1)
}

func TestRequestRefundSignature_ServerErrorRetry(t *testing.T) {
	// Create mock handler that returns 500 errors then success
	handler := NewMockHTTPHandler(t).
		AddResponse(http.StatusServiceUnavailable, nil, 0).
		AddResponse(http.StatusInternalServerError, nil, 0).
		AddResponse(http.StatusOK, CreateRefundSignatureResponse("0xsignature", nil), 0)

	server := CreateMockHTTPServer(t, handler.ServeHTTP)
	defer server.Close()

	client, err := NewVerifillHTTPClient(server.URL,
		WithRetryConfig(10*time.Millisecond, 100*time.Millisecond, 1.5))
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	ctx := context.Background()
	request := CreateValidRefundSignatureRequest()

	resp, err := client.RequestRefundSignature(ctx, request)
	if err != nil {
		t.Errorf("Unexpected error: %v", err)
	}
	if resp == nil || resp.Signature == nil || *resp.Signature == "" {
		t.Error("Expected signature after retries")
	}

	// Should have made 3 requests
	handler.AssertRequestCount(3)
}

func TestRequestRefundSignature_SignatureError(t *testing.T) {
	// veri-fill returns the shared ErrorResponse envelope on 5xx. A signature
	// generation failure is deterministic, so the client keys off the public
	// code to fail fast without retrying.
	handler := NewMockHTTPHandler(t).
		AddResponse(http.StatusInternalServerError, map[string]string{
			"code":    "SIGNATURE_GENERATION_FAILED",
			"message": "Signing failed for this request.",
		}, 0)

	server := CreateMockHTTPServer(t, handler.ServeHTTP)
	defer server.Close()

	client, err := NewVerifillHTTPClient(server.URL)
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	ctx := context.Background()
	request := CreateValidRefundSignatureRequest()

	_, err = client.RequestRefundSignature(ctx, request)
	if err == nil {
		t.Error("Expected signature error")
	}
	if !strings.Contains(err.Error(), "signature generation failed") {
		t.Errorf("Expected signature generation error, got: %v", err)
	}

	// Should have made only 1 request (no retry for signature errors)
	handler.AssertRequestCount(1)
}

func TestRequestRefundSignature_MaxRetries(t *testing.T) {
	// Create mock handler that always returns 500
	handler := NewMockHTTPHandler(t).
		AddResponse(http.StatusInternalServerError, nil, 0)

	server := CreateMockHTTPServer(t, handler.ServeHTTP)
	defer server.Close()

	client, err := NewVerifillHTTPClient(server.URL,
		WithRetryConfig(10*time.Millisecond, 100*time.Millisecond, 1.5))
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	ctx := context.Background()
	request := CreateValidRefundSignatureRequest()

	_, err = client.RequestRefundSignature(ctx, request)
	if err == nil {
		t.Error("Expected max retries error")
	}
	if !strings.Contains(err.Error(), "max retry attempts") {
		t.Errorf("Expected max retries error, got: %v", err)
	}

	// Should have made 5 attempts
	if handler.GetRequestCount() != 5 {
		t.Errorf("Expected 5 attempts, got %d", handler.GetRequestCount())
	}
}

func TestRequestRefundSignature_InvalidRequest(t *testing.T) {
	client, err := NewVerifillHTTPClient("https://example.com")
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}

	ctx := context.Background()
	request := &RefundSignatureRequest{} // Invalid request

	_, err = client.RequestRefundSignature(ctx, request)
	if err == nil {
		t.Error("Expected validation error")
	}
	if !strings.Contains(err.Error(), "invalid request") {
		t.Errorf("Expected validation error, got: %v", err)
	}
}

func TestGetHealth(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		body       interface{}
		wantErr    bool
	}{
		{
			name:       "healthy",
			statusCode: http.StatusOK,
			body:       &HealthResponse{Status: "healthy"},
			wantErr:    false,
		},
		{
			name:       "unhealthy",
			statusCode: http.StatusServiceUnavailable,
			body:       &HealthResponse{Status: "unhealthy"},
			wantErr:    false,
		},
		{
			name:       "unexpected status",
			statusCode: http.StatusInternalServerError,
			body:       nil,
			wantErr:    true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			handler := NewMockHTTPHandler(t).
				AddResponse(tt.statusCode, tt.body, 0)

			server := CreateMockHTTPServer(t, handler.ServeHTTP)
			defer server.Close()

			client, err := NewVerifillHTTPClient(server.URL)
			if err != nil {
				t.Fatalf("Failed to create client: %v", err)
			}

			ctx := context.Background()
			resp, err := client.GetHealth(ctx)

			if (err != nil) != tt.wantErr {
				t.Errorf("GetHealth() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if !tt.wantErr && resp == nil {
				t.Error("Expected non-nil response")
			}
		})
	}
}

func TestNextBackoff(t *testing.T) {
	client, _ := NewVerifillHTTPClient("https://example.com",
		WithRetryConfig(1*time.Second, 10*time.Second, 2.0))

	tests := []struct {
		current  time.Duration
		expected time.Duration
	}{
		{1 * time.Second, 2 * time.Second},
		{2 * time.Second, 4 * time.Second},
		{4 * time.Second, 8 * time.Second},
		{8 * time.Second, 10 * time.Second},  // Capped at max
		{10 * time.Second, 10 * time.Second}, // Already at max
	}

	for _, tt := range tests {
		result := client.nextBackoff(tt.current)
		if result != tt.expected {
			t.Errorf("nextBackoff(%v) = %v, want %v", tt.current, result, tt.expected)
		}
	}
}

// TestRetryClassificationCoversEveryResponseCode pins which codes mean "ask again". The map is
// the whole of that decision, and a code missing from it is silently permanent, so the risk is
// not a wrong entry but an absent one: a new transient code would be treated as terminal and a
// payment that was still resolvable would stop being asked about.
//
// It asserts over the generated enum rather than a hand-written list, so adding a value to the
// schema without classifying it here fails instead of defaulting.
func TestRetryClassificationCoversEveryResponseCode(t *testing.T) {
	want := map[VerifyFulfillmentResponseError]bool{
		// Undetermined: no conclusion was reached, so asking again may reach one.
		VerifyFulfillmentResponseErrorVERIFICATIONERROR:  true,
		VerifyFulfillmentResponseErrorVERIFICATIONFAILED: true,

		// Terminal. FULFILLMENT_NOT_DELIVERED and DEADLINE_EXCEEDED both report a conclusion,
		// and the second arrives alongside a delivered verdict, so the recipient has the funds.
		VerifyFulfillmentResponseErrorFULFILLMENTNOTDELIVERED: false,
		VerifyFulfillmentResponseErrorDEADLINEEXCEEDED:        false,

		// Deterministic: the same request produces the same answer, so retrying is waste.
		VerifyFulfillmentResponseErrorINVALIDREQUEST:   false,
		VerifyFulfillmentResponseErrorUNSUPPORTEDCHAIN: false,
		VerifyFulfillmentResponseErrorINVALIDAMOUNT:    false,
		VerifyFulfillmentResponseErrorSIGNATUREERROR:   false,
	}

	for code, wantRetry := range want {
		if got := retryableVerifyErrors[code]; got != wantRetry {
			t.Errorf("%s: retryable = %v, want %v", code, got, wantRetry)
		}
	}

	// Every value the schema declares must be classified above, so a code added later cannot
	// slip through on the zero value.
	for _, code := range []VerifyFulfillmentResponseError{
		VerifyFulfillmentResponseErrorINVALIDREQUEST,
		VerifyFulfillmentResponseErrorUNSUPPORTEDCHAIN,
		VerifyFulfillmentResponseErrorINVALIDAMOUNT,
		VerifyFulfillmentResponseErrorVERIFICATIONERROR,
		VerifyFulfillmentResponseErrorVERIFICATIONFAILED,
		VerifyFulfillmentResponseErrorFULFILLMENTNOTDELIVERED,
		VerifyFulfillmentResponseErrorDEADLINEEXCEEDED,
		VerifyFulfillmentResponseErrorSIGNATUREERROR,
	} {
		if _, ok := want[code]; !ok {
			t.Errorf("response code %s is not classified as retryable or terminal", code)
		}
	}

	// A code this binding was compiled before must not be retried into the ground either.
	if retryableVerifyErrors[VerifyFulfillmentResponseError("SOMETHING_NEW")] {
		t.Error("an unrecognised code reported as retryable")
	}
}

// The request names no payment, so the response and its verdict are bound to the payment the
// caller expects, never to the id the response reports about itself.
func TestRequestReleaseSignature_BindsToTheExpectedPaymentID(t *testing.T) {
	verdict := func(paymentID string) *FulfillmentVerdict {
		return &FulfillmentVerdict{
			Domain: "did:web:atum.network", PaymentId: paymentID,
			ChainId: TestEVMChainID, Outcome: FulfillmentVerdictOutcomeDelivered,
			BlockNumber: "1", BlockHash: "0x" + strings.Repeat("a", 64),
			TransactionHash: "0x" + strings.Repeat("b", 64), Fulfiller: "0x" + strings.Repeat("c", 40),
			SignatureScheme: VerdictSignatureSchemeEip712Secp256k1, Signature: strings.Repeat("ab", 65),
		}
	}
	expected := "0x" + strings.Repeat("1", 64)
	other := "0x" + strings.Repeat("2", 64)
	deadlineExceeded := VerifyFulfillmentResponseErrorDEADLINEEXCEEDED
	undetermined := VerifyFulfillmentResponseErrorVERIFICATIONERROR
	for name, c := range map[string]struct {
		verified         bool
		code             *VerifyFulfillmentResponseError
		rootPaymentID    string
		verdictPaymentID string
		wantErr          string
	}{
		"expected payment":                       {true, nil, expected, expected, ""},
		"expected payment in upper case":         {true, nil, "0x" + strings.ToUpper(expected[2:]), expected, ""},
		"root and verdict about another":         {true, nil, other, other, "answered about payment"},
		"verdict about another":                  {true, nil, expected, other, "verdict is about payment"},
		"permanent code about another":           {false, &deadlineExceeded, other, other, "answered about payment"},
		"permanent code about the expected":      {false, &deadlineExceeded, expected, expected, "DEADLINE_EXCEEDED"},
		"permanent code with no root id":         {false, &deadlineExceeded, "", expected, "answered about payment"},
		"verified with no verdict about another": {true, nil, other, "", "answered about payment"},
		"retryable code about another":           {false, &undetermined, other, "", "answered about payment"},
	} {
		t.Run(name, func(t *testing.T) {
			resp := CreateVerifyFulfillmentResponse(c.verified, nil)
			resp.PaymentId = c.rootPaymentID
			resp.Error = c.code
			if c.verdictPaymentID != "" {
				resp.Verdict = verdict(c.verdictPaymentID)
			}
			handler := NewMockHTTPHandler(t).AddResponse(http.StatusOK, resp, 0)
			server := CreateMockHTTPServer(t, handler.ServeHTTP)
			defer server.Close()
			client, err := NewVerifillHTTPClient(server.URL)
			if err != nil {
				t.Fatalf("Failed to create client: %v", err)
			}
			_, err = client.RequestReleaseSignature(context.Background(), CreateValidVerifyFulfillmentRequest(), expected)
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("RequestReleaseSignature() error = %v, want none", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("RequestReleaseSignature() error = %v, want it to contain %q", err, c.wantErr)
			}
		})
	}
}

// A caller that cannot name the payment it expects gets no request sent.
func TestRequestReleaseSignature_RequiresAnExpectedPaymentID(t *testing.T) {
	client, err := NewVerifillHTTPClient("http://127.0.0.1:1")
	if err != nil {
		t.Fatalf("Failed to create client: %v", err)
	}
	for _, id := range []string{"", "0x1234", "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"} {
		_, err := client.RequestReleaseSignature(context.Background(), CreateValidVerifyFulfillmentRequest(), id)
		if err == nil || !strings.Contains(err.Error(), "expected payment id") {
			t.Fatalf("RequestReleaseSignature(%q) error = %v, want an expected payment id error", id, err)
		}
	}
}
