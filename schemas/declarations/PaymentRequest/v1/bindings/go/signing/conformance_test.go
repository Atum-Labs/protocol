package ldverification

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Cross-language conformance for the PaymentRequest/v1 LD signing
// libraries. The contract these tests pin:
//
//  1. A request signed by the TS signer (signPaymentRequest /
//     signPaymentRequestEd25519) verifies on the Go side with the
//     expected recovered identity.
//  2. The reverse holds — covered by the TS-side conformance.test.ts.
//  3. Ed25519 signatures are deterministic (RFC 8032), so the Go-signed
//     and TS-signed ed25519 fixtures MUST be byte-identical. Drift here
//     means one side's canonicalization, hash construction, or
//     proof-block assembly has diverged.
//
// The fixtures live at schemas/declarations/PaymentRequest/v1/conformance/fixtures/
// and are regenerated via the two language-specific generators. Mirror of
// the FulfillmentQuote conformance_test.go.

func conformanceFixturesDir(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("cwd: %v", err)
	}
	// cwd here is the package dir (signing/go). Walk up
	// to the PaymentRequest/v1 directory.
	dir := filepath.Join(cwd, "..", "..", "..", "conformance", "fixtures")
	abs, err := filepath.Abs(dir)
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	if _, err := os.Stat(abs); err != nil {
		t.Fatalf("fixtures dir %s not found: %v", abs, err)
	}
	return abs
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	path := filepath.Join(conformanceFixturesDir(t), name)
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return b
}

// fixtureCreated is the proof.created every signed fixture carries;
// pinning the recovered value makes the contract "same signer AND same
// created".
const fixtureCreated = "2026-04-01T00:00:00.000Z"

// createdLayout is the millis-UTC RFC-3339 layout the signers emit;
// formatting Result.Created with it reproduces the fixture's created
// verbatim.
const createdLayout = "2006-01-02T15:04:05.000Z07:00"

// TestConformance_VerifyTSSignedSecp256k1 is the Go ⇐ TS leg of the
// conformance contract for the secp256k1-recovery cryptosuite. A failure
// here means a doc that the TS signer emitted produced bytes the Go
// verifier can't recover — likely a canonicalization disagreement, a JWS
// encoding mismatch, or a v-byte alignment drift.
func TestConformance_VerifyTSSignedSecp256k1(t *testing.T) {
	signed := readFixture(t, "secp256k1-ts-signed.json")
	res, err := VerifyPaymentRequest(signed)
	if err != nil {
		t.Fatalf("VerifyPaymentRequest(secp256k1-ts-signed): %v", err)
	}
	signerAddr := mustSecp256k1Signer(t, res)
	// The fixture is signed by Hardhat account #0. Pinning the recovered
	// address against the well-known value means a regression that
	// silently recovers a different-but-well-formed signer (a v-byte flip,
	// an off-by-one in the JWS parse) fires here rather than passing
	// vacuously.
	const hardhatAccount0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	if !strings.EqualFold(signerAddr.Hex(), hardhatAccount0) {
		t.Fatalf("recovered SignerAddress = %s, want %s", signerAddr.Hex(), hardhatAccount0)
	}
	if got := res.Created.UTC().Format(createdLayout); got != fixtureCreated {
		t.Errorf("recovered Created = %s, want %s", got, fixtureCreated)
	}
}

