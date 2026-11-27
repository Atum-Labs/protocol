package ldverification

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// Credentials signed before the credential contexts moved off
// schemas.atum.network.
//
// The move changed both the known-to-atum context URL and the vocabulary its
// terms expand to (the kta: prefix). A signature covers the vocabulary and not
// the URL: URDNA2015 writes term IRIs into the canonical N-Quads, never a
// context URL. These tests pin the move from both sides:
//
//   - A credential that still names the retired URL is refused as an unknown
//     context, before any signature is checked.
//   - A credential whose URL is rewritten to the current one resolves, but its
//     signature covers the retired term IRIs, so it fails on the signature.
//     For secp256k1 the tests also recover the signer and check it is NOT the
//     signer of record. Recovery over a changed digest returns a valid-looking
//     wrong address, not an error, so err != nil alone cannot tell this apart
//     from any other failure.
//
// Both rest on a positive control: under the retired context document each
// legacy credential still verifies. That proves the testdata is intact, and
// that the failures come from the vocabulary alone.
//
// testdata/legacy-atum-network holds byte copies of conformance fixtures
// signed before the move, and of the known-to-atum context they were signed
// under. They are a record, not generated output; never regenerate them.

const (
	retiredKnownToAtumContextURL      = "https://schemas.atum.network/credentials/known-to-atum/v1"
	retiredKYCContextURL              = "https://schemas.atum.network/credentials/kyc/v1"
	retiredSenderComplianceContextURL = "https://schemas.atum.network/credentials/sender-compliance/v1"

	legacyIssuerDID   = "did:web:atumlabs.xyz"
	legacyIssuerKeyID = legacyIssuerDID + "#key-1"

	legacyHolderSecp256k1 = "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
	legacyHolderEd25519   = "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS"

	// Hardhat account #0: the conformance generators' pinned secp256k1 key,
	// which signed both the legacy credential and the legacy presentation.
	legacyHardhatPrivKeyHex = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
)

var legacyHardhatAddress = common.HexToAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")

func readLegacyTestdata(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "legacy-atum-network", name))
	if err != nil {
		t.Fatalf("read legacy testdata %s: %v", name, err)
	}
	return b
}

// legacyContexts registers the retired known-to-atum URL with the context
// document the legacy credentials were signed under.
func legacyContexts(t *testing.T) map[string]any {
	t.Helper()
	var ctx any
	if err := json.Unmarshal(readLegacyTestdata(t, "known-to-atum-v1.jsonld"), &ctx); err != nil {
		t.Fatalf("parse the legacy known-to-atum context: %v", err)
	}
	return map[string]any{retiredKnownToAtumContextURL: ctx}
}

// legacyEd25519PublicKey is the RFC 8032 zero-seed key, the conformance
// generators' pinned ed25519 key for both issuer and holder.
func legacyEd25519PublicKey() ed25519.PublicKey {
	var seed [32]byte
	return ed25519.NewKeyFromSeed(seed[:]).Public().(ed25519.PublicKey)
}

// legacyIssuerResolver publishes the legacy credentials' issuer key for the
// given cryptosuite, under the verificationMethod id their proofs name.
func legacyIssuerResolver(t *testing.T, cryptosuite string) IssuerKeyResolver {
	t.Helper()
	var jwk map[string]interface{}
	switch cryptosuite {
	case ProofTypeSecp256k1Recovery2020:
		priv, err := crypto.HexToECDSA(legacyHardhatPrivKeyHex)
		if err != nil {
			t.Fatalf("parse the Hardhat key: %v", err)
		}
		pub := crypto.FromECDSAPub(&priv.PublicKey)
		jwk = map[string]interface{}{
			"kty": "EC",
			"crv": "secp256k1",
			"x":   base64.RawURLEncoding.EncodeToString(pub[1:33]),
			"y":   base64.RawURLEncoding.EncodeToString(pub[33:65]),
		}
	case ProofTypeEd25519Signature2020:
		jwk = map[string]interface{}{
			"kty": "OKP",
			"crv": "Ed25519",
			"x":   base64.RawURLEncoding.EncodeToString(legacyEd25519PublicKey()),
		}
	default:
		t.Fatalf("no legacy issuer key for %q", cryptosuite)
	}
	return &mockResolver{
		issuerDID: legacyIssuerDID,
		vmSet:     VerificationMethodSet{{ID: legacyIssuerKeyID, Type: "JsonWebKey2020", PublicKeyJWK: jwk}},
	}
}

