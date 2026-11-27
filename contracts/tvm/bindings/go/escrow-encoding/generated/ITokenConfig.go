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

// ITokenConfigTokenConfig is an auto generated low-level Go binding around an user-defined struct.
type ITokenConfigTokenConfig struct {
	FeePercentage6Decimals *big.Int
	MaxFee6Decimals        *big.Int
	MinFee6Decimals        *big.Int
	TokenDecimals          uint8
}

// ITokenConfigMetaData contains all meta data concerning the ITokenConfig contract.
var ITokenConfigMetaData = &bind.MetaData{
	ABI: "[{\"inputs\":[{\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"}],\"name\":\"CouldNotDisallowToken\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"},{\"internalType\":\"uint256\",\"name\":\"feeAmount\",\"type\":\"uint256\"}],\"name\":\"FeeExceedsDepositAmount\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"FeePercentageCannotBeZeroWhenMaxFeeIsSet\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"uint88\",\"name\":\"feePercentage6Decimals\",\"type\":\"uint88\"}],\"name\":\"FeePercentageExceedsMaximum\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"uint80\",\"name\":\"maxFee6Decimals\",\"type\":\"uint80\"},{\"internalType\":\"uint8\",\"name\":\"tokenDecimals\",\"type\":\"uint8\"}],\"name\":\"MaxFeeNotRepresentable\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"MinFeeCannotBeGreaterThanMaxFee\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"uint80\",\"name\":\"minFee6Decimals\",\"type\":\"uint80\"},{\"internalType\":\"uint8\",\"name\":\"tokenDecimals\",\"type\":\"uint8\"}],\"name\":\"MinFeeNotRepresentable\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"}],\"name\":\"NoFeesToWithdraw\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"RecipientCannotBeSelf\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"RecipientCannotBeZeroAddress\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"}],\"name\":\"TokenAlreadyAllowed\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"TokenCannotBeZeroAddress\",\"type\":\"error\"},{\"inputs\":[],\"name\":\"TokenDecimalsCannotBeZero\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"uint8\",\"name\":\"decimals\",\"type\":\"uint8\"},{\"internalType\":\"uint8\",\"name\":\"maximum\",\"type\":\"uint8\"}],\"name\":\"TokenDecimalsExceedMaximum\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"uint8\",\"name\":\"provided\",\"type\":\"uint8\"},{\"internalType\":\"uint8\",\"name\":\"actual\",\"type\":\"uint8\"}],\"name\":\"TokenDecimalsMismatch\",\"type\":\"error\"},{\"inputs\":[{\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"}],\"name\":\"TokenNotAllowed\",\"type\":\"error\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"},{\"indexed\":true,\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"}],\"name\":\"FeeRevenueWithdrawn\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"uint8\",\"name\":\"decimals\",\"type\":\"uint8\"}],\"name\":\"TokenAllowed\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"}],\"name\":\"TokenDisallowed\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"}],\"name\":\"TokenFeesCleared\",\"type\":\"event\"},{\"anonymous\":false,\"inputs\":[{\"indexed\":true,\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"},{\"indexed\":false,\"internalType\":\"uint88\",\"name\":\"feePercentage\",\"type\":\"uint88\"},{\"indexed\":false,\"internalType\":\"uint80\",\"name\":\"minFee\",\"type\":\"uint80\"},{\"indexed\":false,\"internalType\":\"uint80\",\"name\":\"maxFee\",\"type\":\"uint80\"}],\"name\":\"TokenFeesUpdated\",\"type\":\"event\"},{\"inputs\":[{\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"},{\"internalType\":\"uint8\",\"name\":\"decimals\",\"type\":\"uint8\"}],\"name\":\"allowToken\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"},{\"internalType\":\"uint8\",\"name\":\"decimals\",\"type\":\"uint8\"},{\"internalType\":\"uint88\",\"name\":\"feePercentage\",\"type\":\"uint88\"},{\"internalType\":\"uint80\",\"name\":\"minFee\",\"type\":\"uint80\"},{\"internalType\":\"uint80\",\"name\":\"maxFee\",\"type\":\"uint80\"}],\"name\":\"allowTokenAndSetFeeConfig\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"}],\"name\":\"clearTokenFeeConfig\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"},{\"components\":[{\"internalType\":\"uint88\",\"name\":\"feePercentage6Decimals\",\"type\":\"uint88\"},{\"internalType\":\"uint80\",\"name\":\"maxFee6Decimals\",\"type\":\"uint80\"},{\"internalType\":\"uint80\",\"name\":\"minFee6Decimals\",\"type\":\"uint80\"},{\"internalType\":\"uint8\",\"name\":\"tokenDecimals\",\"type\":\"uint8\"}],\"internalType\":\"structITokenConfig.TokenConfig\",\"name\":\"tokenConfig\",\"type\":\"tuple\"}],\"name\":\"determineFee\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"feeAmount\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"}],\"name\":\"disallowToken\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"getAllowedTokens\",\"outputs\":[{\"internalType\":\"contractIERC20[]\",\"name\":\"allowedTokens\",\"type\":\"address[]\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"}],\"name\":\"getFeeRevenue\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"revenue\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"}],\"name\":\"getTokenConfig\",\"outputs\":[{\"components\":[{\"internalType\":\"uint88\",\"name\":\"feePercentage6Decimals\",\"type\":\"uint88\"},{\"internalType\":\"uint80\",\"name\":\"maxFee6Decimals\",\"type\":\"uint80\"},{\"internalType\":\"uint80\",\"name\":\"minFee6Decimals\",\"type\":\"uint80\"},{\"internalType\":\"uint8\",\"name\":\"tokenDecimals\",\"type\":\"uint8\"}],\"internalType\":\"structITokenConfig.TokenConfig\",\"name\":\"tokenConfig\",\"type\":\"tuple\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"}],\"name\":\"isTokenAllowed\",\"outputs\":[{\"internalType\":\"bool\",\"name\":\"isAllowed\",\"type\":\"bool\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"},{\"internalType\":\"uint88\",\"name\":\"feePercentage\",\"type\":\"uint88\"},{\"internalType\":\"uint80\",\"name\":\"minFee\",\"type\":\"uint80\"},{\"internalType\":\"uint80\",\"name\":\"maxFee\",\"type\":\"uint80\"}],\"name\":\"setTokenFeeConfig\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"contractIERC20\",\"name\":\"token\",\"type\":\"address\"},{\"internalType\":\"address\",\"name\":\"recipient\",\"type\":\"address\"}],\"name\":\"withdrawFeeRevenue\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"}]",
}

