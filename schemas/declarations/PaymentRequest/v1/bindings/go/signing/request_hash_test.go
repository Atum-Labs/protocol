package ldverification

import (
	"encoding/json"
	"errors"
	"regexp"
	"testing"
)

// requestHashPattern: "0x" + 64 lowercase hex (uniform 32-byte keccak256).
var requestHashPattern = regexp.MustCompile(`^0x[0-9a-f]{64}$`)

// baseRequest returns a fresh, valid signed inner PaymentRequest as a generic
// map. Each test clones + mutates it so cases are independent. It carries every
// field the strip/preserve rules touch: a top-level proof, a credential carrier
// candidate, and a sender_auth.signed_messages entry with message_prehash +
// signature.
func baseRequest() map[string]any {
	return map[string]any{
		"@context":                []any{paymentRequestContextURL, secp256k1Recovery2020V2CtxURL},
		"version":                 "1.0",
		"request_id":              "req-pr-secp-1",
		"fulfillment_amount":      "1000000",
		"quote_deadline":          "2030-01-01T00:00:00Z",
		"fulfillment_deadline":    "2030-01-02T00:00:00Z",
		"escrow_contract_address": "0x0000000000000000000000000000000000000003",
		"fulfillment_verifier":    map[string]any{"account": "0x0000000000000000000000000000000000000004", "endpoint": "https://veri-fill.example.com"},
		"source": map[string]any{
			"account":          "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
			"asset_identifier": "eip155:1/erc20:0xA0b86a33E6441E13acB9c4A4948ee8C4605A6a5A",
		},
		"destination": []any{map[string]any{
			"account":          "0x0000000000000000000000000000000000000002",
			"asset_identifier": "eip155:1/erc20:0xbbb",
		}},
		"sender_auth": map[string]any{
			"message_scheme": "EVM_PERMIT2",
			"signed_messages": []any{map[string]any{
				"message":         "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
				"message_prehash": "0xdeadbeef",
				"signature":       "0xabcdef1234567890",
			}},
		},
		"proof": map[string]any{
			"type":               "EcdsaSecp256k1RecoverySignature2020",
			"created":            "2026-04-01T00:00:00.000Z",
			"verificationMethod": "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266#blockchainAccountId",
			"proofPurpose":       "assertionMethod",
			"jws":                "eyJhbGciOiJFUzI1NkstUiJ9..signaturematerial",
		},
	}
}

func hashOf(t *testing.T, m map[string]any) string {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	h, err := ComputeRequestHash(b)
	if err != nil {
		t.Fatalf("ComputeRequestHash: %v", err)
	}
	return h
}

func TestComputeRequestHash_Deterministic(t *testing.T) {
	h1 := hashOf(t, baseRequest())
	h2 := hashOf(t, baseRequest())
	if h1 != h2 {
		t.Fatalf("non-deterministic: %s != %s", h1, h2)
	}
	if !requestHashPattern.MatchString(h1) {
		t.Fatalf("bad shape %q, want 0x+64hex", h1)
	}
}

// IgnoresInnerProofEntirely + IgnoresProofCreated + IgnoresSignatureMaterial:
// the pure-content decision. The hash must NOT depend on the inner PR's own
// proof — neither its presence, its created, nor its signature material.
func TestComputeRequestHash_IgnoresInnerProof(t *testing.T) {
	base := hashOf(t, baseRequest())

	noProof := baseRequest()
	delete(noProof, "proof")
	if got := hashOf(t, noProof); got != base {
		t.Errorf("deleting proof changed hash: %s vs %s", got, base)
	}

	mutCreated := baseRequest()
	mutCreated["proof"].(map[string]any)["created"] = "2099-12-31T23:59:59.000Z"
	if got := hashOf(t, mutCreated); got != base {
		t.Errorf("mutating proof.created changed hash (pure-content violated): %s vs %s", got, base)
	}

	mutJWS := baseRequest()
	mutJWS["proof"].(map[string]any)["jws"] = "tampered"
	if got := hashOf(t, mutJWS); got != base {
		t.Errorf("mutating proof.jws changed hash: %s vs %s", got, base)
	}
}

