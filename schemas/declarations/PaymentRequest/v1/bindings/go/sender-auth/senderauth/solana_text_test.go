package senderauth

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	svm "github.com/atum-labs/protocol/contracts/svm/bindings/go/escrow-encoding/encoding"
	"github.com/mr-tron/base58"
	"github.com/stretchr/testify/require"
)

var (
	allSolanaForms = []svm.EscrowMessageForm{svm.EscrowFormRaw, svm.EscrowFormBare, svm.EscrowFormV1, svm.EscrowFormV0}
	// A key no vector uses.
	textTestKey = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x42}, 32))
)

func schemeAccepts(t *testing.T, scheme svm.MessageScheme, form svm.EscrowMessageForm) bool {
	t.Helper()
	forms, err := svm.MessageForms(scheme)
	require.NoError(t, err)
	for _, f := range forms {
		if f == form {
			return true
		}
	}
	return false
}

func signForm(key ed25519.PrivateKey, form svm.EscrowMessageForm, kind svm.WitnessKind, hash [32]byte) string {
	pk := svm.Pubkey(key.Public().(ed25519.PublicKey))
	return "0x" + hex.EncodeToString(ed25519.Sign(key, svm.EscrowMessage(form, svm.WitnessLabel(kind), hash, pk)))
}

// solanaHonest returns the solana-honest commitment vector and its payer's key, a repeated byte seed.
func solanaHonest(t *testing.T) (namedRequest, ed25519.PrivateKey, SignedMessageInput) {
	t.Helper()
	raw, err := os.ReadFile(conformancePath("commitment-vectors.json"))
	require.NoError(t, err)
	var v commitmentVectors
	require.NoError(t, json.Unmarshal(raw, &v))
	for _, c := range v.Requests {
		if c.Name != "solana-honest" {
			continue
		}
		var req struct {
			Source struct {
				Account string `json:"account"`
			} `json:"source"`
			SenderAuth struct {
				SignedMessages []SignedMessageInput `json:"signed_messages"`
			} `json:"sender_auth"`
		}
		require.NoError(t, json.Unmarshal([]byte(c.Request), &req))
		for b := 0; b < 256; b++ {
			key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{byte(b)}, 32))
			if base58.Encode(key.Public().(ed25519.PublicKey)) == req.Source.Account {
				return namedRequest{Name: c.Name, Request: c.Request, Solana: c.Solana}, key, req.SenderAuth.SignedMessages[0]
			}
		}
		t.Fatal("solana-honest: payer key is not a repeated byte seed")
	}
	t.Fatal("no solana-honest vector")
	return namedRequest{}, nil, SignedMessageInput{}
}

// The deposit binding accepts exactly the forms the escrow's scheme accepts: raw only for "", and
// bare, v1 and v0 for escrow-text-v1.
func TestSolanaDepositBindingByScheme(t *testing.T) {
	honest, key, deposit := solanaHonest(t)
	digest := [32]byte(mustHex(t, deposit.Message[2:]))
	for _, scheme := range svm.MessageSchemes {
		for _, form := range allSolanaForms {
			t.Run(string(scheme)+"/"+form.String(), func(t *testing.T) {
				request := strings.Replace(honest.Request, deposit.Signature, signForm(key, form, svm.WitnessDeposit, digest), 1)
				domain := *honest.Solana
				domain.MessageScheme = string(scheme)
				got, err := VerifyRequestCommitment([]byte(request), &domain)
				if schemeAccepts(t, scheme, form) {
					require.NoError(t, err)
					require.True(t, got.Verified())
					return
				}
				requireCommitmentOutcome(t, err, OutcomeSignerMismatch)
			})
		}
	}
	// A reserve text never binds a deposit.
	request := strings.Replace(honest.Request, deposit.Signature, signForm(key, svm.EscrowFormBare, svm.WitnessReserve, digest), 1)
	domain := *honest.Solana
	domain.MessageScheme = string(svm.SchemeEscrowTextV1)
	_, err := VerifyRequestCommitment([]byte(request), &domain)
	requireCommitmentOutcome(t, err, OutcomeSignerMismatch)
}

