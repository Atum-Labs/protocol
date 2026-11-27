package senderauth

import (
	"errors"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/stretchr/testify/require"
)

// The commitments each chain's test fixture signs (buildEvmSigned, buildTronSigned,
// solanaRoundTripFixture).
var (
	evmTestCommitment = CommitmentExpectation{
		Destinations: []DestinationLeg{{AssetIdentifier: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", Account: "0xC0FFEE254729296a45a3885639AC7E10F9d54979"}},
		RequestID:    "req_test",
	}
	tronTestCommitment = CommitmentExpectation{
		Destinations: []DestinationLeg{{AssetIdentifier: "tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", Account: "TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB"}},
		RequestID:    "req_test",
	}
	solanaTestCommitment = CommitmentExpectation{
		Destinations: []DestinationLeg{{AssetIdentifier: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo", Account: "7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4"}},
		RequestID:    "req-round-trip-1",
	}
)

func requireCommitmentOutcome(t *testing.T, err error, want CommitmentOutcome) {
	t.Helper()
	var ce *CommitmentError
	require.True(t, errors.As(err, &ce), "want a *CommitmentError, got %v", err)
	require.Equal(t, want, ce.Result.Outcome, ce.Result.Detail)
}

// RecoverAndVerify requires the signed deposit to commit to the payment's own destination and
// request id, on every chain, after every other check.
func TestRecoverAndVerifyRequiresTheCommitment(t *testing.T) {
	d, _ := evmTestDefaults()
	evmSigned, evmSource := buildEvmSigned(t, nil)
	td, _ := tronTestDefaults()
	tronSigned, tronSource := buildTronSigned(t, nil)
	solSigned, solSource, solExpected, _ := solanaRoundTripFixture(t)
	stSigned, stSource, stExpected, _ := stellarFixture(t)

	cases := map[string]struct {
		verify   func(CommitmentExpectation) (VerifiedSenderAuth, error)
		honest   CommitmentExpectation
		otherLeg DestinationLeg
	}{
		"eip155": {func(c CommitmentExpectation) (VerifiedSenderAuth, error) {
			return chainAdapters["eip155"].RecoverAndVerify(evmSigned, evmSource, c, evmFullExpectations(d))
		}, evmTestCommitment, DestinationLeg{AssetIdentifier: evmTestCommitment.Destinations[0].AssetIdentifier, Account: "0x1111111111111111111111111111111111111111"}},
		"tron": {func(c CommitmentExpectation) (VerifiedSenderAuth, error) {
			return chainAdapters["tron"].RecoverAndVerify(tronSigned, tronSource, c, tronFullExpectations(td))
		}, tronTestCommitment, DestinationLeg{AssetIdentifier: tronTestCommitment.Destinations[0].AssetIdentifier, Account: "TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m"}},
		"solana": {func(c CommitmentExpectation) (VerifiedSenderAuth, error) {
			return chainAdapters["solana"].RecoverAndVerify(solSigned, solSource, c, solExpected)
		}, solanaTestCommitment, DestinationLeg{AssetIdentifier: solanaTestCommitment.Destinations[0].AssetIdentifier, Account: "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR"}},
		"stellar": {func(c CommitmentExpectation) (VerifiedSenderAuth, error) {
			return chainAdapters["stellar"].RecoverAndVerify(stSigned, stSource, c, stExpected)
		}, stellarTestCommitment, DestinationLeg{AssetIdentifier: stellarTestCommitment.Destinations[0].AssetIdentifier, Account: "0x1111111111111111111111111111111111111111"}},
	}
	// Every registered adapter must have a case here, so an adapter that ignored the commitment
	// could not pass unnoticed.
	for namespace := range chainAdapters {
		require.Contains(t, cases, namespace, "no commitment fixture for the %s adapter", namespace)
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			r, err := c.verify(c.honest)
			require.NoError(t, err)
			require.Equal(t, OutcomeVerified, r.Commitment.Outcome, "the admission carries its commitment result")
			require.Equal(t, name, r.Commitment.Namespace)
			want, err := BuildEscrowDestination(c.honest.Destinations[0].AssetIdentifier, c.honest.Destinations[0].Account)
			require.NoError(t, err)
			require.Equal(t, want, r.Permit.Destination, "the signed destination is reported as signed")
			wantHash, err := DeriveDepositRequestHash(c.honest.RequestID)
			require.NoError(t, err)
			require.Equal(t, common.BytesToHash(wantHash[:]).Hex(), "0x"+strings.TrimPrefix(strings.ToLower(r.Permit.DepositRequestHash), "0x"))

			_, err = c.verify(CommitmentExpectation{Destinations: []DestinationLeg{c.otherLeg}, RequestID: c.honest.RequestID})
			requireCommitmentOutcome(t, err, OutcomeDestinationMismatch)

			_, err = c.verify(CommitmentExpectation{Destinations: c.honest.Destinations, RequestID: "req_other"})
			requireCommitmentOutcome(t, err, OutcomeRequestHashMismatch)

			_, err = c.verify(CommitmentExpectation{})
			requireCommitmentOutcome(t, err, OutcomeDestinationMismatch)
		})
	}
}

// A two-member witness commits no destination, so it is refused as commitment_absent.
func TestRecoverAndVerifyRefusesAWitnessWithNoCommitment(t *testing.T) {
	d, _ := evmTestDefaults()
	signed, source := buildEvmSigned(t, nil)
	prehash := strings.Replace(*signed.MessagePrehash, `"destination":`, `"retired":`, 1)
	signed.MessagePrehash = &prehash
	_, err := evmAdapter{}.RecoverAndVerify(signed, source, evmTestCommitment, evmFullExpectations(d))
	requireCommitmentOutcome(t, err, OutcomeCommitmentAbsent)
}

// The commitment is checked last, so a payment failing an earlier check keeps that check's reason.
func TestRecoverAndVerifyChecksTheCommitmentLast(t *testing.T) {
	d, _ := evmTestDefaults()
	signed, source := buildEvmSigned(t, nil)
	exp := evmFullExpectations(d)
	exp.MaxSourceAmount = "1"
	_, err := evmAdapter{}.RecoverAndVerify(signed, source, CommitmentExpectation{}, exp)
	require.ErrorContains(t, err, "permit amount does not match")
}

// An unusable prehash is reported both as ErrMalformedPrehash and with its commitment outcome, the
// same outcome VerifyCommitment gives it.
func TestRecoverAndVerifyReportsCommitmentOutcomes(t *testing.T) {
	d, _ := evmTestDefaults()
	signed, source := buildEvmSigned(t, nil)

	noPrehash := signed
	noPrehash.MessagePrehash = nil
	_, err := evmAdapter{}.RecoverAndVerify(noPrehash, source, evmTestCommitment, evmFullExpectations(d))
	require.ErrorIs(t, err, ErrMalformedPrehash)
	result, ok := CommitmentResultOf(err)
	require.True(t, ok)
	require.Equal(t, OutcomeCommitmentAbsent, result.Outcome)
	require.Equal(t, detailNoPrehash, result.Detail)

	notJSON := "{"
	unreadable := signed
	unreadable.MessagePrehash = &notJSON
	_, err = evmAdapter{}.RecoverAndVerify(unreadable, source, evmTestCommitment, evmFullExpectations(d))
	require.ErrorIs(t, err, ErrMalformedPrehash)
	requireCommitmentOutcome(t, err, OutcomePrehashMismatch)

	solSigned, solSource, solExpected, _ := solanaRoundTripFixture(t)
	low := 3
	solExpected.SvmSignatureDomainVersion = &low
	_, err = solanaAdapter{}.RecoverAndVerify(solSigned, solSource, solanaTestCommitment, solExpected)
	require.NotErrorIs(t, err, ErrMalformedPrehash)
	requireCommitmentOutcome(t, err, OutcomeCommitmentAbsent)
}