// StripsSignedMessageSignature + PreservesMessagePrehash/message/payload: the
// Permit2 signature is a proof artifact (stripped); the prehash/message/payload
// are content (preserved).
func TestComputeRequestHash_SignedMessageStripVsPreserve(t *testing.T) {
	base := hashOf(t, baseRequest())

	mutSig := baseRequest()
	mutSig["sender_auth"].(map[string]any)["signed_messages"].([]any)[0].(map[string]any)["signature"] = "0xdifferentsignature"
	if got := hashOf(t, mutSig); got != base {
		t.Errorf("mutating signed_messages[0].signature changed hash (should be stripped): %s vs %s", got, base)
	}

	mutPrehash := baseRequest()
	mutPrehash["sender_auth"].(map[string]any)["signed_messages"].([]any)[0].(map[string]any)["message_prehash"] = "0xcafebabe"
	if got := hashOf(t, mutPrehash); got == base {
		t.Error("mutating message_prehash did NOT change hash (prehash is content, must be preserved)")
	}

	mutMsg := baseRequest()
	mutMsg["sender_auth"].(map[string]any)["signed_messages"].([]any)[0].(map[string]any)["message"] = "0x0000"
	if got := hashOf(t, mutMsg); got == base {
		t.Error("mutating signed_messages[0].message did NOT change hash (message is content)")
	}
}

// StripsCredentialCarriers: splicing the PRE presentation / originator_auth /
// verifiableCredential / nested sender_auth.verifiable_credential onto the wire
// PaymentRequest must be inert — the verifier recomputes request_hash over the
// PRE-enriched inner PR and must get the same value the producer computed.
func TestComputeRequestHash_StripsCredentialCarriers(t *testing.T) {
	base := hashOf(t, baseRequest())

	// A schema-valid VC + VC-auth, reused across the carriers (mirrors the
	// shapes the typed binding requires — see roundtrip_test.go's
	// TestVerify_PresentationAndVCSplice_Inert).
	validVC := map[string]any{
		"@context":          []any{"https://www.w3.org/2018/credentials/v1"},
		"id":                "urn:uuid:9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f",
		"type":              []any{"VerifiableCredential"},
		"issuer":            "did:web:spliced.example",
		"issuanceDate":      "2026-01-01T00:00:00Z",
		"credentialSubject": map[string]any{"id": "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"},
		"proof": map[string]any{
			"type": "EcdsaSecp256k1RecoverySignature2020", "created": "2026-01-01T00:00:00Z",
			"verificationMethod": "did:web:spliced.example#key-1", "proofPurpose": "assertionMethod", "jws": "ey..vc",
		},
	}
	validVCAuth := map[string]any{
		"signature":              "0xsig",
		"verification_method_id": "did:web:spliced.example#key-1",
		"verifiable_credential":  validVC,
	}

	// Splice the FULL credential-carrier set onto the wire PaymentRequest AFTER
	// it was formed — exactly what the PRE producer does for
	// `presentation`, plus the deprecated inner carriers. The verifier recomputes
	// request_hash over this enriched body and MUST match the producer's hash
	// over the clean request, so every carrier must be stripped.
	withCarriers := baseRequest()
	withCarriers["presentation"] = map[string]any{
		"@context":             []any{"https://www.w3.org/2018/credentials/v1"},
		"type":                 []any{"VerifiablePresentation", "PaymentRequestEnvelope"},
		"holder":               "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
		"verifiableCredential": []any{validVC},
		"proof": map[string]any{
			"type": "EcdsaSecp256k1RecoverySignature2020", "created": "2026-04-01T00:00:00Z",
			"verificationMethod": "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266#blockchainAccountId",
			"proofPurpose":       "authentication", "challenge": "req-pr-secp-1", "domain": "did:web:devnet.atum.network", "jws": "ey..pre",
		},
	}
	withCarriers["verifiableCredential"] = []any{validVC}
	withCarriers["originator_auth"] = validVCAuth
	withCarriers["sender_auth"].(map[string]any)["verifiable_credential"] = validVCAuth
	if got := hashOf(t, withCarriers); got != base {
		t.Errorf("splicing credential carriers changed hash (must be stripped): %s vs %s", got, base)
	}
}

