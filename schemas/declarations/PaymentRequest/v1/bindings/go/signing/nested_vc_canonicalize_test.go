package ldverification

import (
	"crypto/ecdsa"
	"encoding/json"
	"strings"
	"testing"
	"time"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"

	"github.com/ethereum/go-ethereum/crypto"
)

// nestedVCAuth builds an `originator_auth` / `sender_auth.verifiable_credential`
// value shaped exactly like the one a producer emits in a real
// PaymentRequest (alongside the issued KnownToAtum VC). The load-bearing
// detail is the NESTED `@context` carrying the W3C VC v1 URL — that nested
// context is what json-gold layers on top of the outer PaymentRequest context
// during URDNA2015 expansion, and it is what triggered the
// "protected term redefinition" failure in end-to-end runs.
//
// Minimal fixtures that carry a sender_auth with NO nested VC @context mask
// this bug.
func nestedVCAuth(holderDID string) map[string]any {
	return map[string]any{
		"signature":              "0xsig",
		"verification_method_id": "did:web:atumlabs.xyz#key-1",
		"verifiable_credential": map[string]any{
			// The nested W3C VC @context — the real request layers BOTH the
			// W3C VC v1 URL and known-to-atum here. URDNA2015 processes this
			// nested context against the active outer PaymentRequest context.
			"@context": []any{
				lddataintegrity.W3CVCV1ContextURL,
				lddataintegrity.KnownToAtumV1ContextURL,
			},
			"id":           "urn:uuid:7a3e9c01-2b5d-4f8a-9e7c-1d4a8c2b3f5e",
			"type":         []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
			"issuer":       "did:web:atumlabs.xyz",
			"issuanceDate": "2026-01-01T00:00:00Z",
			"credentialSubject": map[string]any{
				"id":   holderDID,
				"role": "psp",
			},
			"proof": map[string]any{
				"type":               "EcdsaSecp256k1RecoverySignature2020",
				"created":            "2026-01-01T00:00:00Z",
				"verificationMethod": "did:web:atumlabs.xyz#key-1",
				"proofPurpose":       "assertionMethod",
			},
		},
	}
}

// innerDocWithNestedVC returns a PaymentRequest payload that mirrors the
// real inner doc the originator-PRE producer signs: it RETAINS the
// legacy auth carriers (`sender_auth.verifiable_credential` +
// `originator_auth`) whose values nest a W3C Verifiable Credential with its
// own @context. This is the exact shape a producer that only deletes
// @context / proof / presentation yields, so the nested-VC contexts survive
// into canonicalization.
func innerDocWithNestedVC(holderDID, address string) map[string]any {
	return map[string]any{
		"version":    "1.0",
		"request_id": "req-pr-nested-vc",
		"source": map[string]any{
			"asset_identifier": "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A",
			"account":          address,
		},
		"destination": []any{
			map[string]any{"asset_identifier": "eip155:1/erc20:0xbbb", "account": "0x0000000000000000000000000000000000000002"},
		},
		"fulfillment_amount":      "1000000",
		"quote_deadline":          "2030-01-01T00:00:00Z",
		"fulfillment_deadline":    "2030-01-02T00:00:00Z",
		"escrow_contract_address": "0x0000000000000000000000000000000000000003",
		"fulfillment_verifier":    map[string]any{"account": "0x0000000000000000000000000000000000000004", "endpoint": "https://veri-fill.example.com"},
		"sender_auth": map[string]any{
			"message_scheme": "EVM_PERMIT2",
			"signed_messages": []any{
				map[string]any{"message": "0xdead", "message_prehash": "{}", "signature": "0xbeef"},
			},
			// The EVM_PERMIT2 carrier can itself nest a VC; include one to
			// match the broadest real shape.
			"verifiable_credential": nestedVCAuth(holderDID),
		},
		"originator_auth": nestedVCAuth(holderDID),
	}
}

// TestSign_InnerDocWithNestedVCContext_Canonicalizes is the nested-VC
// reproduction. Before the credential-strip fix it FAILS at
// SignPaymentRequest with:
//
//	sign: hash: HashDocument: canonicalize document: lddataintegrity.Canonicalize:
//	protected term redefinition: invalid JSON-LD syntax; tried to redefine a protected term
//
// because the nested VC's @context (W3C VC v1, @protected) collides with the
// @protected PaymentRequest context during URDNA2015 expansion. The fix
// (per the design directive) keeps credentials OUT of the inner PaymentRequest
// entirely: stripDocForHash / documentForCanonicalization strip originator_auth
// + sender_auth.verifiable_credential (and the already-stripped
// verifiableCredential / presentation), so no nested VC @context reaches
// canonicalization. Credentials live ONLY in the PaymentRequestEnvelope (PRE).
//
// Asserts the doc signs AND the recovered signer equals the holder — the inner
// proof remains load-bearing over the PAYMENT (source/destination/amount/
// sender_auth transfer authorization), just not over any credential.
func TestSign_InnerDocWithNestedVCContext_Canonicalizes(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holderDID := "did:pkh:eip155:1:" + address

	signed := signInnerWithNestedVC(t, priv, address, holderDID)

	res, err := VerifyPaymentRequest(signed)
	if err != nil {
		t.Fatalf("verify inner doc carrying nested VC: %v", err)
	}
	if got := strings.ToLower(mustSecp256k1Signer(t, res).Hex()); got != address {
		t.Fatalf("recovered signer = %s, want holder %s", got, address)
	}
}

