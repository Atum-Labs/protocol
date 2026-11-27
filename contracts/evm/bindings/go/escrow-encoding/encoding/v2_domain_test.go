package encoding

// EIP-712 DOMAIN guards for the V2 builders (CORE-1863 follow-up).
//
// WHY THIS FILE EXISTS. escrow_source_typehash_test.go ties every V2 witness TYPE to Escrow.sol, and
// the *_witness_v2_test.go files tie every V2 MEMBER to the value the caller supplied. Neither one
// looks at the DOMAIN — and a signing digest is
//
//	keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(witness))
//
// so the domain is exactly half of what a signature commits to. A verifier demonstrated the gap by
// mutating the V2 Permit2 domain name from "Permit2" to "Permit2X" and the V2 escrow domain version
// from "3" to something else: both mutants compiled and the entire suite stayed GREEN, while every
// signature the mutated builder produced would have recovered to the wrong signer on-chain. That is
// the same failure shape CORE-1863 fixed one layer up, so the domain gets the same treatment: an
// oracle that is not this module.
//
// THREE INDEPENDENT ORACLES, in decreasing strength:
//
//  1. Escrow.sol's own `EIP712("Escrow", "3")` base-constructor call, EXTRACTED FROM SOURCE at test
//     time (TestEscrowV2DomainMatchesEscrowSourceConstructor). Nothing about the escrow domain is
//     transcribed into this file, exactly as with the typehashes.
//  2. The V1 builders' domain separators (TestV2DomainSeparatorsMatchTheirV1Counterparts). The V2
//     work was additive to the WITNESS only, so every V2 domain must be byte-identical to its V1
//     sibling's — and the V1 digests are pinned to contract-derived vectors in
//     testdata/encoding-examples.json (TestDepositEncoder_Digest / TestReleaseEncoder_Digest /
//     TestRefundEncoder_Digest / TestReserveEncoder_Digest), so this chain terminates outside this
//     module too. This is what gives the Permit2 domain teeth despite oracle 3's limitation.
//  3. The literal Permit2 domain shape (TestDepositV2DomainIsThePermit2Domain). Read the honesty
//     note on that test: it is a transcription, and it says so.

