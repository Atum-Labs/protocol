package encoding

import (
	"fmt"
	"math/big"

	contracts "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/tvm/bindings/go/escrow-encoding/generated"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// EscrowRefundEncoder implements digest encoding for the V3 escrow Refund
// function (using TIP-712). Mirrors the EVM equivalent. RefundWitness has 8
// fields, identical in shape to ReleaseWitness. Escrow domain version is "3".
// chainID is masked to its lower 4 bytes for TIP-712.
type EscrowRefundEncoder struct{}

// NewEscrowRefundEncoder returns an EscrowRefundEncoder.
func NewEscrowRefundEncoder() EscrowRefundEncoder {
	return EscrowRefundEncoder{}
}

// BuildTypedData constructs the TIP-712 typed data for a refund witness.
func (e EscrowRefundEncoder) BuildTypedData(
	escrowContract common.Address,
	witness contracts.IEscrowRefundWitness,
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
			"RefundWitness": []apitypes.Type{
				{Name: "paymentId", Type: "bytes32"},
				{Name: "depositor", Type: "address"},
				{Name: "token", Type: "address"},
				{Name: "amount", Type: "uint256"},
				{Name: "feeAmount", Type: "uint256"},
				{Name: "reserver", Type: "address"},
				{Name: "releaser", Type: "address"},
				{Name: "settler", Type: "address"},
			},
		},
		PrimaryType: "RefundWitness",
		Domain: apitypes.TypedDataDomain{
			Name:              "Escrow",
			Version:           "3",
			ChainId:           math.NewHexOrDecimal256(maskedChainID.Int64()),
			VerifyingContract: escrowContract.Hex(),
		},
		Message: apitypes.TypedDataMessage{
			"paymentId": common.BytesToHash(witness.DepositId[:]).Hex(),
			"depositor": witness.Depositor.Hex(),
			"token":     witness.Token.Hex(),
			"amount":    witness.Amount.String(),
			"feeAmount": witness.FeeAmount.String(),
			"reserver":  witness.Reserver.Hex(),
			"releaser":  witness.Releaser.Hex(),
			"settler":   witness.Settler.Hex(),
		},
	}
}

// Digest returns the TIP-712 hash of a refund witness, the value that gets signed.
func (e EscrowRefundEncoder) Digest(
	escrowContract common.Address,
	witness contracts.IEscrowRefundWitness,
	chainID *big.Int,
) ([]byte, error) {
	hash, _, err := apitypes.TypedDataAndHash(e.BuildTypedData(escrowContract, witness, chainID))
	if err != nil {
		return nil, fmt.Errorf("failed to generate TIP-712 hash: %w", err)
	}
	return hash, nil
}

// DigestWithTypedData returns Digest together with the typed data it hashed.
func (e EscrowRefundEncoder) DigestWithTypedData(
	escrowContract common.Address,
	witness contracts.IEscrowRefundWitness,
	chainID *big.Int,
) ([]byte, apitypes.TypedData, error) {
	typedData := e.BuildTypedData(escrowContract, witness, chainID)
	hash, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return nil, apitypes.TypedData{}, fmt.Errorf("failed to generate TIP-712 hash: %w", err)
	}
	return hash, typedData, nil
}

