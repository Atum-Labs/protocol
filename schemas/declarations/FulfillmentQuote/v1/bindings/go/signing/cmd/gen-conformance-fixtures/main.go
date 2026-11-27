// gen-conformance-fixtures generates the Go-signed halves of the cross-
// language conformance fixture set:
//
//	FQ side:
//	  - secp256k1-go-signed.json
//	  - ed25519-go-signed.json
//
//	VP side:
//	  - secp256k1-go-vp.json
//	  - ed25519-go-vp.json
//	  - secp256k1-go-vp-null-issuance-date.json  (negative: VerifyVP must refuse)
//	  - ed25519-go-vp-null-issuance-date.json    (negative: VerifyVP must refuse)
//
//	VC-proof side:
//	  - secp256k1-go-vc-proof.json
//	  - ed25519-go-vc-proof.json
//	  - {secp256k1,ed25519}-go-vc-proof-kta-v2-{quote-awarder,merchant}.json
//	  - vc-issuer-secp256k1.jwk.json  (JWK sidecar — single file, shared by both sides)
//	  - vc-issuer-ed25519.jwk.json
//
// All under schemas/declarations/FulfillmentQuote/v1/conformance/fixtures.
//
// Pinned inputs (see ../../README.md for rationale):
//   - secp256k1 private key: Hardhat account #0
//   - ed25519 seed: 32 bytes of 0x00 (RFC 8032 test vector)
//   - created: 2026-04-01T00:00:00.000Z
//   - FQ document: the FulfillmentQuote fixture used by sign_test.go
//   - VP fixture: minimal envelope with one VerifiableCredential issued by
//     a pinned issuer DID; challenge=req-fixture-1, domain=did:web:settler.atum.network
//
// Run via `make -C schemas/declarations/FulfillmentQuote/v1/bindings/go/signing gen-conformance-fixtures`
// (or directly with `go run ./cmd/gen-conformance-fixtures` from the package dir).
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	ldverification "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go/signing"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/mr-tron/base58"
)

const (
	// Hardhat account #0 — well-known test key. Used here only to pin
	// a deterministic signing identity for the fixture; not appropriate
	// for any production purpose.
	hardhatPrivKeyHex = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

	pinnedCreated = "2026-04-01T00:00:00.000Z"

	// VP-side pinned bindings. challenge / domain are the fields
	// VerifyVP asserts against; pinning them in the generator makes the
	// conformance fixture verify with a known options struct on either
	// side.
	pinnedVPChallenge = "req-fixture-1"
	pinnedVPDomain    = "did:web:settler.atum.network"

	// Pinned VC issuance — also frozen so the embedded VC's date window
	// stays inside any reasonable Now the conformance test pins.
	pinnedVCIssuer       = "did:web:atumlabs.xyz"
	pinnedVCIssuanceDate = "2026-01-01T00:00:00Z"
	pinnedVCID           = "urn:uuid:5b5d7e0e-9d27-4f1f-a5db-3a52cfb24d2f"
	// The known-to-atum v2 fixtures carry an expirationDate, 60 days after
	// issuance. VerifyVCProof checks the signature and not the dates, so the
	// fixtures keep verifying after it passes.
	pinnedVCExpirationDate = "2026-03-02T00:00:00Z"

	// PaymentRequestEnvelope (PRE) bindings for the declarationType-set
	// conformance fixtures. MUST match the TS generator's PRE_CONTEXT_URL /
	// PRE_ENVELOPE_TYPE AND the canonical PRE binding consts
	// (PaymentRequestEnvelope/v1/bindings/{go,typescript}/version) — drift
	// breaks the PRE ed25519 byte-identity invariant.
	preContextURL   = "https://schemas.atum.network/declarations/PaymentRequestEnvelope/v1/context.jsonld"
	preEnvelopeType = "PaymentRequestEnvelope"
)

