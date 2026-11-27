package senderauth

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
	"testing"

	evmencoding "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/encoding"
	svm "github.com/atum-labs/protocol/contracts/svm/bindings/go/escrow-encoding/encoding"
	tvmencoding "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/encoding"
	paymentrequest "github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/generated"

	"github.com/ethereum/go-ethereum/common"
	"github.com/mr-tron/base58"
	"github.com/stretchr/testify/require"
)

// Pinned ids of the go-built fixtures, so the derivation and the reference cannot drift together.
const (
	pinnedEVMPaymentID    = "0x5d2439bce5ec65992fc4879fbd24c69923f19a9a6355b038fb9246ee739d5182"
	pinnedTronPaymentID   = "0x1317eeb7d0ff51bb3ba2a4921fc88c51734ce05465f2524aacfef52a90eef038"
	pinnedSolanaPaymentID = "0x610bb1dd09ea740f507975776c822b547f5bc321dd08c456322969c2b422f9d4"
)

// depositFixture is one go-built payment request split into the inputs DepositFromSenderAuth takes.
type depositFixture struct {
	network, depositor string
	senderAuth         json.RawMessage
	auth               paymentrequest.SenderAuth
	solana             *SolanaDomain
}

func depositFixtures(t *testing.T) map[string]depositFixture {
	t.Helper()
	out := map[string]depositFixture{}
	for _, r := range goBuiltRequests(t) {
		var doc struct {
			Source struct {
				AssetIdentifier string `json:"asset_identifier"`
				Account         string `json:"account"`
			} `json:"source"`
			SenderAuth json.RawMessage `json:"sender_auth"`
		}
		require.NoError(t, json.Unmarshal([]byte(r.Request), &doc))
		var auth paymentrequest.SenderAuth
		require.NoError(t, json.Unmarshal(doc.SenderAuth, &auth))
		out[r.Name] = depositFixture{
			network:    strings.SplitN(doc.Source.AssetIdentifier, "/", 2)[0],
			depositor:  doc.Source.Account,
			senderAuth: doc.SenderAuth,
			auth:       auth,
			solana:     r.Solana,
		}
	}
	return out
}

// referencePermitPaymentID is payment-gw calculateEVMPaymentID / calculateTVMPaymentID.
func referencePermitPaymentID(t *testing.T, namespace, depositor string, auth paymentrequest.SenderAuth) string {
	t.Helper()
	first := auth.SignedMessages[0]
	signature, err := hex.DecodeString(strings.TrimPrefix(first.Signature, "0x"))
	require.NoError(t, err)
	var prehash map[string]any
	require.NoError(t, json.Unmarshal([]byte(first.MessagePrehash), &prehash))
	nonce, ok := new(big.Int).SetString(prehash["message"].(map[string]any)["nonce"].(string), 10)
	require.True(t, ok)
	var id []byte
	if namespace == "eip155" {
		id, err = evmencoding.NewEscrowPaymentIdEncoder().Digest(common.HexToAddress(depositor), signature, nonce)
	} else {
		id, err = tvmencoding.NewEscrowPaymentIdEncoder().Digest(depositor, signature, nonce)
	}
	require.NoError(t, err)
	return fmt.Sprintf("0x%x", id)
}

// referenceSolanaPaymentID is payment-gw calculateSVMPaymentID at signature domain version 4 or later.
func referenceSolanaPaymentID(t *testing.T, auth paymentrequest.SenderAuth, d SolanaDomain) string {
	t.Helper()
	programID, err := svm.PubkeyFromBase58(d.EscrowProgramID)
	require.NoError(t, err)
	domain, err := svm.NewEscrowDomain(d.ClusterID, uint8(d.DomainVersion), programID)
	require.NoError(t, err)
	hash, err := svm.DeterminePaymentIDV2(paymentrequest.SchemaJson{SenderAuth: &auth}, domain)
	require.NoError(t, err)
	return fmt.Sprintf("0x%x", hash[:])
}

