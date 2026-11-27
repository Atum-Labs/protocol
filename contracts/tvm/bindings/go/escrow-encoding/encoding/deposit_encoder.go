package encoding

import (
	"fmt"
	"math/big"

	contracts "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/generated"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// EscrowDepositEncoder implements digest encoding for the V3 escrow Deposit
// function via Permit2's PermitWitnessTransferFrom (using TIP-712).
//
// API mirrors github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/encoding.EscrowDepositEncoder. The only
// TIP-712-specific behaviour is that this encoder applies the Tron chain-ID
// mask (lower 4 bytes) to the chainID before stamping it into the EIP712Domain.
// Address fields are expected to already be normalized to 20-byte common.Address
// (no `0x41` Tron prefix) — use TVMAddress() to convert base58/hex inputs.
type EscrowDepositEncoder struct{}

// NewEscrowDepositEncoder returns an EscrowDepositEncoder.
func NewEscrowDepositEncoder() EscrowDepositEncoder {
	return EscrowDepositEncoder{}
}

// BuildTypedData constructs the TIP-712 TypedData for the V3 Permit2
// PermitWitnessTransferFrom message. Permit2's on-chain domain has only name,
// chainId, and verifyingContract — no version, no salt.
//
// V1 — FROZEN PRE-REDEPLOY SHAPE. THIS BUILDER DOES NOT MATCH THE CONTRACT ANY MORE.
//
// The typed data below declares the ORIGINAL TWO-member witness:
//
//	emitted here:  DepositWitness(address reserver,address releaser)                   0xbcc7a43f…
//	on-chain now:  DepositWitness(bytes32 depositRequestHash,string destination,
//	                              address reserver,address releaser)                   0x49bfb2c3…
//
// witness.DepositRequestHash and witness.Destination are accepted by this function and then SILENTLY
// DROPPED, which is correct only for the CURRENTLY DEPLOYED escrow. It is kept byte-for-byte because
// signatures already in flight must keep verifying; changing it would move a live typehash.
//
// USE BuildTypedDataWithDestination (below) FOR ANYTHING SUBMITTED TO THE REDEPLOYED ESCROW.
// Once that escrow is live, every deposit signature produced by THIS function
// recovers to the wrong signer and the deposit reverts. Migrating the callers is the remaining work;
// see the status note below.
//
// WITNESS REVISIONS. Two shapes exist, and which one you need depends only on which escrow you are
// signing for:
//
//	revision  builder                                              DepositWitness members
//	V1        BuildTypedData / Digest (this function)              reserver, releaser
//	V2        BuildTypedDataWithDestination / DigestWithDestination  depositRequestHash, destination,
//	                                                               reserver, releaser
//
// V1 matches the escrow deployed today; V2 matches the redeployed one. They produce different
// typehashes, so a signature made with the wrong revision recovers to the wrong signer and the
// deposit reverts. The authoritative definition of both is the contract itself
// (../../../source/contracts/Escrow.sol) and the on-chain spec beside it; this package's tests
// EXTRACT the typehashes from that source at test time rather than comparing against constants of
// their own, so the contract is always the oracle.
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
	maskedChainID := MaskTronChainIdBig(chainID)
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
			// FROZEN two-member V1 shape: deliberately missing depositRequestHash +
			// destination, which the current escrow does not verify. Read the
			// "V1 — FROZEN PRE-REDEPLOY SHAPE" note on BuildTypedData above before
			// touching this; the post-redeploy shape lives in
			// BuildTypedDataWithDestination.
			"DepositWitness": []apitypes.Type{
				{Name: "reserver", Type: "address"},
				{Name: "releaser", Type: "address"},
			},
		},
		PrimaryType: "PermitWitnessTransferFrom",
		Domain: apitypes.TypedDataDomain{
			Name:              "Permit2",
			ChainId:           math.NewHexOrDecimal256(maskedChainID.Int64()),
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

// Digest implements the Permit2 TIP-712 hashing algorithm to produce a digest
// that can be signed by a private key.
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
	hash, _, err := apitypes.TypedDataAndHash(e.BuildTypedData(
		permit2Contract, token, spender, witness, amount, nonce, deadline, chainID,
	))
	if err != nil {
		return nil, fmt.Errorf("failed to generate TIP-712 hash: %w", err)
	}
	return hash, nil
}

// DigestWithTypedData returns both the TIP-712 hash and the typed-data
// structure, so callers can ship the typed data alongside the signature as a
// JSON-encoded message prehash.
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
	typedData := e.BuildTypedData(
		permit2Contract, token, spender, witness, amount, nonce, deadline, chainID,
	)
	hash, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return nil, apitypes.TypedData{}, fmt.Errorf("failed to generate TIP-712 hash: %w", err)
	}
	return hash, typedData, nil
}

