package encoding

import (
	"fmt"
	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// EscrowDepositEncoder implements digest encoding for escrow contract Deposit function (using EIP-712).
type EscrowDepositEncoder struct{}

// NewEscrowDepositEncoder returns an EscrowDepositEncoder.
func NewEscrowDepositEncoder() EscrowDepositEncoder {
	return EscrowDepositEncoder{}
}

// BuildTypedData constructs the EIP-712 TypedData for the V3 Permit2
// PermitWitnessTransferFrom message. Exposed so callers can both hash it (via
// Digest / TypedDataAndHash) and json.Marshal it for downstream use as the
// message prehash. Note: Permit2's on-chain EIP-712 domain has only name,
// chainId, and verifyingContract — no `version` field, no `salt`.
//
// This builder is a PURE PROJECTION and does not reject anything: it returns
// apitypes.TypedData with no error, so it cannot report that the witness carries members the
// frozen two-member V1 DepositWitness does not hash (DepositRequestHash, Destination). Digest and
// DigestWithTypedData — which already return an error — carry that guard; see
// assertDepositWitnessV1Complete in v1_witness_guard.go. That guard is package private and stays
// that way deliberately: it has no caller outside this package, and the two routes that ARE
// reachable already cover the case. Reach the check through Digest / DigestWithTypedData, or use
// BuildTypedDataWithDestination, which declares all four members and so needs no guard at all.
func (e EscrowDepositEncoder) BuildTypedData(
	permit2Contract common.Address,
	token common.Address,
	spender common.Address,
	witness contracts.IEscrowDepositWitness,
	amount *big.Int,
	nonce *big.Int,
	deadline *big.Int,
	chainID *big.Int,
) apitypes.TypedData {
	return apitypes.TypedData{
		Types: apitypes.Types{
			"EIP712Domain": []apitypes.Type{
				{Name: "name", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"PermitWitnessTransferFrom": []apitypes.Type{
				{Name: "permitted", Type: "TokenPermissions"},
				{Name: "spender", Type: "address"},
				{Name: "nonce", Type: "uint256"},
				{Name: "deadline", Type: "uint256"},
				{Name: "witness", Type: "DepositWitness"},
			},
			"TokenPermissions": []apitypes.Type{
				{Name: "token", Type: "address"},
				{Name: "amount", Type: "uint256"},
			},
			"DepositWitness": []apitypes.Type{
				{Name: "reserver", Type: "address"},
				{Name: "releaser", Type: "address"},
			},
		},
		PrimaryType: "PermitWitnessTransferFrom",
		Domain: apitypes.TypedDataDomain{
			Name:              "Permit2",
			ChainId:           math.NewHexOrDecimal256(chainID.Int64()),
			VerifyingContract: permit2Contract.Hex(),
		},
		Message: apitypes.TypedDataMessage{
			"permitted": map[string]interface{}{
				"token":  token.Hex(),
				"amount": amount.String(),
			},
			"spender":  spender.Hex(),
			"nonce":    nonce.String(),
			"deadline": deadline.String(),
			"witness": map[string]interface{}{
				"reserver": witness.Reserver.Hex(),
				"releaser": witness.Releaser.Hex(),
			},
		},
	}
}

// BuildTypedDataWithDestination constructs the EIP-712 TypedData for the V2 Permit2
// PermitWitnessTransferFrom message, whose DepositWitness is the FOUR-field shape the redeployed
// escrow actually verifies, including the destination commitment:
//
//	DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)
//
// That claim is NOT asserted here against a transcribed hex constant. escrow_source_typehash_test.go
// extracts DEPOSIT_WITNESS_TYPE_HASH from contracts/evm/source/src/Escrow.sol and compares it
// against this Types map, and a second guard ties it to FULL_DEPOSIT_WITNESS_TYPE_STRING — the
// witness-type string the contract hands Permit2, which must stay in lockstep or NO DEPOSIT CAN
// EVER SUCCEED. Permit2 receives the witness as an opaque bytes32, so a fork test cannot catch a
// mismatch there; only the source tie can.
//
// ADDITIVE: BuildTypedData / Digest / DigestWithTypedData keep the frozen TWO-field V1 witness
// ({reserver, releaser}) byte-for-byte, so pre-redeploy deposit signatures do not move. Note what
// V1 does with the other two members: BuildTypedData accepts a full four-field witness and hashes
// only the two it declares, and it cannot report that (it returns no error). Digest and
// DigestWithTypedData therefore REJECT a witness carrying either commitment with
// ErrV1WitnessDropsMembers instead of returning a digest that commits to neither. Callers on the
// redeployed escrow MUST use this builder; callers still on the deployed escrow MUST use V1. Gate
// the switch behind the same dark flag as the release/refund V2 path.
//
// destination is a Solidity `string` member, so EIP-712 hashes it as keccak256(bytes(destination))
// — apitypes does this for "string" — and the plaintext destination is what a client signing
// policy engine sees. Its grammar is a CAIP-19 asset identifier, a literal "@", then the account in
// its namespace's native form (NOT CAIP-10; see ONCHAIN_SPEC.md "Destination grammar"). This
// builder imposes no grammar or length check on it: the contract's MAX_DESTINATION_BYTES cap is a
// calldata bound owned by Escrow.sol, and duplicating it here as an untied Go constant would
// recreate exactly the hand-transcription problem that once made the typehash disagree with the contract.
//
// Permit2's on-chain EIP-712 domain has only name, chainId, and verifyingContract — no `version`,
// no `salt`.
func (e EscrowDepositEncoder) BuildTypedDataWithDestination(
	permit2Contract common.Address,
	token common.Address,
	spender common.Address,
	witness contracts.IEscrowDepositWitness,
	amount *big.Int,
	nonce *big.Int,
	deadline *big.Int,
	chainID *big.Int,
) apitypes.TypedData {
	return apitypes.TypedData{
		Types: apitypes.Types{
			"EIP712Domain": []apitypes.Type{
				{Name: "name", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"PermitWitnessTransferFrom": []apitypes.Type{
				{Name: "permitted", Type: "TokenPermissions"},
				{Name: "spender", Type: "address"},
				{Name: "nonce", Type: "uint256"},
				{Name: "deadline", Type: "uint256"},
				{Name: "witness", Type: "DepositWitness"},
			},
			"TokenPermissions": []apitypes.Type{
				{Name: "token", Type: "address"},
				{Name: "amount", Type: "uint256"},
			},
			"DepositWitness": []apitypes.Type{
				{Name: "depositRequestHash", Type: "bytes32"},
				{Name: "destination", Type: "string"},
				{Name: "reserver", Type: "address"},
				{Name: "releaser", Type: "address"},
			},
		},
		PrimaryType: "PermitWitnessTransferFrom",
		Domain: apitypes.TypedDataDomain{
			Name:              "Permit2",
			ChainId:           math.NewHexOrDecimal256(chainID.Int64()),
			VerifyingContract: permit2Contract.Hex(),
		},
		Message: apitypes.TypedDataMessage{
			"permitted": map[string]interface{}{
				"token":  token.Hex(),
				"amount": amount.String(),
			},
			"spender":  spender.Hex(),
			"nonce":    nonce.String(),
			"deadline": deadline.String(),
			"witness": map[string]interface{}{
				"depositRequestHash": common.BytesToHash(witness.DepositRequestHash[:]).Hex(),
				"destination":        witness.Destination,
				"reserver":           witness.Reserver.Hex(),
				"releaser":           witness.Releaser.Hex(),
			},
		},
	}
}

// DigestWithDestination returns both the EIP-712 hash (signing input) and the typed-data structure
// for the V2 four-field DepositWitness (see BuildTypedDataWithDestination), mirroring how
// DigestWithTypedData feeds the message layer. ADDITIVE: does not touch the V1 path.
func (e EscrowDepositEncoder) DigestWithDestination(
	permit2Contract common.Address,
	token common.Address,
	spender common.Address,
	witness contracts.IEscrowDepositWitness,
	amount *big.Int,
	nonce *big.Int,
	deadline *big.Int,
	chainID *big.Int,
) ([]byte, apitypes.TypedData, error) {
	typedData := e.BuildTypedDataWithDestination(
		permit2Contract, token, spender, witness, amount, nonce, deadline, chainID,
	)
	hash, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return nil, apitypes.TypedData{}, fmt.Errorf("failed to generate EIP-712 hash (v2 destination): %w", err)
	}
	return hash, typedData, nil
}

// Digest implements the Permit2 EIP-712 hashing algorithm to produce a digest
// that can be signed by a private key. V3 contracts remove requestId from witness.
//
// V1 (TWO-field witness): commits to {reserver, releaser} only. It FAILS CLOSED with
// ErrV1WitnessDropsMembers when witness.DepositRequestHash or witness.Destination is populated,
// rather than hashing neither and returning a digest that commits to neither — use
// DigestWithDestination on the redeployed escrow. A zero-valued member means "not supplied", so
// every pre-redeploy caller is unaffected.
func (e EscrowDepositEncoder) Digest(
	permit2Contract common.Address,
	token common.Address,
	spender common.Address,
	witness contracts.IEscrowDepositWitness,
	amount *big.Int,
	nonce *big.Int,
	deadline *big.Int,
	chainID *big.Int,
) ([]byte, error) {
	if err := assertDepositWitnessV1Complete(witness); err != nil {
		return nil, err
	}
	hash, _, err := apitypes.TypedDataAndHash(e.BuildTypedData(
		permit2Contract, token, spender, witness, amount, nonce, deadline, chainID,
	))
	if err != nil {
		return nil, fmt.Errorf("failed to generate EIP-712 hash: %w", err)
	}
	return hash, nil
}

// DigestWithTypedData returns both the EIP-712 hash (signing input) and the
// typed-data structure itself, so callers can ship the typed data alongside
// the signature as a JSON-encoded message prehash.
//
// V1 shape, so it carries the same ErrV1WitnessDropsMembers guard as Digest — and it matters more
// here: the typed data returned by this method becomes the message_prehash a verifier rebuilds
// from, so a dropped commitment member would be absent from the prehash too and the verifier
// could not tell it was ever intended.
func (e EscrowDepositEncoder) DigestWithTypedData(
	permit2Contract common.Address,
	token common.Address,
	spender common.Address,
	witness contracts.IEscrowDepositWitness,
	amount *big.Int,
	nonce *big.Int,
	deadline *big.Int,
	chainID *big.Int,
) ([]byte, apitypes.TypedData, error) {
	if err := assertDepositWitnessV1Complete(witness); err != nil {
		return nil, apitypes.TypedData{}, err
	}
	typedData := e.BuildTypedData(
		permit2Contract, token, spender, witness, amount, nonce, deadline, chainID,
	)
	hash, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return nil, apitypes.TypedData{}, fmt.Errorf("failed to generate EIP-712 hash: %w", err)
	}
	return hash, typedData, nil
}
