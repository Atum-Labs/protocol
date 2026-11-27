package senderauth

import (
	"encoding/json"
	"fmt"
	"math/big"
	"regexp"
	"strings"

	evmencoding "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/encoding"
	evmcontracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"github.com/ethereum/go-ethereum/common"
)

// DirectDepositHashVersion names the depositRequestHash an originator-executed deposit's witness
// commits. The payer picks it when it funds the deposit, and the escrow treats the hash as opaque,
// so every reader of the deposit has to be told which one it is: there is no default.
type DirectDepositHashVersion int

const (
	// DirectDepositHashV1 is keccak256(request_id).
	DirectDepositHashV1 DirectDepositHashVersion = 1
	// DirectDepositHashV2 commits the payment terms (ReadDepositRequest).
	DirectDepositHashV2 DirectDepositHashVersion = 2
)

// DirectDeposit is the deposit an originator-executed PaymentRequest names: what the payer passed
// to directDeposit, the id the escrow stored it under, and the tuple it stored.
type DirectDeposit struct {
	// ID is the deposit id, the escrow's key for the deposit and the payment's id.
	ID common.Hash
	// Input is what the payer passes to directDeposit. Calling it with these values is what makes
	// the deposit land under ID.
	Input evmcontracts.IEscrowDirectDepositInput
	// Unreserved is the tuple directDeposit stored, and UnreservedHash its hash: what
	// getDepositHash(ID) returns until reserve() rewrites it.
	Unreserved     evmencoding.ActiveDeposit
	UnreservedHash common.Hash
}

// The reasons a DirectDepositError reports: a bounded set, for metric tags.
const (
	DirectDepositReasonRequest             = "request"
	DirectDepositReasonExecutor            = "executor"
	DirectDepositReasonDepositNonce        = "deposit_nonce"
	DirectDepositReasonVersion             = "version"
	DirectDepositReasonSenderAuth          = "sender_auth"
	DirectDepositReasonSource              = "source"
	DirectDepositReasonEscrow              = "escrow"
	DirectDepositReasonQuoteSelector       = "quote_selector"
	DirectDepositReasonFulfillmentVerifier = "fulfillment_verifier"
	DirectDepositReasonMaxSourceAmount     = "max_source_amount"
)

// DirectDepositError is a request DeriveDirectDeposit cannot name a deposit from. Reason is one of
// the DirectDepositReason constants; Detail says what is wrong, for logs.
type DirectDepositError struct {
	Reason string
	Detail string
}

func (e *DirectDepositError) Error() string {
	return "direct deposit: " + e.Reason + ": " + e.Detail
}

func refuseDirectDeposit(reason, detail string) (DirectDeposit, error) {
	return DirectDeposit{}, &DirectDepositError{Reason: reason, Detail: detail}
}

var (
	// evmTokenAsset is a CAIP-19 ERC-20 on an EVM chain, the only source directDeposit pulls.
	evmTokenAsset = regexp.MustCompile(`^eip155:([0-9]+)/erc20:(0x[0-9a-fA-F]{40})$`)
)