func witnessReserver(t *testing.T, auth paymentrequest.SenderAuth) string {
	t.Helper()
	var prehash map[string]any
	require.NoError(t, json.Unmarshal([]byte(auth.SignedMessages[0].MessagePrehash), &prehash))
	return prehash["message"].(map[string]any)["witness"].(map[string]any)["reserver"].(string)
}

// tronBase58 spells a 20-byte account as a base58check Tron address.
func tronBase58(addr common.Address) string {
	payload := append([]byte{0x41}, addr.Bytes()...)
	first := sha256.Sum256(payload)
	second := sha256.Sum256(first[:])
	return base58.Encode(append(payload, second[:4]...))
}

func TestDepositFromSenderAuthMatchesPaymentGateway(t *testing.T) {
	fixtures := depositFixtures(t)

	evm := fixtures["go-built-evm"]
	got, err := DepositFromSenderAuth(evm.network, evm.depositor, evm.senderAuth)
	require.NoError(t, err)
	require.Equal(t, referencePermitPaymentID(t, "eip155", evm.depositor, evm.auth), got.PaymentID)
	require.Equal(t, pinnedEVMPaymentID, got.PaymentID)
	require.Equal(t, witnessReserver(t, evm.auth), got.Reserver)

	tron := fixtures["go-built-tron"]
	addr := common.HexToAddress(tron.depositor)
	for _, depositor := range []string{"41" + hex.EncodeToString(addr.Bytes()), tronBase58(addr)} {
		got, err := DepositFromSenderAuth(tron.network, depositor, tron.senderAuth)
		require.NoError(t, err, depositor)
		require.Equal(t, referencePermitPaymentID(t, "tron", depositor, tron.auth), got.PaymentID, depositor)
		require.Equal(t, pinnedTronPaymentID, got.PaymentID, depositor)
		require.Equal(t, witnessReserver(t, tron.auth), got.Reserver, depositor)
	}

	sol := fixtures["go-built-solana"]
	got, err = DepositFromSenderAuth(sol.network, sol.depositor, sol.senderAuth)
	require.NoError(t, err)
	require.Equal(t, referenceSolanaPaymentID(t, sol.auth, *sol.solana), got.PaymentID)
	require.Equal(t, pinnedSolanaPaymentID, got.PaymentID)
	require.Empty(t, got.Reserver)

	// The message is hex in any case, and the id is always the lowercase spelling.
	upper := sol.auth
	upper.SignedMessages = append([]paymentrequest.SignedMessage(nil), upper.SignedMessages...)
	upper.SignedMessages[0].Message = "0x" + strings.ToUpper(strings.TrimPrefix(upper.SignedMessages[0].Message, "0x"))
	require.NotEqual(t, sol.auth.SignedMessages[0].Message, upper.SignedMessages[0].Message)
	raw, err := json.Marshal(upper)
	require.NoError(t, err)
	got, err = DepositFromSenderAuth(sol.network, sol.depositor, raw)
	require.NoError(t, err)
	require.Equal(t, pinnedSolanaPaymentID, got.PaymentID)
}

// withSignature returns the fixture's sender_auth with signed_messages[0].signature replaced.
func withSignature(t *testing.T, f depositFixture, signature string) (json.RawMessage, paymentrequest.SenderAuth) {
	t.Helper()
	auth := f.auth
	auth.SignedMessages = append([]paymentrequest.SignedMessage(nil), auth.SignedMessages...)
	auth.SignedMessages[0].Signature = signature
	raw, err := json.Marshal(auth)
	require.NoError(t, err)
	return raw, auth
}

func TestDepositFromSenderAuthHashesTheSignatureAsSent(t *testing.T) {
	fixtures := depositFixtures(t)
	sixtyFour := "0x" + strings.Repeat("ab", 64)
	for _, name := range []string{"go-built-evm", "go-built-tron"} {
		f := fixtures[name]
		namespace := namespaceOf(f.network)
		for _, signature := range []string{"0x", sixtyFour} {
			raw, auth := withSignature(t, f, signature)
			got, err := DepositFromSenderAuth(f.network, f.depositor, raw)
			require.NoError(t, err, name+" "+signature)
			require.Equal(t, referencePermitPaymentID(t, namespace, f.depositor, auth), got.PaymentID, name+" "+signature)
		}
	}
}

