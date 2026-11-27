package senderauth

import (
	"encoding/hex"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"
)

func evmTestDefaults() (ChainDefaults, string) {
	return ChainDefaults{
		EscrowContract:              "0x1111111111111111111111111111111111111111",
		QuoteSelector:               "0x2222222222222222222222222222222222222222",
		FulfillmentVerifierAccount:  "0x3333333333333333333333333333333333333333",
		FulfillmentVerifierEndpoint: "https://verifier.example",
		FulfillmentProxy:            "0x4444444444444444444444444444444444444444",
	}, "0x5555555555555555555555555555555555555555"
}

// evmFullExpectations is the opt-in-ON expectation set (amount + escrow + witness roles),
// as the conformance vectors and mppx supply.
func evmFullExpectations(d ChainDefaults) Expectations {
	return Expectations{
		MaxSourceAmount: "1000000",
		EscrowContract:  d.EscrowContract,
		Reserver:        d.QuoteSelector,
		Releaser:        d.FulfillmentVerifierAccount,
	}
}

// buildEvmSigned builds + signs a fresh EVM sender_auth message. deadline, when non-nil,
// overrides the default far-future test deadline (used to forge an expired permit); nil
// uses the fixed 2030 test deadline.
func buildEvmSigned(t *testing.T, deadline *big.Int) (SignedMessageInput, SourceRef) {
	t.Helper()
	d, token := evmTestDefaults()
	key, err := crypto.GenerateKey()
	require.NoError(t, err)
	account := crypto.PubkeyToAddress(key.PublicKey).Hex()
	priv := hex.EncodeToString(crypto.FromECDSA(key))

	if deadline == nil {
		deadline = big.NewInt(1924991999)
	}
	adapter := evmAdapter{}
	res, err := adapter.BuildAuthMessage(BuildParams{
		SourceAsset:        "eip155:1/erc20:" + token,
		MaxSourceAmount:    "1000000",
		SourceDefaults:     d,
		RequestID:          "req_test",
		DestinationAsset:   "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		DestinationAccount: "0xC0FFEE254729296a45a3885639AC7E10F9d54979",
		Nonce:              bigIntFromString(t, "123"),
		Deadline:           deadline,
	})
	require.NoError(t, err)
	require.Equal(t, SenderAuthMessageScheme("EVM_PERMIT2"), res.MessageScheme)

	prehash := res.MessagePrehash
	signed := SignedMessageInput{Message: res.MessageHash, MessagePrehash: &prehash}
	sig, err := adapter.Sign(signed, priv)
	require.NoError(t, err)
	signed.Signature = sig

	return signed, SourceRef{Network: "eip155:1", Asset: token, Account: account}
}

// evmRoundTripFixture returns a fully signed EVM message plus the opt-in-ON expectations.
// Shared with verify_test.go.
func evmRoundTripFixture(t *testing.T) (SignedMessageInput, SourceRef, Expectations) {
	t.Helper()
	d, _ := evmTestDefaults()
	signed, source := buildEvmSigned(t, nil)
	return signed, source, evmFullExpectations(d)
}

func TestEvmAdapterRoundTrip(t *testing.T) {
	signed, source, expected := evmRoundTripFixture(t)

	r, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, expected)
	require.NoError(t, err)
	require.Equal(t, "1000000", r.Amount)
	require.Equal(t, 1924991999, r.DeadlineSec)
	// The parsed permit is returned alongside the terms.
	require.Equal(t, SenderAuthMessageScheme("EVM_PERMIT2"), r.Permit.Scheme)
	require.Equal(t, expected.EscrowContract, r.Permit.Spender)
}

func TestEvmAdapterRejectsWrongSigner(t *testing.T) {
	signed, source, expected := evmRoundTripFixture(t)
	// Bind against a different account than the one that signed.
	source.Account = "0x9999999999999999999999999999999999999999"

	_, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, expected)
	requireCommitmentOutcome(t, err, OutcomeSignerMismatch)
	require.ErrorContains(t, err, "does not recover to the payment's source account")
}

func TestEvmAdapterRejectsWrongEscrow(t *testing.T) {
	signed, source, expected := evmRoundTripFixture(t)
	// Opt-in spender check: a different escrow must be rejected.
	expected.EscrowContract = "0x9999999999999999999999999999999999999999"

	_, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, expected)
	require.ErrorContains(t, err, "permit spender is not the source escrow")
}

func TestEvmAdapterRejectsWitnessMismatch(t *testing.T) {
	signed, source, expected := evmRoundTripFixture(t)
	// A verifier expecting a different reserver must reject the bound terms.
	expected.Reserver = "0x8888888888888888888888888888888888888888"

	_, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, expected)
	require.ErrorContains(t, err, "witness roles do not match")
}

func TestEvmAdapterRejectsWrongToken(t *testing.T) {
	signed, source, expected := evmRoundTripFixture(t)
	source.Asset = "0x8888888888888888888888888888888888888888"

	_, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, expected)
	require.ErrorContains(t, err, "permit token does not match")
}

func TestEvmAdapterRejectsWrongAmount(t *testing.T) {
	signed, source, expected := evmRoundTripFixture(t)
	expected.MaxSourceAmount = "999"

	_, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, expected)
	require.ErrorContains(t, err, "permit amount does not match max_source_amount")
}

func TestEvmAdapterRejectsExpired(t *testing.T) {
	d, _ := evmTestDefaults()
	// An absolute deadline in the past (Unix second 1) forges an expired permit.
	signed, source := buildEvmSigned(t, big.NewInt(1))

	_, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, evmFullExpectations(d))
	require.ErrorContains(t, err, "deadline is not in the future")
}

