// Package senderauth is the Go half of @atum-labs/payment-request-sender-auth.
//
// It builds, signs, and recovers-and-verifies the sender_auth signed messages for the
// supported source-chain families (EVM Permit2, Tron TIP-712, and Solana ed25519). It mirrors
// the TypeScript SDK, and the conformance vectors in v1/conformance/sender-auth-vectors.json
// pin byte parity between the two (see conformance_test.go).
//
// # Type reuse
//
// The wire types come from the generated PaymentRequest Go bindings and the Solana deposit
// prehash from the svm escrow-encoding lib. They are aliased here, not copied:
//
//   - PaymentRequest, SenderAuth, SignedMessage, OwnedAsset, SenderAuthMessageScheme
//     -> github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/generated
//   - SolanaDepositPrehash -> github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/svm/bindings/go/escrow-encoding/encoding
//
// Only types that exist nowhere else are declared below.
package senderauth

import (
	"fmt"
	"math/big"
	"strings"

	svm "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/svm/bindings/go/escrow-encoding/encoding"
	paymentrequest "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/generated"
)

// Reused wire types from the generated PaymentRequest bindings. Aliased (not
// redeclared) so a value produced against the bindings is the exact same type here.
type (
	// PaymentRequest is the canonical PaymentRequest wire document.
	PaymentRequest = paymentrequest.SchemaJson
	// SenderAuth is the request's sender_auth block.
	SenderAuth = paymentrequest.SenderAuth
	// SignedMessage is a single entry of sender_auth.signed_messages[].
	SignedMessage = paymentrequest.SignedMessage
	// OwnedAsset is the CAIP-19 asset + owning account used by source/destination.
	OwnedAsset = paymentrequest.OwnedAsset
	// SenderAuthMessageScheme is the sender_auth message-scheme enum.
	SenderAuthMessageScheme = paymentrequest.SenderAuthMessageScheme
)

// SignedMessageInput is the binding-agnostic verify input: the fields the adapters read from a
// sender_auth.signed_messages[] entry. It is decoupled from the generated bindings so a consumer
// holding its own copy of the bindings can build it from its SignedMessage in a few lines. Field
// names and JSON tags match the wire SignedMessage. Mirrors the TS `SignedMessageInput`.
type SignedMessageInput struct {
	Message        string                 `json:"message"`
	Signature      string                 `json:"signature"`
	MessagePrehash *string                `json:"message_prehash,omitempty"`
	Payload        map[string]interface{} `json:"payload,omitempty"`
	// SvmMessageScheme is SDK-local and never on the wire: the Solana escrow's svm message scheme,
	// set only by a caller that knows it. "" (the default) signs the raw 32 byte hash;
	// "escrow-text-v1" signs the escrow text. Other chains ignore it.
	SvmMessageScheme string `json:"-"`
}

// Reused Solana deposit prehash from the svm escrow-encoding lib (snake_case wire
// keys: payment_id, depositor, mint, amount, reserver, releaser, nonce, issued_at,
// deadline). Aliased, not redeclared.
type SolanaDepositPrehash = svm.SolanaDepositPrehash

// ChainDefaults are the source-chain defaults (escrow contract, quote selector,
// verifier, etc.) that the sender-auth layer consumes to build and to
// rebuild-and-verify the canonical signed message. Mirrors the TS ChainDefaults.
type ChainDefaults struct {
	EscrowContract              string `json:"escrowContract"`
	QuoteSelector               string `json:"quoteSelector"`
	FulfillmentVerifierAccount  string `json:"fulfillmentVerifierAccount"`
	FulfillmentVerifierEndpoint string `json:"fulfillmentVerifierEndpoint"`
	FulfillmentProxy            string `json:"fulfillmentProxy"`
	Permit2Contract             string `json:"permit2Contract,omitempty"`
	// SvmSignatureClusterID and SvmSignatureDomainVersion are the Solana escrow
	// domain-separation fields; absent for EVM/Tron.
	SvmSignatureClusterID     string `json:"svmSignatureClusterId,omitempty"`
	SvmSignatureDomainVersion *int   `json:"svmSignatureDomainVersion,omitempty"`
}