func TestSolanaUnknownSchemeIsMisconfigured(t *testing.T) {
	honest, _, _ := solanaHonest(t)
	for _, scheme := range []string{"text", " ", "ESCROW-TEXT-V1"} {
		domain := *honest.Solana
		domain.MessageScheme = scheme
		_, err := VerifyRequestCommitment([]byte(honest.Request), &domain)
		requireCommitmentOutcome(t, err, OutcomeVerifierMisconfigured)
	}
	// A reserve the solana-verified vector verifies, so the unknown scheme is all that refuses it.
	auth, expected := solanaVerifiedReserve(t)
	require.Equal(t, ReserveReasonVerified, VerifyReserveAuth(context.Background(), auth, expected, nil).Reason)
	expected.SvmMessageScheme = "text"
	got := VerifyReserveAuth(context.Background(), auth, expected, nil)
	require.Equal(t, ReserveReasonVerifierMisconfigured, got.Reason, got.Detail)
	require.Contains(t, got.Detail, "message scheme")
}

func solanaVerifiedReserve(t *testing.T) (ReserveAuth, ReserveAuthExpectations) {
	t.Helper()
	for _, c := range readReserveAuthVectors(t).Vectors {
		if c.Name == "solana-verified" {
			require.Equal(t, 5, *c.Input.Expected.SvmSignatureDomainVersion)
			return c.Input.Auth, c.Input.Expected
		}
	}
	t.Fatal("no solana-verified reserve vector")
	return ReserveAuth{}, ReserveAuthExpectations{}
}

// The forms each scheme accepts, written out rather than read from svm.MessageForms: the empty
// scheme accepts the raw hash only, and the text scheme the bare, v1 and v0 text only.
var acceptedFormsByScheme = map[svm.MessageScheme]map[svm.EscrowMessageForm]bool{
	svm.SchemeRawHash:      {svm.EscrowFormRaw: true, svm.EscrowFormBare: false, svm.EscrowFormV1: false, svm.EscrowFormV0: false},
	svm.SchemeEscrowTextV1: {svm.EscrowFormRaw: false, svm.EscrowFormBare: true, svm.EscrowFormV1: true, svm.EscrowFormV0: true},
}

func TestSolanaDepositBindingHardCodedForms(t *testing.T) {
	honest, key, deposit := solanaHonest(t)
	digest := [32]byte(mustHex(t, deposit.Message[2:]))
	for scheme, forms := range acceptedFormsByScheme {
		for form, accepted := range forms {
			request := strings.Replace(honest.Request, deposit.Signature, signForm(key, form, svm.WitnessDeposit, digest), 1)
			domain := *honest.Solana
			domain.MessageScheme = string(scheme)
			_, err := VerifyRequestCommitment([]byte(request), &domain)
			if accepted {
				require.NoError(t, err, "scheme %q form %v", scheme, form)
				continue
			}
			requireCommitmentOutcome(t, err, OutcomeSignerMismatch)
		}
	}
}

func TestSolanaReserveBindingHardCodedForms(t *testing.T) {
	vector, expected := solanaVerifiedReserve(t)
	expected.Reserver = base58.Encode(textTestKey.Public().(ed25519.PublicKey))
	digest := [32]byte(mustHex(t, vector.Message[2:]))
	for scheme, forms := range acceptedFormsByScheme {
		for form, accepted := range forms {
			auth := vector
			auth.Signature = signForm(textTestKey, form, svm.WitnessReserve, digest)
			exp := expected
			exp.SvmMessageScheme = string(scheme)
			got := VerifyReserveAuth(context.Background(), auth, exp, nil)
			want := ReserveReasonSignerMismatch
			if accepted {
				want = ReserveReasonVerified
			}
			require.Equal(t, want, got.Reason, "scheme %q form %v: %s", scheme, form, got.Detail)
		}
	}
}

// solanaTextRequest is the Solana round-trip request with its deposit re-signed as the escrow text.
func solanaTextRequest(t *testing.T) (PaymentRequest, Expectations) {
	t.Helper()
	req, expected := solanaRequest(t)
	require.Equal(t, 5, *expected.SvmSignatureDomainVersion)
	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = byte(i + 1)
	}
	m := req.SenderAuth.SignedMessages[0]
	prehash := m.MessagePrehash
	sig, err := solanaAdapter{}.Sign(SignedMessageInput{Message: m.Message, MessagePrehash: &prehash, SvmMessageScheme: string(svm.SchemeEscrowTextV1)}, hex.EncodeToString(seed))
	require.NoError(t, err)
	require.NotEqual(t, m.Signature, sig)
	req.SenderAuth.SignedMessages[0].Signature = sig
	return req, expected
}

