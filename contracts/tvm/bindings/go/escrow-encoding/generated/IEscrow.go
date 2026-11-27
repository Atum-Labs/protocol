// Code generated - DO NOT EDIT.
// This file is a generated binding and any manual changes will be lost.

package contracts

import (
	"errors"
	"math/big"
	"strings"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/event"
)

// Reference imports to suppress errors if they are not otherwise used.
var (
	_ = errors.New
	_ = big.NewInt
	_ = strings.NewReader
	_ = ethereum.NotFound
	_ = bind.Bind
	_ = common.Big1
	_ = types.BloomLookup
	_ = event.NewSubscription
	_ = abi.ConvertType
)

// IEscrowDepositInput is an auto generated low-level Go binding around an user-defined struct.
type IEscrowDepositInput struct {
	Permit           ISignatureTransferPermitTransferFrom
	Depositor        common.Address
	DepositWitness   IEscrowDepositWitness
	DepositSignature []byte
	ReserveWitness   IEscrowReserveWitness
	ReserveSignature []byte
}

// IEscrowDepositWitness is an auto generated low-level Go binding around an user-defined struct.
type IEscrowDepositWitness struct {
	DepositRequestHash [32]byte
	Destination        string
	Reserver           common.Address
	Releaser           common.Address
}

// IEscrowRefundInput is an auto generated low-level Go binding around an user-defined struct.
type IEscrowRefundInput struct {
	RefundWitness   IEscrowRefundWitness
	RefundSignature []byte
}

// IEscrowRefundWitness is an auto generated low-level Go binding around an user-defined struct.
type IEscrowRefundWitness struct {
	DepositId          [32]byte
	QuoteHash          [32]byte
	DepositRequestHash [32]byte
	DestinationHash    [32]byte
	Depositor          common.Address
	Token              common.Address
	Amount             *big.Int
	FeeAmount          *big.Int
	Reserver           common.Address
	Releaser           common.Address
	Settler            common.Address
}

// IEscrowReleaseInput is an auto generated low-level Go binding around an user-defined struct.
type IEscrowReleaseInput struct {
	ReleaseWitness   IEscrowReleaseWitness
	ReleaseSignature []byte
}

// IEscrowReleaseWitness is an auto generated low-level Go binding around an user-defined struct.
type IEscrowReleaseWitness struct {
	DepositId          [32]byte
	QuoteHash          [32]byte
	DepositRequestHash [32]byte
	DestinationHash    [32]byte
	Depositor          common.Address
	Token              common.Address
	Amount             *big.Int
	FeeAmount          *big.Int
	Reserver           common.Address
	Releaser           common.Address
	Settler            common.Address
}

// IEscrowReserveWitness is an auto generated low-level Go binding around an user-defined struct.
type IEscrowReserveWitness struct {
	DepositId    [32]byte
	QuoteHash    [32]byte
	Settler      common.Address
	SourceAmount *big.Int
}

// ISignatureTransferPermitTransferFrom is an auto generated low-level Go binding around an user-defined struct.
type ISignatureTransferPermitTransferFrom struct {
	Permitted ISignatureTransferTokenPermissions
	Nonce     *big.Int
	Deadline  *big.Int
}

// ISignatureTransferTokenPermissions is an auto generated low-level Go binding around an user-defined struct.
type ISignatureTransferTokenPermissions struct {
	Token  common.Address
	Amount *big.Int
}

