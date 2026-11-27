package senderauth

import (
	"encoding/json"
	"fmt"
	"strings"
)

// VerifyExpectations is what a verifier binds a recovered sender_auth to. Alias of
// Expectations, mirroring the TS VerifyExpectations name.
type VerifyExpectations = Expectations

// VerifyPaymentRequestExpectations are the expectations VerifyPaymentRequest takes. The
// embedded Expectations carries the scheme fields (escrow / roles / svm / nowSec). The two
// override fields (plus the embedded MaxSourceAmount) let a caller bind the recovered permit
// against its OWN agreed terms rather than the request's self-reported ones — see the
// binding note on VerifyPaymentRequest. Mirrors TS VerifyPaymentRequestExpectations.
type VerifyPaymentRequestExpectations struct {
	// Expectations carries the scheme fields. Its MaxSourceAmount, when non-empty, is the
	// authoritative amount bound against; empty means fall back to the request's
	// max_source_amount (self-consistency only).
	Expectations
	// SourceAsset, when non-empty, is the authoritative bare token address bound against;
	// empty falls back to the request's own source asset (self-consistency only).
	SourceAsset string
	// Network, when non-empty, is the authoritative CAIP-2 network; empty is parsed from the
	// request's source.
	Network string
	// DepositRequestHashV2Mode is how VerifyPaymentRequestJSON reads depositRequestHash v2, as
	// WithDepositRequestHashV2 does for VerifyRequestCommitment. The zero value is off. It does not
	// read retire, which it refuses as verifier_misconfigured: judge a deposit in retire mode with
	// VerifyRequestCommitment. VerifyPaymentRequest accepts only v1 and refuses any other value as
	// verifier_misconfigured.
	DepositRequestHashV2Mode DepositRequestHashV2Mode `json:"depositRequestHashV2Mode,omitempty"`
}

// VerifyResult is the outcome of VerifyPaymentRequest.
type VerifyResult struct {
	// Results has one entry per sender_auth.signed_messages[], in order: the signed terms
	// plus the parsed permit.
	Results []VerifiedSenderAuth
	// RecoveredAccount is the source.account every signature was verified to recover to. On Stellar the
	// signature is by that account's own key as its delegate (a separate delegate is refused as
	// ErrDelegateUnverified), but consent is still established only by the on-chain delegate
	// registration (ParsedPermit.DelegateSigner and DelegateOnchainUnverified), never by this field.
	RecoveredAccount string
	// Commitment is the commitment check's result, once VerifyPaymentRequestJSON is opted in with
	// VerifyPaymentRequestExpectations.DepositRequestHashV2Mode: the version the deposit matched and,
	// in audit mode, StrictDetail. The zero value otherwise.
	Commitment CommitmentResult `json:",omitzero"`
}

// VerifyPaymentRequestJSON is VerifyPaymentRequest over the request exactly as received. Decoding
// into PaymentRequest matches member names regardless of letter case, so a verifier that holds the
// request bytes uses this: it refuses member names ambiguous in what it reads and reads every field
// by exact name. It reads only the fields it verifies; validating the rest against the schema is
// the caller's.
//
// expected.DepositRequestHashV2Mode opts it into depositRequestHash v2: the commitment is checked once,
// over the request as received, as VerifyRequestCommitment does with WithDepositRequestHashV2, and
// every signed message is then recovered against the same v1 or v2 candidate. Without it, it is
// exactly as before v2.
func VerifyPaymentRequestJSON(request []byte, expected VerifyPaymentRequestExpectations) (VerifyResult, error) {
	doc, signed, commitment, _, err := readRequest(request)
	if err != nil {
		return VerifyResult{}, err
	}
	optedIn := expected.DepositRequestHashV2Mode != DepositRequestHashV2Off
	strictDetail, err := readDepositRequestHashV2(request, expected.DepositRequestHashV2Mode, &commitment)
	if err != nil {
		return VerifyResult{}, err
	}
	checked, err := auditFallback(strictDetail)(verifyCommitment(signed, commitment, solanaDomainOf(expected.Expectations), stellarOptionsOf(expected.Expectations)...))
	if err != nil {
		return VerifyResult{}, err
	}
	decoded := PaymentRequest{
		Source:      OwnedAsset{AssetIdentifier: signed.SourceAssetIdentifier, Account: signed.SourceAccount},
		Destination: make([]OwnedAsset, 0, len(commitment.Destinations)),
		RequestId:   commitment.RequestID,
		SenderAuth:  &SenderAuth{MessageScheme: SenderAuthMessageScheme(signed.MessageScheme)},
	}
	if amount, present := doc["max_source_amount"]; present && amount != nil {
		text, ok := amount.(string)
		if !ok {
			return VerifyResult{}, fmt.Errorf("sender_auth: the payment request does not decode: max_source_amount is not a string")
		}
		decoded.MaxSourceAmount = &text
	}
	for _, leg := range commitment.Destinations {
		decoded.Destination = append(decoded.Destination, OwnedAsset{AssetIdentifier: leg.AssetIdentifier, Account: leg.Account})
	}
	for _, m := range signed.SignedMessages {
		var prehash string
		if m.MessagePrehash != nil {
			prehash = *m.MessagePrehash
		}
		decoded.SenderAuth.SignedMessages = append(decoded.SenderAuth.SignedMessages, SignedMessage{
			Message: m.Message, Signature: m.Signature, MessagePrehash: prehash, Payload: m.Payload,
		})
	}
	if optedIn {
		// The commitment was checked over the bytes as received; decoded carries too few members
		// to derive v2 again.
		res, err := recoverAndVerifyEach(decoded, expected, commitment)
		if err != nil {
			return VerifyResult{}, err
		}
		res.Commitment = checked
		return res, nil
	}
	return verifyPaymentRequest(decoded, expected)
}

