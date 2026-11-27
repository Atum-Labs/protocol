package encoding

import (
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// These tests guard the GUARD. witness_v2_typehash_test.go is only as trustworthy as the scanner it
// reads its expectations through, and the failure mode that matters is not a wrong answer — it is a
// scanner that finds nothing and lets the caller pass anyway. Every case below is driven by a
// RUNTIME STRING, never by a symbol, so each one actually compiles and actually executes: a mutation
// proof whose mutant fails to build is void, because the assertion never ran.

const (
	scannerHexA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	scannerHexB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func TestFindDeclaredTypeHashFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name             string
		source           string
		constantName     string
		wantDeclarations int
		wantValue        string
	}{
		{
			name:             "a real declaration is found and decoded",
			source:           "bytes32 private constant RELEASE_WITNESS_TYPE_HASH =\n        0x" + scannerHexA + ";",
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 1,
			wantValue:        "0x" + scannerHexA,
		},
		{
			name:             "mixed-case hex decodes to the same value",
			source:           "bytes32 private constant RELEASE_WITNESS_TYPE_HASH = 0x" + strings.ToUpper(scannerHexA) + ";",
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 1,
			wantValue:        "0x" + scannerHexA,
		},
		{
			name:             "a name that does not exist reports zero, so the caller fails instead of skipping",
			source:           "bytes32 private constant RELEASE_WITNESS_TYPE_HASH = 0x" + scannerHexA + ";",
			constantName:     "NO_SUCH_WITNESS_TYPE_HASH",
			wantDeclarations: 0,
		},
		{
			name: "a natspec comment above the constant is not a declaration",
			// This is the exact hole a naive regexp falls into: both Escrow.sol files carry a
			// `keccak256("…")` comment DIRECTLY ABOVE every typehash constant.
			source:           codeOnly("// keccak256 RELEASE_WITNESS_TYPE_HASH = 0x" + scannerHexA + ";\n"),
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 0,
		},
		{
			name:             "a commented-out old declaration does not win",
			source:           codeOnly("// bytes32 private constant RELEASE_WITNESS_TYPE_HASH = 0x" + scannerHexA + ";\n"),
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 0,
		},
		{
			name:             "a block-commented declaration does not win",
			source:           codeOnly("/* bytes32 private constant RELEASE_WITNESS_TYPE_HASH = 0x" + scannerHexA + "; */"),
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 0,
		},
		{
			name:             "a longer identifier containing the name does not satisfy it",
			source:           "bytes32 private constant FULL_RELEASE_WITNESS_TYPE_HASH = 0x" + scannerHexA + ";",
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 0,
		},
		{
			name:             "a prefixed identifier does not satisfy it either",
			source:           "bytes32 private constant RELEASE_WITNESS_TYPE_HASH_V1 = 0x" + scannerHexA + ";",
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 0,
		},
		{
			name:             "without the `constant` keyword it is not a declaration",
			source:           "bytes32 private RELEASE_WITNESS_TYPE_HASH = 0x" + scannerHexA + ";",
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 0,
		},
		{
			name:             "a keyword that merely ends in `constant` does not count",
			source:           "bytes32 private notconstant RELEASE_WITNESS_TYPE_HASH = 0x" + scannerHexA + ";",
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 0,
		},
		{
			name:             "an `==` comparison is not a declaration",
			source:           "bytes32 private constant RELEASE_WITNESS_TYPE_HASH == 0x" + scannerHexA + ";",
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 0,
		},
		{
			name:             "a truncated hex literal is rejected",
			source:           "bytes32 private constant RELEASE_WITNESS_TYPE_HASH = 0x1234;",
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 0,
		},
		{
			name:             "a 65-nibble literal is not a bytes32 and is rejected",
			source:           "bytes32 private constant RELEASE_WITNESS_TYPE_HASH = 0x" + scannerHexA + "c;",
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 0,
		},
		{
			name:             "a non-hex value is rejected",
			source:           "bytes32 private constant RELEASE_WITNESS_TYPE_HASH = keccak256(\"x\");",
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 0,
		},
		{
			name: "two declarations are reported so the caller can refuse to guess",
			source: "bytes32 private constant RELEASE_WITNESS_TYPE_HASH = 0x" + scannerHexA + ";\n" +
				"bytes32 private constant RELEASE_WITNESS_TYPE_HASH = 0x" + scannerHexB + ";",
			constantName:     "RELEASE_WITNESS_TYPE_HASH",
			wantDeclarations: 2,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			declarations, value := findDeclaredTypeHash(tc.source, tc.constantName)
			if declarations != tc.wantDeclarations {
				t.Fatalf("declarations = %d, want %d (source: %q)", declarations, tc.wantDeclarations, tc.source)
			}
			if tc.wantValue != "" && value != common.HexToHash(tc.wantValue) {
				t.Fatalf("value = %s, want %s", value.Hex(), tc.wantValue)
			}
		})
	}
}

func TestFindDeclaredStringConstantFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name             string
		source           string
		wantDeclarations int
		wantValue        string
	}{
		{
			name:             "a real declaration is found and decoded",
			source:           "string private constant FULL_DEPOSIT_WITNESS_TYPE_STRING =\n        \"DepositWitness witness)\";",
			wantDeclarations: 1,
			wantValue:        "DepositWitness witness)",
		},
		{
			name:             "adjacent literals are concatenated the way Solidity concatenates them",
			source:           "string private constant FULL_DEPOSIT_WITNESS_TYPE_STRING = \"Deposit\" \"Witness\";",
			wantDeclarations: 1,
			wantValue:        "DepositWitness",
		},
		{
			name:             "an escaped quote is decoded, not treated as a terminator",
			source:           "string private constant FULL_DEPOSIT_WITNESS_TYPE_STRING = \"a\\\"b\";",
			wantDeclarations: 1,
			wantValue:        "a\"b",
		},
		{
			name:             "a commented-out declaration does not win",
			source:           codeOnly("// string private constant FULL_DEPOSIT_WITNESS_TYPE_STRING = \"stale\";\n"),
			wantDeclarations: 0,
		},
		{
			name:             "a missing terminator makes it not a declaration",
			source:           "string private constant FULL_DEPOSIT_WITNESS_TYPE_STRING = \"unterminated",
			wantDeclarations: 0,
		},
		{
			name:             "a non-literal initialiser is rejected",
			source:           "string private constant FULL_DEPOSIT_WITNESS_TYPE_STRING = otherConstant;",
			wantDeclarations: 0,
		},
		{
			name:             "an escape this decoder does not understand is rejected rather than half-decoded",
			source:           "string private constant FULL_DEPOSIT_WITNESS_TYPE_STRING = \"a\\qb\";",
			wantDeclarations: 0,
		},
		{
			name: "two declarations are reported so the caller can refuse to guess",
			source: "string private constant FULL_DEPOSIT_WITNESS_TYPE_STRING = \"one\";\n" +
				"string private constant FULL_DEPOSIT_WITNESS_TYPE_STRING = \"two\";",
			wantDeclarations: 2,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			declarations, value := findDeclaredStringConstant(tc.source, "FULL_DEPOSIT_WITNESS_TYPE_STRING")
			if declarations != tc.wantDeclarations {
				t.Fatalf("declarations = %d, want %d (source: %q)", declarations, tc.wantDeclarations, tc.source)
			}
			if tc.wantValue != "" && value != tc.wantValue {
				t.Fatalf("value = %q, want %q", value, tc.wantValue)
			}
		})
	}
}

func TestCodeOnlyStripsCommentsButKeepsStringLiterals(t *testing.T) {
	for _, tc := range []struct {
		name   string
		source string
		want   string
	}{
		{
			name:   "a line comment becomes a space and keeps its newline",
			source: "a // gone\nb",
			want:   "a  \nb",
		},
		{
			name:   "a block comment becomes a single space",
			source: "a/* gone */b",
			want:   "a b",
		},
		{
			name:   "a `//` inside a string literal is not a comment",
			source: "x = \"a//b\";",
			want:   "x = \"a//b\";",
		},
		{
			name:   "a `/*` inside a string literal is not a comment",
			source: "x = \"a/*b*/c\";",
			want:   "x = \"a/*b*/c\";",
		},
		{
			name:   "an escaped quote does not end the string, so the trailing comment still strips",
			source: "x = \"a\\\"//b\"; // gone\n",
			want:   "x = \"a\\\"//b\";  \n",
		},
		{
			name:   "an unterminated block comment consumes the rest of the file",
			source: "a /* forever",
			want:   "a  ",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := codeOnly(tc.source); got != tc.want {
				t.Fatalf("codeOnly(%q) = %q, want %q", tc.source, got, tc.want)
			}
		})
	}
}

func TestTypeStringFromDeclarationFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name       string
		source     string
		structName string
		wantFound  bool
		wantType   string
		wantErr    bool
	}{
		{
			name:       "a real declaration is rebuilt in declaration order",
			source:     "struct ReserveWitness {\n bytes32 depositId;\n bytes32 quoteHash;\n address settler;\n uint256 sourceAmount;\n }",
			structName: "ReserveWitness",
			wantFound:  true,
			wantType:   "ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)",
		},
		{
			name:       "a newline between the keyword and the name still matches",
			source:     "struct\n\tReserveWitness\n{ address settler; }",
			structName: "ReserveWitness",
			wantFound:  true,
			wantType:   "ReserveWitness(address settler)",
		},
		{
			name:       "a struct that does not exist is not found, which the caller must treat as a failure",
			source:     "struct ReserveWitness { address settler; }",
			structName: "ReleaseWitness",
			wantFound:  false,
		},
		{
			name:       "a longer struct name does not satisfy a search for the shorter one",
			source:     "struct ReleaseWitnessV2 { address settler; }",
			structName: "ReleaseWitness",
			wantFound:  false,
		},
		{
			name:       "a commented-out declaration does not win",
			source:     codeOnly("// struct ReleaseWitness { address stale; }\n"),
			structName: "ReleaseWitness",
			wantFound:  false,
		},
		{
			name:       "a same-named function parameter is not a declaration",
			source:     "function f(ReleaseWitness calldata w) {}",
			structName: "ReleaseWitness",
			wantFound:  false,
		},
		{
			name:       "an array member errors rather than being encoded as if elementary",
			source:     "struct ReleaseWitness { bytes32[] ids; }",
			structName: "ReleaseWitness",
			wantErr:    true,
		},
		{
			name:       "a nested struct member errors, because its type definition would have to be appended",
			source:     "struct ReleaseWitness { TokenPermissions permitted; }",
			structName: "ReleaseWitness",
			wantErr:    true,
		},
		{
			name:       "an empty body errors",
			source:     "struct ReleaseWitness { }",
			structName: "ReleaseWitness",
			wantErr:    true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			found, typeString, err := typeStringFromDeclaration(tc.source, tc.structName)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected an error, got found=%v typeString=%q", found, typeString)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if found != tc.wantFound {
				t.Fatalf("found = %v, want %v", found, tc.wantFound)
			}
			if tc.wantType != "" && typeString != tc.wantType {
				t.Fatalf("typeString = %q, want %q", typeString, tc.wantType)
			}
		})
	}
}

// TestEscrowSourceOracleResolves is the "can this guard see its oracle at all" check. If the vendored
// contract moves, is renamed, or stops declaring one of these constants, every pin in
// witness_v2_typehash_test.go loses its oracle — and the whole point of CORE-1863 is that a pin
// without a real oracle reports green while the encoder drifts. Failing here says so out loud.
func TestEscrowSourceOracleResolves(t *testing.T) {
	source := escrowSourceCode(t)
	for _, name := range []string{
		"DEPOSIT_WITNESS_TYPE_HASH",
		"RESERVE_WITNESS_TYPE_HASH",
		"RELEASE_WITNESS_TYPE_HASH",
		"REFUND_WITNESS_TYPE_HASH",
	} {
		declarations, value := findDeclaredTypeHash(source, name)
		if declarations != 1 {
			t.Errorf("%s: found %d declarations in %s, want exactly 1", name, declarations, escrowSourcePath)
			continue
		}
		if value == (common.Hash{}) {
			t.Errorf("%s: declared as the zero hash in %s, which cannot be a real typehash", name, escrowSourcePath)
		}
	}

	if declarations, value := findDeclaredStringConstant(source, "FULL_DEPOSIT_WITNESS_TYPE_STRING"); declarations != 1 || value == "" {
		t.Errorf("FULL_DEPOSIT_WITNESS_TYPE_STRING: found %d declarations (value %q) in %s, want exactly 1 non-empty",
			declarations, value, escrowSourcePath)
	}
}