// IEscrowMetaData contains all meta data concerning the IEscrow contract.
var IEscrowMetaData = &bind.MetaData{
	ABI: "[{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"}],\"name\":\"DepositAlreadyExists\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"DepositAmountCannotBeZero\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"DepositCannotBeZeroAddress\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"}],\"name\":\"DepositNotFound\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"DepositRequestHashCannotBeEmpty\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"DestinationCannotBeEmpty\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"uint256\",\"name\":\"length\",\"type\":\"uint256\"}],\"name\":\"DestinationTooLong\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidSignature\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"InvalidSourceAmount\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"expectedHash\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"passedHash\",\"type\":\"bytes32\"}],\"name\":\"InvalidWitnessValues\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"uint256\",\"name\":\"expected\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"received\",\"type\":\"uint256\"}],\"name\":\"NonExactTransfer\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"}],\"name\":\"NotReserved\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"Permit2CannotBeZeroAddress\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"QuoteHashCannotBeEmpty\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"ReleaserCannotBeZeroAddress\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"ReserverCannotBeZeroAddress\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"SettlerCannotBeZeroAddress\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"USDTCannotBeZeroAddress\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"uint256\",\"name\":\"expected\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"observed\",\"type\":\"uint256\"}],\"name\":\"UsdtTransferDidNotMove\",\"type\":\"error\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"indexed\":false,\"internalType\":\"bytes32\",\"name\":\"depositRequestHash\",\"type\":\"bytes32\"},{\"indexed\":false,\"internalType\":\"bytes32\",\"name\":\"destinationHash\",\"type\":\"bytes32\"}],\"name\":\"DepositCommitments\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"indexed\":true,\"internalType\":\"bytes32\",\"name\":\"quoteHash\",\"type\":\"bytes32\"},{\"indexed\":true,\"internalType\":\"address\",\"name\":\"depositor\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"address\",\"name\":\"settler\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"address\",\"name\":\"token\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"},{\"indexed\":false,\"internalType\":\"uint256\",\"name\":\"feeAmount\",\"type\":\"uint256\"},{\"indexed\":false,\"internalType\":\"address\",\"name\":\"reserver\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"address\",\"name\":\"releaser\",\"type\":\"address\"}],\"name\":\"Deposited\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":false,\"internalType\":\"bytes32[]\",\"name\":\"depositIds\",\"type\":\"bytes32[]\"},{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"depositRequestHash\",\"type\":\"bytes32\"},{\"internalType\":\"string\",\"name\":\"destination\",\"type\":\"string\"},{\"internalType\":\"address\",\"name\":\"reserver\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"releaser\",\"type\":\"address\"}],\"indexed\":false,\"internalType\":\"structIEscrow.DepositWitness[]\",\"name\":\"depositWitnesses\",\"type\":\"tuple[]\"},{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"quoteHash\",\"type\":\"bytes32\"},{\"internalType\":\"address\",\"name\":\"settler\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"sourceAmount\",\"type\":\"uint256\"}],\"indexed\":false,\"internalType\":\"structIEscrow.ReserveWitness[]\",\"name\":\"reserveWitnesses\",\"type\":\"tuple[]\"},{\"indexed\":false,\"internalType\":\"uint256[]\",\"name\":\"feeAmounts\",\"type\":\"uint256[]\"}],\"name\":\"DepositedMany\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"indexed\":true,\"internalType\":\"address\",\"name\":\"depositor\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"address\",\"name\":\"token\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"}],\"name\":\"Refunded\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"quoteHash\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"depositRequestHash\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"destinationHash\",\"type\":\"bytes32\"},{\"internalType\":\"address\",\"name\":\"depositor\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"token\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"feeAmount\",\"type\":\"uint256\"},{\"internalType\":\"address\",\"name\":\"reserver\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"releaser\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"settler\",\"type\":\"address\"}],\"indexed\":false,\"internalType\":\"structIEscrow.RefundWitness[]\",\"name\":\"refundWitnesses\",\"type\":\"tuple[]\"}],\"name\":\"RefundedMany\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"indexed\":true,\"internalType\":\"address\",\"name\":\"settler\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"address\",\"name\":\"token\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"},{\"indexed\":false,\"internalType\":\"uint256\",\"name\":\"feeAmount\",\"type\":\"uint256\"}],\"name\":\"Released\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"quoteHash\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"depositRequestHash\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"destinationHash\",\"type\":\"bytes32\"},{\"internalType\":\"address\",\"name\":\"depositor\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"token\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"feeAmount\",\"type\":\"uint256\"},{\"internalType\":\"address\",\"name\":\"reserver\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"releaser\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"settler\",\"type\":\"address\"}],\"indexed\":false,\"internalType\":\"structIEscrow.ReleaseWitness[]\",\"name\":\"releaseWitnesses\",\"type\":\"tuple[]\"}],\"name\":\"ReleasedMany\",\"type\":\"event\"},{\"inputs\":[{\"components\":[{\"components\":[{\"components\":[{\"internalType\":\"address\",\"name\":\"token\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"}],\"internalType\":\"structISignatureTransfer.TokenPermissions\",\"name\":\"permitted\",\"type\":\"tuple\"},{\"internalType\":\"uint256\",\"name\":\"nonce\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"deadline\",\"type\":\"uint256\"}],\"internalType\":\"structISignatureTransfer.PermitTransferFrom\",\"name\":\"permit\",\"type\":\"tuple\"},{\"internalType\":\"address\",\"name\":\"depositor\",\"type\":\"address\"},{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"depositRequestHash\",\"type\":\"bytes32\"},{\"internalType\":\"string\",\"name\":\"destination\",\"type\":\"string\"},{\"internalType\":\"address\",\"name\":\"reserver\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"releaser\",\"type\":\"address\"}],\"internalType\":\"structIEscrow.DepositWitness\",\"name\":\"depositWitness\",\"type\":\"tuple\"},{\"internalType\":\"bytes\",\"name\":\"depositSignature\",\"type\":\"bytes\"},{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"quoteHash\",\"type\":\"bytes32\"},{\"internalType\":\"address\",\"name\":\"settler\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"sourceAmount\",\"type\":\"uint256\"}],\"internalType\":\"structIEscrow.ReserveWitness\",\"name\":\"reserveWitness\",\"type\":\"tuple\"},{\"internalType\":\"bytes\",\"name\":\"reserveSignature\",\"type\":\"bytes\"}],\"internalType\":\"structIEscrow.DepositInput\",\"name\":\"depositInput\",\"type\":\"tuple\"}],\"name\":\"deposit\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"}],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"components\":[{\"components\":[{\"internalType\":\"address\",\"name\":\"token\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"}],\"internalType\":\"structISignatureTransfer.TokenPermissions\",\"name\":\"permitted\",\"type\":\"tuple\"},{\"internalType\":\"uint256\",\"name\":\"nonce\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"deadline\",\"type\":\"uint256\"}],\"internalType\":\"structISignatureTransfer.PermitTransferFrom\",\"name\":\"permit\",\"type\":\"tuple\"},{\"internalType\":\"address\",\"name\":\"depositor\",\"type\":\"address\"},{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"depositRequestHash\",\"type\":\"bytes32\"},{\"internalType\":\"string\",\"name\":\"destination\",\"type\":\"string\"},{\"internalType\":\"address\",\"name\":\"reserver\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"releaser\",\"type\":\"address\"}],\"internalType\":\"structIEscrow.DepositWitness\",\"name\":\"depositWitness\",\"type\":\"tuple\"},{\"internalType\":\"bytes\",\"name\":\"depositSignature\",\"type\":\"bytes\"},{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"quoteHash\",\"type\":\"bytes32\"},{\"internalType\":\"address\",\"name\":\"settler\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"sourceAmount\",\"type\":\"uint256\"}],\"internalType\":\"structIEscrow.ReserveWitness\",\"name\":\"reserveWitness\",\"type\":\"tuple\"},{\"internalType\":\"bytes\",\"name\":\"reserveSignature\",\"type\":\"bytes\"}],\"internalType\":\"structIEscrow.DepositInput[]\",\"name\":\"depositInputs\",\"type\":\"tuple[]\"}],\"name\":\"depositMany\",\"outputs\":[{\"internalType\":\"bytes32[]\",\"name\":\"depositIds\",\"type\":\"bytes32[]\"}],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"}],\"name\":\"getDepositHash\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"quoteHash\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"depositRequestHash\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"destinationHash\",\"type\":\"bytes32\"},{\"internalType\":\"address\",\"name\":\"depositor\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"token\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"feeAmount\",\"type\":\"uint256\"},{\"internalType\":\"address\",\"name\":\"reserver\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"releaser\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"settler\",\"type\":\"address\"}],\"internalType\":\"structIEscrow.RefundWitness\",\"name\":\"refundWitness\",\"type\":\"tuple\"},{\"internalType\":\"bytes\",\"name\":\"refundSignature\",\"type\":\"bytes\"}],\"internalType\":\"structIEscrow.RefundInput\",\"name\":\"refundInput\",\"type\":\"tuple\"}],\"name\":\"refund\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"quoteHash\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"depositRequestHash\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"destinationHash\",\"type\":\"bytes32\"},{\"internalType\":\"address\",\"name\":\"depositor\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"token\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"feeAmount\",\"type\":\"uint256\"},{\"internalType\":\"address\",\"name\":\"reserver\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"releaser\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"settler\",\"type\":\"address\"}],\"internalType\":\"structIEscrow.RefundWitness\",\"name\":\"refundWitness\",\"type\":\"tuple\"},{\"internalType\":\"bytes\",\"name\":\"refundSignature\",\"type\":\"bytes\"}],\"internalType\":\"structIEscrow.RefundInput[]\",\"name\":\"refundInputs\",\"type\":\"tuple[]\"}],\"name\":\"refundMany\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"quoteHash\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"depositRequestHash\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"destinationHash\",\"type\":\"bytes32\"},{\"internalType\":\"address\",\"name\":\"depositor\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"token\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"feeAmount\",\"type\":\"uint256\"},{\"internalType\":\"address\",\"name\":\"reserver\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"releaser\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"settler\",\"type\":\"address\"}],\"internalType\":\"structIEscrow.ReleaseWitness\",\"name\":\"releaseWitness\",\"type\":\"tuple\"},{\"internalType\":\"bytes\",\"name\":\"releaseSignature\",\"type\":\"bytes\"}],\"internalType\":\"structIEscrow.ReleaseInput\",\"name\":\"releaseInput\",\"type\":\"tuple\"}],\"name\":\"release\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"components\":[{\"components\":[{\"internalType\":\"bytes32\",\"name\":\"depositId\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"quoteHash\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"depositRequestHash\",\"type\":\"bytes32\"},{\"internalType\":\"bytes32\",\"name\":\"destinationHash\",\"type\":\"bytes32\"},{\"internalType\":\"address\",\"name\":\"depositor\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"token\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"feeAmount\",\"type\":\"uint256\"},{\"internalType\":\"address\",\"name\":\"reserver\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"releaser\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"settler\",\"type\":\"address\"}],\"internalType\":\"structIEscrow.ReleaseWitness\",\"name\":\"releaseWitness\",\"type\":\"tuple\"},{\"internalType\":\"bytes\",\"name\":\"releaseSignature\",\"type\":\"bytes\"}],\"internalType\":\"structIEscrow.ReleaseInput[]\",\"name\":\"releaseInputs\",\"type\":\"tuple[]\"}],\"name\":\"releaseMany\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"}]",
}

// IEscrowABI is the input ABI used to generate the binding from.
// Deprecated: Use IEscrowMetaData.ABI instead.
var IEscrowABI = IEscrowMetaData.ABI

