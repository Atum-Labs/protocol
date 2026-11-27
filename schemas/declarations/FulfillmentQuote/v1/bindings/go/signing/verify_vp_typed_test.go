package ldverification

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/crypto"
)

// The typed form of the PaymentRequestEnvelope holder proof: what a payer's wallet signs. These
// pin that a verifier that accepts it verifies it, that one that doesn't refuses it, and that it
// binds exactly what the raw form binds.

const typedPREContextURL = "https://schemas.atum.network/declarations/PaymentRequestEnvelope/v1/context.jsonld"

func typedPREOptions(t *testing.T, holder string) SignVPOptions {
	t.Helper()
	return SignVPOptions{
		Holder:                holder,
		VerificationMethod:    holder + "#blockchainAccountId",
		Challenge:             "req-fixture-1",
		Domain:                "did:web:settler.atum.network",
		DeclarationType:       lddataintegrity.PaymentRequestEnvelopeType,
		EnvelopeContextURL:    typedPREContextURL,
		ExtraEnvelopeContexts: map[string]any{typedPREContextURL: preConformanceContext(t)},
	}
}

func typedPRECredentials(t *testing.T, holder string) []json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"@context":          []any{W3CVCV1ContextURL, "https://schemas.atum.xyz/credentials/known-to-atum/v1"},
		"id":                "urn:uuid:5b5d7e0e-9d27-4f1f-a5db-3a52cfb24d2f",
		"type":              []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
		"issuer":            "did:web:atumlabs.xyz",
		"issuanceDate":      "2026-01-01T00:00:00Z",
		"credentialSubject": map[string]any{"id": holder, "role": "psp"},
		"proof": map[string]any{
			"type": ProofTypeSecp256k1Recovery2020, "created": "2026-01-01T00:00:00Z",
			"verificationMethod": "did:web:atumlabs.xyz#key-1", "proofPurpose": "assertionMethod",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return []json.RawMessage{raw}
}

func signTypedPRE(t *testing.T, opts SignVPOptions) ([]byte, string) {
	t.Helper()
	priv, err := crypto.HexToECDSA("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	if err != nil {
		t.Fatal(err)
	}
	signer, err := lddataintegrity.NewECDSASigner(priv)
	if err != nil {
		t.Fatal(err)
	}
	signed, err := SignVPTypedWithSignerAndCreatedString(typedPRECredentials(t, opts.Holder), signer, opts, "2026-04-01T00:00:00.000Z")
	if err != nil {
		t.Fatalf("SignVPTypedWithSignerAndCreatedString: %v", err)
	}
	return signed, strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
}

const typedHolder = "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"

func acceptingTyped(t *testing.T) VerifyVPOptions {
	t.Helper()
	opts := vpHappyOptsPRE(t, typedHolder)
	opts.AcceptPaymentRequestEnvelopeTypedProof = true
	return opts
}

func TestTypedPRE_VerifiesWhereAccepted(t *testing.T) {
	signed, address := signTypedPRE(t, typedPREOptions(t, typedHolder))
	res, err := VerifyVP(signed, acceptingTyped(t))
	if err != nil {
		t.Fatalf("VerifyVP: %v", err)
	}
	if !strings.EqualFold(res.SignerAddress.Hex(), address) {
		t.Fatalf("recovered %s, want %s", res.SignerAddress.Hex(), address)
	}
}

func TestTypedPRE_RefusedWhereNotAccepted(t *testing.T) {
	signed, _ := signTypedPRE(t, typedPREOptions(t, typedHolder))
	_, err := VerifyVP(signed, vpHappyOptsPRE(t, typedHolder))
	if !errors.Is(err, ErrVPSignerHolderMismatch) {
		t.Fatalf("VerifyVP without the typed form = %v, want ErrVPSignerHolderMismatch", err)
	}
}

