package encoding

// TIP-712 DOMAIN guards for the V2 builders (CORE-1863 follow-up).
//
// WHY THIS FILE EXISTS. witness_v2_typehash_test.go ties every V2 witness TYPE to Escrow.sol and
// witness_v2_binding_test.go ties every V2 MEMBER to the value the caller supplied. Neither one looks
// at the DOMAIN — and a signing digest is
//
//	keccak256(0x19 0x01 ‖ domainSeparator ‖ hashStruct(witness))
//
// so the domain is half of what a signature commits to. A verifier proved the gap by mutating the V2
// domain name, the V2 domain version, and — the one that is specific to this package — THE TRON
// CHAIN-ID MASK on the V2 paths. All three mutants compiled and the whole suite stayed GREEN, while
// every signature the mutated builder produced would have recovered to the wrong signer on-chain.
//
// The mask is the sharpest of the three. Tron contracts hash `block.chainid & 0xFFFFFFFF` into their
// TIP-712 domain (see MaskTronChainIdBig / ChainIDMask in utils.go), so an unmasked V2 builder on
// Shasta signs under chainId 2494104990 while the contract verifies under the same value — identical,
// because Shasta already fits in 32 bits. That is exactly why the mutant passed: every vector in this
// package uses a chain ID under 2^32, so dropping the mask is invisible unless a test deliberately
// feeds a value ABOVE it. The V1 path has such a vector ("mask-overflow" in ../../vectors.json); the
// V2 paths had none.
//
// THREE ORACLES, none of them this module:
//
//  1. Escrow.sol's own `TIP712("Escrow", "3")` base-constructor call, EXTRACTED FROM SOURCE at test
//     time (TestEscrowV2DomainMatchesEscrowSourceConstructor).
//  2. contractEscrowDomainSeparator (reserve_parity_test.go) — the Escrow domain separator PUBLISHED
//     BY THE CONTRACT'S OWN FOUNDRY SUITE for the Shasta deployment, not computed by this encoder.
//     Every escrow-domain V2 builder must reproduce it, at the raw chain ID and at the overflowing
//     one. That single assertion covers the name, the version, the verifyingContract encoding, and
//     the mask at once, against an external reference.
//  3. The V1 builders' separators, whose digests are pinned to the frozen parity vectors.