// IEscrow is an auto generated Go binding around an Ethereum contract.
type IEscrow struct {
	IEscrowCaller     // Read-only binding to the contract
	IEscrowTransactor // Write-only binding to the contract
	IEscrowFilterer   // Log filterer for contract events
}

// IEscrowCaller is an auto generated read-only Go binding around an Ethereum contract.
type IEscrowCaller struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// IEscrowTransactor is an auto generated write-only Go binding around an Ethereum contract.
type IEscrowTransactor struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// IEscrowFilterer is an auto generated log filtering Go binding around an Ethereum contract events.
type IEscrowFilterer struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// IEscrowSession is an auto generated Go binding around an Ethereum contract,
// with pre-set call and transact options.
type IEscrowSession struct {
	Contract     *IEscrow          // Generic contract binding to set the session for
	CallOpts     bind.CallOpts     // Call options to use throughout this session
	TransactOpts bind.TransactOpts // Transaction auth options to use throughout this session
}

// IEscrowCallerSession is an auto generated read-only Go binding around an Ethereum contract,
// with pre-set call options.
type IEscrowCallerSession struct {
	Contract *IEscrowCaller // Generic contract caller binding to set the session for
	CallOpts bind.CallOpts  // Call options to use throughout this session
}

// IEscrowTransactorSession is an auto generated write-only Go binding around an Ethereum contract,
// with pre-set transact options.
type IEscrowTransactorSession struct {
	Contract     *IEscrowTransactor // Generic contract transactor binding to set the session for
	TransactOpts bind.TransactOpts  // Transaction auth options to use throughout this session
}

// IEscrowRaw is an auto generated low-level Go binding around an Ethereum contract.
type IEscrowRaw struct {
	Contract *IEscrow // Generic contract binding to access the raw methods on
}

// IEscrowCallerRaw is an auto generated low-level read-only Go binding around an Ethereum contract.
type IEscrowCallerRaw struct {
	Contract *IEscrowCaller // Generic read-only contract binding to access the raw methods on
}

// IEscrowTransactorRaw is an auto generated low-level write-only Go binding around an Ethereum contract.
type IEscrowTransactorRaw struct {
	Contract *IEscrowTransactor // Generic write-only contract binding to access the raw methods on
}

// NewIEscrow creates a new instance of IEscrow, bound to a specific deployed contract.
func NewIEscrow(address common.Address, backend bind.ContractBackend) (*IEscrow, error) {
	contract, err := bindIEscrow(address, backend, backend, backend)
	if err != nil {
		return nil, err
	}
	return &IEscrow{IEscrowCaller: IEscrowCaller{contract: contract}, IEscrowTransactor: IEscrowTransactor{contract: contract}, IEscrowFilterer: IEscrowFilterer{contract: contract}}, nil
}

// NewIEscrowCaller creates a new read-only instance of IEscrow, bound to a specific deployed contract.
func NewIEscrowCaller(address common.Address, caller bind.ContractCaller) (*IEscrowCaller, error) {
	contract, err := bindIEscrow(address, caller, nil, nil)
	if err != nil {
		return nil, err
	}
	return &IEscrowCaller{contract: contract}, nil
}

// NewIEscrowTransactor creates a new write-only instance of IEscrow, bound to a specific deployed contract.
func NewIEscrowTransactor(address common.Address, transactor bind.ContractTransactor) (*IEscrowTransactor, error) {
	contract, err := bindIEscrow(address, nil, transactor, nil)
	if err != nil {
		return nil, err
	}
	return &IEscrowTransactor{contract: contract}, nil
}

// NewIEscrowFilterer creates a new log filterer instance of IEscrow, bound to a specific deployed contract.
func NewIEscrowFilterer(address common.Address, filterer bind.ContractFilterer) (*IEscrowFilterer, error) {
	contract, err := bindIEscrow(address, nil, nil, filterer)
	if err != nil {
		return nil, err
	}
	return &IEscrowFilterer{contract: contract}, nil
}

// bindIEscrow binds a generic wrapper to an already deployed contract.
func bindIEscrow(address common.Address, caller bind.ContractCaller, transactor bind.ContractTransactor, filterer bind.ContractFilterer) (*bind.BoundContract, error) {
	parsed, err := IEscrowMetaData.GetAbi()
	if err != nil {
		return nil, err
	}
	return bind.NewBoundContract(address, *parsed, caller, transactor, filterer), nil
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_IEscrow *IEscrowRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _IEscrow.Contract.IEscrowCaller.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_IEscrow *IEscrowRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _IEscrow.Contract.IEscrowTransactor.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_IEscrow *IEscrowRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _IEscrow.Contract.IEscrowTransactor.contract.Transact(opts, method, params...)
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_IEscrow *IEscrowCallerRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _IEscrow.Contract.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_IEscrow *IEscrowTransactorRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _IEscrow.Contract.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_IEscrow *IEscrowTransactorRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _IEscrow.Contract.contract.Transact(opts, method, params...)
}

// GetDepositHash is a free data retrieval call binding the contract method 0x663558a7.
//
// Solidity: function getDepositHash(bytes32 depositId) view returns(bytes32)
func (_IEscrow *IEscrowCaller) GetDepositHash(opts *bind.CallOpts, depositId [32]byte) ([32]byte, error) {
	var out []interface{}
	err := _IEscrow.contract.Call(opts, &out, "getDepositHash", depositId)

	if err != nil {
		return *new([32]byte), err
	}

	out0 := *abi.ConvertType(out[0], new([32]byte)).(*[32]byte)

	return out0, err

}

// GetDepositHash is a free data retrieval call binding the contract method 0x663558a7.
//
// Solidity: function getDepositHash(bytes32 depositId) view returns(bytes32)
func (_IEscrow *IEscrowSession) GetDepositHash(depositId [32]byte) ([32]byte, error) {
	return _IEscrow.Contract.GetDepositHash(&_IEscrow.CallOpts, depositId)
}

// GetDepositHash is a free data retrieval call binding the contract method 0x663558a7.
//
// Solidity: function getDepositHash(bytes32 depositId) view returns(bytes32)
func (_IEscrow *IEscrowCallerSession) GetDepositHash(depositId [32]byte) ([32]byte, error) {
	return _IEscrow.Contract.GetDepositHash(&_IEscrow.CallOpts, depositId)
}

// Deposit is a paid mutator transaction binding the contract method 0xf2eb65e0.
//
// Solidity: function deposit((((address,uint256),uint256,uint256),address,(bytes32,string,address,address),bytes,(bytes32,bytes32,address,uint256),bytes) depositInput) returns(bytes32 depositId)
func (_IEscrow *IEscrowTransactor) Deposit(opts *bind.TransactOpts, depositInput IEscrowDepositInput) (*types.Transaction, error) {
	return _IEscrow.contract.Transact(opts, "deposit", depositInput)
}

// Deposit is a paid mutator transaction binding the contract method 0xf2eb65e0.
//
// Solidity: function deposit((((address,uint256),uint256,uint256),address,(bytes32,string,address,address),bytes,(bytes32,bytes32,address,uint256),bytes) depositInput) returns(bytes32 depositId)
func (_IEscrow *IEscrowSession) Deposit(depositInput IEscrowDepositInput) (*types.Transaction, error) {
	return _IEscrow.Contract.Deposit(&_IEscrow.TransactOpts, depositInput)
}

// Deposit is a paid mutator transaction binding the contract method 0xf2eb65e0.
//
// Solidity: function deposit((((address,uint256),uint256,uint256),address,(bytes32,string,address,address),bytes,(bytes32,bytes32,address,uint256),bytes) depositInput) returns(bytes32 depositId)
func (_IEscrow *IEscrowTransactorSession) Deposit(depositInput IEscrowDepositInput) (*types.Transaction, error) {
	return _IEscrow.Contract.Deposit(&_IEscrow.TransactOpts, depositInput)
}