// swapContextURL replaces the one occurrence of the retired known-to-atum URL
// in raw with to. It fails the test if raw does not name that URL exactly once,
// so a change to the testdata cannot make a rewrite silently do nothing.
func swapContextURL(t *testing.T, raw []byte, to string) []byte {
	t.Helper()
	from := []byte(`"` + retiredKnownToAtumContextURL + `"`)
	if n := bytes.Count(raw, from); n != 1 {
		t.Fatalf("legacy testdata names %s %d times, want exactly once", retiredKnownToAtumContextURL, n)
	}
	return bytes.Replace(raw, from, []byte(`"`+to+`"`), 1)
}

// rewriteToCurrentContext is the substitution a careless migration (or an
// attacker) would make: point a legacy credential at the current context URL
// and leave the signed content alone.
func rewriteToCurrentContext(t *testing.T, raw []byte) []byte {
	t.Helper()
	return swapContextURL(t, raw, lddataintegrity.KnownToAtumV1ContextURL)
}

// vcSigningInput rebuilds the signing input VerifyVCProof checks a
// credential's proof against, canonicalizing under loader (nil means the
// verifier's own loader). It returns the proof too.
func vcSigningInput(t *testing.T, raw []byte, loader *lddataintegrity.DocumentLoader) (HashResult, map[string]any) {
	t.Helper()
	var vc map[string]any
	if err := json.Unmarshal(raw, &vc); err != nil {
		t.Fatalf("parse credential: %v", err)
	}
	proof, _ := vc["proof"].(map[string]any)
	suite := rawString(proof, "type")
	hash, err := HashQuote(vc, HashQuoteOptions{
		Cryptosuite: suite,
		ProofOptions: HashableProofOptions{
			Type:               suite,
			Created:            rawString(proof, "created"),
			VerificationMethod: rawString(proof, "verificationMethod"),
			ProofPurpose:       expectedProofPurpose,
			Context:            proof["@context"],
		},
		Loader: loader,
	})
	if err != nil {
		t.Fatalf("HashQuote(credential): %v", err)
	}
	return hash, proof
}

// vpSigningInput rebuilds the signing input VerifyVP checks a holder proof
// against, canonicalizing under loader (nil means the verifier's own loader).
// It returns the proof too.
func vpSigningInput(t *testing.T, raw []byte, loader *lddataintegrity.DocumentLoader) (HashResult, map[string]any) {
	t.Helper()
	doc, proof, err := documentForCanonicalization(raw)
	if err != nil {
		t.Fatalf("parse presentation: %v", err)
	}
	suite := rawString(proof, "type")
	hash, err := HashQuote(doc, HashQuoteOptions{
		Cryptosuite: suite,
		ProofOptions: HashableProofOptions{
			Type:               suite,
			Created:            rawString(proof, "created"),
			VerificationMethod: rawString(proof, "verificationMethod"),
			ProofPurpose:       rawString(proof, "proofPurpose"),
			Challenge:          rawString(proof, "challenge"),
			Domain:             rawString(proof, "domain"),
			Context:            vpProofContext(proof, suiteContextURL(suite)),
		},
		KeepVerifiableCredential: true,
		Loader:                   loader,
	})
	if err != nil {
		t.Fatalf("HashQuote(presentation): %v", err)
	}
	return hash, proof
}

