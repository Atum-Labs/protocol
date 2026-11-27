package senderauth

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func strPtr(s string) *string { return &s }

// bindingSignedMessage maps the binding-agnostic verify input back into the wire
// SignedMessage, so these tests can assemble a generated PaymentRequest to drive the
// VerifyPaymentRequest convenience wrapper end-to-end.
func bindingSignedMessage(in SignedMessageInput) SignedMessage {
	var prehash string
	if in.MessagePrehash != nil {
		prehash = *in.MessagePrehash
	}
	return SignedMessage{
		Message:        in.Message,
		Signature:      in.Signature,
		MessagePrehash: prehash,
		Payload:        in.Payload,
	}
}

// verifyExpectations is the scheme expectations verifyPaymentRequest takes; maxSourceAmount
// is derived from the request, not supplied here.
func verifyExpectations(d ChainDefaults) VerifyPaymentRequestExpectations {
	return VerifyPaymentRequestExpectations{
		Expectations: Expectations{
			EscrowContract: d.EscrowContract,
			Reserver:       d.QuoteSelector,
			Releaser:       d.FulfillmentVerifierAccount,
		},
	}
}

// TestVerifyPaymentRequestEVM drives the chain-agnostic verifier end-to-end over a real
// EVM sender_auth message wrapped in the generated PaymentRequest wire type: it recovers
// the signer, binds the universal terms, and returns the parsed permits.
func TestVerifyPaymentRequestEVM(t *testing.T) {
	d, _ := evmTestDefaults()
	signed, source := buildEvmSigned(t, nil)

	req := PaymentRequest{
		SenderAuth: &SenderAuth{
			MessageScheme:  SenderAuthMessageScheme("EVM_PERMIT2"),
			SignedMessages: []SignedMessage{bindingSignedMessage(signed)},
		},
		Source: OwnedAsset{
			AssetIdentifier: "eip155:1/erc20:" + source.Asset,
			Account:         source.Account,
		},
		MaxSourceAmount: strPtr("1000000"),
		RequestId:       evmTestCommitment.RequestID,
		Destination:     []OwnedAsset{{AssetIdentifier: evmTestCommitment.Destinations[0].AssetIdentifier, Account: evmTestCommitment.Destinations[0].Account}},
	}

	res, err := VerifyPaymentRequest(req, verifyExpectations(d))
	require.NoError(t, err)
	require.Len(t, res.Results, 1)
	require.Equal(t, "1000000", res.Results[0].Amount)
	require.Equal(t, 1924991999, res.Results[0].DeadlineSec)
	require.Equal(t, d.EscrowContract, res.Results[0].Permit.Spender)
	require.Equal(t, source.Account, res.RecoveredAccount)
}

// TestVerifyPaymentRequestAmountMismatch: the permit amount must equal the request's
// max_source_amount, which the verifier derives from the request itself.
func TestVerifyPaymentRequestAmountMismatch(t *testing.T) {
	d, _ := evmTestDefaults()
	req, _ := evmRequest(t, "999")

	_, err := VerifyPaymentRequest(req, verifyExpectations(d))
	require.ErrorContains(t, err, "permit amount does not match max_source_amount")
}

func TestVerifyPaymentRequestNoSignedMessages(t *testing.T) {
	_, err := VerifyPaymentRequest(PaymentRequest{}, VerifyPaymentRequestExpectations{})
	require.ErrorContains(t, err, "no signed_messages")
}

// evmRequest wraps a freshly built+signed EVM message into a generated PaymentRequest.
func evmRequest(t *testing.T, maxSourceAmount string) (PaymentRequest, SourceRef) {
	t.Helper()
	signed, source := buildEvmSigned(t, nil)
	return PaymentRequest{
		SenderAuth: &SenderAuth{
			MessageScheme:  SenderAuthMessageScheme("EVM_PERMIT2"),
			SignedMessages: []SignedMessage{bindingSignedMessage(signed)},
		},
		Source: OwnedAsset{
			AssetIdentifier: "eip155:1/erc20:" + source.Asset,
			Account:         source.Account,
		},
		MaxSourceAmount: strPtr(maxSourceAmount),
		RequestId:       evmTestCommitment.RequestID,
		Destination:     []OwnedAsset{{AssetIdentifier: evmTestCommitment.Destinations[0].AssetIdentifier, Account: evmTestCommitment.Destinations[0].Account}},
	}, source
}