// Expectations is what a verifier binds a recovered sender_auth against. Mirrors the TS
// VerifyExpectations interface. The destination commitment is not here: RecoverAndVerify takes it as
// its own required argument.
//
//   - MaxSourceAmount is always checked (the permit amount must equal it), or QuoteSourceAmount
//     instead when set.
//   - EscrowContract / Reserver / Releaser bind the atum-escrow roles when supplied: spender ==
//     escrow (EVM/Tron) and the witness roles.
//   - On Solana, EscrowContract + the Svm* fields are additionally REQUIRED for the crypto (the
//     deposit-hash domain).
//   - On Stellar, EscrowContract, Reserver and Releaser are all REQUIRED: the escrow is part of the
//     signed digest, and the reserver and releaser are free members of the signed record, so a
//     verifier that does not pin them would admit a deposit whose releaser the requester controls.
//     A verifier that omits one is refused as verifier_misconfigured.
type Expectations struct {
	// MaxSourceAmount is the required amount the permit must authorize (decimal string).
	MaxSourceAmount string `json:"maxSourceAmount"`
	// QuoteSourceAmount, when non-empty, replaces MaxSourceAmount for a deposit that pays a chosen
	// quote: the permit must authorize exactly the quote's source_amount, a decimal string above
	// zero. MaxSourceAmount must then be empty, or the verifier is misconfigured.
	QuoteSourceAmount string `json:"quoteSourceAmount,omitempty"`
	// EscrowContract, when non-empty, enables the spender==escrow check (EVM/Tron) and supplies the
	// escrow program id for the Solana deposit-hash domain.
	EscrowContract string `json:"escrowContract,omitempty"`
	// Reserver / Releaser, when both non-empty, enable the witness-role check.
	Reserver string `json:"reserver,omitempty"`
	Releaser string `json:"releaser,omitempty"`
	// Permit2Contract is the Permit2 the deployed escrow uses, for chains that do not run the
	// canonical address (EVM) or the pinned one (Tron). It is the EIP-712 verifying contract, so it
	// comes from the verifier's own configuration, never from message_prehash.
	Permit2Contract string `json:"permit2Contract,omitempty"`
	// SvmSignatureClusterID / SvmSignatureDomainVersion are the Solana escrow domain-separation
	// fields; required on Solana, absent for EVM/Tron.
	SvmSignatureClusterID     string `json:"svmSignatureClusterId,omitempty"`
	SvmSignatureDomainVersion *int   `json:"svmSignatureDomainVersion,omitempty"`
	// SvmMessageScheme is the Solana escrow's svm message scheme, from the registry's svmMessage
	// for the escrow. "" (the default) is the raw hash; see SolanaDomain.MessageScheme.
	SvmMessageScheme string `json:"svmMessageScheme,omitempty"`
	// NowSec, when non-nil, pins the verify-time clock the EVM/Tron freshness check compares
	// against (unix seconds). Production verifiers leave it nil (real clock).
	NowSec *int `json:"nowSec,omitempty"`
}

// AuthMessageResult is the result of building a sender_auth message.
type AuthMessageResult struct {
	MessageScheme  SenderAuthMessageScheme
	MessageHash    string
	MessagePrehash string
}

// AuthTerms are the signed terms recovered from a verified sender_auth message.
type AuthTerms struct {
	// Amount is atomic units, decimal string.
	Amount string `json:"amount"`
	// DeadlineSec is Unix seconds.
	DeadlineSec int `json:"deadlineSec"`
}