// ChangesOnRequestIDMutation: THE anti-replay invariant. request_hash is safe
// as a replay challenge only because request_id (idempotency key) is in the
// hashed content, so distinct requests get distinct challenges. If this ever
// stops holding (e.g. request_id dropped from the @context), a captured PRE
// could be replayed against a distinct-but-identical-content request.
func TestComputeRequestHash_ChangesOnRequestIDMutation(t *testing.T) {
	base := hashOf(t, baseRequest())
	mut := baseRequest()
	mut["request_id"] = "req-pr-secp-2"
	if got := hashOf(t, mut); got == base {
		t.Fatal("mutating request_id did NOT change request_hash — anti-replay invariant broken (request_id must be in the canonical content)")
	}
}

func TestComputeRequestHash_ExecutorAbsentKeepsHashPresentChangesIt(t *testing.T) {
	base := hashOf(t, baseRequest())
	// baseRequest omits executor. An explicit absent key must not be hashed either.
	omitted := baseRequest()
	delete(omitted, "executor")
	if got := hashOf(t, omitted); got != base {
		t.Fatalf("omitting executor changed request_hash: %s vs %s", got, base)
	}
	present := baseRequest()
	present["executor"] = "settler"
	if got := hashOf(t, present); got == base {
		t.Fatal("a present executor did not change request_hash")
	}
	split := baseRequest()
	split["executor"] = map[string]any{
		"deposit": "settler",
		"reserve": "settler",
		"fulfill": "originator",
	}
	if got := hashOf(t, split); got == base {
		t.Fatal("a split executor did not change request_hash")
	}
}

// The deposit nonce is content: with the source account it names the deposit an originator-executed
// request pays from, so two nonces are two payments. Before the context defined the term, JSON-LD
// dropped it and both hashed alike.
func TestComputeRequestHash_DepositNonceChangesIt(t *testing.T) {
	withNonce := func(nonce string) map[string]any {
		doc := baseRequest()
		delete(doc, "sender_auth")
		doc["executor"] = map[string]any{"deposit": "originator", "reserve": "settler", "fulfill": "originator"}
		if nonce != "" {
			doc["deposit_nonce"] = nonce
		}
		return doc
	}
	without, seven, eight := hashOf(t, withNonce("")), hashOf(t, withNonce("7")), hashOf(t, withNonce("8"))
	if seven == without || seven == eight {
		t.Fatalf("request_hash does not cover deposit_nonce: none %s, 7 %s, 8 %s", without, seven, eight)
	}
}

func TestComputeRequestHash_ChangesOnContentMutation(t *testing.T) {
	base := hashOf(t, baseRequest())
	mut := baseRequest()
	mut["fulfillment_amount"] = "2000000"
	if got := hashOf(t, mut); got == base {
		t.Error("mutating fulfillment_amount did NOT change request_hash")
	}
}

// SuiteIndependent: the hash must not depend on the inner proof's cryptosuite,
// because request_hash pins a fixed suite for the DocHash path. Same content
// signed under ed25519 vs secp256k1 → same request_hash.
func TestComputeRequestHash_SuiteIndependent(t *testing.T) {
	base := hashOf(t, baseRequest())
	ed := baseRequest()
	ed["proof"].(map[string]any)["type"] = "Ed25519Signature2020"
	ed["proof"].(map[string]any)["proofValue"] = "z3rawed25519proofvalue"
	delete(ed["proof"].(map[string]any), "jws")
	if got := hashOf(t, ed); got != base {
		t.Errorf("ed25519-signed content hashed differently from secp256k1 (must be suite-independent): %s vs %s", got, base)
	}
}

func TestComputeRequestHash_Errors(t *testing.T) {
	if _, err := ComputeRequestHash([]byte("{not json")); !errors.Is(err, ErrMalformedRequest) {
		t.Errorf("malformed JSON: want ErrMalformedRequest, got %v", err)
	}
	// Missing required content field (no source/destination/etc.).
	if _, err := ComputeRequestHash([]byte(`{"version":"1.0"}`)); !errors.Is(err, ErrMalformedRequest) {
		t.Errorf("missing required fields: want ErrMalformedRequest, got %v", err)
	}
}
