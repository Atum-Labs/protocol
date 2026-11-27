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

// IFulfillmentProxyFulfillment is an auto generated low-level Go binding around an user-defined struct.
type IFulfillmentProxyFulfillment struct {
	QuoteHash [32]byte
	To        common.Address
	Token     common.Address
	Amount    *big.Int
}

// IFulfillmentProxyMetaData contains all meta data concerning the IFulfillmentProxy contract.
var IFulfillmentProxyMetaData = &bind.MetaData{
	ABI: "[{\"type\":\"function\",\"name\":\"authorizeFulfillment\",\"inputs\":[{\"name\":\"quoteHash\",\"type\":\"bytes32\",\"internalType\":\"bytes32\"},{\"name\":\"authorizationHash\",\"type\":\"bytes32\",\"internalType\":\"bytes32\"}],\"outputs\":[],\"stateMutability\":\"nonpayable\"},{\"type\":\"function\",\"name\":\"fulfill\",\"inputs\":[{\"name\":\"params\",\"type\":\"tuple\",\"internalType\":\"structIFulfillmentProxy.Fulfillment\",\"components\":[{\"name\":\"quoteHash\",\"type\":\"bytes32\",\"internalType\":\"bytes32\"},{\"name\":\"to\",\"type\":\"address\",\"internalType\":\"address\"},{\"name\":\"token\",\"type\":\"address\",\"internalType\":\"address\"},{\"name\":\"amount\",\"type\":\"uint256\",\"internalType\":\"uint256\"}]}],\"outputs\":[],\"stateMutability\":\"nonpayable\"},{\"type\":\"function\",\"name\":\"fulfillMany\",\"inputs\":[{\"name\":\"params\",\"type\":\"tuple[]\",\"internalType\":\"structIFulfillmentProxy.Fulfillment[]\",\"components\":[{\"name\":\"quoteHash\",\"type\":\"bytes32\",\"internalType\":\"bytes32\"},{\"name\":\"to\",\"type\":\"address\",\"internalType\":\"address\"},{\"name\":\"token\",\"type\":\"address\",\"internalType\":\"address\"},{\"name\":\"amount\",\"type\":\"uint256\",\"internalType\":\"uint256\"}]}],\"outputs\":[],\"stateMutability\":\"nonpayable\"},{\"type\":\"function\",\"name\":\"setSettlerAllowlistEnforced\",\"inputs\":[{\"name\":\"enforced\",\"type\":\"bool\",\"internalType\":\"bool\"}],\"outputs\":[],\"stateMutability\":\"nonpayable\"},{\"type\":\"function\",\"name\":\"strictFulfill\",\"inputs\":[{\"name\":\"params\",\"type\":\"tuple\",\"internalType\":\"structIFulfillmentProxy.Fulfillment\",\"components\":[{\"name\":\"quoteHash\",\"type\":\"bytes32\",\"internalType\":\"bytes32\"},{\"name\":\"to\",\"type\":\"address\",\"internalType\":\"address\"},{\"name\":\"token\",\"type\":\"address\",\"internalType\":\"address\"},{\"name\":\"amount\",\"type\":\"uint256\",\"internalType\":\"uint256\"}]},{\"name\":\"deadline\",\"type\":\"uint256\",\"internalType\":\"uint256\"}],\"outputs\":[],\"stateMutability\":\"nonpayable\"},{\"type\":\"event\",\"name\":\"Fulfilled\",\"inputs\":[{\"name\":\"quoteHash\",\"type\":\"bytes32\",\"indexed\":true,\"internalType\":\"bytes32\"},{\"name\":\"settler\",\"type\":\"address\",\"indexed\":true,\"internalType\":\"address\"},{\"name\":\"to\",\"type\":\"address\",\"indexed\":false,\"internalType\":\"address\"},{\"name\":\"token\",\"type\":\"address\",\"indexed\":false,\"internalType\":\"address\"},{\"name\":\"amount\",\"type\":\"uint256\",\"indexed\":false,\"internalType\":\"uint256\"},{\"name\":\"timestamp\",\"type\":\"uint256\",\"indexed\":false,\"internalType\":\"uint256\"}],\"anonymous\":false},{\"type\":\"event\",\"name\":\"FulfilledMany\",\"inputs\":[{\"name\":\"fulfillments\",\"type\":\"tuple[]\",\"indexed\":false,\"internalType\":\"structIFulfillmentProxy.Fulfillment[]\",\"components\":[{\"name\":\"quoteHash\",\"type\":\"bytes32\",\"internalType\":\"bytes32\"},{\"name\":\"to\",\"type\":\"address\",\"internalType\":\"address\"},{\"name\":\"token\",\"type\":\"address\",\"internalType\":\"address\"},{\"name\":\"amount\",\"type\":\"uint256\",\"internalType\":\"uint256\"}]},{\"name\":\"settler\",\"type\":\"address\",\"indexed\":true,\"internalType\":\"address\"},{\"name\":\"timestamp\",\"type\":\"uint256\",\"indexed\":false,\"internalType\":\"uint256\"}],\"anonymous\":false},{\"type\":\"event\",\"name\":\"FulfillmentAuthorized\",\"inputs\":[{\"name\":\"authorizationHash\",\"type\":\"bytes32\",\"indexed\":true,\"internalType\":\"bytes32\"},{\"name\":\"quoteHash\",\"type\":\"bytes32\",\"indexed\":true,\"internalType\":\"bytes32\"},{\"name\":\"settler\",\"type\":\"address\",\"indexed\":true,\"internalType\":\"address\"}],\"anonymous\":false},{\"type\":\"event\",\"name\":\"SettlerAllowlistEnforcementSet\",\"inputs\":[{\"name\":\"enforced\",\"type\":\"bool\",\"indexed\":false,\"internalType\":\"bool\"}],\"anonymous\":false},{\"type\":\"error\",\"name\":\"AlreadyFulfilled\",\"inputs\":[{\"name\":\"quoteHash\",\"type\":\"bytes32\",\"internalType\":\"bytes32\"}]},{\"type\":\"error\",\"name\":\"DeadlineExpired\",\"inputs\":[{\"name\":\"deadline\",\"type\":\"uint256\",\"internalType\":\"uint256\"},{\"name\":\"currentTime\",\"type\":\"uint256\",\"internalType\":\"uint256\"}]},{\"type\":\"error\",\"name\":\"EmptyFulfillmentBatch\",\"inputs\":[]},{\"type\":\"error\",\"name\":\"QuoteHashCannotBeEmpty\",\"inputs\":[]},{\"type\":\"error\",\"name\":\"ZeroAmount\",\"inputs\":[]}]",
}

