package fulfillmentauthorization

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"

	generated "github.com/atum-labs/protocol/schemas/declarations/FulfillmentAuthorization/v1/bindings/go/generated"
	fq "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go/generated"
	fqsigning "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go/signing"
	paymentrequest "github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/generated"
	"github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/jsonmembers"
)

// refuseAmbiguousMembers refuses an embedded document whose sibling members fold to one name. The
// outer scan cannot see into these: each is carried as a JSON string, opaque to it.
func refuseAmbiguousMembers(document []byte, label string, exemptContext bool) error {
	scan := jsonmembers.FirstAmbiguousMember
	if !exemptContext {
		scan = jsonmembers.FirstAmbiguousMemberStrict
	}
	path, err := scan(document)
	if err != nil {
		return fmt.Errorf("fulfillment authorization: %s: %w", label, err)
	}
	if path != "" {
		return fmt.Errorf("fulfillment authorization: %s has ambiguous member %s: two members of one object fold to the same name", label, path)
	}
	return nil
}

// authorizedTransfer is the transfer a scheme's signed authorization lets anyone execute,
// read from what the settler signed. Every scheme reduces its authorization to this, and the
// shared rules below check it against the quote and payment request.
type authorizedTransfer struct {
	// From is the address that signed the authorization and pays the transfer.
	From string
	To   string
	// Value is the amount in the asset's base units.
	Value *big.Int
	// Asset is the CAIP-19 identifier of the token the authorization moves.
	Asset string
	// Nonce is the authorization's nonce, which the scheme binds to the quote hash.
	Nonce string
	// NotBefore is the earliest unix second the authorization is usable, or nil when the
	// scheme has no lower bound.
	NotBefore *big.Int
	// Expiry is the scheme's own expiry field as signed, in unix seconds: EIP-3009's
	// validBefore. A scheme without one cannot be bounded by the fulfillment deadline and
	// must not be added here.
	Expiry *big.Int
	// verifySignature, when set, is the part of proving the signature that needs the chain. The
	// parser leaves it for after every offline rule has passed, so a document that fails one of
	// those costs no chain read, and an account the quote does not name is never asked about.
	verifySignature func() error
}

// schemeParsers read a scheme's signed authorization into the transfer it authorizes. A
// parser also proves the authorization is what was signed: the signed message must be the
// scheme's digest of the readable form, and the signature must recover to its signer. It is
// handed the quote's destination asset (CAIP-19) so it can bind whatever its signing domain
// names to the token the authorization is for, by the field names the settler signed; the
// shared rules then compare the asset it reports as a whole.
// A new scheme (Permit2, CORE-2709) adds an entry here and reports its own expiry field as
// Expiry; the shared rules then bound it by the fulfillment deadline.
var schemeParsers = map[string]func(generated.SignedMessage, map[string]json.RawMessage, string, options) (authorizedTransfer, error){
	schemeEIP3009: parseEIP3009,
}

// ErrSchemeNotImplemented is wrapped by the error Validate and ValidateWithChain return when the
// document names a scheme the schema lists and no validator here implements (SOROBAN-AUTH today).
//
// It is NOT a pass, and it does not mean the document is acceptable. When it comes back only the
// schema and the parsing of the embedded quote and payment request have run. None of the binding
// rules ran (expiry, signer, amount, asset, recipient, nonce) and neither did the signature check,
// so a caller that defers to a scheme-specific verifier must run every one of those itself, in
// that verifier, before it accepts the document.
//
// A caller that must tell "not implemented" from "malformed" matches it with errors.Is, never on
// the message. A scheme the schema does not list is refused by the schema, before this, and does
// not wrap it.
var ErrSchemeNotImplemented = errors.New("not implemented")

func validateRules(jsonData []byte, opts options) error {
	var doc generated.SchemaJson
	if err := json.Unmarshal(jsonData, &doc); err != nil {
		return fmt.Errorf("failed to unmarshal fulfillment authorization: %w", err)
	}

	if err := refuseAmbiguousMembers([]byte(doc.FulfillmentQuoteJson), "fulfillment_quote_json", true); err != nil {
		return err
	}
	var quote fq.SchemaJson
	if err := json.Unmarshal([]byte(doc.FulfillmentQuoteJson), &quote); err != nil {
		return fmt.Errorf("fulfillment authorization: failed to unmarshal fulfillment_quote_json: %w", err)
	}

	if err := refuseAmbiguousMembers([]byte(quote.PaymentRequestJson), "payment_request_json", true); err != nil {
		return err
	}
	var paymentRequest paymentrequest.SchemaJson
	if err := json.Unmarshal([]byte(quote.PaymentRequestJson), &paymentRequest); err != nil {
		return fmt.Errorf("fulfillment authorization: failed to unmarshal payment_request_json: %w", err)
	}

	parse, ok := schemeParsers[string(doc.Scheme)]
	if !ok {
		return fmt.Errorf("fulfillment authorization: scheme %q is %w", doc.Scheme, ErrSchemeNotImplemented)
	}
	// The raw members too: the typed SignedMessage drops anything the scheme does not name, so
	// only these bytes can show a member the signature does not cover.
	rawAuthorization, err := rawAuthorizationMembers(jsonData)
	if err != nil {
		return err
	}
	transfer, err := parse(doc.Authorization, rawAuthorization, quote.Destination.Id, opts)
	if err != nil {
		return fmt.Errorf("fulfillment authorization: %w", err)
	}
	// fulfillment_quote_json stays the original string so the quote hash uses those bytes.
	if err := validateTransfer(transfer, &quote, &paymentRequest, []byte(doc.FulfillmentQuoteJson)); err != nil {
		return err
	}
	if transfer.verifySignature != nil {
		if err := transfer.verifySignature(); err != nil {
			return fmt.Errorf("fulfillment authorization: %w", err)
		}
	}
	return nil
}

