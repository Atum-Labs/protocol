// This file is deliberately in the EXTERNAL test package (contracts_test, not contracts). It must
// reach every symbol the way a real consumer does — qualified through the module's import path — so
// that an identifier reachable only from INSIDE the package cannot make these tests pass.
package contracts_test

import (
	"bytes"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"

	contracts "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding"
)

// sourceIEscrowABI is the ABI extracted from the vendored Solidity by `make generate-abi`, the same
// AUTHORITATIVE input encoding/event_topic0_test.go uses. These tests deliberately do NOT hardcode
// a topic0 and do NOT read the ABI embedded in the bindings: a guard that reads its own subject as
// its oracle cannot fail, which is exactly how six topic0s drifted silently before.
const sourceIEscrowABI = "../../../source/generated/abi/IEscrow.json"

// Scope: IEscrow only, deliberately. IFulfillmentProxy's event set is NOT identical across VMs — the
// TVM interface declares SettlerAllowlistEnforcementSet, which the EVM interface does not and which
// nothing re-exports because nothing consumes it. Extending this guard to IFulfillmentProxy would
// either go red on TVM or force an alias purely to manufacture symmetry. IEscrow is the settlement
// surface off-chain consumers rebuild witnesses from, and its event set IS identical on both VMs,
// DepositCommitments included.

// iEscrowEventAliases maps each IEscrow event name in the SOURCE ABI to the zero value of the
// event's struct type AS NAMED IN THIS MODULE'S ROOT PACKAGE.
//
// The map is the whole guard, and it has two teeth:
//
//   - A new Solidity event with no entry here fails TestIEscrowEventStructsAreReexported, because
//     that test iterates the SOURCE ABI and demands an entry for each event it finds.
//   - An entry whose alias does not exist fails to COMPILE, because the value expression names the
//     root-package identifier rather than the generated one.
//
// Why this exists: CORE-2120 added DepositCommitments, a genuinely NEW event. Everything that
// DERIVES an event signature from the ABI (the topic0 golden, a consumer's topic0 computation)
// picked it up with no code change, so nothing went red — but nothing SUBSCRIBED to it either, and
// its struct type was never re-exported, so a consumer of this package could not name the value it
// decoded. Deriving a signature is not the same as surfacing the type. This map is the explicit
// list that a derived signature cannot supply on your behalf.
var iEscrowEventAliases = map[string]any{
	"Deposited":          contracts.IEscrowDeposited{},
	"DepositedMany":      contracts.IEscrowDepositedMany{},
	"DepositCommitments": contracts.IEscrowDepositCommitments{},
	"Released":           contracts.IEscrowReleased{},
	"ReleasedMany":       contracts.IEscrowReleasedMany{},
	"Refunded":           contracts.IEscrowRefunded{},
	"RefundedMany":       contracts.IEscrowRefundedMany{},
}

func TestIEscrowEventStructsAreReexported(t *testing.T) {
	parsed := loadSourceIEscrowABI(t)

	names := make([]string, 0, len(parsed.Events))
	for name := range parsed.Events {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		if _, ok := iEscrowEventAliases[name]; !ok {
			t.Errorf("IEscrow.%s is declared in the source ABI but its event struct is not "+
				"re-exported from the module root. Add `type IEscrow%s = generated.IEscrow%s` to "+
				"reexport.go and an entry to iEscrowEventAliases, so a consumer importing this "+
				"package can name the value it decodes without importing the generated subpackage.",
				name, name, name)
		}
	}

	// The reverse direction: an alias for an event the contracts no longer declare is dead surface.
	for _, name := range sortedAliasNames() {
		if _, ok := parsed.Events[name]; !ok {
			t.Errorf("iEscrowEventAliases has an entry for IEscrow.%s, which the source ABI does "+
				"not declare — the event was removed or renamed in Solidity. Regenerate bindings "+
				"and drop the stale alias.", name)
		}
	}
}

// TestDepositCommitmentsDecodableFromReexports is the behavioural half: it proves the log-only
// recovery IEscrow.sol promises is actually reachable through this package's exported surface.
//
// IEscrow.sol (interfaces/IEscrow.sol, ActiveDeposit natspec) states that on the deposit() path the
// two commitment hashes — depositRequestHash and destinationHash, the only ActiveDeposit members no
// flat single-item event carries — are recoverable from LOGS ALONE via DepositCommitments, joined to
// Deposited on the indexed depositId. A log-only consumer therefore needs, from this package: a
// filterer constructor, a decode entry point, and a NAMEABLE result type. This test uses all three.
//
// Note what it does NOT need: no free-standing ParseDepositCommitments re-export. Parse/Filter/Watch
// are METHODS on IEscrowFilterer, and a Go type alias carries a type's whole method set, so the
// existing `type IEscrowFilterer = generated.IEscrowFilterer` already surfaces every one of them.
// Only the event STRUCT needed an alias.
func TestDepositCommitmentsDecodableFromReexports(t *testing.T) {
	parsed := loadSourceIEscrowABI(t)
	ev, ok := parsed.Events["DepositCommitments"]
	if !ok {
		t.Fatal("source ABI declares no DepositCommitments event")
	}

	depositID := common.HexToHash("0x1111111111111111111111111111111111111111111111111111111111111111")
	requestHash := common.HexToHash("0x2222222222222222222222222222222222222222222222222222222222222222")
	destinationHash := common.HexToHash("0x3333333333333333333333333333333333333333333333333333333333333333")

	// A log as a scanner sees it: topic0 = the event signature derived from source, topic1 = the
	// indexed depositId, data = the two unindexed bytes32 words in declaration order.
	log := types.Log{
		Topics: []common.Hash{ev.ID, depositID},
		Data:   append(append([]byte{}, requestHash.Bytes()...), destinationHash.Bytes()...),
	}

	filterer, err := contracts.NewIEscrowFilterer(common.Address{}, nil)
	if err != nil {
		t.Fatalf("NewIEscrowFilterer: %v", err)
	}

	// Declared with the re-exported type rather than `:=` on purpose: an inferred type would pass
	// even with no alias in this package, which is the very gap being guarded.
	var decoded *contracts.IEscrowDepositCommitments
	decoded, err = filterer.ParseDepositCommitments(log)
	if err != nil {
		t.Fatalf("ParseDepositCommitments: %v", err)
	}

	if got := common.Hash(decoded.DepositId); got != depositID {
		t.Errorf("DepositId: got %s, want %s (the join key back to Deposited)", got, depositID)
	}
	if got := common.Hash(decoded.DepositRequestHash); got != requestHash {
		t.Errorf("DepositRequestHash: got %s, want %s", got, requestHash)
	}
	if got := common.Hash(decoded.DestinationHash); got != destinationHash {
		t.Errorf("DestinationHash: got %s, want %s", got, destinationHash)
	}
}

func loadSourceIEscrowABI(t *testing.T) *abi.ABI {
	t.Helper()
	path := filepath.Clean(sourceIEscrowABI)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read source ABI %s (run `make generate-abi` in contracts/tvm/source): %v", path, err)
	}
	parsed, err := abi.JSON(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("parse source ABI %s: %v", path, err)
	}
	if len(parsed.Events) == 0 {
		t.Fatalf("%s: source ABI declares no events — wrong file or an empty extraction", path)
	}
	return &parsed
}

func sortedAliasNames() []string {
	names := make([]string, 0, len(iEscrowEventAliases))
	for name := range iEscrowEventAliases {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
