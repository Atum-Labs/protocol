package verifill

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Regular expressions for validation
var (
	// caip2ChainIDRegex matches CAIP-2 chain identifiers (namespace:reference)
	// Allow hyphen in reference part for chains like "mainnet-beta" and "cosmoshub-4"
	caip2ChainIDRegex = regexp.MustCompile(`^[a-z0-9]+:[a-zA-Z0-9\-]+$`)

	// bytes32HexRegex matches a 0x-prefixed 32-byte hex string (e.g. a payment id)
	bytes32HexRegex = regexp.MustCompile(`^0x[a-fA-F0-9]{64}$`)

	// Same shape as the transaction_hash the verify request carries: 0x-prefixed hex, the
	// bare 64-character Tron form, or a base58 Solana signature. Loose on purpose, because
	// this request carries no chain id and so cannot narrow to one family.
	depositTxHashRegex = regexp.MustCompile(
		`^(0x[a-fA-F0-9]{64}|[a-fA-F0-9]{64}|[1-9A-HJ-NP-Za-km-z]{32,88})$`)

	// A base-10 block height with no sign, no leading zero and no exponent, the form the
	// spec gives every block_number.
	blockNumberRegex = regexp.MustCompile(`^(0|[1-9][0-9]{0,18})$`)
)

// ValidateVerifyFulfillmentRequest validates all required fields for a fulfillment verification request.
// The payment id, reserver, delivery terms, chains and contracts come from the quote, the sender_auth
// and veri-fill's own configuration, so what is checked here is the fulfill locator and the shapes of
// the quote and the optional sender_auth.
func ValidateVerifyFulfillmentRequest(req *VerifyFulfillmentRequest) error {
	if req == nil {
		return fmt.Errorf("request is nil")
	}

	// Validate the fulfill locator (required). The verification service fetches
	// the transaction receipt by this identifier to confirm delivery, so a
	// request without one can never be verified and must fail closed here.
	if req.TransactionHash == "" {
		return fmt.Errorf("transaction_hash is required")
	}

	quote, err := ReleaseQuote(req)
	if err != nil {
		return err
	}
	if err := validateQuoteDocument([]byte(quote)); err != nil {
		return err
	}

	if req.SenderAuth != nil {
		if err := validateSenderAuthDocument([]byte(*req.SenderAuth)); err != nil {
			return err
		}
	}

	return nil
}

// ReleaseQuote returns the awarded quote a release request carries, from fulfillment_quote or from
// fulfillment_authorization's fulfillment_quote_json, and refuses a request with both or neither.
func ReleaseQuote(req *VerifyFulfillmentRequest) (string, error) {
	hasQuote := req.FulfillmentQuote != nil && *req.FulfillmentQuote != ""
	hasAuthorization := req.FulfillmentAuthorization != nil
	switch {
	case hasQuote && hasAuthorization:
		return "", fmt.Errorf("send a fulfillment_quote or a fulfillment_authorization, not both")
	case hasQuote:
		return *req.FulfillmentQuote, nil
	case hasAuthorization:
		return req.FulfillmentAuthorization.FulfillmentQuoteJson, nil
	default:
		return "", fmt.Errorf("fulfillment_quote or fulfillment_authorization is required")
	}
}

// validateQuoteDocument checks fulfillment_quote is present and is a JSON object. Null, a bare
// string or a number would all unmarshal and then fail deeper in with a worse message.
func validateQuoteDocument(quote []byte) error {
	trimmed := bytes.TrimSpace(quote)
	if len(trimmed) == 0 {
		return fmt.Errorf("fulfillment_quote is required")
	}
	if !json.Valid(trimmed) {
		return fmt.Errorf("fulfillment_quote is not valid JSON")
	}
	if trimmed[0] != '{' {
		return fmt.Errorf("fulfillment_quote must be the signed quote document, a JSON object")
	}
	return nil
}

// validatePaymentRequestText checks a sent payment_request_json is JSON object text. Reading it is
// veri-fill's: it strict-reads the text as received.
func validatePaymentRequestText(text string) error {
	trimmed := bytes.TrimSpace([]byte(text))
	if len(trimmed) == 0 || !json.Valid(trimmed) || trimmed[0] != '{' {
		return fmt.Errorf("payment_request_json must be the payment request as JSON object text")
	}
	return nil
}

// validateSenderAuthDocument checks a sent sender_auth is a non-empty JSON object.
func validateSenderAuthDocument(senderAuth []byte) error {
	var members map[string]json.RawMessage
	trimmed := bytes.TrimSpace(senderAuth)
	if len(trimmed) == 0 || trimmed[0] != '{' || json.Unmarshal(trimmed, &members) != nil || len(members) == 0 {
		return fmt.Errorf("sender_auth must be the SenderAuth object as JSON text")
	}
	return nil
}