// ITokenConfigABI is the input ABI used to generate the binding from.
// Deprecated: Use ITokenConfigMetaData.ABI instead.
var ITokenConfigABI = ITokenConfigMetaData.ABI

// ITokenConfig is an auto generated Go binding around an Ethereum contract.
type ITokenConfig struct {
	ITokenConfigCaller     // Read-only binding to the contract
	ITokenConfigTransactor // Write-only binding to the contract
	ITokenConfigFilterer   // Log filterer for contract events
}

// ITokenConfigCaller is an auto generated read-only Go binding around an Ethereum contract.
type ITokenConfigCaller struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// ITokenConfigTransactor is an auto generated write-only Go binding around an Ethereum contract.
type ITokenConfigTransactor struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// ITokenConfigFilterer is an auto generated log filtering Go binding around an Ethereum contract events.
type ITokenConfigFilterer struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// ITokenConfigSession is an auto generated Go binding around an Ethereum contract,
// with pre-set call and transact options.
type ITokenConfigSession struct {
	Contract     *ITokenConfig     // Generic contract binding to set the session for
	CallOpts     bind.CallOpts     // Call options to use throughout this session
	TransactOpts bind.TransactOpts // Transaction auth options to use throughout this session
}

// ITokenConfigCallerSession is an auto generated read-only Go binding around an Ethereum contract,
// with pre-set call options.
type ITokenConfigCallerSession struct {
	Contract *ITokenConfigCaller // Generic contract caller binding to set the session for
	CallOpts bind.CallOpts       // Call options to use throughout this session
}

// ITokenConfigTransactorSession is an auto generated write-only Go binding around an Ethereum contract,
// with pre-set transact options.
type ITokenConfigTransactorSession struct {
	Contract     *ITokenConfigTransactor // Generic contract transactor binding to set the session for
	TransactOpts bind.TransactOpts       // Transaction auth options to use throughout this session
}

// ITokenConfigRaw is an auto generated low-level Go binding around an Ethereum contract.
type ITokenConfigRaw struct {
	Contract *ITokenConfig // Generic contract binding to access the raw methods on
}

// ITokenConfigCallerRaw is an auto generated low-level read-only Go binding around an Ethereum contract.
type ITokenConfigCallerRaw struct {
	Contract *ITokenConfigCaller // Generic read-only contract binding to access the raw methods on
}

// ITokenConfigTransactorRaw is an auto generated low-level write-only Go binding around an Ethereum contract.
type ITokenConfigTransactorRaw struct {
	Contract *ITokenConfigTransactor // Generic write-only contract binding to access the raw methods on
}

// NewITokenConfig creates a new instance of ITokenConfig, bound to a specific deployed contract.
func NewITokenConfig(address common.Address, backend bind.ContractBackend) (*ITokenConfig, error) {
	contract, err := bindITokenConfig(address, backend, backend, backend)
	if err != nil {
		return nil, err
	}
	return &ITokenConfig{ITokenConfigCaller: ITokenConfigCaller{contract: contract}, ITokenConfigTransactor: ITokenConfigTransactor{contract: contract}, ITokenConfigFilterer: ITokenConfigFilterer{contract: contract}}, nil
}

// NewITokenConfigCaller creates a new read-only instance of ITokenConfig, bound to a specific deployed contract.
func NewITokenConfigCaller(address common.Address, caller bind.ContractCaller) (*ITokenConfigCaller, error) {
	contract, err := bindITokenConfig(address, caller, nil, nil)
	if err != nil {
		return nil, err
	}
	return &ITokenConfigCaller{contract: contract}, nil
}

// NewITokenConfigTransactor creates a new write-only instance of ITokenConfig, bound to a specific deployed contract.
func NewITokenConfigTransactor(address common.Address, transactor bind.ContractTransactor) (*ITokenConfigTransactor, error) {
	contract, err := bindITokenConfig(address, nil, transactor, nil)
	if err != nil {
		return nil, err
	}
	return &ITokenConfigTransactor{contract: contract}, nil
}

// NewITokenConfigFilterer creates a new log filterer instance of ITokenConfig, bound to a specific deployed contract.
func NewITokenConfigFilterer(address common.Address, filterer bind.ContractFilterer) (*ITokenConfigFilterer, error) {
	contract, err := bindITokenConfig(address, nil, nil, filterer)
	if err != nil {
		return nil, err
	}
	return &ITokenConfigFilterer{contract: contract}, nil
}

// bindITokenConfig binds a generic wrapper to an already deployed contract.
func bindITokenConfig(address common.Address, caller bind.ContractCaller, transactor bind.ContractTransactor, filterer bind.ContractFilterer) (*bind.BoundContract, error) {
	parsed, err := ITokenConfigMetaData.GetAbi()
	if err != nil {
		return nil, err
	}
	return bind.NewBoundContract(address, *parsed, caller, transactor, filterer), nil
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_ITokenConfig *ITokenConfigRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _ITokenConfig.Contract.ITokenConfigCaller.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_ITokenConfig *ITokenConfigRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _ITokenConfig.Contract.ITokenConfigTransactor.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_ITokenConfig *ITokenConfigRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _ITokenConfig.Contract.ITokenConfigTransactor.contract.Transact(opts, method, params...)
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_ITokenConfig *ITokenConfigCallerRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _ITokenConfig.Contract.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_ITokenConfig *ITokenConfigTransactorRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _ITokenConfig.Contract.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_ITokenConfig *ITokenConfigTransactorRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _ITokenConfig.Contract.contract.Transact(opts, method, params...)
}

