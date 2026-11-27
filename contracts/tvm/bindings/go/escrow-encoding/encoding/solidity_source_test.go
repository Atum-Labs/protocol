package encoding

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// ORACLE PATHS. The witness typehash a TIP-712 signature has to reproduce is declared as a
// `private constant` in Escrow.sol, so — unlike an event topic0 — it does NOT appear in the ABI
// (`grep -c WITNESS_TYPE_HASH ../../../source/generated/abi/{Escrow,IEscrow}.json` = 0). The only
// machine-readable statement of the value that ships is the Solidity source itself, so the guards
// in witness_v2_typehash_test.go text-scan it. The relative paths mirror event_topic0_test.go's
// `abiSourceDir = "../../../source/generated/abi"`; both files are ordinary tracked files (not
// submodule content), so the read works in the CI `go` job even though it checks out without
// `submodules: recursive`.
const (
	escrowSourcePath  = "../../../../source/contracts/Escrow.sol"
	iEscrowSourcePath = "../../../../source/contracts/interfaces/IEscrow.sol"
)

// escrowSourceCode returns Escrow.sol with every comment stripped, ready to scan.
func escrowSourceCode(t *testing.T) string {
	t.Helper()
	return solidityCodeOnly(t, escrowSourcePath)
}

// iEscrowSourceCode returns IEscrow.sol (the struct declarations) with every comment stripped.
func iEscrowSourceCode(t *testing.T) string {
	t.Helper()
	return solidityCodeOnly(t, iEscrowSourcePath)
}

func solidityCodeOnly(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read Solidity oracle %s: %v\n"+
			"This guard cannot verify anything without the contract source, which is a FAILURE, not a "+
			"skip: the pinned typehashes would otherwise be compared against nothing.", path, err)
	}
	if len(raw) == 0 {
		t.Fatalf("Solidity oracle %s is empty — wrong path or a truncated checkout", path)
	}
	return codeOnly(string(raw))
}

// escrowSourceTypeHash returns the value of `bytes32 ... constant <constantName> = 0x...;` as
// declared in Escrow.sol, and fails the test unless EXACTLY ONE such declaration exists.
//
// Zero means the constant was renamed, removed, or is no longer a `constant` — in which case this
// guard has nothing to compare against and must fail loudly rather than pass. Two or more means the
// name is declared twice and the guard cannot tell which value the deployed bytecode carries.
func escrowSourceTypeHash(t *testing.T, constantName string) common.Hash {
	t.Helper()
	declarations, value := findDeclaredTypeHash(escrowSourceCode(t), constantName)
	if declarations != 1 {
		t.Fatalf("expected EXACTLY ONE `constant %s = 0x...;` declaration in %s (comments excluded), found %d.\n"+
			"Zero means it was renamed, removed, or is no longer a `constant`, so this guard has no oracle; "+
			"two or more means the guard cannot tell which value ships. Either way it must fail, not skip.",
			constantName, escrowSourcePath, declarations)
	}
	return value
}

// escrowSourceStringConstant returns the value of `string ... constant <constantName> = "...";` as
// declared in Escrow.sol, with the same exactly-one requirement as escrowSourceTypeHash.
func escrowSourceStringConstant(t *testing.T, constantName string) string {
	t.Helper()
	declarations, value := findDeclaredStringConstant(escrowSourceCode(t), constantName)
	if declarations != 1 {
		t.Fatalf("expected EXACTLY ONE `constant %s = \"...\";` declaration in %s (comments excluded), found %d.\n"+
			"Zero means it was renamed, removed, reshaped into a form this scanner does not decode, or is no "+
			"longer a `constant`; two or more means the guard cannot tell which value ships.",
			constantName, escrowSourcePath, declarations)
	}
	return value
}

