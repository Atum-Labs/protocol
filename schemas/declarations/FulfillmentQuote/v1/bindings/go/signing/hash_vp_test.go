package ldverification

import (
	"bytes"
	"testing"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// VP-mode HashQuote tests. The signer lives in TS-only
// (ld-signing-ts/src/sign-vp.ts); the Go side only needs to RECONSTRUCT
// the signing input from a wire VP — but the hash construction is shared,
// so we exercise it here in isolation. The actual VerifyVP entry point
// layers on top.

// fixtureVPBody returns a deterministic VerifiablePresentation body
// suitable for driving HashQuote with KeepVerifiableCredential: true.
// The @context array matches the wire shape signVP emits.
func fixtureVPBody() map[string]any {
	return map[string]any{
		"@context": []any{
			w3cVCV1ContextURL,
			fulfillmentQuoteEnvelopeContextURL,
			secp256k1Recovery2020V2CtxURL,
		},
		"type":   []any{"VerifiablePresentation"},
		"holder": "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
		"verifiableCredential": []any{
			map[string]any{
				"@context": []any{
					w3cVCV1ContextURL,
					lddataintegrity.KnownToAtumV1ContextURL,
				},
				"id":           "urn:uuid:vc-1",
				"type":         []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
				"issuer":       "did:web:issuer.atum.network",
				"issuanceDate": "2026-01-01T00:00:00Z",
				"credentialSubject": map[string]any{
					"id":   "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
					"role": "settler",
				},
				"proof": map[string]any{
					"type":               "EcdsaSecp256k1RecoverySignature2020",
					"created":            "2026-01-01T00:00:00Z",
					"verificationMethod": "did:web:issuer.atum.network#key-1",
					"proofPurpose":       "assertionMethod",
					"jws":                "FIXTURE_VC_JWS",
				},
			},
		},
	}
}

func fixtureVPSecpProofOpts() HashableProofOptions {
	return HashableProofOptions{
		Type:               ProofTypeSecp256k1Recovery2020,
		Created:            "2026-04-01T00:00:00.000Z",
		VerificationMethod: "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266#blockchainAccountId",
		ProofPurpose:       "authentication",
		Challenge:          "req-fixture-1",
		Domain:             "did:web:settler.atum.network",
		// Envelope-first multi-context: see sign-vp.ts. Without the
		// envelope context, URDNA2015 silently drops challenge/domain
		// and replay-binding evaporates.
		Context: []any{
			fulfillmentQuoteEnvelopeContextURL,
			secp256k1Recovery2020V2CtxURL,
		},
	}
}

func fixtureVPEd25519ProofOpts() HashableProofOptions {
	return HashableProofOptions{
		Type:               ProofTypeEd25519Signature2020,
		Created:            "2026-04-01T00:00:00.000Z",
		VerificationMethod: "did:pkh:solana:devnet:Fixture#blockchainAccountId",
		ProofPurpose:       "authentication",
		Challenge:          "req-fixture-1",
		Domain:             "did:web:settler.atum.network",
		Context: []any{
			fulfillmentQuoteEnvelopeContextURL,
			ed25519Signature2020V1CtxURL,
		},
	}
}

func TestHashQuote_VP_Determinism(t *testing.T) {
	t.Run("secp256k1", func(t *testing.T) {
		a, err := HashQuote(fixtureVPBody(), HashQuoteOptions{
			Cryptosuite:              ProofTypeSecp256k1Recovery2020,
			ProofOptions:             fixtureVPSecpProofOpts(),
			KeepVerifiableCredential: true,
		})
		if err != nil {
			t.Fatalf("hash #1: %v", err)
		}
		b, err := HashQuote(fixtureVPBody(), HashQuoteOptions{
			Cryptosuite:              ProofTypeSecp256k1Recovery2020,
			ProofOptions:             fixtureVPSecpProofOpts(),
			KeepVerifiableCredential: true,
		})
		if err != nil {
			t.Fatalf("hash #2: %v", err)
		}
		if !bytes.Equal(a.SigningInput, b.SigningInput) {
			t.Fatalf("VP secp256k1 hash not deterministic")
		}
	})
	t.Run("ed25519", func(t *testing.T) {
		a, err := HashQuote(fixtureVPBody(), HashQuoteOptions{
			Cryptosuite:              ProofTypeEd25519Signature2020,
			ProofOptions:             fixtureVPEd25519ProofOpts(),
			KeepVerifiableCredential: true,
		})
		if err != nil {
			t.Fatalf("hash #1: %v", err)
		}
		b, err := HashQuote(fixtureVPBody(), HashQuoteOptions{
			Cryptosuite:              ProofTypeEd25519Signature2020,
			ProofOptions:             fixtureVPEd25519ProofOpts(),
			KeepVerifiableCredential: true,
		})
		if err != nil {
			t.Fatalf("hash #2: %v", err)
		}
		if !bytes.Equal(a.SigningInput, b.SigningInput) {
			t.Fatalf("VP ed25519 hash not deterministic")
		}
	})
}

// TestHashQuote_VP_KeepVCFlagLoadBearing pins the load-bearing semantic
// of the new flag: when the VP body has its VC array, KeepVerifiableCredential
// must include it in the canonical n-quads. Without the flag, the VC
// array is stripped (FQ default), so the same body produces a different
// SigningInput — proving the flag actually toggles the canonicalization
// path rather than being a no-op.
func TestHashQuote_VP_KeepVCFlagLoadBearing(t *testing.T) {
	body := fixtureVPBody()
	opts := HashQuoteOptions{
		Cryptosuite:  ProofTypeSecp256k1Recovery2020,
		ProofOptions: fixtureVPSecpProofOpts(),
	}
	kept, err := HashQuote(body, HashQuoteOptions{
		Cryptosuite:              opts.Cryptosuite,
		ProofOptions:             opts.ProofOptions,
		KeepVerifiableCredential: true,
	})
	if err != nil {
		t.Fatalf("keep: %v", err)
	}
	stripped, err := HashQuote(body, opts)
	if err != nil {
		t.Fatalf("strip: %v", err)
	}
	if bytes.Equal(kept.SigningInput, stripped.SigningInput) {
		t.Fatalf("KeepVerifiableCredential did not change SigningInput — flag is a no-op")
	}
}

// TestHashQuote_VP_ChallengeAndDomainBindToHash pins the replay-binding
// invariant: changing challenge or domain MUST change the SigningInput.
// A regression here (e.g. the multi-context proofContext getting dropped
// from canonicalize) means the holder's signature stops binding the VP
// to its request_id — captured VPs could be replayed.
func TestHashQuote_VP_ChallengeAndDomainBindToHash(t *testing.T) {
	base, err := HashQuote(fixtureVPBody(), HashQuoteOptions{
		Cryptosuite:              ProofTypeSecp256k1Recovery2020,
		ProofOptions:             fixtureVPSecpProofOpts(),
		KeepVerifiableCredential: true,
	})
	if err != nil {
		t.Fatalf("base: %v", err)
	}

	t.Run("challenge", func(t *testing.T) {
		po := fixtureVPSecpProofOpts()
		po.Challenge = "req-other"
		got, err := HashQuote(fixtureVPBody(), HashQuoteOptions{
			Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: po, KeepVerifiableCredential: true,
		})
		if err != nil {
			t.Fatalf("mutate: %v", err)
		}
		if bytes.Equal(base.SigningInput, got.SigningInput) {
			t.Fatalf("changing challenge did not change SigningInput — replay binding broken")
		}
	})
	t.Run("domain", func(t *testing.T) {
		po := fixtureVPSecpProofOpts()
		po.Domain = "did:web:mismatched-verifier.example"
		got, err := HashQuote(fixtureVPBody(), HashQuoteOptions{
			Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: po, KeepVerifiableCredential: true,
		})
		if err != nil {
			t.Fatalf("mutate: %v", err)
		}
		if bytes.Equal(base.SigningInput, got.SigningInput) {
			t.Fatalf("changing domain did not change SigningInput — cross-env replay binding broken")
		}
	})
}

// TestHashQuote_VP_CryptosuiteOnlyProofContextDropsChallengeDomain is the
// inverse pin: if a caller forgets to pass the envelope context in
// ProofOptions.Context, challenge/domain SHOULD silently disappear from
// the canonical bytes (because the cryptosuite context alone doesn't
// define those terms). Documenting this failure mode in a test fixes
// the convention as "VP callers MUST pass the multi-context"; VerifyVP
// will rely on this same contract.
func TestHashQuote_VP_CryptosuiteOnlyProofContextDropsChallengeDomain(t *testing.T) {
	with := fixtureVPSecpProofOpts()
	without := fixtureVPSecpProofOpts()
	without.Context = secp256k1Recovery2020V2CtxURL // cryptosuite-only

	a, err := HashQuote(fixtureVPBody(), HashQuoteOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: with, KeepVerifiableCredential: true,
	})
	if err != nil {
		t.Fatalf("with multi-context: %v", err)
	}
	b, err := HashQuote(fixtureVPBody(), HashQuoteOptions{
		Cryptosuite: ProofTypeSecp256k1Recovery2020, ProofOptions: without, KeepVerifiableCredential: true,
	})
	if err != nil {
		t.Fatalf("with single-context: %v", err)
	}
	// Hashes MUST differ — proves the envelope context is genuinely
	// load-bearing for challenge/domain canonicalization.
	if bytes.Equal(a.SigningInput, b.SigningInput) {
		t.Fatalf("proofContext didn't affect canonicalization; envelope context isn't carrying challenge/domain")
	}
}
