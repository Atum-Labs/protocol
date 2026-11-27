package senderauth

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/mr-tron/base58"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The Go-built honest payments carry no deadlines, verifier or escrow, so the strict reader refuses
// them. Enforce refuses what the strict reader refuses.
func TestVerifyRequestCommitment_EnforceRefusesWhatTheStrictReaderRefuses(t *testing.T) {
	for _, c := range goBuiltRequests(t) {
		got, err := VerifyRequestCommitment([]byte(c.Request), c.Solana, WithDepositRequestHashV2(DepositRequestHashV2Enforce))
		assertCommitment(t, got, err, commitmentWant{Outcome: OutcomeRequestMalformed})
	}
}

// Audit admits what the strict reader refuses, by today's reading, and reports the refusal.
func TestVerifyRequestCommitment_AuditAdmitsWhatTheStrictReaderRefusesAndReportsIt(t *testing.T) {
	for _, c := range goBuiltRequests(t) {
		_, strictErr := ReadDepositRequest([]byte(c.Request))
		strict, _ := CommitmentResultOf(strictErr)
		require.NotEmpty(t, strict.Detail, c.Name)

		got, err := VerifyRequestCommitment([]byte(c.Request), c.Solana, WithDepositRequestHashV2(DepositRequestHashV2Audit))
		assertCommitment(t, got, err, commitmentWant{Outcome: OutcomeVerified})
		assert.Equal(t, strict.Detail, got.StrictDetail, c.Name)
		assert.Equal(t, "v1", got.DepositRequestHashVersion, c.Name)
		assert.Empty(t, got.ExpectedDepositRequestHashV2, c.Name)
	}
}

// A deposit that commits depositRequestHash v2 verifies once the check is opted in.
func TestVerifyRequestCommitment_AcceptsAV2SignedDeposit(t *testing.T) {
	for _, mode := range []DepositRequestHashV2Mode{DepositRequestHashV2Audit, DepositRequestHashV2Enforce} {
		for _, c := range strictSignedRequests(t, depositRequestHashV2) {
			got, err := VerifyRequestCommitment([]byte(c.Request), c.Solana, WithDepositRequestHashV2(mode))
			assertCommitment(t, got, err, commitmentWant{Outcome: OutcomeVerified})
			assert.Equal(t, "v2", got.DepositRequestHashVersion, c.Name)
		}
	}
}

// A case twin inside a credential is in a subtree v2 never hashes and the commitment check never
// reads, so enforce admits the v2 deposit; VerifyVP and VerifyVCProof refuse the twin where they read it.
func TestVerifyRequestCommitment_EnforceAdmitsACaseTwinInsideACredential(t *testing.T) {
	for _, c := range strictSignedRequests(t, depositRequestHashV2) {
		request := withCredentialCaseTwin(t, c.Request)
		got, err := VerifyRequestCommitment(request, c.Solana, WithDepositRequestHashV2(DepositRequestHashV2Enforce))
		assertCommitment(t, got, err, commitmentWant{Outcome: OutcomeVerified})
		assert.Equal(t, "v2", got.DepositRequestHashVersion, c.Name)
	}
}

// A deposit that commits v1 still verifies once the check is opted in, and says it matched v1.
func TestVerifyRequestCommitment_ReportsAV1SignedDepositAsV1(t *testing.T) {
	for _, mode := range []DepositRequestHashV2Mode{DepositRequestHashV2Audit, DepositRequestHashV2Enforce} {
		for _, c := range strictSignedRequests(t, depositRequestHashV1) {
			got, err := VerifyRequestCommitment([]byte(c.Request), c.Solana, WithDepositRequestHashV2(mode))
			assertCommitment(t, got, err, commitmentWant{Outcome: OutcomeVerified})
			assert.Equal(t, "v1", got.DepositRequestHashVersion, c.Name)
		}
	}
}