// IFulfillmentProxyABI is the input ABI used to generate the binding from.
// Deprecated: Use IFulfillmentProxyMetaData.ABI instead.
var IFulfillmentProxyABI = IFulfillmentProxyMetaData.ABI

// IFulfillmentProxy is an auto generated Go binding around an Ethereum contract.
type IFulfillmentProxy struct {
	IFulfillmentProxyCaller     // Read-only binding to the contract
	IFulfillmentProxyTransactor // Write-only binding to the contract
	IFulfillmentProxyFilterer   // Log filterer for contract events
}

// IFulfillmentProxyCaller is an auto generated read-only Go binding around an Ethereum contract.
type IFulfillmentProxyCaller struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// IFulfillmentProxyTransactor is an auto generated write-only Go binding around an Ethereum contract.
type IFulfillmentProxyTransactor struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// IFulfillmentProxyFilterer is an auto generated log filtering Go binding around an Ethereum contract events.
type IFulfillmentProxyFilterer struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// IFulfillmentProxySession is an auto generated Go binding around an Ethereum contract,
// with pre-set call and transact options.
type IFulfillmentProxySession struct {
	Contract     *IFulfillmentProxy // Generic contract binding to set the session for
	CallOpts     bind.CallOpts      // Call options to use throughout this session
	TransactOpts bind.TransactOpts  // Transaction auth options to use throughout this session
}

// IFulfillmentProxyCallerSession is an auto generated read-only Go binding around an Ethereum contract,
// with pre-set call options.
type IFulfillmentProxyCallerSession struct {
	Contract *IFulfillmentProxyCaller // Generic contract caller binding to set the session for
	CallOpts bind.CallOpts            // Call options to use throughout this session
}

// IFulfillmentProxyTransactorSession is an auto generated write-only Go binding around an Ethereum contract,
// with pre-set transact options.
type IFulfillmentProxyTransactorSession struct {
	Contract     *IFulfillmentProxyTransactor // Generic contract transactor binding to set the session for
	TransactOpts bind.TransactOpts            // Transaction auth options to use throughout this session
}

// IFulfillmentProxyRaw is an auto generated low-level Go binding around an Ethereum contract.
type IFulfillmentProxyRaw struct {
	Contract *IFulfillmentProxy // Generic contract binding to access the raw methods on
}

