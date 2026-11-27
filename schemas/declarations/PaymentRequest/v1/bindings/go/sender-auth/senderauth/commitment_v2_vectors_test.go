package senderauth

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The depositRequestHash v2 behaviour of every entry point, as this SDK computes it, for the
// TypeScript suite to assert. Regenerate: REGEN_COMMITMENT_V2_VECTORS=1 go test -count=1 ./senderauth.
func TestCommitmentV2Vectors_AreCurrent(t *testing.T) {
	fixture, err := json.MarshalIndent(commitmentV2Vectors(t), "", "  ")
	require.NoError(t, err)
	fixture = append(asciiJSON(fixture), '\n')
	// The file stays ASCII, like the deposit-request-hash v2 vectors it is built from.
	for i, b := range fixture {
		require.Less(t, b, byte(0x80), "commitment-v2-vectors.json byte %d is not ASCII", i)
	}
	path := conformancePath("commitment-v2-vectors.json")
	if os.Getenv("REGEN_COMMITMENT_V2_VECTORS") == "1" {
		require.NoError(t, os.WriteFile(path, fixture, 0o644))
	}
	committed, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, string(fixture), string(committed), "commitment-v2-vectors.json is stale; regenerate it")
}

// asciiJSON writes every non-ASCII rune of a JSON document as a \u escape, a surrogate pair above
// U+FFFF. JSON only carries them inside strings, so every value stays the same.
func asciiJSON(document []byte) []byte {
	var b strings.Builder
	for _, r := range string(document) {
		switch {
		case r < 0x80:
			b.WriteRune(r)
		case r > 0xFFFF:
			hi, lo := utf16.EncodeRune(r)
			fmt.Fprintf(&b, "\\u%04x\\u%04x", hi, lo)
		default:
			fmt.Fprintf(&b, "\\u%04x", r)
		}
	}
	return []byte(b.String())
}

// A row's mode is null where a shared configuration gives null, which Go decodes as off.
type v2RequestCase struct {
	Name    string                    `json:"name"`
	Request string                    `json:"request"`
	Solana  *SolanaDomain             `json:"solana,omitempty"`
	Mode    *DepositRequestHashV2Mode `json:"mode"`
	Result  CommitmentResult          `json:"result"`
}

type v2RequiredCase struct {
	Name       string                    `json:"name"`
	Request    string                    `json:"request"`
	Solana     *SolanaDomain             `json:"solana,omitempty"`
	Mode       *DepositRequestHashV2Mode `json:"mode"`
	Commitment *RequiredCommitment       `json:"commitment,omitempty"`
	Result     *CommitmentResult         `json:"result,omitempty"`
}

type v2VerifyJSONCase struct {
	Name     string         `json:"name"`
	Request  string         `json:"request"`
	Expected map[string]any `json:"expected"`
	Amount   string         `json:"amount,omitempty"`
	// Commitment is VerifyResult.Commitment on an admission, when opted in.
	Commitment *CommitmentResult `json:"commitment,omitempty"`
	Result     *CommitmentResult `json:"result,omitempty"`
}

type v2QuoteCase struct {
	Name   string            `json:"name"`
	Quote  string            `json:"quote"`
	Stored string            `json:"stored"`
	Hashes *v2QuoteHashes    `json:"hashes,omitempty"`
	Result *CommitmentResult `json:"result,omitempty"`
}

type v2BuildCase struct {
	Name   string        `json:"name"`
	Params v2BuildParams `json:"params"`
	// Exactly one of Result, Refusal (a *CommitmentError) and Error (any other error) is set.
	Result  *v2BuildResult    `json:"result,omitempty"`
	Refusal *CommitmentResult `json:"refusal,omitempty"`
	Error   string            `json:"error,omitempty"`
}