func main() {
	outDir, err := resolveOutDir()
	if err != nil {
		die("resolve out dir: %v", err)
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		die("mkdir: %v", err)
	}

	if err := genSecp256k1(outDir); err != nil {
		die("secp256k1: %v", err)
	}
	if err := genEd25519(outDir); err != nil {
		die("ed25519: %v", err)
	}
	if err := genSecp256k1VP(outDir, "secp256k1-go-vp.json", pinnedVCIssuanceDate); err != nil {
		die("secp256k1 VP: %v", err)
	}
	if err := genEd25519VP(outDir, "ed25519-go-vp.json", pinnedVCIssuanceDate); err != nil {
		die("ed25519 VP: %v", err)
	}
	// Negative fixtures: the same envelopes with the credential's
	// issuanceDate set to JSON null. The holder signature verifies; the
	// verifiers on both sides must refuse the credential.
	if err := genSecp256k1VP(outDir, "secp256k1-go-vp-null-issuance-date.json", nil); err != nil {
		die("secp256k1 VP, null issuanceDate: %v", err)
	}
	if err := genEd25519VP(outDir, "ed25519-go-vp-null-issuance-date.json", nil); err != nil {
		die("ed25519 VP, null issuanceDate: %v", err)
	}
	if err := genSecp256k1PREVP(outDir); err != nil {
		die("secp256k1 PRE VP: %v", err)
	}
	if err := genEd25519PREVP(outDir); err != nil {
		die("ed25519 PRE VP: %v", err)
	}
	if err := genSecp256k1TypedPREVP(outDir); err != nil {
		die("secp256k1 typed PRE VP: %v", err)
	}
	if err := genVCProofSecp256k1(outDir, buildPinnedVCBody(), "secp256k1-go-vc-proof.json"); err != nil {
		die("secp256k1 VC proof: %v", err)
	}
	if err := genVCProofEd25519(outDir, buildPinnedVCBody(), "ed25519-go-vc-proof.json"); err != nil {
		die("ed25519 VC proof: %v", err)
	}
	for _, f := range knownToAtumV2Fixtures {
		if err := genKnownToAtumV2VCProofs(outDir, f); err != nil {
			die("known-to-atum v2 %s VC proofs: %v", f.role, err)
		}
	}
	if err := genJWKSidecars(outDir); err != nil {
		die("JWK sidecars: %v", err)
	}
	fmt.Printf("wrote %d fixtures to %s\n", 13+2*len(knownToAtumV2Fixtures), outDir)
}

func genSecp256k1(outDir string) error {
	keyBytes, err := hex.DecodeString(hardhatPrivKeyHex)
	if err != nil {
		return fmt.Errorf("decode privkey: %w", err)
	}
	priv, err := crypto.ToECDSA(keyBytes)
	if err != nil {
		return fmt.Errorf("ToECDSA: %w", err)
	}
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())

	doc := map[string]any{
		"version":              "1.0",
		"source_amount":        "1000000",
		"award_deadline":       "2030-01-01T00:00:00Z",
		"source":               map[string]any{"id": "eip155:1/erc20:0xaaa", "account": "eip155:1:0x1"},
		"destination":          map[string]any{"id": "eip155:1/erc20:0xbbb", "account": "eip155:1:0x2"},
		"settler_address":      address,
		"payment_request_json": `{"request_id":"req-1"}`,
	}

	// SignWithCreatedString rather than Sign so the timestamp string is
	// pinned verbatim — Sign would format from time.Time and might
	// re-encode the offset differently than the TS Date.toISOString()
	// output, defeating the determinism guarantee for ed25519 below.
	signed, err := ldverification.SignWithCreatedString(doc, priv, ldverification.SignOptions{
		VerificationMethod: "did:pkh:eip155:1:" + address + "#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
	}, pinnedCreated)
	if err != nil {
		return fmt.Errorf("sign: %w", err)
	}

	dst := filepath.Join(outDir, "secp256k1-go-signed.json")
	if err := os.WriteFile(dst, append(signed, '\n'), 0o644); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

