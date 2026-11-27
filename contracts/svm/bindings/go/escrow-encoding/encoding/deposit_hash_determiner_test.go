package svm_escrow_encoding

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	prmeta "github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go"
	paymentrequest "github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/generated"
)

// TestDetermineDepositHash_Usage demonstrates how to compute the deposit_hash
// from a PaymentRequest by extracting parameters from message_prehash.
//
// This is the primary entry point for payment-gw when processing Solana requests.
// The deposit_hash is used as the unique payment identifier for tracking.
func TestDetermineDepositHash_Usage(t *testing.T) {
	// Create the message_prehash JSON with all deposit parameters
	prehash := SolanaDepositPrehash{
		DepositRequestHash: "0x0102030405060708091011121314151617181920212223242526272829303132",
		Depositor:          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
		Mint:               "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
		Amount:             "1000000", // 1 USDC (as string)
		Reserver:           "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
		Releaser:           "So11111111111111111111111111111111111111112",
		Nonce:              "12345",
		IssuedAt:           "1700000000",
		Deadline:           "1700000128", // 128s after IssuedAt
	}
	prehashJSON, _ := json.Marshal(prehash)
	prehashStr := string(prehashJSON)

	// Construct a PaymentRequest with SOLANA message scheme
	req := paymentrequest.SchemaJson{
		Version:   prmeta.Version,
		RequestId: "payment-request-12345",
		Source: paymentrequest.OwnedAsset{
			Account:         "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
			AssetIdentifier: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
		},
		Destination: []paymentrequest.OwnedAsset{
			{Account: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
		},
		FulfillmentAmount: "1000000",
		SenderAuth: &paymentrequest.SenderAuth{
			MessageScheme: paymentrequest.SenderAuthMessageSchemeSOLANA,
			SignedMessages: []paymentrequest.SignedMessage{
				{
					Message:        "0xabcdef1234567890",
					MessagePrehash: prehashStr,
					Signature:      "base58-signature",
				},
			},
		},
	}

	// Compute deposit_hash from PaymentRequest
	depositHash, err := DetermineDepositHash(req, testEscrowDomain())
	if err != nil {
		t.Fatalf("DetermineDepositHash failed: %v", err)
	}

	// depositHash is the unique payment identifier
	_ = fmt.Sprintf("0x%x", depositHash[:])
}

func TestDetermineDepositHash_NilSenderAuth(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	req.SenderAuth = nil // sender_auth is optional on the unified schema; must not panic

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for nil sender_auth")
	}
	if !errors.Is(err, ErrMissingSenderAuth) {
		t.Errorf("expected ErrMissingSenderAuth, got: %v", err)
	}
}

func TestDetermineDepositHash(t *testing.T) {
	req := createValidSolanaPaymentRequest()

	depositHash, err := DetermineDepositHash(req, testEscrowDomain())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify deposit hash is non-zero
	var zero32 [32]byte
	if depositHash == zero32 {
		t.Error("deposit hash should not be zero")
	}
}

func TestDetermineDepositHash_Deterministic(t *testing.T) {
	req := createValidSolanaPaymentRequest()

	hash1, err := DetermineDepositHash(req, testEscrowDomain())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	hash2, err := DetermineDepositHash(req, testEscrowDomain())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if hash1 != hash2 {
		t.Error("deposit hash should be deterministic for same input")
	}
}

func TestDetermineDepositHash_DifferentPaymentIDs(t *testing.T) {
	req1 := createValidSolanaPaymentRequest()
	req2 := createValidSolanaPaymentRequestWithPaymentID("0x0000000000000000000000000000000000000000000000000000000000000002")

	hash1, _ := DetermineDepositHash(req1, testEscrowDomain())
	hash2, _ := DetermineDepositHash(req2, testEscrowDomain())

	if hash1 == hash2 {
		t.Error("different payment IDs should produce different deposit hashes")
	}
}

func TestDetermineDepositHash_NotSolanaRequest(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	req.SenderAuth.MessageScheme = paymentrequest.SenderAuthMessageSchemeEVMPERMIT2

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for non-Solana request")
	}
	if !errors.Is(err, ErrNotSolanaRequest) {
		t.Errorf("expected ErrNotSolanaRequest, got: %v", err)
	}
}