// Without the option the check is as before v2: a v2 deposit is refused and no v2 field is set.
func TestVerifyRequestCommitment_OffRefusesAV2SignedDepositAsBefore(t *testing.T) {
	for _, c := range strictSignedRequests(t, depositRequestHashV2) {
		for _, opts := range [][]CommitmentOption{nil, {WithDepositRequestHashV2(DepositRequestHashV2Off)}} {
			got, err := VerifyRequestCommitment([]byte(c.Request), c.Solana, opts...)
			assertCommitment(t, got, err, commitmentWant{Outcome: OutcomeRequestHashMismatch})
			assert.Empty(t, got.DepositRequestHashVersion, c.Name)
			assert.Empty(t, got.ExpectedDepositRequestHashV2, c.Name)
			assert.Empty(t, got.StrictDetail, c.Name)
		}
	}
}

// Editing a term after the payer signed v2 leaves the deposit matching neither hash, so it is
// refused in both modes, and the refusal names both candidates.
func TestVerifyRequestCommitment_RefusesADepositMatchingNeitherHash(t *testing.T) {
	for _, mode := range []DepositRequestHashV2Mode{DepositRequestHashV2Audit, DepositRequestHashV2Enforce} {
		for _, c := range strictSignedRequests(t, depositRequestHashV2) {
			edited := withMember(t, c.Request, "fulfillment_amount", "2000000")
			read, err := ReadDepositRequest(edited)
			require.NoError(t, err)

			got, err := VerifyRequestCommitment(edited, c.Solana, WithDepositRequestHashV2(mode))
			assertCommitment(t, got, err, commitmentWant{Outcome: OutcomeRequestHashMismatch, DetailContains: "depositRequestHash v2"})
			assert.Empty(t, got.DepositRequestHashVersion, c.Name)
			assert.Equal(t, "0x"+hex.EncodeToString(read.DepositRequestHashV2[:]), got.ExpectedDepositRequestHashV2, c.Name)
		}
	}
}

// On a request the strict reader refuses that also pays another destination, enforce refuses it as
// malformed before comparing the destination; audit compares it as before v2 and still reports why
// the strict reader refused it.
func TestVerifyRequestCommitment_StrictRefusalComesBeforeTheDestination(t *testing.T) {
	for _, c := range goBuiltRequests(t) {
		edited := editRequest(t, c.Request, func(doc map[string]any) {
			leg := doc["destination"].([]any)[0].(map[string]any)
			leg["account"] = leg["account"].(string) + "0"
		})

		got, err := VerifyRequestCommitment(edited, c.Solana, WithDepositRequestHashV2(DepositRequestHashV2Enforce))
		assertCommitment(t, got, err, commitmentWant{Outcome: OutcomeRequestMalformed})

		got, err = VerifyRequestCommitment(edited, c.Solana, WithDepositRequestHashV2(DepositRequestHashV2Audit))
		assertCommitment(t, got, err, commitmentWant{Outcome: OutcomeDestinationMismatch})
		assert.NotEmpty(t, got.StrictDetail, c.Name)
		assert.Empty(t, got.DepositRequestHashVersion, c.Name)
	}
}

// A signed request requires either hash once opted in: RequiredCommitmentOf returns v1 and v2, and
// the caller matches the one the deposit carries.
func TestRequiredCommitmentOf_ReturnsBothCandidatesForASignedRequest(t *testing.T) {
	for _, mode := range []DepositRequestHashV2Mode{DepositRequestHashV2Audit, DepositRequestHashV2Enforce} {
		for _, c := range strictSignedRequests(t, depositRequestHashV2) {
			read, err := ReadDepositRequest([]byte(c.Request))
			require.NoError(t, err)

			got, err := RequiredCommitmentOf([]byte(c.Request), c.Solana, WithDepositRequestHashV2(mode))
			require.NoError(t, err, c.Name)
			assert.Equal(t, "0x"+hex.EncodeToString(read.DepositRequestHashV1[:]), got.DepositRequestHash, c.Name)
			assert.Equal(t, "0x"+hex.EncodeToString(read.DepositRequestHashV2[:]), got.DepositRequestHashV2, c.Name)
		}
	}
}

