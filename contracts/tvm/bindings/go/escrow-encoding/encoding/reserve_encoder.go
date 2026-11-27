package encoding

import (
	"fmt"
	"math/big"

	contracts "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/generated"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// EscrowReserveEncoder implements digest encoding for the V3 escrow Reserve
// function (using TIP-712). Mirrors the EVM equivalent. ReserveWitness has 2
// fields: paymentId and settler. Escrow domain version is "3". chainID is
// masked to its lower 4 bytes for TIP-712.
type EscrowReserveEncoder struct{}

// NewEscrowReserveEncoder returns an EscrowReserveEncoder.
func NewEscrowReserveEncoder() EscrowReserveEncoder {
	return EscrowReserveEncoder{}
}

// BuildTypedData constructs the TIP-712 typed data for a reserve witness.
func (e EscrowReserveEncoder) BuildTypedData(
	escrowContract common.Address,
	witness contracts.IEscrowReserveWitness,
	chainID *big.Int,
) apitypes.TypedData {
	maskedChainID := MaskTronChainIdBig(chainID)
	return apitypes.TypedData{
		Types: apitypes.Types{
			"EIP712Domain": []apitypes.Type{
				{Name: "name", Type: "string"},
				{Name: "version", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"ReserveWitness": []apitypes.Type{
				{Name: "paymentId", Type: "bytes32"},
				{Name: "settler", Type: "address"},
			},
		},
		PrimaryType: "ReserveWitness",
		Domain: apitypes.TypedDataDomain{
			Name:              "Escrow",
			Version:           "3",
			ChainId:           math.NewHexOrDecimal256(maskedChainID.Int64()),
			VerifyingContract: escrowContract.Hex(),
		},
		Message: apitypes.TypedDataMessage{
			"paymentId": common.BytesToHash(witness.DepositId[:]).Hex(),
			"settler":   witness.Settler.Hex(),
		},
	}
}

// Digest returns the TIP-712 hash of a reserve witness, the value that gets signed.
func (e EscrowReserveEncoder) Digest(
	escrowContract common.Address,
	witness contracts.IEscrowReserveWitness,
	chainID *big.Int,
) ([]byte, error) {
	hash, _, err := apitypes.TypedDataAndHash(e.BuildTypedData(escrowContract, witness, chainID))
	if err != nil {
		return nil, fmt.Errorf("failed to generate TIP-712 hash: %w", err)
	}
	return hash, nil
}

// DigestWithTypedData returns Digest together with the typed data it hashed.
func (e EscrowReserveEncoder) DigestWithTypedData(
	escrowContract common.Address,
	witness contracts.IEscrowReserveWitness,
	chainID *big.Int,
) ([]byte, apitypes.TypedData, error) {
	typedData := e.BuildTypedData(escrowContract, witness, chainID)
	hash, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return nil, apitypes.TypedData{}, fmt.Errorf("failed to generate TIP-712 hash: %w", err)
	}
	return hash, typedData, nil
}

// BuildTypedDataWithQuoteSource builds the V2 ReserveWitness TIP-712 typed data, binding the
// offchain quote hash and the winning source amount into the reserver's signature (
// veri-fill trust model; tvm-contracts #5 quoteHash + #4 sourceAmount). Additive — the 2-field
// BuildTypedData above is unchanged. Field set/order reproduces the merged Tron typehash
// ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)
// (pinned by TestReserveWitnessV2TypeHash). Callers must gate this behind a dark flag until the
// new Tron escrow is deployed.
func (e EscrowReserveEncoder) BuildTypedDataWithQuoteSource(
	escrowContract common.Address,
	paymentID [32]byte,
	quoteHash [32]byte,
	settler common.Address,
	sourceAmount *big.Int,
	chainID *big.Int,
) apitypes.TypedData {
	maskedChainID := MaskTronChainIdBig(chainID)
	return apitypes.TypedData{
		Types: apitypes.Types{
			"EIP712Domain": []apitypes.Type{
				{Name: "name", Type: "string"},
				{Name: "version", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"ReserveWitness": []apitypes.Type{
				{Name: "depositId", Type: "bytes32"},
				{Name: "quoteHash", Type: "bytes32"},
				{Name: "settler", Type: "address"},
				{Name: "sourceAmount", Type: "uint256"},
			},
		},
		PrimaryType: "ReserveWitness",
		Domain: apitypes.TypedDataDomain{
			Name:              "Escrow",
			Version:           "3",
			ChainId:           math.NewHexOrDecimal256(maskedChainID.Int64()),
			VerifyingContract: escrowContract.Hex(),
		},
		Message: apitypes.TypedDataMessage{
			"depositId":    common.BytesToHash(paymentID[:]).Hex(),
			"quoteHash":    common.BytesToHash(quoteHash[:]).Hex(),
			"settler":      settler.Hex(),
			"sourceAmount": sourceAmount.String(),
		},
	}
}

// DigestWithQuoteSource returns the TIP-712 hash of the V2 reserve witness.
func (e EscrowReserveEncoder) DigestWithQuoteSource(
	escrowContract common.Address,
	paymentID [32]byte,
	quoteHash [32]byte,
	settler common.Address,
	sourceAmount *big.Int,
	chainID *big.Int,
) ([]byte, error) {
	hash, _, err := e.DigestWithQuoteSourceTypedData(
		escrowContract, paymentID, quoteHash, settler, sourceAmount, chainID)
	return hash, err
}

// DigestWithQuoteSourceTypedData is DigestWithQuoteSource plus the typed data it hashed, for
// callers that hand the STRUCT to a signer rather than the digest (see DigestWithTypedData).
//
// Name and arity match the EVM reserve encoder deliberately. bid_awarder.go imports both packages
// side by side, so one name meaning two shapes across them is a mistake waiting to be made.
func (e EscrowReserveEncoder) DigestWithQuoteSourceTypedData(
	escrowContract common.Address,
	paymentID [32]byte,
	quoteHash [32]byte,
	settler common.Address,
	sourceAmount *big.Int,
	chainID *big.Int,
) ([]byte, apitypes.TypedData, error) {
	typedData := e.BuildTypedDataWithQuoteSource(escrowContract, paymentID, quoteHash, settler, sourceAmount, chainID)
	hash, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return nil, apitypes.TypedData{}, fmt.Errorf("failed to generate TIP-712 hash (v2 quote+source): %w", err)
	}
	return hash, typedData, nil
}
