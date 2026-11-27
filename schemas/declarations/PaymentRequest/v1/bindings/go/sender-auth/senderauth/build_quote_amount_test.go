package senderauth

import (
	"fmt"
	"math/big"
	"testing"

	"github.com/stretchr/testify/require"
)

// quoteBelow is a quote one unit under the cap, so a permit for the cap and one for the quote differ.
func quoteBelow(t *testing.T, limit string) string {
	t.Helper()
	n, ok := new(big.Int).SetString(limit, 10)
	require.True(t, ok, limit)
	return n.Sub(n, big.NewInt(1)).String()
}

// A deposit that pays a chosen quote authorizes the quote's amount, not the request's cap, and the
// verifier binding the quote admits it while one binding the cap refuses it.
func TestBuildQuoteSourceAmount_SignsExactlyTheQuote(t *testing.T) {
	for _, c := range strictBuildCases(t) {
		for _, version := range []int{1, 2} {
			t.Run(fmt.Sprintf("%s/v%d", c.name, version), func(t *testing.T) {
				params := c.params
				quote := quoteBelow(t, params.MaxSourceAmount)
				params.PaymentRequestJSON, params.DepositRequestHashVersion = c.unsigned(t), version
				params.MaxSourceAmount, params.QuoteSourceAmount = "", quote
				res, err := c.adapter.BuildAuthMessage(params)
				require.NoError(t, err)
				signed := c.signed(t, res)

				exp := c.expectations
				exp.MaxSourceAmount, exp.QuoteSourceAmount = "", quote
				exp.DepositRequestHashV2Mode = DepositRequestHashV2Enforce
				got, err := VerifyPaymentRequestJSON(signed, exp)
				require.NoError(t, err)
				require.Equal(t, quote, got.Results[0].Amount)

				capped := c.expectations
				capped.DepositRequestHashV2Mode = DepositRequestHashV2Enforce
				_, err = VerifyPaymentRequestJSON(signed, capped)
				require.ErrorIs(t, err, ErrPermitAmountMismatch)
			})
		}
	}
}

func TestBuildQuoteSourceAmount_RefusesAQuoteAboveTheCap(t *testing.T) {
	for _, c := range strictBuildCases(t) {
		t.Run(c.name, func(t *testing.T) {
			params := c.params
			params.PaymentRequestJSON = c.unsigned(t)
			params.MaxSourceAmount, params.QuoteSourceAmount = "", params.MaxSourceAmount+"0"
			_, err := c.adapter.BuildAuthMessage(params)
			require.ErrorContains(t, err, "is above the request's max_source_amount")
		})
	}
}

func TestBuildQuoteSourceAmount_RefusesTheQuoteWithTheCap(t *testing.T) {
	for _, c := range strictBuildCases(t) {
		t.Run(c.name, func(t *testing.T) {
			params := c.params
			params.QuoteSourceAmount = quoteBelow(t, params.MaxSourceAmount)
			_, err := c.adapter.BuildAuthMessage(params)
			require.EqualError(t, err, "sender_auth: set maxSourceAmount or quoteSourceAmount, not both")
		})
	}
}

func TestBuildQuoteSourceAmount_RefusesAMalformedQuote(t *testing.T) {
	for _, c := range strictBuildCases(t) {
		for _, quote := range []string{"0", "01", "-1", "1e6", " 1"} {
			t.Run(c.name+"/"+quote, func(t *testing.T) {
				params := c.params
				params.MaxSourceAmount, params.QuoteSourceAmount = "", quote
				_, err := c.adapter.BuildAuthMessage(params)
				require.ErrorContains(t, err, "is not a decimal integer above zero")
			})
		}
	}
}
