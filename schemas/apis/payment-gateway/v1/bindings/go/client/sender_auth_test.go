package pgclient

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/senderauth"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"
)

// stubSigner stands in for a wallet. The cryptography lives in senderauth and is covered by
// the frozen conformance vectors there; what THIS package adds is the walk over
// signed_messages[], so the tests that matter here drive the walk with predictable
// signatures and assert on what the walk did.
type stubSigner struct {
	sig      string
	delegate string
	failAt   int // 1-based call number to fail on; 0 never fails
	calls    int
	seen     []senderauth.SignedMessageInput
}

func (s *stubSigner) Sign(in senderauth.SignedMessageInput) (senderauth.SenderSignature, error) {
	s.calls++
	s.seen = append(s.seen, in)
	if s.failAt != 0 && s.calls == s.failAt {
		return senderauth.SenderSignature{}, errors.New("stub refused to sign")
	}
	return senderauth.SenderSignature{Signature: s.sig, DelegateSigner: s.delegate}, nil
}

func requestWith(messages ...SignedMessage) *PaymentRequest {
	return &PaymentRequest{
		SenderAuth: &SenderAuth{
			MessageScheme:  "EVM_PERMIT2",
			SignedMessages: messages,
		},
	}
}

func TestSignSenderAuth_FillsEverySignature(t *testing.T) {
	req := requestWith(
		SignedMessage{Message: "0xaa"},
		SignedMessage{Message: "0xbb"},
	)
	signer := &stubSigner{sig: "0xsigned"}

	require.NoError(t, SignSenderAuth(req, signer))

	require.Equal(t, 2, signer.calls, "every message must reach the signer")
	for i, m := range req.SenderAuth.SignedMessages {
		require.Equal(t, "0xsigned", m.Signature, "signed_messages[%d] must carry the signature", i)
	}
}

// The `for _, m := range` trap: ranging over a []SignedMessage copies each struct, so
// writing to the loop variable leaves the request unsigned while everything still
// compiles and no error is returned. This test is what catches that.
func TestSignSenderAuth_WritesThroughToTheRequestNotACopy(t *testing.T) {
	req := requestWith(SignedMessage{Message: "0xaa"})
	require.NoError(t, SignSenderAuth(req, &stubSigner{sig: "0xsigned"}))

	// Re-read through the request, not through a local copy.
	require.Equal(t, "0xsigned", req.SenderAuth.SignedMessages[0].Signature,
		"the signature must be visible through req, or the caller submits an unsigned request")
}

func TestSignSenderAuth_AttachesDelegateSignerOnlyWhenTheSignerReturnsOne(t *testing.T) {
	t.Run("solana: delegate signer is attached", func(t *testing.T) {
		req := requestWith(SignedMessage{Message: "0xaa"})
		require.NoError(t, SignSenderAuth(req, &stubSigner{sig: "sig", delegate: "DelegatePubkey"}))

		payload := req.SenderAuth.SignedMessages[0].Payload
		require.NotNil(t, payload, "a delegate signer needs a payload to live in")
		require.Equal(t, "DelegatePubkey", payload["delegate_signer"])
	})

	t.Run("evm: no delegate signer, no payload invented", func(t *testing.T) {
		req := requestWith(SignedMessage{Message: "0xaa"})
		require.NoError(t, SignSenderAuth(req, &stubSigner{sig: "sig"}))

		require.Nil(t, req.SenderAuth.SignedMessages[0].Payload,
			"an empty delegate signer must not materialize a payload")
	})
}

func TestSignSenderAuth_PreservesExistingPayloadKeys(t *testing.T) {
	req := requestWith(SignedMessage{
		Message: "0xaa",
		Payload: map[string]interface{}{"chain_specific": "keep me"},
	})
	require.NoError(t, SignSenderAuth(req, &stubSigner{sig: "sig", delegate: "DelegatePubkey"}))

	payload := req.SenderAuth.SignedMessages[0].Payload
	require.Equal(t, "keep me", payload["chain_specific"], "the delegate signer must merge, not replace")
	require.Equal(t, "DelegatePubkey", payload["delegate_signer"])
}