func TestDetermineDepositHash_EmptySignedMessages(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	req.SenderAuth.SignedMessages = []paymentrequest.SignedMessage{}

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for empty signed_messages")
	}
	if !errors.Is(err, ErrMissingSignedMessages) {
		t.Errorf("expected ErrMissingSignedMessages, got: %v", err)
	}
}

func TestDetermineDepositHash_MissingMessagePrehash(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	req.SenderAuth.SignedMessages[0].MessagePrehash = ""

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for missing message_prehash")
	}
	if !errors.Is(err, ErrMissingMessagePrehash) {
		t.Errorf("expected ErrMissingMessagePrehash, got: %v", err)
	}
}

func TestDetermineDepositHash_InvalidJSON(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	invalidJSON := "not valid json"
	req.SenderAuth.SignedMessages[0].MessagePrehash = invalidJSON

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

func TestDetermineDepositHash_InvalidPaymentIDHex(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	prehash := createTestPrehash()
	prehash.DepositRequestHash = "not-valid-hex"
	setPrehash(&req, prehash)

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for invalid deposit_request_hash hex")
	}
}

func TestDetermineDepositHash_InvalidDepositor(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	prehash := createTestPrehash()
	prehash.Depositor = "invalid-base58!"
	setPrehash(&req, prehash)

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for invalid depositor")
	}
}

func TestDetermineDepositHash_InvalidAmount(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	prehash := createTestPrehash()
	prehash.Amount = "not-a-number"
	setPrehash(&req, prehash)

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for invalid amount")
	}
}

func TestDetermineDepositHash_OverflowAmount(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	prehash := createTestPrehash()
	// uint64 max is 18446744073709551615, this exceeds it
	prehash.Amount = "18446744073709551616"
	setPrehash(&req, prehash)

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for overflow amount")
	}
}

func TestDetermineDepositHash_NegativeAmount(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	prehash := createTestPrehash()
	prehash.Amount = "-1"
	setPrehash(&req, prehash)

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for negative amount")
	}
}

func TestDetermineDepositHash_MaxUint64Values(t *testing.T) {
	// Test that max uint64 values are handled correctly
	req := createValidSolanaPaymentRequest()
	prehash := createTestPrehash()
	prehash.Amount = "18446744073709551615"   // max uint64
	prehash.Nonce = "18446744073709551615"    // max uint64
	prehash.IssuedAt = "18446744073709551615" // max uint64
	prehash.Deadline = "18446744073709551615" // max uint64
	setPrehash(&req, prehash)

	// Should succeed - max values are valid
	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err != nil {
		t.Errorf("max uint64 values should be valid: %v", err)
	}
}

func TestDetermineDepositHash_InvalidReserver(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	prehash := createTestPrehash()
	prehash.Reserver = "invalid!"
	setPrehash(&req, prehash)

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for invalid reserver")
	}
}

func TestDetermineDepositHash_InvalidReleaser(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	prehash := createTestPrehash()
	prehash.Releaser = "invalid-base58!"
	setPrehash(&req, prehash)

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for invalid releaser")
	}
}

func TestDetermineDepositHash_InvalidNonce(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	prehash := createTestPrehash()
	prehash.Nonce = "not-a-number"
	setPrehash(&req, prehash)

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for invalid nonce")
	}
}

func TestDetermineDepositHash_InvalidIssuedAt(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	prehash := createTestPrehash()
	prehash.IssuedAt = "not-a-timestamp"
	setPrehash(&req, prehash)

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for invalid issued_at")
	}
}

func TestDetermineDepositHash_InvalidDeadline(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	prehash := createTestPrehash()
	prehash.Deadline = "invalid-deadline"
	setPrehash(&req, prehash)

	_, err := DetermineDepositHash(req, testEscrowDomain())
	if err == nil {
		t.Error("expected error for invalid deadline")
	}
}