// So does a request with no signed deposit yet, which is where a settler quotes.
func TestRequiredCommitmentOf_ReturnsBothCandidatesForAnUnsignedRequest(t *testing.T) {
	for _, mode := range []DepositRequestHashV2Mode{DepositRequestHashV2Audit, DepositRequestHashV2Enforce} {
		for _, c := range strictSignedRequests(t, depositRequestHashV2) {
			unsigned := withoutMember(t, c.Request, "sender_auth")
			read, err := ReadDepositRequest(unsigned)
			require.NoError(t, err)

			got, err := RequiredCommitmentOf(unsigned, c.Solana, WithDepositRequestHashV2(mode))
			require.NoError(t, err, c.Name)
			assert.Equal(t, "0x"+hex.EncodeToString(read.DepositRequestHashV1[:]), got.DepositRequestHash, c.Name)
			assert.Equal(t, "0x"+hex.EncodeToString(read.DepositRequestHashV2[:]), got.DepositRequestHashV2, c.Name)
		}
	}
}

// On a request the strict reader refuses, signed or not, enforce refuses it and audit returns the
// v1 commitment with the refusal reported.
func TestRequiredCommitmentOf_AppliesTheModeToAStrictRefusal(t *testing.T) {
	for _, c := range goBuiltRequests(t) {
		for _, request := range [][]byte{[]byte(c.Request), withoutMember(t, c.Request, "sender_auth")} {
			_, strictErr := ReadDepositRequest(request)
			strict, _ := CommitmentResultOf(strictErr)
			require.NotEmpty(t, strict.Detail, c.Name)

			_, err := RequiredCommitmentOf(request, c.Solana, WithDepositRequestHashV2(DepositRequestHashV2Enforce))
			requireCommitmentOutcome(t, err, OutcomeRequestMalformed)

			want, err := RequiredCommitmentOf(request, c.Solana)
			require.NoError(t, err, c.Name)
			want.StrictDetail = strict.Detail
			got, err := RequiredCommitmentOf(request, c.Solana, WithDepositRequestHashV2(DepositRequestHashV2Audit))
			require.NoError(t, err, c.Name)
			assert.Equal(t, want, got, c.Name)
		}
	}
}

// An audit refusal reports the strict reader's refusal too, signed or not.
func TestRequiredCommitmentOf_AuditRefusalReportsTheStrictRefusal(t *testing.T) {
	for _, c := range goBuiltRequests(t) {
		edited := withMember(t, c.Request, "destination", []any{})
		for _, request := range [][]byte{edited, withoutMember(t, string(edited), "sender_auth")} {
			_, err := RequiredCommitmentOf(request, c.Solana, WithDepositRequestHashV2(DepositRequestHashV2Audit))
			requireCommitmentOutcome(t, err, OutcomeDestinationMismatch)
			r, _ := CommitmentResultOf(err)
			assert.NotEmpty(t, r.StrictDetail, c.Name)
		}
	}
}

// Opted in, VerifyPaymentRequestJSON returns the commitment check's result, so its caller can
// report the version the deposit matched.
func TestVerifyPaymentRequestJSON_ReportsTheCommitmentOnceOptedIn(t *testing.T) {
	for _, c := range strictSignedRequests(t, depositRequestHashV2) {
		expected := c.Expectations
		expected.DepositRequestHashV2Mode = DepositRequestHashV2Enforce
		res, err := VerifyPaymentRequestJSON([]byte(c.Request), expected)
		require.NoError(t, err, c.Name)
		assert.Len(t, res.Results, 1, c.Name)
		assert.Equal(t, OutcomeVerified, res.Commitment.Outcome, c.Name)
		assert.Equal(t, "v2", res.Commitment.DepositRequestHashVersion, c.Name)
	}
}

// In audit mode, VerifyPaymentRequestJSON admits a request the strict reader refuses and reports the
// refusal in its result, not only in a refusal's error.
func TestVerifyPaymentRequestJSON_AuditReportsTheStrictRefusalOnAnAdmission(t *testing.T) {
	for _, c := range strictSignedRequests(t, depositRequestHashV1) {
		request := withMember(t, c.Request, "unknown_member", 1)
		_, strictErr := ReadDepositRequest(request)
		strict, _ := CommitmentResultOf(strictErr)
		require.NotEmpty(t, strict.Detail, c.Name)

		expected := c.Expectations
		expected.DepositRequestHashV2Mode = DepositRequestHashV2Audit
		res, err := VerifyPaymentRequestJSON(request, expected)
		require.NoError(t, err, c.Name)
		assert.Equal(t, strict.Detail, res.Commitment.StrictDetail, c.Name)
		assert.Equal(t, "v1", res.Commitment.DepositRequestHashVersion, c.Name)
	}
}