// The typed form is a PaymentRequestEnvelope's alone: an envelope that does not declare that type,
// signed over the same typed struct, is refused even by a verifier that accepts the typed form.
func TestTypedPRE_OnlyForADeclaredPaymentRequestEnvelope(t *testing.T) {
	priv, err := crypto.HexToECDSA("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	if err != nil {
		t.Fatal(err)
	}
	signer, _ := lddataintegrity.NewECDSASigner(priv)
	// Everything else valid, so only the declaration can refuse it.
	notPRE := typedPREOptions(t, typedHolder)
	notPRE.DeclarationType = "FulfillmentQuoteEnvelope"
	if _, err := SignVPTypedWithSignerAndCreatedString(typedPRECredentials(t, typedHolder), signer, notPRE, "2026-04-01T00:00:00.000Z"); err == nil ||
		!strings.Contains(err.Error(), "DeclarationType") {
		t.Fatalf("SignVPTyped for a FulfillmentQuoteEnvelope = %v, want a refusal naming DeclarationType", err)
	}
	opts := typedPREOptions(t, typedHolder)
	opts.DeclarationType = ""
	signed, err := signVP(typedPRECredentials(t, typedHolder), signer, opts, "2026-04-01T00:00:00.000Z", func(h HashResult) ([]byte, error) {
		return lddataintegrity.PaymentRequestEnvelopeProofTypedDigest(h.ProofHash, h.DocHash)
	})
	if err != nil {
		t.Fatal(err)
	}
	verify := acceptingTyped(t)
	verify.ExpectedDeclarationType = ""
	if _, err := VerifyVP(signed, verify); !errors.Is(err, ErrVPSignerHolderMismatch) {
		t.Fatalf("an undeclared envelope's typed proof: VerifyVP = %v, want ErrVPSignerHolderMismatch", err)
	}
}

