package senderauth

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// A quote whose embedded request is the stored request binds, and the terms are the stored ones.
func TestVerifyQuoteRequestBinding_BindsTheStoredRequest(t *testing.T) {
	for _, g := range loadDepositRequestV2Vectors(t).Golden {
		stored := []byte(g.Request)
		want, err := ReadDepositRequest(stored)
		require.NoError(t, err, g.Name)

		got, err := VerifyQuoteRequestBinding(quoteFor(t, g.Request), stored)
		require.NoError(t, err, g.Name)
		assert.Equal(t, want, got, g.Name)
	}
}

// A quote that embeds an edited copy of the stored request does not bind: the terms the settler
// quoted are not the terms the payer will sign.
func TestVerifyQuoteRequestBinding_RefusesAnEditedCopy(t *testing.T) {
	stored := loadDepositRequestV2Vectors(t).Golden[0].Request
	for _, edit := range quoteRequestEdits {
		t.Run(edit.name, func(t *testing.T) {
			edited := withMember(t, stored, edit.member, edit.value)
			_, err := VerifyQuoteRequestBinding(quoteFor(t, string(edited)), []byte(stored))
			requireCommitmentOutcome(t, err, OutcomeQuoteRequestMismatch)
		})
	}
}

// A quote carrying payment_request_json twice under spellings that differ in letter case is
// refused: a case-insensitive reader downstream could act on the other copy.
func TestVerifyQuoteRequestBinding_RefusesAnAmbiguousQuote(t *testing.T) {
	stored := loadDepositRequestV2Vectors(t).Golden[0].Request
	_, err := VerifyQuoteRequestBinding(caseTwinQuote(t, stored), []byte(stored))
	requireCommitmentOutcome(t, err, OutcomeRequestMalformed)
}

// payment-gw stores the request in a JSONB column, which reorders members and drops whitespace. The
// stored copy still binds a quote that embeds the request as the payer sent it.
func TestVerifyQuoteRequestBinding_BindsAJSONBStoredRequest(t *testing.T) {
	v := loadDepositRequestV2Vectors(t)
	golden := map[string]string{}
	for _, g := range v.Golden {
		golden[g.Name] = g.Request
	}
	bound := 0
	for _, r := range v.Reencoded {
		if r.Path != "postgres-jsonb" {
			continue
		}
		want, err := ReadDepositRequest([]byte(r.Request))
		require.NoError(t, err, r.Golden)
		got, err := VerifyQuoteRequestBinding(quoteFor(t, golden[r.Golden]), []byte(r.Request))
		require.NoError(t, err, r.Golden)
		assert.Equal(t, want, got, r.Golden)
		bound++
	}
	require.NotZero(t, bound, "no postgres-jsonb rows in the shared vectors")
}

// A quote that does not carry the request as a string is refused, and the refusal says where.
func TestVerifyQuoteRequestBinding_RefusesAQuoteWithoutAnEmbeddedRequest(t *testing.T) {
	stored := []byte(loadDepositRequestV2Vectors(t).Golden[0].Request)
	for _, c := range quotesWithoutAnEmbeddedRequest {
		t.Run(c.name, func(t *testing.T) {
			got, err := VerifyQuoteRequestBinding([]byte(c.quote), stored)
			requireCommitmentOutcome(t, err, OutcomeRequestMalformed)
			r, _ := CommitmentResultOf(err)
			assert.Equal(t, c.detail, r.Detail)
			assert.Equal(t, DepositRequest{}, got)
		})
	}
}

// A copy the strict reader refuses is refused, and the refusal names the copy.
func TestVerifyQuoteRequestBinding_NamesTheCopyTheStrictReaderRefuses(t *testing.T) {
	v := loadDepositRequestV2Vectors(t)
	honest, refused := v.Golden[0].Request, v.Refused[0]

	_, err := VerifyQuoteRequestBinding(quoteFor(t, refused.Request), []byte(honest))
	requireCommitmentOutcome(t, err, OutcomeRequestMalformed)
	r, _ := CommitmentResultOf(err)
	assert.Equal(t, "the quote's payment_request_json: "+refused.Detail, r.Detail)

	_, err = VerifyQuoteRequestBinding(quoteFor(t, honest), []byte(refused.Request))
	requireCommitmentOutcome(t, err, OutcomeRequestMalformed)
	r, _ = CommitmentResultOf(err)
	assert.Equal(t, "the stored payment request: "+refused.Detail, r.Detail)
}

// quoteRequestEdits are the edits to a stored request that a quote embedding the edited copy must
// not bind.
var quoteRequestEdits = []struct {
	name   string
	member string
	value  any
}{
	{"amount", "fulfillment_amount", "1000001"},
	{"deadline", "fulfillment_deadline", "2026-10-07T13:30:00.000Z"},
	{"executor", "executor", "originator"},
	{"destination", "destination", []any{map[string]any{
		"asset_identifier": "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		"account":          "0x1111111111111111111111111111111111111111",
	}}},
}

// quotesWithoutAnEmbeddedRequest are quotes that do not carry the request as a string, with the
// refusal detail each gets.
var quotesWithoutAnEmbeddedRequest = []struct{ name, quote, detail string }{
	{"refuses a quote without payment_request_json", `{"version":"1.0"}`, "the quote has no payment_request_json string"},
	{"refuses a null payment_request_json", `{"payment_request_json":null}`, "the quote has no payment_request_json string"},
	{"refuses an object payment_request_json", `{"payment_request_json":{}}`, "the quote has no payment_request_json string"},
	{"refuses a quote that is not an object", `[]`, "the quote is not an object"},
}

// caseTwinQuote is quoteFor(stored) with a second payment_request_json whose name differs in
// letter case, placed before the honest one.
func caseTwinQuote(t *testing.T, stored string) []byte {
	t.Helper()
	other, err := json.Marshal("{}")
	require.NoError(t, err)
	return []byte(strings.Replace(string(quoteFor(t, stored)), `"payment_request_json":`, `"Payment_Request_Json":`+string(other)+`,"payment_request_json":`, 1))
}

// quoteFor is a FulfillmentQuote whose payment_request_json is embedded.
func quoteFor(t *testing.T, embedded string) []byte {
	t.Helper()
	quote, err := json.Marshal(map[string]any{
		"version":              "1.0",
		"source_amount":        "1000000",
		"award_deadline":       "2026-10-07T11:59:00Z",
		"source":               map[string]any{"asset_identifier": "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"},
		"destination":          map[string]any{"asset_identifier": "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"},
		"settler_address":      "0x4444444444444444444444444444444444444444",
		"payment_request_json": embedded,
	})
	require.NoError(t, err)
	return quote
}
