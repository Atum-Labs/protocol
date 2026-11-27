package ldverification

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

func jsonUnmarshal(data []byte, v any) error { return json.Unmarshal(data, v) }
func testCtx() context.Context               { return context.Background() }

// Cross-language conformance for the FulfillmentQuote/v1 LD signing
// libraries. The contract these tests pin:
//
//  1. A quote signed by the TS signer (signQuote / signQuoteEd25519)
//     verifies on the Go side with the expected recovered identity.
//  2. The reverse holds — covered by the TS-side conformance.test.ts.
//  3. Ed25519 signatures are deterministic (RFC 8032), so the
//     Go-signed and TS-signed ed25519 fixtures MUST be byte-identical.
//     Drift here means one side's canonicalization, hash construction,
//     or proof-block assembly has diverged.
//
// The fixtures live at schemas/declarations/FulfillmentQuote/v1/conformance/fixtures/
// and are regenerated via the two language-specific generators (see
// schemas/declarations/FulfillmentQuote/v1/conformance/README.md). Drift
// between a generator and its peer fires here; drift between either
// generator and the on-disk fixture also fires here (the regen-then-
// rerun cycle is the canonical way to surface a deliberate change).

// conformanceFixturesDir resolves the fixtures directory relative to
// this test file's package. The conformance/ tree sits four levels up
// from the package — schemas/declarations/FulfillmentQuote/v1/conformance/
// — and the fixtures live under fixtures/.
func conformanceFixturesDir(t *testing.T) string {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("cwd: %v", err)
	}
	// cwd here is the package dir (signing/go). Walk
	// up to the FulfillmentQuote/v1 directory.
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

// fixtureCreated is the proof.created every signed fixture carries
// (conformance/README.md "Pinned inputs"); pinning the recovered value makes
// the contract "same signer AND same created". It's midnight (all-zero below
// the date), so sub-second parsing is covered by
// TestVerify_RecoversFullPrecisionCreated (sign_test.go).
const fixtureCreated = "2026-04-01T00:00:00.000Z"

// createdLayout is the millis-UTC RFC-3339 layout the signers emit (sign.go);
// formatting Result.Created with it reproduces the fixture's created verbatim.
const createdLayout = "2006-01-02T15:04:05.000Z07:00"

// TestConformance_VerifyTSSignedSecp256k1 is the Go ⇐ TS leg of the
// conformance contract for the secp256k1-recovery cryptosuite. A
// failure here means a doc that the TS signer emitted produced bytes
// the Go verifier can't recover — likely a canonicalization
// disagreement, a JWS encoding mismatch, or a v-byte alignment drift.
func TestConformance_VerifyTSSignedSecp256k1(t *testing.T) {
	signed := readFixture(t, "secp256k1-ts-signed.json")
	res, err := Verify(signed)
	if err != nil {
		t.Fatalf("Verify(secp256k1-ts-signed): %v", err)
	}
	signerAddr := mustSecp256k1Signer(t, res)
	// The fixture is signed by Hardhat account #0. We pin the recovered
	// address against the well-known address so a regression that
	// silently recovers a *different* but still well-formed signer
	// (e.g. due to a v-byte flip or an off-by-one in the JWS parse)
	// fires here rather than being lost in a vacuous "signature
	// verified" pass.
	const hardhatAccount0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	if !strings.EqualFold(signerAddr.Hex(), hardhatAccount0) {
		t.Fatalf("recovered SignerAddress = %s, want %s", signerAddr.Hex(), hardhatAccount0)
	}
	if got := res.Created.UTC().Format(createdLayout); got != fixtureCreated {
		t.Errorf("recovered Created = %s, want %s", got, fixtureCreated)
	}
}

// TestConformance_VerifyTSSignedEd25519 is the Go ⇐ TS leg for ed25519.
// Mirror of the secp256k1 test above; the recovered pubkey is checked
// rather than an address because Solana identifiers ARE the pubkey.
func TestConformance_VerifyTSSignedEd25519(t *testing.T) {
	signed := readFixture(t, "ed25519-ts-signed.json")
	res, err := Verify(signed)
	if err != nil {
		t.Fatalf("Verify(ed25519-ts-signed): %v", err)
	}
	signer := mustEd25519Signer(t, res)
	// Pubkey derived from the all-zero 32-byte seed used by both
	// generators. This is the RFC 8032 "key A" vector's pubkey:
	// 3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29 (hex).
	// Pinning it here means a drift in either generator's seed handling
	// (e.g. accidentally using the 64-byte expanded secret as the seed)
	// fires this test loud.
	const expectedPubHex = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29"
	gotHex := bytesToLowerHex(signer.PublicKey)
	if gotHex != expectedPubHex {
		t.Fatalf("recovered Ed25519PublicKey = %s, want %s", gotHex, expectedPubHex)
	}
	if signer.DIDNetwork != "devnet" {
		t.Errorf("DIDNetwork = %q, want %q", signer.DIDNetwork, "devnet")
	}
	if signer.DIDNamespace != "solana" {
		t.Errorf("DIDNamespace = %q, want %q", signer.DIDNamespace, "solana")
	}
	if got := res.Created.UTC().Format(createdLayout); got != fixtureCreated {
		t.Errorf("recovered Created = %s, want %s", got, fixtureCreated)
	}
}

// TestConformance_Ed25519FixturesAreByteIdentical pins the load-bearing
// determinism property of Ed25519Signature2020: the signature is RFC
// 8032 deterministic, so the same canonical signing input MUST produce
// the same signature bytes regardless of language. If this fails,
// either (a) the Go and TS canonicalization disagree, (b) the
// hash-composition order disagrees (proofHash || docHash vs the
// reverse), or (c) one side accidentally introduced randomness into
// the signing path.
//
// Note this is a STRONGER check than the verify-each-other tests above:
// those only require *some* valid signature, while this requires the
// exact same bytes. A regression that left both sides cross-verifiable
// but byte-divergent (rare but possible — e.g. a JSON re-marshal that
// reorders keys differently in one language) would slip past the
// verify-only check but fire here.
func TestConformance_Ed25519FixturesAreByteIdentical(t *testing.T) {
	goSigned := readFixture(t, "ed25519-go-signed.json")
	tsSigned := readFixture(t, "ed25519-ts-signed.json")
	if !bytes.Equal(goSigned, tsSigned) {
		t.Fatalf("ed25519 fixtures byte-diverged:\n  go bytes:  %d\n  ts bytes:  %d\n  go (first 200): %s\n  ts (first 200): %s",
			len(goSigned), len(tsSigned),
			prefix(goSigned, 200), prefix(tsSigned, 200))
	}
}

