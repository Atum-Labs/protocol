package ldverification

import (
	"crypto/ed25519"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	fq "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go/generated"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// goldenEd25519QuoteHash is quote-hash-golden.json's ed25519 entry. The proof
// message change leaves SigningInput, and so quote_hash, untouched.
const goldenEd25519QuoteHash = "0xdc2d2df1f96d4224cec32e0ff4fc4f1a50a983396d1dc123f00a38d355c6517a"

func zeroSeedEd25519Key() ed25519.PrivateKey {
	var seed [32]byte
	return ed25519.NewKeyFromSeed(seed[:])
}

// withProofValue re-signs raw's proof over msg with the zero seed key.
func withProofValue(t *testing.T, raw []byte, msg []byte) []byte {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	pv, err := lddataintegrity.EncodeEd25519ProofValue(ed25519.Sign(zeroSeedEd25519Key(), msg))
	if err != nil {
		t.Fatal(err)
	}
	doc["proof"].(map[string]any)["proofValue"] = pv
	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// The fixture is the default signer's output, a signature over the raw SigningInput. Verify accepts
// the raw and the Ed25519ProofMessage forms, rejects a signature over another input, and quote_hash
// stays keccak256(SigningInput) either way.
func TestVerify_Ed25519_AcceptsRawAndTextAndKeepsQuoteHash(t *testing.T) {
	signed := readFixture(t, "ed25519-go-signed.json")
	var quote fq.SchemaJson
	if err := json.Unmarshal(signed, &quote); err != nil {
		t.Fatal(err)
	}
	hash, err := canonicalSigningInput(signed, &quote, ProofTypeEd25519Signature2020)
	if err != nil {
		t.Fatal(err)
	}
	msg, err := lddataintegrity.Ed25519ProofMessage(hash.SigningInput)
	if err != nil {
		t.Fatal(err)
	}
	if got := withProofValue(t, signed, hash.SigningInput); !jsonEqual(t, got, signed) {
		t.Fatal("the fixture is not a signature over the raw SigningInput")
	}

	for name, form := range map[string][]byte{"text": msg, "raw": hash.SigningInput} {
		res, err := Verify(withProofValue(t, signed, form))
		if err != nil {
			t.Fatalf("Verify of the %s form: %v", name, err)
		}
		if res.QuoteHash != goldenEd25519QuoteHash {
			t.Errorf("%s form: QuoteHash = %s, want golden %s", name, res.QuoteHash, goldenEd25519QuoteHash)
		}
	}
	if want := "0x" + common.Bytes2Hex(crypto.Keccak256(hash.SigningInput)); goldenEd25519QuoteHash != want {
		t.Errorf("golden QuoteHash %s, want keccak256(SigningInput) %s", goldenEd25519QuoteHash, want)
	}
	got, err := ComputeQuoteHash(signed)
	if err != nil {
		t.Fatal(err)
	}
	if got != goldenEd25519QuoteHash {
		t.Errorf("ComputeQuoteHash = %s, want golden %s", got, goldenEd25519QuoteHash)
	}

	otherInput := append([]byte(nil), hash.SigningInput...)
	otherInput[0] ^= 0xff
	otherText, err := lddataintegrity.Ed25519ProofMessage(otherInput)
	if err != nil {
		t.Fatal(err)
	}
	for name, form := range map[string][]byte{"raw": otherInput, "text": otherText} {
		_, err = Verify(withProofValue(t, signed, form))
		if err == nil || !strings.Contains(err.Error(), "signature verification failed") {
			t.Fatalf("Verify of a %s signature over another SigningInput: err = %v, want the ed25519 signature failure", name, err)
		}
	}
}

// SignEd25519 and SignEd25519WithCreatedString sign the raw SigningInput by default and
// Ed25519ProofMessage(SigningInput) with TextProof; Verify accepts both.
func TestSignEd25519_TextProof(t *testing.T) {
	signed := readFixture(t, "ed25519-go-signed.json")
	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	proof := doc["proof"].(map[string]any)
	delete(doc, "proof")
	created, err := time.Parse(time.RFC3339Nano, proof["created"].(string))
	if err != nil {
		t.Fatal(err)
	}
	var quote fq.SchemaJson
	if err := json.Unmarshal(signed, &quote); err != nil {
		t.Fatal(err)
	}
	hash, err := canonicalSigningInput(signed, &quote, ProofTypeEd25519Signature2020)
	if err != nil {
		t.Fatal(err)
	}
	msg, err := lddataintegrity.Ed25519ProofMessage(hash.SigningInput)
	if err != nil {
		t.Fatal(err)
	}
	sign := map[string]func(SignEd25519Options) ([]byte, error){
		"SignEd25519": func(o SignEd25519Options) ([]byte, error) {
			o.Created = created
			return SignEd25519(doc, zeroSeedEd25519Key(), o)
		},
		"SignEd25519WithCreatedString": func(o SignEd25519Options) ([]byte, error) {
			return SignEd25519WithCreatedString(doc, zeroSeedEd25519Key(), o, proof["created"].(string))
		},
	}
	for name, fn := range sign {
		for _, tc := range []struct {
			textProof bool
			want      []byte
		}{{false, hash.SigningInput}, {true, msg}} {
			got, err := fn(SignEd25519Options{
				VerificationMethod: proof["verificationMethod"].(string),
				ProofPurpose:       proof["proofPurpose"].(string),
				TextProof:          tc.textProof,
			})
			if err != nil {
				t.Fatal(err)
			}
			if !jsonEqual(t, got, withProofValue(t, signed, tc.want)) {
				t.Fatalf("%s TextProof=%v signed the wrong message", name, tc.textProof)
			}
			if _, err := Verify(got); err != nil {
				t.Fatalf("Verify of the %s TextProof=%v quote: %v", name, tc.textProof, err)
			}
		}
	}
}

func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if err := json.Unmarshal(a, &x); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &y); err != nil {
		t.Fatal(err)
	}
	ja, _ := json.Marshal(x)
	jb, _ := json.Marshal(y)
	return string(ja) == string(jb)
}

