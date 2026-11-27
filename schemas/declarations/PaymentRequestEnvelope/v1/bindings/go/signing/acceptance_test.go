package signing

import (
	"encoding/json"
	"testing"
	"time"

	fqsigning "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go/signing"
	paymentrequestenvelope "github.com/atum-labs/protocol/schemas/declarations/PaymentRequestEnvelope/v1/bindings/go"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
	"github.com/stretchr/testify/require"
)

// Everything else here asserts what BuildEnvelope PRODUCES. This asserts that the verifier
// ACCEPTS it, which is the property a producer actually depends on: an envelope can carry
// every field this package intends and still be refused at the gateway over a
// canonicalization or binding detail. Only a test connects the two.
//
// VerifyVP is the same function the gateway runs.

// acceptanceCredential is a KnownToAtum credential shaped the way the verifier expects.
//
// Its proof is structural rather than a real signature: the VP path does not verify embedded
// VC signatures unless a caller opts in via HolderIssuedVCTypes, but the block must exist and
// its type must match the OUTER cryptosuite or URDNA2015 cannot resolve the cryptosuite alias
// while canonicalizing. That failure surfaces as a canonicalization error rather than a policy
// one, which is why it is spelled out.
func acceptanceCredential(holderDID string, issued time.Time) json.RawMessage {
	vc := map[string]any{
		"@context": []any{
			lddataintegrity.W3CVCV1ContextURL,
			lddataintegrity.KnownToAtumV1ContextURL,
		},
		"id":           "urn:uuid:1f1c1b3a-0000-4000-8000-00000000acce",
		"type":         []any{"VerifiableCredential", "KnownToAtumVerifiableCredential"},
		"issuer":       holderDID,
		"issuanceDate": issued.UTC().Format(time.RFC3339),
		"credentialSubject": map[string]any{
			"id":   holderDID,
			"role": "originator",
		},
		"proof": map[string]any{
			"type":               "EcdsaSecp256k1RecoverySignature2020",
			"created":            issued.UTC().Format(time.RFC3339),
			"verificationMethod": holderDID + "#blockchainAccountId",
			"proofPurpose":       "assertionMethod",
		},
	}
	raw, err := json.Marshal(vc)
	if err != nil {
		panic(err)
	}
	return raw
}

func acceptanceOptions(t *testing.T) Options {
	t.Helper()
	opts := testOptions(t)
	opts.HolderVCs = []json.RawMessage{acceptanceCredential(opts.HolderDID(), created)}
	return opts
}

func verifyOptions(opts Options) fqsigning.VerifyVPOptions {
	return fqsigning.VerifyVPOptions{
		ExpectedChallenge: opts.Challenge,
		ExpectedDomain:    opts.Domain,
		ExpectedHolder:    opts.HolderDID(),
		// The declaration term is bound INTO the holder signature, so asserting it here
		// proves the PRE override reached the signature rather than only the document's
		// type array.
		ExpectedDeclarationType: paymentrequestenvelope.EnvelopeType,
		Now:                     opts.Now.Add(30 * time.Second),
		MaxProofAge:             5 * time.Minute,
		MaxFutureSkew:           30 * time.Second,
		RequiredVCTypes:         []string{"KnownToAtumVerifiableCredential"},
		// Required, not optional: the PRE context is deliberately NOT registered on the
		// FulfillmentQuote verifier's global loader, so a verifier that omits this cannot
		// canonicalize a PRE at all. Every PRE verifier has to supply it, which is what
		// ParsedContext exists for.
		ExtraEnvelopeContexts: map[string]any{
			paymentrequestenvelope.ContextURL: verifierOverlayContext(),
		},
	}
}

func TestBuildEnvelope_IsAcceptedByTheEnvelopeVerifier(t *testing.T) {
	opts := acceptanceOptions(t)

	envelope, err := BuildEnvelope(opts)
	require.NoError(t, err)

	res, err := fqsigning.VerifyVP(envelope, verifyOptions(opts))
	require.NoError(t, err, "the gateway's own verifier must accept what this package builds")
	require.Equal(t, opts.HolderDID(), res.Holder, "and must recover the holder it named")
}

// Without this, the acceptance test above would pass for an envelope whose signature covered
// nothing that matters.
func TestBuildEnvelope_VerifierRejectsATamperedEnvelope(t *testing.T) {
	opts := acceptanceOptions(t)
	envelope, err := BuildEnvelope(opts)
	require.NoError(t, err)

	var doc map[string]any
	require.NoError(t, json.Unmarshal(envelope, &doc))
	doc["holder"] = "did:pkh:eip155:1:0x000000000000000000000000000000000000dead"
	tampered, err := json.Marshal(doc)
	require.NoError(t, err)

	_, err = fqsigning.VerifyVP(tampered, verifyOptions(opts))
	require.Error(t, err, "a rewritten holder must not verify")
}

// The replay bindings are why challenge and domain exist, so both are asserted from the
// verifier's side rather than trusted because the proof block contains them.
func TestBuildEnvelope_VerifierEnforcesTheReplayBindings(t *testing.T) {
	opts := acceptanceOptions(t)
	envelope, err := BuildEnvelope(opts)
	require.NoError(t, err)

	t.Run("a challenge from another request is refused", func(t *testing.T) {
		v := verifyOptions(opts)
		v.ExpectedChallenge = "req-some-other-payment"
		_, err := fqsigning.VerifyVP(envelope, v)
		require.Error(t, err)
	})

	t.Run("a domain from another environment is refused", func(t *testing.T) {
		v := verifyOptions(opts)
		v.ExpectedDomain = "did:web:production.atum.network"
		_, err := fqsigning.VerifyVP(envelope, v)
		require.Error(t, err)
	})

	t.Run("it is not accepted as a FulfillmentQuoteEnvelope", func(t *testing.T) {
		v := verifyOptions(opts)
		v.ExpectedDeclarationType = "FulfillmentQuoteEnvelope"
		_, err := fqsigning.VerifyVP(envelope, v)
		require.Error(t, err,
			"a verifier expecting an FQE must reject a PRE — this declaration binding is what "+
				"keeps the two envelope kinds from being interchangeable")
	})
}

// verifierOverlayContext is the overlay a PRE verifier supplies per call, from the package that
// owns the snapshot. Supplied per call because the PRE context is deliberately absent from the
// FulfillmentQuote verifier's global loader.
//
// It panics rather than returning an error because the only way it can fail is a corrupt
// embedded snapshot, which would fail every test in this package anyway — and this is called
// from a helper with no *testing.T to report through.
func verifierOverlayContext() any {
	ctx, err := paymentrequestenvelope.ParsedContext()
	if err != nil {
		panic(err)
	}
	return ctx
}
