package signing

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	fqsigning "github.com/atum-labs/protocol/schemas/declarations/FulfillmentQuote/v1/bindings/go/signing"
	paymentrequestenvelope "github.com/atum-labs/protocol/schemas/declarations/PaymentRequestEnvelope/v1/bindings/go"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
	"github.com/stretchr/testify/require"
)

// --- JSON-LD context isolation ------------------------------------------------------
//
// The @context decides what each term in a document MEANS, so a context an attacker can serve
// is a context that can change what a signature covers: drop a term from canonicalization and
// the field it names becomes unsigned while the document still looks signed.
//
// This library cannot fetch one. There is no HTTP client anywhere in it, and the loader is a
// map lookup that fails closed on anything unregistered. These tests pin the behaviour so a
// future change that introduces a fetch fails here.

func TestVerify_RefusesAnUnregisteredEnvelopeContext(t *testing.T) {
	opts := acceptanceOptions(t)
	envelope, err := BuildEnvelope(opts)
	require.NoError(t, err)

	for _, tc := range []struct {
		name string
		url  string
	}{
		{"an attacker-controlled host", "https://attacker.example/context.jsonld"},
		{"a look-alike of ours", "https://schemas.atum.network.attacker.example/declarations/PaymentRequestEnvelope/v1/context.jsonld"},
		{"a one-character typo of ours", "https://schemas.atum.netwerk/declarations/PaymentRequestEnvelope/v1/context.jsonld"},
		{"plain http instead of https", "http://schemas.atum.network/declarations/PaymentRequestEnvelope/v1/context.jsonld"},
		{"a file URL", "file:///etc/passwd"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var doc map[string]any
			require.NoError(t, json.Unmarshal(envelope, &doc))
			doc["@context"] = []any{tc.url}
			tampered, err := json.Marshal(doc)
			require.NoError(t, err)

			_, err = fqsigning.VerifyVP(tampered, verifyOptions(opts))
			require.Error(t, err, "an unresolvable context must fail closed, not be fetched")
			require.True(t,
				errors.Is(err, lddataintegrity.ErrUnknownContext) ||
					strings.Contains(err.Error(), "unknown JSON-LD context"),
				"the refusal must name the unknown context rather than surfacing as a network "+
					"or parse failure; got: %v", err)
		})
	}
}

// The overlay is what makes a PRE verifiable at all. A verifier that forgets it cannot
// canonicalize the envelope, and must say so rather than verifying something else.
func TestVerify_WithoutTheContextOverlayFailsClosed(t *testing.T) {
	opts := acceptanceOptions(t)
	envelope, err := BuildEnvelope(opts)
	require.NoError(t, err)

	bare := verifyOptions(opts)
	bare.ExtraEnvelopeContexts = nil

	_, err = fqsigning.VerifyVP(envelope, bare)
	require.Error(t, err, "the PRE context is deliberately absent from the global loader")
}

// --- signer behaviour ---------------------------------------------------------------

// failingSigner stands in for a custodian that declines, is misconfigured, or returns
// something malformed. None of these may produce an envelope.
type failingSigner struct {
	sig []byte
	err error
}

func (f failingSigner) SignDigest([]byte) ([]byte, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.sig, nil
}
func (f failingSigner) PublicKeyUncompressed() []byte { return make([]byte, 65) }

func TestBuildEnvelope_SignerFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		signer lddataintegrity.Secp256k1Signer
		want   string
	}{
		{
			name:   "a custodian that declines",
			signer: failingSigner{err: errors.New("policy: signing denied for this payload")},
			want:   "policy: signing denied",
		},
		{
			name:   "a signature that is too short",
			signer: failingSigner{sig: make([]byte, 64)},
			want:   "65",
		},
		{
			name:   "a signature that is too long",
			signer: failingSigner{sig: make([]byte, 66)},
			want:   "65",
		},
		{
			name:   "an empty signature",
			signer: failingSigner{sig: []byte{}},
			want:   "65",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			opts := acceptanceOptions(t)
			opts.Signer = tc.signer

			_, err := BuildEnvelope(opts)
			require.Error(t, err)
			require.Contains(t, err.Error(), tc.want)
		})
	}
}