import (
	"fmt"
	"math/big"
	"strings"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/generated"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// The Shasta-deployed escrow contractEscrowDomainSeparator was published for. Any other address
// would make oracle 2 above unusable, so this must stay in lockstep with reserve_parity_test.go.
var (
	domainEscrowAddr  = common.HexToAddress("0x2e9fbe1886fa094573e3bd25c554e827873bb9fc")
	domainPermit2Addr = common.HexToAddress("0xa8f0e5b0e7d0b0dfd6cb6e0b7bb1f3ff3c0b2e11")
	domainTokenAddr   = common.HexToAddress("0x1111111111111111111111111111111111111111")
	domainSpenderAddr = common.HexToAddress("0x2222222222222222222222222222222222222222")
)

// chainIDAboveMask shares its low 32 bits with shastaChainID and therefore MUST mask to the same
// signing domain. Every mask assertion below turns on this value; without a chain ID above 2^32 the
// mask is unobservable, which is precisely why the mutant survived.
const chainIDAboveMask = shastaChainID + (1 << 32)

// ---- source oracle: the domain Escrow.sol actually constructs ----

// findDomainConstructorCall returns how many `<ctorName>("<name>", "<version>")` calls appear in
// source, plus the arguments of the last one. The identifier is anchored on both sides, so neither
// `import {TIP712} from "./TIP712.sol";` nor the `contract Escrow is …, TIP712, …` inheritance list
// can satisfy it (neither is followed by `(`).
//
// source is expected to have been through codeOnly, so the `// TIP-712 domain for Escrow contract`
// comment beside the real call is not a candidate. Callers MUST require exactly 1: zero means the
// base constructor was renamed or reshaped and this guard has no oracle; two or more means it cannot
// tell which call ships. String literals are read with readStringLiteral, the same decoder the
// typehash-string scanner uses, so an escape form it does not understand reads as "not found" and
// fails closed rather than yielding a half-decoded domain.
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
		gotName, k, ok := readStringLiteral(src, k)
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
		gotVersion, k, ok := readStringLiteral(src, k)
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

// escrowDomainFromSource extracts the (name, version) pair Escrow.sol passes to its TIP712 base
// constructor. Read at test time, so it cannot be satisfied by editing this file.
func escrowDomainFromSource(t *testing.T) (name, version string) {
	t.Helper()
	const ctorName = "TIP712"
	calls, name, version := findDomainConstructorCall(escrowSourceCode(t), ctorName)
	if calls != 1 {
		t.Fatalf("expected EXACTLY ONE `%s(\"<name>\", \"<version>\")` base-constructor call in %s "+
			"(comments excluded), found %d.\nZero means the domain is no longer declared in a form this guard "+
			"can read, so it has no oracle; two or more means it cannot tell which domain the deployed bytecode "+
			"carries. Either way it must fail, not skip.", ctorName, escrowSourcePath, calls)
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

// v2TypedDataCases builds all four V2 builders' typed data at the RAW (unmasked) chainID. Every
// *big.Int member is non-nil because the builders marshal them into Message.
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

// TestEscrowV2DomainMatchesEscrowSourceConstructor reads the name and version out of Escrow.sol's
// `TIP712(...)` base-constructor call and requires every escrow-domain V2 builder to stamp exactly
// those. Changing "3" in a builder now fails here, in the V1-parity test, and against the
// contract-published separator.
func TestEscrowV2DomainMatchesEscrowSourceConstructor(t *testing.T) {
	wantName, wantVersion := escrowDomainFromSource(t)

	escrowCases := 0
	for _, tc := range v2TypedDataCases(big.NewInt(shastaChainID)) {
		if !tc.escrowDomain {
			continue
		}
		escrowCases++
		t.Run(tc.name, func(t *testing.T) {
			if tc.td.Domain.Name != wantName {
				t.Errorf("%s V2 domain name = %q, but %s constructs TIP712(%q, …): the domain separator would "+
					"differ from the deployed contract's, so every signature recovers to the wrong signer",
					tc.name, tc.td.Domain.Name, escrowSourcePath, wantName)
			}
			if tc.td.Domain.Version != wantVersion {
				t.Errorf("%s V2 domain version = %q, but %s constructs TIP712(…, %q): same consequence — a "+
					"different domain separator, so no signature this builder produces verifies on-chain",
					tc.name, tc.td.Domain.Version, escrowSourcePath, wantVersion)
			}
			if got := tc.td.Domain.VerifyingContract; got != domainEscrowAddr.Hex() {
				t.Errorf("%s V2 domain verifyingContract = %s, want the escrow argument %s",
					tc.name, got, domainEscrowAddr.Hex())
			}
			if tc.td.Domain.Salt != "" {
				t.Errorf("%s V2 domain carries a salt (%q); the escrow's TIP712 domain has none",
					tc.name, tc.td.Domain.Salt)
			}
		})
	}
	if escrowCases != 3 {
		t.Fatalf("expected the three escrow-domain V2 builders (reserve/release/refund) to be covered, got %d",
			escrowCases)
	}
}

// TestEscrowV2DomainSeparatorMatchesContract is the strongest single assertion in this file: every
// escrow-domain V2 builder must reproduce contractEscrowDomainSeparator — the separator the TVM escrow
// project's own Foundry suite published for the Shasta deployment (see the note on that constant in
// reserve_parity_test.go). It is not derived from this encoder, so it independently pins the domain
// name, the version, the 20-byte verifyingContract form, the absence of a salt, AND the chain-ID mask.
//
// It is asserted twice per builder: once at the raw Shasta chain ID and once at chainIDAboveMask.
// The second run is the mask guard — an unmasked builder stamps 6789072286, produces a different
// separator, and fails. TestReserveDomainSeparatorMatchesContract does the same for the V1 reserve
// builder only.
func TestEscrowV2DomainSeparatorMatchesContract(t *testing.T) {
	for _, chainID := range []int64{shastaChainID, chainIDAboveMask} {
		for _, tc := range v2TypedDataCases(big.NewInt(chainID)) {
			if !tc.escrowDomain {
				continue
			}
			t.Run(fmt.Sprintf("%s/chainId=%d", tc.name, chainID), func(t *testing.T) {
				got := domainSeparator(t, tc.td)
				if !strings.EqualFold(got, contractEscrowDomainSeparator) {
					t.Fatalf("the %s V2 builder's domain separator at chainId %d is %s, but the contract "+
						"publishes %s.\nThe escrow verifies under ITS domain, so every signature this builder "+
						"produces recovers to the wrong signer. If this failed only at chainId %d, the Tron "+
						"chain-ID mask is missing from this V2 path: %d and %d must mask to the same signing domain.",
						tc.name, chainID, got, contractEscrowDomainSeparator,
						chainIDAboveMask, chainIDAboveMask, shastaChainID)
				}
			})
		}
	}
}

// TestDepositV2DomainIsThePermit2Domain pins the OTHER domain: a deposit signature is verified by
// Permit2, not by the escrow, so it is signed under Permit2's domain — name "Permit2", NO version
// member at all, Permit2's own address as verifyingContract, and the masked chain ID.
//
// HONESTY NOTE, since this file's whole point is not repeating CORE-1863's mistake: "Permit2" below IS
// a transcription, and unlike the escrow domain there is no in-repo oracle the CI `go` lane can read —
// the Tron Permit2 port arrives as the @alexroan/permit2-tron npm package, installed only in the
// tvm-contracts lane, which runs no Go. What keeps it honest is that it is not the only assertion on
// this domain: TestV2DomainSeparatorsMatchTheirV1Counterparts pins the V2 Permit2 separator to the V1
// one, and the V1 deposit digest is pinned in deposit_encoder_test.go against the contract's own
// encoding examples.
func TestDepositV2DomainIsThePermit2Domain(t *testing.T) {
	var deposit apitypes.TypedData
	for _, tc := range v2TypedDataCases(big.NewInt(shastaChainID)) {
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

	for _, tc := range v2TypedDataCases(big.NewInt(shastaChainID)) {
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

// TestV2DomainSeparatorsMatchTheirV1Counterparts covers the Permit2 domain, which oracle 2 cannot
// reach (contractEscrowDomainSeparator is the escrow's).
//
// Every V2 change was additive to the WITNESS; no V2 builder was supposed to touch the domain. So each
// V2 domain separator must be byte-identical to its V1 sibling's — and the V1 digests are pinned to
// the frozen parity vectors and the contract's encoding examples, so this chain terminates outside
// this module. Mutate "Permit2" in the V2 builder and this fails; mutate it in BOTH V1 and V2 and the
// V1 example-digest tests fail instead.
//
// Run at chainIDAboveMask as well, so a mask dropped from ONE side is caught here too.
func TestV2DomainSeparatorsMatchTheirV1Counterparts(t *testing.T) {
	release := contracts.IEscrowReleaseWitness{Amount: big.NewInt(7), FeeAmount: big.NewInt(3)}
	refund := contracts.IEscrowRefundWitness{Amount: big.NewInt(7), FeeAmount: big.NewInt(3)}
	depositWitness := contracts.IEscrowDepositWitness{Destination: "eip155:1:0xabc"}

	for _, chainID := range []int64{shastaChainID, chainIDAboveMask} {
		cid := big.NewInt(chainID)

		releaseV1 := EscrowReleaseEncoder{}.BuildTypedData(domainEscrowAddr, release, cid)
		refundV1 := EscrowRefundEncoder{}.BuildTypedData(domainEscrowAddr, refund, cid)
		reserveV1 := EscrowReserveEncoder{}.BuildTypedData(domainEscrowAddr, contracts.IEscrowReserveWitness{}, cid)
		depositV1 := EscrowDepositEncoder{}.BuildTypedData(
			domainPermit2Addr, domainTokenAddr, domainSpenderAddr, depositWitness,
			big.NewInt(5), big.NewInt(6), big.NewInt(7), cid,
		)

		v1Separator := map[string]string{
			"release": domainSeparator(t, releaseV1),
			"refund":  domainSeparator(t, refundV1),
			"reserve": domainSeparator(t, reserveV1),
			"deposit": domainSeparator(t, depositV1),
		}

		v2Separator := map[string]string{}
		for _, tc := range v2TypedDataCases(cid) {
			v2Separator[tc.name] = domainSeparator(t, tc.td)
			t.Run(fmt.Sprintf("%s/chainId=%d", tc.name, chainID), func(t *testing.T) {
				want, ok := v1Separator[tc.name]
				if !ok {
					t.Fatalf("no V1 domain separator registered for %s", tc.name)
				}
				if got := v2Separator[tc.name]; got != want {
					t.Fatalf("at chainId %d the %s V2 builder signs under a DIFFERENT DOMAIN than the V1 "+
						"builder.\n  V1 separator: %s\n  V2 separator: %s\n"+
						"The V2 work was additive to the witness only, and the V1 domain is pinned to the frozen "+
						"parity vectors — so the V2 builder is the side that is wrong. Every signature it produces "+
						"recovers to the wrong signer.", chainID, tc.name, want, got)
				}
			})
		}

		// One contract, one domain — and Permit2's must not collide with it: a deposit authorisation and
		// a release authorisation must never share a domain separator.
		if v2Separator["reserve"] != v2Separator["release"] || v2Separator["reserve"] != v2Separator["refund"] {
			t.Errorf("at chainId %d the reserve/release/refund V2 builders do not share one escrow domain "+
				"separator: reserve=%s release=%s refund=%s",
				chainID, v2Separator["reserve"], v2Separator["release"], v2Separator["refund"])
		}
		if v2Separator["deposit"] == v2Separator["release"] {
			t.Errorf("at chainId %d the deposit V2 domain separator equals the escrow one (%s): Permit2 and "+
				"the escrow are different verifiers and must not share a signing domain",
				chainID, v2Separator["deposit"])
		}
	}
}

// TestV2DomainsApplyTheTronChainIdMask is the direct statement of the mutation that survived: every V2
// builder must stamp `chainID & 0xFFFFFFFF`, not the raw value.
//
// Asserted three ways, because the failure is silent for every chain ID Tron actually uses (all are
// under 2^32, so masked == raw and no existing vector can see the difference):
//
//  1. Domain.ChainId is the masked value for an input above the mask.
//  2. The separator for chainIDAboveMask equals the one for shastaChainID — the collision property
//     ChainIDMask's docstring warns about, which is what the contract does too.
//  3. The separator for chainIDAboveMask does NOT equal what an UNMASKED builder would produce. Point
//     2 alone could be satisfied by a builder that ignored chainId entirely.
func TestV2DomainsApplyTheTronChainIdMask(t *testing.T) {
	masked := MaskTronChainIdBig(big.NewInt(chainIDAboveMask))
	if masked.Int64() != shastaChainID {
		t.Fatalf("test premise broken: %d masks to %s, expected %d — chainIDAboveMask must share its low 32 "+
			"bits with shastaChainID or none of the assertions below mean anything",
			int64(chainIDAboveMask), masked, int64(shastaChainID))
	}

	maskedSeparator := map[string]string{}
	for _, tc := range v2TypedDataCases(big.NewInt(shastaChainID)) {
		maskedSeparator[tc.name] = domainSeparator(t, tc.td)
	}

	for _, tc := range v2TypedDataCases(big.NewInt(chainIDAboveMask)) {
		t.Run(tc.name, func(t *testing.T) {
			if tc.td.Domain.ChainId == nil {
				t.Fatalf("%s V2 domain chainId is nil", tc.name)
			}
			if got := (*big.Int)(tc.td.Domain.ChainId); got.Cmp(masked) != 0 {
				t.Fatalf("%s V2 domain chainId = %s for input %d, want the Tron-masked %s. The contract hashes "+
					"`block.chainid & 0x%X` into its TIP-712 domain, so an unmasked builder signs under a domain "+
					"the escrow never verifies and every signature recovers to the wrong signer.",
					tc.name, got, int64(chainIDAboveMask), masked, uint64(ChainIDMask))
			}
			if got := domainSeparator(t, tc.td); got != maskedSeparator[tc.name] {
				t.Fatalf("%s V2 domain separator for chainId %d is %s but %s for the masked %d — the mask is "+
					"not being applied on this path", tc.name, int64(chainIDAboveMask), got,
					maskedSeparator[tc.name], int64(shastaChainID))
			}

			// Point 3: prove the assertions above are not vacuous by building the same typed data with the
			// mask deliberately NOT applied and confirming it lands somewhere else.
			unmasked := tc.td
			unmasked.Domain.ChainId = math.NewHexOrDecimal256(chainIDAboveMask)
			if got := domainSeparator(t, unmasked); got == maskedSeparator[tc.name] {
				t.Fatalf("%s: an UNMASKED chainId produces the same domain separator (%s) as the masked one, so "+
					"assertions 1 and 2 prove nothing — this builder is ignoring chainId altogether", tc.name, got)
			}
		})
	}
}

// TestDomainConstructorScannerFailsClosed holds the new scanner to the same standard
// TestFindDeclaredTypeHashFailsClosed holds the typehash scanner to: a guard that quietly matches
// nothing would make TestEscrowV2DomainMatchesEscrowSourceConstructor pass vacuously while the domain
// drifted. Each case states what a regression would let through.
func TestDomainConstructorScannerFailsClosed(t *testing.T) {
	const real = `constructor(IPermit2 permit2, IERC20 usdt, address defaultAdmin)` + "\n" +
		`        TIP712("Escrow", "3")` + "\n"

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
			source:    "// TIP712(\"EscrowOld\", \"2\")\n",
			wantCalls: 0,
			why:       "Escrow.sol carries a `// TIP-712 domain for Escrow contract` comment on this very line",
		},
		{
			name:      "the import statement is rejected",
			source:    "import {TIP712} from \"./TIP712.sol\";\n",
			wantCalls: 0,
			why:       "the identifier appears twice on that line, once inside a string literal",
		},
		{
			name:      "the inheritance list is rejected",
			source:    "contract Escrow is IEscrow, ITokenConfig, TIP712, AccessControlDefaultAdminRules {\n",
			wantCalls: 0,
			why:       "a base-contract mention is not a constructor call; no `(` follows it",
		},
		{
			name:      "a longer identifier containing the name is rejected",
			source:    "MyTIP712(\"Escrow\", \"3\")\n",
			wantCalls: 0,
			why:       "anchoring has to hold on the leading side",
		},
		{
			name:      "a suffixed identifier is rejected",
			source:    "TIP712Domain(\"Escrow\", \"3\")\n",
			wantCalls: 0,
			why:       "anchoring has to hold on the trailing side too",
		},
		{
			name:      "a one-argument call is rejected",
			source:    "TIP712(\"Escrow\")\n",
			wantCalls: 0,
			why:       "a shape this scanner cannot read must report nothing, not a half-decoded domain",
		},
		{
			name:      "a non-literal argument is rejected",
			source:    "TIP712(NAME, VERSION)\n",
			wantCalls: 0,
			why:       "a domain assembled from constants is not something this scanner may guess at",
		},
		{
			name:      "a third argument is rejected",
			source:    "TIP712(\"Escrow\", \"3\", salt)\n",
			wantCalls: 0,
			why:       "an extra argument means the domain is not the two-member one this guard assumes",
		},
		{
			name:      "an undecodable escape is rejected rather than guessed at",
			source:    "TIP712(\"Esc\\qrow\", \"3\")\n",
			wantCalls: 0,
			why:       "readStringLiteral rejects escapes it does not know; unreadable must mean not-found",
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
			calls, name, version := findDomainConstructorCall(codeOnly(tc.source), "TIP712")
			if calls != tc.wantCalls {
				t.Fatalf("calls = %d, want %d (%s)", calls, tc.wantCalls, tc.why)
			}
			if tc.wantCalls == 1 && (name != tc.wantName || version != tc.wantVersion) {
				t.Fatalf("got (%q, %q), want (%q, %q)", name, version, tc.wantName, tc.wantVersion)
			}
		})
	}
}

// TestEscrowDomainOracleResolves is the non-vacuity check for the real file: the constructor name is a
// string, so a scanner that matched nothing would leave every domain assertion passing on an empty
// oracle. Escrow.sol must yield exactly one call, and a name that is not there must yield zero.
func TestEscrowDomainOracleResolves(t *testing.T) {
	source := escrowSourceCode(t)

	calls, name, version := findDomainConstructorCall(source, "TIP712")
	if calls != 1 || name == "" || version == "" {
		t.Fatalf("TIP712 base-constructor scan of %s returned calls=%d name=%q version=%q, want exactly one "+
			"non-empty pair", escrowSourcePath, calls, name, version)
	}
	if calls, _, _ := findDomainConstructorCall(source, "TIP712_THAT_DOES_NOT_EXIST"); calls != 0 {
		t.Fatalf("scanner found %d calls of a nonexistent base constructor — it is matching something it "+
			"should not", calls)
	}
}