// BuildTypedDataWithDestination builds the V2 DepositWitness TIP-712 typed data: the FOUR-member
// witness the redeployed escrow verifies, reproducing the typehash Escrow.sol pins as
// DEPOSIT_WITNESS_TYPE_HASH (0x49bfb2c3…):
//
//	DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)
//
// Member order is the argument order of the `abi.encode(DEPOSIT_WITNESS_TYPE_HASH, …)` call in
// ../../../source/contracts/Escrow.sol (`deposit`), and TestDepositWitnessV2TypeHash asserts the
// resulting typehash against that constant EXTRACTED FROM THE SOURCE — not against a literal.
//
// The V2 name follows the sibling convention (…WithQuoteHash on release/refund, …WithQuoteSource on
// reserve): the new members here are depositRequestHash and the plaintext destination, not a quote
// hash. Additive — the V1 two-member BuildTypedData above is untouched, so signatures already in
// flight keep verifying. Use it only against the escrow that is live for you.
//
// TWO ENCODING DETAILS THAT ARE EASY TO GET WRONG:
//
//   - `destination` is a DYNAMIC `string` member, so EIP-712 hashes it as keccak256(bytes(value)).
//     apitypes does that for the `string` type, and Escrow.sol writes it explicitly as
//     keccak256(bytes(depositWitness.destination)) with a comment saying that passing the raw string
//     emits offset+len+data and matches no signer. Do not "optimise" this to bytes32.
//   - Permit2, not the escrow, verifies this signature. It splices its own copy of the witness type
//     string (Escrow.sol's FULL_DEPOSIT_WITNESS_TYPE_STRING) into the PermitWitnessTransferFrom type
//     it hashes, so the Types map here must produce a byte-identical tail.
//     TestDepositV2PermitWitnessTypeStringMatchesEscrowSource extracts that string from the contract
//     and checks exactly that; the Foundry fork suites cannot, because Permit2 receives the witness as
//     an opaque bytes32.
//
// Escrow.sol bounds the destination at MAX_DESTINATION_BYTES = 256 (uniform across EVM/TVM/SVM so one
// client signing-policy rule covers every chain) and reverts DestinationCannotBeEmpty /
// DestinationTooLong. BuildTypedDataWithDestination stays a pure encoder and does not check;
// DigestWithDestination mirrors both reverts, so a digest that could never be redeemed is not handed
// to a signer.
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
	maskedChainID := MaskTronChainIdBig(chainID)
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
			ChainId:           math.NewHexOrDecimal256(maskedChainID.Int64()),
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

// MaxDestinationBytes mirrors MAX_DESTINATION_BYTES in ../../../source/contracts/Escrow.sol, which
// reverts DestinationTooLong beyond it. It is uniform across EVM/TVM/SVM so one client signing-policy
// rule covers every chain, and TestMaxDestinationBytesMatchesEscrowSource extracts the contract's own
// value and fails if the two ever diverge.
const MaxDestinationBytes = 256

// DigestWithDestination returns the V2 deposit digest + typed data (for the prehash).
//
// Both destination invariants the escrow enforces are checked here, so a digest that could never be
// redeemed is never handed to a signer:
//
//   - EMPTY is refused (Escrow.sol reverts DestinationCannotBeEmpty). The escrow commits
//     keccak256(bytes(destination)) and every downstream signing-policy check reads the plaintext, so
//     an accidentally-unset destination would otherwise sign a commitment to nothing — silently, since
//     keccak256("") is a perfectly valid bytes32.
//   - OVER MaxDestinationBytes is refused (Escrow.sol reverts DestinationTooLong). The bound is on
//     BYTES, not runes, matching Solidity's bytes(destination).length.
//
// The V1 path has no destination at all and is unaffected.
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
	if witness.Destination == "" {
		return nil, apitypes.TypedData{}, fmt.Errorf(
			"deposit witness Destination is empty: the escrow reverts DestinationCannotBeEmpty, and because " +
				"keccak256(\"\") is a valid bytes32 this would otherwise sign a commitment to no destination at all")
	}
	if len(witness.Destination) > MaxDestinationBytes {
		return nil, apitypes.TypedData{}, fmt.Errorf(
			"deposit witness Destination is %d bytes, over the escrow's MAX_DESTINATION_BYTES of %d: the "+
				"contract reverts DestinationTooLong, so this digest could never be redeemed",
			len(witness.Destination), MaxDestinationBytes)
	}
	typedData := e.BuildTypedDataWithDestination(
		permit2Contract, token, spender, witness, amount, nonce, deadline, chainID,
	)
	hash, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return nil, apitypes.TypedData{}, fmt.Errorf("failed to generate TIP-712 hash (v2 destination): %w", err)
	}
	return hash, typedData, nil
}