func TestDepositFromSenderAuthRefusesANumericNonce(t *testing.T) {
	f := depositFixtures(t)["go-built-evm"]
	auth := f.auth
	auth.SignedMessages = append([]paymentrequest.SignedMessage(nil), auth.SignedMessages...)
	prehash := strings.Replace(auth.SignedMessages[0].MessagePrehash, `"nonce":"123"`, `"nonce":123`, 1)
	require.NotEqual(t, auth.SignedMessages[0].MessagePrehash, prehash)
	auth.SignedMessages[0].MessagePrehash = prehash
	raw, err := json.Marshal(auth)
	require.NoError(t, err)
	_, err = DepositFromSenderAuth(f.network, f.depositor, raw)
	require.ErrorIs(t, err, ErrDepositRefUnreadable)
}

func TestDepositFromSenderAuthRefusesCaseVariantMembers(t *testing.T) {
	f := depositFixtures(t)["go-built-evm"]
	text := string(f.senderAuth)
	cases := map[string]string{
		"renamed scheme":       strings.Replace(text, `"message_scheme"`, `"Message_Scheme"`, 1),
		"renamed signature":    strings.Replace(text, `"signature"`, `"Signature"`, 1),
		"renamed prehash":      strings.Replace(text, `"message_prehash"`, `"MESSAGE_PREHASH"`, 1),
		"twin signature":       strings.Replace(text, `"signature"`, `"Signature":"0x","signature"`, 1),
		"twin nonce":           strings.Replace(text, `\"nonce\":\"123\"`, `\"Nonce\":\"1\",\"nonce\":\"123\"`, 1),
		"renamed nonce":        strings.Replace(text, `\"nonce\":\"123\"`, `\"Nonce\":\"123\"`, 1),
		"renamed witness role": strings.Replace(text, `\"reserver\":\"0x`, `\"Reserver\":\"0x`, 1),
	}
	for name, doc := range cases {
		require.NotEqual(t, text, doc, name)
		_, err := DepositFromSenderAuth(f.network, f.depositor, json.RawMessage(doc))
		require.ErrorIs(t, err, ErrDepositRefUnreadable, name)
	}
}

func TestDepositFromSenderAuthRefusesUnusableInputs(t *testing.T) {
	fixtures := depositFixtures(t)
	evm, sol := fixtures["go-built-evm"], fixtures["go-built-solana"]
	cases := map[string]struct {
		network, depositor string
		auth               string
	}{
		"not an object":         {evm.network, evm.depositor, `[]`},
		"no signed messages":    {evm.network, evm.depositor, `{"message_scheme":"EVM_PERMIT2","signed_messages":[]}`},
		"unsupported network":   {"bip122:000000000019d6689c085ae165831e93", evm.depositor, string(evm.senderAuth)},
		"wrong chain id":        {"eip155:8453", evm.depositor, string(evm.senderAuth)},
		"non-hex depositor":     {evm.network, "not-an-address", string(evm.senderAuth)},
		"solana wrong scheme":   {sol.network, sol.depositor, strings.Replace(string(sol.senderAuth), `"SOLANA"`, `"EVM_PERMIT2"`, 1)},
		"solana short message":  {sol.network, sol.depositor, strings.Replace(string(sol.senderAuth), `"message":"0x`, `"message":"0x00`, 1)},
		"evm source on solana":  {sol.network, sol.depositor, string(evm.senderAuth)},
		"non-hex signature":     {evm.network, evm.depositor, strings.Replace(string(evm.senderAuth), `"signature":"0x`, `"signature":"0xzz`, 1)},
		"missing signature key": {evm.network, evm.depositor, strings.Replace(string(evm.senderAuth), `"signature"`, `"sig"`, 1)},
	}
	for name, c := range cases {
		_, err := DepositFromSenderAuth(c.network, c.depositor, json.RawMessage(c.auth))
		require.ErrorIs(t, err, ErrDepositRefUnreadable, name)
	}
}
