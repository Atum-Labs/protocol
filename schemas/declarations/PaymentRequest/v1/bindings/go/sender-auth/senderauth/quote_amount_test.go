package senderauth

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

// quoteAmountFixture is one chain's signed permit and the expectations it verifies under, with the
// permit amount it authorizes.
type quoteAmountFixture struct {
	adapter  ChainAdapter
	signed   SignedMessageInput
	source   SourceRef
	commit   CommitmentExpectation
	expected Expectations
	amount   string
}

func quoteAmountFixtures(t *testing.T) map[string]quoteAmountFixture {
	t.Helper()
	evmSigned, evmSource, evmExpected := evmRoundTripFixture(t)
	tronDefaults, _ := tronTestDefaults()
	tronSigned, tronSource := buildTronSigned(t, nil)
	solSigned, solSource, solExpected, _ := solanaRoundTripFixture(t)
	return map[string]quoteAmountFixture{
		"eip155": {evmAdapter{}, evmSigned, evmSource, evmTestCommitment, evmExpected, "1000000"},
		"tron":   {tronAdapter{}, tronSigned, tronSource, tronTestCommitment, tronFullExpectations(tronDefaults), "10000000"},
		"solana": {solanaAdapter{}, solSigned, solSource, solanaTestCommitment, solExpected, "1000000"},
	}
}

// inQuoteMode binds the fixture's permit to quote instead of max_source_amount.
func (f quoteAmountFixture) inQuoteMode(quote string) Expectations {
	e := f.expected
	e.MaxSourceAmount = ""
	e.QuoteSourceAmount = quote
	return e
}

// The refusals (above, below, misconfigured) are shared vectors in sender-auth-vectors.json.
func TestQuoteSourceAmount_AdmitsAPermitForExactlyTheQuote(t *testing.T) {
	for namespace, f := range quoteAmountFixtures(t) {
		t.Run(namespace, func(t *testing.T) {
			r, err := f.adapter.RecoverAndVerify(f.signed, f.source, f.commit, f.inQuoteMode(f.amount))
			require.NoError(t, err)
			require.Equal(t, f.amount, r.Amount)
		})
	}
}

// A quote request's max_source_amount is a ceiling the payer may state; the permit pays the quote.
func TestQuoteSourceAmount_IgnoresTheRequestsMaxSourceAmount(t *testing.T) {
	d, _ := evmTestDefaults()
	req, _ := evmRequest(t, "5000000")
	raw, err := json.Marshal(req)
	require.NoError(t, err)

	exp := verifyExpectations(d)
	exp.QuoteSourceAmount = "1000000"
	res, err := VerifyPaymentRequestJSON(raw, exp)
	require.NoError(t, err)
	require.Equal(t, "1000000", res.Results[0].Amount)

	exp.QuoteSourceAmount = "999999"
	_, err = VerifyPaymentRequestJSON(raw, exp)
	require.ErrorIs(t, err, ErrPermitAmountMismatch)
}

func TestMaxSourceAmountMismatchIsTypedWithTheSameText(t *testing.T) {
	for namespace, f := range quoteAmountFixtures(t) {
		t.Run(namespace, func(t *testing.T) {
			e := f.expected
			e.MaxSourceAmount = "999"
			_, err := f.adapter.RecoverAndVerify(f.signed, f.source, f.commit, e)
			require.ErrorIs(t, err, ErrPermitAmountMismatch)
			require.EqualError(t, err, "sender_auth: permit amount does not match max_source_amount")
		})
	}
}
