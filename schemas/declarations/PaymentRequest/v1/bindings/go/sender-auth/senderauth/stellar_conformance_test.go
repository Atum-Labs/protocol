package senderauth

import (
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// The frozen Stellar vectors, shared with the TS suite (stellar-conformance.test.ts). Every accept
// and every reject must come out the same here: the message bytes, the signature check, the
// commitment outcome and its detail. The golden case is not an output of either implementation: its
// digest and delegate signature are the ones contracts/stellar/source/docs/witness-layouts.md
// derives out of band.
const (
	stellarVectorsVerifyCount   = 69
	stellarVectorsBuildCount    = 41
	stellarVectorsRequestsCount = 8
)

type stellarExpect struct {
	Kind                      string            `json:"kind"`
	Amount                    string            `json:"amount"`
	DeadlineSec               int               `json:"deadlineSec"`
	Signer                    string            `json:"signer"`
	DelegateSigner            string            `json:"delegateSigner"`
	DelegateOnchainUnverified bool              `json:"delegateOnchainUnverified"`
	DelegateEpoch             string            `json:"delegateEpoch"`
	Outcome                   CommitmentOutcome `json:"outcome"`
	Detail                    string            `json:"detail"`
	MessageContains           string            `json:"messageContains"`
}

type stellarVerifyVector struct {
	Name       string                `json:"name"`
	Call       string                `json:"call"`
	Source     SourceRef             `json:"source"`
	Commitment CommitmentExpectation `json:"commitment"`
	Expected   Expectations          `json:"expected"`
	Signed     SignedMessageInput    `json:"signed"`
	Expect     stellarExpect         `json:"expect"`
}

type stellarBuildVector struct {
	Name  string `json:"name"`
	Input struct {
		SourceAsset        string        `json:"sourceAsset"`
		Depositor          string        `json:"depositor"`
		MaxSourceAmount    string        `json:"maxSourceAmount"`
		QuoteSourceAmount  string        `json:"quoteSourceAmount"`
		RequestID          string        `json:"requestId"`
		DestinationAsset   string        `json:"destinationAsset"`
		DestinationAccount string        `json:"destinationAccount"`
		SourceDefaults     ChainDefaults `json:"sourceDefaults"`
		Nonce              *string       `json:"nonce"`
		IssuedAt           *uint64       `json:"issuedAt"`
		Deadline           *uint64       `json:"deadline"`
		DelegateEpoch      *string       `json:"delegateEpoch"`
	} `json:"input"`
	MessageHash    string `json:"messageHash"`
	MessagePrehash string `json:"messagePrehash"`
	ErrorContains  string `json:"errorContains"`
}

type stellarRequestVector struct {
	Name     string `json:"name"`
	Request  string `json:"request"`
	Expected struct {
		EscrowContract string `json:"escrowContract"`
		Reserver       string `json:"reserver"`
		Releaser       string `json:"releaser"`
	} `json:"expected"`
	Expect struct {
		Amount             string            `json:"amount"`
		Outcome            CommitmentOutcome `json:"outcome"`
		DelegateUnverified bool              `json:"delegateUnverified"`
	} `json:"expect"`
}

func loadStellarVectors(t *testing.T) (doc struct {
	Verify   []stellarVerifyVector  `json:"verify"`
	Build    []stellarBuildVector   `json:"build"`
	Requests []stellarRequestVector `json:"requests"`
}) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "conformance", "stellar-sender-auth-vectors.json"))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal(raw, &doc))
	return doc
}

func TestStellarConformanceVectorCounts(t *testing.T) {
	doc := loadStellarVectors(t)
	require.Len(t, doc.Verify, stellarVectorsVerifyCount)
	require.Len(t, doc.Build, stellarVectorsBuildCount)
	require.Len(t, doc.Requests, stellarVectorsRequestsCount)
}

func TestStellarConformanceVerify(t *testing.T) {
	for _, v := range loadStellarVectors(t).Verify {
		t.Run(v.Name, func(t *testing.T) {
			adapter, err := GetChainAdapter(v.Source.Network)
			require.NoError(t, err)
			var got error
			switch v.Call {
			case "recoverSigner":
				var signer string
				signer, got = adapter.RecoverSigner(v.Signed, v.Source)
				if got == nil {
					require.Equal(t, "signer", v.Expect.Kind)
					require.Equal(t, v.Expect.Signer, signer)
					return
				}
			case "recoverAndVerify":
				var r VerifiedSenderAuth
				r, got = adapter.RecoverAndVerify(v.Signed, v.Source, v.Commitment, v.Expected)
				if got == nil {
					require.Equal(t, "accept", v.Expect.Kind)
					require.Equal(t, v.Expect.Amount, r.Amount)
					require.Equal(t, v.Expect.DeadlineSec, r.DeadlineSec)
					require.Equal(t, v.Expect.DelegateSigner, r.Permit.DelegateSigner)
					require.Equal(t, v.Expect.DelegateOnchainUnverified, r.Permit.DelegateOnchainUnverified)
					require.Equal(t, v.Expect.DelegateEpoch, r.Permit.DelegateEpoch)
					return
				}
			default:
				t.Fatalf("unknown call %q", v.Call)
			}
			require.Error(t, got, "the vector expects %s", v.Expect.Kind)
			switch v.Expect.Kind {
			case "RecoveryFailed":
				require.ErrorIs(t, got, ErrRecoveryFailed)
			case "SignerMismatch":
				require.ErrorIs(t, got, ErrSignerMismatch)
			case "DelegateUnverified":
				require.ErrorIs(t, got, ErrDelegateUnverified)
				require.NotErrorIs(t, got, ErrSignerMismatch)
				require.NotErrorIs(t, got, ErrRecoveryFailed)
			case "Commitment", "MalformedPrehash":
				var ce *CommitmentError
				require.True(t, errors.As(got, &ce), "want a commitment refusal, got %v", got)
				require.Equal(t, v.Expect.Outcome, ce.Result.Outcome)
				require.Equal(t, v.Expect.Detail, ce.Result.Detail)
				if v.Expect.Kind == "MalformedPrehash" {
					require.ErrorIs(t, got, ErrMalformedPrehash)
				} else {
					require.NotErrorIs(t, got, ErrMalformedPrehash)
				}
			case "Rejected":
				require.ErrorContains(t, got, v.Expect.MessageContains)
				var ce *CommitmentError
				require.False(t, errors.As(got, &ce), "a generic rejection is not a commitment refusal: %v", got)
			default:
				t.Fatalf("the vector expects %q but the call failed with %v", v.Expect.Kind, got)
			}
		})
	}
}

