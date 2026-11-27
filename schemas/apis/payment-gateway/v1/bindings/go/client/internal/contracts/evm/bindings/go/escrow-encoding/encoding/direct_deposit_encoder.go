package encoding

import (
	"errors"
	"fmt"
	"math/big"

	contracts "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/evm/bindings/go/escrow-encoding/generated"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
)

// Encoders for the originator-executed direct deposit path (CORE-3048, CORE-3049): the
// `directDeposit` and `reserve` calldata, the three-call funding batch, the deposit id, the
// active-deposit hashes both states of a direct deposit store, and the `DepositReserved` overlay.
//
// Nothing here is derived from a transcribed constant that the contract could contradict silently:
// direct_deposit_encoder_test.go ties the domain tag, the witness typehash and the destination cap
// to Escrow.sol, and asserts every output against conformance/direct-deposit-vectors.json, which
// test/Escrow.directDepositVectors.t.sol binds to the contract.

// DirectDepositDomainTag is DIRECT_DEPOSIT_DOMAIN_TAG, keccak256("Escrow:directDeposit:v1"): the
// first word of the deposit id preimage. A Permit2-path id starts with a left-padded address, so a
// direct id can never collide with one.
var DirectDepositDomainTag = crypto.Keccak256Hash([]byte("Escrow:directDeposit:v1"))

// depositWitnessTypeHash is DEPOSIT_WITNESS_TYPE_HASH, the EIP-712 type hash of the DepositWitness.
var depositWitnessTypeHash = crypto.Keccak256Hash([]byte(
	"DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)"))

// MaxDestinationBytes is MAX_DESTINATION_BYTES: the cap the escrow puts on the committed
// destination string, in bytes.
const MaxDestinationBytes = 256

// ReserveSelector is the 4-byte selector of reserve(ReserveInput).
var ReserveSelector = [4]byte{0xb4, 0xb6, 0x91, 0x3b}

// Call is one transaction of a batch: a target and its calldata. Value is always zero.
type Call struct {
	To   common.Address
	Data []byte
}

var (
	errDepositWitnessInvalid = errors.New("invalid deposit witness")
	maxUint256               = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
)

// DepositWitnessHash is the EIP-712 struct hash of the DepositWitness, as Escrow._depositWitnessHash
// computes it. The `destination` string member is hashed as keccak256(bytes(destination)).
func DepositWitnessHash(witness contracts.IEscrowDepositWitness) common.Hash {
	return crypto.Keccak256Hash(
		depositWitnessTypeHash.Bytes(),
		witness.DepositRequestHash[:],
		DestinationHash(witness.Destination).Bytes(),
		EncodeAddress(witness.Reserver),
		EncodeAddress(witness.Releaser),
	)
}

// DestinationHash is the destinationHash the escrow stores: keccak256 of the destination bytes.
func DestinationHash(destination string) common.Hash {
	return crypto.Keccak256Hash([]byte(destination))
}

// validateDirectWitness mirrors Escrow._requireDepositWitness, the check both deposit paths apply:
// a witness it rejects makes directDeposit revert, so no calldata is produced for one.
func validateDirectWitness(witness contracts.IEscrowDepositWitness) error {
	switch {
	case witness.Reserver == (common.Address{}):
		return fmt.Errorf("%w: reserver is the zero address", errDepositWitnessInvalid)
	case witness.Releaser == (common.Address{}):
		return fmt.Errorf("%w: releaser is the zero address", errDepositWitnessInvalid)
	case witness.DepositRequestHash == [32]byte{}:
		return fmt.Errorf("%w: depositRequestHash is empty", errDepositWitnessInvalid)
	case len(witness.Destination) == 0:
		return fmt.Errorf("%w: destination is empty", errDepositWitnessInvalid)
	case len(witness.Destination) > MaxDestinationBytes:
		return fmt.Errorf("%w: destination is %d bytes, over the %d byte cap",
			errDepositWitnessInvalid, len(witness.Destination), MaxDestinationBytes)
	}
	return nil
}

func requireUint256(label string, v *big.Int) error {
	if v == nil || v.Sign() < 0 || v.Cmp(maxUint256) > 0 {
		return fmt.Errorf("%s must be an integer in [0, 2^256)", label)
	}
	return nil
}

