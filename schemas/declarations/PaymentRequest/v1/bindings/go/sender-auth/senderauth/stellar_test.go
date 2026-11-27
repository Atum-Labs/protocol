package senderauth

import (
	"bytes"
	"encoding/hex"
	"errors"
	"math"
	"math/big"
	"strings"
	"testing"

	stellar "github.com/atum-labs/protocol/contracts/stellar/bindings/go/escrow-encoding/encoding"
	"github.com/stretchr/testify/require"
)

func stellarAccount(fill byte) string {
	return stellar.NewAccountAddress([32]byte(bytes.Repeat([]byte{fill}, 32))).String()
}

func stellarContract(fill byte) string {
	return stellar.NewContractAddress([32]byte(bytes.Repeat([]byte{fill}, 32))).String()
}

// The commitment the Stellar fixture signs: a cross-chain payee, as the other fixtures use.
var stellarTestCommitment = CommitmentExpectation{
	Destinations: []DestinationLeg{{AssetIdentifier: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", Account: "0xC0FFEE254729296a45a3885639AC7E10F9d54979"}},
	RequestID:    "req_binding_stellar",
}

// stellarFixture builds and signs a Stellar deposit whose depositor is its own delegate signer (the
// only shape an offline verifier admits), with the key the fixed pattern 0x77 x 32 and every build
// input pinned, so it is byte-deterministic. It returns the signed message, the payment's source, and
// the verifier expectations.
func stellarFixture(t *testing.T) (SignedMessageInput, SourceRef, Expectations, string) {
	t.Helper()
	return stellarFixtureFor(t, "")
}

// stellarFixtureFor is stellarFixture for a given depositor; "" is the delegate signer's own account.
func stellarFixtureFor(t *testing.T, depositor string) (SignedMessageInput, SourceRef, Expectations, string) {
	t.Helper()
	priv := hex.EncodeToString(bytes.Repeat([]byte{0x77}, 32))
	adapter := stellarAdapter{}
	delegateSigner, err := adapter.DeriveDelegateSigner(priv)
	require.NoError(t, err)
	if depositor == "" {
		depositor = delegateSigner
	}

	defaults := ChainDefaults{
		EscrowContract:              stellarContract(0xc0),
		QuoteSelector:               stellarAccount(0x55),
		FulfillmentVerifierAccount:  stellarAccount(0x66),
		FulfillmentVerifierEndpoint: "https://verifier.example",
		FulfillmentProxy:            stellarContract(0xf1),
	}
	token := stellarContract(0xe1)
	issuedAt := uint64(1700000000)
	epoch := uint64(1)
	res, err := adapter.BuildAuthMessage(BuildParams{
		SourceAsset:        "stellar:testnet/sep41:" + token,
		Depositor:          depositor,
		MaxSourceAmount:    "1000000",
		RequestID:          stellarTestCommitment.RequestID,
		SourceDefaults:     defaults,
		DestinationAsset:   stellarTestCommitment.Destinations[0].AssetIdentifier,
		DestinationAccount: stellarTestCommitment.Destinations[0].Account,
		Nonce:              big.NewInt(5),
		IssuedAt:           &issuedAt,
		DelegateEpoch:      &epoch,
		Deadline:           big.NewInt(1700000128),
	})
	require.NoError(t, err)
	require.Equal(t, SenderAuthMessageScheme("STELLAR"), res.MessageScheme)

	prehash := res.MessagePrehash
	signed := SignedMessageInput{
		Message:        res.MessageHash,
		MessagePrehash: &prehash,
		Payload:        map[string]interface{}{"delegate_signer": delegateSigner},
	}
	sig, err := adapter.Sign(signed, priv)
	require.NoError(t, err)
	signed.Signature = sig

	expected := Expectations{
		MaxSourceAmount: "1000000",
		EscrowContract:  defaults.EscrowContract,
		Reserver:        defaults.QuoteSelector,
		Releaser:        defaults.FulfillmentVerifierAccount,
	}
	return signed, SourceRef{Network: "stellar:testnet", Asset: token, Account: depositor}, expected, delegateSigner
}

func TestStellarRoundTrip(t *testing.T) {
	signed, source, expected, delegateSigner := stellarFixture(t)
	adapter, err := GetChainAdapter("stellar:testnet")
	require.NoError(t, err)

	got, err := adapter.RecoverSigner(signed, source)
	require.NoError(t, err)
	require.Equal(t, source.Account, got, "the signer is the depositor's own key as its delegate")
	require.Equal(t, delegateSigner, got)

	r, err := adapter.RecoverAndVerify(signed, source, stellarTestCommitment, expected)
	require.NoError(t, err)
	require.Equal(t, "1000000", r.Amount)
	require.Equal(t, 1700000128, r.DeadlineSec)
	require.Equal(t, SenderAuthMessageScheme("STELLAR"), r.Permit.Scheme)
	require.Equal(t, source.Account, r.Permit.Depositor)
	require.Equal(t, source.Asset, r.Permit.Token)
	// Even a self-delegated payer's registration is on-chain state this check does not read.
	require.Equal(t, delegateSigner, r.Permit.DelegateSigner)
	require.True(t, r.Permit.DelegateOnchainUnverified)

	// Fail closed on the roles, unlike EVM and Solana.
	for _, drop := range []func(*Expectations){func(e *Expectations) { e.Reserver = "" }, func(e *Expectations) { e.Releaser = "" }} {
		unpinned := expected
		drop(&unpinned)
		_, err = adapter.RecoverAndVerify(signed, source, stellarTestCommitment, unpinned)
		stellarRefusal(t, err, OutcomeVerifierMisconfigured, "expected reserver and releaser")
	}
}

// A delegate signer that is not the depositor is the shape an offline check cannot admit: the
// requester names the key, so a pass would prove only that some key signed. Both entry points
// refuse it with ErrDelegateUnverified, after every other check has held, and never as a bad
// signature.
func TestStellarSeparateDelegateIsUnverified(t *testing.T) {
	signed, source, expected, delegateSigner := stellarFixtureFor(t, stellarAccount(0xd1))
	require.NotEqual(t, source.Account, delegateSigner)
	adapter := stellarAdapter{}

	got, err := adapter.RecoverSigner(signed, source)
	require.ErrorIs(t, err, ErrDelegateUnverified)
	require.NotErrorIs(t, err, ErrSignerMismatch)
	require.NotErrorIs(t, err, ErrRecoveryFailed)
	require.Empty(t, got, "no signer is returned for a delegate that is not the account")

	_, err = adapter.RecoverAndVerify(signed, source, stellarTestCommitment, expected)
	require.ErrorIs(t, err, ErrDelegateUnverified)
	require.NotErrorIs(t, err, ErrSignerMismatch)

	// It is not a commitment refusal: the payee commitment held.
	var ce *CommitmentError
	require.False(t, errors.As(err, &ce))

	// A bad signature is still a bad signature, not an unverified delegate.
	bad := signed
	bad.Signature = "0x" + strings.Repeat("00", 64)
	_, err = adapter.RecoverSigner(bad, source)
	require.ErrorIs(t, err, ErrSignerMismatch)
	require.NotErrorIs(t, err, ErrDelegateUnverified)
}

func stellarRefusal(t *testing.T, err error, outcome CommitmentOutcome, detail string) {
	t.Helper()
	var ce *CommitmentError
	require.True(t, errors.As(err, &ce), "want a *CommitmentError, got %v", err)
	require.Equal(t, outcome, ce.Result.Outcome, ce.Result.Detail)
	require.Contains(t, ce.Result.Detail, detail)
}

func TestStellarBuildRefusals(t *testing.T) {
	base := func() BuildParams {
		issuedAt := uint64(1700000000)
		epoch := uint64(1)
		return BuildParams{
			SourceAsset:        "stellar:testnet/sep41:" + stellarContract(0xe1),
			Depositor:          stellarAccount(0xd1),
			MaxSourceAmount:    "1000000",
			RequestID:          stellarTestCommitment.RequestID,
			DestinationAsset:   stellarTestCommitment.Destinations[0].AssetIdentifier,
			DestinationAccount: stellarTestCommitment.Destinations[0].Account,
			SourceDefaults: ChainDefaults{
				EscrowContract:             stellarContract(0xc0),
				QuoteSelector:              stellarAccount(0x55),
				FulfillmentVerifierAccount: stellarAccount(0x66),
			},
			Nonce:         big.NewInt(1),
			IssuedAt:      &issuedAt,
			DelegateEpoch: &epoch,
			Deadline:      big.NewInt(1700000128),
		}
	}
	_, err := stellarAdapter{}.BuildAuthMessage(base())
	require.NoError(t, err)

	// Every other refusal of the builder has a shared vector (stellar-sender-auth-vectors.json), run by
	// the conformance test. The shared vectors carry the epoch as text, which ParseStellarEpoch refuses
	// first, so an explicit zero reaches BuildAuthMessage only here.
	p := base()
	zero := uint64(0)
	p.DelegateEpoch = &zero
	_, err = stellarAdapter{}.BuildAuthMessage(p)
	require.ErrorContains(t, err, "needs delegateEpoch")
}

func TestStellarSecretKeyIsHexSeedOnly(t *testing.T) {
	for _, bad := range []string{"", "00", strings.Repeat("zz", 32), strings.Repeat("00", 31), "S" + strings.Repeat("A", 55)} {
		_, err := stellarAdapter{}.DeriveDelegateSigner(bad)
		require.Error(t, err)
		if bad != "" {
			require.NotContains(t, err.Error(), bad, "never echoes the value")
		}
	}
	a, err := stellarAdapter{}.DeriveDelegateSigner(strings.Repeat("11", 32))
	require.NoError(t, err)
	b, err := stellarAdapter{}.DeriveDelegateSigner("0x" + strings.Repeat("11", 32))
	require.NoError(t, err)
	require.Equal(t, a, b)
	require.True(t, strings.HasPrefix(a, "G"))
}

func TestDeterministicStellarNonce(t *testing.T) {
	a, err := DeterministicStellarNonce("req-1", stellarAccount(0xd1))
	require.NoError(t, err)
	b, err := DeterministicStellarNonce("req-1", stellarAccount(0xd1))
	require.NoError(t, err)
	c, err := DeterministicStellarNonce("req-2", stellarAccount(0xd1))
	require.NoError(t, err)
	require.Equal(t, a, b)
	require.NotEqual(t, a, c)
	// Pinned in both languages: a drift between the two derivations fails here and in the TypeScript test.
	require.Equal(t, uint64(288014144211253225), a)
	_, err = DeterministicStellarNonce("", stellarAccount(0xd1))
	require.Error(t, err)
}

// The default deadline is issued_at + 3600. An issued_at within 3600 of 2^64-1 would wrap that sum to a
// small deadline; the builder refuses it with ErrStellarIssuedAtOverflow rather than leaving the wrapped
// value to the later deadline-after-issued_at check. The largest issued_at whose default deadline fits
// is still built, and a caller that supplies its own deadline never reaches the addition.
func TestStellarDefaultDeadlineRefusesOverflowingIssuedAt(t *testing.T) {
	build := func(issuedAt uint64, deadline *big.Int) (AuthMessageResult, error) {
		epoch := uint64(1)
		return stellarAdapter{}.BuildAuthMessage(BuildParams{
			SourceAsset:        "stellar:testnet/sep41:" + stellarContract(0xe1),
			Depositor:          stellarAccount(0xd1),
			MaxSourceAmount:    "1000000",
			RequestID:          stellarTestCommitment.RequestID,
			DestinationAsset:   stellarTestCommitment.Destinations[0].AssetIdentifier,
			DestinationAccount: stellarTestCommitment.Destinations[0].Account,
			SourceDefaults: ChainDefaults{
				EscrowContract:             stellarContract(0xc0),
				QuoteSelector:              stellarAccount(0x55),
				FulfillmentVerifierAccount: stellarAccount(0x66),
			},
			Nonce:         big.NewInt(1),
			IssuedAt:      &issuedAt,
			DelegateEpoch: &epoch,
			Deadline:      deadline,
		})
	}

	// 2^64-1, 2^64-3600+1 (the sum wraps to 1) and 2^64-3600 (the sum wraps to 0).
	for _, issuedAt := range []uint64{math.MaxUint64, math.MaxUint64 - stellarDefaultValiditySecs + 2, math.MaxUint64 - stellarDefaultValiditySecs + 1} {
		_, err := build(issuedAt, nil)
		require.ErrorIs(t, err, ErrStellarIssuedAtOverflow, "issued_at %d", issuedAt)
	}

	// 2^64-1-3600: the default deadline is exactly 2^64-1, which fits.
	res, err := build(math.MaxUint64-stellarDefaultValiditySecs, nil)
	require.NoError(t, err)
	require.Contains(t, res.MessagePrehash, `"deadline":"18446744073709551615"`)

	// An explicit deadline does not use the default, so a large issued_at is not refused here.
	_, err = build(math.MaxUint64-100, new(big.Int).SetUint64(math.MaxUint64-50))
	require.NoError(t, err)
}