// TestVerifyPaymentRequestCallerBindsAmount: a caller-supplied MaxSourceAmount is
// authoritative over the request's own field (a consumer that did not author the request
// pins its agreed term).
func TestVerifyPaymentRequestCallerBindsAmount(t *testing.T) {
	d, _ := evmTestDefaults()
	req, _ := evmRequest(t, "1000000") // request self-reports 1000000 (would pass)

	exp := verifyExpectations(d)
	exp.MaxSourceAmount = "999" // caller's agreed amount differs → mismatch caught
	_, err := VerifyPaymentRequest(req, exp)
	require.ErrorContains(t, err, "permit amount does not match max_source_amount")
}

// TestVerifyPaymentRequestCallerBindsAsset: a caller-supplied SourceAsset is authoritative
// over the request's own asset.
func TestVerifyPaymentRequestCallerBindsAsset(t *testing.T) {
	d, _ := evmTestDefaults()
	req, _ := evmRequest(t, "1000000")

	exp := verifyExpectations(d)
	exp.SourceAsset = "0x6666666666666666666666666666666666666666"
	_, err := VerifyPaymentRequest(req, exp)
	require.ErrorContains(t, err, "permit token does not match the source asset")
}

// TestVerifyPaymentRequestMalformedAsset: a malformed asset_identifier is refused by the
// commitment check, which runs first, as scheme_mismatch.
func TestVerifyPaymentRequestMalformedAsset(t *testing.T) {
	d, _ := evmTestDefaults()
	req, _ := evmRequest(t, "1000000")
	req.Source.AssetIdentifier = "not-a-caip-asset"

	_, err := VerifyPaymentRequest(req, verifyExpectations(d))
	requireCommitmentOutcome(t, err, OutcomeSchemeMismatch)
}

// The deposit must commit to the request's own destination: a request whose payee was rewritten
// after signing is refused.
func TestVerifyPaymentRequestRefusesARewrittenPayee(t *testing.T) {
	d, _ := evmTestDefaults()
	req, _ := evmRequest(t, "1000000")
	req.Destination[0].Account = "0x1111111111111111111111111111111111111111"

	_, err := VerifyPaymentRequest(req, verifyExpectations(d))
	requireCommitmentOutcome(t, err, OutcomeDestinationMismatch)
}

// The commitment check runs before recovery, so its outcome is reported even when a later check
// would also fail.
func TestVerifyPaymentRequestChecksTheCommitmentFirst(t *testing.T) {
	d, _ := evmTestDefaults()

	req, _ := evmRequest(t, "999")
	req.RequestId = "req_other"
	_, err := VerifyPaymentRequest(req, verifyExpectations(d))
	requireCommitmentOutcome(t, err, OutcomeRequestHashMismatch)

	req, _ = evmRequest(t, "1000000")
	req.Destination = nil
	_, err = VerifyPaymentRequest(req, verifyExpectations(d))
	requireCommitmentOutcome(t, err, OutcomeDestinationMismatch)

	req, _ = evmRequest(t, "1000000")
	req.SenderAuth.MessageScheme = ""
	_, err = VerifyPaymentRequest(req, verifyExpectations(d))
	requireCommitmentOutcome(t, err, OutcomeSchemeMismatch)

	req, _ = evmRequest(t, "1000000")
	req.SenderAuth.MessageScheme = SenderAuthMessageScheme("SOLANA")
	_, err = VerifyPaymentRequest(req, verifyExpectations(d))
	requireCommitmentOutcome(t, err, OutcomeSchemeMismatch)
}

// solanaRequest wraps the Solana round-trip fixture into a generated PaymentRequest.
func solanaRequest(t *testing.T) (PaymentRequest, Expectations) {
	t.Helper()
	signed, source, expected, _ := solanaRoundTripFixture(t)
	leg := solanaTestCommitment.Destinations[0]
	return PaymentRequest{
		SenderAuth: &SenderAuth{
			MessageScheme:  SenderAuthMessageScheme("SOLANA"),
			SignedMessages: []SignedMessage{bindingSignedMessage(signed)},
		},
		Source:          OwnedAsset{AssetIdentifier: source.Network + "/token:" + source.Asset, Account: source.Account},
		MaxSourceAmount: strPtr("1000000"),
		RequestId:       solanaTestCommitment.RequestID,
		Destination:     []OwnedAsset{{AssetIdentifier: leg.AssetIdentifier, Account: leg.Account}},
	}, expected
}

