package encoding

// Source-extraction oracle for the EIP-712 witness typehashes (CORE-1863).
//
// WHY THIS FILE EXISTS. Three of the four V2 witness builders in this package disagreed with
// Escrow.sol, and the tests that existed to catch that reported green for both of them, because
// their expected value was DERIVED FROM THE THING UNDER TEST:
//
//	Test{Release,Refund}WitnessV2TypeHash pinned 0xc005c392… / 0xe8ca5e1b… — the keccak of the
//	module's OWN stale NINE-field type strings. Escrow.sol pins the ELEVEN-field
//	0x7b53386f… / 0x3b5d88b2…. The encoder and the pin were wrong together, they agreed, and the
//	suite passed.
//
// A pin whose expected value comes from the subject is worse than no pin: it converts drift into a
// green check and documents the wrong value for the next reader. (The same mistake, in the same
// module, cost two releases of silent event-topic0 drift — see the write-up in event_topic0_test.go.)
//
// So the oracle here is Escrow.sol itself, EXTRACTED FROM SOURCE AT TEST TIME, never transcribed
// into this file as a hex literal. There is exactly one hardcoded hash in this package after
// CORE-1863 and it lives in Solidity, not Go.
//
// WHY TEXT-SCAN AND NOT THE ABI. The typehashes are `private constant`, so they do not appear in
// the generated ABI at all (grep -c WITNESS_TYPE_HASH over source/generated/abi/*.json = 0). The
// ABI route that event_topic0_test.go uses for event topic0s is therefore unavailable, and reading
// the Solidity text is the only way to reach these values. Only the path-access pattern is borrowed
// from that file.
//
// WHY IT HAS TO BE A GO TEST. `forge test` never runs in this repo's CI — the evm-contracts job is
// fmt + build --sizes only (.github/workflows/ci.yml), because the Foundry suites fork mainnet and
// run upstream. EncodingExamples.verify.t.sol already ties these constants to Escrow.sol correctly,
// but that guard is not executed here. The `go` job is, for every go.mod in the tree. A guard in
// Solidity would be a guard that never runs.
//
// The scan mechanism is a faithful port of _assertTypeHashTiedToEscrowSource /
// _findDeclaredTypeHash / _codeOnly in contracts/evm/source/test/EncodingExamples.verify.t.sol, and
// it needs all four of that implementation's hardening properties. Both Escrow.sol files carry a
//
//	// keccak256("ReleaseWitness(...)");
//
// comment directly above each constant, and a commented-out or "previously was 0x…" declaration is
// exactly the kind of thing edits leave behind, so:
//
//  1. comments are stripped BEFORE scanning, so comment text is never a candidate;
//  2. the `constant` keyword is required, so a local variable cannot satisfy the scan;
//  3. the identifier is anchored on both sides, so FULL_DEPOSIT_WITNESS_TYPE_STRING cannot satisfy
//     a scan for DEPOSIT_WITNESS_TYPE_HASH and vice versa;
//  4. the match COUNT is returned, so zero (renamed, removed, no longer `constant`) and two-or-more
//     (ambiguous — this guard cannot tell which value ships) both fail loudly instead of silently
//     trusting whichever came first.
//
// TestEscrowSourceScannerFailsClosed proves each of those on synthetic sources. A guard that quietly
// passes when it cannot find its target is worse than no guard.