// TestConformance_QuoteHashMatchesGolden is the Go leg of the
// content-addressed quote_hash parity contract. It asserts ComputeQuoteHash
// reproduces the committed golden value for every signed fixture; the TS
// conformance.test.ts asserts the same golden from its computeQuoteHash. If
// both sides match this one committed file, they match each other — so this
// pins Go↔TS quote_hash parity without a cross-process test.
//
// A drift in either canonicalization or the wrapper's "0x"+hex(SigningInput)
// shaping changes the output and fires here. To intentionally rebaseline,
// regenerate the golden (see conformance/README.md) — the diff is reviewable.
func TestConformance_QuoteHashMatchesGolden(t *testing.T) {
	goldenPath := filepath.Join(conformanceFixturesDir(t), "..", "quote-hash-golden.json")
	raw, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf("read golden %s: %v", goldenPath, err)
	}
	var golden map[string]string
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatalf("parse golden: %v", err)
	}

	for _, name := range []string{
		"secp256k1-go-signed.json", "secp256k1-ts-signed.json",
		"ed25519-go-signed.json", "ed25519-ts-signed.json",
	} {
		want, ok := golden[name]
		if !ok {
			t.Errorf("golden has no entry for %s", name)
			continue
		}
		got, err := ComputeQuoteHash(readFixture(t, name))
		if err != nil {
			t.Fatalf("ComputeQuoteHash(%s): %v", name, err)
		}
		if got != want {
			t.Errorf("quote_hash(%s) = %s, golden = %s", name, got, want)
		}
	}
}

// VP-side conformance — extends the FQ pattern above to the
// FulfillmentQuoteEnvelope shape: signVP on one side, VerifyVP on the
// other, plus the deterministic-ed25519 byte-identity pin.

// vpHappyOpts returns the VerifyVPOptions matching the fixtures' pinned
// challenge / domain / created. Holder is the caller's responsibility
// since it differs between secp256k1 (eip155) and ed25519 (solana).
func vpHappyOpts(t *testing.T, holder string) VerifyVPOptions {
	t.Helper()
	now, err := time.Parse(time.RFC3339, "2026-04-01T00:00:30Z")
	if err != nil {
		t.Fatalf("parse now: %v", err)
	}
	return VerifyVPOptions{
		ExpectedChallenge: "req-fixture-1",
		ExpectedDomain:    "did:web:settler.atum.network",
		ExpectedHolder:    holder,
		Now:               now,
		MaxProofAge:       time.Hour,
		MaxFutureSkew:     time.Hour,
	}
}

// TestConformance_VerifyTSSignedVPSecp256k1 — Go ⇐ TS leg for the
// secp256k1 VP fixture.
func TestConformance_VerifyTSSignedVPSecp256k1(t *testing.T) {
	signed := readFixture(t, "secp256k1-ts-vp.json")
	const holder = "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
	res, err := VerifyVP(signed, vpHappyOpts(t, holder))
	if err != nil {
		t.Fatalf("VerifyVP(secp256k1-ts-vp): %v", err)
	}
	if res.Cryptosuite != ProofTypeSecp256k1Recovery2020 {
		t.Errorf("Cryptosuite = %q, want %q", res.Cryptosuite, ProofTypeSecp256k1Recovery2020)
	}
	if res.Holder != holder {
		t.Errorf("Holder = %q, want %q", res.Holder, holder)
	}
	// Recovered EVM address — Hardhat account #0.
	const expectedAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	if !strings.EqualFold(res.SignerAddress.Hex(), expectedAddr) {
		t.Fatalf("recovered SignerAddress = %s, want %s", res.SignerAddress.Hex(), expectedAddr)
	}
}

// TestConformance_VerifyTSSignedVPEd25519 — Go ⇐ TS leg for the ed25519
// VP fixture. Pubkey + holder are deterministic from the RFC 8032 zero
// seed, so a regression that changed key derivation (or accidentally
// signed against a different envelope) would fire here.
func TestConformance_VerifyTSSignedVPEd25519(t *testing.T) {
	signed := readFixture(t, "ed25519-ts-vp.json")
	// pubBase58 derived from the all-zero 32-byte seed.
	const holder = "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS"
	res, err := VerifyVP(signed, vpHappyOpts(t, holder))
	if err != nil {
		t.Fatalf("VerifyVP(ed25519-ts-vp): %v", err)
	}
	if res.Cryptosuite != ProofTypeEd25519Signature2020 {
		t.Errorf("Cryptosuite = %q, want %q", res.Cryptosuite, ProofTypeEd25519Signature2020)
	}
	const expectedPubHex = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29"
	if got := bytesToLowerHex(res.Ed25519PublicKey); got != expectedPubHex {
		t.Fatalf("Ed25519PublicKey = %s, want %s", got, expectedPubHex)
	}
	if res.DIDNetwork != "solana:devnet" {
		t.Errorf("DIDNetwork = %q, want %q", res.DIDNetwork, "solana:devnet")
	}
}

// TestConformance_Ed25519VPFixturesAreByteIdentical mirrors the
// FQ-side byte-identity pin: the VP envelope's ed25519 signature is
// RFC 8032 deterministic, so the Go-signed and TS-signed VP files MUST
// match byte-for-byte. Drift means the canonicalization, the multi-
// context proof block assembly, or the keepVerifiableCredential strip
// behavior has silently disagreed across languages.
func TestConformance_Ed25519VPFixturesAreByteIdentical(t *testing.T) {
	goSigned := readFixture(t, "ed25519-go-vp.json")
	tsSigned := readFixture(t, "ed25519-ts-vp.json")
	if !bytes.Equal(goSigned, tsSigned) {
		t.Fatalf("ed25519 VP fixtures byte-diverged:\n  go bytes:  %d\n  ts bytes:  %d\n  go (first 200): %s\n  ts (first 200): %s",
			len(goSigned), len(tsSigned),
			prefix(goSigned, 200), prefix(tsSigned, 200))
	}
}

// TestConformance_VPEd25519_WithKnownToAtumVerifiableCredential confirms the
// production-realistic VC shape — type:
// ["VerifiableCredential", "KnownToAtumVerifiableCredential"] with the
// known-to-atum/v1 context URL alongside W3C VC v1 — verifies AND
// produces byte-identical canonical n-quads across json-gold and
// jsonld.js. The conformance fixtures themselves now
// embed this multi-type shape (see cmd/gen-conformance-fixtures/
// pinnedVCsFor + the TS mirror), so the byte-identity assertion in
// TestConformance_Ed25519VPFixturesAreByteIdentical above already
// covers half of it; this test additionally exercises the VerifyVP
// happy path with RequiredVCTypes including the alias to pin that
// the type-policy gate doesn't drop the alias term.
func TestConformance_VPEd25519_WithKnownToAtumVerifiableCredential(t *testing.T) {
	signed := readFixture(t, "ed25519-go-vp.json")
	const holder = "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS"
	opts := vpHappyOpts(t, holder)
	opts.RequiredVCTypes = []string{"VerifiableCredential", "KnownToAtumVerifiableCredential"}
	res, err := VerifyVP(signed, opts)
	if err != nil {
		t.Fatalf("VerifyVP(ed25519-go-vp with RequiredVCTypes incl. KnownToAtumVerifiableCredential): %v", err)
	}
	if res.Cryptosuite != ProofTypeEd25519Signature2020 {
		t.Errorf("Cryptosuite = %q, want %q", res.Cryptosuite, ProofTypeEd25519Signature2020)
	}
}