// DepositMany is a paid mutator transaction binding the contract method 0x63d478ca.
//
// Solidity: function depositMany((((address,uint256),uint256,uint256),address,(bytes32,string,address,address),bytes,(bytes32,bytes32,address,uint256),bytes)[] depositInputs) returns(bytes32[] depositIds)
func (_IEscrow *IEscrowTransactor) DepositMany(opts *bind.TransactOpts, depositInputs []IEscrowDepositInput) (*types.Transaction, error) {
	return _IEscrow.contract.Transact(opts, "depositMany", depositInputs)
}

// DepositMany is a paid mutator transaction binding the contract method 0x63d478ca.
//
// Solidity: function depositMany((((address,uint256),uint256,uint256),address,(bytes32,string,address,address),bytes,(bytes32,bytes32,address,uint256),bytes)[] depositInputs) returns(bytes32[] depositIds)
func (_IEscrow *IEscrowSession) DepositMany(depositInputs []IEscrowDepositInput) (*types.Transaction, error) {
	return _IEscrow.Contract.DepositMany(&_IEscrow.TransactOpts, depositInputs)
}

// DepositMany is a paid mutator transaction binding the contract method 0x63d478ca.
//
// Solidity: function depositMany((((address,uint256),uint256,uint256),address,(bytes32,string,address,address),bytes,(bytes32,bytes32,address,uint256),bytes)[] depositInputs) returns(bytes32[] depositIds)
func (_IEscrow *IEscrowTransactorSession) DepositMany(depositInputs []IEscrowDepositInput) (*types.Transaction, error) {
	return _IEscrow.Contract.DepositMany(&_IEscrow.TransactOpts, depositInputs)
}

// Refund is a paid mutator transaction binding the contract method 0xeeb69408.
//
// Solidity: function refund(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes) refundInput) returns()
func (_IEscrow *IEscrowTransactor) Refund(opts *bind.TransactOpts, refundInput IEscrowRefundInput) (*types.Transaction, error) {
	return _IEscrow.contract.Transact(opts, "refund", refundInput)
}

// Refund is a paid mutator transaction binding the contract method 0xeeb69408.
//
// Solidity: function refund(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes) refundInput) returns()
func (_IEscrow *IEscrowSession) Refund(refundInput IEscrowRefundInput) (*types.Transaction, error) {
	return _IEscrow.Contract.Refund(&_IEscrow.TransactOpts, refundInput)
}

// Refund is a paid mutator transaction binding the contract method 0xeeb69408.
//
// Solidity: function refund(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes) refundInput) returns()
func (_IEscrow *IEscrowTransactorSession) Refund(refundInput IEscrowRefundInput) (*types.Transaction, error) {
	return _IEscrow.Contract.Refund(&_IEscrow.TransactOpts, refundInput)
}

// RefundMany is a paid mutator transaction binding the contract method 0x165b3f36.
//
// Solidity: function refundMany(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes)[] refundInputs) returns()
func (_IEscrow *IEscrowTransactor) RefundMany(opts *bind.TransactOpts, refundInputs []IEscrowRefundInput) (*types.Transaction, error) {
	return _IEscrow.contract.Transact(opts, "refundMany", refundInputs)
}

// RefundMany is a paid mutator transaction binding the contract method 0x165b3f36.
//
// Solidity: function refundMany(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes)[] refundInputs) returns()
func (_IEscrow *IEscrowSession) RefundMany(refundInputs []IEscrowRefundInput) (*types.Transaction, error) {
	return _IEscrow.Contract.RefundMany(&_IEscrow.TransactOpts, refundInputs)
}

// RefundMany is a paid mutator transaction binding the contract method 0x165b3f36.
//
// Solidity: function refundMany(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes)[] refundInputs) returns()
func (_IEscrow *IEscrowTransactorSession) RefundMany(refundInputs []IEscrowRefundInput) (*types.Transaction, error) {
	return _IEscrow.Contract.RefundMany(&_IEscrow.TransactOpts, refundInputs)
}

// Release is a paid mutator transaction binding the contract method 0xdf851fad.
//
// Solidity: function release(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes) releaseInput) returns()
func (_IEscrow *IEscrowTransactor) Release(opts *bind.TransactOpts, releaseInput IEscrowReleaseInput) (*types.Transaction, error) {
	return _IEscrow.contract.Transact(opts, "release", releaseInput)
}

// Release is a paid mutator transaction binding the contract method 0xdf851fad.
//
// Solidity: function release(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes) releaseInput) returns()
func (_IEscrow *IEscrowSession) Release(releaseInput IEscrowReleaseInput) (*types.Transaction, error) {
	return _IEscrow.Contract.Release(&_IEscrow.TransactOpts, releaseInput)
}

// Release is a paid mutator transaction binding the contract method 0xdf851fad.
//
// Solidity: function release(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes) releaseInput) returns()
func (_IEscrow *IEscrowTransactorSession) Release(releaseInput IEscrowReleaseInput) (*types.Transaction, error) {
	return _IEscrow.Contract.Release(&_IEscrow.TransactOpts, releaseInput)
}

// ReleaseMany is a paid mutator transaction binding the contract method 0x269b634d.
//
// Solidity: function releaseMany(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes)[] releaseInputs) returns()
func (_IEscrow *IEscrowTransactor) ReleaseMany(opts *bind.TransactOpts, releaseInputs []IEscrowReleaseInput) (*types.Transaction, error) {
	return _IEscrow.contract.Transact(opts, "releaseMany", releaseInputs)
}

// ReleaseMany is a paid mutator transaction binding the contract method 0x269b634d.
//
// Solidity: function releaseMany(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes)[] releaseInputs) returns()
func (_IEscrow *IEscrowSession) ReleaseMany(releaseInputs []IEscrowReleaseInput) (*types.Transaction, error) {
	return _IEscrow.Contract.ReleaseMany(&_IEscrow.TransactOpts, releaseInputs)
}

// ReleaseMany is a paid mutator transaction binding the contract method 0x269b634d.
//
// Solidity: function releaseMany(((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address),bytes)[] releaseInputs) returns()
func (_IEscrow *IEscrowTransactorSession) ReleaseMany(releaseInputs []IEscrowReleaseInput) (*types.Transaction, error) {
	return _IEscrow.Contract.ReleaseMany(&_IEscrow.TransactOpts, releaseInputs)
}

// IEscrowDepositCommitmentsIterator is returned from FilterDepositCommitments and is used to iterate over the raw logs and unpacked data for DepositCommitments events raised by the IEscrow contract.
type IEscrowDepositCommitmentsIterator struct {
	Event *IEscrowDepositCommitments // Event containing the contract specifics and raw log

	contract *bind.BoundContract // Generic contract to use for unpacking event data
	event    string              // Event name to use for unpacking event data

	logs chan types.Log        // Log channel receiving the found contract events
	sub  ethereum.Subscription // Subscription for errors, completion and termination
	done bool                  // Whether the subscription completed delivering logs
	fail error                 // Occurred error to stop iteration
}

// Next advances the iterator to the subsequent event, returning whether there
// are any more events found. In case of a retrieval or parsing error, false is
// returned and Error() can be queried for the exact failure.
func (it *IEscrowDepositCommitmentsIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(IEscrowDepositCommitments)
			if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
				it.fail = err
				return false
			}
			it.Event.Raw = log
			return true

		default:
			return false
		}
	}
	// Iterator still in progress, wait for either a data or an error event
	select {
	case log := <-it.logs:
		it.Event = new(IEscrowDepositCommitments)
		if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
			it.fail = err
			return false
		}
		it.Event.Raw = log
		return true

	case err := <-it.sub.Err():
		it.done = true
		it.fail = err
		return it.Next()
	}
}