func genEd25519(outDir string) error {
	// 32 zero bytes as the seed → deterministic keypair. This is the
	// canonical "all-zero" RFC 8032 test vector; the only thing it has
	// going for it is universal reproducibility across languages and
	// libraries, which is exactly what we need to pin cross-language
	// byte-equality of the resulting ed25519 signature.
	var seed [32]byte
	priv := ed25519.NewKeyFromSeed(seed[:])
	pub := priv.Public().(ed25519.PublicKey)
	pubBase58 := base58.Encode(pub)

	doc := map[string]any{
		"version":        "1.0",
		"source_amount":  "1000000",
		"award_deadline": "2030-01-01T00:00:00Z",
		"source": map[string]any{
			"id":      "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
			"account": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:" + pubBase58,
		},
		"destination": map[string]any{
			"id":      "eip155:1/erc20:0xbbb",
			"account": "eip155:1:0x2",
		},
		"settler_address":      pubBase58,
		"payment_request_json": `{"request_id":"req-sol-1"}`,
	}

	signed, err := ldverification.SignEd25519WithCreatedString(doc, priv, ldverification.SignEd25519Options{
		VerificationMethod: "did:pkh:solana:devnet:" + pubBase58 + "#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
	}, pinnedCreated)
	if err != nil {
		return fmt.Errorf("sign: %w", err)
	}

	dst := filepath.Join(outDir, "ed25519-go-signed.json")
	if err := os.WriteFile(dst, append(signed, '\n'), 0o644); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

// genSecp256k1VP signs a FulfillmentQuoteEnvelope (VP wrapping VCs) under
// the EcdsaSecp256k1RecoverySignature2020 cryptosuite. Same Hardhat key
// as genSecp256k1 — holder DID = did:pkh:eip155:1:<address> — so the
// settler identity that signed the inner FQ matches the VP holder (this
// is the consistency invariant VerifyVP enforces). issuanceDate is the
// embedded credential's issuanceDate (nil writes JSON null).
func genSecp256k1VP(outDir, name string, issuanceDate any) error {
	keyBytes, err := hex.DecodeString(hardhatPrivKeyHex)
	if err != nil {
		return fmt.Errorf("decode privkey: %w", err)
	}
	priv, err := crypto.ToECDSA(keyBytes)
	if err != nil {
		return fmt.Errorf("ToECDSA: %w", err)
	}
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + address

	vcs, err := pinnedVCsFor(holder, ldverification.ProofTypeSecp256k1Recovery2020, issuanceDate)
	if err != nil {
		return err
	}

	signed, err := ldverification.SignVPWithCreatedString(vcs, priv, ldverification.SignVPOptions{
		Holder:             holder,
		VerificationMethod: holder + "#blockchainAccountId",
		Challenge:          pinnedVPChallenge,
		Domain:             pinnedVPDomain,
	}, pinnedCreated)
	if err != nil {
		return fmt.Errorf("SignVP: %w", err)
	}

	dst := filepath.Join(outDir, name)
	if err := os.WriteFile(dst, append(signed, '\n'), 0o644); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

// genEd25519VP signs a FulfillmentQuoteEnvelope under Ed25519Signature2020.
// Same RFC 8032 zero-seed key as genEd25519; holder is the Solana-style
// did:pkh from the base58 pubkey. RFC 8032 deterministic — the
// TS-generated counterpart MUST byte-match (pinned by the cross-language
// byte-identity test on both sides). issuanceDate is the embedded
// credential's issuanceDate (nil writes JSON null).
func genEd25519VP(outDir, name string, issuanceDate any) error {
	var seed [32]byte
	priv := ed25519.NewKeyFromSeed(seed[:])
	pub := priv.Public().(ed25519.PublicKey)
	pubBase58 := base58.Encode(pub)
	holder := "did:pkh:solana:devnet:" + pubBase58

	vcs, err := pinnedVCsFor(holder, ldverification.ProofTypeEd25519Signature2020, issuanceDate)
	if err != nil {
		return err
	}

	signed, err := ldverification.SignVPEd25519WithCreatedString(vcs, priv, ldverification.SignVPEd25519Options{
		Holder:             holder,
		VerificationMethod: holder + "#blockchainAccountId",
		Challenge:          pinnedVPChallenge,
		Domain:             pinnedVPDomain,
	}, pinnedCreated)
	if err != nil {
		return fmt.Errorf("SignVPEd25519: %w", err)
	}

	dst := filepath.Join(outDir, name)
	if err := os.WriteFile(dst, append(signed, '\n'), 0o644); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

// loadPREContext reads the canonical PaymentRequestEnvelope declaration
// context from the schema source and parses it for the ExtraEnvelopeContexts
// overlay. Path is relative to the FQ fixtures dir:
// fixtures → conformance → v1 → FulfillmentQuote → declarations →
// PaymentRequestEnvelope/v1/context.jsonld. Loading the canonical file (rather
// than embedding a copy) keeps the conformance overlay identical to what the
// the PRE builder + TS pre-builder use.
func loadPREContext(outDir string) (map[string]any, error) {
	path := filepath.Join(outDir, "..", "..", "..", "..", "PaymentRequestEnvelope", "v1", "context.jsonld")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read PRE context %s: %w", path, err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("parse PRE context: %w", err)
	}
	return parsed, nil
}

// genSecp256k1PREVP signs a PaymentRequestEnvelope (the originator-side holder
// VP) under EcdsaSecp256k1RecoverySignature2020. Same shape as
// genSecp256k1VP but threads the declarationType-set seam —
// DeclarationType=PaymentRequestEnvelope, EnvelopeContextURL=PRE URL, and
// ExtraEnvelopeContexts overlaying the canonical PRE context. The TS verifier
// reads this with expectedDeclarationType + extraEnvelopeContexts and MUST
// accept it.
func genSecp256k1PREVP(outDir string) error {
	keyBytes, err := hex.DecodeString(hardhatPrivKeyHex)
	if err != nil {
		return fmt.Errorf("decode privkey: %w", err)
	}
	priv, err := crypto.ToECDSA(keyBytes)
	if err != nil {
		return fmt.Errorf("ToECDSA: %w", err)
	}
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + address

	vcs, err := pinnedVCsFor(holder, ldverification.ProofTypeSecp256k1Recovery2020, pinnedVCIssuanceDate)
	if err != nil {
		return err
	}

	preCtx, err := loadPREContext(outDir)
	if err != nil {
		return err
	}

	signed, err := ldverification.SignVPWithCreatedString(vcs, priv, ldverification.SignVPOptions{
		Holder:                holder,
		VerificationMethod:    holder + "#blockchainAccountId",
		Challenge:             pinnedVPChallenge,
		Domain:                pinnedVPDomain,
		DeclarationType:       preEnvelopeType,
		EnvelopeContextURL:    preContextURL,
		ExtraEnvelopeContexts: map[string]any{preContextURL: preCtx},
	}, pinnedCreated)
	if err != nil {
		return fmt.Errorf("SignVP (PRE): %w", err)
	}

	dst := filepath.Join(outDir, "secp256k1-go-pre-vp.json")
	if err := os.WriteFile(dst, append(signed, '\n'), 0o644); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

// genSecp256k1TypedPREVP signs the same PaymentRequestEnvelope as genSecp256k1PREVP, in the typed
// form a payer's wallet produces: the holder signature is over the EIP-712 digest of
// PaymentRequestEnvelopeProof{proofHash, docHash}. The TS verifier MUST accept it when told to
// accept that form, and refuse it otherwise.
func genSecp256k1TypedPREVP(outDir string) error {
	keyBytes, err := hex.DecodeString(hardhatPrivKeyHex)
	if err != nil {
		return fmt.Errorf("decode privkey: %w", err)
	}
	priv, err := crypto.ToECDSA(keyBytes)
	if err != nil {
		return fmt.Errorf("ToECDSA: %w", err)
	}
	signer, err := lddataintegrity.NewECDSASigner(priv)
	if err != nil {
		return err
	}
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holder := "did:pkh:eip155:1:" + address

	vcs, err := pinnedVCsFor(holder, ldverification.ProofTypeSecp256k1Recovery2020, pinnedVCIssuanceDate)
	if err != nil {
		return err
	}
	preCtx, err := loadPREContext(outDir)
	if err != nil {
		return err
	}
	signed, err := ldverification.SignVPTypedWithSignerAndCreatedString(vcs, signer, ldverification.SignVPOptions{
		Holder:                holder,
		VerificationMethod:    holder + "#blockchainAccountId",
		Challenge:             pinnedVPChallenge,
		Domain:                pinnedVPDomain,
		DeclarationType:       preEnvelopeType,
		EnvelopeContextURL:    preContextURL,
		ExtraEnvelopeContexts: map[string]any{preContextURL: preCtx},
	}, pinnedCreated)
	if err != nil {
		return fmt.Errorf("SignVPTyped (PRE): %w", err)
	}
	return os.WriteFile(filepath.Join(outDir, "secp256k1-typed-go-pre-vp.json"), append(signed, '\n'), 0o644)
}

// genEd25519PREVP signs a PaymentRequestEnvelope under Ed25519Signature2020.
// RFC 8032 deterministic — the TS-generated counterpart MUST byte-match
// (pinned by TestConformance_Ed25519PREVPFixturesAreByteIdentical on both
// sides), which is the strongest proof the declarationType-set canonical form
// agrees across languages.
func genEd25519PREVP(outDir string) error {
	var seed [32]byte
	priv := ed25519.NewKeyFromSeed(seed[:])
	pub := priv.Public().(ed25519.PublicKey)
	pubBase58 := base58.Encode(pub)
	holder := "did:pkh:solana:devnet:" + pubBase58

	vcs, err := pinnedVCsFor(holder, ldverification.ProofTypeEd25519Signature2020, pinnedVCIssuanceDate)
	if err != nil {
		return err
	}

	preCtx, err := loadPREContext(outDir)
	if err != nil {
		return err
	}

	signed, err := ldverification.SignVPEd25519WithCreatedString(vcs, priv, ldverification.SignVPEd25519Options{
		Holder:                holder,
		VerificationMethod:    holder + "#blockchainAccountId",
		Challenge:             pinnedVPChallenge,
		Domain:                pinnedVPDomain,
		DeclarationType:       preEnvelopeType,
		EnvelopeContextURL:    preContextURL,
		ExtraEnvelopeContexts: map[string]any{preContextURL: preCtx},
	}, pinnedCreated)
	if err != nil {
		return fmt.Errorf("SignVPEd25519 (PRE): %w", err)
	}

	dst := filepath.Join(outDir, "ed25519-go-pre-vp.json")
	if err := os.WriteFile(dst, append(signed, '\n'), 0o644); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

// genVCProofSecp256k1 signs vcBody under
// EcdsaSecp256k1RecoverySignature2020 with the pinned Hardhat key and
// writes it to outDir/name. Cross-language fixture: the TS verifier
// reads the file and verifies it via verifyVCProof + a mock resolver
// returning the JWK sidecar at vc-issuer-secp256k1.jwk.json.
//
// The issuer DID is `did:web:atumlabs.xyz` — same fixed value the
// existing VP fixtures embed (pinnedVCIssuer). The verificationMethod
// URL is `<issuerDID>#key-1`; the resolver MUST advertise that URL.
//
// Cross-language byte equality is NOT asserted for the secp256k1
// fixtures. The signature is deterministic today: go-ethereum's
// crypto.Sign and ethers' SigningKey.sign both derive the nonce per
// RFC 6979, so each file regenerates byte-identically and matches its
// TS counterpart. ECDSA promises no such equality across
// implementations, though, so each language generates its own and the
// other side verifies it and checks the recovered signer (see
// conformance/README.md, "Determinism invariants").
func genVCProofSecp256k1(outDir string, vcBody map[string]any, name string) error {
	keyBytes, err := hex.DecodeString(hardhatPrivKeyHex)
	if err != nil {
		return fmt.Errorf("decode privkey: %w", err)
	}
	priv, err := crypto.ToECDSA(keyBytes)
	if err != nil {
		return fmt.Errorf("ToECDSA: %w", err)
	}

	signed, err := ldverification.SignVCProofSecp256k1WithCreatedString(
		vcBody,
		priv,
		pinnedVCIssuer+"#key-1",
		"assertionMethod",
		pinnedVCIssuanceDate,
	)
	if err != nil {
		return fmt.Errorf("SignVCProofSecp256k1: %w", err)
	}
	return writeFixture(outDir, name, signed)
}

// genVCProofEd25519 signs vcBody under Ed25519Signature2020 with the
// RFC 8032 zero-seed key and writes it to outDir/name. Ed25519 IS
// deterministic — the TS counterpart MUST byte-match the relevant
// portions (proof.proofValue in particular).
func genVCProofEd25519(outDir string, vcBody map[string]any, name string) error {
	var seed [32]byte
	priv := ed25519.NewKeyFromSeed(seed[:])

	signed, err := ldverification.SignVCProofEd25519WithCreatedString(
		vcBody,
		priv,
		pinnedVCIssuer+"#key-1",
		"assertionMethod",
		pinnedVCIssuanceDate,
	)
	if err != nil {
		return fmt.Errorf("SignVCProofEd25519: %w", err)
	}
	return writeFixture(outDir, name, signed)
}

// buildPinnedVCBody returns the unsigned VC the two VC-proof generators
// share. Includes the known-to-atum context URL so the
// `KnownToAtumVerifiableCredential` type alias binds to a stable IRI in both
// json-gold and jsonld.js — this retired the cross-language
// divergence on unmapped type IRIs.
func buildPinnedVCBody() map[string]any {
	return map[string]any{
		"@context": []any{
			"https://www.w3.org/2018/credentials/v1",
			"https://schemas.atum.xyz/credentials/known-to-atum/v1",
		},
		"id":           "urn:uuid:vc-1737-conformance",
		"type":         []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
		"issuer":       pinnedVCIssuer,
		"issuanceDate": pinnedVCIssuanceDate,
		"credentialSubject": map[string]any{
			"id":   "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
			"role": "settler",
		},
	}
}

// knownToAtumV2Fixtures are the credentials issued under the
// known-to-atum v2 context: one per role v2 adds. Each is signed under
// both cryptosuites, in each language, and verified by the other language.
// MUST match the TS generator's KNOWN_TO_ATUM_V2_FIXTURES.
var knownToAtumV2Fixtures = []knownToAtumV2Fixture{
	{name: "kta-v2-quote-awarder", role: "quoteAwarder"},
	{name: "kta-v2-merchant", role: "merchant"},
}

type knownToAtumV2Fixture struct {
	// name is the fixture file suffix, as in
	// secp256k1-go-vc-proof-<name>.json.
	name string
	role string
}

// genKnownToAtumV2VCProofs mints the two signed credentials for one
// known-to-atum v2 role, one per cryptosuite, through the v1 VC-proof
// generators, so they share the pinned keys, issuer and dates.
func genKnownToAtumV2VCProofs(outDir string, f knownToAtumV2Fixture) error {
	secpName := "secp256k1-go-vc-proof-" + f.name + ".json"
	if err := genVCProofSecp256k1(outDir, buildKnownToAtumV2VCBody(f.name, f.role), secpName); err != nil {
		return err
	}
	edName := "ed25519-go-vc-proof-" + f.name + ".json"
	return genVCProofEd25519(outDir, buildKnownToAtumV2VCBody(f.name, f.role), edName)
}

// buildKnownToAtumV2VCBody is the unsigned credential for a known-to-atum
// v2 role: the shape the issuer emits, with an expirationDate as every
// credential carries. MUST mirror the TS generator's
// buildKnownToAtumV2VCBody.
func buildKnownToAtumV2VCBody(name, role string) map[string]any {
	return map[string]any{
		"@context": []any{
			"https://www.w3.org/2018/credentials/v1",
			"https://schemas.atum.xyz/credentials/known-to-atum/v2",
		},
		"id":             "urn:uuid:vc-" + name + "-conformance",
		"type":           []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
		"issuer":         pinnedVCIssuer,
		"issuanceDate":   pinnedVCIssuanceDate,
		"expirationDate": pinnedVCExpirationDate,
		"credentialSubject": map[string]any{
			"id":   "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
			"role": role,
		},
	}
}

func writeFixture(outDir, name string, signed map[string]any) error {
	body, err := json.Marshal(signed)
	if err != nil {
		return fmt.Errorf("marshal %s: %w", name, err)
	}
	if err := os.WriteFile(filepath.Join(outDir, name), append(body, '\n'), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	return nil
}

// genJWKSidecars writes the issuer-key JWK files the conformance tests
// load as the mock resolver's published key set. Single source of truth:
// one file per cryptosuite, shared by Go and TS verifiers (the keys
// themselves are pinned constants on both sides, so emitting the JWKs
// from the Go side is sufficient — the TS side reads the same files).
//
// Shape mirrors the DID document's verificationMethod[] entries the
// production did:web resolver returns: id + type + publicKeyJwk. The
// `vmSet` wrapper makes the loader plumbing trivial on either verifier
// side (read the file, parse, hand the slice to a mock resolver).
func genJWKSidecars(outDir string) error {
	// secp256k1 JWK from Hardhat account #0.
	keyBytes, err := hex.DecodeString(hardhatPrivKeyHex)
	if err != nil {
		return fmt.Errorf("decode privkey: %w", err)
	}
	priv, err := crypto.ToECDSA(keyBytes)
	if err != nil {
		return fmt.Errorf("ToECDSA: %w", err)
	}
	uncompressed := crypto.FromECDSAPub(&priv.PublicKey)
	if len(uncompressed) != 65 {
		return fmt.Errorf("expected 65-byte uncompressed pubkey, got %d", len(uncompressed))
	}
	x := uncompressed[1:33]
	y := uncompressed[33:65]

	secpSidecar := map[string]any{
		"$comment": "Conformance fixture — issuer JWK for the secp256k1-{go,ts}-vc-proof.json fixtures. Mirrors the publicKeyJwk entry the production did:web resolver returns for the pinned Hardhat issuer key.",
		"vmSet": []any{
			map[string]any{
				"id":   pinnedVCIssuer + "#key-1",
				"type": "JsonWebKey2020",
				"publicKeyJwk": map[string]any{
					"kty": "EC",
					"crv": "secp256k1",
					"x":   b64UrlNoPad(x),
					"y":   b64UrlNoPad(y),
				},
			},
		},
	}
	secpBytes, err := json.MarshalIndent(secpSidecar, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal secp sidecar: %w", err)
	}
	if err := os.WriteFile(filepath.Join(outDir, "vc-issuer-secp256k1.jwk.json"), append(secpBytes, '\n'), 0o644); err != nil {
		return fmt.Errorf("write secp sidecar: %w", err)
	}

	// ed25519 JWK from the RFC 8032 zero-seed key.
	var seed [32]byte
	edPriv := ed25519.NewKeyFromSeed(seed[:])
	edPub := edPriv.Public().(ed25519.PublicKey)

	edSidecar := map[string]any{
		"$comment": "Conformance fixture — issuer JWK for the ed25519-{go,ts}-vc-proof.json fixtures. Pinned to the RFC 8032 zero-seed pubkey (deterministic across languages).",
		"vmSet": []any{
			map[string]any{
				"id":   pinnedVCIssuer + "#key-1",
				"type": "JsonWebKey2020",
				"publicKeyJwk": map[string]any{
					"kty": "OKP",
					"crv": "Ed25519",
					"x":   b64UrlNoPad(edPub),
				},
			},
		},
	}
	edBytes, err := json.MarshalIndent(edSidecar, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal ed25519 sidecar: %w", err)
	}
	if err := os.WriteFile(filepath.Join(outDir, "vc-issuer-ed25519.jwk.json"), append(edBytes, '\n'), 0o644); err != nil {
		return fmt.Errorf("write ed25519 sidecar: %w", err)
	}
	return nil
}

func b64UrlNoPad(b []byte) string {
	return strings.TrimRight(base64.RawURLEncoding.EncodeToString(b), "=")
}

// pinnedVCsFor returns the canonical single-VC slice every VP fixture
// embeds. The VC's stub proof.type matches the outer VP cryptosuite so
// the VP's @context covers the term resolution during canonicalization.
// VerifyVP runs policy checks but does NOT crypto-verify the embedded
// VC — so the stub doesn't need a real signature here.
//
// The TS generator MUST produce a byte-identical VC slice (the
// ed25519-deterministic invariant only fires when both halves match).
//
// The type array declares the production-realistic shape
// (W3C `VerifiableCredential` + the Atum-specific `KnownToAtumVerifiableCredential`
// alias). The known-to-atum context URL in the @context array binds the
// alias to a stable IRI on both json-gold and jsonld.js, so both
// libraries emit the same canonical n-quad. Earlier, this fixture
// stripped to single-type form to dodge the cross-language divergence;
// that workaround is now removed.
//
// issuanceDate is the VC's issuanceDate member: pinnedVCIssuanceDate for
// the fixtures that verify, nil (JSON null) for the negative fixtures. The
// stub proof's created stays pinnedVCIssuanceDate either way.
func pinnedVCsFor(holder, cryptosuite string, issuanceDate any) ([]json.RawMessage, error) {
	vc := map[string]any{
		"@context": []any{
			ldverification.W3CVCV1ContextURL,
			"https://schemas.atum.xyz/credentials/known-to-atum/v1",
		},
		"id":           pinnedVCID,
		"type":         []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
		"issuer":       pinnedVCIssuer,
		"issuanceDate": issuanceDate,
		"credentialSubject": map[string]any{
			"id":   holder,
			"role": "settler",
		},
		"proof": map[string]any{
			"type":               cryptosuite,
			"created":            pinnedVCIssuanceDate,
			"verificationMethod": pinnedVCIssuer + "#key-1",
			"proofPurpose":       "assertionMethod",
		},
	}
	raw, err := json.Marshal(vc)
	if err != nil {
		return nil, fmt.Errorf("marshal VC: %w", err)
	}
	return []json.RawMessage{raw}, nil
}

// resolveOutDir walks up from the binary's current working directory to
// locate the `schemas/declarations/FulfillmentQuote/v1/conformance/fixtures`
// dir. Walking rather than hardcoding so the generator works whether it's
// invoked from the package, from the repo root via go run, or from a
// Makefile target.
func resolveOutDir() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	const rel = "schemas/declarations/FulfillmentQuote/v1/conformance/fixtures"
	for dir := cwd; dir != "/" && dir != "."; dir = filepath.Dir(dir) {
		if info, err := os.Stat(filepath.Join(dir, rel)); err == nil && info.IsDir() {
			return filepath.Join(dir, rel), nil
		}
	}
	return "", fmt.Errorf("could not locate %s relative to cwd %s", rel, cwd)
}

func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