func TestVerifyVP_Ed25519_AcceptsRawAndText(t *testing.T) {
	const holder = "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS"
	raw := readFixture(t, "ed25519-go-vp.json")
	hash, _ := vpSigningInput(t, raw, nil)
	msg, err := lddataintegrity.Ed25519ProofMessage(hash.SigningInput)
	if err != nil {
		t.Fatal(err)
	}

	for name, form := range map[string][]byte{"fixture": nil, "raw": hash.SigningInput, "text": msg} {
		doc := raw
		if form != nil {
			doc = withProofValue(t, raw, form)
		}
		if _, err := VerifyVP(doc, vpHappyOpts(t, holder)); err != nil {
			t.Fatalf("VerifyVP of the %s form: %v", name, err)
		}
	}
	other := append([]byte(nil), hash.SigningInput...)
	other[0] ^= 0xff
	_, err = VerifyVP(withProofValue(t, raw, other), vpHappyOpts(t, holder))
	if err == nil || !strings.Contains(err.Error(), "signature verification failed") {
		t.Fatalf("VerifyVP of a signature over another SigningInput: err = %v, want the ed25519 signature failure", err)
	}
}

// SignVPEd25519 and SignVPEd25519WithCreatedString sign the raw SigningInput by default and
// Ed25519ProofMessage(SigningInput) with TextProof.
func TestSignVPEd25519_TextProof(t *testing.T) {
	const holder = "did:pkh:solana:devnet:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS"
	raw := readFixture(t, "ed25519-go-vp.json")
	var doc struct {
		VerifiableCredential []json.RawMessage `json:"verifiableCredential"`
		Proof                map[string]string `json:"proof"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	created, err := time.Parse(time.RFC3339Nano, doc.Proof["created"])
	if err != nil {
		t.Fatal(err)
	}
	hash, _ := vpSigningInput(t, raw, nil)
	msg, err := lddataintegrity.Ed25519ProofMessage(hash.SigningInput)
	if err != nil {
		t.Fatal(err)
	}
	sign := map[string]func(SignVPEd25519Options) ([]byte, error){
		"SignVPEd25519": func(o SignVPEd25519Options) ([]byte, error) {
			o.Created = created
			return SignVPEd25519(doc.VerifiableCredential, zeroSeedEd25519Key(), o)
		},
		"SignVPEd25519WithCreatedString": func(o SignVPEd25519Options) ([]byte, error) {
			return SignVPEd25519WithCreatedString(doc.VerifiableCredential, zeroSeedEd25519Key(), o, doc.Proof["created"])
		},
	}
	for name, fn := range sign {
		for _, tc := range []struct {
			textProof bool
			want      []byte
		}{{false, hash.SigningInput}, {true, msg}} {
			got, err := fn(SignVPEd25519Options{
				Holder:             holder,
				VerificationMethod: doc.Proof["verificationMethod"],
				Challenge:          doc.Proof["challenge"],
				Domain:             doc.Proof["domain"],
				TextProof:          tc.textProof,
			})
			if err != nil {
				t.Fatal(err)
			}
			if !jsonEqual(t, got, withProofValue(t, raw, tc.want)) {
				t.Fatalf("%s TextProof=%v signed the wrong message", name, tc.textProof)
			}
		}
	}
}