// The signer consumes the binding-agnostic SignedMessageInput, so the mapping from the
// generated type is written by hand here. A dropped field means the wallet signs something
// other than what the request says — silently, because the shapes still compile.
func TestSignSenderAuth_PassesEveryFieldToTheSigner(t *testing.T) {
	prehash := `{"types":{"PermitWitnessTransferFrom":[]}}`
	req := requestWith(SignedMessage{
		Message:        "0xaa",
		Signature:      "0xstale",
		MessagePrehash: prehash,
		Payload:        map[string]interface{}{"k": "v"},
	})
	signer := &stubSigner{sig: "0xfresh"}
	require.NoError(t, SignSenderAuth(req, signer))

	require.Len(t, signer.seen, 1)
	got := signer.seen[0]
	require.Equal(t, "0xaa", got.Message)
	require.Equal(t, "0xstale", got.Signature, "the pre-existing signature is part of the input")
	require.NotNil(t, got.MessagePrehash, "the prehash is what carries the signed terms")
	require.Equal(t, prehash, *got.MessagePrehash)
	require.Equal(t, map[string]interface{}{"k": "v"}, got.Payload)
}

func TestSignSenderAuth_LeavesTheRequestUntouchedWhenSigningFails(t *testing.T) {
	req := requestWith(
		SignedMessage{Message: "0xaa"},
		SignedMessage{Message: "0xbb"},
	)
	signer := &stubSigner{sig: "0xsigned", failAt: 2}

	err := SignSenderAuth(req, signer)
	require.Error(t, err)
	require.Contains(t, err.Error(), "signed_messages[1]", "the error must name which message failed")

	for i, m := range req.SenderAuth.SignedMessages {
		require.Empty(t, m.Signature,
			"signed_messages[%d]: a partly-signed request must not be left behind, since a caller "+
				"that ignores the error would submit it", i)
	}
}

func TestSignSenderAuth_RefusesNothingToSign(t *testing.T) {
	t.Run("nil sender_auth", func(t *testing.T) {
		require.ErrorIs(t, SignSenderAuth(&PaymentRequest{}, &stubSigner{}), ErrNoSignedMessages)
	})
	t.Run("empty signed_messages", func(t *testing.T) {
		require.ErrorIs(t, SignSenderAuth(requestWith(), &stubSigner{}), ErrNoSignedMessages)
	})
	t.Run("nil request", func(t *testing.T) {
		require.Error(t, SignSenderAuth(nil, &stubSigner{}))
	})
	t.Run("nil signer", func(t *testing.T) {
		require.Error(t, SignSenderAuth(requestWith(SignedMessage{Message: "0xaa"}), nil))
	})
}

// --- real cryptography, end to end -------------------------------------------------
//
// The tests above prove the walk. This one proves the walk is wired to something that
// actually produces a verifiable signature: sign with a real local key through
// senderauth.LocalKeySigner, then hand the result to the adapter's own verifier. A helper
// that plumbed strings correctly but signed the wrong bytes would pass every test above
// and fail this one.