// BuildTypedDataWithQuoteHash builds the V2 RefundWitness TIP-712 typed data: the ELEVEN-member
// witness the redeployed escrow verifies, reproducing the typehash Escrow.sol pins as
// REFUND_WITNESS_TYPE_HASH (0x3b5d88b2…):
//
//	RefundWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,
//	  bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,
//	  address reserver,address releaser,address settler)
//
// Member order is the argument order of the `abi.encode(REFUND_WITNESS_TYPE_HASH, …)` call in
// ../../../source/contracts/Escrow.sol (`_refund`), and TestRefundWitnessV2TypeHash asserts the
// resulting typehash against that constant EXTRACTED FROM THE SOURCE — not against a literal.
//
// This builder previously declared only NINE members, omitting depositRequestHash and
// destinationHash at positions 3 and 4, so every V2 refund signature it produced recovered to the
// wrong signer. It stayed green because the pin test compared it against the keccak of its own stale
// type string. Do not "simplify" the member list; it is fixed by the contract.
//
// Additive — the V1 8-member BuildTypedData above is untouched, so pre-redeploy signatures do not
// move. Use it only against the escrow that is live for you.
func (e EscrowRefundEncoder) BuildTypedDataWithQuoteHash(
	escrowContract common.Address,
	witness contracts.IEscrowRefundWitness,
	quoteHash [32]byte,
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
			"RefundWitness": []apitypes.Type{
				{Name: "depositId", Type: "bytes32"},
				{Name: "quoteHash", Type: "bytes32"},
				{Name: "depositRequestHash", Type: "bytes32"},
				{Name: "destinationHash", Type: "bytes32"},
				{Name: "depositor", Type: "address"},
				{Name: "token", Type: "address"},
				{Name: "amount", Type: "uint256"},
				{Name: "feeAmount", Type: "uint256"},
				{Name: "reserver", Type: "address"},
				{Name: "releaser", Type: "address"},
				{Name: "settler", Type: "address"},
			},
		},
		PrimaryType: "RefundWitness",
		Domain: apitypes.TypedDataDomain{
			Name:              "Escrow",
			Version:           "3",
			ChainId:           math.NewHexOrDecimal256(maskedChainID.Int64()),
			VerifyingContract: escrowContract.Hex(),
		},
		Message: apitypes.TypedDataMessage{
			"depositId":          common.BytesToHash(witness.DepositId[:]).Hex(),
			"quoteHash":          common.BytesToHash(quoteHash[:]).Hex(),
			"depositRequestHash": common.BytesToHash(witness.DepositRequestHash[:]).Hex(),
			"destinationHash":    common.BytesToHash(witness.DestinationHash[:]).Hex(),
			"depositor":          witness.Depositor.Hex(),
			"token":              witness.Token.Hex(),
			"amount":             witness.Amount.String(),
			"feeAmount":          witness.FeeAmount.String(),
			"reserver":           witness.Reserver.Hex(),
			"releaser":           witness.Releaser.Hex(),
			"settler":            witness.Settler.Hex(),
		},
	}
}

// DigestWithQuoteHash returns the V2 refund digest + typed data (for the prehash).
//
// The loose quoteHash parameter predates the binding regeneration that gave
// contracts.IEscrowRefundWitness its own QuoteHash member; it is kept because callers pass it
// positionally. Escrow.sol hashes refundWitness.quoteHash, so if the witness carries a NON-ZERO
// QuoteHash that disagrees with the parameter, the digest signed here is not the digest the contract
// will verify. That is refused rather than encoded: it is the same class of defect fixed.
func (e EscrowRefundEncoder) DigestWithQuoteHash(
	escrowContract common.Address,
	witness contracts.IEscrowRefundWitness,
	quoteHash [32]byte,
	chainID *big.Int,
) ([]byte, apitypes.TypedData, error) {
	if witness.QuoteHash != ([32]byte{}) && witness.QuoteHash != quoteHash {
		return nil, apitypes.TypedData{}, fmt.Errorf(
			"refund witness QuoteHash %#x disagrees with the quoteHash argument %#x: the escrow hashes the "+
				"witness member, so signing the argument would produce a signature that recovers to the wrong signer",
			witness.QuoteHash, quoteHash)
	}
	typedData := e.BuildTypedDataWithQuoteHash(escrowContract, witness, quoteHash, chainID)
	hash, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return nil, apitypes.TypedData{}, fmt.Errorf("failed to generate TIP-712 hash (v2 quoteHash): %w", err)
	}
	return hash, typedData, nil
}