// Off, VerifyPaymentRequestJSON's result is as before v2: no commitment, in memory or in JSON.
func TestVerifyPaymentRequestJSON_OffReportsNoCommitment(t *testing.T) {
	for _, c := range strictSignedRequests(t, depositRequestHashV1) {
		res, err := VerifyPaymentRequestJSON([]byte(c.Request), c.Expectations)
		require.NoError(t, err, c.Name)
		assert.Zero(t, res.Commitment, c.Name)
		encoded, err := json.Marshal(res)
		require.NoError(t, err, c.Name)
		assert.NotContains(t, string(encoded), `"Commitment"`, c.Name)
	}
}

// Off, VerifyPaymentRequestJSON refuses a v2 deposit as before v2; opted in, it refuses one whose
// terms were edited after the payer signed.
func TestVerifyPaymentRequestJSON_RefusesAV2DepositOffAndAnEditedOne(t *testing.T) {
	for _, c := range strictSignedRequests(t, depositRequestHashV2) {
		_, err := VerifyPaymentRequestJSON([]byte(c.Request), c.Expectations)
		requireCommitmentOutcome(t, err, OutcomeRequestHashMismatch)

		expected := c.Expectations
		expected.DepositRequestHashV2Mode = DepositRequestHashV2Enforce
		_, err = VerifyPaymentRequestJSON(withMember(t, c.Request, "fulfillment_amount", "2000000"), expected)
		requireCommitmentOutcome(t, err, OutcomeRequestHashMismatch)
	}
}

// The v2 fields are logged only when set, so an unopted check logs exactly the keys it did before.
func TestCommitmentResult_LogFieldsAddTheV2FieldsWhenSet(t *testing.T) {
	c := strictSignedRequests(t, depositRequestHashV2)[0]
	got, err := VerifyRequestCommitment([]byte(c.Request), c.Solana, WithDepositRequestHashV2(DepositRequestHashV2Enforce))
	require.NoError(t, err)
	fields := got.LogFields()
	assert.Equal(t, "v2", fields["deposit_request_hash_version"])
	assert.Equal(t, got.ExpectedDepositRequestHashV2, fields["request_deposit_request_hash_v2"])
	assert.NotContains(t, fields, "strict_detail")

	b := goBuiltRequests(t)[0]
	got, err = VerifyRequestCommitment([]byte(b.Request), b.Solana, WithDepositRequestHashV2(DepositRequestHashV2Audit))
	require.NoError(t, err)
	fields = got.LogFields()
	assert.Equal(t, "v1", fields["deposit_request_hash_version"])
	assert.Equal(t, got.StrictDetail, fields["strict_detail"])
	assert.NotContains(t, fields, "request_deposit_request_hash_v2")
}

// CompareCommitment accepts v2 when the caller supplies it on the expectation, as its deprecation
// note says.
func TestCompareCommitment_AcceptsV2WhenTheExpectationCarriesIt(t *testing.T) {
	g := loadDepositRequestV2Vectors(t).Golden[0]
	read, err := ReadDepositRequest([]byte(g.Request))
	require.NoError(t, err)
	var doc struct {
		Destination []struct {
			AssetIdentifier string `json:"asset_identifier"`
			Account         string `json:"account"`
		} `json:"destination"`
	}
	require.NoError(t, json.Unmarshal([]byte(g.Request), &doc))
	leg := DestinationLeg{AssetIdentifier: doc.Destination[0].AssetIdentifier, Account: doc.Destination[0].Account}
	destination, err := BuildEscrowDestination(leg.AssetIdentifier, leg.Account)
	require.NoError(t, err)
	v2 := "0x" + hex.EncodeToString(read.DepositRequestHashV2[:])
	expected := CommitmentExpectation{Destinations: []DestinationLeg{leg}, RequestID: read.Terms.RequestID}

	_, err = CompareCommitment(destination, v2, expected)
	requireCommitmentOutcome(t, err, OutcomeRequestHashMismatch)

	expected.DepositRequestHashV2 = v2
	got, err := CompareCommitment(destination, v2, expected)
	require.NoError(t, err)
	assert.Equal(t, "v2", got.DepositRequestHashVersion)
}

