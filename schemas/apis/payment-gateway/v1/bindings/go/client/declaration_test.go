package pgclient

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	lddataintegrity "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/common/ld-data-integrity/go"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"
)

// The fixture's own signing key, so the verificationMethod below names the key that signs.
const (
	fixtureKey     = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
	fixtureChainID = "eip155:1"
	fixtureAccount = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
)

// fixtureCreated pins proof.created. It is inside the signed payload, so leaving it to the
// clock would make every signature in these tests differ from the last.
var fixtureCreated = time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)

func testSigner(t *testing.T) lddataintegrity.Secp256k1Signer {
	t.Helper()
	priv, err := crypto.HexToECDSA(fixtureKey)
	require.NoError(t, err)
	signer, err := lddataintegrity.NewECDSASigner(priv)
	require.NoError(t, err)
	return signer
}

func testOptions() DeclarationOptions {
	return DeclarationOptions{
		VerificationMethod: VerificationMethodForAccount(fixtureChainID, fixtureAccount),
		Created:            fixtureCreated,
	}
}

// unsignedFixture is the committed conformance fixture with the signing artifacts removed,
// which is the shape the signer expects: a request carrying neither @context nor proof.
func unsignedFixture(t *testing.T) map[string]any {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "..", "..", "..", "schemas", "declarations", "PaymentRequest", "v1", "conformance",
		"fixtures", "secp256k1-go-signed.json")
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	var doc map[string]any
	require.NoError(t, json.Unmarshal(raw, &doc))
	delete(doc, "proof")
	delete(doc, "@context")
	return doc
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	require.NoError(t, err)
	return raw
}

func proofOf(t *testing.T, signed []byte) map[string]any {
	t.Helper()
	var doc map[string]any
	require.NoError(t, json.Unmarshal(signed, &doc))
	proof, ok := doc["proof"].(map[string]any)
	require.True(t, ok, "the signed document must carry a proof object")
	return proof
}

// The typed helper reaches the signer by marshalling through *PaymentRequest. If that round
// trip renames, reorders or drops anything the canonicalized bytes change and so does the
// signature — silently, because both paths still return a valid-looking document. This is
// the guard.
func TestSignDeclaration_TypedPathMatchesTheRawJSONPath(t *testing.T) {
	doc := unsignedFixture(t)
	raw := mustJSON(t, doc)

	var typed PaymentRequest
	require.NoError(t, json.Unmarshal(raw, &typed),
		"the fixture must round-trip into the generated type")

	fromJSON, err := SignDeclarationJSON(raw, testSigner(t), testOptions())
	require.NoError(t, err)
	fromTyped, err := SignDeclaration(&typed, testSigner(t), testOptions())
	require.NoError(t, err)

	require.JSONEq(t, string(fromJSON), string(fromTyped),
		"signing the typed request must produce the same document as signing its JSON")
	require.Equal(t, proofOf(t, fromJSON)["jws"], proofOf(t, fromTyped)["jws"],
		"same request, same key, same instant: the signature must be identical, or the typed "+
			"round trip altered what got canonicalized")
}

// What the two entry points do with a field the generated bindings do not model. Asserted
// rather than assumed, because it decides which entry point a caller holding received bytes
// should use.
func TestSignDeclarationJSON_KeepsFieldsTheBindingsDoNotModel(t *testing.T) {
	doc := unsignedFixture(t)
	doc["a_field_these_bindings_predate"] = "keep me"
	raw := mustJSON(t, doc)

	fromJSON, err := SignDeclarationJSON(raw, testSigner(t), testOptions())
	require.NoError(t, err)

	var out map[string]any
	require.NoError(t, json.Unmarshal(fromJSON, &out))
	require.Equal(t, "keep me", out["a_field_these_bindings_predate"],
		"the raw path must carry every field into the signed document")

	var typed PaymentRequest
	require.NoError(t, json.Unmarshal(raw, &typed))
	fromTyped, err := SignDeclaration(&typed, testSigner(t), testOptions())
	require.NoError(t, err)

	var typedOut map[string]any
	require.NoError(t, json.Unmarshal(fromTyped, &typedOut))
	require.NotContains(t, typedOut, "a_field_these_bindings_predate",
		"the typed path drops what the bindings do not model — this is why a caller signing "+
			"bytes it received must use SignDeclarationJSON")
}