// ---------------------------------------------------------------------------------------------
// Solidity source scanning
//
// This is a faithful Go port of the mechanism in
// ../../../source/foundry_tests/Escrow.declarationOrder.t.sol and
// contracts/evm/source/test/EncodingExamples.verify.t.sol (_codeOnly / _findDeclaredTypeHash /
// _typeStringFromDeclaration). It is ported rather than reused because the Foundry suites DO NOT
// RUN in this repository's CI — .github/workflows/ci.yml's evm-contracts and tvm-contracts jobs run
// `forge fmt --check` and `forge build` only, and say so explicitly. The `go` job is the only lane
// that executes anything here, so a Solidity-only tie would be a guard that never runs.
//
// Four properties matter, and dropping any one of them reopens a hole the Solidity version was
// specifically hardened against:
//
//  1. comments are stripped FIRST, so a `keccak256("…")` natspec line or a leftover
//     "previously was 0x…" note can never be mistaken for a declaration. Both Escrow.sol files
//     carry such a comment DIRECTLY ABOVE every constant, so a naive
//     regexp `RELEASE_WITNESS_TYPE_HASH\s*=\s*(0x[0-9a-fA-F]{64})` would match the COMMENT and
//     report green while the real constant had already moved.
//  2. the `constant` keyword must immediately precede the name, so a local variable or an
//     assignment is not a declaration.
//  3. the name is anchored on identifier characters at BOTH ends, so a search for
//     RELEASE_WITNESS_TYPE_HASH is not satisfied by FULL_RELEASE_WITNESS_TYPE_HASH.
//  4. the scan returns a MATCH COUNT rather than the first hit, so the caller can require exactly
//     one and fail loudly on zero (renamed/removed) or two (ambiguous).
// ---------------------------------------------------------------------------------------------

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
// structure survives. String literals are respected: a `//` or `/*` inside a string never starts a
// comment, and a `\`-escaped quote never ends the string.
func codeOnly(source string) string {
	src := []byte(source)
	var out strings.Builder
	out.Grow(len(src))

	for i := 0; i < len(src); i++ {
		c := src[i]

		if c == '"' || c == '\'' {
			quote := c
			out.WriteByte(c)
			i++
			for i < len(src) {
				out.WriteByte(src[i])
				if src[i] == '\\' && i+1 < len(src) {
					i++
					out.WriteByte(src[i]) // escaped character: never a terminator
				} else if src[i] == quote {
					break
				}
				i++
			}
			continue
		}

		if c == '/' && i+1 < len(src) && src[i+1] == '/' {
			for i < len(src) && src[i] != '\n' {
				i++
			}
			out.WriteByte(' ')
			if i < len(src) {
				out.WriteByte('\n') // the loop's own i++ steps past it
			}
			continue
		}
		if c == '/' && i+1 < len(src) && src[i+1] == '*' {
			i += 2
			for i+1 < len(src) && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			i++ // land on the closing '/', which the loop's own i++ then steps past
			out.WriteByte(' ')
			continue
		}

		out.WriteByte(c)
	}

	return out.String()
}

// keywordPrecedes reports whether keyword sits immediately before src[nameStart] (whitespace aside)
// as a whole token, so `constant NAME` matches but `notconstant NAME` does not.
func keywordPrecedes(src []byte, nameStart int, keyword string) bool {
	back := nameStart
	for back > 0 && isSolWhitespace(src[back-1]) {
		back--
	}
	if back < len(keyword) {
		return false
	}
	start := back - len(keyword)
	if start > 0 && isIdentifierChar(src[start-1]) {
		return false
	}
	return string(src[start:back]) == keyword
}

// declarationSites yields every index at which constantName appears as a whole identifier
// immediately preceded by the `constant` keyword and followed by a bare `=` (not `==`). The
// returned index is the offset of the first character after that `=`.
func declarationSites(source, constantName string) []int {
	src := []byte(source)
	name := []byte(constantName)
	if len(name) == 0 || len(src) < len(name) {
		return nil
	}

	var sites []int
	for i := 0; i+len(name) <= len(src); i++ {
		if i > 0 && isIdentifierChar(src[i-1]) {
			continue
		}
		if !bytes.HasPrefix(src[i:], name) {
			continue
		}
		afterName := i + len(name)
		// Reject a longer identifier that merely contains the name.
		if afterName < len(src) && isIdentifierChar(src[afterName]) {
			continue
		}
		if !keywordPrecedes(src, i, "constant") {
			continue
		}

		k := afterName
		for k < len(src) && isSolWhitespace(src[k]) {
			k++
		}
		if k >= len(src) || src[k] != '=' {
			continue
		}
		k++
		if k < len(src) && src[k] == '=' {
			continue // an `==` comparison is not a declaration
		}
		sites = append(sites, k)
	}
	return sites
}

