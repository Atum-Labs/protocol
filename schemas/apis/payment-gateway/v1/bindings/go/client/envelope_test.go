package pgclient

import (
	"encoding/json"
	"testing"

	presigning "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequestEnvelope/v1/bindings/go/signing"
	"github.com/stretchr/testify/require"
)

// envelopeOptionsIsATrueAlias fails to compile if EnvelopeOptions ever becomes a distinct
// struct rather than an alias. That matters more than it looks: a redeclared struct would
// need field-by-field mapping in the wrappers, and a field added upstream would be dropped
// silently — the envelope would still sign, just without whatever the caller set.
var _ presigning.Options = EnvelopeOptions{}

func envelopeOpts(t *testing.T) EnvelopeOptions {
	t.Helper()
	return EnvelopeOptions{
		PaymentRequestDoc: map[string]any{"version": "1.0", "request_id": "req-1"},
		HolderVCs: []json.RawMessage{json.RawMessage(`{
			"@context": ["https://www.w3.org/2018/credentials/v1"],
			"type": ["VerifiableCredential"],
			"issuer": "did:web:devnet.atum.network",
			"credentialSubject": {"id": "did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"}
		}`)},
		Signer:        testSigner(t),
		ChainID:       fixtureChainID,
		HolderAddress: fixtureAccount,
		Challenge:     "req-1",
		Domain:        "did:web:devnet.atum.network",
		Now:           fixtureCreated,
	}
}

// The wrappers exist so a caller needs one import for all three signatures. This checks they
// are wired to the real envelope signer rather than returning something envelope-shaped.
func TestBuildEnvelope_DelegatesToTheEnvelopeSigner(t *testing.T) {
	viaFacade, err := BuildEnvelope(envelopeOpts(t))
	require.NoError(t, err)
	direct, err := presigning.BuildEnvelope(envelopeOpts(t))
	require.NoError(t, err)

	require.JSONEq(t, string(direct), string(viaFacade),
		"the facade must produce exactly what the envelope package produces")

	var env map[string]any
	require.NoError(t, json.Unmarshal(viaFacade, &env))
	ctx, err := json.Marshal(env["@context"])
	require.NoError(t, err)
	require.Contains(t, string(ctx), "PaymentRequestEnvelope/v1/context.jsonld")
}

// The envelope's holder and the inner document's signer must be the same did:pkh, and both
// wrappers derive it from the same options — so a caller cannot accidentally sign the two
// artifacts under different identities.
func TestSignInnerPaymentRequest_MatchesTheEnvelopeHolder(t *testing.T) {
	opts := envelopeOpts(t)

	inner, err := SignInnerPaymentRequest(opts)
	require.NoError(t, err)
	envelope, err := BuildEnvelope(opts)
	require.NoError(t, err)

	var innerDoc, envDoc map[string]any
	require.NoError(t, json.Unmarshal(inner, &innerDoc))
	require.NoError(t, json.Unmarshal(envelope, &envDoc))

	innerVM := innerDoc["proof"].(map[string]any)["verificationMethod"]
	envVM := envDoc["proof"].(map[string]any)["verificationMethod"]
	require.Equal(t, envVM, innerVM)
	require.Equal(t, VerificationMethodForAccount(opts.ChainID, opts.HolderAddress), innerVM,
		"and both must match what this package's own DID helper derives")
}
