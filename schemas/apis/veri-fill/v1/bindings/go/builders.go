package verifill

import (
	"encoding/json"
	"fmt"
	"strings"
)

// VerifyFulfillmentRequestBuilder provides a fluent API for building fulfillment verification requests.
//
// The payment id, reserver, delivery terms, chains, settler, depositor, source token, source amount
// and contracts are not set here: veri-fill takes them from the verified quote, the sender_auth and
// its own chain configuration.
type VerifyFulfillmentRequestBuilder struct {
	request VerifyFulfillmentRequest
	errors  []error
}

// NewVerifyFulfillmentRequestBuilder creates a new builder for VerifyFulfillmentRequest
func NewVerifyFulfillmentRequestBuilder() *VerifyFulfillmentRequestBuilder {
	return &VerifyFulfillmentRequestBuilder{
		request: VerifyFulfillmentRequest{},
		errors:  []error{},
	}
}

// WithTransactionHash sets the fulfill transaction identifier (required)
func (b *VerifyFulfillmentRequestBuilder) WithTransactionHash(txHash string) *VerifyFulfillmentRequestBuilder {
	if txHash == "" {
		b.errors = append(b.errors, fmt.Errorf("transaction hash cannot be empty"))
	}
	b.request.TransactionHash = txHash
	return b
}

// WithFulfillmentQuote sets the awarded quote, the signed document serialized to a string.
//
// Forward the value as received. Canonicalization removes key order and indentation, so
// those are harmless, but changing any VALUE -- a renormalized timestamp, a re-serialized
// payment_request_json -- changes the hash and the request is refused.
func (b *VerifyFulfillmentRequestBuilder) WithFulfillmentQuote(quote string) *VerifyFulfillmentRequestBuilder {
	b.request.FulfillmentQuote = &quote
	return b
}

// WithSenderAuth sets the payer's SenderAuth object as JSON text. Send it when the quote's embedded
// payment request carries no sender_auth; veri-fill derives the payment id and reserver from it.
func (b *VerifyFulfillmentRequestBuilder) WithSenderAuth(senderAuth string) *VerifyFulfillmentRequestBuilder {
	b.request.SenderAuth = &senderAuth
	return b
}

// Build validates and returns the built request
func (b *VerifyFulfillmentRequestBuilder) Build() (*VerifyFulfillmentRequest, error) {
	// Check for accumulated errors
	if len(b.errors) > 0 {
		return nil, fmt.Errorf("builder errors: %v", b.errors)
	}

	// Validate the complete request
	if err := ValidateVerifyFulfillmentRequest(&b.request); err != nil {
		return nil, fmt.Errorf("validation failed: %w", err)
	}

	return &b.request, nil
}

// RefundSignatureRequestBuilder provides a fluent API for building refund signature requests.
//
// Three fields, because veri-fill reads the rest for itself: the witness members come from
// the deposit's on-chain events and the escrow address from its own configuration.
type RefundSignatureRequestBuilder struct {
	request *RefundSignatureRequest
}

// NewRefundSignatureRequestBuilder creates a new builder for RefundSignatureRequest.
func NewRefundSignatureRequestBuilder() *RefundSignatureRequestBuilder {
	return &RefundSignatureRequestBuilder{request: &RefundSignatureRequest{}}
}

// WithPaymentID sets the escrow deposit identifier.
func (b *RefundSignatureRequestBuilder) WithPaymentID(id string) *RefundSignatureRequestBuilder {
	b.request.PaymentId = id
	return b
}

// WithFulfillmentQuote sets the settler-signed quote document.
//
// Forward the value as received. Canonicalization removes key order and indentation, so
// those are harmless, but changing any VALUE -- a renormalized timestamp, a re-serialized
// payment_request_json -- changes the hash and the request is refused.
func (b *RefundSignatureRequestBuilder) WithFulfillmentQuote(quote json.RawMessage) *RefundSignatureRequestBuilder {
	b.request.FulfillmentQuote = quote
	return b
}

// WithPaymentRequestJSON sets the payment request the payer signed, as its raw JSON text, sent
// instead of the quote or alongside it.
//
// Forward the text as received: veri-fill reads it as is, and accepts it only when the deposit
// commits its depositRequestHash v2.
func (b *RefundSignatureRequestBuilder) WithPaymentRequestJSON(text string) *RefundSignatureRequestBuilder {
	b.request.PaymentRequestJson = &text
	return b
}

// WithDepositTransactionHash sets the optional locator for the deposit transaction.
//
// A hint, never a fact. A malformed value is refused by Build, and a well-formed but wrong
// one simply finds no matching deposit on chain.
func (b *RefundSignatureRequestBuilder) WithDepositTransactionHash(txHash string) *RefundSignatureRequestBuilder {
	b.request.DepositTransactionHash = &txHash
	return b
}

// WithReserveLocation sets the optional location of the reserve of this deposit: the
// transaction, and the number and hash of the block that holds it. For a direct deposit the
// settler sends its own reserve. blockNumber is base-10.
//
// A hint, never a fact. A malformed member is refused by Build, and a well-formed but wrong
// location leaves the answer what it would have been without it once the gate's node has
// reached blockNumber. Send it only for an eip155 source chain.
func (b *RefundSignatureRequestBuilder) WithReserveLocation(txHash, blockNumber, blockHash string) *RefundSignatureRequestBuilder {
	b.request.ReserveLocation = &ReserveLocation{
		TransactionHash: txHash,
		BlockNumber:     blockNumber,
		BlockHash:       blockHash,
	}
	return b
}

// Build validates and returns the request.
func (b *RefundSignatureRequestBuilder) Build() (*RefundSignatureRequest, error) {
	if err := ValidateRefundSignatureRequest(b.request); err != nil {
		return nil, err
	}
	return b.request, nil
}

// Helper functions for extracting V2 witness fields from common structures

// ExtractChainIDFromAssetIdentifier extracts the chain ID from an asset identifier
// Format: "chain_id:token_address" or "chain_id:native"
func ExtractChainIDFromAssetIdentifier(assetID string) (string, error) {
	parts := strings.Split(assetID, ":")
	if len(parts) < 2 {
		return "", fmt.Errorf("invalid asset identifier format: %s", assetID)
	}

	// Reconstruct chain ID (may have multiple colons)
	if len(parts) == 2 {
		return parts[0], nil
	}

	// For CAIP-2 format like "eip155:1:0xtoken"
	if len(parts) == 3 {
		return fmt.Sprintf("%s:%s", parts[0], parts[1]), nil
	}

	return "", fmt.Errorf("unexpected asset identifier format: %s", assetID)
}

// ExtractTokenFromAssetIdentifier extracts the token address from an asset identifier
func ExtractTokenFromAssetIdentifier(assetID string) (string, error) {
	parts := strings.Split(assetID, ":")
	if len(parts) < 2 {
		return "", fmt.Errorf("invalid asset identifier format: %s", assetID)
	}

	// Get the last part (token address or "native")
	token := parts[len(parts)-1]

	// Convert "native" to zero address for EVM chains
	if token == "native" && strings.Contains(assetID, "eip155") {
		return "0x0000000000000000000000000000000000000000", nil
	}

	return token, nil
}