// VerifyPaymentRequest is the chain-agnostic sender_auth verifier over a decoded PaymentRequest.
// It checks the struct it is given: decoding keeps one value for member names that repeat or
// differ only in letter case, so a verifier holding the request bytes uses
// VerifyPaymentRequestJSON, and a verifier that forwards the request forwards this same struct.
// It first runs the commitment check over the request, so the deposit must commit to the
// request's own destination and request_id. Then, for each signed message, it recovers the signer
// via the source chain's adapter and requires it to be source.account, binds the signed terms to
// expected (token + amount + freshness always; the escrow/roles fail-fast only when supplied), and
// returns the parsed permits. Recovering the signer refuses a contract-account payer (ERC-1271, such
// as a Safe), whose signature comes from an owner key; verify its payee with
// VerifyRequestCommitment.
//
// Strict, all-bindable: every entry in signed_messages[] must be a bindable permit; any
// unbindable or malformed one (e.g. ErrMalformedPrehash) fails the whole request. A consumer
// with mixed messages (e.g. an EVM setup approval alongside the permit) composes RecoverSigner
// (recover-only) with RecoverAndVerify itself instead.
//
// Binding note (read if you did NOT author the request): by default token, network, and
// amount are taken from the request itself, so a successful result only proves the signatures
// are self-consistent with the request's own stated fields. To bind against your agreed
// terms, set SourceAsset / Network / MaxSourceAmount on expected; when set, each is used
// instead of the request-sourced value.
//
// This is the sender_auth layer only. Request-shape (deadline ordering) and per-consumer
// policy (budget caps, replay horizons, settlement-routing equality) are the caller's job,
// layered on top of the returned results. Mirrors TS verifyPaymentRequest.
//
// Deprecated: decoding into PaymentRequest keeps one value for member names that repeat or differ
// only in letter case, so it checks a copy of the request rather than the bytes received, and it
// accepts only depositRequestHash v1: a non-empty expected.DepositRequestHashV2Mode is refused as
// verifier_misconfigured. Use VerifyPaymentRequestJSON with the request as received.
func VerifyPaymentRequest(request PaymentRequest, expected VerifyPaymentRequestExpectations) (VerifyResult, error) {
	if expected.DepositRequestHashV2Mode != DepositRequestHashV2Off {
		_, err := refuse(CommitmentResult{}, OutcomeVerifierMisconfigured,
			"VerifyPaymentRequest accepts only depositRequestHash v1; use VerifyPaymentRequestJSON for depositRequestHashV2")
		return VerifyResult{}, err
	}
	return verifyPaymentRequest(request, expected)
}