// signInnerWithNestedVC drives the production SignPaymentRequest path over
// the nested-VC inner doc. Isolated so the failing-pre-fix assertion has a
// single, named choke point.
func signInnerWithNestedVC(t *testing.T, priv *ecdsa.PrivateKey, address, holderDID string) []byte {
	t.Helper()
	doc := innerDocWithNestedVC(holderDID, address)
	signed, err := SignPaymentRequest(doc, priv, SignOptions{
		VerificationMethod: "did:pkh:eip155:1:" + address + "#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
		Created:            time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("SignPaymentRequest over inner doc with nested VC @context failed "+
			"(this is the nested-VC repro): %v", err)
	}
	return signed
}

// TestSign_CredentialFieldsExcludedFromInnerProof is the directive guard:
// the inner PaymentRequest proof MUST NOT cover any credential
// material — only the PaymentRequestEnvelope carries credentials. It signs a
// doc, then splices credential carriers (originator_auth, a top-level
// verifiableCredential, and a nested sender_auth.verifiable_credential) into
// the WIRE doc AFTER signing and confirms recovery STILL yields the holder —
// i.e. those fields are inert to the inner proof. The inverse of a tamper
// test: a field covered by the proof would change the recovered address; these
// don't, proving they're stripped on the verify side too (symmetry).
func TestSign_CredentialFieldsExcludedFromInnerProof(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("genkey: %v", err)
	}
	address := strings.ToLower(crypto.PubkeyToAddress(priv.PublicKey).Hex())
	holderDID := "did:pkh:eip155:1:" + address

	// Sign a clean payment doc (no credentials) and record the recovered holder.
	clean := map[string]any{
		"version":                 "1.0",
		"request_id":              "req-pr-cred-excl",
		"source":                  map[string]any{"asset_identifier": "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A", "account": address},
		"destination":             []any{map[string]any{"asset_identifier": "eip155:1/erc20:0xbbb", "account": "0x0000000000000000000000000000000000000002"}},
		"fulfillment_amount":      "1000000",
		"quote_deadline":          "2030-01-01T00:00:00Z",
		"fulfillment_deadline":    "2030-01-02T00:00:00Z",
		"escrow_contract_address": "0x0000000000000000000000000000000000000003",
		"fulfillment_verifier":    map[string]any{"account": "0x0000000000000000000000000000000000000004", "endpoint": "https://veri-fill.example.com"},
		"sender_auth": map[string]any{
			"message_scheme":  "EVM_PERMIT2",
			"signed_messages": []any{map[string]any{"message": "0xdead", "message_prehash": "{}", "signature": "0xbeef"}},
		},
	}
	signed, err := SignPaymentRequest(clean, priv, SignOptions{
		VerificationMethod: "did:pkh:eip155:1:" + address + "#blockchainAccountId",
		ProofPurpose:       "assertionMethod",
		Created:            time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("sign clean doc: %v", err)
	}
	baseRes, err := VerifyPaymentRequest(signed)
	if err != nil {
		t.Fatalf("verify clean doc: %v", err)
	}
	if got := strings.ToLower(mustSecp256k1Signer(t, baseRes).Hex()); got != address {
		t.Fatalf("clean recovered signer = %s, want %s", got, address)
	}

	// Splice credential carriers into the WIRE doc AFTER signing.
	var doc map[string]any
	if err := json.Unmarshal(signed, &doc); err != nil {
		t.Fatal(err)
	}
	doc["originator_auth"] = nestedVCAuth(holderDID)
	doc["verifiableCredential"] = []any{nestedVCAuth(holderDID)["verifiable_credential"]}
	sa := doc["sender_auth"].(map[string]any)
	sa["verifiable_credential"] = nestedVCAuth(holderDID)
	spliced, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}

	// Recovery must be UNCHANGED — the credential carriers are excluded from
	// the inner proof (and canonicalize without "protected term redefinition"
	// because they're stripped before URDNA2015 on the verify side too).
	res, err := VerifyPaymentRequest(spliced)
	if err != nil {
		t.Fatalf("verify after splicing credential carriers: %v", err)
	}
	if got := strings.ToLower(mustSecp256k1Signer(t, res).Hex()); got != address {
		t.Fatalf("splicing credential carriers changed the recovered signer: got %s, want %s — a credential field is leaking into the inner proof", got, address)
	}
}