import (
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// escrowSourcePath is the Solidity contract these encoders must agree with. Resolves from this
// package directory; mirrors the abiSourceDir pattern in event_topic0_test.go. Escrow.sol is an
// ordinary tracked file (not a submodule), so the read works in CI, which checks out without
// submodules.
const escrowSourcePath = "../../../../source/src/Escrow.sol"

func isIdentifierChar(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
}

func isSolWhitespace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

func isHexChar(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

// codeOnly returns source with every comment replaced by a single space, so a scan over the result
// can only match real code.
//
// A comment becomes ONE SPACE rather than being deleted, so it can never fuse the tokens on either
// side of it into a single identifier, and a line comment's terminating newline is preserved so line
// structure survives. String literals are respected: a // or /* inside a string never starts a
// comment, and a backslash-escaped quote never ends the string.
func codeOnly(source string) string {
	src := []byte(source)
	out := make([]byte, 0, len(src))
	for i := 0; i < len(src); {
		c := src[i]

		if c == '"' || c == '\'' {
			quote := c
			out = append(out, c)
			i++
			for i < len(src) {
				if src[i] == '\\' && i+1 < len(src) {
					out = append(out, src[i], src[i+1])
					i += 2
					continue
				}
				out = append(out, src[i])
				closing := src[i] == quote
				i++
				if closing {
					break
				}
			}
			continue
		}

		if c == '/' && i+1 < len(src) && src[i+1] == '/' {
			out = append(out, ' ')
			i += 2
			for i < len(src) && src[i] != '\n' {
				i++
			}
			continue // the newline itself is copied by the next iteration
		}

		if c == '/' && i+1 < len(src) && src[i+1] == '*' {
			out = append(out, ' ')
			i += 2
			for i+1 < len(src) && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			if i+1 < len(src) {
				i += 2
			} else {
				i = len(src)
			}
			continue
		}

		out = append(out, c)
		i++
	}
	return string(out)
}

// declarationAt reports whether a `constant <constantName>` declaration starts at src[i], and if so
// returns the offset just past the `=` that follows the name. Shared by the typehash and string
// scanners so both get identical anchoring.
func declarationAt(src []byte, i int, name []byte) (afterEquals int, ok bool) {
	const keyword = "constant"

	if i+len(name) > len(src) {
		return 0, false
	}
	if i > 0 && isIdentifierChar(src[i-1]) {
		return 0, false
	}
	if string(src[i:i+len(name)]) != string(name) {
		return 0, false
	}
	after := i + len(name)
	if after < len(src) && isIdentifierChar(src[after]) {
		return 0, false
	}

	// The `constant` keyword must sit immediately before the name (whitespace aside).
	back := i
	for back > 0 && isSolWhitespace(src[back-1]) {
		back--
	}
	if back < len(keyword) {
		return 0, false
	}
	keywordStart := back - len(keyword)
	if keywordStart > 0 && isIdentifierChar(src[keywordStart-1]) {
		return 0, false
	}
	if string(src[keywordStart:back]) != keyword {
		return 0, false
	}

	k := after
	for k < len(src) && isSolWhitespace(src[k]) {
		k++
	}
	if k >= len(src) || src[k] != '=' {
		return 0, false
	}
	k++
	if k < len(src) && src[k] == '=' {
		return 0, false // an `==` comparison, not a declaration
	}
	return k, true
}

// findDeclaredTypeHash returns how many `constant <constantName> = 0x<64 hex>;` declarations appear
// in source, plus the value of the last one. Callers MUST assert the count is exactly 1: see the
// file header for why 0 and 2+ have to fail rather than be tolerated.
//
// source is expected to have been through codeOnly. Candidates that fail validation (wrong
// punctuation, non-hex, wrong width) are skipped rather than aborting the scan, matching the
// Solidity implementation.
func findDeclaredTypeHash(source, constantName string) (declarations int, value common.Hash) {
	src := []byte(source)
	name := []byte(constantName)
	if len(name) == 0 || len(src) < len(name) {
		return 0, common.Hash{}
	}

	for i := 0; i+len(name) <= len(src); i++ {
		k, ok := declarationAt(src, i, name)
		if !ok {
			continue
		}
		for k < len(src) && isSolWhitespace(src[k]) {
			k++
		}
		if k+2 > len(src) || src[k] != '0' || (src[k+1] != 'x' && src[k+1] != 'X') {
			continue
		}
		hexStart := k + 2
		if hexStart+64 > len(src) {
			continue
		}
		validHex := true
		for m := 0; m < 64; m++ {
			if !isHexChar(src[hexStart+m]) {
				validHex = false
				break
			}
		}
		if !validHex {
			continue
		}
		// Reject a literal WIDER than 32 bytes instead of silently reading its first 64 digits.
		if hexStart+64 < len(src) && isHexChar(src[hexStart+64]) {
			continue
		}
		declarations++
		value = common.HexToHash("0x" + string(src[hexStart:hexStart+64]))
	}
	return declarations, value
}

// findDeclaredStringConstant is findDeclaredTypeHash for a `constant <name> = "…";` string, used for
// FULL_DEPOSIT_WITNESS_TYPE_STRING. Adjacent literals are concatenated, as Solidity does, so
// rewrapping that long line cannot break the guard.
func findDeclaredStringConstant(source, constantName string) (declarations int, value string) {
	src := []byte(source)
	name := []byte(constantName)
	if len(name) == 0 || len(src) < len(name) {
		return 0, ""
	}

	for i := 0; i+len(name) <= len(src); i++ {
		k, ok := declarationAt(src, i, name)
		if !ok {
			continue
		}
		var sb strings.Builder
		pieces := 0
		for {
			for k < len(src) && isSolWhitespace(src[k]) {
				k++
			}
			if k >= len(src) || src[k] != '"' {
				break
			}
			k++
			closed := false
			for k < len(src) {
				if src[k] == '\\' && k+1 < len(src) {
					// Only the escapes Solidity string constants in this repo actually use.
					switch src[k+1] {
					case '"', '\\':
						sb.WriteByte(src[k+1])
					default:
						sb.WriteByte(src[k])
						sb.WriteByte(src[k+1])
					}
					k += 2
					continue
				}
				if src[k] == '"' {
					k++
					closed = true
					break
				}
				sb.WriteByte(src[k])
				k++
			}
			if !closed {
				pieces = 0
				break
			}
			pieces++
		}
		if pieces == 0 {
			continue
		}
		declarations++
		value = sb.String()
	}
	return declarations, value
}

// escrowSourceCode reads Escrow.sol and strips its comments.
func escrowSourceCode(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(escrowSourcePath)
	if err != nil {
		t.Fatalf("read %s: %v (the encoders in this package are only correct relative to this "+
			"contract; if the path moved, repoint escrowSourcePath — do not delete the guard)",
			escrowSourcePath, err)
	}
	if len(raw) == 0 {
		t.Fatalf("%s is empty — an empty oracle would make every assertion below vacuous", escrowSourcePath)
	}
	return codeOnly(string(raw))
}

// escrowTypeHashFromSource returns the value of a typehash constant declared in Escrow.sol, failing
// unless exactly one declaration exists. This is the oracle every typehash assertion in this
// package now uses.
func escrowTypeHashFromSource(t *testing.T, constantName string) common.Hash {
	t.Helper()
	declarations, value := findDeclaredTypeHash(escrowSourceCode(t), constantName)
	if declarations != 1 {
		t.Fatalf("expected exactly ONE `constant %s = 0x…;` declaration in %s (comments excluded), found %d: "+
			"zero means it was renamed, removed, or is no longer a `constant`; more than one means the name is "+
			"declared twice and this guard cannot tell which value ships",
			constantName, escrowSourcePath, declarations)
	}
	return value
}

// assertWitnessTypeHashMatchesEscrowSource hashes the encoder's ACTUAL Types map (not a copy of it)
// and compares the result against the constant extracted from Escrow.sol. Because it reads the same
// apitypes.TypedData the signing path builds, a member added, dropped, renamed, retyped, or
// reordered in the encoder fails here.
func assertWitnessTypeHashMatchesEscrowSource(
	t *testing.T, primaryType, constantName string, td apitypes.TypedData,
) {
	t.Helper()
	want := escrowTypeHashFromSource(t, constantName)
	got := common.BytesToHash(td.TypeHash(primaryType))
	if got != want {
		t.Fatalf("%s typehash drifted from the contract.\n"+
			"  encoder:    %s\n"+
			"  Escrow.sol: %s (%s)\n"+
			"  encoder type string: %s\n"+
			"The encoder and %s disagree, so signatures produced by this builder will not verify "+
			"on-chain. Fix the Types map to match the contract; do NOT repin an expected value here.",
			primaryType, got.Hex(), want.Hex(), constantName, string(td.EncodeType(primaryType)), escrowSourcePath)
	}
}

// ---- the four witnesses, each tied to Escrow.sol ----
//
// Reserve/Release/Refund also have per-witness Test…WitnessV2TypeHash functions in their own files
// (repointed to this same oracle by CORE-1863); this table is the one place all four are asserted
// together, so a witness added to the contract without an encoder is visible as a gap here.

// witnessTypeHashCase pairs a witness's Escrow.sol constant with the typed data the ACTUAL encoder
// builds for it.
type witnessTypeHashCase struct {
	primaryType  string
	constantName string
	td           apitypes.TypedData
}

func witnessTypeHashCases(t *testing.T) []witnessTypeHashCase {
	t.Helper()
	chainID := big.NewInt(1)

	depositTD := EscrowDepositEncoder{}.BuildTypedDataWithDestination(
		common.Address{}, common.Address{}, common.Address{},
		contracts.IEscrowDepositWitness{},
		big.NewInt(0), big.NewInt(0), big.NewInt(0), chainID,
	)
	reserveTD := EscrowReserveEncoder{}.BuildTypedDataWithQuoteSource(
		common.Address{}, [32]byte{}, [32]byte{}, common.Address{}, big.NewInt(0), chainID,
	)
	// big.Int members must be non-nil: the builders marshal them into Message.
	releaseTD := EscrowReleaseEncoder{}.BuildTypedDataWithQuoteHash(
		common.Address{},
		contracts.IEscrowReleaseWitness{Amount: big.NewInt(0), FeeAmount: big.NewInt(0)},
		[32]byte{}, chainID,
	)
	refundTD := EscrowRefundEncoder{}.BuildTypedDataWithQuoteHash(
		common.Address{},
		contracts.IEscrowRefundWitness{Amount: big.NewInt(0), FeeAmount: big.NewInt(0)},
		[32]byte{}, chainID,
	)

	return []witnessTypeHashCase{
		{"DepositWitness", "DEPOSIT_WITNESS_TYPE_HASH", depositTD},
		{"ReserveWitness", "RESERVE_WITNESS_TYPE_HASH", reserveTD},
		{"ReleaseWitness", "RELEASE_WITNESS_TYPE_HASH", releaseTD},
		{"RefundWitness", "REFUND_WITNESS_TYPE_HASH", refundTD},
	}
}

// TestWitnessTypeHashesMatchEscrowSource is the guard whose absence let three of the four witnesses
// diverge: it compares every V2 builder's typehash against the constant declared in Escrow.sol.
func TestWitnessTypeHashesMatchEscrowSource(t *testing.T) {
	cases := witnessTypeHashCases(t)
	if len(cases) != 4 {
		t.Fatalf("expected all four witnesses to be covered, got %d", len(cases))
	}
	for _, tc := range cases {
		t.Run(tc.primaryType, func(t *testing.T) {
			assertWitnessTypeHashMatchesEscrowSource(t, tc.primaryType, tc.constantName, tc.td)
		})
	}
}

// TestDepositWitnessTypeStringMatchesPermit2FullTypeString ties the deposit encoder to the OTHER
// deposit-side constant: FULL_DEPOSIT_WITNESS_TYPE_STRING, the witness-type string Escrow.sol hands
// Permit2. Permit2 takes the witness as an opaque bytes32 and hashes this string itself, so if the
// two drift apart no deposit can ever succeed — and because the mismatch is inside Permit2, a fork
// test against the escrow cannot catch it. This is a second, independent oracle for the same
// four-field shape: the typehash tie above would still pass if the contract's Permit2 string were
// wrong.
func TestDepositWitnessTypeStringMatchesPermit2FullTypeString(t *testing.T) {
	const constantName = "FULL_DEPOSIT_WITNESS_TYPE_STRING"

	declarations, full := findDeclaredStringConstant(escrowSourceCode(t), constantName)
	if declarations != 1 {
		t.Fatalf("expected exactly ONE `constant %s = \"…\";` declaration in %s (comments excluded), found %d",
			constantName, escrowSourcePath, declarations)
	}

	td := EscrowDepositEncoder{}.BuildTypedDataWithDestination(
		common.Address{}, common.Address{}, common.Address{},
		contracts.IEscrowDepositWitness{},
		big.NewInt(0), big.NewInt(0), big.NewInt(0), big.NewInt(1),
	)
	depositWitnessType := string(td.EncodeType("DepositWitness"))
	tokenPermissionsType := string(td.EncodeType("TokenPermissions"))

	// EIP-712 orders referenced types alphabetically, and DepositWitness < TokenPermissions.
	want := "DepositWitness witness)" + depositWitnessType + tokenPermissionsType
	if full != want {
		t.Fatalf("%s in %s disagrees with the deposit encoder's Types map.\n"+
			"  contract: %s\n"+
			"  encoder:  %s\n"+
			"A mismatch here means Permit2 hashes a different witness type than the escrow signs, "+
			"so NO DEPOSIT CAN SUCCEED.", constantName, escrowSourcePath, full, want)
	}

	// Stronger still, and independent of how the reconstruction above is spelled: the contract's
	// string must appear VERBATIM as the tail of the encoder's real top-level signing type string.
	// Permit2 derives what it hashes by concatenating its own
	// "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256
	// deadline," stub with exactly this constant, so that suffix relationship IS the on-chain
	// invariant. It catches a wrong ordering of the referenced types, or a stray extra type
	// reference, which reassembling the pieces by hand cannot.
	topLevel := string(td.EncodeType("PermitWitnessTransferFrom"))
	if !strings.HasSuffix(topLevel, full) {
		t.Fatalf("the deposit encoder's PermitWitnessTransferFrom type string does not end with %s.\n"+
			"  encoder top-level: %s\n"+
			"  contract witness:  %s\n"+
			"Permit2 hashes its stub concatenated with exactly that constant, so anything but a verbatim "+
			"suffix match means the depositor signs a different type than Permit2 verifies.",
			constantName, topLevel, full)
	}
}

// ---- the link that makes the bindings a legitimate oracle: structs vs the source ABI ----
//
// TestGeneratedBindingsMatchSourceABI in event_topic0_test.go polices the bindings' EVENTS against
// the source ABI, and nothing else — both sides of it iterate `.Events`. Until the guard below was
// added, NO test in this module tied the binding STRUCTS to the contracts, so a witness member
// renamed or reordered in IEscrow.sol without a `make generate` left every struct-derived assertion
// here comparing stale bindings against an encoder written to match them, and passing.

// abiComponent is one entry (parameter or struct member) in the source ABI. Only the fields this
// guard reads are declared; `components` recurses, because the witnesses are nested inside the
// DepositInput / ReleaseInput / RefundInput tuples rather than appearing at the top level.
type abiComponent struct {
	Name         string         `json:"name"`
	Type         string         `json:"type"`
	InternalType string         `json:"internalType"`
	Components   []abiComponent `json:"components"`
}

// abiEntry is one function/event/error in the source ABI.
type abiEntry struct {
	Inputs  []abiComponent `json:"inputs"`
	Outputs []abiComponent `json:"outputs"`
}

// structMember is an ordered (name, solidityType) pair — the whole of what a struct's EIP-712
// identity depends on.
type structMember struct {
	name         string
	solidityType string
}

// structNameFromInternalType turns `struct IEscrow.ReleaseWitness[]` into `ReleaseWitness`.
// The array suffix is dropped deliberately: solc emits the same member list for the scalar and the
// array form, so both are evidence about the same struct.
func structNameFromInternalType(internalType string) (string, bool) {
	const prefix = "struct "
	if !strings.HasPrefix(internalType, prefix) {
		return "", false
	}
	name := strings.TrimSuffix(strings.TrimPrefix(internalType, prefix), "[]")
	if i := strings.LastIndexByte(name, '.'); i >= 0 {
		name = name[i+1:]
	}
	if name == "" {
		return "", false
	}
	return name, true
}

// structShapesFromSourceABI returns {structName: ordered members} for every struct tuple anywhere in
// the SOURCE-EXTRACTED ABI of contract — the same authoritative input eventTopic0sFromSourceABI
// reads, deliberately NOT the ABI embedded in the bindings this guard exists to police.
//
// A struct used at several call sites must appear IDENTICALLY at each: solc emits one shape per
// struct, so a disagreement means the file is not a faithful extraction and this guard cannot tell
// which shape ships. That fails rather than silently keeping whichever was walked last.
func structShapesFromSourceABI(t *testing.T, contract string) map[string][]structMember {
	t.Helper()
	path := filepath.Join(abiSourceDir, contract+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read source ABI %s (run `make generate-abi` in contracts/evm/source): %v", path, err)
	}
	var entries []abiEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("parse source ABI %s: %v", path, err)
	}

	shapes := map[string][]structMember{}
	var walk func(c abiComponent)
	walk = func(c abiComponent) {
		if name, ok := structNameFromInternalType(c.InternalType); ok && len(c.Components) > 0 {
			members := make([]structMember, 0, len(c.Components))
			for _, m := range c.Components {
				members = append(members, structMember{name: m.Name, solidityType: m.Type})
			}
			if prev, seen := shapes[name]; seen && !reflect.DeepEqual(prev, members) {
				t.Fatalf("%s declares struct %s with two different shapes (%v vs %v) — the extraction is not "+
					"faithful, so this guard cannot tell which one ships", path, name, prev, members)
			}
			shapes[name] = members
		}
		for _, m := range c.Components {
			walk(m)
		}
	}
	for _, e := range entries {
		for _, c := range e.Inputs {
			walk(c)
		}
		for _, c := range e.Outputs {
			walk(c)
		}
	}
	if len(shapes) == 0 {
		t.Fatalf("%s declares no struct tuples — wrong file or an empty extraction, which would make every "+
			"assertion below vacuous", path)
	}
	return shapes
}

// bindingStructShape reads a generated binding struct's members in declaration order and expresses
// them the way the ABI does: the Solidity member name (abigen only upper-cases the leading letter)
// and the Solidity type.
func bindingStructShape(t *testing.T, witness any) []structMember {
	t.Helper()
	rt := reflect.TypeOf(witness)
	if rt.Kind() != reflect.Struct {
		t.Fatalf("expected a struct, got %s", rt.Kind())
	}
	members := make([]structMember, 0, rt.NumField())
	for i := 0; i < rt.NumField(); i++ {
		f := rt.Field(i)
		members = append(members, structMember{
			name:         string(f.Name[0]|0x20) + f.Name[1:],
			solidityType: solidityTypeForBindingField(t, f),
		})
	}
	return members
}

// TestWitnessBindingStructsMatchSourceABI compares each witness BINDING STRUCT against the tuple
// components in the source-extracted ABI, member by member and in order.
//
// This is the check TestWitnessTypeStringsMatchGeneratedBindings needs in order to be worth
// anything, and its absence was a live hole rather than a theoretical one: that test's oracle is the
// committed bindings, which are only as fresh as the last `make generate`. Reorder `bytes32
// depositRequestHash` and `bytes32 destinationHash` in IEscrow.sol and every existing guard in this
// package stays green — the contract reads its members by name so it keeps working, no selector and
// no event topic0 moves, the typehash constant need not change, and a positional caller of the stale
// bindings populates the two commitments SWAPPED. Only this guard fails.
func TestWitnessBindingStructsMatchSourceABI(t *testing.T) {
	shapes := structShapesFromSourceABI(t, "IEscrow")

	for _, tc := range []struct {
		name    string
		binding any
	}{
		{"DepositWitness", contracts.IEscrowDepositWitness{}},
		{"ReserveWitness", contracts.IEscrowReserveWitness{}},
		{"ReleaseWitness", contracts.IEscrowReleaseWitness{}},
		{"RefundWitness", contracts.IEscrowRefundWitness{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			want, ok := shapes[tc.name]
			if !ok {
				t.Fatalf("no `struct IEscrow.%s` tuple found in the source ABI — it was renamed or removed in "+
					"IEscrow.sol. This guard cannot verify anything, which is a FAILURE, not a skip.", tc.name)
			}
			got := bindingStructShape(t, tc.binding)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("the committed %s binding struct disagrees with the source ABI (STALE BINDINGS).\n"+
					"  source ABI: %v\n"+
					"  binding:    %v\n"+
					"Run `make generate` in contracts/evm/bindings/go/escrow-encoding. Every struct-derived assertion in "+
					"this package reads the binding, so until they agree those assertions are comparing the "+
					"encoder against a shape the contract no longer has.", tc.name, want, got)
			}
		})
	}
}