func TestParseSolanaDepositPrehash_ValidJSON(t *testing.T) {
	prehash := createTestPrehash()
	jsonBytes, _ := json.Marshal(prehash)

	parsed, err := ParseSolanaDepositPrehash(string(jsonBytes))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if parsed.DepositRequestHash != prehash.DepositRequestHash {
		t.Errorf("deposit_request_hash mismatch: got %s, want %s", parsed.DepositRequestHash, prehash.DepositRequestHash)
	}
	if parsed.Depositor != prehash.Depositor {
		t.Errorf("depositor mismatch: got %s, want %s", parsed.Depositor, prehash.Depositor)
	}
	if parsed.Amount != prehash.Amount {
		t.Errorf("amount mismatch: got %s, want %s", parsed.Amount, prehash.Amount)
	}
}

func TestParseSolanaDepositPrehash_MissingFields(t *testing.T) {
	tests := []struct {
		name    string
		jsonStr string
		wantErr string
	}{
		{
			name:    "missing payment_id",
			jsonStr: `{"depositor":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","amount":"1000000","reserver":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","releaser":"So11111111111111111111111111111111111111112","nonce":"12345","issued_at":"1700000000","deadline":"1700000128"}`,
			wantErr: "payment_id is required",
		},
		{
			name:    "missing depositor",
			jsonStr: `{"payment_id":"0x0102030405060708091011121314151617181920212223242526272829303132","mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","amount":"1000000","reserver":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","releaser":"So11111111111111111111111111111111111111112","nonce":"12345","issued_at":"1700000000","deadline":"1700000128"}`,
			wantErr: "depositor is required",
		},
		{
			name:    "missing amount",
			jsonStr: `{"payment_id":"0x0102030405060708091011121314151617181920212223242526272829303132","depositor":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","reserver":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA","releaser":"So11111111111111111111111111111111111111112","nonce":"12345","issued_at":"1700000000","deadline":"1700000128"}`,
			wantErr: "amount is required",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseSolanaDepositPrehash(tc.jsonStr)
			if err == nil {
				t.Error("expected error")
				return
			}
			if err.Error() != tc.wantErr {
				t.Errorf("error mismatch: got %q, want %q", err.Error(), tc.wantErr)
			}
		})
	}
}

func TestParseHexBytes32(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    [32]byte
		wantErr bool
	}{
		{
			name:  "with 0x prefix",
			input: "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
			want:  [32]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32},
		},
		{
			name:  "without prefix",
			input: "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
			want:  [32]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32},
		},
		{
			name:  "with 0X prefix (uppercase)",
			input: "0X0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
			want:  [32]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32},
		},
		{
			name:    "too short",
			input:   "0x0102030405",
			wantErr: true,
		},
		{
			name:    "too long",
			input:   "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2021",
			wantErr: true,
		},
		{
			name:    "invalid hex chars",
			input:   "0xgg02030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseHexBytes32(tc.input)
			if tc.wantErr {
				if err == nil {
					t.Error("expected error")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Errorf("mismatch:\ngot:  %x\nwant: %x", got, tc.want)
			}
		})
	}
}

func TestDetermineDepositHash_CrossValidation(t *testing.T) {
	// Cross-validation against TypeScript-generated golden vector.
	// The test vector contains a message_prehash JSON (with Base58 pubkeys,
	// hex deposit_request_hash, string amounts) and the expected deposit_hash.
	// This validates the full pipeline: JSON parsing → Base58 decoding → hash computation.
	vectors, err := loadTestVectors()
	if err != nil {
		t.Fatalf("failed to load test vectors: %v", err)
	}

	// Build a PaymentRequest using the golden message_prehash
	prehashStr := vectors.DeterminePaymentID.MessagePrehash
	req := paymentrequest.SchemaJson{
		Version:   prmeta.Version,
		RequestId: "golden-vector-test",
		Source: paymentrequest.OwnedAsset{
			Account:         "test",
			AssetIdentifier: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:test",
		},
		Destination: []paymentrequest.OwnedAsset{
			{Account: "test"},
		},
		FulfillmentAmount: "1000000",
		SenderAuth: &paymentrequest.SenderAuth{
			MessageScheme: paymentrequest.SenderAuthMessageSchemeSOLANA,
			SignedMessages: []paymentrequest.SignedMessage{
				{
					Message:        "0x00",
					MessagePrehash: prehashStr,
					Signature:      "test-signature",
				},
			},
		},
	}

	depositHash, err := DetermineDepositHash(req, testEscrowDomain())
	if err != nil {
		t.Fatalf("DetermineDepositHash failed: %v", err)
	}

	got := hex.EncodeToString(depositHash[:])
	if got != vectors.DeterminePaymentID.ExpectedHash {
		t.Errorf("cross-validation failed:\ngot:  %s\nwant: %s", got, vectors.DeterminePaymentID.ExpectedHash)
	}
}