type vectorFile struct {
	Cases []struct {
		Name     string                        `json:"name"`
		Network  string                        `json:"network"`
		Source   senderauth.SourceRef          `json:"source"`
		Expected senderauth.Expectations       `json:"expected"`
		Signed   senderauth.SignedMessageInput `json:"signed"`
	} `json:"cases"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	path := filepath.Join("..", "..", "..", "..", "..", "..", "..", "schemas", "declarations", "PaymentRequest", "v1", "conformance",
		"sender-auth-vectors.json")
	raw, err := os.ReadFile(path)
	require.NoError(t, err, "read sender-auth-vectors.json")
	var doc vectorFile
	require.NoError(t, json.Unmarshal(raw, &doc))
	require.NotEmpty(t, doc.Cases)
	return doc
}

func TestSignSenderAuth_ProducesASignatureTheAdapterVerifies(t *testing.T) {
	const evmKey = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318"

	vectors := loadVectors(t)
	var evm *struct {
		Name     string                        `json:"name"`
		Network  string                        `json:"network"`
		Source   senderauth.SourceRef          `json:"source"`
		Expected senderauth.Expectations       `json:"expected"`
		Signed   senderauth.SignedMessageInput `json:"signed"`
	}
	for i := range vectors.Cases {
		if vectors.Cases[i].Name == "evm-permit2" {
			evm = &vectors.Cases[i]
			break
		}
	}
	require.NotNil(t, evm, "the evm-permit2 vector must exist")

	req := requestWith(SignedMessage{
		Message:        evm.Signed.Message,
		MessagePrehash: *evm.Signed.MessagePrehash,
	})

	signer, err := senderauth.LocalKeySigner(evm.Network, evmKey)
	require.NoError(t, err)
	require.NoError(t, SignSenderAuth(req, signer))

	signed := req.SenderAuth.SignedMessages[0]
	require.NotEmpty(t, signed.Signature)
	require.NotEqual(t, evm.Signed.Signature, signed.Signature,
		"a different key must produce a different signature; equality here would mean the "+
			"vector's signature was copied through rather than recomputed")

	// The recovered owner is the test key's own address, so the source account for
	// verification is that address rather than the vector's. It is derived independently
	// from the private key via go-ethereum's key-to-address function, NOT read back from
	// the signature: the assertion is that recovering the signature lands on the same
	// address the key derives to, which is only a real check if the two are computed by
	// different code paths.
	priv, err := crypto.HexToECDSA(evmKey)
	require.NoError(t, err)
	wantSigner := crypto.PubkeyToAddress(priv.PublicKey).Hex()

	source := evm.Source
	source.Account = wantSigner

	adapter, err := senderauth.GetChainAdapter(evm.Network)
	require.NoError(t, err)
	recovered, err := adapter.RecoverSigner(senderauth.SignedMessageInput{
		Message:        signed.Message,
		Signature:      signed.Signature,
		MessagePrehash: &signed.MessagePrehash,
		Payload:        signed.Payload,
	}, source)
	require.NoError(t, err, "the produced signature must recover a signer")
	require.Equal(t, wantSigner, recovered,
		"the signature must recover to the address the signing key derives to")
}

// A field added to senderauth.SignedMessageInput must break this build, not pass silently.
//
// sender_auth.go maps the generated SignedMessage onto SignedMessageInput by hand, because the
// canonical mapping is unexported. Go keyed struct literals do not require every field, so a new
// field upstream keeps compiling here and is passed as its zero value -- the wallet then signs
// something other than what the request says, which is exactly the failure the mapping's own
// comment warns about. TestSignSenderAuth_PassesEveryFieldToTheSigner pins today's fields one by
// one, so it would not catch a NEW one either.
//
// If this fails: a field was added to SignedMessageInput. Map it in sender_auth.go, then update
// the count here.
func TestSignedMessageInputFieldCount(t *testing.T) {
	const mapped = 5 // Message, Signature, MessagePrehash, Payload, SvmMessageScheme

	got := reflect.TypeOf(senderauth.SignedMessageInput{}).NumField()
	if got != mapped {
		t.Fatalf("senderauth.SignedMessageInput has %d fields but sender_auth.go maps %d — "+
			"an unmapped field is signed as its zero value, so the wallet signs something the "+
			"request does not say", got, mapped)
	}
}

// A Solana key signs the raw hash by default, and the escrow text only when the escrow's scheme
// says so. The scheme never reaches the request.
func TestSignSenderAuthWithScheme_Solana(t *testing.T) {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = 7
	}
	pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	signer, err := senderauth.LocalKeySigner("solana:mainnet", hex.EncodeToString(seed))
	require.NoError(t, err)
	var hash [32]byte
	for i := range hash {
		hash[i] = 0xab
	}
	text := []byte("atum deposit v1 q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s")
	for _, tc := range []struct {
		name   string
		sign   func(*PaymentRequest) error
		signed []byte
	}{
		{"default", func(r *PaymentRequest) error { return SignSenderAuth(r, signer) }, hash[:]},
		{"raw scheme", func(r *PaymentRequest) error { return SignSenderAuthWithScheme(r, signer, "") }, hash[:]},
		{"text scheme", func(r *PaymentRequest) error { return SignSenderAuthWithScheme(r, signer, "escrow-text-v1") }, text},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := requestWith(SignedMessage{Message: "0x" + hex.EncodeToString(hash[:])})
			require.NoError(t, tc.sign(req))
			sig, err := hex.DecodeString(req.SenderAuth.SignedMessages[0].Signature[2:])
			require.NoError(t, err)
			require.True(t, ed25519.Verify(pub, tc.signed, sig))
			body, err := json.Marshal(req)
			require.NoError(t, err)
			require.NotContains(t, string(body), "escrow-text-v1")
		})
	}
	req := requestWith(SignedMessage{Message: "0x" + hex.EncodeToString(hash[:])})
	require.ErrorContains(t, SignSenderAuthWithScheme(req, signer, "text"), "unknown message scheme")
	require.Empty(t, req.SenderAuth.SignedMessages[0].Signature)
}