// ---- second oracle: member names + order come from the generated bindings ----

// solidityTypeForBindingField maps the Go types abigen emits for these witness structs onto their
// Solidity EIP-712 type names. Exhaustive-or-fail: an unmapped Go type fails the test instead of
// being guessed at.
func solidityTypeForBindingField(t *testing.T, f reflect.StructField) string {
	t.Helper()
	switch {
	case f.Type == reflect.TypeOf(common.Address{}):
		return "address"
	case f.Type == reflect.TypeOf((*big.Int)(nil)):
		// Every *big.Int member of the four witness structs is a uint256 in IEscrow.sol.
		return "uint256"
	case f.Type.Kind() == reflect.String:
		return "string"
	case f.Type.Kind() == reflect.Array && f.Type.Len() == 32 && f.Type.Elem().Kind() == reflect.Uint8:
		return "bytes32"
	}
	t.Fatalf("no Solidity type mapping for binding field %s of Go type %s — extend "+
		"solidityTypeForBindingField rather than letting this guard skip the member", f.Name, f.Type)
	return ""
}

// canonicalTypeStringFromBinding rebuilds the EIP-712 type string from a GENERATED BINDING STRUCT,
// which abigen derives from IEscrow.sol. abigen only upper-cases the leading letter, so lower-casing
// it back recovers the Solidity member name.
func canonicalTypeStringFromBinding(t *testing.T, typeName string, witness any) string {
	t.Helper()
	rt := reflect.TypeOf(witness)
	if rt.Kind() != reflect.Struct {
		t.Fatalf("%s: expected a struct, got %s", typeName, rt.Kind())
	}
	members := make([]string, 0, rt.NumField())
	for i := 0; i < rt.NumField(); i++ {
		f := rt.Field(i)
		name := string(f.Name[0]|0x20) + f.Name[1:] // ASCII lower-case of the first letter
		members = append(members, solidityTypeForBindingField(t, f)+" "+name)
	}
	return typeName + "(" + strings.Join(members, ",") + ")"
}