// A mode the check does not know is the verifier's mistake, never a quiet audit: a misspelt
// enforce must not admit what enforce refuses.
func TestDepositRequestHashV2_RefusesAnUnknownMode(t *testing.T) {
	c := goBuiltRequests(t)[0]
	mode := WithDepositRequestHashV2("Enforce")
	_, err := VerifyRequestCommitment([]byte(c.Request), c.Solana, mode)
	requireCommitmentOutcome(t, err, OutcomeVerifierMisconfigured)
	_, err = RequiredCommitmentOf([]byte(c.Request), c.Solana, mode)
	requireCommitmentOutcome(t, err, OutcomeVerifierMisconfigured)
	_, err = VerifyPaymentRequestJSON([]byte(c.Request), VerifyPaymentRequestExpectations{DepositRequestHashV2Mode: "Enforce"})
	requireCommitmentOutcome(t, err, OutcomeVerifierMisconfigured)
}

// The typed VerifyPaymentRequest accepts only v1. Asked for v2, it refuses rather than check less
// than the caller asked for.
func TestVerifyPaymentRequest_RefusesAModeItCannotApply(t *testing.T) {
	c := strictSignedRequests(t, depositRequestHashV1)[0]
	var request PaymentRequest
	require.NoError(t, json.Unmarshal([]byte(c.Request), &request))
	expected := c.Expectations
	_, err := VerifyPaymentRequest(request, expected)
	require.NoError(t, err)

	for _, mode := range []DepositRequestHashV2Mode{DepositRequestHashV2Audit, DepositRequestHashV2Enforce, DepositRequestHashV2Retire} {
		expected.DepositRequestHashV2Mode = mode
		_, err := VerifyPaymentRequest(request, expected)
		requireCommitmentOutcome(t, err, OutcomeVerifierMisconfigured)
	}
}