// validateTransfer applies the rules every scheme shares.
func validateTransfer(transfer authorizedTransfer, quote *fq.SchemaJson, paymentRequest *paymentrequest.SchemaJson, quoteJSON []byte) error {
	if err := validateExpiry(transfer, paymentRequest); err != nil {
		return err
	}
	if !sameAccount(transfer.From, quote.SettlerAddress) {
		return fmt.Errorf("fulfillment authorization: signer %s does not equal settler_address %s", transfer.From, quote.SettlerAddress)
	}
	amount, ok := parseUint256(paymentRequest.FulfillmentAmount)
	if !ok || transfer.Value.Cmp(amount) != 0 {
		return fmt.Errorf("fulfillment authorization: amount %s does not equal fulfillment_amount %s", transfer.Value, paymentRequest.FulfillmentAmount)
	}
	if !sameAsset(transfer.Asset, quote.Destination.Id) {
		return fmt.Errorf("fulfillment authorization: asset %s does not equal quote destination %s", transfer.Asset, quote.Destination.Id)
	}

	matched := false
	for _, dest := range paymentRequest.Destination {
		if sameAccount(transfer.To, dest.Account) && sameAsset(transfer.Asset, dest.AssetIdentifier) {
			matched = true
			break
		}
	}
	if !matched {
		return fmt.Errorf("fulfillment authorization: recipient %s does not equal a payment request destination for asset %s", transfer.To, transfer.Asset)
	}

	quoteHash, err := fqsigning.ComputeQuoteHash(quoteJSON)
	if err != nil {
		return fmt.Errorf("fulfillment authorization: quote hash: %w", err)
	}
	if !strings.EqualFold(transfer.Nonce, quoteHash) {
		return fmt.Errorf("fulfillment authorization: nonce %s does not equal quote hash %s", transfer.Nonce, quoteHash)
	}
	return nil
}

// validateExpiry requires the authorization to expire exactly at the payment request's
// fulfillment deadline, in whole unix seconds (the deadline's fraction is dropped, as the
// settler and the destination contract both do). Later would let the originator move the
// settler's funds after the deadline, when the escrow can already refund the sender. Earlier
// would cut short the window the originator was promised to fulfill in.
func validateExpiry(transfer authorizedTransfer, paymentRequest *paymentrequest.SchemaJson) error {
	if transfer.NotBefore != nil && transfer.NotBefore.Cmp(transfer.Expiry) >= 0 {
		return fmt.Errorf("fulfillment authorization: not-before %s is not earlier than expiry %s, so the authorization is never usable", transfer.NotBefore, transfer.Expiry)
	}
	deadline := big.NewInt(paymentRequest.FulfillmentDeadline.Unix())
	switch transfer.Expiry.Cmp(deadline) {
	case 1:
		return fmt.Errorf("fulfillment authorization: expiry %s is after the fulfillment deadline %s (%s)", transfer.Expiry, deadline, paymentRequest.FulfillmentDeadline.UTC().Format("2006-01-02T15:04:05.999Z07:00"))
	case -1:
		return fmt.Errorf("fulfillment authorization: expiry %s is before the fulfillment deadline %s (%s); it must equal it", transfer.Expiry, deadline, paymentRequest.FulfillmentDeadline.UTC().Format("2006-01-02T15:04:05.999Z07:00"))
	}
	return nil
}

func sameAccount(a, b string) bool {
	return strings.EqualFold(trimASCIISpace(a), trimASCIISpace(b))
}

// sameAsset compares CAIP-19 identifiers, and the CAIP-2 chain identifiers that start them, whole:
// trimmed and case folded. EVM addresses inside them may be checksummed or not, and an eip155
// reference is decimal, so folding it changes nothing. A chain whose reference is case sensitive
// would need its own comparison.
func sameAsset(a, b string) bool {
	return strings.EqualFold(trimASCIISpace(a), trimASCIISpace(b))
}

// trimASCIISpace trims the four ASCII whitespace characters and nothing else. strings.TrimSpace
// also strips U+0085 and U+00A0 and keeps U+FEFF, while JavaScript's trim() keeps U+0085 and
// strips U+FEFF; the same bytes would then pass in one language and be refused in the other. The
// TypeScript binding's trimASCIISpace trims exactly this set.
func trimASCIISpace(s string) string {
	return strings.Trim(s, " \t\n\r")
}

// rawAuthorizationMembers returns the authorization object's members as they were written.
func rawAuthorizationMembers(jsonData []byte) (map[string]json.RawMessage, error) {
	var document map[string]json.RawMessage
	if err := json.Unmarshal(jsonData, &document); err != nil {
		return nil, fmt.Errorf("fulfillment authorization: %w", err)
	}
	var members map[string]json.RawMessage
	if err := json.Unmarshal(document["authorization"], &members); err != nil {
		return nil, fmt.Errorf("fulfillment authorization: authorization: %w", err)
	}
	return members, nil
}