// TestWitnessTypeStringsMatchGeneratedBindings is the reason no type-string literal is transcribed
// anywhere in this package's tests. It derives the expected member names, types, and ORDER from the
// generated binding structs, which abigen produces from IEscrow.sol.
//
// WHAT POLICES THE BINDINGS, stated precisely, because this docstring previously got it wrong in
// exactly the way CORE-1863 is about. It used to say the binding structs were "already policed
// against the source ABI by TestGeneratedBindingsMatchSourceABI". They were not:
// TestGeneratedBindingsMatchSourceABI compares EVENTS ONLY — both of its sides iterate `.Events`
// (event_topic0_test.go) — and at the time NO test in this module tied the binding STRUCTS to the
// contract source. They were tied only to the encoder, by this very test, so the "policed" link the
// docstring leaned on ran in a circle. The claim described a chain that did not exist, which is the
// same defect class as a pin whose expected value comes from its subject: it invites the next reader
// to trust an unguarded link.
//
// The struct half of the chain is now real and is TestWitnessBindingStructsMatchSourceABI above,
// which compares the binding structs member-by-member against the tuple components in
// ../../../source/generated/abi/IEscrow.json. So the two independent chains onto the encoder are:
//
//	Escrow.sol constant                   -> typehash              (TestWitnessTypeHashesMatchEscrowSource)
//	IEscrow.sol -> source ABI -> bindings -> member names + order  (TestWitnessBindingStructsMatchSourceABI, then here)
//
// THE FIRST ARROW OF THE SECOND CHAIN IS NOT GUARDED, and saying so is the whole point of this block.
// TestWitnessBindingStructsMatchSourceABI's oracle is the COMMITTED ../../../source/generated/abi/IEscrow.json,
// not IEscrow.sol itself. Nothing in CI regenerates that ABI and diffs it — `grep -n generate-abi
// .github/workflows/ci.yml` returns nothing, and the evm-contracts job runs only `forge fmt --check` plus
// `forge build --sizes`. So editing IEscrow.sol WITHOUT running `make generate-abi` leaves the ABI and the
// bindings stale together, and every guard in this file stays green while all of them describe the old shape.
//
// Closing that link means running generate-abi in CI and failing on a diff. That is currently BLOCKED on
// CORE-1866: generated/abi/TIP712.json is nondeterministic on TVM (two contracts named TIP712 collide on one
// tronbox artifact filename, whichever compiles last wins), which makes `make check-abi` flaky by
// construction. Until that lands, the freshness of the committed ABI rests on the author remembering — which
// is exactly the kind of unguarded link the paragraph above warns about, and it is recorded here rather than
// implied away.
//
// What THIS test covers on its own, exactly: the encoder's Types map against the committed bindings.
// A member added, dropped, renamed, retyped, or reordered IN THE ENCODER fails here. A member
// renamed or reordered in IEscrow.sol WITHOUT regenerating does not — the bindings would move with
// the encoder and both would be wrong together; that case is the guard above, not this one.
//
// No single edit can turn both chains green while the encoder is wrong, and the second chain is what
// names the offending member when the first one fails with nothing but two hashes.
func TestWitnessTypeStringsMatchGeneratedBindings(t *testing.T) {
	bindings := map[string]any{
		"DepositWitness": contracts.IEscrowDepositWitness{},
		"ReserveWitness": contracts.IEscrowReserveWitness{},
		"ReleaseWitness": contracts.IEscrowReleaseWitness{},
		"RefundWitness":  contracts.IEscrowRefundWitness{},
	}

	for _, tc := range witnessTypeHashCases(t) {
		t.Run(tc.primaryType, func(t *testing.T) {
			witness, ok := bindings[tc.primaryType]
			if !ok {
				t.Fatalf("no generated binding struct registered for %s", tc.primaryType)
			}
			want := canonicalTypeStringFromBinding(t, tc.primaryType, witness)
			got := string(tc.td.EncodeType(tc.primaryType))
			if got != want {
				t.Fatalf("%s type string drifted from the generated binding struct.\n"+
					"  encoder: %s\n"+
					"  binding: %s\n"+
					"The binding is generated from IEscrow.sol, so the encoder is the side that is wrong "+
					"unless `make generate` is overdue.", tc.primaryType, got, want)
			}
		})
	}
}