func requirePositiveUint256(label string, v *big.Int) error {
	if err := requireUint256(label, v); err != nil {
		return err
	}
	if v.Sign() == 0 {
		return fmt.Errorf("%s must be greater than zero", label)
	}
	return nil
}

// DirectDepositID derives the deposit id of a direct deposit:
//
//	keccak256(abi.encode(DIRECT_DEPOSIT_DOMAIN_TAG, chainid, escrow, owner, token, nonce,
//	                     depositWitnessHash, amount))
//
// owner is the account that calls directDeposit (the depositor), amount the deposited maximum
// (the request's max_source_amount, fees included). Every member is a static type, so the preimage
// is eight words. The token, nonce, amount and witness are validated like the contract does (a
// zero token, a zero amount or a witness directDeposit rejects would revert), so an id is only
// returned for a deposit the escrow would accept. chainID, escrow and owner are not checked beyond
// their range: the contract takes them from block.chainid, its own address and msg.sender.
func DirectDepositID(
	chainID *big.Int,
	escrow common.Address,
	owner common.Address,
	token common.Address,
	nonce *big.Int,
	witness contracts.IEscrowDepositWitness,
	amount *big.Int,
) (common.Hash, error) {
	if err := requireUint256("chainID", chainID); err != nil {
		return common.Hash{}, err
	}
	if token == (common.Address{}) {
		return common.Hash{}, errors.New("token is the zero address")
	}
	if err := requireUint256("nonce", nonce); err != nil {
		return common.Hash{}, err
	}
	if err := requirePositiveUint256("amount", amount); err != nil {
		return common.Hash{}, err
	}
	if err := validateDirectWitness(witness); err != nil {
		return common.Hash{}, err
	}
	return crypto.Keccak256Hash(
		DirectDepositDomainTag.Bytes(),
		EncodeBig(*chainID),
		EncodeAddress(escrow),
		EncodeAddress(owner),
		EncodeAddress(token),
		EncodeBig(*nonce),
		DepositWitnessHash(witness).Bytes(),
		EncodeBig(*amount),
	), nil
}

// EncodeDirectDeposit returns the calldata of escrow.directDeposit(input). input.Amount is the
// request's max_source_amount.
func EncodeDirectDeposit(input contracts.IEscrowDirectDepositInput) ([]byte, error) {
	if input.Token == (common.Address{}) {
		return nil, errors.New("token is the zero address")
	}
	if err := requireUint256("nonce", input.Nonce); err != nil {
		return nil, err
	}
	if err := requirePositiveUint256("amount", input.Amount); err != nil {
		return nil, err
	}
	if err := validateDirectWitness(input.DepositWitness); err != nil {
		return nil, err
	}
	return packEscrowCall("directDeposit", input)
}

// EncodeReserve returns the calldata of escrow.reserve(input), selector 0xb4b6913b. The input
// carries the unreserved tuple's members (depositor, token, amount, the deposit witness) and the
// reserver's signature over the ReserveWitness; there is no nonce and no deposit id outside the
// reserve witness. The bounds checked are the ones reserve() reverts on without needing chain
// state: a zero settler or quote, a zero charge, a charge above the deposit.
func EncodeReserve(input contracts.IEscrowReserveInput) ([]byte, error) {
	if input.Depositor == (common.Address{}) {
		return nil, errors.New("depositor is the zero address")
	}
	if input.Token == (common.Address{}) {
		return nil, errors.New("token is the zero address")
	}
	if err := requirePositiveUint256("amount", input.Amount); err != nil {
		return nil, err
	}
	if err := validateDirectWitness(input.DepositWitness); err != nil {
		return nil, err
	}
	rw := input.ReserveWitness
	if rw.Settler == (common.Address{}) {
		return nil, errors.New("reserve witness settler is the zero address")
	}
	if rw.QuoteHash == [32]byte{} {
		return nil, errors.New("reserve witness quoteHash is empty")
	}
	if err := requirePositiveUint256("reserve witness sourceAmount", rw.SourceAmount); err != nil {
		return nil, err
	}
	if rw.SourceAmount.Cmp(input.Amount) > 0 {
		return nil, fmt.Errorf("reserve witness sourceAmount %s exceeds the deposited amount %s",
			rw.SourceAmount, input.Amount)
	}
	data, err := packEscrowCall("reserve", input)
	if err != nil {
		return nil, err
	}
	if [4]byte(data[:4]) != ReserveSelector {
		return nil, fmt.Errorf("reserve selector is %x, expected %x: the ReserveInput binding drifted",
			data[:4], ReserveSelector)
	}
	return data, nil
}