// The typed envelope is the raw envelope with only the signature changed.
func TestTypedPRE_DiffersFromTheRawFormOnlyInItsSignature(t *testing.T) {
	opts := typedPREOptions(t, typedHolder)
	typed, _ := signTypedPRE(t, opts)
	priv, _ := crypto.HexToECDSA("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	raw, err := SignVPWithCreatedString(typedPRECredentials(t, typedHolder), priv, opts, "2026-04-01T00:00:00.000Z")
	if err != nil {
		t.Fatal(err)
	}
	strip := func(b []byte) (string, string) {
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		proof := m["proof"].(map[string]any)
		jws := proof["jws"].(string)
		delete(proof, "jws")
		out, _ := json.Marshal(m)
		return string(out), jws
	}
	typedBody, typedJWS := strip(typed)
	rawBody, rawJWS := strip(raw)
	if typedBody != rawBody {
		t.Fatalf("the typed envelope differs beyond its signature:\n typed %s\n raw   %s", typedBody, rawBody)
	}
	if typedJWS == rawJWS {
		t.Fatal("the typed and raw envelopes carry the same signature")
	}
}

// What the raw holder proof binds, the typed one binds: the challenge (the request_hash), the
// domain, proof.created, the holder and the credentials. Each changed after signing is refused.
func TestTypedPRE_BindsWhatTheRawFormBinds(t *testing.T) {
	signed, _ := signTypedPRE(t, typedPREOptions(t, typedHolder))
	for _, tc := range []struct {
		name   string
		mutate func(m map[string]any, opts *VerifyVPOptions)
	}{
		{"challenge", func(m map[string]any, o *VerifyVPOptions) {
			m["proof"].(map[string]any)["challenge"] = "req-fixture-2"
			o.ExpectedChallenge = "req-fixture-2"
		}},
		{"domain", func(m map[string]any, o *VerifyVPOptions) {
			m["proof"].(map[string]any)["domain"] = "did:web:other.atum.network"
			o.ExpectedDomain = "did:web:other.atum.network"
		}},
		{"created", func(m map[string]any, _ *VerifyVPOptions) {
			m["proof"].(map[string]any)["created"] = "2026-04-01T00:00:01.000Z"
		}},
		{"credential id", func(m map[string]any, _ *VerifyVPOptions) {
			m["verifiableCredential"].([]any)[0].(map[string]any)["id"] = "urn:uuid:00000000-0000-0000-0000-000000000000"
		}},
		{"credential issuer", func(m map[string]any, _ *VerifyVPOptions) {
			m["verifiableCredential"].([]any)[0].(map[string]any)["issuer"] = "did:web:example.com"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var m map[string]any
			if err := json.Unmarshal(signed, &m); err != nil {
				t.Fatal(err)
			}
			opts := acceptingTyped(t)
			tc.mutate(m, &opts)
			mutated, _ := json.Marshal(m)
			if _, err := VerifyVP(mutated, opts); err == nil {
				t.Fatalf("changing %s after a typed holder signature still verifies", tc.name)
			}
		})
	}
}

// signPREWith signs the PRE as typedPREOptions describes, over the digest digestOf derives from its
// hashes: a holder signature in some other typed form than the envelope's own.
func signPREWith(t *testing.T, digestOf lddataintegrity.TypedProofDigest) []byte {
	t.Helper()
	priv, err := crypto.HexToECDSA("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	if err != nil {
		t.Fatal(err)
	}
	signer, _ := lddataintegrity.NewECDSASigner(priv)
	signed, err := signVP(typedPRECredentials(t, typedHolder), signer, typedPREOptions(t, typedHolder), "2026-04-01T00:00:00.000Z",
		func(h HashResult) ([]byte, error) { return digestOf(h.ProofHash, h.DocHash) })
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

// The inner request's typed struct is not the envelope's: a PaymentRequestProof signature over the
// envelope's hashes is refused even where the envelope's typed form is accepted.
func TestTypedPRE_RefusesAPaymentRequestProofSignature(t *testing.T) {
	signed := signPREWith(t, lddataintegrity.PaymentRequestProofTypedDigest)
	if _, err := VerifyVP(signed, acceptingTyped(t)); !errors.Is(err, ErrVPSignerHolderMismatch) {
		t.Fatalf("a PaymentRequestProof-signed envelope: VerifyVP = %v, want ErrVPSignerHolderMismatch", err)
	}
}

// The settler identity form is a settler's. An envelope that declares PaymentRequestEnvelope signed in
// it is refused, whether or not the verifier accepts the payer's typed form.
func TestTypedPRE_RefusesASettlerProofSignature(t *testing.T) {
	signed := signPREWith(t, lddataintegrity.SettlerProofTypedDigest)
	for _, opts := range []VerifyVPOptions{vpHappyOptsPRE(t, typedHolder), acceptingTyped(t)} {
		if _, err := VerifyVP(signed, opts); !errors.Is(err, ErrVPSignerHolderMismatch) {
			t.Fatalf("a SettlerProof-signed PaymentRequestEnvelope (accept typed=%v): VerifyVP = %v, want ErrVPSignerHolderMismatch",
				opts.AcceptPaymentRequestEnvelopeTypedProof, err)
		}
	}
}

// JSON-LD reads `"type": "PaymentRequestEnvelope"` like the one-element array, so a holder signature
// over one covers the other. Go decodes `type` as a []string and refuses the bare string while
// decoding, before any signature check. The TypeScript verifier refuses it too
// (sign-vp-typed.test.ts).
func TestVerifyVP_RefusesABareStringType(t *testing.T) {
	priv, err := crypto.HexToECDSA("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
	if err != nil {
		t.Fatal(err)
	}
	signed, err := SignVPWithCreatedString(typedPRECredentials(t, typedHolder), priv, typedPREOptions(t, typedHolder), "2026-04-01T00:00:00.000Z")
	if err != nil {
		t.Fatal(err)
	}
	opts := acceptingTyped(t)
	if _, err := VerifyVP(signed, opts); err != nil {
		t.Fatalf("control: the array-typed envelope: VerifyVP = %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(signed, &m); err != nil {
		t.Fatal(err)
	}
	m["type"] = lddataintegrity.PaymentRequestEnvelopeType
	bare, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	opts.ExpectedDeclarationType = ""
	if _, err := VerifyVP(bare, opts); !errors.Is(err, ErrMalformedQuote) {
		t.Fatalf("a bare-string type: VerifyVP = %v, want ErrMalformedQuote", err)
	}
}
