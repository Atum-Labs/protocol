package verifill

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

// TestValidateVerifyFulfillmentRequest_RequiresTransactionHash asserts the
// validator fails closed when the fulfill locator is absent. The transaction
// hash is the self-locating key the verification service uses to fetch the
// receipt, so a request without one can never be verified and must be rejected
// at construction — including for callers that build the struct literally and
// bypass the fluent builder.
func TestValidateVerifyFulfillmentRequest_RequiresTransactionHash(t *testing.T) {
	req := CreateValidVerifyFulfillmentRequest()
	req.TransactionHash = ""

	err := ValidateVerifyFulfillmentRequest(req)
	if err == nil {
		t.Fatal("expected an error when transaction_hash is empty, got nil")
	}
	if !strings.Contains(err.Error(), "transaction_hash is required") {
		t.Errorf("expected error to mention transaction_hash, got: %v", err)
	}
}

// TestValidateVerifyFulfillmentRequest_SenderAuth asserts a sent sender_auth must be a non-empty
// JSON object, and that leaving it out is valid.
func TestValidateVerifyFulfillmentRequest_SenderAuth(t *testing.T) {
	req := CreateValidVerifyFulfillmentRequest()
	if err := ValidateVerifyFulfillmentRequest(req); err != nil {
		t.Fatalf("expected a request without sender_auth to pass, got: %v", err)
	}
	req.SenderAuth = ptr(TestSenderAuth)
	if err := ValidateVerifyFulfillmentRequest(req); err != nil {
		t.Fatalf("expected a SenderAuth object to pass, got: %v", err)
	}
	for name, bad := range map[string]string{
		"empty": "", "blank": "  ", "not json": "{not json", "null": "null",
		"a list": `[{"message_scheme":"EVM_PERMIT2"}]`, "a string": `"x"`, "an empty object": "{}",
	} {
		req.SenderAuth = ptr(bad)
		err := ValidateVerifyFulfillmentRequest(req)
		if err == nil || !strings.Contains(err.Error(), "sender_auth") {
			t.Errorf("%s: expected a sender_auth error, got: %v", name, err)
		}
	}
}

func TestValidateVerifyFulfillmentRequest(t *testing.T) {
	withQuote := func(quote string) *VerifyFulfillmentRequest {
		req := CreateValidVerifyFulfillmentRequest()
		req.FulfillmentQuote = &quote
		return req
	}
	tests := []struct {
		name    string
		request *VerifyFulfillmentRequest
		wantErr bool
		errMsg  string
	}{
		{
			name:    "valid request",
			request: CreateValidVerifyFulfillmentRequest(),
			wantErr: false,
		},
		{
			name:    "nil request",
			request: nil,
			wantErr: true,
			errMsg:  "request is nil",
		},
		{
			name:    "missing fulfillment quote",
			request: withQuote(""),
			wantErr: true,
			errMsg:  "fulfillment_quote or fulfillment_authorization is required",
		},
		{
			name:    "blank fulfillment quote",
			request: withQuote("  "),
			wantErr: true,
			errMsg:  "fulfillment_quote is required",
		},
		{
			name:    "fulfillment quote is not JSON",
			request: withQuote("{not json"),
			wantErr: true,
			errMsg:  "fulfillment_quote is not valid JSON",
		},
		{
			name:    "fulfillment quote is not an object",
			request: withQuote(`["a"]`),
			wantErr: true,
			errMsg:  "fulfillment_quote must be the signed quote document",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateVerifyFulfillmentRequest(tt.request)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateVerifyFulfillmentRequest() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if err != nil && tt.errMsg != "" && !strings.Contains(err.Error(), tt.errMsg) {
				t.Errorf("Expected error containing '%s', got: %v", tt.errMsg, err)
			}
		})
	}
}

