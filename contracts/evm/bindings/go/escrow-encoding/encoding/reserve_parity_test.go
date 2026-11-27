package encoding

import (
	"encoding/json"
	contracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// Cross-side parity vectors for the EVM reserve encoder + paymentId derivation.
//
// The committed file vectors.json is the single,
// FROZEN source of truth. Both this Go test and the sibling TS test
// (reserve-parity.test.ts) read that same file and assert byte-equality, so an
// encoding regression on EITHER side turns CI red. The file is authored from
// the production Go encoder (the signing side, already anchored to on-chain
// known-good values); it is NOT regenerated in CI.
//
// Regenerate ONLY on an intentional encoding change:
//
//	REGEN_PARITY=1 go test ./... -run TestRegenerateReserveParityVectors
//
// then re-baseline the TS side + §"Appendix B" frozen values together.

const reserveParityVectorsPath = "../../../../conformance/vectors.json"

type reserveParityVector struct {
	Name           string `json:"name"`
	ChainID        int64  `json:"chainID"`
	Escrow         string `json:"escrow"`
	PaymentID      string `json:"paymentId"`
	Settler        string `json:"settler"`
	ExpectedDigest string `json:"expectedDigest"`
}

type paymentIDParityVector struct {
	Name              string `json:"name"`
	Depositor         string `json:"depositor"`
	Signature         string `json:"signature"`
	Nonce             string `json:"nonce"`
	ExpectedPaymentID string `json:"expectedPaymentId"`
}

type reserveParityFile struct {
	Comment   string                  `json:"_comment"`
	Reserve   []reserveParityVector   `json:"reserve"`
	PaymentID []paymentIDParityVector `json:"paymentId"`
}

const reserveParityComment = "FROZEN cross-side parity vectors (EVM). Both reserve_parity_test.go (Go) and " +
	"reserve-parity.test.ts (TS) assert against this file; do not edit by hand. " +
	"Regenerate via: REGEN_PARITY=1 go test ./... -run TestRegenerateReserveParityVectors"

// reserveParityInputs is the authored EVM vector set (inputs only). Expected
// digests are computed from the production encoder at regeneration time.
func reserveParityInputs() []reserveParityVector {
	const (
		escrow  = "0x41AD713827f11837f06C065e9cd0Bb56CE1e06a0"
		settler = "0x1E85c6266C9EDf9e6BA293d780DcdDE76dC7Acf7"
		zeroPID = "0x0000000000000000000000000000000000000000000000000000000000000000"
		maxPID  = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
		zeroAdr = "0x0000000000000000000000000000000000000000"
	)
	return []reserveParityVector{
		// Anchors — known-good production reproductions (testdata/encoding-examples.json,
		// already byte-verified by TestReserveEncoder_Digest).
		{Name: "anchor/examples-0", ChainID: 1, Escrow: escrow, PaymentID: "0xbbbf298f926ddc48a92871e25e7e223ba104de64fc827650963e8ec89e37d8ac", Settler: settler},
		{Name: "anchor/examples-1", ChainID: 1, Escrow: escrow, PaymentID: "0x419d1a281d76364f19f4141f885f05041e7c8fba624fa727fe087fa48af2cb1c", Settler: settler},
		// Edge cases.
		{Name: "zero-paymentId", ChainID: 1, Escrow: escrow, PaymentID: zeroPID, Settler: settler},
		{Name: "max-paymentId", ChainID: 1, Escrow: escrow, PaymentID: maxPID, Settler: settler},
		{Name: "zero-settler", ChainID: 1, Escrow: escrow, PaymentID: "0xbbbf298f926ddc48a92871e25e7e223ba104de64fc827650963e8ec89e37d8ac", Settler: zeroAdr},
		{Name: "settler-equals-escrow", ChainID: 1, Escrow: escrow, PaymentID: "0xbbbf298f926ddc48a92871e25e7e223ba104de64fc827650963e8ec89e37d8ac", Settler: escrow},
		// Address-casing invariance: every other vector uses the EIP-55
		// checksummed (mixed-case) `settler`, so feeding the all-lowercase form
		// here proves both encoders normalise casing and yield the same digest.
		{Name: "lowercase-settler", ChainID: 1, Escrow: escrow, PaymentID: "0xbbbf298f926ddc48a92871e25e7e223ba104de64fc827650963e8ec89e37d8ac", Settler: strings.ToLower(settler)},
		// Domain-separator sensitivity — different chainId.
		{Name: "chainId-137", ChainID: 137, Escrow: escrow, PaymentID: "0xbbbf298f926ddc48a92871e25e7e223ba104de64fc827650963e8ec89e37d8ac", Settler: settler},
	}
}

// paymentIDParityInputs is the authored EVM paymentId-derivation vector set.
// keccak256(abi.encode(depositor, signature, nonce)) — the depositId the
// reserve witness commits to. TS counterpart: computePaymentIdV2.
func paymentIDParityInputs() []paymentIDParityVector {
	const depositor = "0x1E85c6266C9EDf9e6BA293d780DcdDE76dC7Acf7"
	// A representative 65-byte ECDSA signature (r ‖ s ‖ v).
	const sig65 = "0x" +
		"1111111111111111111111111111111111111111111111111111111111111111" +
		"2222222222222222222222222222222222222222222222222222222222222222" +
		"1b"
	// Independent anchor: depositor/signature/nonce from testdata/encoding-examples.json
	// (paymentId[0]); its expectedPaymentId 0xbbbf298f… is exactly the paymentId
	// fed into the anchor/examples-0 reserve vector, so the full derivation chain
	// (paymentId → reserve witness) is anchored to the contract reference.
	const examplesDepositor = "0x1Ffc33f5E217b1CF95e713DB49Fcd86C8195666C"
	const examplesSig = "0x380efd4e333d316a9f99e2d31c872459f9675e95eb6d12f8c9e11694ca49df01" +
		"42254b2a658464302955fb29375b73cdcbf38be80164d0f1a58b247b2650ca131b"
	return []paymentIDParityVector{
		{Name: "anchor/examples-paymentId-0", Depositor: examplesDepositor, Signature: examplesSig, Nonce: "1"},
		{Name: "zero-nonce", Depositor: depositor, Signature: "0xdeadbeef", Nonce: "0"},
		{Name: "small-nonce", Depositor: depositor, Signature: "0xdeadbeef", Nonce: "1"},
		{Name: "sig-65-byte", Depositor: depositor, Signature: sig65, Nonce: "42"},
		{Name: "large-nonce", Depositor: depositor, Signature: sig65, Nonce: "340282366920938463463374607431768211455"},
		{Name: "zero-depositor", Depositor: "0x0000000000000000000000000000000000000000", Signature: sig65, Nonce: "7"},
	}
}

func computeReserveVector(t *testing.T, v reserveParityVector) string {
	t.Helper()
	var pid [32]byte
	copy(pid[:], common.FromHex(v.PaymentID))
	digest, err := NewEscrowReserveEncoder().Digest(
		common.HexToAddress(v.Escrow),
		contracts.IEscrowReserveWitness{DepositId: pid, Settler: common.HexToAddress(v.Settler)},
		big.NewInt(v.ChainID),
	)
	if err != nil {
		t.Fatalf("%s: Digest error: %v", v.Name, err)
	}
	return "0x" + common.Bytes2Hex(digest)
}

func computePaymentIDVector(t *testing.T, v paymentIDParityVector) string {
	t.Helper()
	nonce, ok := new(big.Int).SetString(v.Nonce, 10)
	if !ok {
		t.Fatalf("%s: bad nonce %q", v.Name, v.Nonce)
	}
	digest, err := NewEscrowPaymentIdEncoder().Digest(
		common.HexToAddress(v.Depositor),
		common.FromHex(v.Signature),
		nonce,
	)
	if err != nil {
		t.Fatalf("%s: paymentId error: %v", v.Name, err)
	}
	return "0x" + common.Bytes2Hex(digest)
}

func loadReserveParityFile(t *testing.T) reserveParityFile {
	t.Helper()
	data, err := os.ReadFile(reserveParityVectorsPath)
	if err != nil {
		t.Fatalf("read parity vectors (run TestRegenerateReserveParityVectors with REGEN_PARITY=1): %v", err)
	}
	var f reserveParityFile
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatalf("parse parity vectors: %v", err)
	}
	return f
}