// TestConformance_VerifyTSSignedTypedSecp256k1 is the Go ⇐ TS leg for the typed form a wallet
// signs: the TS signer took an EIP-712 signature over PaymentRequestProof{proofHash, docHash} from
// ethers' Wallet.signTypedData, and the Go verifier must recover the same signer from it as from
// the raw form, under the same proof options.
func TestConformance_VerifyTSSignedTypedSecp256k1(t *testing.T) {
	signed := readFixture(t, "secp256k1-typed-ts-signed.json")
	res, err := VerifyPaymentRequestWithOptions(signed, VerifyOptions{AcceptPaymentRequestTypedProof: true})
	if err != nil {
		t.Fatalf("VerifyPaymentRequestWithOptions(secp256k1-typed-ts-signed): %v", err)
	}
	const hardhatAccount0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	if signer := mustSecp256k1Signer(t, res); !strings.EqualFold(signer.Hex(), hardhatAccount0) {
		t.Fatalf("recovered SignerAddress = %s, want %s", signer.Hex(), hardhatAccount0)
	}
	if got := res.Created.UTC().Format(createdLayout); got != fixtureCreated {
		t.Errorf("recovered Created = %s, want %s", got, fixtureCreated)
	}
	// The same document, signed raw, recovers the same signer from a different signature.
	raw := readFixture(t, "secp256k1-ts-signed.json")
	if bytes.Equal(raw, signed) {
		t.Fatal("the typed fixture is the raw fixture")
	}
	// Without the opt-in, the typed fixture recovers someone else.
	plain, err := VerifyPaymentRequest(signed)
	if err != nil {
		t.Fatal(err)
	}
	if signer := mustSecp256k1Signer(t, plain); strings.EqualFold(signer.Hex(), hardhatAccount0) {
		t.Fatal("VerifyPaymentRequest took the typed form without the opt-in")
	}
}

// TestConformance_VerifyTSSignedEd25519 is the Go ⇐ TS leg for ed25519.
// Mirror of the secp256k1 test above; the recovered pubkey is checked
// rather than an address because Solana identifiers ARE the pubkey.
func TestConformance_VerifyTSSignedEd25519(t *testing.T) {
	signed := readFixture(t, "ed25519-ts-signed.json")
	res, err := VerifyPaymentRequest(signed)
	if err != nil {
		t.Fatalf("VerifyPaymentRequest(ed25519-ts-signed): %v", err)
	}
	signer := mustEd25519Signer(t, res)
	// Pubkey derived from the all-zero 32-byte seed used by both
	// generators (the RFC 8032 "key A" vector's pubkey).
	const expectedPubHex = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29"
	gotHex := bytesToLowerHex(signer.PublicKey)
	if gotHex != expectedPubHex {
		t.Fatalf("recovered Ed25519PublicKey = %s, want %s", gotHex, expectedPubHex)
	}
	if signer.DIDNetwork != "devnet" {
		t.Errorf("DIDNetwork = %q, want %q", signer.DIDNetwork, "devnet")
	}
	if got := res.Created.UTC().Format(createdLayout); got != fixtureCreated {
		t.Errorf("recovered Created = %s, want %s", got, fixtureCreated)
	}
}

// TestConformance_Ed25519FixturesAreByteIdentical pins the load-bearing
// determinism property of Ed25519Signature2020: the signature is RFC 8032
// deterministic, so the same canonical signing input MUST produce the
// same signature bytes regardless of language. If this fails, either (a)
// the Go and TS canonicalization disagree, (b) the hash-composition order
// disagrees (proofHash || docHash vs the reverse), or (c) one side
// accidentally introduced randomness into the signing path.
//
// Stronger than the verify-each-other tests above: those only require
// *some* valid signature; this requires the exact same bytes.
func TestConformance_Ed25519FixturesAreByteIdentical(t *testing.T) {
	goSigned := readFixture(t, "ed25519-go-signed.json")
	tsSigned := readFixture(t, "ed25519-ts-signed.json")
	if !bytes.Equal(goSigned, tsSigned) {
		t.Fatalf("ed25519 fixtures byte-diverged:\n  go bytes:  %d\n  ts bytes:  %d\n  go (first 200): %s\n  ts (first 200): %s",
			len(goSigned), len(tsSigned),
			prefix(goSigned, 200), prefix(tsSigned, 200))
	}
}

func bytesToLowerHex(b []byte) string {
	const hex = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, c := range b {
		out[i*2] = hex[c>>4]
		out[i*2+1] = hex[c&0x0f]
	}
	return string(out)
}

func prefix(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "..."
}