// TestVerifyFulfillmentRequest_BodyWithoutQuoteIsRejected pins what happens to a caller that
// sends delivery terms instead of a quote: the extra keys are ignored on unmarshal, and the
// request is refused because it carries no fulfillment_quote.
func TestVerifyFulfillmentRequest_BodyWithoutQuoteIsRejected(t *testing.T) {
	body := []byte(`{
		"payment_id": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
		"transaction_hash": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
		"chain_id": "eip155:1",
		"escrow_address": "0x742d35CC6634c0532925a3B844bC9e7595F0BeB4",
		"deadline": 1735689600,
		"expected_fulfillment": {"settler": "0x742d35CC6634c0532925a3B844bC9e7595F0BeB4", "recipient": "0x742d35CC6634c0532925a3B844bC9e7595F0BeB4", "token": "0x742d35CC6634c0532925a3B844bC9e7595F0BeB4", "amount": "1"},
		"reserver": "0x742d35CC6634c0532925a3B844bC9e7595F0BeB4",
		"releaser": "0x742d35CC6634c0532925a3B844bC9e7595F0BeB4"
	}`)

	var req VerifyFulfillmentRequest
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatalf("the body should unmarshal, with the unknown keys ignored: %v", err)
	}
	if err := ValidateVerifyFulfillmentRequest(&req); err == nil {
		t.Fatal("a request with no quote must be refused")
	}
}