// ---- the scanner's own guarantees ----

// TestEscrowSourceScannerFailsClosed proves the four hardening properties described in the file
// header, on synthetic sources. Without this, the scanner could silently match nothing — or match a
// comment — and every assertion above would pass vacuously while the encoders drifted. Each case
// states what a regression would let through.
func TestEscrowSourceScannerFailsClosed(t *testing.T) {
	const real = "bytes32 private constant RELEASE_WITNESS_TYPE_HASH =\n" +
		"    0x7b53386f16fef70a2a3ea71bda140486e6167753168b12a94b218b94de37fe7b;\n"

	cases := []struct {
		name     string
		source   string
		want     int
		wantHash string
		why      string
	}{
		{
			name:     "real declaration is found",
			source:   real,
			want:     1,
			wantHash: "0x7b53386f16fef70a2a3ea71bda140486e6167753168b12a94b218b94de37fe7b",
			why:      "the positive control; if this fails every other case is meaningless",
		},
		{
			name: "line-commented declaration is invisible",
			source: "// RELEASE_WITNESS_TYPE_HASH = " +
				"0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef;\n",
			want: 0,
			why:  "a leftover `previously was 0x…` note must not be able to satisfy the scan",
		},
		{
			name: "block-commented declaration is invisible",
			source: "/* bytes32 private constant RELEASE_WITNESS_TYPE_HASH =\n" +
				"   0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef; */\n",
			want: 0,
			why:  "a commented-out old declaration must not be able to satisfy the scan",
		},
		{
			name:   "natspec keccak256 comment above the constant is invisible",
			source: "// keccak256(\"ReleaseWitness(bytes32 depositId)\");\n// RELEASE_WITNESS_TYPE_HASH\n",
			want:   0,
			why:    "Escrow.sol really does carry this comment above each constant",
		},
		{
			name:   "missing `constant` keyword is rejected",
			source: "bytes32 RELEASE_WITNESS_TYPE_HASH = 0x7b53386f16fef70a2a3ea71bda140486e6167753168b12a94b218b94de37fe7b;\n",
			want:   0,
			why:    "a local variable or storage field is not the shipped constant",
		},
		{
			name:   "`==` comparison is rejected",
			source: "require(RELEASE_WITNESS_TYPE_HASH == 0x7b53386f16fef70a2a3ea71bda140486e6167753168b12a94b218b94de37fe7b);\n",
			want:   0,
			why:    "a comparison is not a declaration",
		},
		{
			name: "longer identifier containing the name is rejected",
			source: "bytes32 private constant FULL_RELEASE_WITNESS_TYPE_HASH =\n" +
				"    0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef;\n",
			want: 0,
			why:  "FULL_DEPOSIT_WITNESS_TYPE_STRING sits right beside DEPOSIT_WITNESS_TYPE_HASH in Escrow.sol",
		},
		{
			name: "suffixed identifier is rejected",
			source: "bytes32 private constant RELEASE_WITNESS_TYPE_HASH_V1 =\n" +
				"    0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef;\n",
			want: 0,
			why:  "anchoring has to hold on the trailing side too",
		},
		{
			name:   "duplicate declarations are reported, not silently resolved",
			source: real + real,
			want:   2,
			why:    "two declarations means this guard cannot tell which value ships",
		},
		{
			name:   "over-wide hex literal is rejected",
			source: "bytes32 private constant RELEASE_WITNESS_TYPE_HASH = 0x7b53386f16fef70a2a3ea71bda140486e6167753168b12a94b218b94de37fe7bAA;\n",
			want:   0,
			why:    "reading the first 64 digits of a 33-byte literal would invent a value nobody wrote",
		},
		{
			name:   "truncated hex literal is rejected",
			source: "bytes32 private constant RELEASE_WITNESS_TYPE_HASH = 0x7b53386f;\n",
			want:   0,
			why:    "a short literal is not a typehash",
		},
		{
			name:     "a `//` inside a string literal does not start a comment",
			source:   "string private constant P = \"http://x\"; " + real,
			want:     1,
			wantHash: "0x7b53386f16fef70a2a3ea71bda140486e6167753168b12a94b218b94de37fe7b",
			why:      "mis-handling string literals would blind the scanner to everything after such a string",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, value := findDeclaredTypeHash(codeOnly(tc.source), "RELEASE_WITNESS_TYPE_HASH")
			if got != tc.want {
				t.Fatalf("declarations = %d, want %d (%s)", got, tc.want, tc.why)
			}
			if tc.wantHash != "" && value != common.HexToHash(tc.wantHash) {
				t.Fatalf("value = %s, want %s", value.Hex(), tc.wantHash)
			}
		})
	}
}

