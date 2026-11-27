package pgclient

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/senderauth"
	"github.com/stretchr/testify/require"
)

// The Go SDK signs and verifies a Stellar PaymentRequest against the same frozen vectors the
// sender_auth bindings and the TypeScript SDK use. The vectors are the shared file; this suite adds
// the SDK's own walk (SignSenderAuth with the built-in local signer) to them. The request it signs
// is built in advance: this package has no request builder yet, so building one in Go is not
// covered here.
type stellarRequestVector struct {
	Name     string          `json:"name"`
	Request  json.RawMessage `json:"request"`
	Expected struct {
		EscrowContract string `json:"escrowContract"`
		Reserver       string `json:"reserver"`
		Releaser       string `json:"releaser"`
	} `json:"expected"`
	Expect struct {
		Amount             string                       `json:"amount"`
		Outcome            senderauth.CommitmentOutcome `json:"outcome"`
		DelegateUnverified bool                         `json:"delegateUnverified"`
	} `json:"expect"`
}

func loadStellarRequests(t *testing.T) []stellarRequestVector {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "..", "..", "schemas", "declarations", "PaymentRequest", "v1", "conformance", "stellar-sender-auth-vectors.json"))
	require.NoError(t, err)
	var doc struct {
		Requests []stellarRequestVector `json:"requests"`
	}
	require.NoError(t, json.Unmarshal(raw, &doc))
	require.NotEmpty(t, doc.Requests)
	return doc.Requests
}

func TestStellarVectorRequestsVerify(t *testing.T) {
	for _, v := range loadStellarRequests(t) {
		t.Run(v.Name, func(t *testing.T) {
			// The vector carries the request as a JSON string, so unquote it to the bytes the gateway receives.
			var body string
			require.NoError(t, json.Unmarshal(v.Request, &body))
			r, err := senderauth.VerifyPaymentRequestJSON([]byte(body), senderauth.VerifyPaymentRequestExpectations{
				Expectations: senderauth.Expectations{
					EscrowContract: v.Expected.EscrowContract,
					Reserver:       v.Expected.Reserver,
					Releaser:       v.Expected.Releaser,
				},
			})
			if v.Expect.DelegateUnverified {
				require.ErrorIs(t, err, senderauth.ErrDelegateUnverified)
				return
			}
			if v.Expect.Outcome == "" {
				require.NoError(t, err)
				require.Equal(t, v.Expect.Amount, r.Results[0].Amount)
				return
			}
			result, ok := senderauth.CommitmentResultOf(err)
			require.True(t, ok, "want a commitment refusal, got %v", err)
			require.Equal(t, v.Expect.Outcome, result.Outcome)
		})
	}
}

// SignSenderAuth with the local signer for a stellar network re-signs the honest vector's message to
// the same bytes: ed25519 is deterministic, so the SDK path and the vector's signer agree exactly,
// and the delegate signer it attaches is the key the verifier checks against.
func TestStellarSignSenderAuthReproducesTheVectorSignature(t *testing.T) {
	var honest json.RawMessage
	for _, v := range loadStellarRequests(t) {
		if v.Name == "honest-request" {
			honest = v.Request
		}
	}
	require.NotNil(t, honest)
	var body string
	require.NoError(t, json.Unmarshal(honest, &body))
	var req PaymentRequest
	require.NoError(t, json.Unmarshal([]byte(body), &req))
	want := req.SenderAuth.SignedMessages[0].Signature
	require.NotEmpty(t, want)
	wantDelegate := req.SenderAuth.SignedMessages[0].Payload["delegate_signer"]

	req.SenderAuth.SignedMessages[0].Signature = ""
	req.SenderAuth.SignedMessages[0].Payload = nil
	signer, err := senderauth.LocalKeySigner("stellar:testnet", hex.EncodeToString(bytes.Repeat([]byte{0x77}, 32)))
	require.NoError(t, err)
	require.NoError(t, SignSenderAuth(&req, signer))

	require.Equal(t, want, req.SenderAuth.SignedMessages[0].Signature)
	require.Equal(t, wantDelegate, req.SenderAuth.SignedMessages[0].Payload["delegate_signer"])
}