// Error returns any retrieval or parsing error occurred during filtering.
func (it *IEscrowDepositCommitmentsIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *IEscrowDepositCommitmentsIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// IEscrowDepositCommitments represents a DepositCommitments event raised by the IEscrow contract.
type IEscrowDepositCommitments struct {
	DepositId          [32]byte
	DepositRequestHash [32]byte
	DestinationHash    [32]byte
	Raw                types.Log // Blockchain specific contextual infos
}

// FilterDepositCommitments is a free log retrieval operation binding the contract event 0xdd71cfeda84126f075a6e6c4e6aacadc514806a79f1bccb0619818b7736eefc5.
//
// Solidity: event DepositCommitments(bytes32 indexed depositId, bytes32 depositRequestHash, bytes32 destinationHash)
func (_IEscrow *IEscrowFilterer) FilterDepositCommitments(opts *bind.FilterOpts, depositId [][32]byte) (*IEscrowDepositCommitmentsIterator, error) {

	var depositIdRule []interface{}
	for _, depositIdItem := range depositId {
		depositIdRule = append(depositIdRule, depositIdItem)
	}

	logs, sub, err := _IEscrow.contract.FilterLogs(opts, "DepositCommitments", depositIdRule)
	if err != nil {
		return nil, err
	}
	return &IEscrowDepositCommitmentsIterator{contract: _IEscrow.contract, event: "DepositCommitments", logs: logs, sub: sub}, nil
}

// WatchDepositCommitments is a free log subscription operation binding the contract event 0xdd71cfeda84126f075a6e6c4e6aacadc514806a79f1bccb0619818b7736eefc5.
//
// Solidity: event DepositCommitments(bytes32 indexed depositId, bytes32 depositRequestHash, bytes32 destinationHash)
func (_IEscrow *IEscrowFilterer) WatchDepositCommitments(opts *bind.WatchOpts, sink chan<- *IEscrowDepositCommitments, depositId [][32]byte) (event.Subscription, error) {

	var depositIdRule []interface{}
	for _, depositIdItem := range depositId {
		depositIdRule = append(depositIdRule, depositIdItem)
	}

	logs, sub, err := _IEscrow.contract.WatchLogs(opts, "DepositCommitments", depositIdRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(IEscrowDepositCommitments)
				if err := _IEscrow.contract.UnpackLog(event, "DepositCommitments", log); err != nil {
					return err
				}
				event.Raw = log

				select {
				case sink <- event:
				case err := <-sub.Err():
					return err
				case <-quit:
					return nil
				}
			case err := <-sub.Err():
				return err
			case <-quit:
				return nil
			}
		}
	}), nil
}

// ParseDepositCommitments is a log parse operation binding the contract event 0xdd71cfeda84126f075a6e6c4e6aacadc514806a79f1bccb0619818b7736eefc5.
//
// Solidity: event DepositCommitments(bytes32 indexed depositId, bytes32 depositRequestHash, bytes32 destinationHash)
func (_IEscrow *IEscrowFilterer) ParseDepositCommitments(log types.Log) (*IEscrowDepositCommitments, error) {
	event := new(IEscrowDepositCommitments)
	if err := _IEscrow.contract.UnpackLog(event, "DepositCommitments", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// IEscrowDepositedIterator is returned from FilterDeposited and is used to iterate over the raw logs and unpacked data for Deposited events raised by the IEscrow contract.
type IEscrowDepositedIterator struct {
	Event *IEscrowDeposited // Event containing the contract specifics and raw log

	contract *bind.BoundContract // Generic contract to use for unpacking event data
	event    string              // Event name to use for unpacking event data

	logs chan types.Log        // Log channel receiving the found contract events
	sub  ethereum.Subscription // Subscription for errors, completion and termination
	done bool                  // Whether the subscription completed delivering logs
	fail error                 // Occurred error to stop iteration
}

// Next advances the iterator to the subsequent event, returning whether there
// are any more events found. In case of a retrieval or parsing error, false is
// returned and Error() can be queried for the exact failure.
func (it *IEscrowDepositedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(IEscrowDeposited)
			if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
				it.fail = err
				return false
			}
			it.Event.Raw = log
			return true

		default:
			return false
		}
	}
	// Iterator still in progress, wait for either a data or an error event
	select {
	case log := <-it.logs:
		it.Event = new(IEscrowDeposited)
		if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
			it.fail = err
			return false
		}
		it.Event.Raw = log
		return true

	case err := <-it.sub.Err():
		it.done = true
		it.fail = err
		return it.Next()
	}
}

// Error returns any retrieval or parsing error occurred during filtering.
func (it *IEscrowDepositedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *IEscrowDepositedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// IEscrowDeposited represents a Deposited event raised by the IEscrow contract.
type IEscrowDeposited struct {
	DepositId [32]byte
	QuoteHash [32]byte
	Depositor common.Address
	Settler   common.Address
	Token     common.Address
	Amount    *big.Int
	FeeAmount *big.Int
	Reserver  common.Address
	Releaser  common.Address
	Raw       types.Log // Blockchain specific contextual infos
}

// FilterDeposited is a free log retrieval operation binding the contract event 0x00d99cb530e2d4ecb11da22fd966de4bd68000fdbc6b822f902163642404000e.
//
// Solidity: event Deposited(bytes32 indexed depositId, bytes32 indexed quoteHash, address indexed depositor, address settler, address token, uint256 amount, uint256 feeAmount, address reserver, address releaser)
func (_IEscrow *IEscrowFilterer) FilterDeposited(opts *bind.FilterOpts, depositId [][32]byte, quoteHash [][32]byte, depositor []common.Address) (*IEscrowDepositedIterator, error) {

	var depositIdRule []interface{}
	for _, depositIdItem := range depositId {
		depositIdRule = append(depositIdRule, depositIdItem)
	}
	var quoteHashRule []interface{}
	for _, quoteHashItem := range quoteHash {
		quoteHashRule = append(quoteHashRule, quoteHashItem)
	}
	var depositorRule []interface{}
	for _, depositorItem := range depositor {
		depositorRule = append(depositorRule, depositorItem)
	}

	logs, sub, err := _IEscrow.contract.FilterLogs(opts, "Deposited", depositIdRule, quoteHashRule, depositorRule)
	if err != nil {
		return nil, err
	}
	return &IEscrowDepositedIterator{contract: _IEscrow.contract, event: "Deposited", logs: logs, sub: sub}, nil
}

// WatchDeposited is a free log subscription operation binding the contract event 0x00d99cb530e2d4ecb11da22fd966de4bd68000fdbc6b822f902163642404000e.
//
// Solidity: event Deposited(bytes32 indexed depositId, bytes32 indexed quoteHash, address indexed depositor, address settler, address token, uint256 amount, uint256 feeAmount, address reserver, address releaser)
func (_IEscrow *IEscrowFilterer) WatchDeposited(opts *bind.WatchOpts, sink chan<- *IEscrowDeposited, depositId [][32]byte, quoteHash [][32]byte, depositor []common.Address) (event.Subscription, error) {

	var depositIdRule []interface{}
	for _, depositIdItem := range depositId {
		depositIdRule = append(depositIdRule, depositIdItem)
	}
	var quoteHashRule []interface{}
	for _, quoteHashItem := range quoteHash {
		quoteHashRule = append(quoteHashRule, quoteHashItem)
	}
	var depositorRule []interface{}
	for _, depositorItem := range depositor {
		depositorRule = append(depositorRule, depositorItem)
	}

	logs, sub, err := _IEscrow.contract.WatchLogs(opts, "Deposited", depositIdRule, quoteHashRule, depositorRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(IEscrowDeposited)
				if err := _IEscrow.contract.UnpackLog(event, "Deposited", log); err != nil {
					return err
				}
				event.Raw = log

				select {
				case sink <- event:
				case err := <-sub.Err():
					return err
				case <-quit:
					return nil
				}
			case err := <-sub.Err():
				return err
			case <-quit:
				return nil
			}
		}
	}), nil
}