func TestEvmAdapterRejectsMalformedPrehash(t *testing.T) {
	d, token := evmTestDefaults()
	bad := "not json"
	signed := SignedMessageInput{Message: "0x00", MessagePrehash: &bad, Signature: "0x00"}
	source := SourceRef{Network: "eip155:1", Asset: token, Account: "0x9999999999999999999999999999999999999999"}

	_, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, evmFullExpectations(d))
	require.ErrorContains(t, err, "malformed message_prehash")
}

func TestEvmAdapterRejectsMissingPrehash(t *testing.T) {
	signed, source, expected := evmRoundTripFixture(t)
	signed.MessagePrehash = nil

	// A missing prehash is caught by the same uniform malformed-rejection as bad JSON.
	_, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, expected)
	require.ErrorContains(t, err, "malformed message_prehash")
}

func TestEvmAdapterOptInOff(t *testing.T) {
	d, _ := evmTestDefaults()
	signed, source := buildEvmSigned(t, nil)

	// Opt-in OFF: only the universal amount is supplied. The spender/witness checks are
	// skipped, so verification succeeds and the parsed permit still exposes the spender.
	r, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, Expectations{MaxSourceAmount: "1000000"})
	require.NoError(t, err)
	require.Equal(t, "1000000", r.Amount)
	require.Equal(t, d.EscrowContract, r.Permit.Spender)
}

// The Permit2 the escrow uses is the EIP-712 verifying contract, so build and verify must name the
// same one.
func TestEvmPermit2OverrideRoundTrip(t *testing.T) {
	d, token := evmTestDefaults()
	d.Permit2Contract = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	key, err := crypto.GenerateKey()
	require.NoError(t, err)
	adapter := evmAdapter{}
	res, err := adapter.BuildAuthMessage(BuildParams{
		SourceAsset: "eip155:1/erc20:" + token, MaxSourceAmount: "1000000", SourceDefaults: d, RequestID: "req_test",
		DestinationAsset:   evmTestCommitment.Destinations[0].AssetIdentifier,
		DestinationAccount: evmTestCommitment.Destinations[0].Account,
		Nonce:              big.NewInt(123), Deadline: big.NewInt(1924991999),
	})
	require.NoError(t, err)
	prehash := res.MessagePrehash
	signed := SignedMessageInput{Message: res.MessageHash, MessagePrehash: &prehash}
	signed.Signature, err = adapter.Sign(signed, hex.EncodeToString(crypto.FromECDSA(key)))
	require.NoError(t, err)
	source := SourceRef{Network: "eip155:1", Asset: token, Account: crypto.PubkeyToAddress(key.PublicKey).Hex()}
	expected := evmFullExpectations(d)

	expected.Permit2Contract = d.Permit2Contract
	_, err = adapter.RecoverAndVerify(signed, source, evmTestCommitment, expected)
	require.NoError(t, err)

	expected.Permit2Contract = ""
	_, err = adapter.RecoverAndVerify(signed, source, evmTestCommitment, expected)
	require.ErrorContains(t, err, "is not the EIP-712 hash of message_prehash")

	d.Permit2Contract = "0x12"
	_, err = adapter.BuildAuthMessage(BuildParams{
		SourceAsset: "eip155:1/erc20:" + token, MaxSourceAmount: "1000000", SourceDefaults: d, RequestID: "req_test",
		DestinationAsset: "eip155:1/erc20:" + token, DestinationAccount: token, Nonce: big.NewInt(1), Deadline: big.NewInt(1),
	})
	require.ErrorContains(t, err, "is not an address")
}

// A deadline no verifier reads exactly is refused at build, on EVM and Tron alike.
func TestBuildRefusesADeadlineOutsideTheSafeRange(t *testing.T) {
	d, token := evmTestDefaults()
	for _, deadline := range []*big.Int{new(big.Int).Lsh(big.NewInt(1), 53), big.NewInt(-1)} {
		_, err := evmAdapter{}.BuildAuthMessage(BuildParams{
			SourceAsset: "eip155:1/erc20:" + token, MaxSourceAmount: "1000000", SourceDefaults: d, RequestID: "req_test",
			DestinationAsset: evmTestCommitment.Destinations[0].AssetIdentifier, DestinationAccount: evmTestCommitment.Destinations[0].Account,
			Nonce: big.NewInt(1), Deadline: deadline,
		})
		require.ErrorContains(t, err, "is outside 0..9007199254740991")
		tronDefaults, tronToken := tronTestDefaults()
		_, err = tronAdapter{}.BuildAuthMessage(BuildParams{
			SourceAsset: "tron:mainnet/trc20:" + tronToken, MaxSourceAmount: "1", SourceDefaults: tronDefaults, RequestID: "req_test",
			DestinationAsset: tronTestCommitment.Destinations[0].AssetIdentifier, DestinationAccount: tronTestCommitment.Destinations[0].Account,
			Nonce: big.NewInt(1), Deadline: deadline,
		})
		require.ErrorContains(t, err, "is outside 0..9007199254740991")
	}
}

// A signature that is not 65 bytes of r, s and v recovers nothing.
func TestEvmRecoverAndVerifyRefusesAMalformedSignature(t *testing.T) {
	signed, source, expected := evmRoundTripFixture(t)
	signed.Signature = "0x12"
	_, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, expected)
	requireCommitmentOutcome(t, err, OutcomeSignerMismatch)
	require.ErrorContains(t, err, "does not recover to the payment's source account")
}