// DestinationChainID returns the CAIP-2 chain of the single destination leg in the quote's signed
// payment_request_json, the chain a fulfillment verdict must be about. Zero or several legs are refused.
func DestinationChainID(fulfillmentQuote string) (string, error) {
	var q struct {
		PaymentRequestJSON string `json:"payment_request_json"`
	}
	if err := json.Unmarshal([]byte(fulfillmentQuote), &q); err != nil {
		return "", fmt.Errorf("fulfillment_quote does not decode: %w", err)
	}
	var pr struct {
		Destination []struct {
			AssetIdentifier string `json:"asset_identifier"`
		} `json:"destination"`
	}
	if err := json.Unmarshal([]byte(q.PaymentRequestJSON), &pr); err != nil {
		return "", fmt.Errorf("fulfillment_quote payment_request_json does not decode: %w", err)
	}
	if len(pr.Destination) != 1 {
		return "", fmt.Errorf("fulfillment_quote payment request has %d destination legs, want exactly 1", len(pr.Destination))
	}
	id := strings.TrimSpace(pr.Destination[0].AssetIdentifier)
	chainID, _, found := strings.Cut(id, "/")
	if !found || !isValidCAIP2ChainID(chainID) {
		return "", fmt.Errorf("fulfillment_quote destination asset_identifier does not name a CAIP-2 chain: %q", id)
	}
	return chainID, nil
}

// ValidateRefundSignatureRequest checks the payment id, and that the request carries the quote,
// the payer's payment request, or both, each shaped as a JSON object.
func ValidateRefundSignatureRequest(req *RefundSignatureRequest) error {
	if req == nil {
		return fmt.Errorf("request is nil")
	}
	if !bytes32HexRegex.MatchString(req.PaymentId) {
		return fmt.Errorf("payment_id must be a 0x-prefixed 32-byte hex string")
	}
	// An explicit null decodes to the bytes "null": it is no quote, as an omitted one is.
	hasQuote := req.FulfillmentQuote != nil && !bytes.Equal(bytes.TrimSpace(req.FulfillmentQuote), []byte("null"))
	if !hasQuote && req.PaymentRequestJson == nil {
		return fmt.Errorf("fulfillment_quote or payment_request_json is required")
	}
	if hasQuote {
		if err := validateQuoteDocument(req.FulfillmentQuote); err != nil {
			return err
		}
	}
	if req.PaymentRequestJson != nil {
		if err := validatePaymentRequestText(*req.PaymentRequestJson); err != nil {
			return err
		}
	}
	// A shape check only. The request no longer carries a chain id, so the family that
	// decides the real format (0x hex on eip155 and tron, base58 on solana) is unknown
	// here. This still turns obvious junk into a clear error instead of a chain lookup
	// that comes back "no deposit found", which is a confusing thing to debug.
	if req.DepositTransactionHash != nil && !depositTxHashRegex.MatchString(*req.DepositTransactionHash) {
		return fmt.Errorf("deposit_transaction_hash is not a transaction identifier")
	}
	if req.ReserveLocation != nil {
		if err := validateReserveLocation(req.ReserveLocation); err != nil {
			return err
		}
	}
	return nil
}

// validateReserveLocation is the same shape check, for the same reason, on the reserve
// location. Its three members travel together, so a missing one (decoded as "") is refused.
func validateReserveLocation(loc *ReserveLocation) error {
	if !depositTxHashRegex.MatchString(loc.TransactionHash) {
		return fmt.Errorf("reserve_location.transaction_hash is not a transaction identifier")
	}
	if !blockNumberRegex.MatchString(loc.BlockNumber) {
		return fmt.Errorf("reserve_location.block_number must be a non-negative base-10 integer string")
	}
	if !bytes32HexRegex.MatchString(loc.BlockHash) {
		return fmt.Errorf("reserve_location.block_hash must be a 0x-prefixed 32-byte hex string")
	}
	return nil
}

// isValidCAIP2ChainID checks if a string is a valid CAIP-2 chain identifier
func isValidCAIP2ChainID(chainID string) bool {
	return caip2ChainIDRegex.MatchString(chainID)
}

// isEVMChain checks if a CAIP-2 chain ID represents an EVM chain
func isEVMChain(chainID string) bool {
	return strings.HasPrefix(chainID, "eip155:")
}

// isTronChain checks if a CAIP-2 chain ID represents a Tron chain
func isTronChain(chainID string) bool {
	return strings.HasPrefix(chainID, "tron:")
}

// isSolanaChain checks if a CAIP-2 chain ID represents a Solana chain
func isSolanaChain(chainID string) bool {
	return strings.HasPrefix(chainID, "solana:")
}

// NormalizeAddress normalizes an address for the given chain type.
// For EVM chains, it lowercases the address.
// For other chains, it returns the address as-is.
func NormalizeAddress(address string, chainID string) string {
	if isEVMChain(chainID) {
		return strings.ToLower(address)
	}
	return address
}