// findDeclaredTypeHash returns how many `constant <constantName> = 0x<64 hex>;` declarations source
// contains, plus the last value found. Callers must require declarations == 1; see
// escrowSourceTypeHash. Candidates that fail validation (wrong punctuation, non-hex characters,
// truncated, or a longer-than-bytes32 literal) are skipped rather than aborting the scan, so a
// malformed value reads as "not found" and fails closed.
func findDeclaredTypeHash(source, constantName string) (declarations int, value common.Hash) {
	src := []byte(source)
	for _, k := range declarationSites(source, constantName) {
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
		// A 65th hex nibble (or a `_` digit separator) means this is not a bytes32 literal.
		if hexStart+64 < len(src) && (isHexChar(src[hexStart+64]) || src[hexStart+64] == '_') {
			continue
		}
		declarations++
		value = common.HexToHash(string(src[hexStart : hexStart+64]))
	}
	return declarations, value
}

// findDeclaredStringConstant returns how many `constant <constantName> = "...";` declarations source
// contains, plus the last value found. Solidity's implicit concatenation of adjacent string literals
// is honoured, and the declaration must terminate in `;` — a form this decoder does not understand
// yields no match, so the caller's exactly-one requirement fails loudly instead of accepting a
// half-decoded string.
func findDeclaredStringConstant(source, constantName string) (declarations int, value string) {
	src := []byte(source)
	for _, k := range declarationSites(source, constantName) {
		var sb strings.Builder
		literals := 0
		for {
			for k < len(src) && isSolWhitespace(src[k]) {
				k++
			}
			if k >= len(src) || src[k] != '"' {
				break
			}
			lit, next, ok := readStringLiteral(src, k)
			if !ok {
				literals = 0
				break
			}
			sb.WriteString(lit)
			literals++
			k = next
		}
		if literals == 0 {
			continue
		}
		for k < len(src) && isSolWhitespace(src[k]) {
			k++
		}
		if k >= len(src) || src[k] != ';' {
			continue
		}
		declarations++
		value = sb.String()
	}
	return declarations, value
}

// findDeclaredUintConstant returns how many `constant <constantName> = <decimal>;` declarations source
// contains, plus the last value found. Used to keep a Go-side bound in lockstep with the contract's
// own instead of transcribing the number.
func findDeclaredUintConstant(source, constantName string) (declarations int, value uint64) {
	src := []byte(source)
	for _, k := range declarationSites(source, constantName) {
		for k < len(src) && isSolWhitespace(src[k]) {
			k++
		}
		start := k
		var parsed uint64
		for k < len(src) && src[k] >= '0' && src[k] <= '9' {
			parsed = parsed*10 + uint64(src[k]-'0')
			k++
		}
		if k == start {
			continue // not a decimal literal (hex, an expression, another constant)
		}
		for k < len(src) && isSolWhitespace(src[k]) {
			k++
		}
		if k >= len(src) || src[k] != ';' {
			continue
		}
		declarations++
		value = parsed
	}
	return declarations, value
}

// readStringLiteral decodes the double-quoted Solidity string literal starting at src[start] and
// returns its value plus the index just past the closing quote. An unterminated literal, or an
// escape this decoder does not understand, returns ok=false so the surrounding scan reports NOTHING
// rather than a partially-decoded value.
func readStringLiteral(src []byte, start int) (string, int, bool) {
	if start >= len(src) || src[start] != '"' {
		return "", start, false
	}
	var sb strings.Builder
	for i := start + 1; i < len(src); i++ {
		switch src[i] {
		case '"':
			return sb.String(), i + 1, true
		case '\\':
			if i+1 >= len(src) {
				return "", start, false
			}
			i++
			switch src[i] {
			case '"':
				sb.WriteByte('"')
			case '\\':
				sb.WriteByte('\\')
			case 'n':
				sb.WriteByte('\n')
			case 'r':
				sb.WriteByte('\r')
			case 't':
				sb.WriteByte('\t')
			default:
				return "", start, false
			}
		default:
			sb.WriteByte(src[i])
		}
	}
	return "", start, false
}