// Negative VP fixtures: the envelopes above with the credential's
// issuanceDate set to JSON null. Each language signs a pair, and both
// verifiers must refuse all four. The holder signature over each envelope
// is valid, so the refusal comes from the credential check rather than the
// signature: Go answers ErrVPVCMissingIssuanceDate, which VerifyVP reaches
// only after the signature and the signer/holder binding have passed.
var nullIssuanceDateVPFixtures = []struct{ file, holder string }{
	{"secp256k1-go-vp-null-issuance-date.json", "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"},
	{"secp256k1-ts-vp-null-issuance-date.json", "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"},
	{"ed25519-go-vp-null-issuance-date.json", "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS"},
	{"ed25519-ts-vp-null-issuance-date.json", "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS"},
}

// TestConformance_VPNullIssuanceDateRefused: VerifyVP refuses every
// null-issuanceDate fixture, Go-signed and TS-signed.
func TestConformance_VPNullIssuanceDateRefused(t *testing.T) {
	for _, f := range nullIssuanceDateVPFixtures {
		t.Run(f.file, func(t *testing.T) {
			signed := readFixture(t, f.file)

			// The member must be on the wire and null. A generator that
			// dropped it would exercise the absent case, which the binding
			// refuses while decoding with a different error. Checking the
			// wire first makes that failure say what went wrong.
			var env struct {
				VerifiableCredential []map[string]json.RawMessage `json:"verifiableCredential"`
			}
			if err := json.Unmarshal(signed, &env); err != nil {
				t.Fatalf("parse %s: %v", f.file, err)
			}
			if len(env.VerifiableCredential) != 1 {
				t.Fatalf("%s carries %d credentials, want 1", f.file, len(env.VerifiableCredential))
			}
			raw, ok := env.VerifiableCredential[0]["issuanceDate"]
			if !ok || string(raw) != "null" {
				t.Fatalf("%s: verifiableCredential[0].issuanceDate = %q (present=%v), want null", f.file, raw, ok)
			}

			_, err := VerifyVP(signed, vpHappyOpts(t, f.holder))
			if err == nil {
				t.Fatalf("VerifyVP(%s) accepted a credential whose issuanceDate is null", f.file)
			}
			if !errors.Is(err, ErrVPVCMissingIssuanceDate) {
				t.Fatalf("VerifyVP(%s): expected ErrVPVCMissingIssuanceDate, got %v", f.file, err)
			}
		})
	}
}

// TestConformance_Ed25519NullIssuanceDateVPFixturesAreByteIdentical: the
// negative ed25519 pair is RFC 8032 deterministic like the others, so the
// two signers must also agree on the canonical form of a null member.
func TestConformance_Ed25519NullIssuanceDateVPFixturesAreByteIdentical(t *testing.T) {
	goSigned := readFixture(t, "ed25519-go-vp-null-issuance-date.json")
	tsSigned := readFixture(t, "ed25519-ts-vp-null-issuance-date.json")
	if !bytes.Equal(goSigned, tsSigned) {
		t.Fatalf("ed25519 null-issuanceDate VP fixtures byte-diverged:\n  go bytes:  %d\n  ts bytes:  %d\n  go (first 200): %s\n  ts (first 200): %s",
			len(goSigned), len(tsSigned),
			prefix(goSigned, 200), prefix(tsSigned, 200))
	}
}

// PRE-side conformance — the declarationType-set path. These
// fixtures are PaymentRequestEnvelopes: the same VP shape as above but signed
// under the PRE declaration @context with type
// ["VerifiablePresentation","PaymentRequestEnvelope"]. They exercise the
// envelope-context-overlay seam (signVP.EnvelopeContextURL +
// ExtraEnvelopeContexts) and the declaration-type binding
// (VerifyVPOptions.ExpectedDeclarationType, covered by the signature via the
// rdf:type n-quad) end-to-end across languages.

// preConformanceContext loads the canonical PaymentRequestEnvelope context for
// the verifier's ExtraEnvelopeContexts overlay — the strict no-network loader
// can't resolve the PRE URL otherwise. Path mirrors the generator's
// loadPREContext: fixtures → … → declarations → PaymentRequestEnvelope.
func preConformanceContext(t *testing.T) map[string]any {
	t.Helper()
	path := filepath.Join(conformanceFixturesDir(t), "..", "..", "..", "..", "PaymentRequestEnvelope", "v1", "context.jsonld")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read PRE context %s: %v", path, err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("parse PRE context: %v", err)
	}
	return parsed
}

// vpHappyOptsPRE extends vpHappyOpts with the declarationType-set verify seam:
// ExpectedDeclarationType pins the PaymentRequestEnvelope type binding, and
// ExtraEnvelopeContexts overlays the PRE context so the loader resolves the
// envelope's declaration @context during canonicalization.
func vpHappyOptsPRE(t *testing.T, holder string) VerifyVPOptions {
	t.Helper()
	opts := vpHappyOpts(t, holder)
	opts.ExpectedDeclarationType = "PaymentRequestEnvelope"
	opts.ExtraEnvelopeContexts = map[string]any{
		"https://schemas.atum.network/declarations/PaymentRequestEnvelope/v1/context.jsonld": preConformanceContext(t),
	}
	return opts
}

// TestConformance_VerifyTSSignedPREVPSecp256k1 — Go ⇐ TS leg for the secp256k1
// PaymentRequestEnvelope fixture. Proves a PRE minted by the TS signer (via
// the envelope-context-overlay seam) verifies on the Go side with the
// declaration-type binding enforced.
func TestConformance_VerifyTSSignedPREVPSecp256k1(t *testing.T) {
	signed := readFixture(t, "secp256k1-ts-pre-vp.json")
	const holder = "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
	res, err := VerifyVP(signed, vpHappyOptsPRE(t, holder))
	if err != nil {
		t.Fatalf("VerifyVP(secp256k1-ts-pre-vp): %v", err)
	}
	if res.Cryptosuite != ProofTypeSecp256k1Recovery2020 {
		t.Errorf("Cryptosuite = %q, want %q", res.Cryptosuite, ProofTypeSecp256k1Recovery2020)
	}
	const expectedAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	if !strings.EqualFold(res.SignerAddress.Hex(), expectedAddr) {
		t.Fatalf("recovered SignerAddress = %s, want %s", res.SignerAddress.Hex(), expectedAddr)
	}
}