// ParseDeposited is a log parse operation binding the contract event 0x00d99cb530e2d4ecb11da22fd966de4bd68000fdbc6b822f902163642404000e.
//
// Solidity: event Deposited(bytes32 indexed depositId, bytes32 indexed quoteHash, address indexed depositor, address settler, address token, uint256 amount, uint256 feeAmount, address reserver, address releaser)
func (_IEscrow *IEscrowFilterer) ParseDeposited(log types.Log) (*IEscrowDeposited, error) {
	event := new(IEscrowDeposited)
	if err := _IEscrow.contract.UnpackLog(event, "Deposited", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// IEscrowDepositedManyIterator is returned from FilterDepositedMany and is used to iterate over the raw logs and unpacked data for DepositedMany events raised by the IEscrow contract.
type IEscrowDepositedManyIterator struct {
	Event *IEscrowDepositedMany // Event containing the contract specifics and raw log

	contract *bind.BoundContract // Generic contract to use for unpacking event data
	event    string              // Event name to use for unpacking event data

	logs chan types.Log        // Log channel receiving the found contract events
	sub  ethereum.Subscription // Subscription for errors, completion and termination
	done bool                  // Whether the subscription completed delivering logs
	fail error                 // Occurred error to stop iteration
}

// Next advances the iterator to the subsequent event, returning whether there
// are any more events found. In case of a retrieval or parsing error, false is
// returned and Error() can be queried for the exact failure.
func (it *IEscrowDepositedManyIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(IEscrowDepositedMany)
			if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
				it.fail = err
				return false
			}
			it.Event.Raw = log
			return true

		default:
			return false
		}
	}
	// Iterator still in progress, wait for either a data or an error event
	select {
	case log := <-it.logs:
		it.Event = new(IEscrowDepositedMany)
		if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
			it.fail = err
			return false
		}
		it.Event.Raw = log
		return true

	case err := <-it.sub.Err():
		it.done = true
		it.fail = err
		return it.Next()
	}
}

// Error returns any retrieval or parsing error occurred during filtering.
func (it *IEscrowDepositedManyIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *IEscrowDepositedManyIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// IEscrowDepositedMany represents a DepositedMany event raised by the IEscrow contract.
type IEscrowDepositedMany struct {
	DepositIds       [][32]byte
	DepositWitnesses []IEscrowDepositWitness
	ReserveWitnesses []IEscrowReserveWitness
	FeeAmounts       []*big.Int
	Raw              types.Log // Blockchain specific contextual infos
}

// FilterDepositedMany is a free log retrieval operation binding the contract event 0x837f538e17106ab6df4c0f8a1de4e8127c1dc86827e956daebf9942a0406e2d0.
//
// Solidity: event DepositedMany(bytes32[] depositIds, (bytes32,string,address,address)[] depositWitnesses, (bytes32,bytes32,address,uint256)[] reserveWitnesses, uint256[] feeAmounts)
func (_IEscrow *IEscrowFilterer) FilterDepositedMany(opts *bind.FilterOpts) (*IEscrowDepositedManyIterator, error) {

	logs, sub, err := _IEscrow.contract.FilterLogs(opts, "DepositedMany")
	if err != nil {
		return nil, err
	}
	return &IEscrowDepositedManyIterator{contract: _IEscrow.contract, event: "DepositedMany", logs: logs, sub: sub}, nil
}

// WatchDepositedMany is a free log subscription operation binding the contract event 0x837f538e17106ab6df4c0f8a1de4e8127c1dc86827e956daebf9942a0406e2d0.
//
// Solidity: event DepositedMany(bytes32[] depositIds, (bytes32,string,address,address)[] depositWitnesses, (bytes32,bytes32,address,uint256)[] reserveWitnesses, uint256[] feeAmounts)
func (_IEscrow *IEscrowFilterer) WatchDepositedMany(opts *bind.WatchOpts, sink chan<- *IEscrowDepositedMany) (event.Subscription, error) {

	logs, sub, err := _IEscrow.contract.WatchLogs(opts, "DepositedMany")
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(IEscrowDepositedMany)
				if err := _IEscrow.contract.UnpackLog(event, "DepositedMany", log); err != nil {
					return err
				}
				event.Raw = log

				select {
				case sink <- event:
				case err := <-sub.Err():
					return err
				case <-quit:
					return nil
				}
			case err := <-sub.Err():
				return err
			case <-quit:
				return nil
			}
		}
	}), nil
}

// ParseDepositedMany is a log parse operation binding the contract event 0x837f538e17106ab6df4c0f8a1de4e8127c1dc86827e956daebf9942a0406e2d0.
//
// Solidity: event DepositedMany(bytes32[] depositIds, (bytes32,string,address,address)[] depositWitnesses, (bytes32,bytes32,address,uint256)[] reserveWitnesses, uint256[] feeAmounts)
func (_IEscrow *IEscrowFilterer) ParseDepositedMany(log types.Log) (*IEscrowDepositedMany, error) {
	event := new(IEscrowDepositedMany)
	if err := _IEscrow.contract.UnpackLog(event, "DepositedMany", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// IEscrowRefundedIterator is returned from FilterRefunded and is used to iterate over the raw logs and unpacked data for Refunded events raised by the IEscrow contract.
type IEscrowRefundedIterator struct {
	Event *IEscrowRefunded // Event containing the contract specifics and raw log

	contract *bind.BoundContract // Generic contract to use for unpacking event data
	event    string              // Event name to use for unpacking event data

	logs chan types.Log        // Log channel receiving the found contract events
	sub  ethereum.Subscription // Subscription for errors, completion and termination
	done bool                  // Whether the subscription completed delivering logs
	fail error                 // Occurred error to stop iteration
}

// Next advances the iterator to the subsequent event, returning whether there
// are any more events found. In case of a retrieval or parsing error, false is
// returned and Error() can be queried for the exact failure.
func (it *IEscrowRefundedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(IEscrowRefunded)
			if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
				it.fail = err
				return false
			}
			it.Event.Raw = log
			return true

		default:
			return false
		}
	}
	// Iterator still in progress, wait for either a data or an error event
	select {
	case log := <-it.logs:
		it.Event = new(IEscrowRefunded)
		if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
			it.fail = err
			return false
		}
		it.Event.Raw = log
		return true

	case err := <-it.sub.Err():
		it.done = true
		it.fail = err
		return it.Next()
	}
}