// v2BuildParams are BuildParams under the TypeScript buildAuthMessage keys. SolanaClock is the
// issued_at the fixture's clock reader returns.
type v2BuildParams struct {
	SourceAsset               string        `json:"sourceAsset"`
	Depositor                 string        `json:"depositor"`
	MaxSourceAmount           string        `json:"maxSourceAmount"`
	QuoteSourceAmount         string        `json:"quoteSourceAmount,omitempty"`
	RequestID                 string        `json:"requestId,omitempty"`
	SourceDefaults            ChainDefaults `json:"sourceDefaults"`
	DestinationAsset          string        `json:"destinationAsset,omitempty"`
	DestinationAccount        string        `json:"destinationAccount,omitempty"`
	Deadline                  string        `json:"deadline,omitempty"`
	Nonce                     string        `json:"nonce,omitempty"`
	SolanaClock               *uint64       `json:"solanaClock,omitempty"`
	PaymentRequestJSON        string        `json:"paymentRequestJSON,omitempty"`
	DepositRequestHashVersion int           `json:"depositRequestHashVersion,omitempty"`
}

type v2BuildResult struct {
	MessageScheme  SenderAuthMessageScheme `json:"messageScheme"`
	MessageHash    string                  `json:"messageHash"`
	MessagePrehash string                  `json:"messagePrehash"`
}