// TestConformance_VerifyTSSignedTypedPREVPSecp256k1 — Go ⇐ TS leg for the typed holder proof a
// payer's wallet signs: the TS signer took an EIP-712 signature over
// PaymentRequestEnvelopeProof{proofHash, docHash} from ethers' Wallet.signTypedData. A verifier
// that accepts that form recovers Hardhat #0; one that doesn't refuses it.
func TestConformance_VerifyTSSignedTypedPREVPSecp256k1(t *testing.T) {
	signed := readFixture(t, "secp256k1-typed-ts-pre-vp.json")
	const holder = "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
	opts := vpHappyOptsPRE(t, holder)
	opts.AcceptPaymentRequestEnvelopeTypedProof = true
	res, err := VerifyVP(signed, opts)
	if err != nil {
		t.Fatalf("VerifyVP(secp256k1-typed-ts-pre-vp): %v", err)
	}
	const expectedAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	if !strings.EqualFold(res.SignerAddress.Hex(), expectedAddr) {
		t.Fatalf("recovered SignerAddress = %s, want %s", res.SignerAddress.Hex(), expectedAddr)
	}
	if _, err := VerifyVP(signed, vpHappyOptsPRE(t, holder)); !errors.Is(err, ErrVPSignerHolderMismatch) {
		t.Fatalf("VerifyVP without the typed form = %v, want ErrVPSignerHolderMismatch", err)
	}
}

// TestConformance_VerifyTSSignedPREVPEd25519 — Go ⇐ TS leg for the ed25519 PRE
// fixture.
func TestConformance_VerifyTSSignedPREVPEd25519(t *testing.T) {
	signed := readFixture(t, "ed25519-ts-pre-vp.json")
	const holder = "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS"
	res, err := VerifyVP(signed, vpHappyOptsPRE(t, holder))
	if err != nil {
		t.Fatalf("VerifyVP(ed25519-ts-pre-vp): %v", err)
	}
	if res.Cryptosuite != ProofTypeEd25519Signature2020 {
		t.Errorf("Cryptosuite = %q, want %q", res.Cryptosuite, ProofTypeEd25519Signature2020)
	}
	const expectedPubHex = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29"
	if got := bytesToLowerHex(res.Ed25519PublicKey); got != expectedPubHex {
		t.Fatalf("Ed25519PublicKey = %s, want %s", got, expectedPubHex)
	}
}

// TestConformance_VerifyPREDeclarationTypeRequired pins the security property
// the PRE seam exists for: a PaymentRequestEnvelope MUST be rejected when the
// verifier expects a DIFFERENT declaration type. Without the rdf:type n-quad
// being covered by the signature, a relabeled envelope would slip through; the
// mismatch must surface as ErrVPDeclarationTypeMismatch (not a generic crypto
// failure — the signature itself is valid).
func TestConformance_VerifyPREDeclarationTypeRequired(t *testing.T) {
	signed := readFixture(t, "secp256k1-go-pre-vp.json")
	const holder = "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"

	// First prove the SAME fixture verifies cleanly (signature + every binding)
	// under the CORRECT declaration type. Without this, the rejection below
	// could be a false positive — the declaration-type gate runs before crypto
	// dispatch, so a corrupt/tampered fixture would "reject" for the wrong
	// reason. Pinning the positive case makes the type mismatch the sole
	// differentiator between accept and reject.
	if _, err := VerifyVP(signed, vpHappyOptsPRE(t, holder)); err != nil {
		t.Fatalf("VerifyVP(secp256k1-go-pre-vp) under correct type: %v", err)
	}

	// Now flip ONLY the expected type — the same otherwise-valid fixture must be
	// rejected with the declaration-type sentinel (relabel protection).
	opts := vpHappyOptsPRE(t, holder)
	opts.ExpectedDeclarationType = "FulfillmentQuoteEnvelope" // wrong kind
	_, err := VerifyVP(signed, opts)
	if err == nil {
		t.Fatal("expected VerifyVP to reject a PRE under the wrong ExpectedDeclarationType, got nil")
	}
	if !errors.Is(err, ErrVPDeclarationTypeMismatch) {
		t.Fatalf("expected ErrVPDeclarationTypeMismatch, got %v", err)
	}
}

// TestConformance_Ed25519PREVPFixturesAreByteIdentical mirrors the FQE-side
// byte-identity pin for the declarationType-set path: the PRE envelope's
// ed25519 signature is RFC 8032 deterministic, so the Go-signed and TS-signed
// PRE files MUST match byte-for-byte. This is the strongest cross-language
// proof that the seam (declaration @context overlay + the PaymentRequestEnvelope
// rdf:type n-quad) canonicalizes identically under json-gold and jsonld.js.
func TestConformance_Ed25519PREVPFixturesAreByteIdentical(t *testing.T) {
	goSigned := readFixture(t, "ed25519-go-pre-vp.json")
	tsSigned := readFixture(t, "ed25519-ts-pre-vp.json")
	if !bytes.Equal(goSigned, tsSigned) {
		t.Fatalf("ed25519 PRE VP fixtures byte-diverged:\n  go bytes:  %d\n  ts bytes:  %d\n  go (first 200): %s\n  ts (first 200): %s",
			len(goSigned), len(tsSigned),
			prefix(goSigned, 200), prefix(tsSigned, 200))
	}
}

