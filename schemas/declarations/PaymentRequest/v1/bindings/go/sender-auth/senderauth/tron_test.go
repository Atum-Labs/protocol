package senderauth

import (
	"encoding/hex"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/stretchr/testify/require"
)

func tronTestDefaults() (ChainDefaults, string) {
	return ChainDefaults{
		EscrowContract:              "TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp",
		QuoteSelector:               "TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m",
		FulfillmentVerifierAccount:  "TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S",
		FulfillmentVerifierEndpoint: "https://verifier.example.com",
		FulfillmentProxy:            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
	}, "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
}

func tronFullExpectations(d ChainDefaults) Expectations {
	return Expectations{
		MaxSourceAmount: "10000000",
		EscrowContract:  d.EscrowContract,
		Reserver:        d.QuoteSelector,
		Releaser:        d.FulfillmentVerifierAccount,
	}
}

// buildTronSigned builds + signs a fresh Tron TIP-712 sender_auth message. The source
// account is the canonical 41-prefixed hex form of the signer's address so
// NormalizeAddress round-trips deterministically. deadline, when non-nil, forges an
// expired permit; nil uses the fixed 2030 test deadline.
func buildTronSigned(t *testing.T, deadline *big.Int) (SignedMessageInput, SourceRef) {
	t.Helper()
	d, token := tronTestDefaults()
	key, err := crypto.GenerateKey()
	require.NoError(t, err)
	addr := crypto.PubkeyToAddress(key.PublicKey)
	priv := hex.EncodeToString(crypto.FromECDSA(key))
	account := "41" + hex.EncodeToString(addr.Bytes())

	if deadline == nil {
		deadline = big.NewInt(1924991999)
	}
	adapter := tronAdapter{}
	res, err := adapter.BuildAuthMessage(BuildParams{
		SourceAsset:        "tron:mainnet/trc20:" + token,
		MaxSourceAmount:    "10000000",
		SourceDefaults:     d,
		RequestID:          "req_test",
		DestinationAsset:   "tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
		DestinationAccount: "TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB",
		Nonce:              bigIntFromString(t, "456"),
		Deadline:           deadline,
	})
	require.NoError(t, err)
	require.Equal(t, SenderAuthMessageScheme("EVM_PERMIT2"), res.MessageScheme, "Tron reuses the Permit2 wire scheme")

	prehash := res.MessagePrehash
	signed := SignedMessageInput{Message: res.MessageHash, MessagePrehash: &prehash}
	sig, err := adapter.Sign(signed, priv)
	require.NoError(t, err)
	signed.Signature = sig

	return signed, SourceRef{Network: "tron:mainnet", Asset: token, Account: account}
}

func TestTronAdapterRoundTrip(t *testing.T) {
	d, _ := tronTestDefaults()
	signed, source := buildTronSigned(t, nil)

	r, err := tronAdapter{}.RecoverAndVerify(signed, source, tronTestCommitment, tronFullExpectations(d))
	require.NoError(t, err)
	require.Equal(t, "10000000", r.Amount)
	require.Equal(t, 1924991999, r.DeadlineSec)
	require.Equal(t, SenderAuthMessageScheme("EVM_PERMIT2"), r.Permit.Scheme)
}

func TestTronAdapterRejectsWrongSigner(t *testing.T) {
	d, _ := tronTestDefaults()
	signed, source := buildTronSigned(t, nil)
	// A different Tron account than the signer must be rejected.
	source.Account = "TBvJUBXorwBPzqvV38vjDgegj5Eh6g2Tsq"

	_, err := tronAdapter{}.RecoverAndVerify(signed, source, tronTestCommitment, tronFullExpectations(d))
	requireCommitmentOutcome(t, err, OutcomeSignerMismatch)
	require.ErrorContains(t, err, "does not recover to the payment's source account")
}

func TestTronAdapterRejectsWrongEscrow(t *testing.T) {
	d, _ := tronTestDefaults()
	signed, source := buildTronSigned(t, nil)
	expected := tronFullExpectations(d)
	// Opt-in spender check (Tron): a different escrow must be rejected.
	expected.EscrowContract = "TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S"

	_, err := tronAdapter{}.RecoverAndVerify(signed, source, tronTestCommitment, expected)
	require.ErrorContains(t, err, "permit spender is not the source escrow")
}

func TestTronAdapterRejectsWitnessMismatch(t *testing.T) {
	d, _ := tronTestDefaults()
	signed, source := buildTronSigned(t, nil)
	expected := tronFullExpectations(d)
	expected.Reserver = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"

	_, err := tronAdapter{}.RecoverAndVerify(signed, source, tronTestCommitment, expected)
	require.ErrorContains(t, err, "witness roles do not match")
}

func TestTronAdapterRejectsWrongAmount(t *testing.T) {
	d, _ := tronTestDefaults()
	signed, source := buildTronSigned(t, nil)
	expected := tronFullExpectations(d)
	expected.MaxSourceAmount = "999"

	_, err := tronAdapter{}.RecoverAndVerify(signed, source, tronTestCommitment, expected)
	require.ErrorContains(t, err, "permit amount does not match max_source_amount")
}

func TestTronAdapterRejectsExpired(t *testing.T) {
	d, _ := tronTestDefaults()
	// An absolute deadline in the past (Unix second 1) forges an expired permit.
	signed, source := buildTronSigned(t, big.NewInt(1))

	_, err := tronAdapter{}.RecoverAndVerify(signed, source, tronTestCommitment, tronFullExpectations(d))
	require.ErrorContains(t, err, "deadline is not in the future")
}
