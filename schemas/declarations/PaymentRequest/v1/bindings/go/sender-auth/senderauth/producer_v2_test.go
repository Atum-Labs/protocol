package senderauth

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Given the assembled request and no version, the builder signs what it signs from RequestID and
// the destination params: depositRequestHash v1 stays the default output.
func TestBuildAuthMessage_FromTheAssembledRequestSignsV1ByDefault(t *testing.T) {
	for _, c := range strictBuildCases(t) {
		legacy, err := c.adapter.BuildAuthMessage(c.params)
		require.NoError(t, err, c.name)

		params := c.params
		params.PaymentRequestJSON = c.unsigned(t)
		got, err := c.adapter.BuildAuthMessage(params)
		require.NoError(t, err, c.name)
		assert.Equal(t, legacy, got, c.name)
	}
}

// Asked for version 2, the builder commits the assembled request's depositRequestHash v2, which a
// verifier opted into v2 matches.
func TestBuildAuthMessage_Version2CommitsTheRequestsV2(t *testing.T) {
	for _, c := range strictBuildCases(t) {
		params := c.params
		params.PaymentRequestJSON = c.unsigned(t)
		params.DepositRequestHashVersion = 2
		res, err := c.adapter.BuildAuthMessage(params)
		require.NoError(t, err, c.name)

		got, err := VerifyRequestCommitment(c.signed(t, res), c.solana, WithDepositRequestHashV2(DepositRequestHashV2Enforce))
		require.NoError(t, err, c.name)
		assert.Equal(t, "v2", got.DepositRequestHashVersion, c.name)
	}
}

// Given the assembled request, the builder reads request_id and the destination from it, so the
// deprecated RequestID and destination params can be left out.
func TestBuildAuthMessage_ReadsTheCommitmentsFromTheAssembledRequest(t *testing.T) {
	for _, c := range strictBuildCases(t) {
		legacy, err := c.adapter.BuildAuthMessage(c.params)
		require.NoError(t, err, c.name)

		params := c.params
		params.PaymentRequestJSON = c.unsigned(t)
		params.RequestID, params.DestinationAsset, params.DestinationAccount = "", "", ""
		got, err := c.adapter.BuildAuthMessage(params)
		require.NoError(t, err, c.name)
		assert.Equal(t, legacy, got, c.name)
	}
}

// v2 is the hash of the assembled request, so version 2 without one is refused, and so is a
// version the builder does not know, rather than signing v1.
func TestBuildAuthMessage_RefusesAVersionItCannotCommit(t *testing.T) {
	for _, c := range strictBuildCases(t) {
		params := c.params
		params.DepositRequestHashVersion = 2
		_, err := c.adapter.BuildAuthMessage(params)
		assert.ErrorContains(t, err, "depositRequestHash version 2 needs the assembled payment request", c.name)

		for _, version := range []int{-1, 3} {
			params := c.params
			params.PaymentRequestJSON = c.unsigned(t)
			params.DepositRequestHashVersion = version
			_, err := c.adapter.BuildAuthMessage(params)
			assert.ErrorContains(t, err, "is not 1 or 2", c.name)
		}
	}
}

// A deprecated param set next to the assembled request must name the same request id and payee,
// or the builder would sign one request's commitments over another's body.
func TestBuildAuthMessage_RefusesDeprecatedParamsTheRequestContradicts(t *testing.T) {
	for _, c := range strictBuildCases(t) {
		params := c.params
		params.PaymentRequestJSON = c.unsigned(t)
		params.RequestID = "another_request"
		_, err := c.adapter.BuildAuthMessage(params)
		assert.ErrorContains(t, err, `the request id param "another_request" is not the request's request_id`, c.name)

		params = c.params
		params.PaymentRequestJSON = c.unsigned(t)
		params.DestinationAccount += "0"
		_, err = c.adapter.BuildAuthMessage(params)
		assert.ErrorContains(t, err, "is not the request's destination", c.name)
	}
}

// The assembled request is read strictly whatever version is signed: a body an enforcing reader
// refuses is refused here, before it is signed.
func TestBuildAuthMessage_RefusesARequestTheStrictReaderRefuses(t *testing.T) {
	for _, c := range strictBuildCases(t) {
		for _, version := range []int{0, 1, 2} {
			params := c.params
			params.PaymentRequestJSON = withMember(t, string(c.unsigned(t)), "unknown_member", 1)
			params.DepositRequestHashVersion = version
			_, err := c.adapter.BuildAuthMessage(params)
			requireCommitmentOutcome(t, err, OutcomeRequestMalformed)
		}
	}
}

// The params that still drive the permit must agree with the assembled request where it commits
// them, or the builder would sign a deposit whose v2 commits a token, cap or escrow its own permit
// does not use.
func TestBuildAuthMessage_RefusesPermitParamsTheRequestContradicts(t *testing.T) {
	cases := []struct {
		name string
		edit func(p *BuildParams)
		want string
	}{
		{"escrow", func(p *BuildParams) { p.SourceDefaults.EscrowContract = p.SourceDefaults.QuoteSelector },
			"is not the request's escrow_contract_address"},
		{"reserver", func(p *BuildParams) { p.SourceDefaults.QuoteSelector = p.SourceDefaults.EscrowContract },
			"is not the request's quote_selector"},
		{"releaser", func(p *BuildParams) { p.SourceDefaults.FulfillmentVerifierAccount = p.SourceDefaults.EscrowContract },
			"is not the request's fulfillment_verifier account"},
		{"source-asset", func(p *BuildParams) {
			p.SourceAsset = p.SourceAsset[:strings.LastIndex(p.SourceAsset, ":")+1] + p.SourceDefaults.EscrowContract
		}, "is not the request's source asset_identifier"},
		{"depositor", func(p *BuildParams) { p.Depositor = p.SourceDefaults.EscrowContract },
			"is not the request's source account"},
		{"max-source-amount", func(p *BuildParams) { p.MaxSourceAmount += "0" },
			"is not the request's max_source_amount"},
	}
	for _, c := range strictBuildCases(t) {
		for _, tc := range cases {
			params := c.params
			params.PaymentRequestJSON = c.unsigned(t)
			tc.edit(&params)
			_, err := c.adapter.BuildAuthMessage(params)
			assert.ErrorContains(t, err, tc.want, c.name+"/"+tc.name)
		}
	}
}

// Agreement is on the value, not the spelling: an amount with leading zeros names the amount the
// request commits.
func TestBuildAuthMessage_AcceptsPermitParamsSpelledDifferently(t *testing.T) {
	for _, c := range strictBuildCases(t) {
		params := c.params
		params.PaymentRequestJSON = c.unsigned(t)
		params.MaxSourceAmount = "0" + params.MaxSourceAmount
		_, err := c.adapter.BuildAuthMessage(params)
		assert.NoError(t, err, c.name)
	}
}