// Error returns any retrieval or parsing error occurred during filtering.
func (it *IEscrowRefundedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *IEscrowRefundedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// IEscrowRefunded represents a Refunded event raised by the IEscrow contract.
type IEscrowRefunded struct {
	DepositId [32]byte
	Depositor common.Address
	Token     common.Address
	Amount    *big.Int
	Raw       types.Log // Blockchain specific contextual infos
}

// FilterRefunded is a free log retrieval operation binding the contract event 0x2e0668a62a5f556368dca9c7113e20f2852c05155548243804bf714ce72b25a6.
//
// Solidity: event Refunded(bytes32 indexed depositId, address indexed depositor, address token, uint256 amount)
func (_IEscrow *IEscrowFilterer) FilterRefunded(opts *bind.FilterOpts, depositId [][32]byte, depositor []common.Address) (*IEscrowRefundedIterator, error) {

	var depositIdRule []interface{}
	for _, depositIdItem := range depositId {
		depositIdRule = append(depositIdRule, depositIdItem)
	}
	var depositorRule []interface{}
	for _, depositorItem := range depositor {
		depositorRule = append(depositorRule, depositorItem)
	}

	logs, sub, err := _IEscrow.contract.FilterLogs(opts, "Refunded", depositIdRule, depositorRule)
	if err != nil {
		return nil, err
	}
	return &IEscrowRefundedIterator{contract: _IEscrow.contract, event: "Refunded", logs: logs, sub: sub}, nil
}

// WatchRefunded is a free log subscription operation binding the contract event 0x2e0668a62a5f556368dca9c7113e20f2852c05155548243804bf714ce72b25a6.
//
// Solidity: event Refunded(bytes32 indexed depositId, address indexed depositor, address token, uint256 amount)
func (_IEscrow *IEscrowFilterer) WatchRefunded(opts *bind.WatchOpts, sink chan<- *IEscrowRefunded, depositId [][32]byte, depositor []common.Address) (event.Subscription, error) {

	var depositIdRule []interface{}
	for _, depositIdItem := range depositId {
		depositIdRule = append(depositIdRule, depositIdItem)
	}
	var depositorRule []interface{}
	for _, depositorItem := range depositor {
		depositorRule = append(depositorRule, depositorItem)
	}

	logs, sub, err := _IEscrow.contract.WatchLogs(opts, "Refunded", depositIdRule, depositorRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(IEscrowRefunded)
				if err := _IEscrow.contract.UnpackLog(event, "Refunded", log); err != nil {
					return err
				}
				event.Raw = log

				select {
				case sink <- event:
				case err := <-sub.Err():
					return err
				case <-quit:
					return nil
				}
			case err := <-sub.Err():
				return err
			case <-quit:
				return nil
			}
		}
	}), nil
}

// ParseRefunded is a log parse operation binding the contract event 0x2e0668a62a5f556368dca9c7113e20f2852c05155548243804bf714ce72b25a6.
//
// Solidity: event Refunded(bytes32 indexed depositId, address indexed depositor, address token, uint256 amount)
func (_IEscrow *IEscrowFilterer) ParseRefunded(log types.Log) (*IEscrowRefunded, error) {
	event := new(IEscrowRefunded)
	if err := _IEscrow.contract.UnpackLog(event, "Refunded", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// IEscrowRefundedManyIterator is returned from FilterRefundedMany and is used to iterate over the raw logs and unpacked data for RefundedMany events raised by the IEscrow contract.
type IEscrowRefundedManyIterator struct {
	Event *IEscrowRefundedMany // Event containing the contract specifics and raw log

	contract *bind.BoundContract // Generic contract to use for unpacking event data
	event    string              // Event name to use for unpacking event data

	logs chan types.Log        // Log channel receiving the found contract events
	sub  ethereum.Subscription // Subscription for errors, completion and termination
	done bool                  // Whether the subscription completed delivering logs
	fail error                 // Occurred error to stop iteration
}

// Next advances the iterator to the subsequent event, returning whether there
// are any more events found. In case of a retrieval or parsing error, false is
// returned and Error() can be queried for the exact failure.
func (it *IEscrowRefundedManyIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(IEscrowRefundedMany)
			if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
				it.fail = err
				return false
			}
			it.Event.Raw = log
			return true

		default:
			return false
		}
	}
	// Iterator still in progress, wait for either a data or an error event
	select {
	case log := <-it.logs:
		it.Event = new(IEscrowRefundedMany)
		if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
			it.fail = err
			return false
		}
		it.Event.Raw = log
		return true

	case err := <-it.sub.Err():
		it.done = true
		it.fail = err
		return it.Next()
	}
}

// Error returns any retrieval or parsing error occurred during filtering.
func (it *IEscrowRefundedManyIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *IEscrowRefundedManyIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// IEscrowRefundedMany represents a RefundedMany event raised by the IEscrow contract.
type IEscrowRefundedMany struct {
	RefundWitnesses []IEscrowRefundWitness
	Raw             types.Log // Blockchain specific contextual infos
}

// FilterRefundedMany is a free log retrieval operation binding the contract event 0x949fa5cc9abe2cf38fdd057482e67cc01d31361a8981e80cc0ac93396ecfa801.
//
// Solidity: event RefundedMany((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address)[] refundWitnesses)
func (_IEscrow *IEscrowFilterer) FilterRefundedMany(opts *bind.FilterOpts) (*IEscrowRefundedManyIterator, error) {

	logs, sub, err := _IEscrow.contract.FilterLogs(opts, "RefundedMany")
	if err != nil {
		return nil, err
	}
	return &IEscrowRefundedManyIterator{contract: _IEscrow.contract, event: "RefundedMany", logs: logs, sub: sub}, nil
}

// WatchRefundedMany is a free log subscription operation binding the contract event 0x949fa5cc9abe2cf38fdd057482e67cc01d31361a8981e80cc0ac93396ecfa801.
//
// Solidity: event RefundedMany((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address)[] refundWitnesses)
func (_IEscrow *IEscrowFilterer) WatchRefundedMany(opts *bind.WatchOpts, sink chan<- *IEscrowRefundedMany) (event.Subscription, error) {

	logs, sub, err := _IEscrow.contract.WatchLogs(opts, "RefundedMany")
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(IEscrowRefundedMany)
				if err := _IEscrow.contract.UnpackLog(event, "RefundedMany", log); err != nil {
					return err
				}
				event.Raw = log

				select {
				case sink <- event:
				case err := <-sub.Err():
					return err
				case <-quit:
					return nil
				}
			case err := <-sub.Err():
				return err
			case <-quit:
				return nil
			}
		}
	}), nil
}

// ParseRefundedMany is a log parse operation binding the contract event 0x949fa5cc9abe2cf38fdd057482e67cc01d31361a8981e80cc0ac93396ecfa801.
//
// Solidity: event RefundedMany((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address)[] refundWitnesses)
func (_IEscrow *IEscrowFilterer) ParseRefundedMany(log types.Log) (*IEscrowRefundedMany, error) {
	event := new(IEscrowRefundedMany)
	if err := _IEscrow.contract.UnpackLog(event, "RefundedMany", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// IEscrowReleasedIterator is returned from FilterReleased and is used to iterate over the raw logs and unpacked data for Released events raised by the IEscrow contract.
type IEscrowReleasedIterator struct {
	Event *IEscrowReleased // Event containing the contract specifics and raw log

	contract *bind.BoundContract // Generic contract to use for unpacking event data
	event    string              // Event name to use for unpacking event data

	logs chan types.Log        // Log channel receiving the found contract events
	sub  ethereum.Subscription // Subscription for errors, completion and termination
	done bool                  // Whether the subscription completed delivering logs
	fail error                 // Occurred error to stop iteration
}

// Next advances the iterator to the subsequent event, returning whether there
// are any more events found. In case of a retrieval or parsing error, false is
// returned and Error() can be queried for the exact failure.
func (it *IEscrowReleasedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(IEscrowReleased)
			if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
				it.fail = err
				return false
			}
			it.Event.Raw = log
			return true

		default:
			return false
		}
	}
	// Iterator still in progress, wait for either a data or an error event
	select {
	case log := <-it.logs:
		it.Event = new(IEscrowReleased)
		if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
			it.fail = err
			return false
		}
		it.Event.Raw = log
		return true

	case err := <-it.sub.Err():
		it.done = true
		it.fail = err
		return it.Next()
	}
}