// DetermineFee is a free data retrieval call binding the contract method 0x8b90d672.
//
// Solidity: function determineFee(uint256 amount, (uint88,uint80,uint80,uint8) tokenConfig) view returns(uint256 feeAmount)
func (_ITokenConfig *ITokenConfigCaller) DetermineFee(opts *bind.CallOpts, amount *big.Int, tokenConfig ITokenConfigTokenConfig) (*big.Int, error) {
	var out []interface{}
	err := _ITokenConfig.contract.Call(opts, &out, "determineFee", amount, tokenConfig)

	if err != nil {
		return *new(*big.Int), err
	}

	out0 := *abi.ConvertType(out[0], new(*big.Int)).(**big.Int)

	return out0, err

}

// DetermineFee is a free data retrieval call binding the contract method 0x8b90d672.
//
// Solidity: function determineFee(uint256 amount, (uint88,uint80,uint80,uint8) tokenConfig) view returns(uint256 feeAmount)
func (_ITokenConfig *ITokenConfigSession) DetermineFee(amount *big.Int, tokenConfig ITokenConfigTokenConfig) (*big.Int, error) {
	return _ITokenConfig.Contract.DetermineFee(&_ITokenConfig.CallOpts, amount, tokenConfig)
}

// DetermineFee is a free data retrieval call binding the contract method 0x8b90d672.
//
// Solidity: function determineFee(uint256 amount, (uint88,uint80,uint80,uint8) tokenConfig) view returns(uint256 feeAmount)
func (_ITokenConfig *ITokenConfigCallerSession) DetermineFee(amount *big.Int, tokenConfig ITokenConfigTokenConfig) (*big.Int, error) {
	return _ITokenConfig.Contract.DetermineFee(&_ITokenConfig.CallOpts, amount, tokenConfig)
}

// GetAllowedTokens is a free data retrieval call binding the contract method 0x024ece89.
//
// Solidity: function getAllowedTokens() view returns(address[] allowedTokens)
func (_ITokenConfig *ITokenConfigCaller) GetAllowedTokens(opts *bind.CallOpts) ([]common.Address, error) {
	var out []interface{}
	err := _ITokenConfig.contract.Call(opts, &out, "getAllowedTokens")

	if err != nil {
		return *new([]common.Address), err
	}

	out0 := *abi.ConvertType(out[0], new([]common.Address)).(*[]common.Address)

	return out0, err

}

// GetAllowedTokens is a free data retrieval call binding the contract method 0x024ece89.
//
// Solidity: function getAllowedTokens() view returns(address[] allowedTokens)
func (_ITokenConfig *ITokenConfigSession) GetAllowedTokens() ([]common.Address, error) {
	return _ITokenConfig.Contract.GetAllowedTokens(&_ITokenConfig.CallOpts)
}

// GetAllowedTokens is a free data retrieval call binding the contract method 0x024ece89.
//
// Solidity: function getAllowedTokens() view returns(address[] allowedTokens)
func (_ITokenConfig *ITokenConfigCallerSession) GetAllowedTokens() ([]common.Address, error) {
	return _ITokenConfig.Contract.GetAllowedTokens(&_ITokenConfig.CallOpts)
}

// GetFeeRevenue is a free data retrieval call binding the contract method 0x41daeb24.
//
// Solidity: function getFeeRevenue(address token) view returns(uint256 revenue)
func (_ITokenConfig *ITokenConfigCaller) GetFeeRevenue(opts *bind.CallOpts, token common.Address) (*big.Int, error) {
	var out []interface{}
	err := _ITokenConfig.contract.Call(opts, &out, "getFeeRevenue", token)

	if err != nil {
		return *new(*big.Int), err
	}

	out0 := *abi.ConvertType(out[0], new(*big.Int)).(**big.Int)

	return out0, err

}

// GetFeeRevenue is a free data retrieval call binding the contract method 0x41daeb24.
//
// Solidity: function getFeeRevenue(address token) view returns(uint256 revenue)
func (_ITokenConfig *ITokenConfigSession) GetFeeRevenue(token common.Address) (*big.Int, error) {
	return _ITokenConfig.Contract.GetFeeRevenue(&_ITokenConfig.CallOpts, token)
}

// GetFeeRevenue is a free data retrieval call binding the contract method 0x41daeb24.
//
// Solidity: function getFeeRevenue(address token) view returns(uint256 revenue)
func (_ITokenConfig *ITokenConfigCallerSession) GetFeeRevenue(token common.Address) (*big.Int, error) {
	return _ITokenConfig.Contract.GetFeeRevenue(&_ITokenConfig.CallOpts, token)
}

// GetTokenConfig is a free data retrieval call binding the contract method 0xcb67e3b1.
//
// Solidity: function getTokenConfig(address token) view returns((uint88,uint80,uint80,uint8) tokenConfig)
func (_ITokenConfig *ITokenConfigCaller) GetTokenConfig(opts *bind.CallOpts, token common.Address) (ITokenConfigTokenConfig, error) {
	var out []interface{}
	err := _ITokenConfig.contract.Call(opts, &out, "getTokenConfig", token)

	if err != nil {
		return *new(ITokenConfigTokenConfig), err
	}

	out0 := *abi.ConvertType(out[0], new(ITokenConfigTokenConfig)).(*ITokenConfigTokenConfig)

	return out0, err

}