// TestEscrowSourceScannerRejectsUnknownConstant is the fail-closed case that matters most in
// practice: if someone renames a constant in Escrow.sol, the scanner must report zero and the
// assertion helper must FAIL, not skip. The name is a string, so this mutation compiles — which is
// precisely why it is a valid proof and a compile-broken mutant would not be.
func TestEscrowSourceScannerRejectsUnknownConstant(t *testing.T) {
	declarations, value := findDeclaredTypeHash(escrowSourceCode(t), "RELEASE_WITNESS_TYPE_HASH_THAT_DOES_NOT_EXIST")
	if declarations != 0 {
		t.Fatalf("scanner found %d declarations of a nonexistent constant (value %s) — it is matching "+
			"something it should not", declarations, value.Hex())
	}
	// And the real names must all resolve, so the tests above are not vacuous.
	for _, name := range []string{
		"DEPOSIT_WITNESS_TYPE_HASH",
		"RESERVE_WITNESS_TYPE_HASH",
		"RELEASE_WITNESS_TYPE_HASH",
		"REFUND_WITNESS_TYPE_HASH",
	} {
		if got := escrowTypeHashFromSource(t, name); got == (common.Hash{}) {
			t.Fatalf("%s resolved to the zero hash", name)
		}
	}
}

// TestEscrowSourceStringScannerFailsClosed covers the string-constant scanner, which the Permit2
// witness-string guard depends on.
func TestEscrowSourceStringScannerFailsClosed(t *testing.T) {
	cases := []struct {
		name   string
		source string
		want   int
		value  string
	}{
		{
			name:   "single literal",
			source: "string private constant S = \"abc\";\n",
			want:   1,
			value:  "abc",
		},
		{
			name:   "adjacent literals are concatenated as Solidity does",
			source: "string private constant S =\n    \"ab\"\n    \"cd\";\n",
			want:   1,
			value:  "abcd",
		},
		{
			name:   "commented-out declaration is invisible",
			source: "// string private constant S = \"abc\";\n",
			want:   0,
		},
		{
			name:   "missing `constant` keyword is rejected",
			source: "string S = \"abc\";\n",
			want:   0,
		},
		{
			name:   "unterminated literal is rejected",
			source: "string private constant S = \"abc;\n",
			want:   0,
		},
		{
			name:   "non-string value is rejected",
			source: "string private constant S = OTHER;\n",
			want:   0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, value := findDeclaredStringConstant(codeOnly(tc.source), "S")
			if got != tc.want {
				t.Fatalf("declarations = %d, want %d", got, tc.want)
			}
			if tc.want == 1 && value != tc.value {
				t.Fatalf("value = %q, want %q", value, tc.value)
			}
		})
	}
}