// DeriveDirectDeposit derives the deposit an originator-executed PaymentRequest names, from the
// request exactly as received, the source chain id and escrow the deposit was made on, and the
// depositRequestHash version its witness commits. The payer, payment-gw, the settler and
// veri-fill all derive it here, so none of them re-implements the preimage.
func DeriveDirectDeposit(request []byte, chainID *big.Int, escrow common.Address, version DirectDepositHashVersion) (DirectDeposit, error) {
	if version != DirectDepositHashV1 && version != DirectDepositHashV2 {
		return refuseDirectDeposit(DirectDepositReasonVersion, fmt.Sprintf("unknown depositRequestHash version %d", version))
	}
	read, err := ReadDepositRequest(request)
	if err != nil {
		return refuseDirectDeposit(DirectDepositReasonRequest, err.Error())
	}
	terms := read.Terms
	if terms.Executor.Deposit != ExecutorOriginator {
		return refuseDirectDeposit(DirectDepositReasonExecutor, "the deposit leg is not originator-executed")
	}
	// The settler submits reserve(), as the Validate rules require: an id for any other request
	// would name a deposit payment-gw refuses.
	if terms.Executor.Reserve != ExecutorSettler {
		return refuseDirectDeposit(DirectDepositReasonExecutor, "an originator-executed deposit is reserved by the settler")
	}
	// The reader refused a case twin of any root member, so an exact-name lookup sees the one
	// sender_auth there is. null counts as present: the settler refuses it too.
	var root map[string]json.RawMessage
	if err := json.Unmarshal(request, &root); err != nil {
		return refuseDirectDeposit(DirectDepositReasonRequest, "the payment request is not a JSON object")
	}
	if _, present := root["sender_auth"]; present {
		return refuseDirectDeposit(DirectDepositReasonSenderAuth, "an originator-executed deposit carries no sender_auth")
	}
	if read.DepositNonce == nil {
		return refuseDirectDeposit(DirectDepositReasonDepositNonce, "deposit_nonce is missing")
	}
	nonceText, problem := readAmount(*read.DepositNonce, "deposit_nonce")
	if problem != "" {
		return refuseDirectDeposit(DirectDepositReasonDepositNonce, problem)
	}
	nonce, _ := new(big.Int).SetString(nonceText, 10)
	source := evmTokenAsset.FindStringSubmatch(terms.SourceAssetIdentifier)
	if source == nil {
		return refuseDirectDeposit(DirectDepositReasonSource, "source.asset_identifier is not an ERC-20 on an EVM chain")
	}
	if source[1] != chainID.String() {
		return refuseDirectDeposit(DirectDepositReasonSource, fmt.Sprintf("the source is on chain %s, not %s", source[1], chainID))
	}
	if !hexAddressPattern.MatchString(terms.SourceAccount) {
		return refuseDirectDeposit(DirectDepositReasonSource, "source.account is not an address")
	}
	if escrow == (common.Address{}) {
		return refuseDirectDeposit(DirectDepositReasonEscrow, "the escrow is the zero address")
	}
	if !strings.EqualFold(terms.EscrowContractAddress, escrow.Hex()) {
		return refuseDirectDeposit(DirectDepositReasonEscrow, "escrow_contract_address is not the escrow the deposit was made on")
	}
	// The escrow refuses a zero reserver or releaser, as the Validate rules do.
	if terms.QuoteSelector == nil || !hexAddressPattern.MatchString(*terms.QuoteSelector) {
		return refuseDirectDeposit(DirectDepositReasonQuoteSelector, "quote_selector is not an address")
	}
	if common.HexToAddress(*terms.QuoteSelector) == (common.Address{}) {
		return refuseDirectDeposit(DirectDepositReasonQuoteSelector, "quote_selector is the zero address")
	}
	if !hexAddressPattern.MatchString(terms.FulfillmentVerifierAccount) {
		return refuseDirectDeposit(DirectDepositReasonFulfillmentVerifier, "fulfillment_verifier.account is not an address")
	}
	if common.HexToAddress(terms.FulfillmentVerifierAccount) == (common.Address{}) {
		return refuseDirectDeposit(DirectDepositReasonFulfillmentVerifier, "fulfillment_verifier.account is the zero address")
	}
	// The reader has already bounded max_source_amount to uint256 and stripped its leading zeros.
	if terms.MaxSourceAmount == nil || *terms.MaxSourceAmount == "0" {
		return refuseDirectDeposit(DirectDepositReasonMaxSourceAmount, "max_source_amount is missing or zero")
	}
	amount, _ := new(big.Int).SetString(*terms.MaxSourceAmount, 10)
	token := common.HexToAddress(source[2])
	hash := read.DepositRequestHashV2
	if version == DirectDepositHashV1 {
		hash = read.DepositRequestHashV1
	}
	input := evmcontracts.IEscrowDirectDepositInput{
		Token:  token,
		Amount: amount,
		Nonce:  nonce,
		DepositWitness: evmcontracts.IEscrowDepositWitness{
			DepositRequestHash: hash,
			Destination:        terms.Destination,
			Reserver:           common.HexToAddress(*terms.QuoteSelector),
			Releaser:           common.HexToAddress(terms.FulfillmentVerifierAccount),
		},
	}
	owner := common.HexToAddress(terms.SourceAccount)
	id, err := evmencoding.DirectDepositID(chainID, escrow, owner, token, nonce, input.DepositWitness, amount)
	if err != nil {
		return refuseDirectDeposit(DirectDepositReasonRequest, err.Error())
	}
	unreserved, err := evmencoding.UnreservedActiveDeposit(owner, token, amount, input.DepositWitness)
	if err != nil {
		return refuseDirectDeposit(DirectDepositReasonRequest, err.Error())
	}
	unreservedHash, err := unreserved.Hash()
	if err != nil {
		return refuseDirectDeposit(DirectDepositReasonRequest, err.Error())
	}
	return DirectDeposit{ID: id, Input: input, Unreserved: unreserved, UnreservedHash: unreservedHash}, nil
}