// Whether an unmodelled field is actually COVERED by the proof depends on the @context:
// URDNA2015 drops terms the context does not define, so a preserved field is not necessarily
// a signed one. Recording which it is, since the doc comments claim it.
func TestSignDeclarationJSON_UndefinedTermsAreNotCoveredByTheProof(t *testing.T) {
	base := unsignedFixture(t)
	withExtra := unsignedFixture(t)
	withExtra["a_field_these_bindings_predate"] = "keep me"

	signedBase, err := SignDeclarationJSON(mustJSON(t, base), testSigner(t), testOptions())
	require.NoError(t, err)
	signedExtra, err := SignDeclarationJSON(mustJSON(t, withExtra), testSigner(t), testOptions())
	require.NoError(t, err)

	require.Equal(t, proofOf(t, signedBase)["jws"], proofOf(t, signedExtra)["jws"],
		"a term the @context does not define is dropped by canonicalization, so it rides in "+
			"the document without being covered by the signature. A caller that needs a new "+
			"field signed must add it to the context, not just to the payload.")
}

func TestSignDeclaration_UsesAssertionMethodAsTheProofPurpose(t *testing.T) {
	var typed PaymentRequest
	require.NoError(t, json.Unmarshal(mustJSON(t, unsignedFixture(t)), &typed))

	signed, err := SignDeclaration(&typed, testSigner(t), testOptions())
	require.NoError(t, err)

	// Pins the constant this package supplies on the caller's behalf against the signer's
	// own validation: the signer accepts exactly one value, so if it ever changes, signing
	// starts failing here instead of emitting a proof the verifier rejects.
	require.Equal(t, "assertionMethod", proofOf(t, signed)["proofPurpose"])
	require.Equal(t, "EcdsaSecp256k1RecoverySignature2020", proofOf(t, signed)["type"])
	require.Equal(t, VerificationMethodForAccount(fixtureChainID, fixtureAccount),
		proofOf(t, signed)["verificationMethod"])
}

func TestSignDeclaration_ReplacesAnExistingProofRatherThanNesting(t *testing.T) {
	var typed PaymentRequest
	require.NoError(t, json.Unmarshal(mustJSON(t, unsignedFixture(t)), &typed))

	once, err := SignDeclaration(&typed, testSigner(t), testOptions())
	require.NoError(t, err)

	// Re-sign the already-signed document, which is what a caller retrying with fresh
	// deadlines does.
	twice, err := SignDeclarationJSON(once, testSigner(t), testOptions())
	require.NoError(t, err)

	proof := proofOf(t, twice)
	require.NotContains(t, proof, "proof", "a re-sign must not nest one proof inside another")
	require.JSONEq(t, string(once), string(twice),
		"re-signing the same request with the same key and instant must be idempotent")
}

func TestSignDeclaration_Rejects(t *testing.T) {
	var typed PaymentRequest
	require.NoError(t, json.Unmarshal(mustJSON(t, unsignedFixture(t)), &typed))

	t.Run("nil request", func(t *testing.T) {
		_, err := SignDeclaration(nil, testSigner(t), testOptions())
		require.Error(t, err)
	})
	t.Run("nil signer", func(t *testing.T) {
		_, err := SignDeclaration(&typed, nil, testOptions())
		require.Error(t, err)
	})
	t.Run("missing verification method", func(t *testing.T) {
		_, err := SignDeclaration(&typed, testSigner(t), DeclarationOptions{Created: fixtureCreated})
		require.Error(t, err, "an unnamed signing key must be refused, not defaulted")
	})
	t.Run("not a JSON object", func(t *testing.T) {
		_, err := SignDeclarationJSON([]byte("[1,2,3]"), testSigner(t), testOptions())
		require.Error(t, err)
	})
}

