package paymentrequest

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
)

// ErrInvalidDirectDeposit marks every refusal from the originator-executed deposit rules, so a
// caller can tell them from a schema failure or an unsupported destination without matching on
// message text.
var ErrInvalidDirectDeposit = errors.New("invalid originator-executed deposit")

// The rules a DirectDepositRuleError names: a bounded set, so a consumer maps each to its API
// error and tags metrics with it. The first seven are the names payment-gw's direct deposit
// admission reports; source and destination are new with these rules.
const (
	DirectDepositRuleExecutor            = "executor"
	DirectDepositRuleSenderAuth          = "sender_auth"
	DirectDepositRuleDepositNonce        = "deposit_nonce"
	DirectDepositRuleQuoteSelector       = "quote_selector"
	DirectDepositRuleFulfillmentVerifier = "fulfillment_verifier"
	DirectDepositRuleMaxSourceAmount     = "max_source_amount"
	DirectDepositRuleRequestID           = "request_id"
	DirectDepositRuleSource              = "source"
	DirectDepositRuleDestination         = "destination"
)

// DirectDepositRuleError is a request the originator-executed deposit rules refuse. Rule is one
// of the DirectDepositRule constants. It unwraps to ErrInvalidDirectDeposit.
type DirectDepositRuleError struct {
	Rule   string
	Detail string
}

func (e *DirectDepositRuleError) Error() string {
	return "originator-executed deposit: " + e.Rule + ": " + e.Detail
}

// Unwrap reports the sentinel, so errors.Is matches this refusal wherever it is wrapped.
func (e *DirectDepositRuleError) Unwrap() error { return ErrInvalidDirectDeposit }

var (
	directDepositAddress   = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
	directDepositUint      = regexp.MustCompile(`^[0-9]+$`)
	directDepositRequestID = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)
	// directDepositSourceAsset is a CAIP-19 ERC-20 on an EVM chain, the only source directDeposit
	// pulls; the submatch is the token.
	directDepositSourceAsset = regexp.MustCompile(`^eip155:[0-9]+/erc20:(0x[0-9a-fA-F]{40})$`)
	maxUint256               = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
	maxUint256Decimal        = maxUint256.String()
)

// directDepositMaxDestinationBytes mirrors MAX_DESTINATION_BYTES in Escrow.sol: a longer composed
// destination reverts DestinationTooLong. conformance/destination-vectors.json pins it.
const directDepositMaxDestinationBytes = 256

// directDepositMembers are the root members these rules read, beyond executor and destination.
var directDepositMembers = []string{"deposit_nonce", "quote_selector", "fulfillment_verifier", "max_source_amount", "request_id", "source"}

