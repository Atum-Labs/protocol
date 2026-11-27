package verifill

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestVerifyFulfillmentRequestBuilder(t *testing.T) {
	t.Run("build valid request with all fields", func(t *testing.T) {
		req, err := NewVerifyFulfillmentRequestBuilder().
			WithTransactionHash(TestTxHash).
			WithFulfillmentQuote(TestFulfillmentQuote).
			WithSenderAuth(TestSenderAuth).
			Build()

		if err != nil {
			t.Fatalf("Build() error = %v, want nil", err)
		}
		if req == nil {
			t.Fatal("Expected non-nil request")
		}
		if req.SenderAuth == nil || *req.SenderAuth != TestSenderAuth {
			t.Errorf("SenderAuth = %v, want %v", req.SenderAuth, TestSenderAuth)
		}
		if req.FulfillmentQuote == nil || *req.FulfillmentQuote != TestFulfillmentQuote {
			t.Errorf("FulfillmentQuote = %v, want %v", req.FulfillmentQuote, TestFulfillmentQuote)
		}
	})

	t.Run("error accumulation for invalid fields", func(t *testing.T) {
		_, err := NewVerifyFulfillmentRequestBuilder().
			WithTransactionHash(""). // Empty transaction hash
			Build()

		if err == nil {
			t.Fatal("Expected builder errors")
		}
		errStr := err.Error()
		if !strings.Contains(errStr, "transaction hash cannot be empty") {
			t.Error("Expected transaction hash error in accumulated errors")
		}
	})

	t.Run("validation fails on build", func(t *testing.T) {
		_, err := NewVerifyFulfillmentRequestBuilder().
			WithFulfillmentQuote(TestFulfillmentQuote).
			Build()

		if err == nil {
			t.Fatal("Expected validation error")
		}
		if !strings.Contains(err.Error(), "validation failed") {
			t.Errorf("Expected validation error, got: %v", err)
		}
	})

	t.Run("a missing quote fails the build", func(t *testing.T) {
		_, err := NewVerifyFulfillmentRequestBuilder().
			WithTransactionHash(TestTxHash).
			Build()

		if err == nil || !strings.Contains(err.Error(), "fulfillment_quote or fulfillment_authorization is required") {
			t.Errorf("Build() error = %v, want the missing quote reported", err)
		}
	})

	t.Run("fluent API chaining", func(t *testing.T) {
		builder := NewVerifyFulfillmentRequestBuilder()
		// Test that all methods return the same builder instance
		result := builder.
			WithTransactionHash(TestTxHash).
			WithFulfillmentQuote(TestFulfillmentQuote).
			WithSenderAuth(TestSenderAuth)

		if result != builder {
			t.Error("Builder methods should return the same instance for chaining")
		}
	})
}
func TestRefundSignatureRequestBuilder(t *testing.T) {
	t.Run("builds a valid request", func(t *testing.T) {
		req, err := NewRefundSignatureRequestBuilder().
			WithPaymentID(TestPaymentID).
			WithFulfillmentQuote(json.RawMessage(`{"version":"1.0"}`)).
			Build()
		if err != nil {
			t.Fatalf("Build: %v", err)
		}
		if req.PaymentId != TestPaymentID {
			t.Fatalf("payment_id = %q", req.PaymentId)
		}
	})

	t.Run("builds a request from the payer's payment request alone", func(t *testing.T) {
		text := `{"request_id":"req_1"}`
		req, err := NewRefundSignatureRequestBuilder().
			WithPaymentID(TestPaymentID).
			WithPaymentRequestJSON(text).
			Build()
		if err != nil {
			t.Fatalf("Build: %v", err)
		}
		if req.PaymentRequestJson == nil || *req.PaymentRequestJson != text || req.FulfillmentQuote != nil {
			t.Fatalf("payment_request_json = %v, fulfillment_quote = %s", req.PaymentRequestJson, req.FulfillmentQuote)
		}
	})

	t.Run("the deposit tx hash is optional", func(t *testing.T) {
		locator := "0x" + strings.Repeat("ab", 32)
		req, err := NewRefundSignatureRequestBuilder().
			WithPaymentID(TestPaymentID).
			WithFulfillmentQuote(json.RawMessage(`{"version":"1.0"}`)).
			WithDepositTransactionHash(locator).
			Build()
		if err != nil {
			t.Fatalf("Build: %v", err)
		}
		if req.DepositTransactionHash == nil || *req.DepositTransactionHash != locator {
			t.Fatal("deposit_transaction_hash was not carried")
		}
	})

	// A wrong locator is refused downstream by finding no deposit, but junk should not have
	// to travel to a chain RPC to be told it was junk.
	// The three real forms, all of which must pass: 0x hex on eip155, the bare 64 character
	// Tron txid, and a base58 Solana signature. Tron matters most, because the locator is the
	// only way veri-fill can reach a Tron deposit at all.
	t.Run("accepts every chain family's locator", func(t *testing.T) {
		for name, good := range map[string]string{
			"eip155 hex": "0x" + strings.Repeat("ab", 32),
			// Contains a zero deliberately: base58 has no "0", so a bare Tron txid passes
			// only if the hex branch accepts it without a 0x prefix. That is the case that broke.
			"tron bare hex":    "0" + strings.Repeat("a", 63),
			"solana signature": strings.Repeat("A", 87),
		} {
			if _, err := NewRefundSignatureRequestBuilder().
				WithPaymentID(TestPaymentID).
				WithFulfillmentQuote(json.RawMessage(`{"version":"1.0"}`)).
				WithDepositTransactionHash(good).
				Build(); err != nil {
				t.Errorf("%s locator %q was refused: %v", name, good, err)
			}
		}
	})

	t.Run("rejects a deposit tx hash that is not one", func(t *testing.T) {
		for _, bad := range []string{"0xabc", "not a hash", "0x" + strings.Repeat("zz", 32)} {
			if _, err := NewRefundSignatureRequestBuilder().
				WithPaymentID(TestPaymentID).
				WithFulfillmentQuote(json.RawMessage(`{"version":"1.0"}`)).
				WithDepositTransactionHash(bad).
				Build(); err == nil {
				t.Errorf("expected %q to be refused", bad)
			}
		}
	})

	// reserve_location is where the settler's own reserve landed, kept apart from
	// deposit_transaction_hash, which locates the payer's deposit. It is optional, and its
	// three members travel together.
	goodTx := "0x" + strings.Repeat("cd", 32)
	goodBlockNumber := "21500000"
	goodBlockHash := "0x" + strings.Repeat("ef", 32)

	t.Run("the reserve location is optional", func(t *testing.T) {
		req, err := NewRefundSignatureRequestBuilder().
			WithPaymentID(TestPaymentID).
			WithFulfillmentQuote(json.RawMessage(`{"version":"1.0"}`)).
			Build()
		if err != nil {
			t.Fatalf("Build without the field: %v", err)
		}
		if req.ReserveLocation != nil {
			t.Fatal("reserve_location set when it was not supplied")
		}

		deposit := "0x" + strings.Repeat("ab", 32)
		req, err = NewRefundSignatureRequestBuilder().
			WithPaymentID(TestPaymentID).
			WithFulfillmentQuote(json.RawMessage(`{"version":"1.0"}`)).
			WithDepositTransactionHash(deposit).
			WithReserveLocation(goodTx, goodBlockNumber, goodBlockHash).
			Build()
		if err != nil {
			t.Fatalf("Build: %v", err)
		}
		loc := req.ReserveLocation
		if loc == nil || loc.TransactionHash != goodTx || loc.BlockNumber != goodBlockNumber || loc.BlockHash != goodBlockHash {
			t.Fatalf("reserve_location was not carried: %+v", loc)
		}
		if req.DepositTransactionHash == nil || *req.DepositTransactionHash != deposit {
			t.Fatal("deposit_transaction_hash was not carried beside it")
		}
	})

	t.Run("accepts a well-formed reserve location", func(t *testing.T) {
		for name, loc := range map[string][3]string{
			"typical":               {goodTx, goodBlockNumber, goodBlockHash},
			"block zero":            {goodTx, "0", goodBlockHash},
			"uppercase hex":         {"0x" + strings.Repeat("CD", 32), goodBlockNumber, "0x" + strings.Repeat("EF", 32)},
			"tx as the sibling's":   {"0" + strings.Repeat("a", 63), goodBlockNumber, goodBlockHash},
			"19 digit block number": {goodTx, "1" + strings.Repeat("0", 18), goodBlockHash},
		} {
			if _, err := NewRefundSignatureRequestBuilder().
				WithPaymentID(TestPaymentID).
				WithFulfillmentQuote(json.RawMessage(`{"version":"1.0"}`)).
				WithReserveLocation(loc[0], loc[1], loc[2]).
				Build(); err != nil {
				t.Errorf("%s: %v was refused: %v", name, loc, err)
			}
		}
	})

	// The same malformed transaction values the deposit locator refuses, refused the same way.
	t.Run("rejects a reserve transaction hash that is not one", func(t *testing.T) {
		for _, bad := range []string{"0xabc", "not a hash", "0x" + strings.Repeat("zz", 32), ""} {
			_, err := NewRefundSignatureRequestBuilder().
				WithPaymentID(TestPaymentID).
				WithFulfillmentQuote(json.RawMessage(`{"version":"1.0"}`)).
				WithReserveLocation(bad, goodBlockNumber, goodBlockHash).
				Build()
			if err == nil {
				t.Errorf("expected transaction_hash %q to be refused", bad)
				continue
			}
			if !strings.Contains(err.Error(), "reserve_location.transaction_hash") {
				t.Errorf("%q refused for the wrong reason: %v", bad, err)
			}
		}
	})

	t.Run("rejects a block number that is not a non-negative integer", func(t *testing.T) {
		for _, bad := range []string{"-1", "1.5", "1e6", "0x10", "007", " 1", "", "1" + strings.Repeat("0", 19)} {
			_, err := NewRefundSignatureRequestBuilder().
				WithPaymentID(TestPaymentID).
				WithFulfillmentQuote(json.RawMessage(`{"version":"1.0"}`)).
				WithReserveLocation(goodTx, bad, goodBlockHash).
				Build()
			if err == nil {
				t.Errorf("expected block_number %q to be refused", bad)
				continue
			}
			if !strings.Contains(err.Error(), "reserve_location.block_number") {
				t.Errorf("%q refused for the wrong reason: %v", bad, err)
			}
		}
	})

	t.Run("rejects a block hash that is not 0x and 64 hex", func(t *testing.T) {
		for _, bad := range []string{"0xabc", strings.Repeat("ef", 32), "0x" + strings.Repeat("zz", 32), strings.Repeat("A", 87), ""} {
			_, err := NewRefundSignatureRequestBuilder().
				WithPaymentID(TestPaymentID).
				WithFulfillmentQuote(json.RawMessage(`{"version":"1.0"}`)).
				WithReserveLocation(goodTx, goodBlockNumber, bad).
				Build()
			if err == nil {
				t.Errorf("expected block_hash %q to be refused", bad)
				continue
			}
			if !strings.Contains(err.Error(), "reserve_location.block_hash") {
				t.Errorf("%q refused for the wrong reason: %v", bad, err)
			}
		}
	})

	// As decoded from the wire: a location missing any one member, or carrying the block
	// number as a JSON number, does not pass.
	t.Run("rejects a reserve location missing a member, as decoded", func(t *testing.T) {
		members := map[string]string{
			"transaction_hash": `"` + goodTx + `"`,
			"block_number":     `"` + goodBlockNumber + `"`,
			"block_hash":       `"` + goodBlockHash + `"`,
		}
		body := func(loc string) string {
			return `{"payment_id":"` + TestPaymentID + `","fulfillment_quote":{"version":"1.0"},"reserve_location":` + loc + `}`
		}
		decode := func(loc string) error {
			var req RefundSignatureRequest
			if err := json.Unmarshal([]byte(body(loc)), &req); err != nil {
				return err
			}
			return ValidateRefundSignatureRequest(&req)
		}

		whole := `{"transaction_hash":` + members["transaction_hash"] + `,"block_number":` + members["block_number"] + `,"block_hash":` + members["block_hash"] + `}`
		if err := decode(whole); err != nil {
			t.Fatalf("a whole location was refused: %v", err)
		}
		for missing := range members {
			parts := []string{}
			for _, name := range []string{"transaction_hash", "block_number", "block_hash"} {
				if name != missing {
					parts = append(parts, `"`+name+`":`+members[name])
				}
			}
			if err := decode(`{` + strings.Join(parts, ",") + `}`); err == nil {
				t.Errorf("a location without %s was accepted", missing)
			}
		}
		for _, number := range []string{"21500000", "-1", "1.5"} {
			loc := `{"transaction_hash":` + members["transaction_hash"] + `,"block_number":` + number + `,"block_hash":` + members["block_hash"] + `}`
			if err := decode(loc); err == nil {
				t.Errorf("block_number as the JSON number %s was accepted", number)
			}
		}
	})

	t.Run("rejects a missing quote", func(t *testing.T) {
		if _, err := NewRefundSignatureRequestBuilder().
			WithPaymentID(TestPaymentID).Build(); err == nil {
			t.Fatal("expected an error without a quote")
		}
	})

	t.Run("rejects a malformed payment id", func(t *testing.T) {
		if _, err := NewRefundSignatureRequestBuilder().
			WithPaymentID("0xabc").
			WithFulfillmentQuote(json.RawMessage(`{"version":"1.0"}`)).Build(); err == nil {
			t.Fatal("expected an error for a short payment_id")
		}
	})
}

