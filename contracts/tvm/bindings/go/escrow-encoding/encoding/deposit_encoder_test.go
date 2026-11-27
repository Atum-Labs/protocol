package encoding

import (
	"encoding/hex"
	"fmt"
	"math/big"
	"strings"
	"testing"

	contracts "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/generated"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// shastaChainID is what Tron Shasta returns from block.chainid; the V3
// encoders mask to 32 bits internally for TIP-712.
const shastaChainID = int64(2494104990)

func mustParseBigInt(s string) *big.Int {
	bi, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("invalid big.Int string: " + s)
	}
	return bi
}

// mustTVMAddress converts a base58/hex Tron address into a 20-byte
// common.Address; fails the calling test on error.
func mustTVMAddress(t *testing.T, addr string) common.Address {
	t.Helper()
	a, err := TVMAddress(addr)
	if err != nil {
		t.Fatalf("TVMAddress(%q): %v", addr, err)
	}
	return a
}

// TestDepositEncoder_V3_FromExamples verifies the encoder against the
// Foundry-computed reference digest in the TVM escrow contract's encoding examples
// (the "deposit" entry). The example uses Shasta-deployed contracts and the V3
// witness shape {reserver, releaser}.
func TestDepositEncoder_V3_FromExamples(t *testing.T) {
	const expectedDigestHex = "6f82c825f19bb27159168f053d026c72043ca51699943db0778639310c99e111"

	encoder := NewEscrowDepositEncoder()

	witness := contracts.IEscrowDepositWitness{
		Reserver: mustTVMAddress(t, "TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N"),
		Releaser: mustTVMAddress(t, "TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N"),
	}

	digest, err := encoder.Digest(
		mustTVMAddress(t, "TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp"), // permit2
		mustTVMAddress(t, "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs"), // token
		mustTVMAddress(t, "TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py"), // spender (escrow)
		witness,
		mustParseBigInt("100000000"),     // amount
		mustParseBigInt("1776340107514"), // nonce
		big.NewInt(1776343707),           // deadline
		big.NewInt(shastaChainID),        // chainID
	)
	if err != nil {
		t.Fatalf("Digest() error: %v", err)
	}

	got := strings.ToLower(hex.EncodeToString(digest))
	if got != expectedDigestHex {
		t.Errorf("digest mismatch:\n  got:  %s\n  want: %s", got, expectedDigestHex)
	}
}