// IFulfillmentProxyCallerRaw is an auto generated low-level read-only Go binding around an Ethereum contract.
type IFulfillmentProxyCallerRaw struct {
	Contract *IFulfillmentProxyCaller // Generic read-only contract binding to access the raw methods on
}

// IFulfillmentProxyTransactorRaw is an auto generated low-level write-only Go binding around an Ethereum contract.
type IFulfillmentProxyTransactorRaw struct {
	Contract *IFulfillmentProxyTransactor // Generic write-only contract binding to access the raw methods on
}

// NewIFulfillmentProxy creates a new instance of IFulfillmentProxy, bound to a specific deployed contract.
func NewIFulfillmentProxy(address common.Address, backend bind.ContractBackend) (*IFulfillmentProxy, error) {
	contract, err := bindIFulfillmentProxy(address, backend, backend, backend)
	if err != nil {
		return nil, err
	}
	return &IFulfillmentProxy{IFulfillmentProxyCaller: IFulfillmentProxyCaller{contract: contract}, IFulfillmentProxyTransactor: IFulfillmentProxyTransactor{contract: contract}, IFulfillmentProxyFilterer: IFulfillmentProxyFilterer{contract: contract}}, nil
}

// NewIFulfillmentProxyCaller creates a new read-only instance of IFulfillmentProxy, bound to a specific deployed contract.
func NewIFulfillmentProxyCaller(address common.Address, caller bind.ContractCaller) (*IFulfillmentProxyCaller, error) {
	contract, err := bindIFulfillmentProxy(address, caller, nil, nil)
	if err != nil {
		return nil, err
	}
	return &IFulfillmentProxyCaller{contract: contract}, nil
}

// NewIFulfillmentProxyTransactor creates a new write-only instance of IFulfillmentProxy, bound to a specific deployed contract.
func NewIFulfillmentProxyTransactor(address common.Address, transactor bind.ContractTransactor) (*IFulfillmentProxyTransactor, error) {
	contract, err := bindIFulfillmentProxy(address, nil, transactor, nil)
	if err != nil {
		return nil, err
	}
	return &IFulfillmentProxyTransactor{contract: contract}, nil
}

// NewIFulfillmentProxyFilterer creates a new log filterer instance of IFulfillmentProxy, bound to a specific deployed contract.
func NewIFulfillmentProxyFilterer(address common.Address, filterer bind.ContractFilterer) (*IFulfillmentProxyFilterer, error) {
	contract, err := bindIFulfillmentProxy(address, nil, nil, filterer)
	if err != nil {
		return nil, err
	}
	return &IFulfillmentProxyFilterer{contract: contract}, nil
}

// bindIFulfillmentProxy binds a generic wrapper to an already deployed contract.
func bindIFulfillmentProxy(address common.Address, caller bind.ContractCaller, transactor bind.ContractTransactor, filterer bind.ContractFilterer) (*bind.BoundContract, error) {
	parsed, err := IFulfillmentProxyMetaData.GetAbi()
	if err != nil {
		return nil, err
	}
	return bind.NewBoundContract(address, *parsed, caller, transactor, filterer), nil
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_IFulfillmentProxy *IFulfillmentProxyRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _IFulfillmentProxy.Contract.IFulfillmentProxyCaller.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_IFulfillmentProxy *IFulfillmentProxyRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.IFulfillmentProxyTransactor.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_IFulfillmentProxy *IFulfillmentProxyRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.IFulfillmentProxyTransactor.contract.Transact(opts, method, params...)
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_IFulfillmentProxy *IFulfillmentProxyCallerRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _IFulfillmentProxy.Contract.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_IFulfillmentProxy *IFulfillmentProxyTransactorRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_IFulfillmentProxy *IFulfillmentProxyTransactorRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.contract.Transact(opts, method, params...)
}

// AuthorizeFulfillment is a paid mutator transaction binding the contract method 0x15922c85.
//
// Solidity: function authorizeFulfillment(bytes32 quoteHash, bytes32 authorizationHash) returns()
func (_IFulfillmentProxy *IFulfillmentProxyTransactor) AuthorizeFulfillment(opts *bind.TransactOpts, quoteHash [32]byte, authorizationHash [32]byte) (*types.Transaction, error) {
	return _IFulfillmentProxy.contract.Transact(opts, "authorizeFulfillment", quoteHash, authorizationHash)
}