func TestStellarConformanceBuild(t *testing.T) {
	for _, v := range loadStellarVectors(t).Build {
		t.Run(v.Name, func(t *testing.T) {
			p := BuildParams{
				SourceAsset:        v.Input.SourceAsset,
				Depositor:          v.Input.Depositor,
				MaxSourceAmount:    v.Input.MaxSourceAmount,
				QuoteSourceAmount:  v.Input.QuoteSourceAmount,
				RequestID:          v.Input.RequestID,
				DestinationAsset:   v.Input.DestinationAsset,
				DestinationAccount: v.Input.DestinationAccount,
				SourceDefaults:     v.Input.SourceDefaults,
				IssuedAt:           v.Input.IssuedAt,
			}
			if v.Input.Nonce != nil {
				// The text is read by the SDK's own parser, which refuses what the TS builder refuses.
				n, err := ParseStellarNonce(*v.Input.Nonce)
				if err != nil {
					require.ErrorContains(t, err, v.ErrorContains)
					return
				}
				p.Nonce = n
			}
			if v.Input.DelegateEpoch != nil {
				epoch, err := ParseStellarEpoch(*v.Input.DelegateEpoch)
				if err != nil {
					require.ErrorContains(t, err, v.ErrorContains)
					return
				}
				p.DelegateEpoch = &epoch
			}
			if v.Input.Deadline != nil {
				p.Deadline = new(big.Int).SetUint64(*v.Input.Deadline)
			}
			res, err := stellarAdapter{}.BuildAuthMessage(p)
			if v.ErrorContains != "" {
				require.ErrorContains(t, err, v.ErrorContains)
				return
			}
			require.NoError(t, err)
			require.Equal(t, SenderAuthMessageScheme("STELLAR"), res.MessageScheme)
			require.Equal(t, v.MessageHash, res.MessageHash)
			require.Equal(t, v.MessagePrehash, res.MessagePrehash, "the prehash is byte-identical to the TS builder's")
		})
	}
}

func TestStellarConformanceRequests(t *testing.T) {
	for _, v := range loadStellarVectors(t).Requests {
		t.Run(v.Name, func(t *testing.T) {
			r, err := VerifyPaymentRequestJSON([]byte(v.Request), VerifyPaymentRequestExpectations{
				Expectations: Expectations{
					EscrowContract: v.Expected.EscrowContract,
					Reserver:       v.Expected.Reserver,
					Releaser:       v.Expected.Releaser,
				},
			})
			if v.Expect.DelegateUnverified {
				require.ErrorIs(t, err, ErrDelegateUnverified)
				return
			}
			if v.Expect.Outcome == "" {
				require.NoError(t, err)
				require.Equal(t, v.Expect.Amount, r.Results[0].Amount)
				return
			}
			requireCommitmentOutcome(t, err, v.Expect.Outcome)
		})
	}
}

// The commitment-only path (VerifyRequestCommitment) reads the record on its own, so it needs its own
// proof that a member spelled two ways is refused with that reason, not merely as an unreadable record.
func TestStellarCommitmentPathRefusesAMemberSpelledTwice(t *testing.T) {
	for _, v := range loadStellarVectors(t).Requests {
		if v.Name != "honest-request" {
			continue
		}
		var body map[string]any
		require.NoError(t, json.Unmarshal([]byte(v.Request), &body))
		signed := body["sender_auth"].(map[string]any)["signed_messages"].([]any)[0].(map[string]any)
		for _, extra := range []string{`,"issuedAt":"1"`, `,"paymentId":"0x00"`} {
			prehash := signed["message_prehash"].(string)
			tampered := map[string]any{}
			for k, val := range signed {
				tampered[k] = val
			}
			tampered["message_prehash"] = prehash[:len(prehash)-1] + extra + "}"
			body["sender_auth"].(map[string]any)["signed_messages"] = []any{tampered}
			raw, err := json.Marshal(body)
			require.NoError(t, err)
			_, err = VerifyRequestCommitment(raw, nil, WithStellarEscrow(v.Expected.EscrowContract))
			requireCommitmentOutcome(t, err, OutcomePrehashMismatch)
			result, _ := CommitmentResultOf(err)
			require.Equal(t, "message_prehash spells one member two ways", result.Detail, extra)
		}
		return
	}
	t.Fatal("no honest-request vector")
}