// buildCases are the builder's results on the strict payments: the deprecated params alone, the
// assembled request with each version, and the inputs it refuses.
func buildCases(t *testing.T) []v2BuildCase {
	t.Helper()
	var out []v2BuildCase
	for _, c := range strictBuildCases(t) {
		unsigned := c.unsigned(t)
		variants := []struct {
			name string
			edit func(p *BuildParams)
		}{
			{"deprecated-params", func(*BuildParams) {}},
			{"request", func(p *BuildParams) { p.PaymentRequestJSON = unsigned }},
			{"request-v1", func(p *BuildParams) { p.PaymentRequestJSON, p.DepositRequestHashVersion = unsigned, 1 }},
			{"request-v2", func(p *BuildParams) { p.PaymentRequestJSON, p.DepositRequestHashVersion = unsigned, 2 }},
			{"request-only-v1", func(p *BuildParams) {
				p.PaymentRequestJSON, p.RequestID, p.DestinationAsset, p.DestinationAccount = unsigned, "", "", ""
			}},
			{"request-only-v2", func(p *BuildParams) {
				p.PaymentRequestJSON, p.DepositRequestHashVersion = unsigned, 2
				p.RequestID, p.DestinationAsset, p.DestinationAccount = "", "", ""
			}},
			{"v2-without-request", func(p *BuildParams) { p.DepositRequestHashVersion = 2 }},
			{"version-3", func(p *BuildParams) { p.PaymentRequestJSON, p.DepositRequestHashVersion = unsigned, 3 }},
			{"request-id-contradicts", func(p *BuildParams) { p.PaymentRequestJSON, p.RequestID = unsigned, "another_request" }},
			{"destination-contradicts", func(p *BuildParams) { p.PaymentRequestJSON, p.DestinationAccount = unsigned, p.DestinationAccount+"0" }},
			{"source-asset-contradicts", func(p *BuildParams) {
				p.PaymentRequestJSON = unsigned
				p.SourceAsset = p.SourceAsset[:strings.LastIndex(p.SourceAsset, ":")+1] + p.SourceDefaults.EscrowContract
			}},
			{"depositor-contradicts", func(p *BuildParams) { p.PaymentRequestJSON, p.Depositor = unsigned, p.SourceDefaults.EscrowContract }},
			{"max-source-amount-contradicts", func(p *BuildParams) { p.PaymentRequestJSON, p.MaxSourceAmount = unsigned, p.MaxSourceAmount+"0" }},
			{"escrow-contradicts", func(p *BuildParams) {
				p.PaymentRequestJSON, p.SourceDefaults.EscrowContract = unsigned, p.SourceDefaults.QuoteSelector
			}},
			{"reserver-contradicts", func(p *BuildParams) {
				p.PaymentRequestJSON, p.SourceDefaults.QuoteSelector = unsigned, p.SourceDefaults.EscrowContract
			}},
			{"releaser-contradicts", func(p *BuildParams) {
				p.PaymentRequestJSON, p.SourceDefaults.FulfillmentVerifierAccount = unsigned, p.SourceDefaults.EscrowContract
			}},
			{"max-source-amount-leading-zero", func(p *BuildParams) { p.PaymentRequestJSON, p.MaxSourceAmount = unsigned, "0"+p.MaxSourceAmount }},
			{"quote-amount-v1", func(p *BuildParams) {
				p.PaymentRequestJSON, p.MaxSourceAmount, p.QuoteSourceAmount = unsigned, "", quoteBelow(t, p.MaxSourceAmount)
			}},
			{"quote-amount-v2", func(p *BuildParams) {
				p.PaymentRequestJSON, p.DepositRequestHashVersion = unsigned, 2
				p.MaxSourceAmount, p.QuoteSourceAmount = "", quoteBelow(t, p.MaxSourceAmount)
			}},
			{"quote-amount-at-cap", func(p *BuildParams) {
				p.PaymentRequestJSON, p.MaxSourceAmount, p.QuoteSourceAmount = unsigned, "", p.MaxSourceAmount
			}},
			{"quote-above-cap", func(p *BuildParams) {
				p.PaymentRequestJSON, p.MaxSourceAmount, p.QuoteSourceAmount = unsigned, "", p.MaxSourceAmount+"0"
			}},
			{"quote-and-cap", func(p *BuildParams) {
				p.PaymentRequestJSON, p.QuoteSourceAmount = unsigned, quoteBelow(t, p.MaxSourceAmount)
			}},
			{"quote-not-positive", func(p *BuildParams) { p.PaymentRequestJSON, p.MaxSourceAmount, p.QuoteSourceAmount = unsigned, "", "0" }},
			{"strict-refusal", func(p *BuildParams) {
				p.PaymentRequestJSON = withMember(t, string(unsigned), "unknown_member", 1)
			}},
		}
		for _, v := range variants {
			params := c.params
			v.edit(&params)
			row := v2BuildCase{Name: c.name + "/" + v.name, Params: v2BuildParams{
				SourceAsset: params.SourceAsset, Depositor: params.Depositor, MaxSourceAmount: params.MaxSourceAmount,
				QuoteSourceAmount: params.QuoteSourceAmount, RequestID: params.RequestID, SourceDefaults: params.SourceDefaults,
				DestinationAsset: params.DestinationAsset, DestinationAccount: params.DestinationAccount,
				PaymentRequestJSON: string(params.PaymentRequestJSON), DepositRequestHashVersion: params.DepositRequestHashVersion,
			}}
			if params.Deadline != nil {
				row.Params.Deadline = params.Deadline.String()
			}
			if params.Nonce != nil {
				row.Params.Nonce = params.Nonce.String()
			}
			if params.SolanaClock != nil {
				issuedAt, err := params.SolanaClock("")
				require.NoError(t, err)
				row.Params.SolanaClock = &issuedAt
			}
			res, err := c.adapter.BuildAuthMessage(params)
			switch refusal, ok := CommitmentResultOf(err); {
			case err == nil:
				row.Result = &v2BuildResult{res.MessageScheme, res.MessageHash, res.MessagePrehash}
			case ok:
				row.Refusal = &refusal
			default:
				row.Error = err.Error()
			}
			out = append(out, row)
		}
	}
	return out
}

type v2QuoteHashes struct {
	DepositRequestHashV1 string `json:"depositRequestHashV1"`
	DepositRequestHashV2 string `json:"depositRequestHashV2"`
}