// The recovery byte contract, mirrored from the inner signer: a signer that already applied
// the +27 alignment must be refused, because applying it twice recovers a different address —
// an envelope that verifies as somebody else.
func TestBuildEnvelope_RefusesAPreAppliedRecoveryByte(t *testing.T) {
	opts := acceptanceOptions(t)
	inner := opts.Signer
	opts.Signer = shiftingSigner{inner: inner}

	_, err := BuildEnvelope(opts)
	require.Error(t, err)
	require.Contains(t, strings.ToLower(err.Error()), "27",
		"the refusal must name the alignment rather than failing later as a bad signature")
}

type shiftingSigner struct {
	inner lddataintegrity.Secp256k1Signer
}

func (s shiftingSigner) SignDigest(d []byte) ([]byte, error) {
	sig, err := s.inner.SignDigest(d)
	if err != nil {
		return nil, err
	}
	out := append([]byte(nil), sig...)
	out[64] += 27
	return out, nil
}
func (s shiftingSigner) PublicKeyUncompressed() []byte { return s.inner.PublicKeyUncompressed() }

// --- freshness and policy -----------------------------------------------------------

func TestVerify_EnforcesProofFreshness(t *testing.T) {
	opts := acceptanceOptions(t)
	envelope, err := BuildEnvelope(opts)
	require.NoError(t, err)

	t.Run("a proof older than the tolerance is refused", func(t *testing.T) {
		v := verifyOptions(opts)
		v.Now = opts.Now.Add(2 * time.Hour)
		_, err := fqsigning.VerifyVP(envelope, v)
		require.Error(t, err, "a replayed envelope from hours ago must not verify")
	})

	t.Run("a proof from the future beyond the skew allowance is refused", func(t *testing.T) {
		v := verifyOptions(opts)
		v.Now = opts.Now.Add(-2 * time.Hour)
		_, err := fqsigning.VerifyVP(envelope, v)
		require.Error(t, err, "a clock far behind the signer's must not silently accept")
	})

	t.Run("a proof inside the window verifies", func(t *testing.T) {
		_, err := fqsigning.VerifyVP(envelope, verifyOptions(opts))
		require.NoError(t, err)
	})
}

func TestVerify_EnforcesTheCredentialPolicy(t *testing.T) {
	opts := acceptanceOptions(t)
	envelope, err := BuildEnvelope(opts)
	require.NoError(t, err)

	t.Run("a required credential type that is absent is refused", func(t *testing.T) {
		v := verifyOptions(opts)
		v.RequiredVCTypes = []string{"SomeCredentialTypeThisHolderDoesNotHave"}
		_, err := fqsigning.VerifyVP(envelope, v)
		require.Error(t, err)
	})

	t.Run("the holder must match the one the verifier expects", func(t *testing.T) {
		v := verifyOptions(opts)
		v.ExpectedHolder = "did:pkh:eip155:1:0x000000000000000000000000000000000000dead"
		_, err := fqsigning.VerifyVP(envelope, v)
		require.Error(t, err,
			"the envelope holder is bound into the signature; a different expectation must "+
				"not be satisfied by it")
	})
}

// The declaration term is bound into the holder signature rather than merely present in the
// document, so rewriting it in the JSON cannot make an envelope pass as another kind.
func TestVerify_RewritingTheDeclarationTypeDoesNotChangeWhatItIs(t *testing.T) {
	opts := acceptanceOptions(t)
	envelope, err := BuildEnvelope(opts)
	require.NoError(t, err)

	var doc map[string]any
	require.NoError(t, json.Unmarshal(envelope, &doc))
	doc["type"] = []any{"VerifiablePresentation", "FulfillmentQuoteEnvelope"}
	rewritten, err := json.Marshal(doc)
	require.NoError(t, err)

	v := verifyOptions(opts)
	v.ExpectedDeclarationType = "FulfillmentQuoteEnvelope"
	_, err = fqsigning.VerifyVP(rewritten, v)
	require.Error(t, err,
		"editing the type array must not let a PRE be accepted where an FQE is expected")

	require.Equal(t, "PaymentRequestEnvelope", paymentrequestenvelope.EnvelopeType,
		"and the constant this package signs with is the PRE one")
}