func TestDestinationChainID(t *testing.T) {
	// quoteWith embeds a payment request with the given destination legs, the way a quote
	// carries it: as a JSON string.
	quoteWith := func(t *testing.T, extra string, legs ...string) string {
		t.Helper()
		dest := make([]map[string]string, 0, len(legs))
		for _, l := range legs {
			dest = append(dest, map[string]string{"asset_identifier": l})
		}
		pr, err := json.Marshal(map[string]any{"destination": dest})
		if err != nil {
			t.Fatal(err)
		}
		prJSON, err := json.Marshal(string(pr))
		if err != nil {
			t.Fatal(err)
		}
		return `{` + extra + `"payment_request_json":` + string(prJSON) + `}`
	}
	tests := []struct {
		name    string
		quote   string
		want    string
		wantErr bool
	}{
		{name: "fixture", quote: TestFulfillmentQuote, want: TestEVMChainID},
		{name: "evm", quote: quoteWith(t, "", "eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831"), want: "eip155:42161"},
		{name: "solana", quote: quoteWith(t, "", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), want: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"},
		{name: "tron", quote: quoteWith(t, "", "tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"), want: TestTronChainID},
		{
			// destination.id is outside the quote signature, so the signed payment request wins.
			name:  "unsigned destination.id disagrees",
			quote: quoteWith(t, `"destination":{"id":"eip155:10/erc20:0x0b2c639c533813f4aa9d7837caf62653d097ff85"},`, "eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
			want:  "eip155:42161",
		},
		{name: "multiple legs", quote: quoteWith(t, "", "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831"), wantErr: true},
		{name: "no legs", quote: quoteWith(t, ""), wantErr: true},
		{name: "only destination.id", quote: `{"destination":{"id":"eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"}}`, wantErr: true},
		{name: "leg is not CAIP-19", quote: quoteWith(t, "", "arbitrum"), wantErr: true},
		{name: "payment request is not JSON", quote: `{"payment_request_json":"{not json"}`, wantErr: true},
		{name: "not json", quote: `{not json`, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := DestinationChainID(tt.quote)
			if (err != nil) != tt.wantErr {
				t.Fatalf("DestinationChainID() error = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Errorf("DestinationChainID() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestValidateRefundSignatureRequest covers the two required fields. There are no addresses
// left in the request to validate. The optional locator is covered in builders_test.go.
func TestValidateRefundSignatureRequest(t *testing.T) {
	t.Run("accepts a well-formed request", func(t *testing.T) {
		if err := ValidateRefundSignatureRequest(CreateValidRefundSignatureRequest()); err != nil {
			t.Fatalf("expected valid, got %v", err)
		}
	})

	t.Run("rejects nil", func(t *testing.T) {
		if err := ValidateRefundSignatureRequest(nil); err == nil {
			t.Fatal("expected an error for nil")
		}
	})

	t.Run("rejects a malformed payment id", func(t *testing.T) {
		req := CreateValidRefundSignatureRequest()
		req.PaymentId = "0xabc"
		if err := ValidateRefundSignatureRequest(req); err == nil {
			t.Fatal("expected an error for a short payment_id")
		}
	})

	t.Run("rejects a quote that is not a signed document", func(t *testing.T) {
		for name, quote := range map[string]string{
			"blank":       "  ",
			"empty":       "",
			"not json":    "{not json",
			"json null":   "null",
			"a bare list": `["a"]`,
			"a string":    `"a quote"`,
		} {
			t.Run(name, func(t *testing.T) {
				req := CreateValidRefundSignatureRequest()
				req.FulfillmentQuote = json.RawMessage(quote)
				if err := ValidateRefundSignatureRequest(req); err == nil {
					t.Fatalf("expected an error for %s", name)
				}
			})
		}
	})
}

// TestValidateRefundSignatureRequest_PaymentRequestJSON covers the payer's request, which a refund
// may send instead of the quote or alongside it. A request with neither is refused.
func TestValidateRefundSignatureRequest_PaymentRequestJSON(t *testing.T) {
	request := `{"request_id":"req_1"}`

	t.Run("accepts the payer's request without a quote", func(t *testing.T) {
		req := &RefundSignatureRequest{PaymentId: TestPaymentID, PaymentRequestJson: &request}
		if err := ValidateRefundSignatureRequest(req); err != nil {
			t.Fatalf("expected valid, got %v", err)
		}
	})

	t.Run("accepts the payer's request alongside the quote", func(t *testing.T) {
		req := CreateValidRefundSignatureRequest()
		req.PaymentRequestJson = &request
		if err := ValidateRefundSignatureRequest(req); err != nil {
			t.Fatalf("expected valid, got %v", err)
		}
	})

	t.Run("refuses a request with neither", func(t *testing.T) {
		req := &RefundSignatureRequest{PaymentId: TestPaymentID}
		err := ValidateRefundSignatureRequest(req)
		if err == nil || err.Error() != "fulfillment_quote or payment_request_json is required" {
			t.Fatalf("expected the at-least-one refusal, got %v", err)
		}
	})

	// An explicit null is how a JSON client says it has no quote, so it counts as absent rather
	// than as a quote that is not a document.
	t.Run("reads an explicit null fulfillment_quote as absent", func(t *testing.T) {
		withRequest := `{"payment_id":"` + TestPaymentID + `","fulfillment_quote":null,"payment_request_json":` + strconv.Quote(request) + `}`
		var req RefundSignatureRequest
		if err := json.Unmarshal([]byte(withRequest), &req); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if err := ValidateRefundSignatureRequest(&req); err != nil {
			t.Fatalf("expected valid, got %v", err)
		}

		alone := `{"payment_id":"` + TestPaymentID + `","fulfillment_quote":null}`
		req = RefundSignatureRequest{}
		if err := json.Unmarshal([]byte(alone), &req); err != nil {
			t.Fatalf("decode: %v", err)
		}
		err := ValidateRefundSignatureRequest(&req)
		if err == nil || err.Error() != "fulfillment_quote or payment_request_json is required" {
			t.Fatalf("expected the at-least-one refusal, got %v", err)
		}
	})

	t.Run("refuses a payment_request_json that is not a JSON object", func(t *testing.T) {
		for name, text := range map[string]string{
			"empty":       "",
			"blank":       "  ",
			"not json":    "{not json",
			"json null":   "null",
			"a bare list": `["a"]`,
		} {
			t.Run(name, func(t *testing.T) {
				req := &RefundSignatureRequest{PaymentId: TestPaymentID, PaymentRequestJson: &text}
				if err := ValidateRefundSignatureRequest(req); err == nil {
					t.Fatalf("expected an error for %s", name)
				}
			})
		}
	})
}

func TestIsValidCAIP2ChainID(t *testing.T) {
	tests := []struct {
		chainID string
		want    bool
	}{
		{"eip155:1", true},
		{"eip155:137", true},
		{"tron:mainnet", true},
		{"solana:mainnet-beta", true},
		{"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", true},
		{"cosmos:cosmoshub-4", true},
		{"", false},
		{"invalid", false},
		{"eip155", false},
		{"eip155:", false},
		{":1", false},
		{"EIP155:1", false},       // Wrong case for namespace
		{"eip155:1:extra", false}, // Too many parts
	}

	for _, tt := range tests {
		t.Run(tt.chainID, func(t *testing.T) {
			if got := isValidCAIP2ChainID(tt.chainID); got != tt.want {
				t.Errorf("isValidCAIP2ChainID(%q) = %v, want %v", tt.chainID, got, tt.want)
			}
		})
	}
}

func TestIsEVMChain(t *testing.T) {
	tests := []struct {
		chainID string
		want    bool
	}{
		{"eip155:1", true},
		{"eip155:137", true},
		{"eip155:42161", true},
		{"tron:mainnet", false},
		{"solana:mainnet-beta", false},
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.chainID, func(t *testing.T) {
			if got := isEVMChain(tt.chainID); got != tt.want {
				t.Errorf("isEVMChain(%q) = %v, want %v", tt.chainID, got, tt.want)
			}
		})
	}
}

func TestIsTronChain(t *testing.T) {
	tests := []struct {
		chainID string
		want    bool
	}{
		{"tron:mainnet", true},
		{"tron:shasta", true},
		{"eip155:1", false},
		{"solana:mainnet-beta", false},
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.chainID, func(t *testing.T) {
			if got := isTronChain(tt.chainID); got != tt.want {
				t.Errorf("isTronChain(%q) = %v, want %v", tt.chainID, got, tt.want)
			}
		})
	}
}

func TestIsSolanaChain(t *testing.T) {
	tests := []struct {
		chainID string
		want    bool
	}{
		{"solana:mainnet-beta", true},
		{"solana:devnet", true},
		{"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", true},
		{"eip155:1", false},
		{"tron:mainnet", false},
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.chainID, func(t *testing.T) {
			if got := isSolanaChain(tt.chainID); got != tt.want {
				t.Errorf("isSolanaChain(%q) = %v, want %v", tt.chainID, got, tt.want)
			}
		})
	}
}

func TestNormalizeAddress(t *testing.T) {
	tests := []struct {
		address string
		chainID string
		want    string
	}{
		{
			address: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0",
			chainID: "eip155:1",
			want:    "0x742d35cc6634c0532925a3b844bc9e7595f0beb0",
		},
		{
			address: "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
			chainID: "eip155:137",
			want:    "0xabcdef1234567890abcdef1234567890abcdef12",
		},
		{
			address: "TAddress123",
			chainID: "tron:mainnet",
			want:    "TAddress123", // No change for Tron
		},
		{
			address: "SolanaAddress123",
			chainID: "solana:mainnet-beta",
			want:    "SolanaAddress123", // No change for Solana
		},
		{
			address: "MixedCase123",
			chainID: "unknown:chain",
			want:    "MixedCase123", // No change for unknown
		},
	}

	for _, tt := range tests {
		t.Run(tt.address+"_"+tt.chainID, func(t *testing.T) {
			if got := NormalizeAddress(tt.address, tt.chainID); got != tt.want {
				t.Errorf("NormalizeAddress(%q, %q) = %q, want %q", tt.address, tt.chainID, got, tt.want)
			}
		})
	}
}

// TestRefundSignatureRequest_OldBodyIsRejectedNotSilentlyAccepted pins the real
// compatibility story, which is the opposite of "an unchanged caller keeps working".
//
// A caller still sending the old body unmarshals fine, because the removed keys
// are simply ignored, and then fails validation because it carries no fulfillment_quote.
// That is the intended outcome, and it is why the settler change has to ship first. Pinned
// here so nobody later reads the clean unmarshal as evidence the old shape still works.
func TestRefundSignatureRequest_OldBodyIsRejectedNotSilentlyAccepted(t *testing.T) {
	oldBody := []byte(`{
		"payment_id": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
		"escrow_address": "0x742d35CC6634c0532925a3B844bC9e7595F0BeB4",
		"deadline": 1735689600,
		"chain_id": "eip155:1",
		"depositor": "0x742d35CC6634c0532925a3B844bC9e7595F0BeB4",
		"token": "0x742d35CC6634c0532925a3B844bC9e7595F0BeB4",
		"amount": "1000000",
		"reserver": "0x742d35CC6634c0532925a3B844bC9e7595F0BeB4",
		"releaser": "0x742d35CC6634c0532925a3B844bC9e7595F0BeB4",
		"settler": "0x742d35CC6634c0532925a3B844bC9e7595F0BeB4"
	}`)

	var req RefundSignatureRequest
	if err := json.Unmarshal(oldBody, &req); err != nil {
		t.Fatalf("the old body should still unmarshal, with the removed keys ignored: %v", err)
	}
	if req.PaymentId == "" {
		t.Fatal("payment_id should survive, it is the one field the two shapes share")
	}
	if err := ValidateRefundSignatureRequest(&req); err == nil {
		t.Fatal("the old body must be REFUSED, or a stale caller would reach the signer with no quote")
	}
}

// TestRefundSignatureRequest_QuoteMarshalsAsAnObject locks the wire shape.
//
// fulfillment_quote is json.RawMessage, which emits the document verbatim. If it were ever
// changed to []byte the same value would silently marshal as base64, every request would
// fail the server's hash check, and nothing here would have caught it.
func TestRefundSignatureRequest_QuoteMarshalsAsAnObject(t *testing.T) {
	req := CreateValidRefundSignatureRequest()

	encoded, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var wire struct {
		FulfillmentQuote json.RawMessage `json:"fulfillment_quote"`
	}
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(wire.FulfillmentQuote) == 0 || wire.FulfillmentQuote[0] != '{' {
		t.Fatalf("fulfillment_quote went on the wire as %s, want a JSON object", wire.FulfillmentQuote)
	}
}

func TestReleaseQuote(t *testing.T) {
	withAuthorization := func() *VerifyFulfillmentRequest {
		req := CreateValidVerifyFulfillmentRequest()
		req.FulfillmentQuote = nil
		req.FulfillmentAuthorization = &FulfillmentAuthorization{FulfillmentQuoteJson: TestFulfillmentQuote}
		return req
	}

	t.Run("quote", func(t *testing.T) {
		got, err := ReleaseQuote(CreateValidVerifyFulfillmentRequest())
		if err != nil || got != TestFulfillmentQuote {
			t.Fatalf("ReleaseQuote = %q, %v", got, err)
		}
	})
	t.Run("authorization carries the quote", func(t *testing.T) {
		got, err := ReleaseQuote(withAuthorization())
		if err != nil || got != TestFulfillmentQuote {
			t.Fatalf("ReleaseQuote = %q, %v", got, err)
		}
		if err := ValidateVerifyFulfillmentRequest(withAuthorization()); err != nil {
			t.Fatalf("a request carrying an authorization must validate: %v", err)
		}
	})
	t.Run("both are refused", func(t *testing.T) {
		req := withAuthorization()
		req.FulfillmentQuote = ptr(TestFulfillmentQuote)
		if _, err := ReleaseQuote(req); err == nil {
			t.Fatal("a request with a quote and an authorization must be refused")
		}
	})
	t.Run("neither is refused", func(t *testing.T) {
		req := CreateValidVerifyFulfillmentRequest()
		req.FulfillmentQuote = nil
		if _, err := ReleaseQuote(req); err == nil {
			t.Fatal("a request with no quote must be refused")
		}
	})
}