// recoverLegacySigner recovers the secp256k1 signer of proof over hash the
// way the verifiers do. Recovery itself must succeed: a changed digest yields
// a different address, not an error.
func recoverLegacySigner(t *testing.T, hash HashResult, proof map[string]any) common.Address {
	t.Helper()
	_, sig, err := ParseDetachedJWS(rawString(proof, "jws"))
	if err != nil {
		t.Fatalf("ParseDetachedJWS: %v", err)
	}
	addr, err := recoverProofSigner(hash, sig, func(a common.Address) bool { return a == legacyHardhatAddress })
	if err != nil {
		t.Fatalf("recover signer: %v", err)
	}
	return addr
}

func ed25519ProofVerifies(t *testing.T, hash HashResult, proof map[string]any) bool {
	t.Helper()
	sig, err := lddataintegrity.DecodeEd25519ProofValue(rawString(proof, "proofValue"))
	if err != nil {
		t.Fatalf("DecodeEd25519ProofValue: %v", err)
	}
	return ed25519.Verify(legacyEd25519PublicKey(), hash.SigningInput, sig)
}

func legacyLoader(t *testing.T) *lddataintegrity.DocumentLoader {
	t.Helper()
	return loaderWithExtraEnvelopeContexts(legacyContexts(t))
}

// The positive control. Under the context document they were signed under,
// the legacy credentials and presentations still verify: the testdata is
// intact, and the legacy context reproduces their signing inputs exactly.
func TestLegacyCredentials_VerifyUnderTheRetiredContext(t *testing.T) {
	t.Run("secp256k1 credential", func(t *testing.T) {
		hash, proof := vcSigningInput(t, readLegacyTestdata(t, "secp256k1-go-vc-proof.json"), legacyLoader(t))
		if got := recoverLegacySigner(t, hash, proof); got != legacyHardhatAddress {
			t.Fatalf("recovered %s under the retired context, want the issuer %s", got.Hex(), legacyHardhatAddress.Hex())
		}
	})
	t.Run("ed25519 credential", func(t *testing.T) {
		hash, proof := vcSigningInput(t, readLegacyTestdata(t, "ed25519-go-vc-proof.json"), legacyLoader(t))
		if !ed25519ProofVerifies(t, hash, proof) {
			t.Fatal("the legacy ed25519 credential does not verify under the retired context")
		}
	})
	for _, c := range []struct {
		name, file, holder, suite string
	}{
		{"secp256k1 presentation", "secp256k1-go-vp.json", legacyHolderSecp256k1, ProofTypeSecp256k1Recovery2020},
		{"ed25519 presentation", "ed25519-go-vp.json", legacyHolderEd25519, ProofTypeEd25519Signature2020},
	} {
		t.Run(c.name, func(t *testing.T) {
			raw := readLegacyTestdata(t, c.file)
			opts := vpHappyOpts(t, c.holder)
			opts.ExtraEnvelopeContexts = legacyContexts(t)
			res, err := VerifyVP(raw, opts)
			if err != nil {
				t.Fatalf("VerifyVP under the retired context: %v", err)
			}
			if res.Holder != c.holder {
				t.Errorf("Holder = %q, want %q", res.Holder, c.holder)
			}

			// The rewrite tests read the holder signature through
			// vpSigningInput, so it must rebuild the input the holder
			// signed: under the retired context it gives the holder back.
			hash, proof := vpSigningInput(t, raw, legacyLoader(t))
			switch c.suite {
			case ProofTypeSecp256k1Recovery2020:
				if got := recoverLegacySigner(t, hash, proof); got != legacyHardhatAddress {
					t.Fatalf("vpSigningInput under the retired context recovered %s, want the holder %s", got.Hex(), legacyHardhatAddress.Hex())
				}
			case ProofTypeEd25519Signature2020:
				if !ed25519ProofVerifies(t, hash, proof) {
					t.Fatal("the holder's ed25519 signature does not verify over vpSigningInput under the retired context")
				}
			}
		})
	}
}