func commitmentV2Vectors(t *testing.T) map[string]any {
	t.Helper()
	// VerifyPaymentRequestJSON does not read retire, so its rows have one retire row, below, not one per
	// input.
	verifyModes := []DepositRequestHashV2Mode{DepositRequestHashV2Off, DepositRequestHashV2Audit, DepositRequestHashV2Enforce}
	modes := append(append([]DepositRequestHashV2Mode{}, verifyModes...), DepositRequestHashV2Retire)
	modeName := func(m DepositRequestHashV2Mode) string {
		if m == DepositRequestHashV2Off {
			return "off"
		}
		return string(m)
	}
	resultOf := func(r CommitmentResult, err error) CommitmentResult {
		if err != nil {
			refusal, ok := CommitmentResultOf(err)
			require.True(t, ok, err.Error())
			return refusal
		}
		return r
	}

	// The inputs: honest strict payments signed with v1 and v2, a v2 one edited after signing, a v2
	// one carrying a case twin inside a credential, and the Go-built payments the strict reader
	// refuses, honest and paying another destination.
	type input struct {
		name    string
		request string
		solana  *SolanaDomain
		// expected is what VerifyPaymentRequestJSON checks the payment against; nil for the
		// Go-built payments, which are not run through it.
		expected *VerifyPaymentRequestExpectations
	}
	var signed, unsigned []input
	for _, c := range strictSignedRequests(t, depositRequestHashV1) {
		expected := c.Expectations
		signed = append(signed, input{c.Name + "-v1", c.Request, c.Solana, &expected})
	}
	for _, c := range strictSignedRequests(t, depositRequestHashV2) {
		expected := c.Expectations
		signed = append(signed, input{c.Name + "-v2", c.Request, c.Solana, &expected})
		signed = append(signed, input{c.Name + "-v2-amount-edited", string(withMember(t, c.Request, "fulfillment_amount", "2000000")), c.Solana, &expected})
		signed = append(signed, input{c.Name + "-v2-credential-twin", string(withCredentialCaseTwin(t, c.Request)), c.Solana, &expected})
		unsigned = append(unsigned, input{c.Name + "-unsigned", string(withoutMember(t, c.Request, "sender_auth")), c.Solana, &expected})
	}
	for _, c := range goBuiltRequests(t) {
		signed = append(signed, input{c.Name, c.Request, c.Solana, nil})
		signed = append(signed, input{c.Name + "-no-destination", string(withMember(t, c.Request, "destination", []any{})), c.Solana, nil})
		unsigned = append(unsigned, input{c.Name + "-unsigned", string(withoutMember(t, c.Request, "sender_auth")), c.Solana, nil})
		// Refused after the strict reader, so audit's refusal carries the strict detail.
		unsigned = append(unsigned, input{c.Name + "-no-destination-unsigned", string(withoutMember(t, string(withMember(t, c.Request, "destination", []any{})), "sender_auth")), c.Solana, nil})
	}

	// odd are the modes outside modes: two Go does not know, refused, and null, which Go decodes as
	// off. Their rows are named for them and run on the first signed payment.
	odd := []struct {
		name string
		mode *DepositRequestHashV2Mode
	}{
		{"unknown-mode", modePtr("Enforce")},
		{"unknown-mode-retire", modePtr("Retire")},
		{"null", nil},
	}
	modeOf := func(mode *DepositRequestHashV2Mode) DepositRequestHashV2Mode {
		if mode == nil {
			return DepositRequestHashV2Off
		}
		return *mode
	}
	requestRow := func(name string, in input, mode *DepositRequestHashV2Mode) v2RequestCase {
		r, err := VerifyRequestCommitment([]byte(in.request), in.solana, WithDepositRequestHashV2(modeOf(mode)))
		return v2RequestCase{Name: name, Request: in.request, Solana: in.solana, Mode: mode, Result: resultOf(r, err)}
	}
	requiredRow := func(name string, in input, mode *DepositRequestHashV2Mode) v2RequiredCase {
		c := v2RequiredCase{Name: name, Request: in.request, Solana: in.solana, Mode: mode}
		commitment, err := RequiredCommitmentOf([]byte(in.request), in.solana, WithDepositRequestHashV2(modeOf(mode)))
		if err != nil {
			r := resultOf(CommitmentResult{}, err)
			c.Result = &r
		} else {
			c.Commitment = &commitment
		}
		return c
	}
	verifyJSONRow := func(name string, in input, mode *DepositRequestHashV2Mode) v2VerifyJSONCase {
		expected := *in.expected
		expected.DepositRequestHashV2Mode = modeOf(mode)
		c := v2VerifyJSONCase{Name: name, Request: in.request, Expected: expectationsJSON(expected)}
		if mode == nil {
			// null, which the struct cannot spell.
			c.Expected["depositRequestHashV2Mode"] = nil
		}
		res, err := VerifyPaymentRequestJSON([]byte(in.request), expected)
		if err != nil {
			r := resultOf(CommitmentResult{}, err)
			c.Result = &r
		} else {
			c.Amount = res.Results[0].Amount
			if res.Commitment != (CommitmentResult{}) {
				c.Commitment = &res.Commitment
			}
		}
		return c
	}

	var requests []v2RequestCase
	var required []v2RequiredCase
	for _, mode := range modes {
		for _, in := range signed {
			requests = append(requests, requestRow(in.name+"/"+modeName(mode), in, modePtr(mode)))
		}
		for _, in := range append(append([]input{}, signed...), unsigned...) {
			required = append(required, requiredRow(in.name+"/"+modeName(mode), in, modePtr(mode)))
		}
	}
	first := signed[0]
	for _, o := range odd {
		requests = append(requests, requestRow(first.name+"/"+o.name, first, o.mode))
		required = append(required, requiredRow(first.name+"/"+o.name, first, o.mode))
	}

	// VerifyPaymentRequestJSON also gets v1-signed payments the strict reader refuses for a member v1
	// does not hash, so audit admits them and reports the refusal.
	verifyInputs := append([]input{}, signed...)
	for _, c := range strictSignedRequests(t, depositRequestHashV1) {
		expected := c.Expectations
		verifyInputs = append(verifyInputs, input{c.Name + "-v1-unknown-member", string(withMember(t, c.Request, "unknown_member", 1)), c.Solana, &expected})
	}
	var verifyJSON []v2VerifyJSONCase
	for _, in := range verifyInputs {
		if in.expected == nil {
			continue
		}
		for _, mode := range verifyModes {
			verifyJSON = append(verifyJSON, verifyJSONRow(in.name+"/"+modeName(mode), in, modePtr(mode)))
		}
	}
	// Retire is refused, even on a v2 payment it would admit, rather than read as enforce.
	v2 := signed[slices.IndexFunc(signed, func(in input) bool { return strings.HasSuffix(in.name, "-v2") })]
	verifyJSON = append(verifyJSON, verifyJSONRow(v2.name+"/retire", v2, modePtr(DepositRequestHashV2Retire)))
	for _, o := range odd {
		verifyJSON = append(verifyJSON, verifyJSONRow(first.name+"/"+o.name, first, o.mode))
	}

	return map[string]any{
		"_comment": "depositRequestHash v2 behaviour of VerifyRequestCommitment, RequiredCommitmentOf, VerifyPaymentRequestJSON, " +
			"VerifyQuoteRequestBinding and BuildAuthMessage, computed by the Go sender-auth SDK. Every implementation must give the same results. " +
			"Regenerate: REGEN_COMMITMENT_V2_VECTORS=1 go test -count=1 ./senderauth (in bindings/go/sender-auth).",
		"requests":           requests,
		"requiredCommitment": required,
		"verifyJson":         verifyJSON,
		"quoteBinding":       quoteBindingCases(t),
		"build":              buildCases(t),
	}
}