// AuthorizeFulfillment is a paid mutator transaction binding the contract method 0x15922c85.
//
// Solidity: function authorizeFulfillment(bytes32 quoteHash, bytes32 authorizationHash) returns()
func (_IFulfillmentProxy *IFulfillmentProxySession) AuthorizeFulfillment(quoteHash [32]byte, authorizationHash [32]byte) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.AuthorizeFulfillment(&_IFulfillmentProxy.TransactOpts, quoteHash, authorizationHash)
}

// AuthorizeFulfillment is a paid mutator transaction binding the contract method 0x15922c85.
//
// Solidity: function authorizeFulfillment(bytes32 quoteHash, bytes32 authorizationHash) returns()
func (_IFulfillmentProxy *IFulfillmentProxyTransactorSession) AuthorizeFulfillment(quoteHash [32]byte, authorizationHash [32]byte) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.AuthorizeFulfillment(&_IFulfillmentProxy.TransactOpts, quoteHash, authorizationHash)
}

// Fulfill is a paid mutator transaction binding the contract method 0xf0630329.
//
// Solidity: function fulfill((bytes32,address,address,uint256) params) returns()
func (_IFulfillmentProxy *IFulfillmentProxyTransactor) Fulfill(opts *bind.TransactOpts, params IFulfillmentProxyFulfillment) (*types.Transaction, error) {
	return _IFulfillmentProxy.contract.Transact(opts, "fulfill", params)
}

// Fulfill is a paid mutator transaction binding the contract method 0xf0630329.
//
// Solidity: function fulfill((bytes32,address,address,uint256) params) returns()
func (_IFulfillmentProxy *IFulfillmentProxySession) Fulfill(params IFulfillmentProxyFulfillment) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.Fulfill(&_IFulfillmentProxy.TransactOpts, params)
}

// Fulfill is a paid mutator transaction binding the contract method 0xf0630329.
//
// Solidity: function fulfill((bytes32,address,address,uint256) params) returns()
func (_IFulfillmentProxy *IFulfillmentProxyTransactorSession) Fulfill(params IFulfillmentProxyFulfillment) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.Fulfill(&_IFulfillmentProxy.TransactOpts, params)
}

// FulfillMany is a paid mutator transaction binding the contract method 0xda00124e.
//
// Solidity: function fulfillMany((bytes32,address,address,uint256)[] params) returns()
func (_IFulfillmentProxy *IFulfillmentProxyTransactor) FulfillMany(opts *bind.TransactOpts, params []IFulfillmentProxyFulfillment) (*types.Transaction, error) {
	return _IFulfillmentProxy.contract.Transact(opts, "fulfillMany", params)
}

// FulfillMany is a paid mutator transaction binding the contract method 0xda00124e.
//
// Solidity: function fulfillMany((bytes32,address,address,uint256)[] params) returns()
func (_IFulfillmentProxy *IFulfillmentProxySession) FulfillMany(params []IFulfillmentProxyFulfillment) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.FulfillMany(&_IFulfillmentProxy.TransactOpts, params)
}

// FulfillMany is a paid mutator transaction binding the contract method 0xda00124e.
//
// Solidity: function fulfillMany((bytes32,address,address,uint256)[] params) returns()
func (_IFulfillmentProxy *IFulfillmentProxyTransactorSession) FulfillMany(params []IFulfillmentProxyFulfillment) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.FulfillMany(&_IFulfillmentProxy.TransactOpts, params)
}

// SetSettlerAllowlistEnforced is a paid mutator transaction binding the contract method 0x76573485.
//
// Solidity: function setSettlerAllowlistEnforced(bool enforced) returns()
func (_IFulfillmentProxy *IFulfillmentProxyTransactor) SetSettlerAllowlistEnforced(opts *bind.TransactOpts, enforced bool) (*types.Transaction, error) {
	return _IFulfillmentProxy.contract.Transact(opts, "setSettlerAllowlistEnforced", enforced)
}

// SetSettlerAllowlistEnforced is a paid mutator transaction binding the contract method 0x76573485.
//
// Solidity: function setSettlerAllowlistEnforced(bool enforced) returns()
func (_IFulfillmentProxy *IFulfillmentProxySession) SetSettlerAllowlistEnforced(enforced bool) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.SetSettlerAllowlistEnforced(&_IFulfillmentProxy.TransactOpts, enforced)
}

// SetSettlerAllowlistEnforced is a paid mutator transaction binding the contract method 0x76573485.
//
// Solidity: function setSettlerAllowlistEnforced(bool enforced) returns()
func (_IFulfillmentProxy *IFulfillmentProxyTransactorSession) SetSettlerAllowlistEnforced(enforced bool) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.SetSettlerAllowlistEnforced(&_IFulfillmentProxy.TransactOpts, enforced)
}