// wantRefusedAsUnknownContext checks a refusal happened at context
// resolution, naming the URL, and not on any signature.
func wantRefusedAsUnknownContext(t *testing.T, err error, url string) {
	t.Helper()
	if !errors.Is(err, lddataintegrity.ErrUnknownContext) {
		t.Fatalf("err = %v, want lddataintegrity.ErrUnknownContext", err)
	}
	if !errors.Is(err, ErrMalformedQuote) {
		t.Errorf("err = %v, want it to match ErrMalformedQuote too", err)
	}
	if !strings.Contains(err.Error(), url) {
		t.Errorf("err = %q, want it to name %s", err, url)
	}
	if errors.Is(err, ErrVPVCSignatureInvalid) || errors.Is(err, ErrVPSignerHolderMismatch) {
		t.Errorf("err = %v, a signature failure; the retired context must be refused before any signature is checked", err)
	}
}

func TestVerifyVCProof_RefusesTheRetiredCredentialContexts(t *testing.T) {
	secp := readLegacyTestdata(t, "secp256k1-go-vc-proof.json")
	for _, c := range []struct {
		name  string
		raw   []byte
		suite string
		url   string
	}{
		{"known-to-atum, the legacy secp256k1 credential as signed", secp, ProofTypeSecp256k1Recovery2020, retiredKnownToAtumContextURL},
		{"known-to-atum, the legacy ed25519 credential as signed", readLegacyTestdata(t, "ed25519-go-vc-proof.json"), ProofTypeEd25519Signature2020, retiredKnownToAtumContextURL},
		{"kyc", swapContextURL(t, secp, retiredKYCContextURL), ProofTypeSecp256k1Recovery2020, retiredKYCContextURL},
		{"sender-compliance", swapContextURL(t, secp, retiredSenderComplianceContextURL), ProofTypeSecp256k1Recovery2020, retiredSenderComplianceContextURL},
	} {
		t.Run(c.name, func(t *testing.T) {
			err := VerifyVCProof(mustUnmarshalVC(t, c.raw), c.raw, legacyIssuerResolver(t, c.suite), VerifyVCProofOptions{Context: context.Background()})
			wantRefusedAsUnknownContext(t, err, c.url)
		})
	}
}

func TestVerifyVP_RefusesAPresentationEmbeddingARetiredCredentialContext(t *testing.T) {
	for _, c := range []struct {
		name, file, holder string
	}{
		{"secp256k1", "secp256k1-go-vp.json", legacyHolderSecp256k1},
		{"ed25519", "ed25519-go-vp.json", legacyHolderEd25519},
	} {
		t.Run(c.name, func(t *testing.T) {
			_, err := VerifyVP(readLegacyTestdata(t, c.file), vpHappyOpts(t, c.holder))
			wantRefusedAsUnknownContext(t, err, retiredKnownToAtumContextURL)
		})
	}
}