// VerifyPaymentRequest carries Expectations.SvmMessageScheme to the commitment check and the
// deposit binding: a v5 text-signed deposit verifies under escrow-text-v1 and is refused under "".
func TestVerifyPaymentRequestSolanaByScheme(t *testing.T) {
	req, expected := solanaTextRequest(t)
	expected.SvmMessageScheme = string(svm.SchemeEscrowTextV1)
	res, err := VerifyPaymentRequest(req, VerifyPaymentRequestExpectations{Expectations: expected})
	require.NoError(t, err)
	require.Equal(t, "1000000", res.Results[0].Amount)

	expected.SvmMessageScheme = ""
	_, err = VerifyPaymentRequest(req, VerifyPaymentRequestExpectations{Expectations: expected})
	requireCommitmentOutcome(t, err, OutcomeSignerMismatch)
}

// RecoverAndVerify alone, with no commitment check before it, carries the scheme to the binding.
func TestSolanaRecoverAndVerifyTextDeposit(t *testing.T) {
	req, expected := solanaTextRequest(t)
	signed := signedMessageInput(req.SenderAuth.SignedMessages[0])
	source := SourceRef{Network: "solana:mainnet", Asset: strings.SplitN(req.Source.AssetIdentifier, ":", 3)[2], Account: req.Source.Account}
	commitment := CommitmentExpectation{RequestID: req.RequestId, Destinations: []DestinationLeg{{AssetIdentifier: req.Destination[0].AssetIdentifier, Account: req.Destination[0].Account}}}
	expected.SvmMessageScheme = string(svm.SchemeEscrowTextV1)
	_, err := solanaAdapter{}.RecoverAndVerify(signed, source, commitment, expected)
	require.NoError(t, err)
	expected.SvmMessageScheme = ""
	_, err = solanaAdapter{}.RecoverAndVerify(signed, source, commitment, expected)
	requireCommitmentOutcome(t, err, OutcomeSignerMismatch)
}

// Expectations.SvmMessageScheme reaches the deposit binding of RecoverAndVerify.
func TestSolanaRecoverAndVerifyByScheme(t *testing.T) {
	honest, key, deposit := solanaHonest(t)
	digest := [32]byte(mustHex(t, deposit.Message[2:]))
	for _, scheme := range svm.MessageSchemes {
		for _, form := range []svm.EscrowMessageForm{svm.EscrowFormRaw, svm.EscrowFormBare} {
			signed := deposit
			signed.Signature = signForm(key, form, svm.WitnessDeposit, digest)
			version := honest.Solana.DomainVersion
			expected := Expectations{
				EscrowContract:            honest.Solana.EscrowProgramID,
				SvmSignatureClusterID:     honest.Solana.ClusterID,
				SvmSignatureDomainVersion: &version,
				SvmMessageScheme:          string(scheme),
			}
			_, err := solanaAdapter{}.RecoverAndVerify(signed, SourceRef{Account: base58.Encode(key.Public().(ed25519.PublicKey))}, CommitmentExpectation{}, expected)
			var ce *CommitmentError
			signerRefused := err != nil && errors.As(err, &ce) && ce.Result.Outcome == OutcomeSignerMismatch
			require.Equal(t, !schemeAccepts(t, scheme, form), signerRefused, "scheme %q form %v: %v", scheme, form, err)
		}
	}
}

func TestSolanaReserveBindingByScheme(t *testing.T) {
	var vector *ReserveAuth
	var expected ReserveAuthExpectations
	for _, c := range readReserveAuthVectors(t).Vectors {
		if c.Name == "solana-verified" {
			vector, expected = &c.Input.Auth, c.Input.Expected
		}
	}
	require.NotNil(t, vector)
	expected.Reserver = base58.Encode(textTestKey.Public().(ed25519.PublicKey))
	digest := [32]byte(mustHex(t, vector.Message[2:]))
	for _, scheme := range svm.MessageSchemes {
		for _, form := range allSolanaForms {
			t.Run(string(scheme)+"/"+form.String(), func(t *testing.T) {
				auth := *vector
				auth.Signature = signForm(textTestKey, form, svm.WitnessReserve, digest)
				exp := expected
				exp.SvmMessageScheme = string(scheme)
				got := VerifyReserveAuth(context.Background(), auth, exp, nil)
				if schemeAccepts(t, scheme, form) {
					require.Equal(t, ReserveReasonVerified, got.Reason, got.Detail)
					return
				}
				require.Equal(t, ReserveReasonSignerMismatch, got.Reason, got.Detail)
			})
		}
	}
	// A deposit text never authorizes a reserve.
	auth := *vector
	auth.Signature = signForm(textTestKey, svm.EscrowFormBare, svm.WitnessDeposit, digest)
	exp := expected
	exp.SvmMessageScheme = string(svm.SchemeEscrowTextV1)
	require.Equal(t, ReserveReasonSignerMismatch, VerifyReserveAuth(context.Background(), auth, exp, nil).Reason)
}