import (
	"math/big"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// Distinct, non-zero fixtures so a builder that stamps the WRONG address into verifyingContract
// cannot pass by accident (the shared zero address in witnessTypeHashCases would let it).
var (
	domainEscrowAddr  = common.HexToAddress("0x2e9fbe1886fa094573e3bd25c554e827873bb9fc")
	domainPermit2Addr = common.HexToAddress("0x000000000022d473030f116ddee9f6b43ac78ba3")
	domainTokenAddr   = common.HexToAddress("0x1111111111111111111111111111111111111111")
	domainSpenderAddr = common.HexToAddress("0x2222222222222222222222222222222222222222")
)

// ---- source oracle: the domain Escrow.sol actually constructs ----

// readPlainStringLiteral decodes the double-quoted Solidity literal starting at src[start] and
// returns its value plus the offset just past the closing quote.
//
// Deliberately narrow: a literal containing ANY backslash returns ok=false rather than being decoded,
// so this reader never has to guess at an escape table. An EIP-712 domain name or version has no
// escapes, and the caller's exactly-one requirement turns an undecodable literal into a loud failure
// instead of a silently wrong value.
func readPlainStringLiteral(src []byte, start int) (value string, next int, ok bool) {
	if start >= len(src) || src[start] != '"' {
		return "", start, false
	}
	for i := start + 1; i < len(src); i++ {
		switch src[i] {
		case '\\':
			return "", start, false
		case '"':
			return string(src[start+1 : i]), i + 1, true
		}
	}
	return "", start, false
}

// findDomainConstructorCall returns how many `<ctorName>("<name>", "<version>")` calls appear in
// source, plus the arguments of the last one. Anchored on identifier characters at both ends, so the
// `import {EIP712} from ".../EIP712.sol";` line and the `contract Escrow is …, EIP712, …` inheritance
// list cannot satisfy it (neither is followed by `(`), and neither can an `EIP712Domain` identifier.
//
// source is expected to have been through codeOnly, so the `// EIP-712 domain for Escrow contract`
// comment beside the real call is not a candidate. Callers MUST require exactly 1: zero means the
// base constructor was renamed or reshaped and this guard has no oracle; two or more means it cannot
// tell which call ships.
func findDomainConstructorCall(source, ctorName string) (calls int, name, version string) {
	src := []byte(source)
	ident := []byte(ctorName)
	if len(ident) == 0 || len(src) < len(ident) {
		return 0, "", ""
	}

	for i := 0; i+len(ident) <= len(src); i++ {
		if i > 0 && isIdentifierChar(src[i-1]) {
			continue
		}
		if string(src[i:i+len(ident)]) != ctorName {
			continue
		}
		k := i + len(ident)
		if k < len(src) && isIdentifierChar(src[k]) {
			continue
		}
		for k < len(src) && isSolWhitespace(src[k]) {
			k++
		}
		if k >= len(src) || src[k] != '(' {
			continue
		}
		k++

		for k < len(src) && isSolWhitespace(src[k]) {
			k++
		}
		gotName, k, ok := readPlainStringLiteral(src, k)
		if !ok {
			continue
		}
		for k < len(src) && isSolWhitespace(src[k]) {
			k++
		}
		if k >= len(src) || src[k] != ',' {
			continue
		}
		k++
		for k < len(src) && isSolWhitespace(src[k]) {
			k++
		}
		gotVersion, k, ok := readPlainStringLiteral(src, k)
		if !ok {
			continue
		}
		for k < len(src) && isSolWhitespace(src[k]) {
			k++
		}
		if k >= len(src) || src[k] != ')' {
			continue
		}
		calls++
		name, version = gotName, gotVersion
	}
	return calls, name, version
}

// escrowDomainFromSource extracts the (name, version) pair Escrow.sol passes to its EIP712 base
// constructor. This is the oracle for the escrow half of the domain, read at test time so it cannot
// be satisfied by editing this file.
func escrowDomainFromSource(t *testing.T) (name, version string) {
	t.Helper()
	const ctorName = "EIP712"
	calls, name, version := findDomainConstructorCall(escrowSourceCode(t), ctorName)
	if calls != 1 {
		t.Fatalf("expected EXACTLY ONE `%s(\"<name>\", \"<version>\")` base-constructor call in %s "+
			"(comments excluded), found %d: zero means the domain is no longer declared in a form this guard "+
			"can read, so it has no oracle; two or more means it cannot tell which domain the deployed "+
			"bytecode carries. Either way it must fail, not skip.", ctorName, escrowSourcePath, calls)
	}
	if name == "" || version == "" {
		t.Fatalf("%s declares an empty domain name (%q) or version (%q) — refusing to assert against a "+
			"vacuous oracle", escrowSourcePath, name, version)
	}
	return name, version
}

// v2TypedDataCase pairs a V2 builder's typed data with the domain it is supposed to be signing under.
type v2TypedDataCase struct {
	name         string
	td           apitypes.TypedData
	escrowDomain bool // true: the "Escrow"/"3" domain. false: Permit2's.
}

// v2TypedDataCases builds all four V2 builders' typed data at chainID. Every *big.Int member is
// non-nil because the builders marshal them into Message.
func v2TypedDataCases(chainID *big.Int) []v2TypedDataCase {
	deposit := EscrowDepositEncoder{}.BuildTypedDataWithDestination(
		domainPermit2Addr, domainTokenAddr, domainSpenderAddr,
		contracts.IEscrowDepositWitness{Destination: "eip155:1:0xabc"},
		big.NewInt(5), big.NewInt(6), big.NewInt(7), chainID,
	)
	reserve := EscrowReserveEncoder{}.BuildTypedDataWithQuoteSource(
		domainEscrowAddr, [32]byte{0xaa}, [32]byte{0xbb}, domainSpenderAddr, big.NewInt(9), chainID,
	)
	release := EscrowReleaseEncoder{}.BuildTypedDataWithQuoteHash(
		domainEscrowAddr,
		contracts.IEscrowReleaseWitness{Amount: big.NewInt(7), FeeAmount: big.NewInt(3)},
		[32]byte{0xbb}, chainID,
	)
	refund := EscrowRefundEncoder{}.BuildTypedDataWithQuoteHash(
		domainEscrowAddr,
		contracts.IEscrowRefundWitness{Amount: big.NewInt(7), FeeAmount: big.NewInt(3)},
		[32]byte{0xbb}, chainID,
	)
	return []v2TypedDataCase{
		{"deposit", deposit, false},
		{"reserve", reserve, true},
		{"release", release, true},
		{"refund", refund, true},
	}
}

func domainSeparator(t *testing.T, td apitypes.TypedData) string {
	t.Helper()
	sep, err := td.HashStruct("EIP712Domain", td.Domain.Map())
	if err != nil {
		t.Fatalf("hash EIP712Domain: %v", err)
	}
	return common.BytesToHash(sep).Hex()
}

// TestEscrowV2DomainMatchesEscrowSourceConstructor is the assertion whose absence let the domain
// version be mutated with the suite still green. It reads the name and version out of Escrow.sol's
// `EIP712(...)` base-constructor call and requires every escrow-domain V2 builder to stamp exactly
// those. Changing "3" in a builder now fails here AND in the V1-parity test below.
func TestEscrowV2DomainMatchesEscrowSourceConstructor(t *testing.T) {
	wantName, wantVersion := escrowDomainFromSource(t)

	escrowCases := 0
	for _, tc := range v2TypedDataCases(big.NewInt(1)) {
		if !tc.escrowDomain {
			continue
		}
		escrowCases++
		t.Run(tc.name, func(t *testing.T) {
			if tc.td.Domain.Name != wantName {
				t.Errorf("%s V2 domain name = %q, but %s constructs EIP712(%q, …): the domain separator would "+
					"differ from the deployed contract's, so every signature recovers to the wrong signer",
					tc.name, tc.td.Domain.Name, escrowSourcePath, wantName)
			}
			if tc.td.Domain.Version != wantVersion {
				t.Errorf("%s V2 domain version = %q, but %s constructs EIP712(…, %q): same consequence — a "+
					"different domain separator, so no signature this builder produces verifies on-chain",
					tc.name, tc.td.Domain.Version, escrowSourcePath, wantVersion)
			}
			if got := tc.td.Domain.VerifyingContract; got != domainEscrowAddr.Hex() {
				t.Errorf("%s V2 domain verifyingContract = %s, want the escrow argument %s",
					tc.name, got, domainEscrowAddr.Hex())
			}
			if tc.td.Domain.Salt != "" {
				t.Errorf("%s V2 domain carries a salt (%q); the escrow's EIP712 domain has none",
					tc.name, tc.td.Domain.Salt)
			}
		})
	}
	if escrowCases != 3 {
		t.Fatalf("expected the three escrow-domain V2 builders (reserve/release/refund) to be covered, got %d",
			escrowCases)
	}
}

// TestDepositV2DomainIsThePermit2Domain pins the OTHER domain: the deposit signature is verified by
// Permit2, not by the escrow, so it is signed under Permit2's domain — name "Permit2", NO version
// member at all, and Permit2's own address as verifyingContract.
//
// HONESTY NOTE, since this file's whole point is not repeating CORE-1863's mistake: the two string
// literals below ARE transcriptions, and unlike the escrow domain there is no in-repo oracle the CI
// `go` lane can read. Permit2 is a git SUBMODULE (contracts/evm/source/lib/permit2, where
// src/EIP712.sol declares `_HASHED_NAME = keccak256("Permit2")`) and the `go` job checks out WITHOUT
// submodules, so a source tie here would be a guard that silently skips in CI — worse than a
// documented literal. What keeps this honest is that it is not the only assertion on this domain:
// TestV2DomainSeparatorsMatchTheirV1Counterparts pins the V2 Permit2 separator to the V1 one, and the
// V1 deposit digest is pinned to a contract-derived vector in testdata/encoding-examples.json. So a
// wrong Permit2 domain fails there whether or not this transcription is right.
func TestDepositV2DomainIsThePermit2Domain(t *testing.T) {
	var deposit apitypes.TypedData
	for _, tc := range v2TypedDataCases(big.NewInt(1)) {
		if tc.name == "deposit" {
			deposit = tc.td
		}
	}

	if got := deposit.Domain.Name; got != "Permit2" {
		t.Errorf("deposit V2 domain name = %q, want %q — Permit2 verifies this signature under its own "+
			"domain, so a different name means no deposit can ever succeed", got, "Permit2")
	}
	if got := deposit.Domain.Version; got != "" {
		t.Errorf("deposit V2 domain version = %q, want empty: Permit2's EIP712Domain has only "+
			"name/chainId/verifyingContract, and a version here would be a member Permit2 never hashes", got)
	}
	if got := deposit.Domain.VerifyingContract; got != domainPermit2Addr.Hex() {
		t.Errorf("deposit V2 domain verifyingContract = %s, want the permit2 argument %s",
			got, domainPermit2Addr.Hex())
	}
}

// TestV2DomainTypeListsAreTheOnesTheirVerifiersHash asserts the EIP712Domain TYPE definition of each
// V2 builder, which is what actually gets hashed — Domain.Map() drops empty fields, so a stray
// `version` in the Permit2 domain's type list (or a missing one in the escrow's) changes the separator
// even when the Domain struct's fields look right.
func TestV2DomainTypeListsAreTheOnesTheirVerifiersHash(t *testing.T) {
	permit2Domain := []apitypes.Type{
		{Name: "name", Type: "string"},
		{Name: "chainId", Type: "uint256"},
		{Name: "verifyingContract", Type: "address"},
	}
	escrowDomain := []apitypes.Type{
		{Name: "name", Type: "string"},
		{Name: "version", Type: "string"},
		{Name: "chainId", Type: "uint256"},
		{Name: "verifyingContract", Type: "address"},
	}

	for _, tc := range v2TypedDataCases(big.NewInt(1)) {
		t.Run(tc.name, func(t *testing.T) {
			want := permit2Domain
			if tc.escrowDomain {
				want = escrowDomain
			}
			got := tc.td.Types["EIP712Domain"]
			if len(got) != len(want) {
				t.Fatalf("%s V2 EIP712Domain has %d members, want %d:\n got: %v\nwant: %v",
					tc.name, len(got), len(want), got, want)
			}
			for i := range want {
				if got[i] != want[i] {
					t.Fatalf("%s V2 EIP712Domain member %d = %v, want %v (the domain separator hashes this "+
						"list, so any difference changes it)", tc.name, i, got[i], want[i])
				}
			}
		})
	}
}

// TestV2DomainSeparatorsMatchTheirV1Counterparts is the assertion that reaches outside this module.
//
// Every V2 change was additive to the WITNESS; no V2 builder was supposed to touch the domain. So
// each V2 domain separator must be byte-identical to its V1 sibling's — and the V1 digests are pinned
// to contract-derived vectors in testdata/encoding-examples.json, which is what makes this a real
// oracle rather than a self-comparison. Mutate "Permit2" or "3" in a V2 builder and this fails;
// mutate it in BOTH V1 and V2 and the V1 example-digest tests fail instead.
//
// EVM's V1 reserve encoder inlines its typed data inside Digest and exposes no BuildTypedData, so
// reserve is compared against the release V1 domain: all three escrow builders share one domain, and
// the cross-equality assertion below is what makes that substitution sound.
func TestV2DomainSeparatorsMatchTheirV1Counterparts(t *testing.T) {
	chainID := big.NewInt(1)
	release := releaseWitnessFixture([32]byte{0xbb})
	refund := refundWitnessFixture([32]byte{0xbb})

	releaseV1 := EscrowReleaseEncoder{}.BuildTypedData(domainEscrowAddr, release, chainID)
	refundV1 := EscrowRefundEncoder{}.BuildTypedData(domainEscrowAddr, refund, chainID)
	depositV1 := EscrowDepositEncoder{}.BuildTypedData(
		domainPermit2Addr, domainTokenAddr, domainSpenderAddr,
		contracts.IEscrowDepositWitness{Destination: "eip155:1:0xabc"},
		big.NewInt(5), big.NewInt(6), big.NewInt(7), chainID,
	)

	v1Separator := map[string]string{
		"release": domainSeparator(t, releaseV1),
		"refund":  domainSeparator(t, refundV1),
		"deposit": domainSeparator(t, depositV1),
		// See the docstring: reserve V1 has no exported typed data, and the escrow domain is shared.
		"reserve": domainSeparator(t, releaseV1),
	}

	v2Separator := map[string]string{}
	for _, tc := range v2TypedDataCases(chainID) {
		v2Separator[tc.name] = domainSeparator(t, tc.td)
		t.Run(tc.name, func(t *testing.T) {
			want, ok := v1Separator[tc.name]
			if !ok {
				t.Fatalf("no V1 domain separator registered for %s", tc.name)
			}
			if got := v2Separator[tc.name]; got != want {
				t.Fatalf("the %s V2 builder signs under a DIFFERENT DOMAIN than the V1 builder.\n"+
					"  V1 separator: %s\n"+
					"  V2 separator: %s\n"+
					"The V2 work was additive to the witness only, and the V1 domain is pinned to the "+
					"contract-derived digests in testdata/encoding-examples.json — so the V2 builder is the side "+
					"that is wrong. Every signature it produces recovers to the wrong signer.", tc.name, want, got)
			}
		})
	}

	// The three escrow builders must agree with each other (one contract, one domain), and must NOT
	// collide with Permit2's — a deposit authorisation and a release authorisation must never share a
	// domain separator.
	if v2Separator["reserve"] != v2Separator["release"] || v2Separator["reserve"] != v2Separator["refund"] {
		t.Errorf("the reserve/release/refund V2 builders do not share one escrow domain separator: "+
			"reserve=%s release=%s refund=%s", v2Separator["reserve"], v2Separator["release"], v2Separator["refund"])
	}
	if v2Separator["deposit"] == v2Separator["release"] {
		t.Errorf("the deposit V2 domain separator equals the escrow one (%s): Permit2 and the escrow are "+
			"different verifiers and must not share a signing domain", v2Separator["deposit"])
	}
}

// TestV2DomainsUseTheChainIdVerbatim is the EVM counterpart of the TVM mask guard. Tron masks the
// chain ID to its low 32 bits for TIP-712; EVM must NOT, and the sibling TVM package next door is a
// standing invitation to copy that line over. A chain ID above 2^32 is stamped verbatim, and the
// separator it produces differs from a masked one's.
func TestV2DomainsUseTheChainIdVerbatim(t *testing.T) {
	const low = int64(1)
	high := big.NewInt(low + (1 << 32)) // shares its low 32 bits with `low`

	lowSeparator := map[string]string{}
	for _, tc := range v2TypedDataCases(big.NewInt(low)) {
		lowSeparator[tc.name] = domainSeparator(t, tc.td)
	}

	for _, tc := range v2TypedDataCases(high) {
		t.Run(tc.name, func(t *testing.T) {
			if tc.td.Domain.ChainId == nil {
				t.Fatalf("%s V2 domain chainId is nil", tc.name)
			}
			if got := (*big.Int)(tc.td.Domain.ChainId); got.Cmp(high) != 0 {
				t.Fatalf("%s V2 domain chainId = %s for input %s: EVM must stamp the chain ID verbatim. A "+
					"low-32-bit mask (correct for TIP-712, wrong here) would make chain %s and chain %d share a "+
					"signing domain, so a signature for one would verify on the other.",
					tc.name, got, high, high, low)
			}
			if got := domainSeparator(t, tc.td); got == lowSeparator[tc.name] {
				t.Fatalf("%s V2 domain separator for chain %s equals the one for chain %d (%s) — the chain ID "+
					"is being truncated", tc.name, high, low, got)
			}
		})
	}
}

// TestDomainConstructorScannerFailsClosed holds the new scanner to the same standard
// TestEscrowSourceScannerFailsClosed holds the typehash scanner to: a guard that quietly matches
// nothing would make TestEscrowV2DomainMatchesEscrowSourceConstructor pass vacuously while the domain
// drifted. Each case states what a regression would let through.
func TestDomainConstructorScannerFailsClosed(t *testing.T) {
	const real = `constructor(IPermit2 permit2, address defaultAdmin)` + "\n" +
		`        EIP712("Escrow", "3")` + "\n"

	cases := []struct {
		name        string
		source      string
		wantCalls   int
		wantName    string
		wantVersion string
		why         string
	}{
		{
			name: "real base-constructor call is found", source: real,
			wantCalls: 1, wantName: "Escrow", wantVersion: "3",
			why: "the positive control; if this fails every other case is meaningless",
		},
		{
			name:      "commented-out call is invisible",
			source:    "// EIP712(\"EscrowOld\", \"2\")\n",
			wantCalls: 0,
			why:       "Escrow.sol carries a `// EIP-712 domain for Escrow contract` comment on this very line",
		},
		{
			name:      "the import statement is rejected",
			source:    "import {EIP712} from \"@openzeppelin/contracts/utils/cryptography/EIP712.sol\";\n",
			wantCalls: 0,
			why:       "the identifier appears twice on that line, once inside a string literal",
		},
		{
			name:      "the inheritance list is rejected",
			source:    "contract Escrow is IEscrow, ITokenConfig, EIP712, AccessControlDefaultAdminRules {\n",
			wantCalls: 0,
			why:       "a base-contract mention is not a constructor call; no `(` follows it",
		},
		{
			name:      "a longer identifier containing the name is rejected",
			source:    "MyEIP712(\"Escrow\", \"3\")\n",
			wantCalls: 0,
			why:       "anchoring has to hold on the leading side",
		},
		{
			name:      "a suffixed identifier is rejected",
			source:    "EIP712Domain(\"Escrow\", \"3\")\n",
			wantCalls: 0,
			why:       "EIP712Domain is a real identifier in this codebase and is NOT the base constructor",
		},
		{
			name:      "a one-argument call is rejected",
			source:    "EIP712(\"Escrow\")\n",
			wantCalls: 0,
			why:       "a shape this scanner cannot read must report nothing, not a half-decoded domain",
		},
		{
			name:      "a non-literal argument is rejected",
			source:    "EIP712(NAME, VERSION)\n",
			wantCalls: 0,
			why:       "a domain assembled from constants is not something this scanner may guess at",
		},
		{
			name:      "a third argument is rejected",
			source:    "EIP712(\"Escrow\", \"3\", salt)\n",
			wantCalls: 0,
			why:       "an extra argument means the domain is not the two-member one this guard assumes",
		},
		{
			name:      "an escaped literal is rejected rather than guessed at",
			source:    "EIP712(\"Esc\\\"row\", \"3\")\n",
			wantCalls: 0,
			why:       "readPlainStringLiteral deliberately decodes no escapes; unreadable must mean not-found",
		},
		{
			name:      "duplicate calls are reported, not silently resolved",
			source:    real + real,
			wantCalls: 2,
			why:       "two calls means this guard cannot tell which domain the deployed bytecode carries",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			calls, name, version := findDomainConstructorCall(codeOnly(tc.source), "EIP712")
			if calls != tc.wantCalls {
				t.Fatalf("calls = %d, want %d (%s)", calls, tc.wantCalls, tc.why)
			}
			if tc.wantCalls == 1 && (name != tc.wantName || version != tc.wantVersion) {
				t.Fatalf("got (%q, %q), want (%q, %q)", name, version, tc.wantName, tc.wantVersion)
			}
		})
	}
}

// TestEscrowDomainOracleResolves is the non-vacuity check for the real file: the constant names above
// are strings, so a scanner that matched nothing would leave every domain assertion passing on an
// empty oracle. Escrow.sol must yield exactly one call, and a name that is not there must yield zero.
func TestEscrowDomainOracleResolves(t *testing.T) {
	source := escrowSourceCode(t)

	calls, name, version := findDomainConstructorCall(source, "EIP712")
	if calls != 1 || name == "" || version == "" {
		t.Fatalf("EIP712 base-constructor scan of %s returned calls=%d name=%q version=%q, want exactly one "+
			"non-empty pair", escrowSourcePath, calls, name, version)
	}
	if calls, _, _ := findDomainConstructorCall(source, "EIP712_THAT_DOES_NOT_EXIST"); calls != 0 {
		t.Fatalf("scanner found %d calls of a nonexistent base constructor — it is matching something it "+
			"should not", calls)
	}
}
