package pgclient

import (
	"encoding/json"
	"testing"

	"github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/senderauth"
	"github.com/stretchr/testify/require"
)

// One signer must serve every surface that takes one, or an integrator has to hold two kinds
// of credential for the same key. sender_auth takes a SenderSigner (it signs chain-specific
// messages); the document and envelope paths take a Secp256k1Signer (they sign digests).
// This pins that both are reachable from the same key material without conversion.
func TestOneKeyServesEverySigningSurface(t *testing.T) {
	digestSigner := testSigner(t) // lddataintegrity.Secp256k1Signer
	senderSigner, err := senderauth.LocalKeySigner("eip155:1", fixtureKey)
	require.NoError(t, err)

	doc := unsignedFixture(t)
	signed, err := SignDeclarationJSON(mustJSON(t, doc), digestSigner, testOptions())
	require.NoError(t, err)
	require.NotEmpty(t, proofOf(t, signed)["jws"])

	// A real 32-byte digest: the stub signers elsewhere ignore the message, so this is the
	// first place a real signer validates its length.
	req := requestWith(SignedMessage{
		Message: "0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f",
	})
	require.NoError(t, SignSenderAuth(req, senderSigner))
	require.NotEmpty(t, req.SenderAuth.SignedMessages[0].Signature)

	env, err := BuildEnvelope(EnvelopeOptions{
		PaymentRequestDoc: map[string]any{"version": "1.0", "request_id": "req-1"},
		HolderVCs:         []json.RawMessage{json.RawMessage(`{"@context":["https://www.w3.org/2018/credentials/v1"],"type":["VerifiableCredential"],"issuer":"did:web:devnet.atum.network","credentialSubject":{"id":"did:pkh:eip155:1:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"}}`)},
		Signer:            digestSigner,
		ChainID:           fixtureChainID,
		HolderAddress:     fixtureAccount,
		Challenge:         "req-1",
		Domain:            "did:web:devnet.atum.network",
		Now:               fixtureCreated,
	})
	require.NoError(t, err)
	require.NotEmpty(t, env)
}