// StrictFulfill is a paid mutator transaction binding the contract method 0x7905fbfa.
//
// Solidity: function strictFulfill((bytes32,address,address,uint256) params, uint256 deadline) returns()
func (_IFulfillmentProxy *IFulfillmentProxyTransactor) StrictFulfill(opts *bind.TransactOpts, params IFulfillmentProxyFulfillment, deadline *big.Int) (*types.Transaction, error) {
	return _IFulfillmentProxy.contract.Transact(opts, "strictFulfill", params, deadline)
}

// StrictFulfill is a paid mutator transaction binding the contract method 0x7905fbfa.
//
// Solidity: function strictFulfill((bytes32,address,address,uint256) params, uint256 deadline) returns()
func (_IFulfillmentProxy *IFulfillmentProxySession) StrictFulfill(params IFulfillmentProxyFulfillment, deadline *big.Int) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.StrictFulfill(&_IFulfillmentProxy.TransactOpts, params, deadline)
}

// StrictFulfill is a paid mutator transaction binding the contract method 0x7905fbfa.
//
// Solidity: function strictFulfill((bytes32,address,address,uint256) params, uint256 deadline) returns()
func (_IFulfillmentProxy *IFulfillmentProxyTransactorSession) StrictFulfill(params IFulfillmentProxyFulfillment, deadline *big.Int) (*types.Transaction, error) {
	return _IFulfillmentProxy.Contract.StrictFulfill(&_IFulfillmentProxy.TransactOpts, params, deadline)
}