// TestReserveParity asserts the production encoder reproduces every frozen
// vector byte-for-byte. The TS test asserts the same file independently.
func TestReserveParity(t *testing.T) {
	f := loadReserveParityFile(t)
	if len(f.Reserve) == 0 || len(f.PaymentID) == 0 {
		t.Fatal("parity vectors file is empty")
	}
	for _, v := range f.Reserve {
		if got := computeReserveVector(t, v); !strings.EqualFold(got, v.ExpectedDigest) {
			t.Errorf("reserve %q: got %s want %s", v.Name, got, v.ExpectedDigest)
		}
	}
	for _, v := range f.PaymentID {
		if got := computePaymentIDVector(t, v); !strings.EqualFold(got, v.ExpectedPaymentID) {
			t.Errorf("paymentId %q: got %s want %s", v.Name, got, v.ExpectedPaymentID)
		}
	}
}

// Contract-/Foundry-derived known-good values (testdata/encoding-examples.json). The
// frozen vectors named here MUST equal these. Asserted in CI by
// TestReserveParityAnchors — NOT only in the REGEN-gated regenerator — so the
// gate proves the frozen file matches the chain reference, not merely that Go
// and TS agree with the committed blob.
var reserveDigestAnchors = map[string]string{
	"anchor/examples-0": "0xcf8d951f801282d378804b4afd2ea9973e63395d4d21caa775658ca38c5c09df",
	"anchor/examples-1": "0x581d3e3540d76eb5531dc4d3a989acc8750a948494c283f284ea978dd1a2a93e",
}
var paymentIdAnchors = map[string]string{
	"anchor/examples-paymentId-0": "0xbbbf298f926ddc48a92871e25e7e223ba104de64fc827650963e8ec89e37d8ac",
}