// Helper functions

func createTestPrehash() SolanaDepositPrehash {
	return SolanaDepositPrehash{
		DepositRequestHash: "0x0102030405060708091011121314151617181920212223242526272829303132",
		Depositor:          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
		Mint:               "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
		Amount:             "1000000",
		Reserver:           "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
		Releaser:           "So11111111111111111111111111111111111111112",
		Nonce:              "12345",
		IssuedAt:           "1700000000",
		Deadline:           "1700000128", // 128 seconds after issued_at (REPLAY_HORIZON_SECS)
	}
}

func setPrehash(req *paymentrequest.SchemaJson, prehash SolanaDepositPrehash) {
	jsonBytes, _ := json.Marshal(prehash)
	jsonStr := string(jsonBytes)
	req.SenderAuth.SignedMessages[0].MessagePrehash = jsonStr
}

// createValidSolanaPaymentRequest creates a valid PaymentRequest for testing.
// Uses real Solana pubkey formats for realistic test data.
//
// Time constraints for Solana escrow:
// - issued_at: When the authorization was signed
// - deadline: Must satisfy issued_at <= deadline <= issued_at + 128 (REPLAY_HORIZON_SECS)
func createValidSolanaPaymentRequest() paymentrequest.SchemaJson {
	prehash := createTestPrehash()
	jsonBytes, _ := json.Marshal(prehash)
	prehashStr := string(jsonBytes)

	return paymentrequest.SchemaJson{
		Version:   prmeta.Version,
		RequestId: "test-payment-request-001",
		Source: paymentrequest.OwnedAsset{
			Account:         "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
			AssetIdentifier: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
		},
		Destination: []paymentrequest.OwnedAsset{
			{
				Account:         "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
				AssetIdentifier: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
			},
		},
		FulfillmentAmount: "1000000",
		SenderAuth: &paymentrequest.SenderAuth{
			MessageScheme: paymentrequest.SenderAuthMessageSchemeSOLANA,
			SignedMessages: []paymentrequest.SignedMessage{
				{
					Message:        "0xabcdef1234567890", // hex-encoded hash
					MessagePrehash: prehashStr,
					Signature:      "test-signature-base58",
				},
			},
		},
	}
}

func createValidSolanaPaymentRequestWithPaymentID(paymentID string) paymentrequest.SchemaJson {
	req := createValidSolanaPaymentRequest()
	prehash := createTestPrehash()
	prehash.DepositRequestHash = paymentID
	setPrehash(&req, prehash)
	return req
}

// TestDeprecatedAliasesForward pins that the old names still resolve to the new implementations.
// They are not decoration: atum-core's payment-gw processor tests import DeterminePaymentID, so
// dropping or diverging these breaks a consumer in another repository. Asserting equality rather
// than merely "it compiles" is the point -- a forwarder that called the wrong sibling would still
// build.
func TestDeprecatedAliasesForward(t *testing.T) {
	req := createValidSolanaPaymentRequest()
	domain := testEscrowDomain()

	want, err := DetermineDepositHash(req, domain)
	if err != nil {
		t.Fatalf("DetermineDepositHash: %v", err)
	}
	got, err := DeterminePaymentID(req, domain)
	if err != nil {
		t.Fatalf("deprecated DeterminePaymentID: %v", err)
	}
	if got != want {
		t.Fatalf("deprecated DeterminePaymentID must forward to DetermineDepositHash: got %x want %x", got, want)
	}
}