// modePtr is mode as a vector row carries it.
func modePtr(mode DepositRequestHashV2Mode) *DepositRequestHashV2Mode { return &mode }

// expectationsJSON is expected under the keys both SDKs read.
func expectationsJSON(expected VerifyPaymentRequestExpectations) map[string]any {
	out := map[string]any{"maxSourceAmount": expected.MaxSourceAmount}
	if expected.EscrowContract != "" {
		out["escrowContract"] = expected.EscrowContract
	}
	if expected.SvmSignatureClusterID != "" {
		out["svmSignatureClusterId"] = expected.SvmSignatureClusterID
	}
	if expected.SvmSignatureDomainVersion != nil {
		out["svmSignatureDomainVersion"] = *expected.SvmSignatureDomainVersion
	}
	if expected.NowSec != nil {
		out["nowSec"] = *expected.NowSec
	}
	if expected.DepositRequestHashV2Mode != DepositRequestHashV2Off {
		out["depositRequestHashV2Mode"] = string(expected.DepositRequestHashV2Mode)
	}
	return out
}

func quoteBindingCases(t *testing.T) []v2QuoteCase {
	t.Helper()
	v := loadDepositRequestV2Vectors(t)
	run := func(name string, quote []byte, stored string) v2QuoteCase {
		c := v2QuoteCase{Name: name, Quote: string(quote), Stored: stored}
		read, err := VerifyQuoteRequestBinding(quote, []byte(stored))
		if err != nil {
			r, ok := CommitmentResultOf(err)
			require.True(t, ok, err.Error())
			c.Result = &r
		} else {
			c.Hashes = &v2QuoteHashes{
				DepositRequestHashV1: "0x" + hex.EncodeToString(read.DepositRequestHashV1[:]),
				DepositRequestHashV2: "0x" + hex.EncodeToString(read.DepositRequestHashV2[:]),
			}
		}
		return c
	}

	var cases []v2QuoteCase
	golden := map[string]string{}
	for _, g := range v.Golden {
		golden[g.Name] = g.Request
		cases = append(cases, run("binds: "+g.Name, quoteFor(t, g.Request), g.Request))
	}
	for _, r := range v.Reencoded {
		if r.Path == "postgres-jsonb" {
			cases = append(cases, run("binds a JSONB-stored request: "+r.Golden, quoteFor(t, golden[r.Golden]), r.Request))
		}
	}
	stored := v.Golden[0].Request
	for _, edit := range quoteRequestEdits {
		cases = append(cases, run("refuses an edited "+edit.name, quoteFor(t, string(withMember(t, stored, edit.member, edit.value))), stored))
	}
	cases = append(cases, run("refuses a case-twin payment_request_json", caseTwinQuote(t, stored), stored))
	for _, q := range quotesWithoutAnEmbeddedRequest {
		cases = append(cases, run(q.name, []byte(q.quote), stored))
	}
	cases = append(cases,
		run("refuses a quote that is not JSON", []byte(`{`), stored),
		run("refuses an embedded copy the strict reader refuses", quoteFor(t, v.Refused[0].Request), stored),
		run("refuses a stored request the strict reader refuses", quoteFor(t, stored), v.Refused[0].Request),
	)
	// An originator-executed deposit's nonce is not in v2, so the binding compares it on its own.
	direct := string(directDepositRequest(t, "7"))
	cases = append(cases,
		run("binds an originator-executed deposit with its nonce", quoteFor(t, direct), direct),
		run("refuses a quote naming another deposit_nonce", quoteFor(t, string(directDepositRequest(t, "8"))), direct),
		run("refuses a quote that drops the deposit_nonce", quoteFor(t, string(directDepositRequest(t, ""))), direct),
	)
	return cases
}