// validateDirectDeposit applies the originator-executed deposit rules. The payer funds the deposit
// with directDeposit before the request exists, so the request has to name everything the deposit
// committed, and nothing signed off chain: the chain is the authorization (CORE-3005). Any other
// request carries no deposit_nonce.
//
// root holds the request's root members by their exact names (see ValidateRules), and executor is
// the value of the one named exactly "executor".
func validateDirectDeposit(executor any, root map[string]json.RawMessage) error {
	_, hasNonce := root["deposit_nonce"]
	if !DepositsAsOriginator(executor) {
		if hasNonce {
			return directDepositRefusal(DirectDepositRuleDepositNonce, "deposit_nonce is only a member of an originator-executed deposit")
		}
		return nil
	}
	legs, _ := executor.(map[string]any)
	if reserve, _ := legs["reserve"].(string); reserve != "settler" {
		return directDepositRefusal(DirectDepositRuleExecutor, "an originator-executed deposit names each leg, with reserve by the settler")
	}
	if _, present := root["sender_auth"]; present {
		return directDepositRefusal(DirectDepositRuleSenderAuth, "an originator-executed deposit carries no sender_auth")
	}
	if !isUint256(stringMember(root, "deposit_nonce"), false) {
		return directDepositRefusal(DirectDepositRuleDepositNonce, "deposit_nonce must be a decimal uint256")
	}
	// The escrow refuses a zero reserver or releaser (_requireDepositWitness), so a request naming
	// one validates but can never be funded.
	quoteSelector := stringMember(root, "quote_selector")
	if !directDepositAddress.MatchString(quoteSelector) {
		return directDepositRefusal(DirectDepositRuleQuoteSelector, "quote_selector must be an EVM address")
	}
	if isZeroAddress(quoteSelector) {
		return directDepositRefusal(DirectDepositRuleQuoteSelector, "quote_selector must not be the zero address")
	}
	var verifier map[string]json.RawMessage
	if raw, ok := root["fulfillment_verifier"]; ok {
		_ = json.Unmarshal(raw, &verifier)
	}
	verifierAccount := stringMember(verifier, "account")
	if !directDepositAddress.MatchString(verifierAccount) {
		return directDepositRefusal(DirectDepositRuleFulfillmentVerifier, "fulfillment_verifier.account must be an EVM address")
	}
	if isZeroAddress(verifierAccount) {
		return directDepositRefusal(DirectDepositRuleFulfillmentVerifier, "fulfillment_verifier.account must not be the zero address")
	}
	if !isUint256(stringMember(root, "max_source_amount"), true) {
		return directDepositRefusal(DirectDepositRuleMaxSourceAmount, "max_source_amount must be a positive uint256")
	}
	if !directDepositRequestID.MatchString(stringMember(root, "request_id")) {
		return directDepositRefusal(DirectDepositRuleRequestID, "request_id must be 1 to 128 characters from A-Z, a-z, 0-9, '.', '_' and '-'")
	}
	// The source and destination checks below are the context-free part of what the derivation
	// and the escrow refuse: directDeposit pulls an allowed ERC-20 from an account, and the witness
	// commits one destination of at most MAX_DESTINATION_BYTES.
	var source map[string]json.RawMessage
	if raw, ok := root["source"]; ok {
		_ = json.Unmarshal(raw, &source)
	}
	token := directDepositSourceAsset.FindStringSubmatch(stringMember(source, "asset_identifier"))
	if token == nil {
		return directDepositRefusal(DirectDepositRuleSource, "source.asset_identifier must be an ERC-20 on an EVM chain")
	}
	if isZeroAddress(token[1]) {
		return directDepositRefusal(DirectDepositRuleSource, "the source token must not be the zero address")
	}
	if !directDepositAddress.MatchString(stringMember(source, "account")) {
		return directDepositRefusal(DirectDepositRuleSource, "source.account must be an EVM address")
	}
	var destinations []json.RawMessage
	if raw, ok := root["destination"]; ok {
		_ = json.Unmarshal(raw, &destinations)
	}
	if len(destinations) != 1 {
		return directDepositRefusal(DirectDepositRuleDestination, "an originator-executed deposit names exactly one destination")
	}
	var leg map[string]json.RawMessage
	_ = json.Unmarshal(destinations[0], &leg)
	// The composed destination is asset_identifier, "@" and account; lowercasing an eip155 one does
	// not change its length. len counts bytes, as the escrow does.
	if len(stringMember(leg, "asset_identifier"))+1+len(stringMember(leg, "account")) > directDepositMaxDestinationBytes {
		return directDepositRefusal(DirectDepositRuleDestination, fmt.Sprintf("destination[0] composes to more than the escrow's %d bytes", directDepositMaxDestinationBytes))
	}
	return nil
}

func directDepositRefusal(rule, detail string) error {
	return &DirectDepositRuleError{Rule: rule, Detail: detail}
}

// stringMember returns the string value of the member with exactly this name, or "" when it is
// absent or not a string.
func stringMember(object map[string]json.RawMessage, name string) string {
	var value string
	if raw, ok := object[name]; ok {
		_ = json.Unmarshal(raw, &value)
	}
	return value
}

// isZeroAddress reports whether address, already matched as 0x and 40 hex digits, is all zeros.
func isZeroAddress(address string) bool {
	return strings.TrimLeft(address[2:], "0") == ""
}

// isUint256 reports whether value is a decimal integer within uint256, and above zero when
// positive is set. The leading zeros are stripped and the length checked first, so no
// big-integer parse runs on an arbitrarily long string.
func isUint256(value string, positive bool) bool {
	if !directDepositUint.MatchString(value) {
		return false
	}
	digits := strings.TrimLeft(value, "0")
	if len(digits) > len(maxUint256Decimal) {
		return false
	}
	n, _ := new(big.Int).SetString("0"+digits, 10)
	return n.Cmp(maxUint256) <= 0 && (!positive || n.Sign() > 0)
}