// DirectDepositFundingBatch returns the three calls the owner account sends, in order:
//
//	token.approve(escrow, 0), token.approve(escrow, amount), escrow.directDeposit(input)
//
// The reset to zero is what makes a Tempo access key's spending limit charge exactly `amount`
// (the limit is charged on the key's own approve, not on the escrow's transferFrom); it is the
// signer's discipline and the contract does not check it. The escrow pulls with
// transferFrom(msg.sender) after every state write, so the two approves must precede
// directDeposit in the same batch.
func DirectDepositFundingBatch(
	escrow common.Address,
	input contracts.IEscrowDirectDepositInput,
) ([]Call, error) {
	deposit, err := EncodeDirectDeposit(input)
	if err != nil {
		return nil, err
	}
	erc20, err := contracts.IERC20MetaData.GetAbi()
	if err != nil {
		return nil, fmt.Errorf("load IERC20 ABI: %w", err)
	}
	reset, err := erc20.Pack("approve", escrow, big.NewInt(0))
	if err != nil {
		return nil, fmt.Errorf("pack approve(escrow, 0): %w", err)
	}
	fund, err := erc20.Pack("approve", escrow, input.Amount)
	if err != nil {
		return nil, fmt.Errorf("pack approve(escrow, amount): %w", err)
	}
	return []Call{
		{To: input.Token, Data: reset},
		{To: input.Token, Data: fund},
		{To: escrow, Data: deposit},
	}, nil
}

func packEscrowCall(method string, args ...any) ([]byte, error) {
	escrow, err := contracts.IEscrowMetaData.GetAbi()
	if err != nil {
		return nil, fmt.Errorf("load IEscrow ABI: %w", err)
	}
	data, err := escrow.Pack(method, args...)
	if err != nil {
		return nil, fmt.Errorf("pack %s: %w", method, err)
	}
	return data, nil
}

// ActiveDeposit mirrors IEscrow.ActiveDeposit, the tuple whose keccak256(abi.encode(...)) the
// escrow stores under the deposit id and getDepositHash returns. settler-agent and veri-fill
// compare getDepositHash(id) against Hash() instead of re-implementing the tuple.
type ActiveDeposit struct {
	Depositor          common.Address
	QuoteHash          [32]byte
	DepositRequestHash [32]byte
	DestinationHash    [32]byte
	Token              common.Address
	Amount             *big.Int
	FeeAmount          *big.Int
	Reserver           common.Address
	Releaser           common.Address
	Settler            common.Address
}

// Hash is keccak256(abi.encode(activeDeposit)). The struct is all static types, so the encoding is
// ten words in declaration order, with no offset word.
func (a ActiveDeposit) Hash() (common.Hash, error) {
	if err := requireUint256("amount", a.Amount); err != nil {
		return common.Hash{}, err
	}
	if err := requireUint256("feeAmount", a.FeeAmount); err != nil {
		return common.Hash{}, err
	}
	return crypto.Keccak256Hash(
		EncodeAddress(a.Depositor),
		a.QuoteHash[:],
		a.DepositRequestHash[:],
		a.DestinationHash[:],
		EncodeAddress(a.Token),
		EncodeBig(*a.Amount),
		EncodeBig(*a.FeeAmount),
		EncodeAddress(a.Reserver),
		EncodeAddress(a.Releaser),
		EncodeAddress(a.Settler),
	), nil
}

// UnreservedActiveDeposit is the tuple directDeposit stores: zero quoteHash, settler and feeAmount,
// and amount = the deposited maximum. The depositor is the account that called directDeposit.
func UnreservedActiveDeposit(
	depositor common.Address,
	token common.Address,
	amount *big.Int,
	witness contracts.IEscrowDepositWitness,
) (ActiveDeposit, error) {
	if err := requirePositiveUint256("amount", amount); err != nil {
		return ActiveDeposit{}, err
	}
	if err := validateDirectWitness(witness); err != nil {
		return ActiveDeposit{}, err
	}
	return ActiveDeposit{
		Depositor:          depositor,
		DepositRequestHash: witness.DepositRequestHash,
		DestinationHash:    DestinationHash(witness.Destination),
		Token:              token,
		Amount:             new(big.Int).Set(amount),
		FeeAmount:          new(big.Int),
		Reserver:           witness.Reserver,
		Releaser:           witness.Releaser,
	}, nil
}