// VerifyCommitment cannot read v2 from the request it is not given, so a v2 mode is refused rather
// than ignored: a caller opting in there would otherwise stay on v1 without knowing. Mirrors the TS
// test.
func TestVerifyCommitment_RefusesAModeItCannotApply(t *testing.T) {
	signed := SignedDeposit{SourceAssetIdentifier: "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}
	_, err := VerifyCommitment(signed, CommitmentExpectation{}, nil)
	requireCommitmentOutcome(t, err, OutcomeCommitmentAbsent)

	// Retire included: it could not tell a v2 deposit from a v1 one, so it would admit v1.
	for _, mode := range []DepositRequestHashV2Mode{DepositRequestHashV2Audit, DepositRequestHashV2Enforce, DepositRequestHashV2Retire, "Enforce"} {
		_, err := VerifyCommitment(signed, CommitmentExpectation{}, nil, WithDepositRequestHashV2(mode))
		requireCommitmentOutcome(t, err, OutcomeVerifierMisconfigured)
	}
}

// editRequest returns request decoded, changed by edit, and encoded again.
func editRequest(t *testing.T, request string, edit func(doc map[string]any)) []byte {
	t.Helper()
	var doc map[string]any
	require.NoError(t, json.Unmarshal([]byte(request), &doc))
	edit(doc)
	edited, err := json.Marshal(doc)
	require.NoError(t, err)
	return edited
}

// withMember returns request with one top-level member replaced.
func withMember(t *testing.T, request, name string, value any) []byte {
	t.Helper()
	return editRequest(t, request, func(doc map[string]any) { doc[name] = value })
}

// withCredentialCaseTwin returns request carrying a credential whose subject names one member twice,
// in two letter cases.
func withCredentialCaseTwin(t *testing.T, request string) []byte {
	t.Helper()
	credential := map[string]any{"credentialSubject": map[string]any{"role": "merchant", "Role": "admin"}}
	return withMember(t, request, "verifiableCredential", []any{credential})
}

// withoutMember returns request with one top-level member removed.
func withoutMember(t *testing.T, request, name string) []byte {
	t.Helper()
	return editRequest(t, request, func(doc map[string]any) { delete(doc, name) })
}

// Which depositRequestHash a strictSignedRequests deposit commits.
type signedHashVersion int

const (
	depositRequestHashV1 signedHashVersion = iota
	depositRequestHashV2
)

// strictSignedRequests are honest payments the strict reader admits, one per chain, whose deposit
// commits the given depositRequestHash. They are goBuiltRequests with every member v2 commits.
func strictSignedRequests(t *testing.T, version signedHashVersion) []strictSignedRequest {
	t.Helper()
	var out []strictSignedRequest
	for _, c := range strictBuildCases(t) {
		params := c.params
		params.PaymentRequestJSON = c.unsigned(t)
		if version == depositRequestHashV2 {
			params.DepositRequestHashVersion = 2
		}
		res, err := c.adapter.BuildAuthMessage(params)
		require.NoError(t, err, c.name)
		out = append(out, strictSignedRequest{
			namedRequest: namedRequest{Name: c.name, Request: string(c.signed(t, res)), Solana: c.solana},
			Expectations: c.expectations,
		})
	}
	return out
}

// strictSignedRequest is a strictSignedRequests payment with the expectations a verifier checks it
// against. Not serialized, unlike namedRequest.
type strictSignedRequest struct {
	namedRequest
	Expectations VerifyPaymentRequestExpectations
}

// strictBuildCase is one chain's honest payment: the builder inputs, the request they belong to
// without sender_auth, and the expectations a verifier checks the signed payment against.
type strictBuildCase struct {
	name         string
	adapter      ChainAdapter
	keyHex       string
	params       BuildParams
	payload      map[string]any
	solana       *SolanaDomain
	request      map[string]any
	expectations VerifyPaymentRequestExpectations
}

// unsigned is the assembled request, every member v2 commits and no sender_auth.
func (c strictBuildCase) unsigned(t *testing.T) []byte {
	t.Helper()
	unsigned, err := json.Marshal(c.request)
	require.NoError(t, err)
	return unsigned
}

// signed is the request carrying res, signed with the case's key.
func (c strictBuildCase) signed(t *testing.T, res AuthMessageResult) []byte {
	t.Helper()
	prehash := res.MessagePrehash
	sig, err := c.adapter.Sign(SignedMessageInput{Message: res.MessageHash, MessagePrehash: &prehash}, c.keyHex)
	require.NoError(t, err, c.name)
	message := map[string]any{"message": res.MessageHash, "signature": sig, "message_prehash": prehash}
	if c.payload != nil {
		message["payload"] = c.payload
	}
	request := map[string]any{}
	for k, v := range c.request {
		request[k] = v
	}
	request["sender_auth"] = map[string]any{"message_scheme": string(res.MessageScheme), "signed_messages": []any{message}}
	signed, err := json.Marshal(request)
	require.NoError(t, err)
	return signed
}

// strictBuildCases are the honest payments strictSignedRequests signs, one per chain.
func strictBuildCases(t *testing.T) []strictBuildCase {
	t.Helper()
	// The request is built from the same values the builder signs, as a producer builds it: role is
	// the form the request carries a role address in (Tron: hex, as the client SDKs write it).
	build := func(name string, adapter ChainAdapter, keyHex, account string, params BuildParams, role func(string) string, payload map[string]any, solana *SolanaDomain, expectations VerifyPaymentRequestExpectations) strictBuildCase {
		request := map[string]any{
			"version":    "1.0",
			"request_id": params.RequestID,
			"source":     map[string]any{"asset_identifier": params.SourceAsset, "account": account},
			"destination": []any{map[string]any{
				"asset_identifier": params.DestinationAsset, "account": params.DestinationAccount,
			}},
			"fulfillment_amount":      "1000000",
			"max_source_amount":       params.MaxSourceAmount,
			"quote_deadline":          "2026-10-07T12:00:00.000Z",
			"fulfillment_deadline":    "2026-10-07T12:30:00.000Z",
			"escrow_contract_address": params.SourceDefaults.EscrowContract,
			"quote_selector":          role(params.SourceDefaults.QuoteSelector),
			"fulfillment_verifier": map[string]any{
				"account": role(params.SourceDefaults.FulfillmentVerifierAccount), "endpoint": "https://veri-fill.example/v1",
			},
		}
		return strictBuildCase{name: name, adapter: adapter, keyHex: keyHex, params: params, payload: payload, solana: solana, request: request, expectations: expectations}
	}
	evmAccount := func(keyHex string) string {
		key, err := crypto.HexToECDSA(keyHex)
		require.NoError(t, err)
		return crypto.PubkeyToAddress(key.PublicKey).Hex()
	}

	evmDefaults, evmToken := evmTestDefaults()
	tronDefaults, tronToken := tronTestDefaults()
	evmKey, tronKey := strings.Repeat("11", 32), strings.Repeat("22", 32)

	solanaSeed := strings.Repeat("05", 32)
	seedBytes, err := hex.DecodeString(solanaSeed)
	require.NoError(t, err)
	payer := base58.Encode(ed25519.NewKeyFromSeed(seedBytes).Public().(ed25519.PublicKey))
	keys := func(fill byte) string { return base58.Encode(bytes.Repeat([]byte{fill}, 32)) }
	domainVersion, solanaNow := 5, 1700000060
	nonce, err := DeterministicSolanaNonce("req_v2_sol_go", payer)
	require.NoError(t, err)

	return []strictBuildCase{
		build("strict-evm", evmAdapter{}, evmKey, evmAccount(evmKey), BuildParams{
			SourceAsset: "eip155:1/erc20:" + evmToken, MaxSourceAmount: "1000000", SourceDefaults: evmDefaults,
			RequestID: "req_v2_evm_go", Nonce: big.NewInt(123), Deadline: big.NewInt(1924991999),
			DestinationAsset:   "eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			DestinationAccount: "0xC0FFEE254729296a45a3885639AC7E10F9d54979",
		}, identityAddr, nil, nil, VerifyPaymentRequestExpectations{Expectations: Expectations{MaxSourceAmount: "1000000"}}),
		build("strict-tron", tronAdapter{}, tronKey, evmAccount(tronKey), BuildParams{
			SourceAsset: "tron:mainnet/trc20:" + tronToken, MaxSourceAmount: "10000000", SourceDefaults: tronDefaults,
			RequestID: "req_v2_tron_go", Nonce: big.NewInt(456), Deadline: big.NewInt(1924991999),
			DestinationAsset:   "tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
			DestinationAccount: "TQ5NMqJjW8sTHhcNJ6VhVnQ2gPTBqLPRLB",
		}, tronNormalize, nil, nil, VerifyPaymentRequestExpectations{Expectations: Expectations{MaxSourceAmount: "10000000"}}),
		build("strict-solana", solanaAdapter{}, solanaSeed, payer, BuildParams{
			SourceAsset: "solana:mainnet/spl:" + keys(9), Depositor: payer, MaxSourceAmount: "1000000", RequestID: "req_v2_sol_go",
			SourceDefaults: ChainDefaults{
				EscrowContract: keys(1), QuoteSelector: keys(2), FulfillmentVerifierAccount: keys(3),
				SvmSignatureClusterID: "devnet", SvmSignatureDomainVersion: &domainVersion,
			},
			DestinationAsset:   "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo",
			DestinationAccount: "7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4",
			Nonce:              new(big.Int).SetUint64(nonce),
			SolanaClock:        func(string) (uint64, error) { return 1700000000, nil },
		}, identityAddr, map[string]any{"delegate_signer": payer}, &SolanaDomain{EscrowProgramID: keys(1), ClusterID: "devnet", DomainVersion: domainVersion},
			VerifyPaymentRequestExpectations{Expectations: Expectations{
				MaxSourceAmount: "1000000", EscrowContract: keys(1),
				SvmSignatureClusterID: "devnet", SvmSignatureDomainVersion: &domainVersion, NowSec: &solanaNow,
			}}),
	}
}
