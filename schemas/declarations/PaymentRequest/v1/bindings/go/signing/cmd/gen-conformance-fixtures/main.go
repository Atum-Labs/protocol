// gen-conformance-fixtures generates the Go-signed halves of the cross-
// language conformance fixture set for the inner PaymentRequest signer:
//
//   - secp256k1-go-signed.json
//   - ed25519-go-signed.json
//   - ed25519-stellar-go-signed.json
//   - secp256k1-typed-go-signed.json
//
// All under schemas/declarations/PaymentRequest/v1/conformance/fixtures.
//
// Pinned inputs (see ../../README.md / the FulfillmentQuote conformance
// README for the shared rationale):
//   - secp256k1 private key: Hardhat account #0
//   - ed25519 seed: 32 bytes of 0x00 (RFC 8032 test vector)
//   - created: 2026-04-01T00:00:00.000Z
//   - PaymentRequest document: a minimal but schema-valid request (all
//     six required fields present) so the Go verifier's typed
//     paymentrequest.SchemaJson unmarshal succeeds on the fixture.
//
// Run via `make -C schemas/declarations/PaymentRequest/v1/bindings/go/signing gen-conformance-fixtures`
// (or directly with `go run ./cmd/gen-conformance-fixtures` from the package dir).
package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	ldverification "github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/signing"
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
	if err := genEd25519Stellar(outDir); err != nil {
		die("ed25519 stellar: %v", err)
	}
	if err := genSecp256k1Typed(outDir); err != nil {
		die("secp256k1 typed: %v", err)
	}
	fmt.Printf("wrote 4 fixtures to %s\n", outDir)
}

// pinnedSecp256k1Doc returns the unsigned PaymentRequest the secp256k1
// generator signs. MUST exactly mirror the TS generator's secp256k1 doc
// — drift between the two unsigned docs changes the canonical n-quads
// and breaks cross-language verification.
func pinnedSecp256k1Doc(senderAddr string) map[string]any {
	return map[string]any{
		"version":    "1.0",
		"request_id": "req-pr-secp-1",
		"source": map[string]any{
			"asset_identifier": "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A",
			"account":          senderAddr,
		},
		"destination": []any{
			map[string]any{
				"asset_identifier": "eip155:1/erc20:0xbbb",
				"account":          "0x0000000000000000000000000000000000000002",
			},
		},
		"fulfillment_amount":      "1000000",
		"quote_deadline":          "2030-01-01T00:00:00Z",
		"fulfillment_deadline":    "2030-01-02T00:00:00Z",
		"escrow_contract_address": "0x0000000000000000000000000000000000000003",
		"fulfillment_verifier": map[string]any{
			"account":  "0x0000000000000000000000000000000000000004",
			"endpoint": "https://veri-fill.example.com",
		},
		"sender_auth": map[string]any{
			"message_scheme": "EVM_PERMIT2",
			"signed_messages": []any{
				map[string]any{
					"message":         "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
					"message_prehash": "{}",
					"signature":       "0xabcdef1234567890",
				},
			},
		},
	}
}

// pinnedEd25519Doc returns the unsigned PaymentRequest the ed25519
// generator signs. MUST exactly mirror the TS generator's ed25519 doc.
func pinnedEd25519Doc(senderAddr string) map[string]any {
	return map[string]any{
		"version":    "1.0",
		"request_id": "req-pr-sol-1",
		"source": map[string]any{
			"asset_identifier": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/spltoken:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
			"account":          senderAddr,
		},
		"destination": []any{
			map[string]any{
				"asset_identifier": "eip155:1/erc20:0xbbb",
				"account":          "0x0000000000000000000000000000000000000002",
			},
		},
		"fulfillment_amount":      "1000000",
		"quote_deadline":          "2030-01-01T00:00:00Z",
		"fulfillment_deadline":    "2030-01-02T00:00:00Z",
		"escrow_contract_address": "11111111111111111111111111111111",
		"fulfillment_verifier": map[string]any{
			"account":  "0x0000000000000000000000000000000000000004",
			"endpoint": "https://veri-fill.example.com",
		},
		"sender_auth": map[string]any{
			"message_scheme": "SOLANA",
			"signed_messages": []any{
				map[string]any{
					"message":         "0xdeadbeef",
					"message_prehash": "{}",
					"signature":       "0xfeedface",
				},
			},
		},
	}
}

