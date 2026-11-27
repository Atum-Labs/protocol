package svm_escrow_encoding

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The deposit compute-unit limit exists in THREE places and must agree in all three, so this
// test reads the other two as text rather than trusting them to be copied correctly.
//
// Why it is text-scanned rather than imported: contracts/svm/source is installed with
// `pnpm install --ignore-workspace` and does not depend on the escrow-encoding package, so the
// Anchor suite cannot import the constant, and adding the dependency would couple the vendored
// contract tree to the SDK's install story. Reading the sibling source as the oracle is the same
// technique the EVM/TVM typehash guards already use on Escrow.sol, and the `go:` paths filter
// includes contracts/*/bindings/**, contracts/*/conformance/** and contracts/*/source/**, so an edit to either
// scanned file runs this test.
//
// What goes wrong without it: 400_000 lived ONLY in the Anchor test helper, where no client
// could find it. A client that requests Solana's 200k default gets "exceeded CUs meter at BPF
// instruction" and the deposit fails. Duplicating the number into the SDK fixes reachability but
// creates the drift this test forecloses -- if the program's cost changes and only the Anchor
// helper is raised, every SDK caller keeps signing transactions that cannot land.
func TestDepositComputeUnitLimitAgreesEverywhere(t *testing.T) {
	for _, src := range []struct {
		name  string
		path  string
		re    *regexp.Regexp
		human string
	}{
		{
			name:  "Anchor test helper",
			path:  "../../../../source/tests/helpers.ts",
			re:    regexp.MustCompile(`DEPOSIT_COMPUTE_UNIT_LIMIT\s*=\s*([0-9_]+)`),
			human: "contracts/svm/source/tests/helpers.ts",
		},
		{
			name:  "TypeScript mirror",
			path:  "../../../typescript/escrow-encoding/src/nonce-generator.ts",
			re:    regexp.MustCompile(`DEPOSIT_COMPUTE_UNIT_LIMIT\s*=\s*([0-9_]+)`),
			human: "contracts/svm/bindings/typescript/escrow-encoding/src/nonce-generator.ts",
		},
	} {
		raw, err := os.ReadFile(src.path)
		if err != nil {
			// A rename must fail loudly rather than silently stop comparing: a guard that
			// quietly finds nothing is worse than no guard.
			t.Fatalf("could not read %s (%s): %v — if this file moved, update this test rather "+
				"than deleting it, or the three copies of the limit stop being checked",
				src.human, src.name, err)
		}
		m := src.re.FindSubmatch(raw)
		if m == nil {
			t.Fatalf("no DEPOSIT_COMPUTE_UNIT_LIMIT assignment found in %s; the declaration was "+
				"renamed or removed, so this guard is no longer comparing anything", src.human)
		}
		got, err := strconv.Atoi(strings.ReplaceAll(string(m[1]), "_", ""))
		if err != nil {
			t.Fatalf("%s: could not parse %q as an integer: %v", src.human, m[1], err)
		}
		if got != DepositComputeUnitLimit {
			t.Errorf("%s declares the deposit compute-unit limit as %d, but this package exports "+
				"%d. Every SDK caller builds its transaction from the exported value, so while "+
				"these disagree one of the two is signing deposits that cannot land.",
				src.human, got, DepositComputeUnitLimit)
		}
	}
}

// The limit has to exceed Solana's default, or requesting it would be pointless.
func TestDepositComputeUnitLimitExceedsTheSolanaDefault(t *testing.T) {
	const solanaDefaultPerTransactionCUs = 200_000
	if DepositComputeUnitLimit <= solanaDefaultPerTransactionCUs {
		t.Errorf("DepositComputeUnitLimit = %d, which is not above Solana's %d default: a client "+
			"prepending setComputeUnitLimit with this value would gain nothing, and the deposit "+
			"would fail exactly as it does with no compute-budget instruction at all",
			DepositComputeUnitLimit, solanaDefaultPerTransactionCUs)
	}
}