// RecoverSigner proves the signer of a raw or text signature, deposit or reserve, and nothing else.
func TestSolanaRecoverSignerAcceptsRawAndText(t *testing.T) {
	account := base58.Encode(textTestKey.Public().(ed25519.PublicKey))
	hash := [32]byte(bytes.Repeat([]byte{0xab}, 32))
	message := "0x" + hex.EncodeToString(hash[:])
	for _, kind := range []svm.WitnessKind{svm.WitnessDeposit, svm.WitnessReserve} {
		for _, form := range allSolanaForms {
			got, err := solanaAdapter{}.RecoverSigner(SignedMessageInput{Message: message, Signature: signForm(textTestKey, form, kind, hash)}, SourceRef{Account: account})
			require.NoError(t, err, "kind %d form %v", kind, form)
			require.Equal(t, account, got)
		}
	}
	other := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x43}, 32))
	for name, sig := range map[string]string{
		"another key":     signForm(other, svm.EscrowFormBare, svm.WitnessDeposit, hash),
		"release text":    signForm(textTestKey, svm.EscrowFormBare, svm.WitnessRelease, hash),
		"another hash":    signForm(textTestKey, svm.EscrowFormRaw, svm.WitnessDeposit, [32]byte{1}),
		"plain text form": "0x" + hex.EncodeToString(ed25519.Sign(textTestKey, []byte("atum deposit v1"))),
	} {
		_, err := solanaAdapter{}.RecoverSigner(SignedMessageInput{Message: message, Signature: sig}, SourceRef{Account: account})
		require.ErrorIs(t, err, ErrSignerMismatch, name)
	}
}

// The adapter and LocalKeySigner sign the raw hash by default and the escrow text only when the
// SDK-local scheme carrier names the text scheme.
func TestSolanaSignByScheme(t *testing.T) {
	seed := hex.EncodeToString(textTestKey.Seed())
	pub := textTestKey.Public().(ed25519.PublicKey)
	hash := [32]byte(bytes.Repeat([]byte{0xcd}, 32))
	reservePrehash := `{"deposit_hash":"0x11","recipient":"r","quote_hash":"0x33","source_amount":"1"}`
	depositPrehash := `{"deposit_request_hash":"0x11","depositor":"d","destination":"x"}`
	cases := []struct {
		name    string
		scheme  string
		prehash *string
		want    []byte
	}{
		{"default raw", "", nil, hash[:]},
		{"default raw, reserve record", "", &reservePrehash, hash[:]},
		{"text deposit", "escrow-text-v1", nil, svm.EscrowText(svm.EscrowLabelDeposit, hash)},
		{"text deposit record", "escrow-text-v1", &depositPrehash, svm.EscrowText(svm.EscrowLabelDeposit, hash)},
		{"text reserve record", "escrow-text-v1", &reservePrehash, svm.EscrowText(svm.EscrowLabelReserve, hash)},
	}
	signer, err := LocalKeySigner("solana:devnet", seed)
	require.NoError(t, err)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := SignedMessageInput{Message: "0x" + hex.EncodeToString(hash[:]), MessagePrehash: tc.prehash, SvmMessageScheme: tc.scheme}
			sigHex, err := solanaAdapter{}.Sign(in, seed)
			require.NoError(t, err)
			require.True(t, ed25519.Verify(pub, tc.want, mustHex(t, sigHex[2:])))
			out, err := signer.Sign(in)
			require.NoError(t, err)
			require.Equal(t, sigHex, out.Signature)
			require.Equal(t, base58.Encode(pub), out.DelegateSigner)
		})
	}
	_, err = solanaAdapter{}.Sign(SignedMessageInput{Message: "0x" + hex.EncodeToString(hash[:]), SvmMessageScheme: "text"}, seed)
	require.ErrorContains(t, err, "unknown message scheme")
	_, err = solanaAdapter{}.Sign(SignedMessageInput{Message: "0x00", SvmMessageScheme: "escrow-text-v1"}, seed)
	require.ErrorContains(t, err, "32-byte")

	// The carrier is never on the wire.
	b, err := json.Marshal(SignedMessageInput{Message: "0x00", SvmMessageScheme: "escrow-text-v1"})
	require.NoError(t, err)
	require.NotContains(t, string(b), "escrow-text-v1")
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	require.NoError(t, err)
	return b
}