// verifyPaymentRequest is VerifyPaymentRequest, for VerifyPaymentRequestJSON's unopted path.
func verifyPaymentRequest(request PaymentRequest, expected VerifyPaymentRequestExpectations) (VerifyResult, error) {
	if request.SenderAuth == nil || len(request.SenderAuth.SignedMessages) == 0 {
		return VerifyResult{}, fmt.Errorf("sender_auth: request has no signed_messages to verify")
	}
	// The payee check runs first, on the request as serialized: every field is read by exact name,
	// the same way VerifyRequestCommitment reads a request as received.
	if request.Destination == nil {
		request.Destination = []OwnedAsset{} // a nil list is empty, not JSON null
	}
	raw, err := json.Marshal(request)
	if err != nil {
		return VerifyResult{}, fmt.Errorf("sender_auth: request cannot be serialized: %w", err)
	}
	if _, err := VerifyRequestCommitment(raw, solanaDomainOf(expected.Expectations), stellarOptionsOf(expected.Expectations)...); err != nil {
		return VerifyResult{}, err
	}
	commitment := CommitmentExpectation{RequestID: request.RequestId}
	for _, leg := range request.Destination {
		commitment.Destinations = append(commitment.Destinations, DestinationLeg{AssetIdentifier: leg.AssetIdentifier, Account: leg.Account})
	}
	return recoverAndVerifyEach(request, expected, commitment)
}

// recoverAndVerifyEach is VerifyPaymentRequest after the commitment check: it recovers and binds
// every signed message, each against commitment.
func recoverAndVerifyEach(request PaymentRequest, expected VerifyPaymentRequestExpectations, commitment CommitmentExpectation) (VerifyResult, error) {
	inputs := make([]SignedMessageInput, 0, len(request.SenderAuth.SignedMessages))
	for _, m := range request.SenderAuth.SignedMessages {
		inputs = append(inputs, signedMessageInput(m))
	}

	// Parse the request's source asset up-front; assetAddress returns a clean error for a
	// malformed asset_identifier.
	requestNetwork := strings.SplitN(request.Source.AssetIdentifier, "/", 2)[0]
	requestAsset, err := assetAddress(request.Source.AssetIdentifier)
	if err != nil {
		return VerifyResult{}, err
	}

	network := requestNetwork
	if expected.Network != "" {
		network = expected.Network
	}
	asset := requestAsset
	if expected.SourceAsset != "" {
		asset = expected.SourceAsset
	}
	source := SourceRef{Network: network, Asset: asset, Account: request.Source.Account}

	adapter, err := GetChainAdapter(network)
	if err != nil {
		return VerifyResult{}, err
	}

	// The always-checked max_source_amount: caller-authoritative when set, else derived from
	// the request (TS: `?? "0"`). A quote source amount replaces it, so the request's is not read.
	perMessage := expected.Expectations
	if perMessage.MaxSourceAmount == "" && perMessage.QuoteSourceAmount == "" {
		perMessage.MaxSourceAmount = "0"
		if request.MaxSourceAmount != nil {
			perMessage.MaxSourceAmount = *request.MaxSourceAmount
		}
	}

	results := make([]VerifiedSenderAuth, 0, len(inputs))
	for _, m := range inputs {
		r, err := adapter.RecoverAndVerify(m, source, commitment, perMessage)
		if err != nil {
			return VerifyResult{}, err
		}
		results = append(results, r)
	}

	return VerifyResult{Results: results, RecoveredAccount: source.Account}, nil
}

// stellarOptionsOf is the Stellar escrow the expectations configure, as a commitment option: their own
// EscrowContract. Empty when they carry none, so a non-Stellar check is exactly as before.
func stellarOptionsOf(expected Expectations) []CommitmentOption {
	if expected.EscrowContract == "" {
		return nil
	}
	return []CommitmentOption{WithStellarEscrow(expected.EscrowContract)}
}

// solanaDomainOf is the Solana escrow domain the expectations configure, or nil when they carry
// none (VerifyCommitment then refuses a Solana payment as verifier_misconfigured).
func solanaDomainOf(expected Expectations) *SolanaDomain {
	if expected.SvmSignatureDomainVersion == nil {
		return nil
	}
	return &SolanaDomain{
		EscrowProgramID: expected.EscrowContract,
		ClusterID:       expected.SvmSignatureClusterID,
		DomainVersion:   *expected.SvmSignatureDomainVersion,
	}
}

// signedMessageInput maps a wire SignedMessage (from the generated PaymentRequest bindings)
// into the binding-agnostic SignedMessageInput the adapters consume. Callers holding a
// different bindings copy write the equivalent mapping from their own type.
func signedMessageInput(m SignedMessage) SignedMessageInput {
	return SignedMessageInput{
		Message:        m.Message,
		Signature:      m.Signature,
		MessagePrehash: &m.MessagePrehash,
		Payload:        m.Payload,
	}
}