// TestReserveParityAnchors pins the frozen file's anchor vectors to the chain
// reference inside the CI gate (the regenerator's identical pre-write check only
// runs under REGEN_PARITY=1). This converts "Go and TS agree with the file" into
// "Go and TS agree AND the file matches the chain".
func TestReserveParityAnchors(t *testing.T) {
	f := loadReserveParityFile(t)
	matched := 0
	for _, v := range f.Reserve {
		if want, ok := reserveDigestAnchors[v.Name]; ok {
			matched++
			if !strings.EqualFold(v.ExpectedDigest, want) {
				t.Errorf("reserve anchor %q = %s, want chain known-good %s", v.Name, v.ExpectedDigest, want)
			}
		}
	}
	for _, v := range f.PaymentID {
		if want, ok := paymentIdAnchors[v.Name]; ok {
			matched++
			if !strings.EqualFold(v.ExpectedPaymentID, want) {
				t.Errorf("paymentId anchor %q = %s, want chain known-good %s", v.Name, v.ExpectedPaymentID, want)
			}
		}
	}
	if want := len(reserveDigestAnchors) + len(paymentIdAnchors); matched != want {
		t.Fatalf("expected %d anchor vectors in frozen file, found %d (anchor dropped from vectors?)", want, matched)
	}
}

// TestRegenerateReserveParityVectors re-authors the frozen file from the
// production encoder. Opt-in (REGEN_PARITY=1) so it never runs in CI. It
// asserts the anchor digests equal the on-chain known-good values before
// writing, so a broken regenerator cannot silently re-baseline.
func TestRegenerateReserveParityVectors(t *testing.T) {
	if os.Getenv("REGEN_PARITY") != "1" {
		t.Skip("set REGEN_PARITY=1 to regenerate the frozen parity vectors")
	}
	f := reserveParityFile{Comment: reserveParityComment}
	for _, v := range reserveParityInputs() {
		v.ExpectedDigest = computeReserveVector(t, v)
		if want, ok := reserveDigestAnchors[v.Name]; ok && !strings.EqualFold(v.ExpectedDigest, want) {
			t.Fatalf("anchor %q regenerated to %s, expected on-chain known-good %s", v.Name, v.ExpectedDigest, want)
		}
		f.Reserve = append(f.Reserve, v)
	}
	for _, v := range paymentIDParityInputs() {
		v.ExpectedPaymentID = computePaymentIDVector(t, v)
		if want, ok := paymentIdAnchors[v.Name]; ok && !strings.EqualFold(v.ExpectedPaymentID, want) {
			t.Fatalf("paymentId anchor %q regenerated to %s, expected contract known-good %s", v.Name, v.ExpectedPaymentID, want)
		}
		f.PaymentID = append(f.PaymentID, v)
	}
	out, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(reserveParityVectorsPath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(reserveParityVectorsPath, append(out, '\n'), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	t.Logf("wrote %s (%d reserve, %d paymentId vectors)", reserveParityVectorsPath, len(f.Reserve), len(f.PaymentID))
}
