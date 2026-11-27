package paymentrequest

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/jsonmembers"
)

// ErrUnsupportedOriginatorDestination marks every refusal from the originator-fulfill destination
// rule. It is what separates this refusal from any other validation failure, so a caller can act
// on it without matching on message text.
//
// payment-gw SHOULD answer errors.Is(err, paymentrequest.ErrUnsupportedOriginatorDestination)
// with the UNSUPPORTED_DESTINATION_ASSET API error and leave every other Validate failure as a
// malformed body. It does not yet: all three endpoints that call Validate answer any failure with
// MALFORMED_REQUEST_BODY, and Validate runs ahead of their assetSupported check, so until that
// mapping lands with the atum-core go.mod bump this refusal also pre-empts the
// UNSUPPORTED_DESTINATION_ASSET those endpoints already return for an unlisted token.
var ErrUnsupportedOriginatorDestination = errors.New("originator fulfill requires a destination token that implements EIP-3009 transferWithAuthorization")

// UnsupportedDestinationAssetError is the refusal itself, naming the leg that caused it. Callers
// that only need to branch should use errors.Is against
// ErrUnsupportedOriginatorDestination, which this unwraps to; callers that want to log or echo
// the offending leg reach for the fields with errors.As.
type UnsupportedDestinationAssetError struct {
	// AssetIdentifier is the CAIP-19 identifier of the destination that was refused.
	AssetIdentifier string
	// Chain is that destination's CAIP-2 chain ID, split out because consumers tag metrics and
	// logs by chain. It is empty when the identifier could not be read.
	Chain string
}

func (e *UnsupportedDestinationAssetError) Error() string {
	return fmt.Sprintf("destination asset %q does not support EIP-3009 transferWithAuthorization, which originator fulfill requires", e.AssetIdentifier)
}

// Unwrap reports the sentinel, so errors.Is matches this refusal wherever it is wrapped.
func (e *UnsupportedDestinationAssetError) Unwrap() error { return ErrUnsupportedOriginatorDestination }

// ValidateRules applies the PaymentRequest checks that live above the JSON Schema: the schema
// fixes the shape of a request, these decide whether the request can actually be settled as
// written. Validate runs them, so a caller needs this only when it has already validated the
// shape and does not want to pay for that again.
//
// Two rules: the originator-fulfill destination check below, then the originator-executed deposit
// rules (validateDirectDeposit).
//
// Only the members a rule reads are decoded, rather than the generated SchemaJson: whether the
// other members are present and well-formed is the schema's question, and answering it a second
// time here would make the rules refuse documents for reasons that are not theirs — and would
// diverge from the TypeScript binding, which reads the same members (ruleMembers) off the document.
func ValidateRules(jsonData []byte) error {
	// The scan comes before the decode, not after. encoding/json folds member names and keeps the
	// last match, so `{"executor":"originator","Executor":"settler"}` decodes here as settler and
	// the rule below never runs — while JSON.parse keeps both spellings and the TypeScript binding
	// reads originator and refuses. The same bytes would mean different payments to the two
	// readers, which is exactly what these bindings exist to prevent, so such a document is
	// refused outright.
	//
	// Only the root member names and the values of the members this reader acts on are inspected:
	// a twin inside a part of the document carried for someone else is not this reader's to refuse.
	// The "@context" exemption is kept, because a PaymentRequest carries JSON-LD whose contexts
	// legitimately define terms differing only in case.
	if path, err := jsonmembers.FirstAmbiguousMemberIn(jsonData, ruleMembers); err != nil {
		return fmt.Errorf("failed to read payment request: %w", err)
	} else if path != "" {
		return fmt.Errorf("payment request has ambiguous member %s: two members of one object fold to the same name", path)
	}

	// Members are looked up by their exact names, as the TypeScript binding does, rather than
	// through encoding/json's case-folding struct decode: a lone "Executor" is not the executor in
	// either language.
	var root map[string]json.RawMessage
	if err := json.Unmarshal(jsonData, &root); err != nil {
		return fmt.Errorf("failed to unmarshal payment request: %w", err)
	}
	var doc ruleDocument
	if err := doc.read(root); err != nil {
		return fmt.Errorf("failed to unmarshal payment request: %w", err)
	}
	// The destination rule runs first, so a request it refuses is reported the same way whatever
	// else is wrong with it.
	if err := validateOriginatorFulfillDestinations(&doc); err != nil {
		return err
	}
	return validateDirectDeposit(doc.Executor, root)
}

// ruleMembers are the root members the rules below read, and so the ones whose values the
// ambiguous-member scan inspects. It must list every member ruleDocument.read decodes and every
// member validateDirectDeposit reads. sender_auth is read only for its presence, and a twin of a root
// name is refused whatever the member, so its value is left to the readers that act on it.
var ruleMembers = append([]string{"executor", "destination"}, directDepositMembers...)