func TestVerifyPaymentRequestSolana(t *testing.T) {
	req, expected := solanaRequest(t)
	res, err := VerifyPaymentRequest(req, VerifyPaymentRequestExpectations{Expectations: expected})
	require.NoError(t, err)
	require.Equal(t, "1000000", res.Results[0].Amount)

	req.Destination[0].Account = "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR"
	_, err = VerifyPaymentRequest(req, VerifyPaymentRequestExpectations{Expectations: expected})
	requireCommitmentOutcome(t, err, OutcomeDestinationMismatch)
}

// A Solana payment needs the escrow domain from the verifier's configuration.
func TestVerifyPaymentRequestSolanaNeedsTheEscrowDomain(t *testing.T) {
	req, expected := solanaRequest(t)
	expected.SvmSignatureDomainVersion = nil
	_, err := VerifyPaymentRequest(req, VerifyPaymentRequestExpectations{Expectations: expected})
	requireCommitmentOutcome(t, err, OutcomeVerifierMisconfigured)
}

// Decoding keeps only the last of two member names that differ in letter case, so the decoded
// request cannot show the twin; VerifyPaymentRequestJSON refuses it from the bytes.
func TestVerifyPaymentRequestJSONRefusesCaseTwinMembers(t *testing.T) {
	d, _ := evmTestDefaults()
	req, _ := evmRequest(t, "1000000")
	req.Version = "1.0"
	req.FulfillmentAmount = "1000000"
	req.QuoteDeadline = time.Unix(1924990000, 0).UTC()
	req.FulfillmentDeadline = time.Unix(1924991000, 0).UTC()
	honest, err := json.Marshal(req)
	require.NoError(t, err)

	res, err := VerifyPaymentRequestJSON(honest, verifyExpectations(d))
	require.NoError(t, err)
	require.Equal(t, "1000000", res.Results[0].Amount)

	attacker := `"destination":[{"asset_identifier":"` + req.Destination[0].AssetIdentifier + `","account":"0x1111111111111111111111111111111111111111"}],"Destination":`
	twin := []byte(strings.Replace(string(honest), `"destination":`, attacker, 1))
	var decoded PaymentRequest
	require.NoError(t, json.Unmarshal(twin, &decoded))
	require.Equal(t, req.Destination[0].Account, decoded.Destination[0].Account, "decoding keeps the last spelling")

	_, err = VerifyPaymentRequestJSON(twin, verifyExpectations(d))
	requireCommitmentOutcome(t, err, OutcomeRequestMalformed)
}

// The JSON entry point must judge the shared vectors exactly as the TypeScript one does.
func TestVerifyPaymentRequestJSONVectors(t *testing.T) {
	raw, err := os.ReadFile(conformancePath("verify-json-vectors.json"))
	require.NoError(t, err)
	var doc struct {
		Vectors []struct {
			Name     string                           `json:"name"`
			Request  string                           `json:"request"`
			Expected VerifyPaymentRequestExpectations `json:"expected"`
			Expect   struct {
				Amount        string            `json:"amount"`
				Outcome       CommitmentOutcome `json:"outcome"`
				ErrorContains string            `json:"errorContains"`
			} `json:"expect"`
		} `json:"vectors"`
	}
	require.NoError(t, json.Unmarshal(raw, &doc))
	require.Len(t, doc.Vectors, 15)
	for _, v := range doc.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			res, err := VerifyPaymentRequestJSON([]byte(v.Request), v.Expected)
			if v.Expect.Amount != "" {
				require.NoError(t, err)
				require.Equal(t, v.Expect.Amount, res.Results[0].Amount)
				return
			}
			require.Error(t, err)
			r, ok := CommitmentResultOf(err)
			if v.Expect.Outcome != "" {
				require.True(t, ok, err.Error())
				require.Equal(t, v.Expect.Outcome, r.Outcome, r.Detail)
				return
			}
			require.False(t, ok)
			require.Contains(t, err.Error(), v.Expect.ErrorContains)
		})
	}
}