// pinnedStellarDoc returns the unsigned PaymentRequest the Stellar generator signs. MUST exactly
// mirror the TS generator's Stellar doc.
func pinnedStellarDoc(senderAddr string) map[string]any {
	return map[string]any{
		"version":    "1.0",
		"request_id": "req-pr-stellar-1",
		"source": map[string]any{
			"asset_identifier": "stellar:testnet/sep41:CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
			"account":          senderAddr,
		},
		"destination": []any{
			map[string]any{
				"asset_identifier": "eip155:1/erc20:0xbbb",
				"account":          "0x0000000000000000000000000000000000000002",
			},
		},
		"fulfillment_amount":      "1000000",
		"quote_deadline":          "2030-01-01T00:00:00Z",
		"fulfillment_deadline":    "2030-01-02T00:00:00Z",
		"escrow_contract_address": "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5",
		"fulfillment_verifier": map[string]any{
			"account":  "0x0000000000000000000000000000000000000004",
			"endpoint": "https://veri-fill.example.com",
		},
		"sender_auth": map[string]any{
			"message_scheme": "STELLAR",
			"signed_messages": []any{
				map[string]any{
					"message":         "0xdeadbeef",
					"message_prehash": "{}",
					"signature":       "0xfeedface",
				},
			},
		},
	}
}

// genEd25519Stellar signs under the same all-zero seed as the Solana fixture, so the key is the
// account GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH of the shared strkey vectors.
// "testnet" is a reference no Solana network uses, so the same key and reference under another
// namespace is what the binding tests refuse.
func genEd25519Stellar(outDir string) error {
	var seed [32]byte
	priv := ed25519.NewKeyFromSeed(seed[:])
	// The shared strkey vectors pair this key with its account; the fixture tests re-check the pairing.
	const account = "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH"

	signed, err := ldverification.SignPaymentRequestEd25519WithCreatedString(pinnedStellarDoc(account), priv, ldverification.SignEd25519Options{
		VerificationMethod: "did:pkh:stellar:testnet:" + account + "#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
	}, pinnedCreated)
	if err != nil {
		return fmt.Errorf("sign: %w", err)
	}
	return os.WriteFile(filepath.Join(outDir, "ed25519-stellar-go-signed.json"), append(signed, '\n'), 0o644)
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

	doc := pinnedSecp256k1Doc(address)

	// SignPaymentRequestWithCreatedString rather than SignPaymentRequest
	// so the timestamp string is pinned verbatim — the time.Time path
	// might re-encode the offset differently than the TS
	// Date.toISOString() output, defeating the determinism guarantee for
	// ed25519 below.
	signed, err := ldverification.SignPaymentRequestWithCreatedString(doc, priv, ldverification.SignOptions{
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

// genSecp256k1Typed signs the secp256k1 document in the typed form a payer's wallet produces: the
// signature is over the EIP-712 digest of PaymentRequestProof{proofHash, docHash} rather than over
// keccak256(proofHash || docHash). The TS verifier MUST recover Hardhat #0 from it.
func genSecp256k1Typed(outDir string) error {
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
	signed, err := ldverification.SignPaymentRequestTypedWithSignerAndCreatedString(pinnedSecp256k1Doc(address), signer, ldverification.SignOptions{
		VerificationMethod: "did:pkh:eip155:1:" + address + "#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
	}, pinnedCreated)
	if err != nil {
		return fmt.Errorf("sign: %w", err)
	}
	return os.WriteFile(filepath.Join(outDir, "secp256k1-typed-go-signed.json"), append(signed, '\n'), 0o644)
}

func genEd25519(outDir string) error {
	// 32 zero bytes as the seed → deterministic keypair. The canonical
	// "all-zero" RFC 8032 test vector; universally reproducible across
	// languages, which is exactly what we need to pin cross-language
	// byte-equality of the resulting ed25519 signature.
	var seed [32]byte
	priv := ed25519.NewKeyFromSeed(seed[:])
	pub := priv.Public().(ed25519.PublicKey)
	pubBase58 := base58.Encode(pub)

	doc := pinnedEd25519Doc(pubBase58)

	signed, err := ldverification.SignPaymentRequestEd25519WithCreatedString(doc, priv, ldverification.SignEd25519Options{
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

// resolveOutDir walks up from the binary's current working directory to
// locate the `schemas/declarations/PaymentRequest/v1/conformance/fixtures`
// dir. Walking rather than hardcoding so the generator works whether it's
// invoked from the package, from the repo root via go run, or from a
// Makefile target.
func resolveOutDir() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	const rel = "schemas/declarations/PaymentRequest/v1/conformance/fixtures"
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