// TestDepositEncoder_BuildTypedData verifies BuildTypedData and
// DigestWithTypedData stay in sync with Digest.
func TestDepositEncoder_BuildTypedData(t *testing.T) {
	encoder := NewEscrowDepositEncoder()
	witness := contracts.IEscrowDepositWitness{
		Reserver: mustTVMAddress(t, "TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N"),
		Releaser: mustTVMAddress(t, "TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N"),
	}
	permit2 := mustTVMAddress(t, "TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp")
	token := mustTVMAddress(t, "TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs")
	spender := mustTVMAddress(t, "TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py")
	amount := big.NewInt(100000000)
	nonce := big.NewInt(1)
	deadline := big.NewInt(1776343707)
	chainID := big.NewInt(shastaChainID)

	typedData := encoder.BuildTypedData(permit2, token, spender, witness, amount, nonce, deadline, chainID)
	if typedData.PrimaryType != "PermitWitnessTransferFrom" {
		t.Errorf("unexpected PrimaryType: %q", typedData.PrimaryType)
	}
	if typedData.Domain.Name != "Permit2" {
		t.Errorf("unexpected domain name: %q", typedData.Domain.Name)
	}
	if typedData.Domain.Version != "" {
		t.Errorf("Permit2 domain should not have version, got %q", typedData.Domain.Version)
	}
	if _, ok := typedData.Types["DepositWitness"]; !ok {
		t.Error("missing DepositWitness type")
	}
	if witnessType := typedData.Types["DepositWitness"]; len(witnessType) != 2 {
		t.Errorf("V3 DepositWitness should have 2 fields (reserver, releaser); got %d", len(witnessType))
	}
	// CORE-1911 tripwire. The count check above is necessary but NOT sufficient: it pins the
	// generated TYPE. What it cannot see is a producer whose struct literal fails to populate a
	// member the type declares.
	//
	// That gap is the actual hazard. wallet-orch's witness literals
	// (internal/backends/{evm,tron}_message_generator.go) are KEYED, so regenerating these
	// bindings to the four-member CORE-2120 shape still COMPILES — depositRequestHash and
	// destination silently default to bytes32(0) and "". The escrow rejects empty commitments
	// first, so the result is a revert on every deposit off a clean build.
	//
	// Asserting that every declared member is present AND non-empty in the signed message closes
	// it: true today, and false the moment the type grows without the producer keeping up.
	assertEveryWitnessMemberPopulated(t, typedData)

	digest1, err := encoder.Digest(permit2, token, spender, witness, amount, nonce, deadline, chainID)
	if err != nil {
		t.Fatalf("Digest: %v", err)
	}
	digest2, _, err := encoder.DigestWithTypedData(permit2, token, spender, witness, amount, nonce, deadline, chainID)
	if err != nil {
		t.Fatalf("DigestWithTypedData: %v", err)
	}
	if !bytesEqual(digest1, digest2) {
		t.Errorf("Digest and DigestWithTypedData disagree:\n  Digest: %x\n  DigestWithTypedData: %x", digest1, digest2)
	}
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// assertEveryWitnessMemberPopulated fails if any member the DepositWitness TYPE declares is
// missing from the signed message, or present but zero-valued. See the CORE-1911 note above.
func assertEveryWitnessMemberPopulated(t *testing.T, typedData apitypes.TypedData) {
	t.Helper()

	declared, ok := typedData.Types["DepositWitness"]
	if !ok {
		t.Fatal("missing DepositWitness type")
	}
	witnessMsg, ok := typedData.Message["witness"].(map[string]interface{})
	if !ok {
		t.Fatal("witness is absent from the signed message, or is not an object")
	}

	for _, field := range declared {
		raw, present := witnessMsg[field.Name]
		if !present {
			t.Errorf("DepositWitness declares %q (%s) but the signed message never sets it: a keyed struct literal is not populating it, so it would be signed as a default value", field.Name, field.Type)
			continue
		}
		if isZeroWitnessValue(raw) {
			t.Errorf("DepositWitness member %q (%s) is zero-valued in the signed message (%v); the escrow rejects empty commitments, so this would revert on every deposit", field.Name, field.Type, raw)
		}
	}
}

// isZeroWitnessValue reports whether a witness member carries a default rather than a real value:
// the empty string, or an all-zero hex address/hash of any width.
func isZeroWitnessValue(raw interface{}) bool {
	s, ok := raw.(string)
	if !ok {
		return raw == nil
	}
	if s == "" {
		return true
	}
	trimmed := strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X")
	if trimmed == "" {
		return true
	}
	return strings.Trim(trimmed, "0") == ""
}

// The digest the TypeScript encoder is pinned to (deposit-encoder.test.ts, which passes the same
// addresses in base58), so both languages are held to the same bytes.
func TestDepositWithDestinationGolden(t *testing.T) {
	witness := contracts.IEscrowDepositWitness{
		DepositRequestHash: crypto.Keccak256Hash([]byte("req-golden-tron")),
		Destination:        "tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t@TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB",
		Reserver:           common.HexToAddress("0xa601a68f95f0cb1ec1e186b1f4f709478bde679f"),
		Releaser:           common.HexToAddress("0xa601a68f95f0cb1ec1e186b1f4f709478bde679f"),
	}
	digest, _, err := EscrowDepositEncoder{}.DigestWithDestination(
		common.HexToAddress("0x9433ffaad19a9aaff9ec184b879dd23ba5a6553d"),
		common.HexToAddress("0x42a1e39aefa49290f2b3f9ed688d7cecf86cd6e0"),
		common.HexToAddress("0x2e9fbe1886fa094573e3bd25c554e827873bb9fc"),
		witness, big.NewInt(100000000), big.NewInt(1776340107514), big.NewInt(1776343707), big.NewInt(2494104990))
	if err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprintf("0x%x", digest); got != "0xe3d341e43876778976d830aa30cd15f97a7874030e8e9c6e31faa36043a98791" {
		t.Fatalf("digest = %s", got)
	}
}