func TestDIDHelpers(t *testing.T) {
	// Literal expectations: derived ones would just restate the implementation.
	require.Equal(t, "did:pkh:eip155:1:0xabc", DIDForAccount("eip155:1", "0xabc"))
	require.Equal(t, "did:pkh:eip155:1:0xabc#blockchainAccountId",
		VerificationMethodForAccount("eip155:1", "0xabc"))
	require.Equal(t, "did:pkh:solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:SoME1",
		DIDForAccount("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "SoME1"))
}

// --- JSON-LD context isolation ------------------------------------------------------
//
// The @context decides what each term MEANS, so a context an attacker can supply is a context
// that can change what a signature covers. The TypeScript half pins the same two properties;
// they had diverged here, with TS treating a caller-supplied @context as a default while this
// half replaced it.

func TestSignDeclaration_ReplacesACallerSuppliedContext(t *testing.T) {
	doc := unsignedFixture(t)
	doc["@context"] = []any{"https://attacker.example/context.jsonld"}

	signed, err := SignDeclarationJSON(mustJSON(t, doc), testSigner(t), testOptions())
	require.NoError(t, err, "a hostile @context must be replaced, not resolved")

	var out map[string]any
	require.NoError(t, json.Unmarshal(signed, &out))
	raw, err := json.Marshal(out["@context"])
	require.NoError(t, err)
	require.NotContains(t, string(raw), "attacker.example",
		"the signer emits the canonical context array and discards what came in; merging would "+
			"let a caller introduce term definitions into the document it then signs")
	require.Contains(t, string(raw), "/declarations/PaymentRequest/v1/context.jsonld")
}

func TestSignDeclaration_ContextReplacementMakesTheInputIrrelevant(t *testing.T) {
	bare := unsignedFixture(t)
	hostile := unsignedFixture(t)
	hostile["@context"] = []any{"https://attacker.example/context.jsonld"}

	fromBare, err := SignDeclarationJSON(mustJSON(t, bare), testSigner(t), testOptions())
	require.NoError(t, err)
	fromHostile, err := SignDeclarationJSON(mustJSON(t, hostile), testSigner(t), testOptions())
	require.NoError(t, err)

	require.Equal(t, proofOf(t, fromBare)["jws"], proofOf(t, fromHostile)["jws"],
		"the same content must produce the same signature whatever @context arrived with it; "+
			"if these differ, a caller-supplied context reached canonicalization")
}

func TestSignDeclaration_StaleProofOnTheInputIsNotSigned(t *testing.T) {
	bare := unsignedFixture(t)
	withProof := unsignedFixture(t)
	withProof["proof"] = map[string]any{
		"type": "EcdsaSecp256k1RecoverySignature2020",
		"jws":  "not-a-real-signature",
	}

	fromBare, err := SignDeclarationJSON(mustJSON(t, bare), testSigner(t), testOptions())
	require.NoError(t, err)
	fromStale, err := SignDeclarationJSON(mustJSON(t, withProof), testSigner(t), testOptions())
	require.NoError(t, err)

	require.Equal(t, proofOf(t, fromBare)["jws"], proofOf(t, fromStale)["jws"],
		"re-signing must not cover the previous proof")
}

// A caller who omits Created must get a usable proof, not one dated year 1.
//
// This is the case every other test misses: they all pass Created: fixtureCreated, because a
// pinned instant is what makes a signature reproducible. So the zero value -- the one a customer
// reaches by simply not setting a struct field -- was never exercised. The resulting proof is
// cryptographically valid and verifies locally; it fails only at a gateway's freshness window,
// with an error that never mentions created.
func TestSignDeclaration_DefaultsCreatedToNow(t *testing.T) {
	signer := testSigner(t)

	before := time.Now().UTC().Add(-time.Second)
	signed, err := SignDeclarationJSON(
		[]byte(`{"version":"1.0","request_id":"req-no-created"}`),
		signer,
		// Created deliberately omitted — this is the whole point of the test.
		DeclarationOptions{VerificationMethod: VerificationMethodForAccount(fixtureChainID, fixtureAccount)},
	)
	if err != nil {
		t.Fatalf("SignDeclarationJSON: %v", err)
	}
	after := time.Now().UTC().Add(time.Second)

	var doc struct {
		Proof struct {
			Created string `json:"created"`
		} `json:"proof"`
	}
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if strings.HasPrefix(doc.Proof.Created, "0001-01-01") {
		t.Fatalf("proof.created is the zero time (%q) — a caller omitting Created got a year-1 proof", doc.Proof.Created)
	}
	got, err := time.Parse("2006-01-02T15:04:05.000Z", doc.Proof.Created)
	if err != nil {
		t.Fatalf("proof.created %q is not the expected format: %v", doc.Proof.Created, err)
	}
	if got.Before(before) || got.After(after) {
		t.Fatalf("proof.created %s is outside [%s, %s]", got, before, after)
	}
}