// Retire admits only a deposit matched as v2: a v1 deposit is refused as request_hash_mismatch, and
// a request the strict reader refuses is refused as enforce refuses it, since it has no v2 a deposit
// could commit. VerifyPaymentRequestJSON does not read retire, so it refuses it even where enforce
// admits.
func TestVerifyRequestCommitment_RetireAdmitsOnlyV2(t *testing.T) {
	retire := WithDepositRequestHashV2(DepositRequestHashV2Retire)
	for _, c := range strictSignedRequests(t, depositRequestHashV2) {
		r, err := VerifyRequestCommitment([]byte(c.Request), c.Solana, retire)
		require.NoError(t, err, "%s: a v2 deposit is admitted", c.Name)
		assert.Equal(t, "v2", r.DepositRequestHashVersion, c.Name)

		expected := c.Expectations
		expected.DepositRequestHashV2Mode = DepositRequestHashV2Enforce
		_, err = VerifyPaymentRequestJSON([]byte(c.Request), expected)
		require.NoError(t, err, "%s: enforce admits it", c.Name)
		expected.DepositRequestHashV2Mode = DepositRequestHashV2Retire
		_, err = VerifyPaymentRequestJSON([]byte(c.Request), expected)
		requireCommitmentOutcome(t, err, OutcomeVerifierMisconfigured)
	}
	for _, c := range strictSignedRequests(t, depositRequestHashV1) {
		r, err := VerifyRequestCommitment([]byte(c.Request), c.Solana, retire)
		require.Error(t, err, "%s: a v1 deposit is refused", c.Name)
		assert.Equal(t, OutcomeRequestHashMismatch, r.Outcome, c.Name)
		assert.Equal(t, detailDepositRequestHashV1Retired, r.Detail, c.Name)
		assert.Empty(t, r.DepositRequestHashVersion, "%s: a refusal matched no version", c.Name)
	}
	for _, c := range goBuiltRequests(t) {
		enforced, enforceErr := VerifyRequestCommitment([]byte(c.Request), c.Solana, WithDepositRequestHashV2(DepositRequestHashV2Enforce))
		r, err := VerifyRequestCommitment([]byte(c.Request), c.Solana, retire)
		require.Error(t, err, "%s: the strict reader refuses it", c.Name)
		assert.Equal(t, OutcomeRequestMalformed, r.Outcome, c.Name)
		assert.Equal(t, resultOfRefusal(t, enforced, enforceErr), resultOfRefusal(t, r, err), "%s: as enforce refuses it", c.Name)
	}
}

