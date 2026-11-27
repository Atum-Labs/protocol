package verifill

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Test constants for common values
const (
	TestPaymentID      = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
	TestEVMChainID     = "eip155:1"
	TestTronChainID    = "tron:mainnet"
	TestSolanaChainID  = "solana:mainnet-beta"
	TestInvalidChainID = "invalid-chain"
	TestInvalidAddress = "0xinvalid"
	TestTokenAddress   = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
	TestZeroAddress    = "0x0000000000000000000000000000000000000000"
	TestTxHash         = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"

	// A quote document carrying just the members the bindings read. Its signed payment request
	// has one destination leg, on TestEVMChainID.
	TestFulfillmentQuote = `{"version":"1.0","payment_request_json":"{\"destination\":[{\"asset_identifier\":\"eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48\"}]}"}`

	// A SenderAuth object as JSON text. Its shape is all the bindings check.
	TestSenderAuth = `{"message_scheme":"EVM_PERMIT2","signed_messages":[{"message":"0x00","signature":"0x"}]}`
)

// CreateMockHTTPServer creates a test HTTP server with configurable responses
func CreateMockHTTPServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	return httptest.NewServer(handler)
}

// CreateValidVerifyFulfillmentRequest creates a valid verification request for testing
func CreateValidVerifyFulfillmentRequest() *VerifyFulfillmentRequest {
	return &VerifyFulfillmentRequest{
		TransactionHash:  TestTxHash,
		FulfillmentQuote: ptr(TestFulfillmentQuote),
	}
}

// CreateValidRefundSignatureRequest returns a request that passes validation.
func CreateValidRefundSignatureRequest() *RefundSignatureRequest {
	return &RefundSignatureRequest{
		PaymentId:        TestPaymentID,
		FulfillmentQuote: json.RawMessage(`{"version":"1.0"}`),
	}
}

// CreateVerifyFulfillmentResponse creates a mock verification response
func CreateVerifyFulfillmentResponse(verified bool, errorMsg *string) *VerifyFulfillmentResponse {
	resp := &VerifyFulfillmentResponse{
		Verified:  verified,
		PaymentId: TestPaymentID,
	}

	if verified {
		signature := "0xmocksignature"
		resp.Signature = &signature
		messageHash := "abcdef1234567890"
		resp.MessageHash = &messageHash

		// Add verification details
		boolTrue := true
		resp.VerificationDetails = &VerificationDetails{
			TransactionFound: &boolTrue,
			EventFound:       &boolTrue,
			BlockConfirmed:   &boolTrue,
			AmountMatches:    &boolTrue,
			RecipientMatches: &boolTrue,
			SettlerMatches:   &boolTrue,
			TokenMatches:     &boolTrue,
		}
	}

	if errorMsg != nil {
		errEnum := VerifyFulfillmentResponseError(*errorMsg)
		resp.Error = &errEnum
	}

	return resp
}

// CreateRefundSignatureResponse creates a mock refund response
func CreateRefundSignatureResponse(signature string, errorMsg *string) *RefundSignatureResponse {
	resp := &RefundSignatureResponse{
		PaymentId: TestPaymentID,
		Verified:  signature != "",
	}

	if signature != "" {
		resp.Signature = &signature
		messageHash := "fedcba0987654321"
		resp.MessageHash = &messageHash
	}

	if errorMsg != nil {
		errEnum := RefundSignatureResponseError(*errorMsg)
		resp.Error = &errEnum
	}

	return resp
}

// MockHTTPHandler creates a configurable HTTP handler for testing
type MockHTTPHandler struct {
	t            *testing.T
	responses    []MockResponse
	currentIndex int
	requestCount int
}

// MockResponse defines a single mock response
type MockResponse struct {
	StatusCode int
	Body       interface{}
	Delay      time.Duration
}

// NewMockHTTPHandler creates a new mock handler
func NewMockHTTPHandler(t *testing.T) *MockHTTPHandler {
	return &MockHTTPHandler{
		t:         t,
		responses: []MockResponse{},
	}
}

// AddResponse adds a response to the sequence
func (m *MockHTTPHandler) AddResponse(statusCode int, body interface{}, delay time.Duration) *MockHTTPHandler {
	m.responses = append(m.responses, MockResponse{
		StatusCode: statusCode,
		Body:       body,
		Delay:      delay,
	})
	return m
}

// ServeHTTP implements http.Handler
func (m *MockHTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.requestCount++

	if m.currentIndex >= len(m.responses) {
		// Repeat last response if we run out
		m.currentIndex = len(m.responses) - 1
	}

	if m.currentIndex < 0 {
		m.t.Fatal("No responses configured")
		return
	}

	resp := m.responses[m.currentIndex]
	m.currentIndex++

	// Simulate delay if specified
	if resp.Delay > 0 {
		time.Sleep(resp.Delay)
	}

	// Write response
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)

	if resp.Body != nil {
		if err := json.NewEncoder(w).Encode(resp.Body); err != nil {
			m.t.Fatalf("Failed to encode response: %v", err)
		}
	}
}

// GetRequestCount returns the number of requests received
func (m *MockHTTPHandler) GetRequestCount() int {
	return m.requestCount
}

// AssertRequestCount verifies the expected number of requests
func (m *MockHTTPHandler) AssertRequestCount(expected int) {
	if m.requestCount != expected {
		m.t.Errorf("Expected %d requests, got %d", expected, m.requestCount)
	}
}

func ptr[T any](v T) *T { return &v }