// declContextMap loads a declaration context.jsonld and returns its top-level
// `@context` term map.
func declContextMap(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var doc struct {
		Context map[string]any `json:"@context"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if doc.Context == nil {
		t.Fatalf("%s has no @context object", path)
	}
	return doc.Context
}

// TestConformance_PREAndFQEProofTermsAgree pins the invariant the verifier's
// hardcoded proof @context silently relies on. VerifyVP reconstructs the proof
// block's @context as the FulfillmentQuoteEnvelope URL regardless of the
// envelope kind (verify_vp.go vpProofContext) — and VerifyVPOptions has no
// EnvelopeContextURL knob for the proof block. That is safe ONLY because the
// PaymentRequestEnvelope and FulfillmentQuoteEnvelope declaration contexts
// define every proof-block term IDENTICALLY: a PRE proof verified under the FQE
// context must canonicalize to the same n-quads it was signed under. If a
// future context revision redefined a proof term (challenge / domain / created /
// …) for one envelope kind only, a valid PRE proof would start failing (or a
// tampered one start passing). This test fails the moment that divergence is
// introduced — turning the parity comment into an enforced contract.
func TestConformance_PREAndFQEProofTermsAgree(t *testing.T) {
	fixturesDir := conformanceFixturesDir(t)
	fqe := declContextMap(t, filepath.Join(fixturesDir, "..", "..", "..", "..", "FulfillmentQuoteEnvelope", "v1", "context.jsonld"))
	pre := declContextMap(t, filepath.Join(fixturesDir, "..", "..", "..", "..", "PaymentRequestEnvelope", "v1", "context.jsonld"))

	// The proof block's signed fields (proof options + signature term). Terms
	// the envelope context doesn't define are absent in BOTH (defined by the
	// cryptosuite/W3C contexts instead) — that's fine; the check only fires on a
	// presence or definition mismatch BETWEEN the two declaration contexts.
	proofTerms := []string{
		"type", "created", "verificationMethod", "proofPurpose",
		"challenge", "domain", "jws", "proofValue", "proof",
	}
	for _, term := range proofTerms {
		f, fok := fqe[term]
		p, pok := pre[term]
		if fok != pok {
			t.Errorf("proof term %q presence differs across declaration contexts: FQE=%v PRE=%v", term, fok, pok)
			continue
		}
		if fok && !reflect.DeepEqual(f, p) {
			t.Errorf("proof term %q definition differs across declaration contexts:\n  FQE: %#v\n  PRE: %#v", term, f, p)
		}
	}
}

// VC-proof side conformance. Extends the FQ/VP pattern to
// bare signed VerifiableCredentials — the unit verifyVCProof and
// VerifyVCProof gate against directly. The contract is:
//
//  1. A VC the TS signer emitted verifies under VerifyVCProof, using
//     the JWK sidecar (vc-issuer-{secp256k1,ed25519}.jwk.json) as the
//     mock resolver's published key set.
//  2. The reverse holds — covered by conformance.test.ts.
//  3. Ed25519 VC-proof fixtures MUST be byte-identical across languages
//     (RFC 8032 deterministic).
//
// The JWK sidecars are emitted only by the Go generator — both
// languages pin the same keys, so re-emitting from TS would only
// invite drift.

// jwkSidecarResolver loads the issuer JWK from the conformance fixture
// directory and returns a resolver that advertises it for the pinned
// issuer DID. Mirrors the structure mockResolver uses in
// verify_vc_test.go but reads the file rather than minting in-place.
func jwkSidecarResolver(t *testing.T, sidecarFile string) IssuerKeyResolver {
	t.Helper()
	body := readFixture(t, sidecarFile)
	var parsed struct {
		Comment string `json:"$comment"`
		VMSet   []struct {
			ID           string                 `json:"id"`
			Type         string                 `json:"type"`
			PublicKeyJWK map[string]interface{} `json:"publicKeyJwk"`
		} `json:"vmSet"`
	}
	if err := jsonUnmarshal(body, &parsed); err != nil {
		t.Fatalf("unmarshal %s: %v", sidecarFile, err)
	}
	vmSet := make(VerificationMethodSet, len(parsed.VMSet))
	for i, entry := range parsed.VMSet {
		vmSet[i] = VerificationMethod{
			ID:           entry.ID,
			Type:         entry.Type,
			PublicKeyJWK: entry.PublicKeyJWK,
		}
	}
	return &mockResolver{
		issuerDID: "did:web:atumlabs.xyz",
		vmSet:     vmSet,
	}
}

// TestConformance_VerifyTSSignedVCProofSecp256k1 proves the
// secp256k1 cryptographic plumbing composes correctly cross-
// language (TS-side signer → Go-side verifier). Two assertions:
//
//  1. VerifyVCProof returns nil — the signature is mathematically
//     valid against the issuer's published JWK.
//  2. The canonical n-quads contain the load-bearing predicates
//     the verifier counts on (W3C VC v1's credentialSubject,
//     issuer, issuanceDate; the KnownToAtumVerifiableCredential
//     rdf:type; the kta:role term that the production issuer emits
//     for the settler / psp / atumOperatedService claim). A
//     regression that silently dropped any of those from the
//     signing input fires here.
//
// SCOPE NOTE: the helper's predicate list now includes the
// atum-specific bindings —
// `kta:KnownToAtumVerifiableCredential` (the @type alias retired
// here for cross-language byte-identity) and `kta:role` (the
// production-emitted claim field on credentialSubject). The
// previous fixture-only placeholder `knownToAtum: true` is gone;
// the fixture matches what the production issuer actually emits.
//
// What this DOES NOT cover: claim fields a future producer might
// add under @contexts that don't bind them — that's the
// architectural gap the SECURITY NOTE on VerifyVCProof carves out.
// A defensive `knownToAtum` binding is also added to the
// known-to-atum context (see TestKnownToAtumFieldBinding below)
// so the canonical example flagged in review is closed for any
// future producer that does emit the field.
func TestConformance_VerifyTSSignedVCProofSecp256k1(t *testing.T) {
	raw := readFixture(t, "secp256k1-ts-vc-proof.json")
	resolver := jwkSidecarResolver(t, "vc-issuer-secp256k1.jwk.json")
	vc := mustUnmarshalVC(t, raw)
	if err := VerifyVCProof(vc, raw, resolver, VerifyVCProofOptions{Context: testCtx()}); err != nil {
		t.Fatalf("VerifyVCProof(secp256k1-ts-vc-proof): %v", err)
	}
	assertVCNquadsBindLoadBearingTerms(t, raw, "secp256k1-ts-vc-proof")
}

// TestConformance_VerifyTSSignedVCProofEd25519 mirrors
// TestConformance_VerifyTSSignedVCProofSecp256k1 for the ed25519
// path. Same predicate-presence guarantees apply.
func TestConformance_VerifyTSSignedVCProofEd25519(t *testing.T) {
	raw := readFixture(t, "ed25519-ts-vc-proof.json")
	resolver := jwkSidecarResolver(t, "vc-issuer-ed25519.jwk.json")
	vc := mustUnmarshalVC(t, raw)
	if err := VerifyVCProof(vc, raw, resolver, VerifyVCProofOptions{Context: testCtx()}); err != nil {
		t.Fatalf("VerifyVCProof(ed25519-ts-vc-proof): %v", err)
	}
	assertVCNquadsBindLoadBearingTerms(t, raw, "ed25519-ts-vc-proof")
}

// assertVCNquadsBindLoadBearingTerms canonicalizes a VC body
// (proof stripped) via the exported Canonicalize and asserts that
// the W3C VC v1 + atum-specific bound predicates the verifier
// counts on appear in the resulting n-quads. Surfaces the
// canonical output via t.Logf on success so a reader sees what's
// actually in the signed bytes without needing to re-canonicalize.
//
// Adds the orthogonal property
// "the load-bearing predicates were in the signed bytes" on top
// of the existing "the signature verifies" assertion. A
// regression that silently dropped one of them — an @context
// loader change that stopped resolving a registered context, a
// future IRI rename, a fixture mutation that elided a claim
// field — would fail here even while the signature mathematically
// still recovered.
//
// The predicate list extends beyond W3C VC v1 to the
// atum-specific bindings:
//   - kta:KnownToAtumVerifiableCredential (the @type alias —
//     cross-language byte-identity guarantee for the multi-type
//     form).
//   - kta:role (the production-emitted claim field).
//
// The known-to-atum context also defensively binds `knownToAtum`
// (xsd:boolean) — exercised separately by TestKnownToAtumFieldBinding
// so the conformance fixtures stay shaped like real production
// credentials (which don't emit that field today).
func assertVCNquadsBindLoadBearingTerms(t *testing.T, rawVC []byte, fixtureLabel string) {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(rawVC, &doc); err != nil {
		t.Fatalf("%s: unmarshal VC for canonicalization check: %v", fixtureLabel, err)
	}
	delete(doc, "proof")
	nquads, err := Canonicalize(doc)
	if err != nil {
		t.Fatalf("%s: Canonicalize VC body: %v", fixtureLabel, err)
	}
	t.Logf("%s canonical n-quads (proof stripped):\n%s", fixtureLabel, nquads)
	requiredPredicates := []string{
		// W3C VC v1 — load-bearing for ANY VC's identity.
		"<https://www.w3.org/2018/credentials#credentialSubject>",
		"<https://www.w3.org/2018/credentials#issuer>",
		"<https://www.w3.org/2018/credentials#issuanceDate>",
		// Atum-specific bindings the issuer emits.
		// rdf:type predicate carrying the KnownToAtumVerifiableCredential
		// alias (the @type bound for cross-language byte-identity).
		"<https://schemas.atum.xyz/credentials/known-to-atum/v1#KnownToAtumVerifiableCredential>",
		// The role claim — what production VCs actually carry on
		// credentialSubject.
		"<https://schemas.atum.xyz/credentials/known-to-atum/v1#role>",
	}
	for _, p := range requiredPredicates {
		if !strings.Contains(nquads, p) {
			t.Errorf("%s canonical n-quads missing required predicate %s — claim is in JSON but not in signed bytes:\n%s",
				fixtureLabel, p, nquads)
		}
	}
}

// TestKnownToAtumFieldBinding pins the defensive binding for the
// `knownToAtum` boolean field on the known-to-atum v1 context.
//
// Background: review originally flagged that a fixture-only
// placeholder `credentialSubject.knownToAtum: true` was being
// silently dropped during URDNA2015 expansion (the W3C VC v1
// context didn't bind the term; neither did the earlier
// known-to-atum context). The primary scope of that work was the
// @type alias divergence — production credentials don't emit
// `knownToAtum` today, the
// fixture was updated to match (now carries `role: "settler"`,
// not `knownToAtum: true`). But the architectural lesson stands:
// any claim field the issuer emits MUST be bound in an
// in-scope @context or the signature won't cover it.
//
// This test exercises the defensive `knownToAtum` binding on the
// known-to-atum context with a synthetic VC body — not a
// production-realistic shape today, but future-proof against an
// issuer code change that DOES start emitting the field. Asserts:
//
//  1. Canonicalization succeeds (the binding is well-formed JSON-LD
//     under @protected).
//  2. The canonical n-quads contain the `kta:knownToAtum` predicate
//     with the boolean object — proves the field would be
//     cryptographically attested if a producer emitted it.
//
// Distinct from the conformance fixture tests above: those
// guard production reality; this guards the binding itself. Both
// matter because the binding is invisible to a regression test that
// only checks production-shaped fixtures.
func TestKnownToAtumFieldBinding(t *testing.T) {
	doc := map[string]any{
		"@context": []any{
			w3cVCV1ContextURL,
			lddataintegrity.KnownToAtumV1ContextURL,
		},
		"id":           "urn:uuid:vc-knowntoatum-binding-test",
		"type":         []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
		"issuer":       "did:web:atumlabs.xyz",
		"issuanceDate": "2026-01-01T00:00:00Z",
		"credentialSubject": map[string]any{
			"id":          "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
			"knownToAtum": true,
		},
	}
	nquads, err := Canonicalize(doc)
	if err != nil {
		t.Fatalf("Canonicalize synthetic knownToAtum VC: %v", err)
	}
	t.Logf("synthetic knownToAtum VC canonical n-quads:\n%s", nquads)
	wantPredicate := "<https://schemas.atum.xyz/credentials/known-to-atum/v1#knownToAtum>"
	if !strings.Contains(nquads, wantPredicate) {
		t.Errorf("canonical n-quads missing kta:knownToAtum predicate — the defensive binding isn't taking effect, future producers that emit this field would have it silently dropped:\n%s", nquads)
	}
	// Also assert the boolean object — confirms @type: xsd:boolean
	// in the binding actually types the value correctly. Without
	// this, the field could bind but with the wrong type, which
	// would still drop or mis-canonicalize.
	wantBooleanType := `"true"^^<http://www.w3.org/2001/XMLSchema#boolean>`
	if !strings.Contains(nquads, wantBooleanType) {
		t.Errorf("canonical n-quads missing the xsd:boolean object for knownToAtum — the binding's @type isn't taking effect:\n%s", nquads)
	}
}

// TestConformance_Ed25519VCProofFixturesAreByteIdentical: the ed25519
// VC-proof fixture MUST byte-match across languages (RFC 8032
// determinism). Drift means the VC body construction, the
// canonicalization, the proof template assembly, or the proofValue
// encoding has silently diverged.
func TestConformance_Ed25519VCProofFixturesAreByteIdentical(t *testing.T) {
	goSigned := readFixture(t, "ed25519-go-vc-proof.json")
	tsSigned := readFixture(t, "ed25519-ts-vc-proof.json")
	if !bytes.Equal(goSigned, tsSigned) {
		t.Fatalf("ed25519 VC-proof fixtures byte-diverged:\n  go bytes:  %d\n  ts bytes:  %d\n  go (first 200): %s\n  ts (first 200): %s",
			len(goSigned), len(tsSigned),
			prefix(goSigned, 200), prefix(tsSigned, 200))
	}
}

// Known-to-atum v2 credentials. v2 adds the quoteAwarder and merchant
// roles, which v1 does not define; under v1 a credential's signature does
// not cover either role. Each fixture is a credential the issuer would emit
// under v2, signed in TS and verified here (the TS suite verifies the Go
// halves). Beyond verifying, each case checks that the role is in the signed
// bytes: changing the role, or naming the v1 context instead, must break the
// signature.
var knownToAtumV2Conformance = []struct {
	name    string
	role    string
	relabel string
}{
	{name: "kta-v2-quote-awarder", role: "quoteAwarder", relabel: "merchant"},
	{name: "kta-v2-merchant", role: "merchant", relabel: "quoteAwarder"},
}

var knownToAtumV2Suites = []struct {
	suite   string
	sidecar string
}{
	{suite: "secp256k1", sidecar: "vc-issuer-secp256k1.jwk.json"},
	{suite: "ed25519", sidecar: "vc-issuer-ed25519.jwk.json"},
}

func TestConformance_VerifyTSSignedKnownToAtumV2VCProofs(t *testing.T) {
	for _, c := range knownToAtumV2Conformance {
		for _, s := range knownToAtumV2Suites {
			fixture := s.suite + "-ts-vc-proof-" + c.name + ".json"
			t.Run(fixture, func(t *testing.T) {
				raw := readFixture(t, fixture)
				resolver := jwkSidecarResolver(t, s.sidecar)
				if err := VerifyVCProof(mustUnmarshalVC(t, raw), raw, resolver, VerifyVCProofOptions{Context: testCtx()}); err != nil {
					t.Fatalf("VerifyVCProof(%s): %v", fixture, err)
				}

				var doc map[string]any
				if err := json.Unmarshal(raw, &doc); err != nil {
					t.Fatalf("unmarshal %s: %v", fixture, err)
				}
				if got := doc["credentialSubject"].(map[string]any)["role"]; got != c.role {
					t.Fatalf("%s carries role %v, want %s", fixture, got, c.role)
				}
				assertVCNquadsBindLoadBearingTerms(t, raw, fixture)
				body := cloneJSONMap(t, doc)
				delete(body, "proof")
				nquads, err := Canonicalize(body)
				if err != nil {
					t.Fatalf("Canonicalize %s: %v", fixture, err)
				}
				const kta = "https://schemas.atum.xyz/credentials/known-to-atum/v1#"
				if want := "<" + kta + "role> <" + kta + c.role + "> "; !strings.Contains(nquads, want) {
					t.Errorf("%s: the signed N-Quads lack the %s role:\n%s", fixture, c.role, nquads)
				}

				relabeled := cloneJSONMap(t, doc)
				relabeled["credentialSubject"].(map[string]any)["role"] = c.relabel
				wantSignatureInvalid(t, "role "+c.relabel, relabeled, resolver)

				underV1 := cloneJSONMap(t, doc)
				underV1["@context"] = []any{w3cVCV1ContextURL, lddataintegrity.KnownToAtumV1ContextURL}
				wantSignatureInvalid(t, "the v1 context", underV1, resolver)
			})
		}
	}
}

// TestConformance_Ed25519KnownToAtumV2VCProofFixturesAreByteIdentical pins
// RFC 8032 determinism on the v2 credentials: drift means the two languages
// canonicalize the v2 context differently.
func TestConformance_Ed25519KnownToAtumV2VCProofFixturesAreByteIdentical(t *testing.T) {
	for _, c := range knownToAtumV2Conformance {
		goSigned := readFixture(t, "ed25519-go-vc-proof-"+c.name+".json")
		tsSigned := readFixture(t, "ed25519-ts-vc-proof-"+c.name+".json")
		if !bytes.Equal(goSigned, tsSigned) {
			t.Errorf("%s ed25519 VC-proof fixtures byte-diverged:\n  go (first 200): %s\n  ts (first 200): %s",
				c.name, prefix(goSigned, 200), prefix(tsSigned, 200))
		}
	}
}

// wantSignatureInvalid verifies a changed copy of a signed credential and
// requires the signature check to refuse it.
func wantSignatureInvalid(t *testing.T, change string, doc map[string]any, resolver IssuerKeyResolver) {
	t.Helper()
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal the credential with %s: %v", change, err)
	}
	err = VerifyVCProof(mustUnmarshalVC(t, raw), raw, resolver, VerifyVCProofOptions{Context: testCtx()})
	if !errors.Is(err, ErrVPVCSignatureInvalid) {
		t.Errorf("VerifyVCProof with %s = %v, want ErrVPVCSignatureInvalid: the signature must cover it", change, err)
	}
}