// ParsedPermit is the recovered + parsed permit, returned so a consumer can run its own
// scheme/policy checks (e.g. against a challenge) without re-parsing message_prehash.
// Mirrors the TS ParsedPermit interface.
type ParsedPermit struct {
	Scheme SenderAuthMessageScheme `json:"scheme"`
	// Token is the permit token (EVM/Tron) or mint (Solana).
	Token       string `json:"token"`
	Amount      string `json:"amount"`
	DeadlineSec int    `json:"deadlineSec"`
	Reserver    string `json:"reserver"`
	Releaser    string `json:"releaser"`
	// Spender is the Permit2 spender (EVM/Tron only).
	Spender string `json:"spender,omitempty"`
	// Depositor is the signed depositor (Solana and Stellar).
	Depositor string `json:"depositor,omitempty"`
	// DelegateSigner is Stellar only: the payload.delegate_signer (a G strkey) that signed the deposit
	// digest. It equals Depositor: a different key is refused as ErrDelegateUnverified. Whether it is
	// registered for Depositor (create_delegate) is on-chain state no offline check reads. The
	// gateway applies the offline verdict only; the
	// party that reads the chain (veri-fill, or the settler before it deposits) compares
	// DelegateSigner and DelegateEpoch with the escrow's get_delegate for (depositor, token), and
	// until that check has run the payer has not been shown to have consented.
	DelegateSigner string `json:"delegateSigner,omitempty"`
	// DelegateOnchainUnverified is Stellar only, always true there: the delegate's registration for
	// the depositor was NOT verified here, although the delegate is the depositor's own key; consent is
	// established only by the on-chain delegate registration. It is set on every Stellar permit, so
	// it says no more than Scheme == STELLAR, and it is not carried by RecoverSigner or
	// CommitmentResult: it documents the gap, it does not enforce the check.
	DelegateOnchainUnverified bool `json:"delegateOnchainUnverified,omitempty"`
	// DelegateEpoch is Stellar only: the delegate record epoch the deposit digest commits to, as a
	// decimal string. The party that reads the chain compares it with get_delegate(depositor, token).epoch: a deposit
	// signed under an earlier record is void on chain.
	DelegateEpoch string `json:"delegateEpoch,omitempty"`
	// Destination and DepositRequestHash are the two escrow commitments as they were signed.
	Destination        string `json:"destination,omitempty"`
	DepositRequestHash string `json:"depositRequestHash,omitempty"`
}

// VerifiedSenderAuth is a RecoverAndVerify result: the signed terms plus the parsed
// permit. Embeds AuthTerms (so .Amount / .DeadlineSec read through). Mirrors the TS
// `VerifiedSenderAuth extends AuthTerms { permit }`.
type VerifiedSenderAuth struct {
	AuthTerms
	Permit ParsedPermit `json:"permit"`
	// Commitment is the verified destination commitment, for logging and counting admissions.
	Commitment CommitmentResult `json:"commitment"`
}

// SourceRef is the source asset reference a verifier binds a recovered signer against.
type SourceRef struct {
	Network string `json:"network"`
	Asset   string `json:"asset"`
	Account string `json:"account"`
}

// PermitMessage is the decoded Permit2 (EVM/Tron) witness message carried in
// `message_prehash`. Mirrors the TS `PermitMessage` interface.
type PermitMessage struct {
	Permitted struct {
		Token  string `json:"token"`
		Amount string `json:"amount"`
	} `json:"permitted"`
	Spender  string `json:"spender"`
	Nonce    string `json:"nonce"`
	Deadline string `json:"deadline"`
	// Witness is the four-member DepositWitness. DepositRequestHash and Destination are
	// part of the signed digest, so a prehash without them is refused, never hashed as
	// zero values.
	Witness struct {
		DepositRequestHash string `json:"depositRequestHash"`
		Destination        string `json:"destination"`
		Reserver           string `json:"reserver"`
		Releaser           string `json:"releaser"`
	} `json:"witness"`
}

