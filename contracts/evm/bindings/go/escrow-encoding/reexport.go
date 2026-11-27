// Package contracts re-exports generated contract bindings and provides
// hand-written utilities (error decoding, encoding, etc.).
//
// Generated bindings live in the "generated" subpackage and are re-exported
// here so that consumers of this module don't need to distinguish between
// generated and hand-written code.
package contracts

import (
	generated "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"

	"github.com/ethereum/go-ethereum/accounts/abi/bind"
)

// ---------------------------------------------------------------------------
// Metadata re-exports  (used by error_decoder.go, EVM plugin, etc.)
// ---------------------------------------------------------------------------

// IEscrowMetaData re-exports [generated.IEscrowMetaData].
var IEscrowMetaData *bind.MetaData = generated.IEscrowMetaData

// IFulfillmentProxyMetaData re-exports [generated.IFulfillmentProxyMetaData].
var IFulfillmentProxyMetaData *bind.MetaData = generated.IFulfillmentProxyMetaData

// IERC20MetaData re-exports [generated.IERC20MetaData].
var IERC20MetaData *bind.MetaData = generated.IERC20MetaData

// SignatureVerificationMetaData re-exports [generated.SignatureVerificationMetaData].
var SignatureVerificationMetaData *bind.MetaData = generated.SignatureVerificationMetaData

// ITokenConfigMetaData re-exports [generated.ITokenConfigMetaData].
var ITokenConfigMetaData *bind.MetaData = generated.ITokenConfigMetaData

// ---------------------------------------------------------------------------
// Struct type aliases  (used by encoding package, services, etc.)
// ---------------------------------------------------------------------------

// IEscrow structs

// IEscrowDepositInput re-exports [generated.IEscrowDepositInput].
type IEscrowDepositInput = generated.IEscrowDepositInput

// IEscrowDepositWitness re-exports [generated.IEscrowDepositWitness].
type IEscrowDepositWitness = generated.IEscrowDepositWitness

// IEscrowReserveWitness re-exports [generated.IEscrowReserveWitness].
type IEscrowReserveWitness = generated.IEscrowReserveWitness

// IEscrowReleaseWitness re-exports [generated.IEscrowReleaseWitness].
type IEscrowReleaseWitness = generated.IEscrowReleaseWitness

// IEscrowRefundWitness re-exports [generated.IEscrowRefundWitness].
type IEscrowRefundWitness = generated.IEscrowRefundWitness

// IEscrowDirectDepositInput re-exports [generated.IEscrowDirectDepositInput], the argument of
// `directDeposit` (CORE-3048).
type IEscrowDirectDepositInput = generated.IEscrowDirectDepositInput

// IEscrowReserveInput re-exports [generated.IEscrowReserveInput], the argument of `reserve`
// (CORE-3048).
type IEscrowReserveInput = generated.IEscrowReserveInput

// IEscrowReleaseInput re-exports [generated.IEscrowReleaseInput].
type IEscrowReleaseInput = generated.IEscrowReleaseInput

// IEscrowRefundInput re-exports [generated.IEscrowRefundInput].
type IEscrowRefundInput = generated.IEscrowRefundInput

// IEscrow event structs

// IEscrowDeposited re-exports [generated.IEscrowDeposited].
type IEscrowDeposited = generated.IEscrowDeposited

// IEscrowDepositedMany re-exports [generated.IEscrowDepositedMany].
type IEscrowDepositedMany = generated.IEscrowDepositedMany

// IEscrowDepositCommitments re-exports [generated.IEscrowDepositCommitments].
type IEscrowDepositCommitments = generated.IEscrowDepositCommitments

// IEscrowDepositReserved re-exports [generated.IEscrowDepositReserved]: the reserve-time event of a
// direct deposit (CORE-3048), whose quoteHash, settler, charged amount and fee a log-only consumer
// overlays on the tuple it rebuilt from Deposited + DepositCommitments.
type IEscrowDepositReserved = generated.IEscrowDepositReserved

// IEscrowReleased re-exports [generated.IEscrowReleased].
type IEscrowReleased = generated.IEscrowReleased

// IEscrowReleasedMany re-exports [generated.IEscrowReleasedMany].
type IEscrowReleasedMany = generated.IEscrowReleasedMany

// IEscrowRefunded re-exports [generated.IEscrowRefunded].
type IEscrowRefunded = generated.IEscrowRefunded

// IEscrowRefundedMany re-exports [generated.IEscrowRefundedMany].
type IEscrowRefundedMany = generated.IEscrowRefundedMany

// IEscrow contract types

// IEscrow re-exports [generated.IEscrow].
type IEscrow = generated.IEscrow

// IEscrowFilterer re-exports [generated.IEscrowFilterer].
type IEscrowFilterer = generated.IEscrowFilterer

// Permit2 / SignatureTransfer structs

// ISignatureTransferPermitTransferFrom re-exports [generated.ISignatureTransferPermitTransferFrom].
type ISignatureTransferPermitTransferFrom = generated.ISignatureTransferPermitTransferFrom

// ISignatureTransferTokenPermissions re-exports [generated.ISignatureTransferTokenPermissions].
type ISignatureTransferTokenPermissions = generated.ISignatureTransferTokenPermissions

// IFulfillmentProxy structs

// IFulfillmentProxyFulfillment re-exports [generated.IFulfillmentProxyFulfillment].
type IFulfillmentProxyFulfillment = generated.IFulfillmentProxyFulfillment

// IFulfillmentProxyFulfilled re-exports [generated.IFulfillmentProxyFulfilled].
type IFulfillmentProxyFulfilled = generated.IFulfillmentProxyFulfilled

// IFulfillmentProxyFulfilledMany re-exports [generated.IFulfillmentProxyFulfilledMany].
type IFulfillmentProxyFulfilledMany = generated.IFulfillmentProxyFulfilledMany

// IFulfillmentProxy re-exports [generated.IFulfillmentProxy].
type IFulfillmentProxy = generated.IFulfillmentProxy

// IFulfillmentProxyFilterer re-exports [generated.IFulfillmentProxyFilterer].
type IFulfillmentProxyFilterer = generated.IFulfillmentProxyFilterer

// ITokenConfig structs

// ITokenConfigTokenConfig re-exports [generated.ITokenConfigTokenConfig].
type ITokenConfigTokenConfig = generated.ITokenConfigTokenConfig

// IERC20

// IERC20 re-exports [generated.IERC20].
type IERC20 = generated.IERC20

// ---------------------------------------------------------------------------
// Constructor re-exports
// ---------------------------------------------------------------------------

// NewIEscrow re-exports [generated.NewIEscrow].
var NewIEscrow = generated.NewIEscrow

// NewIEscrowFilterer re-exports [generated.NewIEscrowFilterer].
var NewIEscrowFilterer = generated.NewIEscrowFilterer

// NewIFulfillmentProxy re-exports [generated.NewIFulfillmentProxy].
var NewIFulfillmentProxy = generated.NewIFulfillmentProxy

// NewIFulfillmentProxyFilterer re-exports [generated.NewIFulfillmentProxyFilterer].
var NewIFulfillmentProxyFilterer = generated.NewIFulfillmentProxyFilterer

// NewIERC20 re-exports [generated.NewIERC20].
var NewIERC20 = generated.NewIERC20

// NewITokenConfig re-exports [generated.NewITokenConfig].
var NewITokenConfig = generated.NewITokenConfig