// cloneJSONMap deep-copies a decoded JSON object.
func cloneJSONMap(t *testing.T, m map[string]any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
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

// passThroughVPFixtures carry the pinned Known-to-Atum credential followed
// by a third-party credential from an unlisted issuer that fails every
// per-VC check (expired, another account's subject, unresolvable issuer).
var passThroughVPFixtures = []struct{ file, holder string }{
	{"secp256k1-go-vp-pass-through.json", "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"},
	{"secp256k1-ts-vp-pass-through.json", "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"},
	{"ed25519-go-vp-pass-through.json", "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS"},
	{"ed25519-ts-vp-pass-through.json", "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS"},
}

// TestConformance_VPPassThroughThirdPartyCredential: with Known-to-Atum
// required (so reserved) and issuer trust strict on the pinned issuer,
// every pass-through fixture, Go-signed and TS-signed, verifies; the
// third-party credential comes back byte-identical in PassThroughClaims.
// With no reserved set the same envelope is refused, as before the option.
// The TS conformance suite asserts the same verdicts.
func TestConformance_VPPassThroughThirdPartyCredential(t *testing.T) {
	for _, f := range passThroughVPFixtures {
		t.Run(f.file, func(t *testing.T) {
			signed := readFixture(t, f.file)
			var env struct {
				VerifiableCredential []json.RawMessage `json:"verifiableCredential"`
			}
			if err := json.Unmarshal(signed, &env); err != nil {
				t.Fatalf("parse %s: %v", f.file, err)
			}
			if len(env.VerifiableCredential) != 2 {
				t.Fatalf("%s carries %d credentials, want 2", f.file, len(env.VerifiableCredential))
			}

			opts := vpHappyOpts(t, f.holder)
			opts.RequiredVCTypes = []string{"KnownToAtumVerifiableCredential"}
			opts.IsIssuerTrusted = func(d string) (bool, bool) { return d == "did:web:atumlabs.xyz", true }
			res, err := VerifyVP(signed, opts)
			if err != nil {
				t.Fatalf("VerifyVP(%s) refused an unreserved third-party credential: %v", f.file, err)
			}
			if len(res.AttestedClaims) != 1 || !bytes.Equal(res.AttestedClaims[0], env.VerifiableCredential[0]) {
				t.Fatalf("%s: AttestedClaims = %d entries, want exactly the Known-to-Atum credential", f.file, len(res.AttestedClaims))
			}
			if len(res.PassThroughClaims) != 1 || !bytes.Equal(res.PassThroughClaims[0], env.VerifiableCredential[1]) {
				t.Fatalf("%s: PassThroughClaims = %d entries, want the third-party credential byte-identical", f.file, len(res.PassThroughClaims))
			}

			opts.RequiredVCTypes = nil
			if _, err := VerifyVP(signed, opts); err == nil {
				t.Fatalf("VerifyVP(%s) accepted the third-party credential with no reserved set", f.file)
			}
		})
	}
}

// TestConformance_Ed25519PassThroughVPFixturesAreByteIdentical: the
// pass-through pair is RFC 8032 deterministic like the others.
func TestConformance_Ed25519PassThroughVPFixturesAreByteIdentical(t *testing.T) {
	goSigned := readFixture(t, "ed25519-go-vp-pass-through.json")
	tsSigned := readFixture(t, "ed25519-ts-vp-pass-through.json")
	if !bytes.Equal(goSigned, tsSigned) {
		t.Fatalf("ed25519 pass-through VP fixtures differ between Go and TS signers")
	}
}

// reservedSpellingVPFixtures carry the pinned Known-to-Atum credential
// followed by a credential from an issuer on no trust list whose type is the
// reserved type in another JSON-LD spelling, or a short name no context
// defines. Its subject is the holder and its dates are valid.
var reservedSpellingVPFixtures = []string{"iri", "compact", "compact-no-context", "undefined"}

// TestConformance_VPReservedTypeSpellingsAreChecked: with Known-to-Atum
// required and issuer trust strict on the pinned issuer, every
// reserved-spelling fixture, Go-signed and TS-signed, is refused on the
// spelled credential's issuer; trusting that issuer too makes it verify
// with both credentials checked. So the spelled credential was checked, not
// passed through. The TS conformance suite asserts the same verdicts.
//
// A short name no context defines canonicalizes differently in json-gold
// and jsonld.js, so the other language's "undefined" fixture never verifies
// here: its holder signature fails. It is refused either way and never
// passed through, which is what this asserts for that one.
func TestConformance_VPReservedTypeSpellingsAreChecked(t *testing.T) {
	const holder = "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
	for _, spelling := range reservedSpellingVPFixtures {
		for _, signer := range []string{"go", "ts"} {
			file := "secp256k1-" + signer + "-vp-reserved-" + spelling + ".json"
			t.Run(file, func(t *testing.T) {
				signed := readFixture(t, file)
				opts := vpHappyOpts(t, holder)
				opts.RequiredVCTypes = []string{"KnownToAtumVerifiableCredential"}
				if spelling == "undefined" && signer == "ts" {
					opts.IsIssuerTrusted = func(string) (bool, bool) { return true, true }
					if _, err := VerifyVP(signed, opts); !errors.Is(err, ErrVPSignerHolderMismatch) {
						t.Fatalf("VerifyVP(%s): want the cross-language holder-signature refusal, got %v", file, err)
					}
					return
				}
				opts.IsIssuerTrusted = func(d string) (bool, bool) { return d == "did:web:atumlabs.xyz", true }
				_, err := VerifyVP(signed, opts)
				if !errors.Is(err, ErrVPIssuerNotTrusted) || !strings.Contains(err.Error(), "verifiableCredential[1]") {
					t.Fatalf("VerifyVP(%s): want ErrVPIssuerNotTrusted on verifiableCredential[1], got %v", file, err)
				}

				opts.IsIssuerTrusted = func(d string) (bool, bool) {
					return d == "did:web:atumlabs.xyz" || d == "did:web:impersonator.example", true
				}
				res, err := VerifyVP(signed, opts)
				if err != nil {
					t.Fatalf("VerifyVP(%s) with both issuers trusted: %v", file, err)
				}
				if len(res.AttestedClaims) != 2 || len(res.PassThroughClaims) != 0 {
					t.Fatalf("%s: %d attested and %d passed through, want both checked", file, len(res.AttestedClaims), len(res.PassThroughClaims))
				}
			})
		}
	}
}

// partnerContext reads a partner context document the conformance fixtures
// were canonicalized with and returns it as ExtraCredentialContexts.
func partnerContexts(t *testing.T, url, file string) map[string]any {
	t.Helper()
	var ctx any
	if err := json.Unmarshal(readFixture(t, file), &ctx); err != nil {
		t.Fatalf("parse %s: %v", file, err)
	}
	return map[string]any{url: ctx}
}

// TestConformance_VPPartnerContextCredentialPassesThrough: a partner
// credential under its own context, from an unlisted issuer, expired and
// about another account, passes through, byte-identical, when the verifier
// is given that context; without it the presentation is refused, since the
// loader never fetches a context. Go-signed and TS-signed alike; the TS
// conformance suite asserts the same verdicts.
func TestConformance_VPPartnerContextCredentialPassesThrough(t *testing.T) {
	const holder = "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
	contexts := partnerContexts(t, "https://partner.example/credentials/v1", "partner-credentials-v1-context.jsonld")
	for _, signer := range []string{"go", "ts"} {
		file := "secp256k1-" + signer + "-vp-partner-context.json"
		t.Run(file, func(t *testing.T) {
			signed := readFixture(t, file)
			var env struct {
				VerifiableCredential []json.RawMessage `json:"verifiableCredential"`
			}
			if err := json.Unmarshal(signed, &env); err != nil || len(env.VerifiableCredential) != 2 {
				t.Fatalf("parse %s: %v (%d credentials)", file, err, len(env.VerifiableCredential))
			}
			opts := vpHappyOpts(t, holder)
			opts.RequiredVCTypes = []string{"KnownToAtumVerifiableCredential"}
			opts.IsIssuerTrusted = func(d string) (bool, bool) { return d == "did:web:atumlabs.xyz", true }
			opts.ExtraCredentialContexts = contexts
			res, err := VerifyVP(signed, opts)
			if err != nil {
				t.Fatalf("VerifyVP(%s) with the partner context: %v", file, err)
			}
			if len(res.AttestedClaims) != 1 || !bytes.Equal(res.AttestedClaims[0], env.VerifiableCredential[0]) {
				t.Fatalf("%s: AttestedClaims = %d entries, want exactly the Known-to-Atum credential", file, len(res.AttestedClaims))
			}
			if len(res.PassThroughClaims) != 1 || !bytes.Equal(res.PassThroughClaims[0], env.VerifiableCredential[1]) {
				t.Fatalf("%s: PassThroughClaims = %d entries, want the partner credential byte-identical", file, len(res.PassThroughClaims))
			}
			opts.ExtraCredentialContexts = nil
			if _, err := VerifyVP(signed, opts); err == nil {
				t.Fatalf("VerifyVP(%s) accepted the partner credential without its context", file)
			}
		})
	}
}

// TestConformance_VPSuppliedContextAliasIsChecked: a partner context term
// that stands for the reserved type's IRI makes the credential reserved:
// with that context supplied it is refused on its unlisted issuer, and
// trusting that issuer too makes it verify with both credentials checked.
func TestConformance_VPSuppliedContextAliasIsChecked(t *testing.T) {
	const holder = "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
	contexts := partnerContexts(t, "https://partner.example/membership/v1", "partner-membership-v1-context.jsonld")
	for _, signer := range []string{"go", "ts"} {
		file := "secp256k1-" + signer + "-vp-partner-alias.json"
		t.Run(file, func(t *testing.T) {
			signed := readFixture(t, file)
			opts := vpHappyOpts(t, holder)
			opts.RequiredVCTypes = []string{"KnownToAtumVerifiableCredential"}
			opts.ExtraCredentialContexts = contexts
			opts.IsIssuerTrusted = func(d string) (bool, bool) { return d == "did:web:atumlabs.xyz", true }
			_, err := VerifyVP(signed, opts)
			if !errors.Is(err, ErrVPIssuerNotTrusted) || !strings.Contains(err.Error(), "verifiableCredential[1]") {
				t.Fatalf("VerifyVP(%s): want ErrVPIssuerNotTrusted on verifiableCredential[1], got %v", file, err)
			}
			opts.IsIssuerTrusted = func(d string) (bool, bool) {
				return d == "did:web:atumlabs.xyz" || d == "did:web:impersonator.example", true
			}
			res, err := VerifyVP(signed, opts)
			if err != nil {
				t.Fatalf("VerifyVP(%s) with both issuers trusted: %v", file, err)
			}
			if len(res.AttestedClaims) != 2 || len(res.PassThroughClaims) != 0 {
				t.Fatalf("%s: %d attested and %d passed through, want both checked", file, len(res.AttestedClaims), len(res.PassThroughClaims))
			}
		})
	}
}
