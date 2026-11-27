package encoding

import (
	"encoding/json"
	"fmt"
	contracts "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/evm/bindings/go/escrow-encoding/generated"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// EscrowRefundEncoder implements digest encoding for the escrow contract Refund function using typed data signing.
type EscrowRefundEncoder struct{}

// NewEscrowRefundEncoder returns an EscrowRefundEncoder.
func NewEscrowRefundEncoder() EscrowRefundEncoder {
	return EscrowRefundEncoder{}
}

// BuildTypedData constructs the EIP-712 TypedData for a V3 RefundWitness.
// Exposed so callers can both hash it (via Digest / TypedDataAndHash) and
// json.Marshal it for downstream use as the message prehash.
// V3: RefundWitness has 8 fields including feeAmount between amount and reserver.
// V3: Escrow domain version is "3".
//
// PURE PROJECTION: returns apitypes.TypedData with no error, so it cannot report that the witness
// carries QuoteHash / DepositRequestHash / DestinationHash — the three members the regenerated
// eleven-member binding has and this eight-member V1 type does not declare. Digest and
// DigestWithTypedData carry that guard (assertRefundWitnessV1Complete in v1_witness_guard.go).
func (e EscrowRefundEncoder) BuildTypedData(
	escrowContract common.Address,
	witness contracts.IEscrowRefundWitness,
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
			ChainId:           math.NewHexOrDecimal256(chainID.Int64()),
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

// Digest implements the EIP-712 hashing algorithm for V3 Refund witness.
//
// FAILS CLOSED with ErrV1WitnessDropsMembers when the witness carries QuoteHash,
// DepositRequestHash or DestinationHash: the eight-member V1 type declares none of them, so the
// digest would commit to none of them. Use DigestWithQuoteHash on the redeployed escrow. Zero
// means "not supplied", so pre-redeploy callers are unaffected.
func (e EscrowRefundEncoder) Digest(
	escrowContract common.Address,
	witness contracts.IEscrowRefundWitness,
	chainID *big.Int,
) ([]byte, error) {
	if err := assertRefundWitnessV1Complete(witness); err != nil {
		return nil, err
	}
	hash, _, err := apitypes.TypedDataAndHash(e.BuildTypedData(escrowContract, witness, chainID))
	if err != nil {
		return nil, fmt.Errorf("failed to generate EIP-712 hash: %w", err)
	}
	return hash, nil
}

// DigestWithTypedData returns both the EIP-712 hash (signing input) and the
// typed-data structure itself, so callers can ship the typed data alongside
// the signature as a JSON-encoded message prehash.
//
// V1 shape, so it carries the same ErrV1WitnessDropsMembers guard as Digest.
func (e EscrowRefundEncoder) DigestWithTypedData(
	escrowContract common.Address,
	witness contracts.IEscrowRefundWitness,
	chainID *big.Int,
) ([]byte, apitypes.TypedData, error) {
	if err := assertRefundWitnessV1Complete(witness); err != nil {
		return nil, apitypes.TypedData{}, err
	}
	typedData := e.BuildTypedData(escrowContract, witness, chainID)
	hash, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return nil, apitypes.TypedData{}, fmt.Errorf("failed to generate EIP-712 hash: %w", err)
	}
	return hash, typedData, nil
}

// BuildTypedDataWithQuoteHash constructs the EIP-712 TypedData for the V2 RefundWitness — the
// ELEVEN-field shape the redeployed escrow actually verifies (quote hash + destination commitment +
// veri-fill trust model). It is an ADDITIVE sibling of BuildTypedData; callers MUST gate this path
// behind a dark flag until the redeploy.
//
// The field set + order reproduce Escrow.sol's REFUND_WITNESS_TYPE_HASH:
//
//	RefundWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)
//
// That claim is NOT asserted here against a transcribed hex constant. escrow_source_typehash_test.go
// extracts REFUND_WITNESS_TYPE_HASH from contracts/evm/source/src/Escrow.sol and compares it
// against this Types map, so the contract is the oracle. This builder once declared only
// NINE members (depositRequestHash and destinationHash missing at positions 3-4) and the test that
// should have caught it pinned the hash of this module's own stale type string — a self-oracle that
// froze the divergence and reported green.
//
// ADDITIVE: BuildTypedData / Digest / DigestWithTypedData keep the frozen EIGHT-field V1 shape,
// member name "paymentId" included, byte-for-byte. Pre-redeploy signatures do not move.
//
// quoteHash is a legacy loose parameter and stays authoritative for the quoteHash member. The
// regenerated binding now also carries witness.QuoteHash; DigestWithQuoteHash rejects a witness
// whose non-zero QuoteHash disagrees with this parameter, so the two cannot silently diverge.
// Prefer passing the same value in both, or leave witness.QuoteHash zero.
//
// depositId carries the same value as the V1 paymentId (witness.DepositId).
// Domain stays Name "Escrow" Version "3".
func (e EscrowRefundEncoder) BuildTypedDataWithQuoteHash(
	escrowContract common.Address,
	witness contracts.IEscrowRefundWitness,
	quoteHash [32]byte,
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
			ChainId:           math.NewHexOrDecimal256(chainID.Int64()),
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

// DigestWithQuoteHash implements the EIP-712 hashing for the V2 RefundWitness
// (quoteHash-bound). It returns both the signing digest and the JSON-encoded
// TypedData prehash, mirroring how DigestWithTypedData feeds the message layer.
// ADDITIVE: does not touch the 8-field BuildTypedData / Digest path.
//
// Fails closed when witness.QuoteHash is populated and disagrees with the quoteHash argument:
// signing a digest built from the argument while the caller believes the witness field is what
// binds would produce a signature the contract rejects, and the two values are trivially easy to
// wire from different places. Zero witness.QuoteHash means "not supplied" and the argument wins.
func (e EscrowRefundEncoder) DigestWithQuoteHash(
	escrowContract common.Address,
	witness contracts.IEscrowRefundWitness,
	quoteHash [32]byte,
	chainID *big.Int,
) ([]byte, []byte, error) {
	if witness.QuoteHash != ([32]byte{}) && witness.QuoteHash != quoteHash {
		return nil, nil, fmt.Errorf(
			"refund witness QuoteHash %s disagrees with the quoteHash argument %s: "+
				"pass the same value in both, or leave witness.QuoteHash zero",
			common.BytesToHash(witness.QuoteHash[:]).Hex(), common.BytesToHash(quoteHash[:]).Hex())
	}
	typedData := e.BuildTypedDataWithQuoteHash(escrowContract, witness, quoteHash, chainID)
	hash, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to generate EIP-712 hash (v2 quoteHash): %w", err)
	}
	prehash, err := json.Marshal(typedData)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to marshal refund typed data (v2 quoteHash): %w", err)
	}
	return hash, prehash, nil
}