// eip712ElementaryTypes are the Solidity types whose canonical EIP-712 encoding is the type name
// itself. Anything else (an array, a mapping, or a referenced struct) would require appending the
// referenced type definitions to the canonical type string, which typeStringFromDeclaration
// deliberately does not do — it errors instead, so an unsupported member can never be silently
// encoded as if it were elementary.
var eip712ElementaryTypes = map[string]bool{
	"address": true,
	"bool":    true,
	"bytes":   true,
	"bytes32": true,
	"int256":  true,
	"string":  true,
	"uint8":   true,
	"uint256": true,
}

// typeStringFromDeclaration rebuilds the canonical EIP-712 type string for structName from its
// `struct` DECLARATION in source, member by member IN DECLARATION ORDER.
//
// This is a second, INDEPENDENT oracle. findDeclaredTypeHash ties an encoder to the typehash
// constant Escrow.sol uses; this ties that same typehash to the struct the generated bindings are
// produced from. Transposing two same-type members (say the adjacent `bytes32 depositRequestHash`
// and `bytes32 destinationHash`) in the declaration moves no selector and no topic0, and Escrow.sol
// reads every member by name, so only a guard of this shape catches it.
//
// found=false means the struct was renamed or removed: the caller must treat that as a failure, not
// a skip.
func typeStringFromDeclaration(source, structName string) (found bool, typeString string, err error) {
	src := []byte(source)
	name := []byte(structName)
	if len(name) == 0 {
		return false, "", errors.New("empty struct name")
	}

	for i := 0; i+len(name) <= len(src); i++ {
		if i > 0 && isIdentifierChar(src[i-1]) {
			continue
		}
		if !bytes.HasPrefix(src[i:], name) {
			continue
		}
		k := i + len(name)
		// Reject a longer identifier that merely starts with the name (`ReleaseWitnessV2`).
		if k < len(src) && isIdentifierChar(src[k]) {
			continue
		}
		if !keywordPrecedes(src, i, "struct") {
			continue
		}
		for k < len(src) && isSolWhitespace(src[k]) {
			k++
		}
		if k >= len(src) || src[k] != '{' {
			continue
		}

		end := bytes.IndexByte(src[k:], '}')
		if end < 0 {
			return false, "", fmt.Errorf("struct %s: body is never closed", structName)
		}
		members, err := declaredMemberList(string(src[k+1 : k+end]))
		if err != nil {
			return false, "", fmt.Errorf("struct %s: %w", structName, err)
		}
		return true, structName + "(" + members + ")", nil
	}

	return false, "", nil
}

// declaredMemberList turns a struct body into the comma-separated `type name` list of a canonical
// EIP-712 type string.
func declaredMemberList(body string) (string, error) {
	parts := strings.Split(body, ";")
	members := make([]string, 0, len(parts))
	for idx, part := range parts {
		fields := strings.Fields(part)
		if len(fields) == 0 {
			// Only the tail after the final `;` may be blank.
			if idx == len(parts)-1 {
				continue
			}
			return "", fmt.Errorf("member %d is an empty declaration", idx+1)
		}
		if len(fields) != 2 {
			return "", fmt.Errorf("member %d (%q) is not a plain `<type> <name>` pair", idx+1, strings.Join(fields, " "))
		}
		if !eip712ElementaryTypes[fields[0]] {
			return "", fmt.Errorf("member %d (%q) has non-elementary type %q: its canonical EIP-712 encoding "+
				"would have to append the referenced type definition, which this guard does not do",
				idx+1, strings.Join(fields, " "), fields[0])
		}
		members = append(members, fields[0]+" "+fields[1])
	}
	if len(members) == 0 {
		return "", errors.New("struct body declares no members")
	}
	return strings.Join(members, ","), nil
}