// IFulfillmentProxyFulfilledIterator is returned from FilterFulfilled and is used to iterate over the raw logs and unpacked data for Fulfilled events raised by the IFulfillmentProxy contract.
type IFulfillmentProxyFulfilledIterator struct {
	Event *IFulfillmentProxyFulfilled // Event containing the contract specifics and raw log

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
func (it *IFulfillmentProxyFulfilledIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(IFulfillmentProxyFulfilled)
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
		it.Event = new(IFulfillmentProxyFulfilled)
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
func (it *IFulfillmentProxyFulfilledIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *IFulfillmentProxyFulfilledIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// IFulfillmentProxyFulfilled represents a Fulfilled event raised by the IFulfillmentProxy contract.
type IFulfillmentProxyFulfilled struct {
	QuoteHash [32]byte
	Settler   common.Address
	To        common.Address
	Token     common.Address
	Amount    *big.Int
	Timestamp *big.Int
	Raw       types.Log // Blockchain specific contextual infos
}

// FilterFulfilled is a free log retrieval operation binding the contract event 0x6344d803114225f61bd0be81b7f0810daff32f11666c3e6e0f51e50a8c7450f2.
//
// Solidity: event Fulfilled(bytes32 indexed quoteHash, address indexed settler, address to, address token, uint256 amount, uint256 timestamp)
func (_IFulfillmentProxy *IFulfillmentProxyFilterer) FilterFulfilled(opts *bind.FilterOpts, quoteHash [][32]byte, settler []common.Address) (*IFulfillmentProxyFulfilledIterator, error) {

	var quoteHashRule []interface{}
	for _, quoteHashItem := range quoteHash {
		quoteHashRule = append(quoteHashRule, quoteHashItem)
	}
	var settlerRule []interface{}
	for _, settlerItem := range settler {
		settlerRule = append(settlerRule, settlerItem)
	}

	logs, sub, err := _IFulfillmentProxy.contract.FilterLogs(opts, "Fulfilled", quoteHashRule, settlerRule)
	if err != nil {
		return nil, err
	}
	return &IFulfillmentProxyFulfilledIterator{contract: _IFulfillmentProxy.contract, event: "Fulfilled", logs: logs, sub: sub}, nil
}

// WatchFulfilled is a free log subscription operation binding the contract event 0x6344d803114225f61bd0be81b7f0810daff32f11666c3e6e0f51e50a8c7450f2.
//
// Solidity: event Fulfilled(bytes32 indexed quoteHash, address indexed settler, address to, address token, uint256 amount, uint256 timestamp)
func (_IFulfillmentProxy *IFulfillmentProxyFilterer) WatchFulfilled(opts *bind.WatchOpts, sink chan<- *IFulfillmentProxyFulfilled, quoteHash [][32]byte, settler []common.Address) (event.Subscription, error) {

	var quoteHashRule []interface{}
	for _, quoteHashItem := range quoteHash {
		quoteHashRule = append(quoteHashRule, quoteHashItem)
	}
	var settlerRule []interface{}
	for _, settlerItem := range settler {
		settlerRule = append(settlerRule, settlerItem)
	}

	logs, sub, err := _IFulfillmentProxy.contract.WatchLogs(opts, "Fulfilled", quoteHashRule, settlerRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(IFulfillmentProxyFulfilled)
				if err := _IFulfillmentProxy.contract.UnpackLog(event, "Fulfilled", log); err != nil {
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

// ParseFulfilled is a log parse operation binding the contract event 0x6344d803114225f61bd0be81b7f0810daff32f11666c3e6e0f51e50a8c7450f2.
//
// Solidity: event Fulfilled(bytes32 indexed quoteHash, address indexed settler, address to, address token, uint256 amount, uint256 timestamp)
func (_IFulfillmentProxy *IFulfillmentProxyFilterer) ParseFulfilled(log types.Log) (*IFulfillmentProxyFulfilled, error) {
	event := new(IFulfillmentProxyFulfilled)
	if err := _IFulfillmentProxy.contract.UnpackLog(event, "Fulfilled", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// IFulfillmentProxyFulfilledManyIterator is returned from FilterFulfilledMany and is used to iterate over the raw logs and unpacked data for FulfilledMany events raised by the IFulfillmentProxy contract.
type IFulfillmentProxyFulfilledManyIterator struct {
	Event *IFulfillmentProxyFulfilledMany // Event containing the contract specifics and raw log

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
func (it *IFulfillmentProxyFulfilledManyIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(IFulfillmentProxyFulfilledMany)
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
		it.Event = new(IFulfillmentProxyFulfilledMany)
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
func (it *IFulfillmentProxyFulfilledManyIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *IFulfillmentProxyFulfilledManyIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// IFulfillmentProxyFulfilledMany represents a FulfilledMany event raised by the IFulfillmentProxy contract.
type IFulfillmentProxyFulfilledMany struct {
	Fulfillments []IFulfillmentProxyFulfillment
	Settler      common.Address
	Timestamp    *big.Int
	Raw          types.Log // Blockchain specific contextual infos
}

// FilterFulfilledMany is a free log retrieval operation binding the contract event 0xa55853fe36e243bbd57e73a1582a883508e206be6fce5a8f07e29cb0808959b5.
//
// Solidity: event FulfilledMany((bytes32,address,address,uint256)[] fulfillments, address indexed settler, uint256 timestamp)
func (_IFulfillmentProxy *IFulfillmentProxyFilterer) FilterFulfilledMany(opts *bind.FilterOpts, settler []common.Address) (*IFulfillmentProxyFulfilledManyIterator, error) {

	var settlerRule []interface{}
	for _, settlerItem := range settler {
		settlerRule = append(settlerRule, settlerItem)
	}

	logs, sub, err := _IFulfillmentProxy.contract.FilterLogs(opts, "FulfilledMany", settlerRule)
	if err != nil {
		return nil, err
	}
	return &IFulfillmentProxyFulfilledManyIterator{contract: _IFulfillmentProxy.contract, event: "FulfilledMany", logs: logs, sub: sub}, nil
}

// WatchFulfilledMany is a free log subscription operation binding the contract event 0xa55853fe36e243bbd57e73a1582a883508e206be6fce5a8f07e29cb0808959b5.
//
// Solidity: event FulfilledMany((bytes32,address,address,uint256)[] fulfillments, address indexed settler, uint256 timestamp)
func (_IFulfillmentProxy *IFulfillmentProxyFilterer) WatchFulfilledMany(opts *bind.WatchOpts, sink chan<- *IFulfillmentProxyFulfilledMany, settler []common.Address) (event.Subscription, error) {

	var settlerRule []interface{}
	for _, settlerItem := range settler {
		settlerRule = append(settlerRule, settlerItem)
	}

	logs, sub, err := _IFulfillmentProxy.contract.WatchLogs(opts, "FulfilledMany", settlerRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(IFulfillmentProxyFulfilledMany)
				if err := _IFulfillmentProxy.contract.UnpackLog(event, "FulfilledMany", log); err != nil {
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

// ParseFulfilledMany is a log parse operation binding the contract event 0xa55853fe36e243bbd57e73a1582a883508e206be6fce5a8f07e29cb0808959b5.
//
// Solidity: event FulfilledMany((bytes32,address,address,uint256)[] fulfillments, address indexed settler, uint256 timestamp)
func (_IFulfillmentProxy *IFulfillmentProxyFilterer) ParseFulfilledMany(log types.Log) (*IFulfillmentProxyFulfilledMany, error) {
	event := new(IFulfillmentProxyFulfilledMany)
	if err := _IFulfillmentProxy.contract.UnpackLog(event, "FulfilledMany", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// IFulfillmentProxyFulfillmentAuthorizedIterator is returned from FilterFulfillmentAuthorized and is used to iterate over the raw logs and unpacked data for FulfillmentAuthorized events raised by the IFulfillmentProxy contract.
type IFulfillmentProxyFulfillmentAuthorizedIterator struct {
	Event *IFulfillmentProxyFulfillmentAuthorized // Event containing the contract specifics and raw log

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
func (it *IFulfillmentProxyFulfillmentAuthorizedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(IFulfillmentProxyFulfillmentAuthorized)
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
		it.Event = new(IFulfillmentProxyFulfillmentAuthorized)
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
func (it *IFulfillmentProxyFulfillmentAuthorizedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *IFulfillmentProxyFulfillmentAuthorizedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// IFulfillmentProxyFulfillmentAuthorized represents a FulfillmentAuthorized event raised by the IFulfillmentProxy contract.
type IFulfillmentProxyFulfillmentAuthorized struct {
	AuthorizationHash [32]byte
	QuoteHash         [32]byte
	Settler           common.Address
	Raw               types.Log // Blockchain specific contextual infos
}

// FilterFulfillmentAuthorized is a free log retrieval operation binding the contract event 0xf2a1b3ad292e8363fb70c5ae2b93b3d782e205e51818eabfe90265d4201a2cc5.
//
// Solidity: event FulfillmentAuthorized(bytes32 indexed authorizationHash, bytes32 indexed quoteHash, address indexed settler)
func (_IFulfillmentProxy *IFulfillmentProxyFilterer) FilterFulfillmentAuthorized(opts *bind.FilterOpts, authorizationHash [][32]byte, quoteHash [][32]byte, settler []common.Address) (*IFulfillmentProxyFulfillmentAuthorizedIterator, error) {

	var authorizationHashRule []interface{}
	for _, authorizationHashItem := range authorizationHash {
		authorizationHashRule = append(authorizationHashRule, authorizationHashItem)
	}
	var quoteHashRule []interface{}
	for _, quoteHashItem := range quoteHash {
		quoteHashRule = append(quoteHashRule, quoteHashItem)
	}
	var settlerRule []interface{}
	for _, settlerItem := range settler {
		settlerRule = append(settlerRule, settlerItem)
	}

	logs, sub, err := _IFulfillmentProxy.contract.FilterLogs(opts, "FulfillmentAuthorized", authorizationHashRule, quoteHashRule, settlerRule)
	if err != nil {
		return nil, err
	}
	return &IFulfillmentProxyFulfillmentAuthorizedIterator{contract: _IFulfillmentProxy.contract, event: "FulfillmentAuthorized", logs: logs, sub: sub}, nil
}

// WatchFulfillmentAuthorized is a free log subscription operation binding the contract event 0xf2a1b3ad292e8363fb70c5ae2b93b3d782e205e51818eabfe90265d4201a2cc5.
//
// Solidity: event FulfillmentAuthorized(bytes32 indexed authorizationHash, bytes32 indexed quoteHash, address indexed settler)
func (_IFulfillmentProxy *IFulfillmentProxyFilterer) WatchFulfillmentAuthorized(opts *bind.WatchOpts, sink chan<- *IFulfillmentProxyFulfillmentAuthorized, authorizationHash [][32]byte, quoteHash [][32]byte, settler []common.Address) (event.Subscription, error) {

	var authorizationHashRule []interface{}
	for _, authorizationHashItem := range authorizationHash {
		authorizationHashRule = append(authorizationHashRule, authorizationHashItem)
	}
	var quoteHashRule []interface{}
	for _, quoteHashItem := range quoteHash {
		quoteHashRule = append(quoteHashRule, quoteHashItem)
	}
	var settlerRule []interface{}
	for _, settlerItem := range settler {
		settlerRule = append(settlerRule, settlerItem)
	}

	logs, sub, err := _IFulfillmentProxy.contract.WatchLogs(opts, "FulfillmentAuthorized", authorizationHashRule, quoteHashRule, settlerRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(IFulfillmentProxyFulfillmentAuthorized)
				if err := _IFulfillmentProxy.contract.UnpackLog(event, "FulfillmentAuthorized", log); err != nil {
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

// ParseFulfillmentAuthorized is a log parse operation binding the contract event 0xf2a1b3ad292e8363fb70c5ae2b93b3d782e205e51818eabfe90265d4201a2cc5.
//
// Solidity: event FulfillmentAuthorized(bytes32 indexed authorizationHash, bytes32 indexed quoteHash, address indexed settler)
func (_IFulfillmentProxy *IFulfillmentProxyFilterer) ParseFulfillmentAuthorized(log types.Log) (*IFulfillmentProxyFulfillmentAuthorized, error) {
	event := new(IFulfillmentProxyFulfillmentAuthorized)
	if err := _IFulfillmentProxy.contract.UnpackLog(event, "FulfillmentAuthorized", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// IFulfillmentProxySettlerAllowlistEnforcementSetIterator is returned from FilterSettlerAllowlistEnforcementSet and is used to iterate over the raw logs and unpacked data for SettlerAllowlistEnforcementSet events raised by the IFulfillmentProxy contract.
type IFulfillmentProxySettlerAllowlistEnforcementSetIterator struct {
	Event *IFulfillmentProxySettlerAllowlistEnforcementSet // Event containing the contract specifics and raw log

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
func (it *IFulfillmentProxySettlerAllowlistEnforcementSetIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(IFulfillmentProxySettlerAllowlistEnforcementSet)
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
		it.Event = new(IFulfillmentProxySettlerAllowlistEnforcementSet)
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
func (it *IFulfillmentProxySettlerAllowlistEnforcementSetIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *IFulfillmentProxySettlerAllowlistEnforcementSetIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// IFulfillmentProxySettlerAllowlistEnforcementSet represents a SettlerAllowlistEnforcementSet event raised by the IFulfillmentProxy contract.
type IFulfillmentProxySettlerAllowlistEnforcementSet struct {
	Enforced bool
	Raw      types.Log // Blockchain specific contextual infos
}

// FilterSettlerAllowlistEnforcementSet is a free log retrieval operation binding the contract event 0x86330013ac079c8cb36d0e3bc6a0faa3f21f62de7570ea02aa265464cfc43854.
//
// Solidity: event SettlerAllowlistEnforcementSet(bool enforced)
func (_IFulfillmentProxy *IFulfillmentProxyFilterer) FilterSettlerAllowlistEnforcementSet(opts *bind.FilterOpts) (*IFulfillmentProxySettlerAllowlistEnforcementSetIterator, error) {

	logs, sub, err := _IFulfillmentProxy.contract.FilterLogs(opts, "SettlerAllowlistEnforcementSet")
	if err != nil {
		return nil, err
	}
	return &IFulfillmentProxySettlerAllowlistEnforcementSetIterator{contract: _IFulfillmentProxy.contract, event: "SettlerAllowlistEnforcementSet", logs: logs, sub: sub}, nil
}

// WatchSettlerAllowlistEnforcementSet is a free log subscription operation binding the contract event 0x86330013ac079c8cb36d0e3bc6a0faa3f21f62de7570ea02aa265464cfc43854.
//
// Solidity: event SettlerAllowlistEnforcementSet(bool enforced)
func (_IFulfillmentProxy *IFulfillmentProxyFilterer) WatchSettlerAllowlistEnforcementSet(opts *bind.WatchOpts, sink chan<- *IFulfillmentProxySettlerAllowlistEnforcementSet) (event.Subscription, error) {

	logs, sub, err := _IFulfillmentProxy.contract.WatchLogs(opts, "SettlerAllowlistEnforcementSet")
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(IFulfillmentProxySettlerAllowlistEnforcementSet)
				if err := _IFulfillmentProxy.contract.UnpackLog(event, "SettlerAllowlistEnforcementSet", log); err != nil {
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

// ParseSettlerAllowlistEnforcementSet is a log parse operation binding the contract event 0x86330013ac079c8cb36d0e3bc6a0faa3f21f62de7570ea02aa265464cfc43854.
//
// Solidity: event SettlerAllowlistEnforcementSet(bool enforced)
func (_IFulfillmentProxy *IFulfillmentProxyFilterer) ParseSettlerAllowlistEnforcementSet(log types.Log) (*IFulfillmentProxySettlerAllowlistEnforcementSet, error) {
	event := new(IFulfillmentProxySettlerAllowlistEnforcementSet)
	if err := _IFulfillmentProxy.contract.UnpackLog(event, "SettlerAllowlistEnforcementSet", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}
