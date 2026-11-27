package encoding

import (
	"encoding/json"
	contracts "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/generated"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// Cross-side parity vectors for the TVM (Tron) reserve encoder.
//
// The committed file vectors.json is the single,
// FROZEN source of truth. Both this Go test and the sibling TS test
// (reserve-parity.test.ts) read that same file and assert byte-equality, so a
// regression on EITHER side turns CI red. Authored from the production Go
// encoder; not regenerated in CI.
//
// Reserve-witness addresses are in EVM-hex form (the signing side converts Tron
// base58 to hex before encoding — see createTVMAuthorization).
//
// The paymentId vectors pin the TVM-SPECIFIC depositId derivation, which is NOT
// shared with EVM: tvm payment_id_encoder.go takes the depositor as a base58
// ("T…") or 41-prefixed-hex string and runs it through EncodeTIP712Address
// (Tron base58/41-hex → 20-byte) before abi.encode, whereas the EVM encoder
// takes a common.Address. Pinning it cross-side (Go `EscrowPaymentIdEncoder` vs
// the TS `computePaymentId`) catches a divergence in how a Tron depositor is
// normalized into the depositId that becomes the reserve witness's PaymentId.
//
// Regenerate ONLY on an intentional encoding change:
//
//	REGEN_PARITY=1 go test ./... -run TestRegenerateReserveParityVectors

const reserveParityVectorsPath = "../../../../conformance/vectors.json"

// Raw Tron block.chainid values (masked to 32 bits inside the encoder).
const (
	shastaChainIDParity  = 2494104990
	mainnetChainIDParity = 728126428
	// shasta + 2^32 — must collide with shasta after masking.
	shastaOverflowChainID = shastaChainIDParity + (1 << 32)
)

type reserveParityVector struct {
	Name           string `json:"name"`
	ChainID        int64  `json:"chainID"`
	Escrow         string `json:"escrow"`
	PaymentID      string `json:"paymentId"`
	Settler        string `json:"settler"`
	ExpectedDigest string `json:"expectedDigest"`
}

// paymentIDParityVector pins the Tron depositId derivation. Depositor is kept
// in its original on-the-wire form (base58 or 41-/0x-hex) so both sides
// exercise EncodeTIP712Address / the TS normalizer.
type paymentIDParityVector struct {
	Name              string `json:"name"`
	Depositor         string `json:"depositor"`
	Signature         string `json:"signature"`
	Nonce             string `json:"nonce"`
	ExpectedPaymentID string `json:"expectedPaymentId"`
}

// rejectParityVector pins a depositor that BOTH sides must reject. The point of
// the normalizer is that the TS and Go sides refuse the same malformed
// addresses; without these, only accept-cases were proven and a
// reject-divergence (TS throws where Go silently accepts, or vice-versa) would
// ship unseen.
type rejectParityVector struct {
	Name      string `json:"name"`
	Depositor string `json:"depositor"`
	Reason    string `json:"reason"`
}

type reserveParityFile struct {
	Comment         string                  `json:"_comment"`
	Reserve         []reserveParityVector   `json:"reserve"`
	PaymentID       []paymentIDParityVector `json:"paymentId"`
	RejectPaymentID []rejectParityVector    `json:"rejectPaymentId"`
}

const reserveParityComment = "FROZEN cross-side parity vectors (TVM). Both reserve_parity_test.go (Go) and " +
	"reserve-parity.test.ts (TS) assert against this file; do not edit by hand. " +
	"Regenerate from contracts/tvm/bindings/go/escrow-encoding: " +
	"REGEN_PARITY=1 go test ./... -run TestRegenerateReserveParityVectors"

// reserveParityInputs is the authored TVM vector set (inputs only).
func reserveParityInputs() []reserveParityVector {
	const (
		// Shasta anchor — base58 escrow TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py /
		// settler TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N converted to EVM-hex.
		escrow  = "0x2e9fbe1886fa094573e3bd25c554e827873bb9fc"
		settler = "0xa601a68f95f0cb1ec1e186b1f4f709478bde679f"
		anchPID = "0xd927076fea2c62b09e3b0b7fe343573849be3933d4d645dbaa8fd0bbc06f13bc"
		zeroPID = "0x0000000000000000000000000000000000000000000000000000000000000000"
		maxPID  = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
		zeroAdr = "0x0000000000000000000000000000000000000000"
	)
	return []reserveParityVector{
		{Name: "anchor/examples-shasta", ChainID: shastaChainIDParity, Escrow: escrow, PaymentID: anchPID, Settler: settler},
		// Masking: shasta + 2^32 must produce the same digest as the anchor.
		{Name: "mask-overflow", ChainID: shastaOverflowChainID, Escrow: escrow, PaymentID: anchPID, Settler: settler},
		{Name: "mainnet-chainId", ChainID: mainnetChainIDParity, Escrow: escrow, PaymentID: anchPID, Settler: settler},
		{Name: "zero-paymentId", ChainID: shastaChainIDParity, Escrow: escrow, PaymentID: zeroPID, Settler: settler},
		{Name: "max-paymentId", ChainID: shastaChainIDParity, Escrow: escrow, PaymentID: maxPID, Settler: settler},
		{Name: "zero-settler", ChainID: shastaChainIDParity, Escrow: escrow, PaymentID: anchPID, Settler: zeroAdr},
		{Name: "settler-equals-escrow", ChainID: shastaChainIDParity, Escrow: escrow, PaymentID: anchPID, Settler: escrow},
	}
}

// paymentIDParityInputs exercises the three depositor input forms that
// EncodeTIP712Address accepts (base58, 41-prefixed hex, plain 20-byte hex).
// base58-depositor, hex41-depositor and plain-hex-depositor are the SAME address
// in different forms and MUST yield the same depositId — a direct check that the
// Tron normalization is form-invariant on both sides. The leading-41-* trio does
// the same for an address whose body begins with the marker byte.
func paymentIDParityInputs() []paymentIDParityVector {
	// Address TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py == 0x41 + 2e9fbe…b9fc.
	const (
		depB58   = "TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4py"
		dep41Hex = "0x412e9fbe1886fa094573e3bd25c554e827873bb9fc"
		depHex   = "0x2e9fbe1886fa094573e3bd25c554e827873bb9fc"
		altB58   = "TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N"
	)
	const sig65 = "0x" +
		"1111111111111111111111111111111111111111111111111111111111111111" +
		"2222222222222222222222222222222222222222222222222222222222222222" +
		"1b"
	// Independent anchor: the depositor/signature/nonce from
	// the TVM escrow contract's encoding examples (paymentId[0]), whose
	// expectedPaymentId is Foundry-/contract-derived — so the paymentId leg gets
	// the same external anchoring as the reserve leg, rather than being pure
	// Go self-reference. Asserted in TestRegenerateReserveParityVectors.
	const examplesSig = "0x164f0f9c1cd6a10420502792d408b54e81c73652f51db08b0da0884b3179c528" +
		"77fd386c009a1b6fc242a5afcf03ab583c1a407bacbf1626c0ca30c7851d81ce1c"
	// 0x41-leading address: a 20-byte address whose first byte happens to be the
	// Tron mainnet prefix. All three spellings must normalize to the same 20
	// bytes; the plain-hex one only does so if the marker is stripped by length
	// rather than by leading characters.
	const (
		lead41B58      = "TFxRTJi1NBJ2qMr3NJvszkPGVtvSVcNLx8"
		lead41Hex41    = "0x4141aabbccddeeff00112233445566778899aabbcc"
		lead41PlainHex = "0x41aabbccddeeff00112233445566778899aabbcc"
	)
	return []paymentIDParityVector{
		{Name: "anchor/examples-paymentId", Depositor: altB58, Signature: examplesSig, Nonce: "1776340107514"},
		{Name: "base58-depositor", Depositor: depB58, Signature: sig65, Nonce: "1"},
		{Name: "hex41-depositor", Depositor: dep41Hex, Signature: sig65, Nonce: "1"},
		{Name: "plain-hex-depositor", Depositor: depHex, Signature: sig65, Nonce: "1"},
		{Name: "alt-base58-zero-nonce", Depositor: altB58, Signature: "0xdeadbeef", Nonce: "0"},
		{Name: "alt-base58-large-nonce", Depositor: altB58, Signature: sig65, Nonce: "340282366920938463463374607431768211455"},
		{Name: "leading-41-base58", Depositor: lead41B58, Signature: sig65, Nonce: "1"},
		{Name: "leading-41-hex41", Depositor: lead41Hex41, Signature: sig65, Nonce: "1"},
		{Name: "leading-41-plain-hex", Depositor: lead41PlainHex, Signature: sig65, Nonce: "1"},
	}
}

// rejectPaymentIDInputs are depositor forms BOTH sides must reject. Frozen so a
// future refactor can't quietly start accepting one of them on a single side.
func rejectPaymentIDInputs() []rejectParityVector {
	return []rejectParityVector{
		{Name: "empty", Depositor: "", Reason: "empty address"},
		// 25-byte base58 with a corrupted final checksum byte — the typo case.
		{Name: "bad-base58-checksum", Depositor: "TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4qS", Reason: "base58check checksum mismatch"},
		{Name: "non-base58-chars", Depositor: "T0OIl0OIl0OIl0OIl0OIl0OIl0OIl", Reason: "0 O I l are not in the base58 alphabet"},
		{Name: "hex-19-bytes", Depositor: "0xaabbccddeeff00112233445566778899aabbcc", Reason: "19 bytes, not 20"},
		{Name: "hex-21-bytes", Depositor: "0xaabbccddeeff00112233445566778899aabbccddee", Reason: "21 bytes, not 20"},
		{Name: "uppercase-0X-prefix", Depositor: "0X2e9fbe1886fa094573e3bd25c554e827873bb9fc", Reason: "Go strips only lowercase 0x"},
		// Wrong marker byte over the same body the leading-41 accept vectors use, so
		// the marker is the only difference between these and leading-41-hex41. Both
		// nibbles get their own vector: a marker comparison that inspects one nibble
		// and ignores the other accepts one of these two, and no other reject vector
		// is in the 4x family or ends in 1.
		{Name: "wrong-marker-4f", Depositor: "0x4f41aabbccddeeff00112233445566778899aabbcc", Reason: "marker differs from 41 in the low nibble only"},
		{Name: "wrong-marker-a1", Depositor: "0xa141aabbccddeeff00112233445566778899aabbcc", Reason: "marker differs from 41 in the high nibble only"},
		// Only a LEADING 0x comes off. A strip matching it anywhere would delete
		// this interior pair and leave 40 valid hex characters, silently resolving
		// a 42-character string to an address it does not spell.
		{Name: "interior-0x", Depositor: "e96051e8da2f0cc02c370x2252dfacfdb129b5d4d6", Reason: "0x inside the body is address data, not a prefix"},
		// Adjacent to the prefix, where a leading-window scan would still reach and a
		// mid-body witness cannot tell the difference. Also where the two strips
		// meet: the marker comes off, the 0x stays.
		{Name: "interior-0x-after-marker", Depositor: "410x00112233445566778899aabbccddeeff001122", Reason: "0x adjacent to the marker is address data, not a prefix"},
		{Name: "double-0x-prefix", Depositor: "0x0xe96051e8da2f0cc02c372252dfacfdb129b5d4d6", Reason: "exactly one leading 0x comes off, not a run of them"},
	}
}

func computePaymentIDVector(t *testing.T, v paymentIDParityVector) string {
	t.Helper()
	nonce, ok := new(big.Int).SetString(v.Nonce, 10)
	if !ok {
		t.Fatalf("%s: bad nonce %q", v.Name, v.Nonce)
	}
	id, err := NewEscrowPaymentIdEncoder().Digest(v.Depositor, common.FromHex(v.Signature), nonce)
	if err != nil {
		t.Fatalf("%s: paymentId error: %v", v.Name, err)
	}
	return "0x" + common.Bytes2Hex(id)
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
	if len(f.Reserve) == 0 {
		t.Fatal("parity vectors file is empty")
	}
	for _, v := range f.Reserve {
		if got := computeReserveVector(t, v); !strings.EqualFold(got, v.ExpectedDigest) {
			t.Errorf("reserve %q: got %s want %s", v.Name, got, v.ExpectedDigest)
		}
	}
	if len(f.PaymentID) == 0 {
		t.Fatal("parity vectors file has no paymentId vectors")
	}
	for _, v := range f.PaymentID {
		if got := computePaymentIDVector(t, v); !strings.EqualFold(got, v.ExpectedPaymentID) {
			t.Errorf("paymentId %q: got %s want %s", v.Name, got, v.ExpectedPaymentID)
		}
	}
	if len(f.RejectPaymentID) == 0 {
		t.Fatal("parity vectors file has no rejectPaymentId vectors")
	}
	for _, v := range f.RejectPaymentID {
		if _, err := NewEscrowPaymentIdEncoder().Digest(v.Depositor, []byte{}, big.NewInt(1)); err == nil {
			t.Errorf("rejectPaymentId %q (%s): expected error, got none", v.Name, v.Reason)
		}
	}
}

// Known-good anchors. tvmReserveAnchors["anchor/examples-shasta"] is the on-chain
// Shasta reserve digest; tvmPaymentIdAnchors is Foundry-/contract-derived from
// encoding-examples.json (paymentId[0]). Asserted in CI by
// TestReserveParityAnchors — not only in the REGEN-gated regenerator — so the
// gate proves the frozen file matches the chain reference, not just Go↔TS.
var tvmReserveAnchors = map[string]string{
	"anchor/examples-shasta": "0xb0245d1de88ea677343ff99c9f83434c60a3f6438475d28731231d9be64bcca7",
}
var tvmPaymentIdAnchors = map[string]string{
	"anchor/examples-paymentId": "0xd927076fea2c62b09e3b0b7fe343573849be3933d4d645dbaa8fd0bbc06f13bc",
}

// Contract-published Escrow TIP-712 domain separator for the Shasta-deployed
// Escrow (escrow 0x2e9fbe…b9fc, chainId shastaChainIDParity). Source:
// encoding-examples.json#domainSeparators.escrow from the TVM escrow contract project,
// produced by the contract's own Foundry suite — NOT by this encoder. The
// reserve digest is keccak256(0x1901 ‖ domainSeparator ‖ structHash), so pinning
// the separator to the contract's published value proves both encoders hash the
// same domain the contract does (incl. the 20-byte verifyingContract form) —
// closing the "Go==TS==our-own-constant" gap on the one assumption the anchor
// can't otherwise verify.
const contractEscrowDomainSeparator = "0x43cd45f97265fa0fc229571347a828eb18224cf3c1020e12017f491e9a50e3a0"

// TestReserveParityAnchors pins the frozen file's anchor vectors to the chain
// reference inside the CI gate (the regenerator's identical pre-write check only
// runs under REGEN_PARITY=1).
func TestReserveParityAnchors(t *testing.T) {
	f := loadReserveParityFile(t)
	matched := 0
	for _, v := range f.Reserve {
		if want, ok := tvmReserveAnchors[v.Name]; ok {
			matched++
			if !strings.EqualFold(v.ExpectedDigest, want) {
				t.Errorf("reserve anchor %q = %s, want on-chain known-good %s", v.Name, v.ExpectedDigest, want)
			}
		}
	}
	for _, v := range f.PaymentID {
		if want, ok := tvmPaymentIdAnchors[v.Name]; ok {
			matched++
			if !strings.EqualFold(v.ExpectedPaymentID, want) {
				t.Errorf("paymentId anchor %q = %s, want contract known-good %s", v.Name, v.ExpectedPaymentID, want)
			}
		}
	}
	if want := len(tvmReserveAnchors) + len(tvmPaymentIdAnchors); matched != want {
		t.Fatalf("expected %d anchor vectors in frozen file, found %d (anchor dropped?)", want, matched)
	}
}

// TestReserveDomainSeparatorMatchesContract proves the encoder's TIP-712 domain
// reproduces the Escrow contract's published domain separator. If the contract
// computed its domain over a different verifyingContract form (21-byte 0x41) or
// a different version/salt, this fails — even though Go↔TS would still agree.
func TestReserveDomainSeparatorMatchesContract(t *testing.T) {
	td := NewEscrowReserveEncoder().BuildTypedData(
		common.HexToAddress("0x2e9fbe1886fa094573e3bd25c554e827873bb9fc"),
		contracts.IEscrowReserveWitness{},
		big.NewInt(shastaChainIDParity),
	)
	sep, err := td.HashStruct("EIP712Domain", td.Domain.Map())
	if err != nil {
		t.Fatalf("hash domain: %v", err)
	}
	if got := "0x" + common.Bytes2Hex(sep); !strings.EqualFold(got, contractEscrowDomainSeparator) {
		t.Errorf("domain separator = %s, want contract-published %s", got, contractEscrowDomainSeparator)
	}
}

// TestRegenerateReserveParityVectors re-authors the frozen file from the
// production encoder. Opt-in (REGEN_PARITY=1) so it never runs in CI. It
// asserts the Shasta anchor equals the on-chain known-good value and that the
// masking vector collides with the anchor before writing.
func TestRegenerateReserveParityVectors(t *testing.T) {
	if os.Getenv("REGEN_PARITY") != "1" {
		t.Skip("set REGEN_PARITY=1 to regenerate the frozen parity vectors")
	}
	knownShastaAnchor := tvmReserveAnchors["anchor/examples-shasta"]

	f := reserveParityFile{Comment: reserveParityComment}
	digestByName := map[string]string{}
	for _, v := range reserveParityInputs() {
		v.ExpectedDigest = computeReserveVector(t, v)
		digestByName[v.Name] = v.ExpectedDigest
		f.Reserve = append(f.Reserve, v)
	}
	if got := digestByName["anchor/examples-shasta"]; !strings.EqualFold(got, knownShastaAnchor) {
		t.Fatalf("shasta anchor regenerated to %s, expected on-chain known-good %s", got, knownShastaAnchor)
	}
	if digestByName["mask-overflow"] != digestByName["anchor/examples-shasta"] {
		t.Fatalf("mask-overflow digest %s should equal shasta anchor %s (chainId masking broken)",
			digestByName["mask-overflow"], digestByName["anchor/examples-shasta"])
	}

	// Foundry-/contract-derived known-good from encoding-examples.json (paymentId[0]).
	knownExamplesPaymentID := tvmPaymentIdAnchors["anchor/examples-paymentId"]

	pidByName := map[string]string{}
	for _, v := range paymentIDParityInputs() {
		v.ExpectedPaymentID = computePaymentIDVector(t, v)
		pidByName[v.Name] = v.ExpectedPaymentID
		f.PaymentID = append(f.PaymentID, v)
	}
	if got := pidByName["anchor/examples-paymentId"]; !strings.EqualFold(got, knownExamplesPaymentID) {
		t.Fatalf("examples paymentId anchor regenerated to %s, expected contract known-good %s", got, knownExamplesPaymentID)
	}
	// Form-invariance: base58, 41-hex, and plain-hex of the same address must
	// derive the identical depositId.
	if pidByName["base58-depositor"] != pidByName["hex41-depositor"] ||
		pidByName["base58-depositor"] != pidByName["plain-hex-depositor"] {
		t.Fatalf("Tron depositor normalization is not form-invariant: base58=%s hex41=%s plainHex=%s",
			pidByName["base58-depositor"], pidByName["hex41-depositor"], pidByName["plain-hex-depositor"])
	}
	// 0x41-leading address: base58, 41-hex and plain-hex forms must agree. The
	// plain-hex spelling is the one a marker strip gated on leading characters
	// truncates, which is what makes this family worth freezing.
	if pidByName["leading-41-base58"] != pidByName["leading-41-hex41"] ||
		pidByName["leading-41-base58"] != pidByName["leading-41-plain-hex"] {
		t.Fatalf("0x41-leading address not form-invariant: base58=%s hex41=%s plainHex=%s",
			pidByName["leading-41-base58"], pidByName["leading-41-hex41"], pidByName["leading-41-plain-hex"])
	}

	// Reject vectors: assert the production encoder refuses each before freezing,
	// so we never bake in an input one side silently accepts.
	for _, r := range rejectPaymentIDInputs() {
		if _, err := NewEscrowPaymentIdEncoder().Digest(r.Depositor, []byte{}, big.NewInt(1)); err == nil {
			t.Fatalf("reject vector %q (%s) was accepted by the encoder", r.Name, r.Reason)
		}
		f.RejectPaymentID = append(f.RejectPaymentID, r)
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
	t.Logf("wrote %s (%d reserve, %d paymentId, %d reject vectors)",
		reserveParityVectorsPath, len(f.Reserve), len(f.PaymentID), len(f.RejectPaymentID))
}