// Error returns any retrieval or parsing error occurred during filtering.
func (it *IEscrowReleasedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *IEscrowReleasedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// IEscrowReleased represents a Released event raised by the IEscrow contract.
type IEscrowReleased struct {
	DepositId [32]byte
	Settler   common.Address
	Token     common.Address
	Amount    *big.Int
	FeeAmount *big.Int
	Raw       types.Log // Blockchain specific contextual infos
}

// FilterReleased is a free log retrieval operation binding the contract event 0x703d1f677dc7a240b8578621df4ac5a0d8323e943fcc50ce0ffd9dcc8f6974cc.
//
// Solidity: event Released(bytes32 indexed depositId, address indexed settler, address token, uint256 amount, uint256 feeAmount)
func (_IEscrow *IEscrowFilterer) FilterReleased(opts *bind.FilterOpts, depositId [][32]byte, settler []common.Address) (*IEscrowReleasedIterator, error) {

	var depositIdRule []interface{}
	for _, depositIdItem := range depositId {
		depositIdRule = append(depositIdRule, depositIdItem)
	}
	var settlerRule []interface{}
	for _, settlerItem := range settler {
		settlerRule = append(settlerRule, settlerItem)
	}

	logs, sub, err := _IEscrow.contract.FilterLogs(opts, "Released", depositIdRule, settlerRule)
	if err != nil {
		return nil, err
	}
	return &IEscrowReleasedIterator{contract: _IEscrow.contract, event: "Released", logs: logs, sub: sub}, nil
}

// WatchReleased is a free log subscription operation binding the contract event 0x703d1f677dc7a240b8578621df4ac5a0d8323e943fcc50ce0ffd9dcc8f6974cc.
//
// Solidity: event Released(bytes32 indexed depositId, address indexed settler, address token, uint256 amount, uint256 feeAmount)
func (_IEscrow *IEscrowFilterer) WatchReleased(opts *bind.WatchOpts, sink chan<- *IEscrowReleased, depositId [][32]byte, settler []common.Address) (event.Subscription, error) {

	var depositIdRule []interface{}
	for _, depositIdItem := range depositId {
		depositIdRule = append(depositIdRule, depositIdItem)
	}
	var settlerRule []interface{}
	for _, settlerItem := range settler {
		settlerRule = append(settlerRule, settlerItem)
	}

	logs, sub, err := _IEscrow.contract.WatchLogs(opts, "Released", depositIdRule, settlerRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(IEscrowReleased)
				if err := _IEscrow.contract.UnpackLog(event, "Released", log); err != nil {
					return err
				}
				event.Raw = log

				select {
				case sink <- event:
				case err := <-sub.Err():
					return err
				case <-quit:
					return nil
				}
			case err := <-sub.Err():
				return err
			case <-quit:
				return nil
			}
		}
	}), nil
}

// ParseReleased is a log parse operation binding the contract event 0x703d1f677dc7a240b8578621df4ac5a0d8323e943fcc50ce0ffd9dcc8f6974cc.
//
// Solidity: event Released(bytes32 indexed depositId, address indexed settler, address token, uint256 amount, uint256 feeAmount)
func (_IEscrow *IEscrowFilterer) ParseReleased(log types.Log) (*IEscrowReleased, error) {
	event := new(IEscrowReleased)
	if err := _IEscrow.contract.UnpackLog(event, "Released", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// IEscrowReleasedManyIterator is returned from FilterReleasedMany and is used to iterate over the raw logs and unpacked data for ReleasedMany events raised by the IEscrow contract.
type IEscrowReleasedManyIterator struct {
	Event *IEscrowReleasedMany // Event containing the contract specifics and raw log

	contract *bind.BoundContract // Generic contract to use for unpacking event data
	event    string              // Event name to use for unpacking event data

	logs chan types.Log        // Log channel receiving the found contract events
	sub  ethereum.Subscription // Subscription for errors, completion and termination
	done bool                  // Whether the subscription completed delivering logs
	fail error                 // Occurred error to stop iteration
}

// Next advances the iterator to the subsequent event, returning whether there
// are any more events found. In case of a retrieval or parsing error, false is
// returned and Error() can be queried for the exact failure.
func (it *IEscrowReleasedManyIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(IEscrowReleasedMany)
			if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
				it.fail = err
				return false
			}
			it.Event.Raw = log
			return true

		default:
			return false
		}
	}
	// Iterator still in progress, wait for either a data or an error event
	select {
	case log := <-it.logs:
		it.Event = new(IEscrowReleasedMany)
		if err := it.contract.UnpackLog(it.Event, it.event, log); err != nil {
			it.fail = err
			return false
		}
		it.Event.Raw = log
		return true

	case err := <-it.sub.Err():
		it.done = true
		it.fail = err
		return it.Next()
	}
}

// Error returns any retrieval or parsing error occurred during filtering.
func (it *IEscrowReleasedManyIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *IEscrowReleasedManyIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// IEscrowReleasedMany represents a ReleasedMany event raised by the IEscrow contract.
type IEscrowReleasedMany struct {
	ReleaseWitnesses []IEscrowReleaseWitness
	Raw              types.Log // Blockchain specific contextual infos
}

// FilterReleasedMany is a free log retrieval operation binding the contract event 0x63ae99db9a784d0cfddbfc24a172533fca09ed92f286131b04742dbceac30016.
//
// Solidity: event ReleasedMany((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address)[] releaseWitnesses)
func (_IEscrow *IEscrowFilterer) FilterReleasedMany(opts *bind.FilterOpts) (*IEscrowReleasedManyIterator, error) {

	logs, sub, err := _IEscrow.contract.FilterLogs(opts, "ReleasedMany")
	if err != nil {
		return nil, err
	}
	return &IEscrowReleasedManyIterator{contract: _IEscrow.contract, event: "ReleasedMany", logs: logs, sub: sub}, nil
}

// WatchReleasedMany is a free log subscription operation binding the contract event 0x63ae99db9a784d0cfddbfc24a172533fca09ed92f286131b04742dbceac30016.
//
// Solidity: event ReleasedMany((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address)[] releaseWitnesses)
func (_IEscrow *IEscrowFilterer) WatchReleasedMany(opts *bind.WatchOpts, sink chan<- *IEscrowReleasedMany) (event.Subscription, error) {

	logs, sub, err := _IEscrow.contract.WatchLogs(opts, "ReleasedMany")
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(IEscrowReleasedMany)
				if err := _IEscrow.contract.UnpackLog(event, "ReleasedMany", log); err != nil {
					return err
				}
				event.Raw = log

				select {
				case sink <- event:
				case err := <-sub.Err():
					return err
				case <-quit:
					return nil
				}
			case err := <-sub.Err():
				return err
			case <-quit:
				return nil
			}
		}
	}), nil
}

// ParseReleasedMany is a log parse operation binding the contract event 0x63ae99db9a784d0cfddbfc24a172533fca09ed92f286131b04742dbceac30016.
//
// Solidity: event ReleasedMany((bytes32,bytes32,bytes32,bytes32,address,address,uint256,uint256,address,address,address)[] releaseWitnesses)
func (_IEscrow *IEscrowFilterer) ParseReleasedMany(log types.Log) (*IEscrowReleasedMany, error) {
	event := new(IEscrowReleasedMany)
	if err := _IEscrow.contract.UnpackLog(event, "ReleasedMany", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}