// GetTokenConfig is a free data retrieval call binding the contract method 0xcb67e3b1.
//
// Solidity: function getTokenConfig(address token) view returns((uint88,uint80,uint80,uint8) tokenConfig)
func (_ITokenConfig *ITokenConfigSession) GetTokenConfig(token common.Address) (ITokenConfigTokenConfig, error) {
	return _ITokenConfig.Contract.GetTokenConfig(&_ITokenConfig.CallOpts, token)
}

// GetTokenConfig is a free data retrieval call binding the contract method 0xcb67e3b1.
//
// Solidity: function getTokenConfig(address token) view returns((uint88,uint80,uint80,uint8) tokenConfig)
func (_ITokenConfig *ITokenConfigCallerSession) GetTokenConfig(token common.Address) (ITokenConfigTokenConfig, error) {
	return _ITokenConfig.Contract.GetTokenConfig(&_ITokenConfig.CallOpts, token)
}

// IsTokenAllowed is a free data retrieval call binding the contract method 0xf9eaee0d.
//
// Solidity: function isTokenAllowed(address token) view returns(bool isAllowed)
func (_ITokenConfig *ITokenConfigCaller) IsTokenAllowed(opts *bind.CallOpts, token common.Address) (bool, error) {
	var out []interface{}
	err := _ITokenConfig.contract.Call(opts, &out, "isTokenAllowed", token)

	if err != nil {
		return *new(bool), err
	}

	out0 := *abi.ConvertType(out[0], new(bool)).(*bool)

	return out0, err

}

// IsTokenAllowed is a free data retrieval call binding the contract method 0xf9eaee0d.
//
// Solidity: function isTokenAllowed(address token) view returns(bool isAllowed)
func (_ITokenConfig *ITokenConfigSession) IsTokenAllowed(token common.Address) (bool, error) {
	return _ITokenConfig.Contract.IsTokenAllowed(&_ITokenConfig.CallOpts, token)
}

// IsTokenAllowed is a free data retrieval call binding the contract method 0xf9eaee0d.
//
// Solidity: function isTokenAllowed(address token) view returns(bool isAllowed)
func (_ITokenConfig *ITokenConfigCallerSession) IsTokenAllowed(token common.Address) (bool, error) {
	return _ITokenConfig.Contract.IsTokenAllowed(&_ITokenConfig.CallOpts, token)
}

// AllowToken is a paid mutator transaction binding the contract method 0x549ef0d1.
//
// Solidity: function allowToken(address token, uint8 decimals) returns()
func (_ITokenConfig *ITokenConfigTransactor) AllowToken(opts *bind.TransactOpts, token common.Address, decimals uint8) (*types.Transaction, error) {
	return _ITokenConfig.contract.Transact(opts, "allowToken", token, decimals)
}

// AllowToken is a paid mutator transaction binding the contract method 0x549ef0d1.
//
// Solidity: function allowToken(address token, uint8 decimals) returns()
func (_ITokenConfig *ITokenConfigSession) AllowToken(token common.Address, decimals uint8) (*types.Transaction, error) {
	return _ITokenConfig.Contract.AllowToken(&_ITokenConfig.TransactOpts, token, decimals)
}

// AllowToken is a paid mutator transaction binding the contract method 0x549ef0d1.
//
// Solidity: function allowToken(address token, uint8 decimals) returns()
func (_ITokenConfig *ITokenConfigTransactorSession) AllowToken(token common.Address, decimals uint8) (*types.Transaction, error) {
	return _ITokenConfig.Contract.AllowToken(&_ITokenConfig.TransactOpts, token, decimals)
}

// AllowTokenAndSetFeeConfig is a paid mutator transaction binding the contract method 0x8fdf27e9.
//
// Solidity: function allowTokenAndSetFeeConfig(address token, uint8 decimals, uint88 feePercentage, uint80 minFee, uint80 maxFee) returns()
func (_ITokenConfig *ITokenConfigTransactor) AllowTokenAndSetFeeConfig(opts *bind.TransactOpts, token common.Address, decimals uint8, feePercentage *big.Int, minFee *big.Int, maxFee *big.Int) (*types.Transaction, error) {
	return _ITokenConfig.contract.Transact(opts, "allowTokenAndSetFeeConfig", token, decimals, feePercentage, minFee, maxFee)
}

// AllowTokenAndSetFeeConfig is a paid mutator transaction binding the contract method 0x8fdf27e9.
//
// Solidity: function allowTokenAndSetFeeConfig(address token, uint8 decimals, uint88 feePercentage, uint80 minFee, uint80 maxFee) returns()
func (_ITokenConfig *ITokenConfigSession) AllowTokenAndSetFeeConfig(token common.Address, decimals uint8, feePercentage *big.Int, minFee *big.Int, maxFee *big.Int) (*types.Transaction, error) {
	return _ITokenConfig.Contract.AllowTokenAndSetFeeConfig(&_ITokenConfig.TransactOpts, token, decimals, feePercentage, minFee, maxFee)
}

// AllowTokenAndSetFeeConfig is a paid mutator transaction binding the contract method 0x8fdf27e9.
//
// Solidity: function allowTokenAndSetFeeConfig(address token, uint8 decimals, uint88 feePercentage, uint80 minFee, uint80 maxFee) returns()
func (_ITokenConfig *ITokenConfigTransactorSession) AllowTokenAndSetFeeConfig(token common.Address, decimals uint8, feePercentage *big.Int, minFee *big.Int, maxFee *big.Int) (*types.Transaction, error) {
	return _ITokenConfig.Contract.AllowTokenAndSetFeeConfig(&_ITokenConfig.TransactOpts, token, decimals, feePercentage, minFee, maxFee)
}

// ClearTokenFeeConfig is a paid mutator transaction binding the contract method 0x2f1ca9b2.
//
// Solidity: function clearTokenFeeConfig(address token) returns()
func (_ITokenConfig *ITokenConfigTransactor) ClearTokenFeeConfig(opts *bind.TransactOpts, token common.Address) (*types.Transaction, error) {
	return _ITokenConfig.contract.Transact(opts, "clearTokenFeeConfig", token)
}

