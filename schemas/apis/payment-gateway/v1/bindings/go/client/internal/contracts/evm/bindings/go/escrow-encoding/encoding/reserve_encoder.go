package encoding

import (
	"fmt"
	contracts "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/evm/bindings/go/escrow-encoding/generated"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// EscrowReserveEncoder implements digest encoding for escrow contract Reserve function (using EIP-712).
type EscrowReserveEncoder struct{}

// NewEscrowReserveEncoder returns an EscrowReserveEncoder.
func NewEscrowReserveEncoder() EscrowReserveEncoder {
	return EscrowReserveEncoder{}
}

// BuildTypedData constructs the EIP-712 TypedData for the V3 Reserve witness.
// V3: ReserveWitness only has 2 fields: paymentId and settler.
// V3: Escrow domain version is "3".
//
// Extracted from Digest so the struct can be handed to a signer rather than only its hash.
// Digest's byte output is unchanged. Mirrors the TVM encoder's method of the same name.
//
// PURE PROJECTION: returns apitypes.TypedData with no error, so it cannot report that the witness
// carries QuoteHash / SourceAmount — the two members the regenerated four-member binding has and
// this two-member V1 type does not declare. DigestWithTypedData (and Digest, which delegates to
// it) carry that guard (assertReserveWitnessV1Complete in v1_witness_guard.go).
func (e EscrowReserveEncoder) BuildTypedData(
	escrowContract common.Address,
	witness contracts.IEscrowReserveWitness,
	chainID *big.Int,
) apitypes.TypedData {
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
			ChainId:           math.NewHexOrDecimal256(chainID.Int64()),
			VerifyingContract: escrowContract.Hex(),
		},
		Message: apitypes.TypedDataMessage{
			"paymentId": common.BytesToHash(witness.DepositId[:]).Hex(),
			"settler":   witness.Settler.Hex(),
		},
	}
}

// Digest implements the EIP-712 hashing algorithm for V3 Reserve witness.
// Signature kept as ([]byte, error) — existing callers depend on it.
func (e EscrowReserveEncoder) Digest(
	escrowContract common.Address,
	witness contracts.IEscrowReserveWitness,
	chainID *big.Int,
) ([]byte, error) {
	hash, _, err := e.DigestWithTypedData(escrowContract, witness, chainID)
	return hash, err
}

// DigestWithTypedData is Digest plus the typed data it hashed, for callers that need to hand the
// STRUCT to a signer rather than the digest. A policy-aware remote signer can only authorize on
// fields it can read, and EIP-712 struct hashing has already keccak'd every field by the time a
// digest exists. Mirrors the TVM reserve encoder and both release encoders.
//
// FAILS CLOSED with ErrV1WitnessDropsMembers when the witness carries QuoteHash or SourceAmount:
// the two-member V1 type declares neither, so the digest would commit to neither. Use
// DigestWithQuoteSource on the redeployed escrow. Zero/nil means "not supplied", so pre-redeploy
// callers are unaffected. Digest delegates here, so both paths are guarded by this one check.
func (e EscrowReserveEncoder) DigestWithTypedData(
	escrowContract common.Address,
	witness contracts.IEscrowReserveWitness,
	chainID *big.Int,
) ([]byte, apitypes.TypedData, error) {
	if err := assertReserveWitnessV1Complete(witness); err != nil {
		return nil, apitypes.TypedData{}, err
	}
	typedData := e.BuildTypedData(escrowContract, witness, chainID)
	hash, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return nil, apitypes.TypedData{}, fmt.Errorf("failed to generate EIP-712 hash: %w", err)
	}

	return hash, typedData, nil
}

// BuildTypedDataWithQuoteSource constructs the EIP-712 TypedData for the V2 Reserve
// witness, which binds the offchain quote hash and the winning source amount into the
// reserver's signature, which veri-fill anchors against. It is an ADDITIVE sibling of
// BuildTypedData: the currently-deployed contract has only {paymentId, settler}, so callers
// must gate this path behind a dark flag until the new escrow is deployed. DigestWithQuoteSource
// and the typehash test both derive from this single Types map so a field rename can't drift.
//
// The field set + order reproduce Escrow.sol's RESERVE_WITNESS_TYPE_HASH:
//
//	ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)
//
// That claim is NOT asserted against a transcribed hex constant. escrow_source_typehash_test.go
// extracts RESERVE_WITNESS_TYPE_HASH from contracts/evm/source/src/Escrow.sol and compares it
// against this Types map, so the contract is the oracle. This is the one witness whose
// encoder already agreed with the contract; the other three did not, and the hardcoded pins hid it.
//
// depositId carries the same value as the V1 paymentId (renamed on-chain in evm-contracts #80).
func (e EscrowReserveEncoder) BuildTypedDataWithQuoteSource(
	escrowContract common.Address,
	depositID [32]byte,
	quoteHash [32]byte,
	settler common.Address,
	sourceAmount *big.Int,
	chainID *big.Int,
) apitypes.TypedData {
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
			ChainId:           math.NewHexOrDecimal256(chainID.Int64()),
			VerifyingContract: escrowContract.Hex(),
		},
		Message: apitypes.TypedDataMessage{
			"depositId":    common.BytesToHash(depositID[:]).Hex(),
			"quoteHash":    common.BytesToHash(quoteHash[:]).Hex(),
			"settler":      settler.Hex(),
			"sourceAmount": sourceAmount.String(),
		},
	}
}

// DigestWithQuoteSource returns the EIP-712 hash of the V2 Reserve witness (see
// BuildTypedDataWithQuoteSource). Signature kept as ([]byte, error) — atum-core calls it.
func (e EscrowReserveEncoder) DigestWithQuoteSource(
	escrowContract common.Address,
	depositID [32]byte,
	quoteHash [32]byte,
	settler common.Address,
	sourceAmount *big.Int,
	chainID *big.Int,
) ([]byte, error) {
	hash, _, err := e.DigestWithQuoteSourceTypedData(
		escrowContract, depositID, quoteHash, settler, sourceAmount, chainID)
	return hash, err
}

// DigestWithQuoteSourceTypedData is DigestWithQuoteSource plus the typed data it hashed, for
// callers that hand the STRUCT to a signer rather than the digest (see DigestWithTypedData).
func (e EscrowReserveEncoder) DigestWithQuoteSourceTypedData(
	escrowContract common.Address,
	depositID [32]byte,
	quoteHash [32]byte,
	settler common.Address,
	sourceAmount *big.Int,
	chainID *big.Int,
) ([]byte, apitypes.TypedData, error) {
	typedData := e.BuildTypedDataWithQuoteSource(escrowContract, depositID, quoteHash, settler, sourceAmount, chainID)
	hash, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return nil, apitypes.TypedData{}, fmt.Errorf("failed to generate EIP-712 hash (v2 quote+source): %w", err)
	}

	return hash, typedData, nil
}