func TestExtractChainIDFromAssetIdentifier(t *testing.T) {
	tests := []struct {
		name    string
		assetID string
		want    string
		wantErr bool
	}{
		{
			name:    "simple chain ID with token",
			assetID: "ethereum:0xtoken",
			want:    "ethereum",
			wantErr: false,
		},
		{
			name:    "CAIP-2 format with token",
			assetID: "eip155:1:0xtoken",
			want:    "eip155:1",
			wantErr: false,
		},
		{
			name:    "CAIP-2 format with native",
			assetID: "eip155:1:native",
			want:    "eip155:1",
			wantErr: false,
		},
		{
			name:    "chain ID with native",
			assetID: "ethereum:native",
			want:    "ethereum",
			wantErr: false,
		},
		{
			name:    "invalid format - no colon",
			assetID: "ethereum",
			want:    "",
			wantErr: true,
		},
		{
			name:    "invalid format - empty",
			assetID: "",
			want:    "",
			wantErr: true,
		},
		{
			name:    "more than 3 parts",
			assetID: "eip155:1:0xtoken:extra",
			want:    "",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ExtractChainIDFromAssetIdentifier(tt.assetID)
			if (err != nil) != tt.wantErr {
				t.Errorf("ExtractChainIDFromAssetIdentifier() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if got != tt.want {
				t.Errorf("ExtractChainIDFromAssetIdentifier() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestExtractTokenFromAssetIdentifier(t *testing.T) {
	tests := []struct {
		name    string
		assetID string
		want    string
		wantErr bool
	}{
		{
			name:    "simple format with token",
			assetID: "ethereum:0xtoken",
			want:    "0xtoken",
			wantErr: false,
		},
		{
			name:    "CAIP-2 format with token",
			assetID: "eip155:1:0xtoken",
			want:    "0xtoken",
			wantErr: false,
		},
		{
			name:    "native token on EVM",
			assetID: "eip155:1:native",
			want:    TestZeroAddress,
			wantErr: false,
		},
		{
			name:    "native token on non-EVM",
			assetID: "tron:mainnet:native",
			want:    "native",
			wantErr: false,
		},
		{
			name:    "full token address",
			assetID: "eip155:137:" + TestTokenAddress,
			want:    TestTokenAddress,
			wantErr: false,
		},
		{
			name:    "invalid format - no colon",
			assetID: "ethereum",
			want:    "",
			wantErr: true,
		},
		{
			name:    "invalid format - empty",
			assetID: "",
			want:    "",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ExtractTokenFromAssetIdentifier(tt.assetID)
			if (err != nil) != tt.wantErr {
				t.Errorf("ExtractTokenFromAssetIdentifier() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if got != tt.want {
				t.Errorf("ExtractTokenFromAssetIdentifier() = %v, want %v", got, tt.want)
			}
		})
	}
}
