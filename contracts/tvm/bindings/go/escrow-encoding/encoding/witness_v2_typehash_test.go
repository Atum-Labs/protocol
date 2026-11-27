package encoding

import (
	"math/big"
	"strings"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/generated"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// These tie the V2 witness typehashes to ../../../source/contracts/Escrow.sol — the contract that is
// about to be deployed — by EXTRACTING each `*_WITNESS_TYPE_HASH` constant from the Solidity source
// at test time. Nothing about the expected value is transcribed into this file.
//
// WHY THAT MATTERS, because it is the entire point of CORE-1863. These tests used to compare each
// encoder against a hardcoded hex literal: 0xc005c392… for ReleaseWitness and 0xe8ca5e1b… for
// RefundWitness, described in the docstring as "tvm-contracts main on-chain values". They were not.
// They were the keccak of THIS MODULE'S OWN nine-field type strings — the hashes of the very Types
// maps under test. Escrow.sol pins the ELEVEN-field 0x7b53386f… and 0x3b5d88b2…, which carry
// `bytes32 depositRequestHash` and `bytes32 destinationHash` at positions 3 and 4. So the encoders
// had drifted from the contract, and the tests that existed to catch that FROZE the drift and
// reported green. A pin whose expected value derives from the thing under test is worse than no pin:
// it converts an unnoticed divergence into an actively defended one.
//
// The rule this file now follows: the oracle is the contract source, extracted mechanically. The
// canonical type strings below stay as readable literals so a failure prints a legible diff, but they
// are NOT the oracle — assertV2TypeHashMatchesEscrowSource compares the encoder's own TypeHash
// against the source-extracted constant directly, so editing a literal here cannot make a wrong
// encoder pass.
//
// A note on scope, so the next reader does not "tidy" it: only the V2 (…WithQuoteHash /
// …WithQuoteSource / …WithDestination) builders are asserted against Escrow.sol. The V1 builders
// intentionally still emit the frozen pre-redeploy shapes, including the member name `paymentId`,
// and pre-redeploy signatures must not move. Renaming one member name silently moves a frozen
// typehash.

func TestReserveWitnessV2TypeHash(t *testing.T) {
	td := EscrowReserveEncoder{}.BuildTypedDataWithQuoteSource(
		common.Address{}, [32]byte{}, [32]byte{}, common.Address{}, big.NewInt(0), big.NewInt(1))
	assertV2TypeHashMatchesEscrowSource(t, td, "ReserveWitness",
		"ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)",
		"RESERVE_WITNESS_TYPE_HASH")
}

func TestReleaseWitnessV2TypeHash(t *testing.T) {
	w := contracts.IEscrowReleaseWitness{Amount: big.NewInt(0), FeeAmount: big.NewInt(0)}
	td := EscrowReleaseEncoder{}.BuildTypedDataWithQuoteHash(common.Address{}, w, [32]byte{}, big.NewInt(1))
	assertV2TypeHashMatchesEscrowSource(t, td, "ReleaseWitness",
		"ReleaseWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,"+
			"address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,"+
			"address settler)",
		"RELEASE_WITNESS_TYPE_HASH")
}

func TestRefundWitnessV2TypeHash(t *testing.T) {
	w := contracts.IEscrowRefundWitness{Amount: big.NewInt(0), FeeAmount: big.NewInt(0)}
	td := EscrowRefundEncoder{}.BuildTypedDataWithQuoteHash(common.Address{}, w, [32]byte{}, big.NewInt(1))
	assertV2TypeHashMatchesEscrowSource(t, td, "RefundWitness",
		"RefundWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,"+
			"address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,"+
			"address settler)",
		"REFUND_WITNESS_TYPE_HASH")
}

func TestDepositWitnessV2TypeHash(t *testing.T) {
	td := newDepositV2TypedDataForPinning()
	assertV2TypeHashMatchesEscrowSource(t, td, "DepositWitness",
		"DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)",
		"DEPOSIT_WITNESS_TYPE_HASH")
}

// TestDepositV2PermitWitnessTypeStringMatchesEscrowSource is the deposit-specific half of the pin,
// and it guards a failure mode the Foundry fork suites structurally cannot see.
//
// A deposit is not verified by the escrow directly: the escrow hands Permit2 an opaque bytes32
// witness hash TOGETHER WITH the witness TYPE STRING (FULL_DEPOSIT_WITNESS_TYPE_STRING), and Permit2
// splices that string into the `PermitWitnessTransferFrom(...)` type it hashes. If the string the
// contract passes and the type the signer hashed disagree by one character, recovery yields a
// different address and NO DEPOSIT CAN EVER SUCCEED — and because Permit2 receives the witness as an
// opaque hash, a fork test that stubs Permit2 still passes.
//
// So this asserts that what go-ethereum's apitypes builds for the V2 typed data ENDS WITH the exact
// string Escrow.sol hands Permit2, extracted from the source.
func TestDepositV2PermitWitnessTypeStringMatchesEscrowSource(t *testing.T) {
	fullWitnessTypeString := escrowSourceStringConstant(t, "FULL_DEPOSIT_WITNESS_TYPE_STRING")

	td := newDepositV2TypedDataForPinning()
	encoded := string(td.EncodeType("PermitWitnessTransferFrom"))

	if !strings.HasSuffix(encoded, fullWitnessTypeString) {
		t.Fatalf("the V2 deposit typed data does not end in the witness type string Escrow.sol hands Permit2.\n"+
			"  apitypes encodeType:                         %s\n"+
			"  Escrow.sol FULL_DEPOSIT_WITNESS_TYPE_STRING: %s\n"+
			"Permit2 splices its own copy of that string into the type it hashes, so any difference means every "+
			"deposit signature recovers to the wrong signer and the deposit reverts. The fork suites cannot catch "+
			"this: Permit2 takes the witness as an opaque bytes32.",
			encoded, fullWitnessTypeString)
	}
}

// TestWitnessStructDeclarationsMatchEscrowSourceTypeHashes is a SECOND, INDEPENDENT oracle: it
// rebuilds each canonical type string member by member from the `struct` DECLARATION in IEscrow.sol
// and requires it to hash to the typehash Escrow.sol actually uses.
//
// Why both: the tests above tie the ENCODERS to Escrow.sol's constants. This ties those constants to
// the struct declarations the Go bindings are generated from. Exchanging two adjacent same-type
// members in a declaration (`bytes32 depositRequestHash` / `bytes32 destinationHash`) moves no
// selector and no event topic0, and Escrow.sol reads every member by name — so the contract keeps
// working while the generated bindings silently reorder, and a positional caller populates the two
// commitments swapped. With both oracles in place, no single edit can make this package green while
// the deployed contract disagrees.
func TestWitnessStructDeclarationsMatchEscrowSourceTypeHashes(t *testing.T) {
	iface := iEscrowSourceCode(t)

	for _, tc := range []struct {
		structName     string
		sourceConstant string
	}{
		{"DepositWitness", "DEPOSIT_WITNESS_TYPE_HASH"},
		{"ReserveWitness", "RESERVE_WITNESS_TYPE_HASH"},
		{"ReleaseWitness", "RELEASE_WITNESS_TYPE_HASH"},
		{"RefundWitness", "REFUND_WITNESS_TYPE_HASH"},
	} {
		t.Run(tc.structName, func(t *testing.T) {
			found, declared, err := typeStringFromDeclaration(iface, tc.structName)
			if err != nil {
				t.Fatalf("rebuild the %s type string from its declaration in %s: %v",
					tc.structName, iEscrowSourcePath, err)
			}
			if !found {
				t.Fatalf("no `struct %s {` declaration found in %s — it was renamed or removed. "+
					"This guard cannot verify anything, which is a FAILURE, not a skip.",
					tc.structName, iEscrowSourcePath)
			}

			want := escrowSourceTypeHash(t, tc.sourceConstant)
			if got := crypto.Keccak256Hash([]byte(declared)); got != want {
				t.Fatalf("the %s STRUCT DECLARATION has drifted from the typehash Escrow.sol uses.\n"+
					"  rebuilt from %s: %s\n"+
					"  which hashes to: %s\n"+
					"  Escrow.sol %s: %s\n"+
					"Do NOT repoint anything to make this pass: a changed declaration is a breaking change for "+
					"every generated client. Re-derive it out of band and treat it as one.",
					tc.structName, iEscrowSourcePath, declared, got.Hex(), tc.sourceConstant, want.Hex())
			}
		})
	}
}

// newDepositV2TypedDataForPinning builds V2 deposit typed data with placeholder values. Only the
// Types map (and therefore the type strings and typehashes) is under test here, so the values are
// arbitrary — but every *big.Int must be non-nil, because the builder marshals them into Message.
func newDepositV2TypedDataForPinning() apitypes.TypedData {
	w := contracts.IEscrowDepositWitness{Destination: "eip155:1:0x0000000000000000000000000000000000000000"}
	return EscrowDepositEncoder{}.BuildTypedDataWithDestination(
		common.Address{}, common.Address{}, common.Address{}, w,
		big.NewInt(0), big.NewInt(0), big.NewInt(0), big.NewInt(1))
}

// assertV2TypeHashMatchesEscrowSource hashes the encoder-produced TypedData (not a hand-copied field
// list) and compares it against the typehash EXTRACTED FROM Escrow.sol.
//
// Two assertions, deliberately not one:
//
//   - encodeType == wantType gives a legible member-by-member diff when an encoder changes.
//   - TypeHash == the source-extracted constant is the assertion that actually has teeth. It reads
//     the expected value out of the contract on every run, so it cannot be satisfied by editing this
//     file — which is exactly how the old hardcoded pins ended up defending a nine-field encoder
//     against an eleven-field contract.
func assertV2TypeHashMatchesEscrowSource(
	t *testing.T,
	td apitypes.TypedData,
	primary, wantType, sourceConstant string,
) {
	t.Helper()

	if got := string(td.EncodeType(primary)); got != wantType {
		t.Errorf("%s encodeType mismatch:\n got: %s\nwant: %s", primary, got, wantType)
	}

	want := escrowSourceTypeHash(t, sourceConstant)
	if got := common.BytesToHash(td.TypeHash(primary)); got != want {
		t.Fatalf("%s typehash has DRIFTED FROM THE CONTRACT.\n"+
			"  encoder Types map: %s\n"+
			"  %s in %s: %s\n"+
			"The encoder and the escrow about to be deployed disagree, so every signature this builder produces "+
			"would recover to the wrong signer. Fix the encoder's Types map — do NOT repoint the expectation, "+
			"which is read from the contract source and is not editable from this file.",
			primary, got.Hex(), sourceConstant, escrowSourcePath, want.Hex())
	}
}