// ReservedActiveDeposit is the tuple reserve() rewrites the stored hash to: the unreserved tuple
// with the winning quoteHash and settler, amount = sourceAmount (what the quote charged, at most
// the deposited maximum) and the fee on it. The fee is computed on chain from the token config locked at
// deposit time, so it is an input here: take it from DepositReserved rather than recomputing it
// (see ApplyDepositReserved).
func ReservedActiveDeposit(
	unreserved ActiveDeposit,
	quoteHash [32]byte,
	settler common.Address,
	sourceAmount *big.Int,
	feeAmount *big.Int,
) (ActiveDeposit, error) {
	if err := requirePositiveUint256("sourceAmount", sourceAmount); err != nil {
		return ActiveDeposit{}, err
	}
	if err := requireUint256("feeAmount", feeAmount); err != nil {
		return ActiveDeposit{}, err
	}
	if unreserved.Amount == nil || sourceAmount.Cmp(unreserved.Amount) > 0 {
		return ActiveDeposit{}, fmt.Errorf("sourceAmount %s exceeds the deposited amount %v",
			sourceAmount, unreserved.Amount)
	}
	reserved := unreserved
	reserved.QuoteHash = quoteHash
	reserved.Settler = settler
	reserved.Amount = new(big.Int).Set(sourceAmount)
	reserved.FeeAmount = new(big.Int).Set(feeAmount)
	return reserved, nil
}

// DecodeDepositReserved decodes a DepositReserved log:
//
//	event DepositReserved(bytes32 indexed depositId, bytes32 quoteHash, address settler,
//	                      uint256 amount, uint256 feeAmount)
//
// It checks only the log's own shape (topic0, topic count, data length). The caller filters by
// emitter, which is the escrow's address.
func DecodeDepositReserved(log types.Log) (*contracts.IEscrowDepositReserved, error) {
	escrow, err := contracts.IEscrowMetaData.GetAbi()
	if err != nil {
		return nil, fmt.Errorf("load IEscrow ABI: %w", err)
	}
	event, ok := escrow.Events["DepositReserved"]
	if !ok {
		return nil, errors.New("IEscrow ABI has no DepositReserved event")
	}
	if len(log.Topics) != 2 || log.Topics[0] != event.ID {
		return nil, errors.New("log is not a DepositReserved event")
	}
	decoded := new(contracts.IEscrowDepositReserved)
	if err := unpackEventData(escrow, event, log.Data, decoded); err != nil {
		return nil, err
	}
	decoded.DepositId = log.Topics[1]
	decoded.Raw = log
	return decoded, nil
}

func unpackEventData(a *abi.ABI, event abi.Event, data []byte, out any) error {
	if err := a.UnpackIntoInterface(out, event.Name, data); err != nil {
		return fmt.Errorf("decode %s data: %w", event.Name, err)
	}
	return nil
}

// ApplyDepositReserved overlays the four values DepositReserved carries (quoteHash, settler, the
// charged amount, the fee) on the deposit-time tuple, which a log-only consumer rebuilt from
// Deposited and DepositCommitments (or an indexer from the deposit call). It refuses an overlay
// for another deposit's id or one that charges more than the deposited amount, so a mismatched
// log cannot produce a hash that no stored deposit has.
func ApplyDepositReserved(
	depositID common.Hash,
	unreserved ActiveDeposit,
	event *contracts.IEscrowDepositReserved,
) (ActiveDeposit, error) {
	if event == nil {
		return ActiveDeposit{}, errors.New("nil DepositReserved event")
	}
	if event.DepositId != depositID {
		return ActiveDeposit{}, fmt.Errorf("DepositReserved is for deposit %x, not %x", event.DepositId, depositID)
	}
	return ReservedActiveDeposit(unreserved, event.QuoteHash, event.Settler, event.Amount, event.FeeAmount)
}