// BuildParams are the inputs to a chain adapter's BuildAuthMessage. Mirrors the TS
// buildAuthMessage params (subset needed for round-trip construction).
type BuildParams struct {
	// SourceAsset is a CAIP-19-ish asset id: "<caip2>/<ns>:<address>".
	SourceAsset     string
	Depositor       string
	MaxSourceAmount string
	// QuoteSourceAmount, when non-empty, is the amount the permit authorizes for a deposit that pays
	// a chosen quote: the quote's source_amount, a decimal string above zero, at most the request's
	// max_source_amount when PaymentRequestJSON commits one. MaxSourceAmount must then be empty.
	// Mirrors the verifier's Expectations.QuoteSourceAmount.
	QuoteSourceAmount string
	// RequestID is the payment's request_id, whose keccak256 is depositRequestHash v1. Required
	// without PaymentRequestJSON; with it, empty or equal to the request's request_id.
	//
	// Deprecated: set PaymentRequestJSON, which carries the request_id.
	RequestID      string
	SourceDefaults ChainDefaults
	// DestinationAsset and DestinationAccount are the payee the deposit commits to: the
	// destination's CAIP-19 asset_identifier and its account. Required without
	// PaymentRequestJSON; with it, empty or composing the request's destination. They are passed
	// separately so the adapter composes the destination through BuildEscrowDestination rather
	// than each caller formatting it.
	//
	// Deprecated: set PaymentRequestJSON, which carries the destination.
	DestinationAsset string
	// Deprecated: set PaymentRequestJSON, which carries the destination. See DestinationAsset.
	DestinationAccount string
	// Deadline is the absolute Permit2 deadline (Unix seconds). Required for EVM/Tron
	// (BuildAuthMessage errors if nil); derive it from the payment's fulfillment deadline.
	// Ignored by Solana, whose deadline is the on-chain replay window from issued_at.
	Deadline *big.Int
	// Nonce is the permit nonce. Required for EVM/Tron (see DeterministicPermitNonce). Optional
	// for Solana (see DeterministicSolanaNonce); when nil a random valid nonce is generated.
	Nonce *big.Int
	// SolanaClock, when non-nil, grounds Solana issued_at in a cluster-clock reader.
	SolanaClock func(chainID string) (uint64, error)
	// IssuedAt is Stellar only: the deposit's issued_at (Unix seconds). The escrow requires it to be at
	// or before the ledger close time, so take it from the latest closed ledger, not the local clock.
	// When nil the builder uses the local clock minus a 30 second skew allowance.
	IssuedAt *uint64
	// DelegateEpoch is Stellar only, required: the epoch of the payer's delegate record for (depositor,
	// token), from the escrow's get_delegate (or the value create_delegate assigned). The deposit digest
	// commits to it, so a deposit signed under one record is void under a later one.
	DelegateEpoch *uint64
	// PaymentRequestJSON is the assembled payment request, exactly as it will be posted once
	// sender_auth is added: build the final body first (defaults, deadlines and executor all
	// fixed), then sign it, then post it unchanged. The builder reads it with ReadDepositRequest,
	// whatever version it signs, and takes the request_id and destination it commits from that
	// reading. A request ReadDepositRequest refuses is refused here. The params that drive the
	// permit, SourceAsset, Depositor, MaxSourceAmount and the escrow, quote selector and fulfillment
	// verifier in SourceDefaults, must agree with the request where it commits them, or the builder
	// refuses rather than sign a deposit whose v2 commits terms its permit does not use.
	PaymentRequestJSON []byte
	// DepositRequestHashVersion is the depositRequestHash the deposit commits: 1 for v1,
	// keccak256(request_id), or 2 for v2, the hash of PaymentRequestJSON's terms, which needs
	// PaymentRequestJSON. 0 is 1, so v1 stays the default output; any other value is refused.
	DepositRequestHashVersion int
}