func TestVerifyVCProof_ALegacyCredentialRewrittenToTheCurrentContextFailsOnTheSignature(t *testing.T) {
	wantSignatureInvalid := func(t *testing.T, err error) {
		t.Helper()
		if !errors.Is(err, ErrVPVCSignatureInvalid) {
			t.Fatalf("err = %v, want ErrVPVCSignatureInvalid", err)
		}
		if errors.Is(err, lddataintegrity.ErrUnknownContext) || errors.Is(err, ErrMalformedQuote) {
			t.Errorf("err = %v, a resolution or shape failure; the rewritten URL must resolve and fail on the signature", err)
		}
	}

	t.Run("secp256k1 recovers a signer other than the issuer", func(t *testing.T) {
		legacy := readLegacyTestdata(t, "secp256k1-go-vc-proof.json")
		raw := rewriteToCurrentContext(t, legacy)

		err := VerifyVCProof(mustUnmarshalVC(t, raw), raw, legacyIssuerResolver(t, ProofTypeSecp256k1Recovery2020), VerifyVCProofOptions{Context: context.Background()})
		wantSignatureInvalid(t, err)

		before, _ := vcSigningInput(t, legacy, legacyLoader(t))
		after, proof := vcSigningInput(t, raw, nil)
		if bytes.Equal(before.SigningInput, after.SigningInput) {
			t.Fatal("the signing input is unchanged by the rewrite: the signature does not cover the credential vocabulary")
		}
		got := recoverLegacySigner(t, after, proof)
		if got == legacyHardhatAddress {
			t.Fatalf("recovered the issuer %s from the rewritten credential, want a different address", got.Hex())
		}
		if got == (common.Address{}) {
			t.Fatal("recovered the zero address, want the different but valid address a changed digest yields")
		}
	})

	t.Run("ed25519 rejects the signature", func(t *testing.T) {
		raw := rewriteToCurrentContext(t, readLegacyTestdata(t, "ed25519-go-vc-proof.json"))

		err := VerifyVCProof(mustUnmarshalVC(t, raw), raw, legacyIssuerResolver(t, ProofTypeEd25519Signature2020), VerifyVCProofOptions{Context: context.Background()})
		wantSignatureInvalid(t, err)

		hash, proof := vcSigningInput(t, raw, nil)
		if ed25519ProofVerifies(t, hash, proof) {
			t.Fatal("the issuer's ed25519 signature verifies over the rewritten credential")
		}
	})
}

// A presentation's holder signature covers the credentials it embeds
// (verifiableCredential is an @graph container), so rewriting an embedded
// legacy credential's context breaks the holder signature as well.
func TestVerifyVP_ALegacyCredentialRewrittenToTheCurrentContextFailsTheHolderSignature(t *testing.T) {
	t.Run("secp256k1 recovers a signer other than the holder", func(t *testing.T) {
		raw := rewriteToCurrentContext(t, readLegacyTestdata(t, "secp256k1-go-vp.json"))

		_, err := VerifyVP(raw, vpHappyOpts(t, legacyHolderSecp256k1))
		if !errors.Is(err, ErrVPSignerHolderMismatch) {
			t.Fatalf("err = %v, want ErrVPSignerHolderMismatch", err)
		}
		if errors.Is(err, lddataintegrity.ErrUnknownContext) {
			t.Errorf("err = %v, a resolution failure; the rewritten URL must resolve", err)
		}

		hash, proof := vpSigningInput(t, raw, nil)
		got := recoverLegacySigner(t, hash, proof)
		if got == legacyHardhatAddress {
			t.Fatalf("recovered the holder %s from the rewritten presentation, want a different address", got.Hex())
		}
		if got == (common.Address{}) {
			t.Fatal("recovered the zero address, want the different but valid address a changed digest yields")
		}
	})

	t.Run("ed25519 rejects the holder signature", func(t *testing.T) {
		raw := rewriteToCurrentContext(t, readLegacyTestdata(t, "ed25519-go-vp.json"))

		_, err := VerifyVP(raw, vpHappyOpts(t, legacyHolderEd25519))
		if err == nil {
			t.Fatal("VerifyVP accepted the rewritten presentation")
		}
		if errors.Is(err, lddataintegrity.ErrUnknownContext) || errors.Is(err, ErrMalformedProof) {
			t.Errorf("err = %v, want the ed25519 signature failure, which wraps no malformed-input sentinel", err)
		}
		if !strings.Contains(err.Error(), "signature verification failed") {
			t.Errorf("err = %v, want the ed25519 signature failure", err)
		}

		hash, proof := vpSigningInput(t, raw, nil)
		if ed25519ProofVerifies(t, hash, proof) {
			t.Fatal("the holder's ed25519 signature verifies over the rewritten presentation")
		}
	})
}