// ClearTokenFeeConfig is a paid mutator transaction binding the contract method 0x2f1ca9b2.
//
// Solidity: function clearTokenFeeConfig(address token) returns()
func (_ITokenConfig *ITokenConfigSession) ClearTokenFeeConfig(token common.Address) (*types.Transaction, error) {
	return _ITokenConfig.Contract.ClearTokenFeeConfig(&_ITokenConfig.TransactOpts, token)
}

// ClearTokenFeeConfig is a paid mutator transaction binding the contract method 0x2f1ca9b2.
//
// Solidity: function clearTokenFeeConfig(address token) returns()
func (_ITokenConfig *ITokenConfigTransactorSession) ClearTokenFeeConfig(token common.Address) (*types.Transaction, error) {
	return _ITokenConfig.Contract.ClearTokenFeeConfig(&_ITokenConfig.TransactOpts, token)
}

// DisallowToken is a paid mutator transaction binding the contract method 0xe79767af.
//
// Solidity: function disallowToken(address token) returns()
func (_ITokenConfig *ITokenConfigTransactor) DisallowToken(opts *bind.TransactOpts, token common.Address) (*types.Transaction, error) {
	return _ITokenConfig.contract.Transact(opts, "disallowToken", token)
}

// DisallowToken is a paid mutator transaction binding the contract method 0xe79767af.
//
// Solidity: function disallowToken(address token) returns()
func (_ITokenConfig *ITokenConfigSession) DisallowToken(token common.Address) (*types.Transaction, error) {
	return _ITokenConfig.Contract.DisallowToken(&_ITokenConfig.TransactOpts, token)
}

// DisallowToken is a paid mutator transaction binding the contract method 0xe79767af.
//
// Solidity: function disallowToken(address token) returns()
func (_ITokenConfig *ITokenConfigTransactorSession) DisallowToken(token common.Address) (*types.Transaction, error) {
	return _ITokenConfig.Contract.DisallowToken(&_ITokenConfig.TransactOpts, token)
}

// SetTokenFeeConfig is a paid mutator transaction binding the contract method 0x7aa0f50d.
//
// Solidity: function setTokenFeeConfig(address token, uint88 feePercentage, uint80 minFee, uint80 maxFee) returns()
func (_ITokenConfig *ITokenConfigTransactor) SetTokenFeeConfig(opts *bind.TransactOpts, token common.Address, feePercentage *big.Int, minFee *big.Int, maxFee *big.Int) (*types.Transaction, error) {
	return _ITokenConfig.contract.Transact(opts, "setTokenFeeConfig", token, feePercentage, minFee, maxFee)
}

// SetTokenFeeConfig is a paid mutator transaction binding the contract method 0x7aa0f50d.
//
// Solidity: function setTokenFeeConfig(address token, uint88 feePercentage, uint80 minFee, uint80 maxFee) returns()
func (_ITokenConfig *ITokenConfigSession) SetTokenFeeConfig(token common.Address, feePercentage *big.Int, minFee *big.Int, maxFee *big.Int) (*types.Transaction, error) {
	return _ITokenConfig.Contract.SetTokenFeeConfig(&_ITokenConfig.TransactOpts, token, feePercentage, minFee, maxFee)
}

// SetTokenFeeConfig is a paid mutator transaction binding the contract method 0x7aa0f50d.
//
// Solidity: function setTokenFeeConfig(address token, uint88 feePercentage, uint80 minFee, uint80 maxFee) returns()
func (_ITokenConfig *ITokenConfigTransactorSession) SetTokenFeeConfig(token common.Address, feePercentage *big.Int, minFee *big.Int, maxFee *big.Int) (*types.Transaction, error) {
	return _ITokenConfig.Contract.SetTokenFeeConfig(&_ITokenConfig.TransactOpts, token, feePercentage, minFee, maxFee)
}

// WithdrawFeeRevenue is a paid mutator transaction binding the contract method 0x75154601.
//
// Solidity: function withdrawFeeRevenue(address token, address recipient) returns()
func (_ITokenConfig *ITokenConfigTransactor) WithdrawFeeRevenue(opts *bind.TransactOpts, token common.Address, recipient common.Address) (*types.Transaction, error) {
	return _ITokenConfig.contract.Transact(opts, "withdrawFeeRevenue", token, recipient)
}

// WithdrawFeeRevenue is a paid mutator transaction binding the contract method 0x75154601.
//
// Solidity: function withdrawFeeRevenue(address token, address recipient) returns()
func (_ITokenConfig *ITokenConfigSession) WithdrawFeeRevenue(token common.Address, recipient common.Address) (*types.Transaction, error) {
	return _ITokenConfig.Contract.WithdrawFeeRevenue(&_ITokenConfig.TransactOpts, token, recipient)
}

// WithdrawFeeRevenue is a paid mutator transaction binding the contract method 0x75154601.
//
// Solidity: function withdrawFeeRevenue(address token, address recipient) returns()
func (_ITokenConfig *ITokenConfigTransactorSession) WithdrawFeeRevenue(token common.Address, recipient common.Address) (*types.Transaction, error) {
	return _ITokenConfig.Contract.WithdrawFeeRevenue(&_ITokenConfig.TransactOpts, token, recipient)
}