// commitments are the two escrow commitments the deposit signs: its depositRequestHash and its
// destination, as BuildEscrowDestination composes it. With PaymentRequestJSON they are read from
// the request with ReadDepositRequest, and the params that drive the permit must agree with the
// request where it commits them, compared with sameAddr, the source chain's address equality;
// without it, they are read from RequestID and the destination params.
func (p BuildParams) commitments(sameAddr func(a, b string) bool) (depositRequestHash [32]byte, destination string, err error) {
	switch {
	case p.DepositRequestHashVersion < 0 || p.DepositRequestHashVersion > 2:
		return [32]byte{}, "", fmt.Errorf("sender_auth: depositRequestHash version %d is not 1 or 2", p.DepositRequestHashVersion)
	case p.DepositRequestHashVersion == 2 && p.PaymentRequestJSON == nil:
		return [32]byte{}, "", fmt.Errorf("sender_auth: depositRequestHash version 2 needs the assembled payment request, which it hashes")
	}
	if p.PaymentRequestJSON != nil {
		read, err := ReadDepositRequest(p.PaymentRequestJSON)
		if err != nil {
			return [32]byte{}, "", err
		}
		// The deprecated params are not needed, but one that is set must agree with the request.
		if p.RequestID != "" && p.RequestID != read.Terms.RequestID {
			return [32]byte{}, "", fmt.Errorf("sender_auth: the request id param %q is not the request's request_id %q", p.RequestID, read.Terms.RequestID)
		}
		if p.DestinationAsset != "" || p.DestinationAccount != "" {
			stated, err := BuildEscrowDestination(p.DestinationAsset, p.DestinationAccount)
			if err != nil {
				return [32]byte{}, "", err
			}
			if stated != read.Terms.Destination {
				return [32]byte{}, "", fmt.Errorf("sender_auth: the destination params %q is not the request's destination %q", stated, read.Terms.Destination)
			}
		}
		if err := p.agreeWith(read.Terms, sameAddr); err != nil {
			return [32]byte{}, "", err
		}
		depositRequestHash = read.DepositRequestHashV1
		if p.DepositRequestHashVersion == 2 {
			depositRequestHash = read.DepositRequestHashV2
		}
		return depositRequestHash, read.Terms.Destination, nil
	}
	if depositRequestHash, err = DeriveDepositRequestHash(p.RequestID); err != nil {
		return [32]byte{}, "", err
	}
	destination, err = BuildEscrowDestination(p.DestinationAsset, p.DestinationAccount)
	if err != nil {
		return [32]byte{}, "", err
	}
	return depositRequestHash, destination, nil
}

// depositAmount is the amount the permit authorizes and the param it came from: QuoteSourceAmount
// when it is set, else MaxSourceAmount.
func (p BuildParams) depositAmount() (field, amount string, err error) {
	if p.QuoteSourceAmount == "" {
		return "maxSourceAmount", p.MaxSourceAmount, nil
	}
	if p.MaxSourceAmount != "" {
		return "", "", fmt.Errorf("sender_auth: set maxSourceAmount or quoteSourceAmount, not both")
	}
	if !positiveUintPattern.MatchString(p.QuoteSourceAmount) {
		return "", "", fmt.Errorf("sender_auth: quoteSourceAmount %q is not a decimal integer above zero", p.QuoteSourceAmount)
	}
	return "quoteSourceAmount", p.QuoteSourceAmount, nil
}