// ruleDocument is the slice of a PaymentRequest the rules below read.
type ruleDocument struct {
	Executor    any
	Destination []struct {
		AssetIdentifier string `json:"asset_identifier"`
	}
}

// read decodes the members the rules read from the root members with exactly those names.
func (d *ruleDocument) read(root map[string]json.RawMessage) error {
	if raw, ok := root["executor"]; ok {
		if err := json.Unmarshal(raw, &d.Executor); err != nil {
			return err
		}
	}
	if raw, ok := root["destination"]; ok {
		if err := json.Unmarshal(raw, &d.Destination); err != nil {
			return err
		}
	}
	return nil
}

// validateOriginatorFulfillDestinations refuses an originator-fulfilled payment whose destination
// token cannot take one. Originator fulfill is delivered with an EIP-3009
// transferWithAuthorization signed on the destination token, so a token that does not implement
// it can never be delivered that way: the settler declines every quote, and the payer learns
// nothing until the deadline burns. Deciding it here means every consumer of these bindings —
// the settler before it bids, the gateways at ingress, a client before it calls anything —
// refuses the same request for the same reason (CORE-2776).
//
// Every destination is checked, not just the first: the executor applies to the whole request, so
// one unlisted leg is enough to make the payment undeliverable. Destinations are checked in the
// order they appear, so the error names the first unlisted leg.
//
// Settler-fulfilled requests are not checked at all, and neither is a request that names no
// executor, which means settler. The settler's own checks still decide whether funds move; this
// only stops a request that cannot succeed from being accepted in the first place.
func validateOriginatorFulfillDestinations(doc *ruleDocument) error {
	if !FulfillsAsOriginator(doc.Executor) {
		return nil
	}
	for _, destination := range doc.Destination {
		asset, ok := parseAssetIdentifier(destination.AssetIdentifier)
		// An identifier this cannot read is refused rather than skipped. The schema's CAIP-19
		// pattern means Validate never reaches that, so it only arises when a caller runs the
		// rules against an unvalidated document — where admitting an unreadable destination
		// would be the one outcome this rule exists to prevent.
		if !ok || !deliverableByEIP3009(asset) {
			return &UnsupportedDestinationAssetError{
				AssetIdentifier: destination.AssetIdentifier,
				Chain:           asset.Chain,
			}
		}
	}
	return nil
}

// deliverableByEIP3009 reports whether an EIP-3009 transferWithAuthorization can actually move
// this asset. Being on the list is necessary but not sufficient, because the list is keyed by
// chain and contract address alone:
//
//   - The namespace must be erc20. transferWithAuthorization is an ERC-20 extension, so the same
//     address under another namespace — eip155:8453/erc721:<a listed address> — names a different
//     kind of asset that no EIP-3009 transfer can deliver, and a namespace the registry has never
//     heard of names nothing at all.
//   - A CAIP-19 token ID must be absent. transferWithAuthorization moves a fungible value, so a
//     document that names one token of a collection is refused rather than silently delivered as
//     if the suffix had not been written.
func deliverableByEIP3009(asset assetIdentifier) bool {
	return asset.Namespace == erc20Namespace &&
		asset.TokenID == "" &&
		SupportsEIP3009(asset.Chain, asset.Reference)
}

// erc20Namespace is the only CAIP-19 asset namespace EIP-3009 applies to.
const erc20Namespace = "erc20"

// assetIdentifier is a parsed CAIP-19 asset identifier,
// "{chain}/{namespace}:{reference}" with an optional "/{token-id}".
type assetIdentifier struct {
	// Chain is the CAIP-2 chain ID, for example "eip155:1".
	Chain string
	// Namespace is the asset namespace, for example "erc20".
	Namespace string
	// Reference is the asset reference, for a token its contract address.
	Reference string
	// TokenID is the token ID CAIP-19 allows on a non-fungible asset, empty when absent. It is
	// reported rather than dropped, so a caller decides what naming one token of a collection
	// means instead of silently reading it as the whole contract.
	TokenID string
}

// parseAssetIdentifier splits a CAIP-19 asset identifier into its parts:
// "eip155:1/erc20:0xA0b8…" yields chain "eip155:1", namespace "erc20" and reference "0xA0b8…".
func parseAssetIdentifier(raw string) (assetIdentifier, bool) {
	chain, assetPart, found := strings.Cut(raw, "/")
	if !found || chain == "" {
		return assetIdentifier{}, false
	}
	namespace, reference, found := strings.Cut(assetPart, ":")
	if !found || namespace == "" || reference == "" {
		return assetIdentifier{}, false
	}
	reference, tokenID, _ := strings.Cut(reference, "/")
	if reference == "" {
		return assetIdentifier{}, false
	}
	return assetIdentifier{
		Chain:     chain,
		Namespace: namespace,
		Reference: reference,
		TokenID:   tokenID,
	}, true
}
