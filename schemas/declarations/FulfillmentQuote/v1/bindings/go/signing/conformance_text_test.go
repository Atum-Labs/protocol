package ldverification

import (
	"bytes"
	"encoding/json"
	"testing"
)

// The *-text fixtures are the TextProof variants of the ed25519 quote, VP and
// PRE VP fixtures: same document, proof over Ed25519ProofMessage(SigningInput).

const zeroSeedHolder = "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS"

func proofValueOf(t *testing.T, raw []byte) string {
	t.Helper()
	var doc struct {
		Proof struct {
			ProofValue string `json:"proofValue"`
		} `json:"proof"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Proof.ProofValue
}

func TestConformance_Ed25519TextFixtures(t *testing.T) {
	for _, kind := range []string{"signed", "vp", "pre-vp"} {
		t.Run(kind, func(t *testing.T) {
			goText := readFixture(t, "ed25519-go-"+kind+"-text.json")
			tsText := readFixture(t, "ed25519-ts-"+kind+"-text.json")
			if !bytes.Equal(goText, tsText) {
				t.Fatalf("ed25519 %s text fixtures byte-diverged", kind)
			}
			raw := readFixture(t, "ed25519-go-"+kind+".json")
			rawPV, textPV := proofValueOf(t, raw), proofValueOf(t, tsText)
			if rawPV == textPV {
				t.Fatal("text fixture carries the raw proof")
			}
			if !bytes.Equal(bytes.Replace(tsText, []byte(textPV), []byte(rawPV), 1), raw) {
				t.Fatal("text fixture differs from the raw one beyond proofValue")
			}

			var pub []byte
			switch kind {
			case "signed":
				res, err := Verify(tsText)
				if err != nil {
					t.Fatalf("Verify: %v", err)
				}
				pub = mustEd25519Signer(t, res).PublicKey
				textHash, err := ComputeQuoteHash(tsText)
				if err != nil {
					t.Fatal(err)
				}
				rawHash, err := ComputeQuoteHash(raw)
				if err != nil {
					t.Fatal(err)
				}
				if textHash != rawHash {
					t.Fatalf("quote_hash %s != raw %s", textHash, rawHash)
				}
			case "vp":
				res, err := VerifyVP(tsText, vpHappyOpts(t, zeroSeedHolder))
				if err != nil {
					t.Fatalf("VerifyVP: %v", err)
				}
				pub = res.Ed25519PublicKey
			case "pre-vp":
				res, err := VerifyVP(tsText, vpHappyOptsPRE(t, zeroSeedHolder))
				if err != nil {
					t.Fatalf("VerifyVP (PRE): %v", err)
				}
				pub = res.Ed25519PublicKey
			}
			const expectedPubHex = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29"
			if got := bytesToLowerHex(pub); got != expectedPubHex {
				t.Fatalf("Ed25519 public key = %s, want %s", got, expectedPubHex)
			}
		})
	}
}