func TestStellarLocalSignerRefusesANonHexKey(t *testing.T) {
	signer, err := senderauth.LocalKeySigner("stellar:testnet", "not-a-key")
	require.NoError(t, err)
	_, err = signer.Sign(senderauth.SignedMessageInput{Message: "0x" + hex.EncodeToString(bytes.Repeat([]byte{1}, 32))})
	require.Error(t, err)
	require.NotContains(t, err.Error(), "not-a-key")
}

// honestStellarRequest is the frozen honest vector's request, unsigned, with the local signer for the
// key that signed it.
func honestStellarRequest(t *testing.T) (PaymentRequest, senderauth.SenderSigner) {
	t.Helper()
	var honest json.RawMessage
	for _, v := range loadStellarRequests(t) {
		if v.Name == "honest-request" {
			honest = v.Request
		}
	}
	require.NotNil(t, honest)
	var body string
	require.NoError(t, json.Unmarshal(honest, &body))
	var req PaymentRequest
	require.NoError(t, json.Unmarshal([]byte(body), &req))
	req.SenderAuth.SignedMessages[0].Signature = ""
	req.SenderAuth.SignedMessages[0].Payload = nil
	signer, err := senderauth.LocalKeySigner("stellar:testnet", hex.EncodeToString(bytes.Repeat([]byte{0x77}, 32)))
	require.NoError(t, err)
	return req, signer
}

// A Stellar key signs 32 bytes with plain ed25519, which is also how a Stellar transaction is signed
// (over its hash). A requester that sets message to such a hash must not get the payer's signature.
func TestStellarSignSenderAuthRefusesAMessageThatIsNotTheDepositDigest(t *testing.T) {
	txHash := "0x" + hex.EncodeToString(bytes.Repeat([]byte{0xab}, 32))
	req, signer := honestStellarRequest(t)
	req.SenderAuth.SignedMessages[0].Message = txHash

	err := SignSenderAuth(&req, signer)
	require.ErrorIs(t, err, senderauth.ErrStellarNotADeposit)
	require.Empty(t, req.SenderAuth.SignedMessages[0].Signature, "nothing is signed")
}

func TestStellarSignSenderAuthRefusesAMessageWithoutItsPrehash(t *testing.T) {
	req, signer := honestStellarRequest(t)
	req.SenderAuth.SignedMessages[0].MessagePrehash = ""

	err := SignSenderAuth(&req, signer)
	require.ErrorContains(t, err, "message_prehash")
	require.Empty(t, req.SenderAuth.SignedMessages[0].Signature)
}

// The digest is rebuilt under the request's escrow: a prehash whose digest was computed for another
// escrow is not this request's deposit.
func TestStellarSignSenderAuthRefusesADigestForAnotherEscrow(t *testing.T) {
	req, signer := honestStellarRequest(t)
	// The recorded testnet escrow, a well-formed contract strkey other than the vector's.
	require.NotEqual(t, "CBF3JFX2BZREI5T53SSLEV3LHU2Y5YQKLX64CGSEIIXNZTJE3VCV622U", req.EscrowContractAddress)
	req.EscrowContractAddress = "CBF3JFX2BZREI5T53SSLEV3LHU2Y5YQKLX64CGSEIIXNZTJE3VCV622U"

	err := SignSenderAuth(&req, signer)
	require.ErrorIs(t, err, senderauth.ErrStellarNotADeposit)
	require.Empty(t, req.SenderAuth.SignedMessages[0].Signature)
}

// A request that calls itself an EVM payment must not be given to a Stellar key.
func TestStellarSignSenderAuthRefusesAStellarKeyForAnotherNetwork(t *testing.T) {
	req, signer := honestStellarRequest(t)
	req.Source.AssetIdentifier = "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"

	err := SignSenderAuth(&req, signer)
	require.ErrorContains(t, err, "the signer is for stellar:testnet")
	require.Empty(t, req.SenderAuth.SignedMessages[0].Signature)
}