// Retire makes RequiredCommitmentOf name only v2, signed or not: a commitment names the v2 under
// both hashes, so a consumer admitting either admits only v2, a signed v1 deposit is refused as
// VerifyRequestCommitment refuses it, and a request the strict reader refuses is refused as enforce
// refuses it.
func TestRequiredCommitmentOf_RetireNamesOnlyV2(t *testing.T) {
	retire := WithDepositRequestHashV2(DepositRequestHashV2Retire)
	for _, c := range strictSignedRequests(t, depositRequestHashV2) {
		for _, request := range []string{c.Request, string(withoutMember(t, c.Request, "sender_auth"))} {
			commitment, err := RequiredCommitmentOf([]byte(request), c.Solana, retire)
			require.NoError(t, err, c.Name)
			require.NotEmpty(t, commitment.DepositRequestHashV2, c.Name)
			assert.Equal(t, commitment.DepositRequestHashV2, commitment.DepositRequestHash, "%s: v1 is not named", c.Name)
		}
	}
	for _, c := range strictSignedRequests(t, depositRequestHashV1) {
		_, err := RequiredCommitmentOf([]byte(c.Request), c.Solana, retire)
		r, _ := CommitmentResultOf(err)
		assert.Equal(t, OutcomeRequestHashMismatch, r.Outcome, c.Name)
		assert.Equal(t, detailDepositRequestHashV1Retired, r.Detail, c.Name)
	}
	for _, c := range goBuiltRequests(t) {
		unsigned := withoutMember(t, c.Request, "sender_auth")
		_, enforceErr := RequiredCommitmentOf(unsigned, c.Solana, WithDepositRequestHashV2(DepositRequestHashV2Enforce))
		_, err := RequiredCommitmentOf(unsigned, c.Solana, retire)
		require.Error(t, err, c.Name)
		assert.Equal(t, resultOfRefusal(t, CommitmentResult{}, enforceErr), resultOfRefusal(t, CommitmentResult{}, err), "%s: as enforce refuses it", c.Name)
	}
}

// resultOfRefusal is the result a refusal carries.
func resultOfRefusal(t *testing.T, _ CommitmentResult, err error) CommitmentResult {
	t.Helper()
	r, ok := CommitmentResultOf(err)
	require.True(t, ok, "%v is a refusal", err)
	return r
}