// ITokenConfigFeeRevenueWithdrawnIterator is returned from FilterFeeRevenueWithdrawn and is used to iterate over the raw logs and unpacked data for FeeRevenueWithdrawn events raised by the ITokenConfig contract.
type ITokenConfigFeeRevenueWithdrawnIterator struct {
	Event *ITokenConfigFeeRevenueWithdrawn // Event containing the contract specifics and raw log

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
func (it *ITokenConfigFeeRevenueWithdrawnIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(ITokenConfigFeeRevenueWithdrawn)
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
		it.Event = new(ITokenConfigFeeRevenueWithdrawn)
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
func (it *ITokenConfigFeeRevenueWithdrawnIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *ITokenConfigFeeRevenueWithdrawnIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// ITokenConfigFeeRevenueWithdrawn represents a FeeRevenueWithdrawn event raised by the ITokenConfig contract.
type ITokenConfigFeeRevenueWithdrawn struct {
	Token     common.Address
	Recipient common.Address
	Amount    *big.Int
	Raw       types.Log // Blockchain specific contextual infos
}

// FilterFeeRevenueWithdrawn is a free log retrieval operation binding the contract event 0x76ac859941c37173539323f59a86de5409d3350f8f407088f35d10e79557fc99.
//
// Solidity: event FeeRevenueWithdrawn(address indexed token, address indexed recipient, uint256 amount)
func (_ITokenConfig *ITokenConfigFilterer) FilterFeeRevenueWithdrawn(opts *bind.FilterOpts, token []common.Address, recipient []common.Address) (*ITokenConfigFeeRevenueWithdrawnIterator, error) {

	var tokenRule []interface{}
	for _, tokenItem := range token {
		tokenRule = append(tokenRule, tokenItem)
	}
	var recipientRule []interface{}
	for _, recipientItem := range recipient {
		recipientRule = append(recipientRule, recipientItem)
	}

	logs, sub, err := _ITokenConfig.contract.FilterLogs(opts, "FeeRevenueWithdrawn", tokenRule, recipientRule)
	if err != nil {
		return nil, err
	}
	return &ITokenConfigFeeRevenueWithdrawnIterator{contract: _ITokenConfig.contract, event: "FeeRevenueWithdrawn", logs: logs, sub: sub}, nil
}

// WatchFeeRevenueWithdrawn is a free log subscription operation binding the contract event 0x76ac859941c37173539323f59a86de5409d3350f8f407088f35d10e79557fc99.
//
// Solidity: event FeeRevenueWithdrawn(address indexed token, address indexed recipient, uint256 amount)
func (_ITokenConfig *ITokenConfigFilterer) WatchFeeRevenueWithdrawn(opts *bind.WatchOpts, sink chan<- *ITokenConfigFeeRevenueWithdrawn, token []common.Address, recipient []common.Address) (event.Subscription, error) {

	var tokenRule []interface{}
	for _, tokenItem := range token {
		tokenRule = append(tokenRule, tokenItem)
	}
	var recipientRule []interface{}
	for _, recipientItem := range recipient {
		recipientRule = append(recipientRule, recipientItem)
	}

	logs, sub, err := _ITokenConfig.contract.WatchLogs(opts, "FeeRevenueWithdrawn", tokenRule, recipientRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(ITokenConfigFeeRevenueWithdrawn)
				if err := _ITokenConfig.contract.UnpackLog(event, "FeeRevenueWithdrawn", log); err != nil {
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

// ParseFeeRevenueWithdrawn is a log parse operation binding the contract event 0x76ac859941c37173539323f59a86de5409d3350f8f407088f35d10e79557fc99.
//
// Solidity: event FeeRevenueWithdrawn(address indexed token, address indexed recipient, uint256 amount)
func (_ITokenConfig *ITokenConfigFilterer) ParseFeeRevenueWithdrawn(log types.Log) (*ITokenConfigFeeRevenueWithdrawn, error) {
	event := new(ITokenConfigFeeRevenueWithdrawn)
	if err := _ITokenConfig.contract.UnpackLog(event, "FeeRevenueWithdrawn", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// ITokenConfigTokenAllowedIterator is returned from FilterTokenAllowed and is used to iterate over the raw logs and unpacked data for TokenAllowed events raised by the ITokenConfig contract.
type ITokenConfigTokenAllowedIterator struct {
	Event *ITokenConfigTokenAllowed // Event containing the contract specifics and raw log

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
func (it *ITokenConfigTokenAllowedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(ITokenConfigTokenAllowed)
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
		it.Event = new(ITokenConfigTokenAllowed)
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
func (it *ITokenConfigTokenAllowedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *ITokenConfigTokenAllowedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// ITokenConfigTokenAllowed represents a TokenAllowed event raised by the ITokenConfig contract.
type ITokenConfigTokenAllowed struct {
	Token    common.Address
	Decimals uint8
	Raw      types.Log // Blockchain specific contextual infos
}

// FilterTokenAllowed is a free log retrieval operation binding the contract event 0xe3a2f60d67f76ac1de94f074db7146923e99f6cb205066d3c1a23749677f3305.
//
// Solidity: event TokenAllowed(address indexed token, uint8 decimals)
func (_ITokenConfig *ITokenConfigFilterer) FilterTokenAllowed(opts *bind.FilterOpts, token []common.Address) (*ITokenConfigTokenAllowedIterator, error) {

	var tokenRule []interface{}
	for _, tokenItem := range token {
		tokenRule = append(tokenRule, tokenItem)
	}

	logs, sub, err := _ITokenConfig.contract.FilterLogs(opts, "TokenAllowed", tokenRule)
	if err != nil {
		return nil, err
	}
	return &ITokenConfigTokenAllowedIterator{contract: _ITokenConfig.contract, event: "TokenAllowed", logs: logs, sub: sub}, nil
}

// WatchTokenAllowed is a free log subscription operation binding the contract event 0xe3a2f60d67f76ac1de94f074db7146923e99f6cb205066d3c1a23749677f3305.
//
// Solidity: event TokenAllowed(address indexed token, uint8 decimals)
func (_ITokenConfig *ITokenConfigFilterer) WatchTokenAllowed(opts *bind.WatchOpts, sink chan<- *ITokenConfigTokenAllowed, token []common.Address) (event.Subscription, error) {

	var tokenRule []interface{}
	for _, tokenItem := range token {
		tokenRule = append(tokenRule, tokenItem)
	}

	logs, sub, err := _ITokenConfig.contract.WatchLogs(opts, "TokenAllowed", tokenRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(ITokenConfigTokenAllowed)
				if err := _ITokenConfig.contract.UnpackLog(event, "TokenAllowed", log); err != nil {
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

// ParseTokenAllowed is a log parse operation binding the contract event 0xe3a2f60d67f76ac1de94f074db7146923e99f6cb205066d3c1a23749677f3305.
//
// Solidity: event TokenAllowed(address indexed token, uint8 decimals)
func (_ITokenConfig *ITokenConfigFilterer) ParseTokenAllowed(log types.Log) (*ITokenConfigTokenAllowed, error) {
	event := new(ITokenConfigTokenAllowed)
	if err := _ITokenConfig.contract.UnpackLog(event, "TokenAllowed", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// ITokenConfigTokenDisallowedIterator is returned from FilterTokenDisallowed and is used to iterate over the raw logs and unpacked data for TokenDisallowed events raised by the ITokenConfig contract.
type ITokenConfigTokenDisallowedIterator struct {
	Event *ITokenConfigTokenDisallowed // Event containing the contract specifics and raw log

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
func (it *ITokenConfigTokenDisallowedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(ITokenConfigTokenDisallowed)
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
		it.Event = new(ITokenConfigTokenDisallowed)
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
func (it *ITokenConfigTokenDisallowedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *ITokenConfigTokenDisallowedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// ITokenConfigTokenDisallowed represents a TokenDisallowed event raised by the ITokenConfig contract.
type ITokenConfigTokenDisallowed struct {
	Token common.Address
	Raw   types.Log // Blockchain specific contextual infos
}

// FilterTokenDisallowed is a free log retrieval operation binding the contract event 0xeaa9136602e3b70a4e689b5b6f55bda25ca62b917d839c0ff87f5902387f77b9.
//
// Solidity: event TokenDisallowed(address indexed token)
func (_ITokenConfig *ITokenConfigFilterer) FilterTokenDisallowed(opts *bind.FilterOpts, token []common.Address) (*ITokenConfigTokenDisallowedIterator, error) {

	var tokenRule []interface{}
	for _, tokenItem := range token {
		tokenRule = append(tokenRule, tokenItem)
	}

	logs, sub, err := _ITokenConfig.contract.FilterLogs(opts, "TokenDisallowed", tokenRule)
	if err != nil {
		return nil, err
	}
	return &ITokenConfigTokenDisallowedIterator{contract: _ITokenConfig.contract, event: "TokenDisallowed", logs: logs, sub: sub}, nil
}

// WatchTokenDisallowed is a free log subscription operation binding the contract event 0xeaa9136602e3b70a4e689b5b6f55bda25ca62b917d839c0ff87f5902387f77b9.
//
// Solidity: event TokenDisallowed(address indexed token)
func (_ITokenConfig *ITokenConfigFilterer) WatchTokenDisallowed(opts *bind.WatchOpts, sink chan<- *ITokenConfigTokenDisallowed, token []common.Address) (event.Subscription, error) {

	var tokenRule []interface{}
	for _, tokenItem := range token {
		tokenRule = append(tokenRule, tokenItem)
	}

	logs, sub, err := _ITokenConfig.contract.WatchLogs(opts, "TokenDisallowed", tokenRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(ITokenConfigTokenDisallowed)
				if err := _ITokenConfig.contract.UnpackLog(event, "TokenDisallowed", log); err != nil {
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

// ParseTokenDisallowed is a log parse operation binding the contract event 0xeaa9136602e3b70a4e689b5b6f55bda25ca62b917d839c0ff87f5902387f77b9.
//
// Solidity: event TokenDisallowed(address indexed token)
func (_ITokenConfig *ITokenConfigFilterer) ParseTokenDisallowed(log types.Log) (*ITokenConfigTokenDisallowed, error) {
	event := new(ITokenConfigTokenDisallowed)
	if err := _ITokenConfig.contract.UnpackLog(event, "TokenDisallowed", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// ITokenConfigTokenFeesClearedIterator is returned from FilterTokenFeesCleared and is used to iterate over the raw logs and unpacked data for TokenFeesCleared events raised by the ITokenConfig contract.
type ITokenConfigTokenFeesClearedIterator struct {
	Event *ITokenConfigTokenFeesCleared // Event containing the contract specifics and raw log

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
func (it *ITokenConfigTokenFeesClearedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(ITokenConfigTokenFeesCleared)
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
		it.Event = new(ITokenConfigTokenFeesCleared)
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
func (it *ITokenConfigTokenFeesClearedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *ITokenConfigTokenFeesClearedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// ITokenConfigTokenFeesCleared represents a TokenFeesCleared event raised by the ITokenConfig contract.
type ITokenConfigTokenFeesCleared struct {
	Token common.Address
	Raw   types.Log // Blockchain specific contextual infos
}

// FilterTokenFeesCleared is a free log retrieval operation binding the contract event 0x475663cd3704d5c0c391c5f6b3f338694109b06b355a629e72ec57d40241b441.
//
// Solidity: event TokenFeesCleared(address indexed token)
func (_ITokenConfig *ITokenConfigFilterer) FilterTokenFeesCleared(opts *bind.FilterOpts, token []common.Address) (*ITokenConfigTokenFeesClearedIterator, error) {

	var tokenRule []interface{}
	for _, tokenItem := range token {
		tokenRule = append(tokenRule, tokenItem)
	}

	logs, sub, err := _ITokenConfig.contract.FilterLogs(opts, "TokenFeesCleared", tokenRule)
	if err != nil {
		return nil, err
	}
	return &ITokenConfigTokenFeesClearedIterator{contract: _ITokenConfig.contract, event: "TokenFeesCleared", logs: logs, sub: sub}, nil
}

// WatchTokenFeesCleared is a free log subscription operation binding the contract event 0x475663cd3704d5c0c391c5f6b3f338694109b06b355a629e72ec57d40241b441.
//
// Solidity: event TokenFeesCleared(address indexed token)
func (_ITokenConfig *ITokenConfigFilterer) WatchTokenFeesCleared(opts *bind.WatchOpts, sink chan<- *ITokenConfigTokenFeesCleared, token []common.Address) (event.Subscription, error) {

	var tokenRule []interface{}
	for _, tokenItem := range token {
		tokenRule = append(tokenRule, tokenItem)
	}

	logs, sub, err := _ITokenConfig.contract.WatchLogs(opts, "TokenFeesCleared", tokenRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(ITokenConfigTokenFeesCleared)
				if err := _ITokenConfig.contract.UnpackLog(event, "TokenFeesCleared", log); err != nil {
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

// ParseTokenFeesCleared is a log parse operation binding the contract event 0x475663cd3704d5c0c391c5f6b3f338694109b06b355a629e72ec57d40241b441.
//
// Solidity: event TokenFeesCleared(address indexed token)
func (_ITokenConfig *ITokenConfigFilterer) ParseTokenFeesCleared(log types.Log) (*ITokenConfigTokenFeesCleared, error) {
	event := new(ITokenConfigTokenFeesCleared)
	if err := _ITokenConfig.contract.UnpackLog(event, "TokenFeesCleared", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}

// ITokenConfigTokenFeesUpdatedIterator is returned from FilterTokenFeesUpdated and is used to iterate over the raw logs and unpacked data for TokenFeesUpdated events raised by the ITokenConfig contract.
type ITokenConfigTokenFeesUpdatedIterator struct {
	Event *ITokenConfigTokenFeesUpdated // Event containing the contract specifics and raw log

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
func (it *ITokenConfigTokenFeesUpdatedIterator) Next() bool {
	// If the iterator failed, stop iterating
	if it.fail != nil {
		return false
	}
	// If the iterator completed, deliver directly whatever's available
	if it.done {
		select {
		case log := <-it.logs:
			it.Event = new(ITokenConfigTokenFeesUpdated)
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
		it.Event = new(ITokenConfigTokenFeesUpdated)
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
func (it *ITokenConfigTokenFeesUpdatedIterator) Error() error {
	return it.fail
}

// Close terminates the iteration process, releasing any pending underlying
// resources.
func (it *ITokenConfigTokenFeesUpdatedIterator) Close() error {
	it.sub.Unsubscribe()
	return nil
}

// ITokenConfigTokenFeesUpdated represents a TokenFeesUpdated event raised by the ITokenConfig contract.
type ITokenConfigTokenFeesUpdated struct {
	Token         common.Address
	FeePercentage *big.Int
	MinFee        *big.Int
	MaxFee        *big.Int
	Raw           types.Log // Blockchain specific contextual infos
}

// FilterTokenFeesUpdated is a free log retrieval operation binding the contract event 0xc6f10594e7d46a9a199c763fc19b5da209bf35ac4aa1360c386f881d3c4b03c5.
//
// Solidity: event TokenFeesUpdated(address indexed token, uint88 feePercentage, uint80 minFee, uint80 maxFee)
func (_ITokenConfig *ITokenConfigFilterer) FilterTokenFeesUpdated(opts *bind.FilterOpts, token []common.Address) (*ITokenConfigTokenFeesUpdatedIterator, error) {

	var tokenRule []interface{}
	for _, tokenItem := range token {
		tokenRule = append(tokenRule, tokenItem)
	}

	logs, sub, err := _ITokenConfig.contract.FilterLogs(opts, "TokenFeesUpdated", tokenRule)
	if err != nil {
		return nil, err
	}
	return &ITokenConfigTokenFeesUpdatedIterator{contract: _ITokenConfig.contract, event: "TokenFeesUpdated", logs: logs, sub: sub}, nil
}

// WatchTokenFeesUpdated is a free log subscription operation binding the contract event 0xc6f10594e7d46a9a199c763fc19b5da209bf35ac4aa1360c386f881d3c4b03c5.
//
// Solidity: event TokenFeesUpdated(address indexed token, uint88 feePercentage, uint80 minFee, uint80 maxFee)
func (_ITokenConfig *ITokenConfigFilterer) WatchTokenFeesUpdated(opts *bind.WatchOpts, sink chan<- *ITokenConfigTokenFeesUpdated, token []common.Address) (event.Subscription, error) {

	var tokenRule []interface{}
	for _, tokenItem := range token {
		tokenRule = append(tokenRule, tokenItem)
	}

	logs, sub, err := _ITokenConfig.contract.WatchLogs(opts, "TokenFeesUpdated", tokenRule)
	if err != nil {
		return nil, err
	}
	return event.NewSubscription(func(quit <-chan struct{}) error {
		defer sub.Unsubscribe()
		for {
			select {
			case log := <-logs:
				// New log arrived, parse the event and forward to the user
				event := new(ITokenConfigTokenFeesUpdated)
				if err := _ITokenConfig.contract.UnpackLog(event, "TokenFeesUpdated", log); err != nil {
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

// ParseTokenFeesUpdated is a log parse operation binding the contract event 0xc6f10594e7d46a9a199c763fc19b5da209bf35ac4aa1360c386f881d3c4b03c5.
//
// Solidity: event TokenFeesUpdated(address indexed token, uint88 feePercentage, uint80 minFee, uint80 maxFee)
func (_ITokenConfig *ITokenConfigFilterer) ParseTokenFeesUpdated(log types.Log) (*ITokenConfigTokenFeesUpdated, error) {
	event := new(ITokenConfigTokenFeesUpdated)
	if err := _ITokenConfig.contract.UnpackLog(event, "TokenFeesUpdated", log); err != nil {
		return nil, err
	}
	event.Raw = log
	return event, nil
}