// agreeWith refuses a param that drives the permit and is set, but names a different value than the
// one terms commits, so v2 never commits terms the permit does not use.
func (p BuildParams) agreeWith(terms DepositTerms, sameAddr func(a, b string) bool) error {
	if p.SourceAsset != "" && !sameAsset(p.SourceAsset, terms.SourceAssetIdentifier, sameAddr) {
		return fmt.Errorf("sender_auth: the source asset param %q is not the request's source asset_identifier %q", p.SourceAsset, terms.SourceAssetIdentifier)
	}
	if p.Depositor != "" && !sameAddr(p.Depositor, terms.SourceAccount) {
		return fmt.Errorf("sender_auth: the depositor param %q is not the request's source account %q", p.Depositor, terms.SourceAccount)
	}
	// terms commits the amount as readAmount reads it, and nothing when the request omits it. An
	// amount readAmount refuses reads as "", which no committed amount is.
	if p.MaxSourceAmount != "" && terms.MaxSourceAmount != nil {
		if amount, _ := readAmount(p.MaxSourceAmount, "max_source_amount"); amount != *terms.MaxSourceAmount {
			return fmt.Errorf("sender_auth: the max source amount param %q is not the request's max_source_amount %q", p.MaxSourceAmount, *terms.MaxSourceAmount)
		}
	}
	// A quote is paid at its own amount, which the request's cap bounds.
	if p.QuoteSourceAmount != "" && terms.MaxSourceAmount != nil {
		quote, quoteOK := new(big.Int).SetString(p.QuoteSourceAmount, 10)
		limit, limitOK := new(big.Int).SetString(*terms.MaxSourceAmount, 10)
		if !quoteOK || !limitOK || quote.Cmp(limit) > 0 {
			return fmt.Errorf("sender_auth: the quote source amount param %q is above the request's max_source_amount %q", p.QuoteSourceAmount, *terms.MaxSourceAmount)
		}
	}
	if p.SourceDefaults.EscrowContract != "" && !sameAddr(p.SourceDefaults.EscrowContract, terms.EscrowContractAddress) {
		return fmt.Errorf("sender_auth: the escrow contract default %q is not the request's escrow_contract_address %q", p.SourceDefaults.EscrowContract, terms.EscrowContractAddress)
	}
	// The witness reserver and releaser.
	if p.SourceDefaults.QuoteSelector != "" && terms.QuoteSelector != nil && !sameAddr(p.SourceDefaults.QuoteSelector, *terms.QuoteSelector) {
		return fmt.Errorf("sender_auth: the quote selector default %q is not the request's quote_selector %q", p.SourceDefaults.QuoteSelector, *terms.QuoteSelector)
	}
	if p.SourceDefaults.FulfillmentVerifierAccount != "" && !sameAddr(p.SourceDefaults.FulfillmentVerifierAccount, terms.FulfillmentVerifierAccount) {
		return fmt.Errorf("sender_auth: the fulfillment verifier default %q is not the request's fulfillment_verifier account %q", p.SourceDefaults.FulfillmentVerifierAccount, terms.FulfillmentVerifierAccount)
	}
	return nil
}

// sameAsset is asset identifier equality: the chain and asset namespace exactly, and the token
// address, after the last ':', with sameAddr.
func sameAsset(a, b string, sameAddr func(a, b string) bool) bool {
	i, j := strings.LastIndex(a, ":"), strings.LastIndex(b, ":")
	if i < 0 || j < 0 {
		return a == b
	}
	return a[:i] == b[:j] && sameAddr(a[i+1:], b[j+1:])
}

// ChainAdapter builds + signs + recovers-and-verifies one sender_auth scheme.
// Selected by CAIP-2 namespace via GetChainAdapter.
type ChainAdapter interface {
	BuildAuthMessage(params BuildParams) (AuthMessageResult, error)
	Sign(signed SignedMessageInput, privateKey string) (string, error)
	// RecoverSigner recovers/verifies the signer of ONE signed message and confirms it is
	// source.account, WITHOUT parsing or binding a permit — the recover-only primitive a
	// multi-message verifier runs over every signed_messages[] entry (including non-permit
	// setup approvals). Mirrors the TS `recoverSigner`.
	RecoverSigner(signed SignedMessageInput, source SourceRef) (string, error)
	// RecoverAndVerify recovers the signer, binds the signed terms to expected, and requires the
	// signed deposit to commit to commitment (the payment's own destination and request id, or its
	// depositRequestHash v2 when commitment carries one). A commitment failure is a
	// *CommitmentError.
	//
	// Deprecated: the caller assembles commitment from the request itself. Use
	// VerifyPaymentRequestJSON with the request as received, or RecoverSigner for a message that is
	// not the deposit.
	RecoverAndVerify(signed SignedMessageInput, source SourceRef, commitment CommitmentExpectation, expected Expectations) (VerifiedSenderAuth, error)
}

// DelegateSignerDeriver is the optional capability corresponding to the TS
// adapter's `deriveDelegateSigner?`. Only the Solana adapter implements it.
type DelegateSignerDeriver interface {
	DeriveDelegateSigner(privateKey string) (string, error)
}
