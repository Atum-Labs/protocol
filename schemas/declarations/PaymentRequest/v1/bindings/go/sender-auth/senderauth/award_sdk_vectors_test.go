package senderauth

import (
	"bytes"
	"context"
	"encoding/json"
	"math/big"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	evmencoding "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/encoding"
	svm "github.com/atum-labs/protocol/contracts/svm/bindings/go/escrow-encoding/encoding"
	tvmencoding "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/encoding"
)

// awardSDKVector is one row of PaymentRequest/v1/conformance/award-sdk-vectors.json: an award the
// TypeScript SDK built, which this verifier must accept, and its tampered reserves, which it must
// refuse for the same reasons the TypeScript verifier gives.
type awardSDKVector struct {
	Name                      string          `json:"name"`
	Route                     string          `json:"route"`
	Defaults                  json.RawMessage `json:"defaults"`
	DepositRequestHashVersion int             `json:"depositRequestHashVersion"`
	QuoteRequestID            string          `json:"quoteRequestId"`
	QuoteRequest              json.RawMessage `json:"quoteRequest"`
	Quote                     json.RawMessage `json:"quote"`
	Award                     json.RawMessage `json:"award"`
	PaymentID                 string          `json:"paymentId"`
	Reserve                   struct {
		Expected       ReserveAuthExpectations `json:"expected"`
		Message        string                  `json:"message"`
		MessagePrehash string                  `json:"message_prehash"`
	} `json:"reserve"`
	Tampered []struct {
		Field       string            `json:"field"`
		ReserveAuth ReserveAuth       `json:"reserve_auth"`
		Reason      ReserveAuthReason `json:"reason"`
	} `json:"tampered"`
	ContractReserverOwner string `json:"contractReserverOwner"`
}

// awardSDKBody is the part of the award body these tests read.
type awardSDKBody struct {
	SenderAuth struct {
		SignedMessages []struct {
			Message        string `json:"message"`
			MessagePrehash string `json:"message_prehash"`
			Signature      string `json:"signature"`
		} `json:"signed_messages"`
	} `json:"sender_auth"`
	ReserveAuth ReserveAuth `json:"reserve_auth"`
}

func readAwardSDKVectors(t *testing.T) []awardSDKVector {
	t.Helper()
	raw, err := os.ReadFile(conformancePath("award-sdk-vectors.json"))
	require.NoError(t, err)
	var file struct {
		Comment string           `json:"_comment"`
		Vectors []awardSDKVector `json:"vectors"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	require.NoError(t, dec.Decode(&file))
	require.NotEmpty(t, file.Vectors)
	return file.Vectors
}

func (v awardSDKVector) body(t *testing.T) awardSDKBody {
	t.Helper()
	var b awardSDKBody
	require.NoError(t, json.Unmarshal(v.Award, &b))
	require.Len(t, b.SenderAuth.SignedMessages, 1)
	return b
}

// checker answers as the reserver's chain would: no code for an EOA, the ERC-1271 magic value for
// the contract reserver.
func (v awardSDKVector) checker() *fakeChecker {
	if v.Route != "contract-selector" {
		return &fakeChecker{}
	}
	chain := fakeChain{Code: "0x01"}
	chain.IsValidSignature = &struct {
		ReturnData string `json:"returnData"`
		Reverts    bool   `json:"reverts"`
		OnlyCaller string `json:"onlyCaller"`
	}{ReturnData: hexutil.Encode(erc1271MagicWord)}
	return &fakeChecker{chain: chain}
}

func TestAwardSDKVectors_ReserveVerifies(t *testing.T) {
	for _, v := range readAwardSDKVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			auth := v.body(t).ReserveAuth
			require.Equal(t, v.Reserve.Message, auth.Message)
			require.Equal(t, v.Reserve.MessagePrehash, auth.MessagePrehash)
			require.Equal(t, v.PaymentID, v.Reserve.Expected.DepositID)

			checker := v.checker()
			got := VerifyReserveAuth(context.Background(), auth, v.Reserve.Expected, checker)
			require.Equal(t, ReserveReasonVerified, got.Reason, got.Detail)
			if v.Route != "contract-selector" {
				assert.Equal(t, PathEOA, got.Path)
				return
			}
			assert.Equal(t, PathContract, got.Path)
			// The wallet is asked about the digest the SDK signed, by the escrow.
			var asked []checkerCall
			for _, c := range checker.calls {
				if c.Method == "isValidSignatureFrom" {
					asked = append(asked, c)
				}
			}
			require.Len(t, asked, 1)
			assert.Equal(t, strings.ToLower(v.Reserve.Message), asked[0].Digest)
			assert.Equal(t, strings.ToLower(auth.Signature), asked[0].Signature)
			assert.True(t, strings.EqualFold(v.Reserve.Expected.Reserver, asked[0].Account))
			assert.True(t, strings.EqualFold(v.Reserve.Expected.EscrowContract, asked[0].Caller))
		})
	}
}

func TestAwardSDKVectors_TamperedReserveRefused(t *testing.T) {
	for _, v := range readAwardSDKVectors(t) {
		require.Len(t, v.Tampered, 2, v.Name)
		for _, tampered := range v.Tampered {
			t.Run(v.Name+"/"+tampered.Field, func(t *testing.T) {
				got := VerifyReserveAuth(context.Background(), tampered.ReserveAuth, v.Reserve.Expected, v.checker())
				assert.False(t, got.Valid)
				assert.Equal(t, tampered.Reason, got.Reason, got.Detail)
			})
		}
	}
}

// awardSDKClock is the clock the fixture was built at (2026-06-01T00:00:00Z).
const awardSDKClock = 1780272000

// The award's sender_auth verifies as a gateway verifies it: for the quote's amount, with the
// quote request's escrow, the reserve's signer as reserver and the fulfillment verifier as
// releaser, so a deposit whose roles do not match the reserve is refused.
func TestAwardSDKVectors_SenderAuthVerifies(t *testing.T) {
	for _, v := range readAwardSDKVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			var quoteRequest struct {
				Source struct {
					Account string `json:"account"`
				} `json:"source"`
				EscrowContractAddress string `json:"escrow_contract_address"`
				FulfillmentVerifier   struct {
					Account string `json:"account"`
				} `json:"fulfillment_verifier"`
			}
			require.NoError(t, json.Unmarshal(v.QuoteRequest, &quoteRequest))
			var quote struct {
				FulfillmentQuote struct {
					SourceAmount string `json:"source_amount"`
				} `json:"fulfillment_quote"`
			}
			require.NoError(t, json.Unmarshal(v.Quote, &quote))
			var defaults struct {
				SvmSignatureClusterID     string `json:"svm_signature_cluster_id"`
				SvmSignatureDomainVersion *int   `json:"svm_signature_domain_version"`
			}
			require.NoError(t, json.Unmarshal(v.Defaults, &defaults))
			var award struct {
				SenderAuth json.RawMessage `json:"sender_auth"`
			}
			require.NoError(t, json.Unmarshal(v.Award, &award))

			request := map[string]json.RawMessage{}
			require.NoError(t, json.Unmarshal(v.QuoteRequest, &request))
			request["sender_auth"] = award.SenderAuth
			raw, err := json.Marshal(request)
			require.NoError(t, err)

			now := awardSDKClock
			got, err := VerifyPaymentRequestJSON(raw, VerifyPaymentRequestExpectations{
				Expectations: Expectations{
					QuoteSourceAmount:         quote.FulfillmentQuote.SourceAmount,
					EscrowContract:            quoteRequest.EscrowContractAddress,
					Reserver:                  v.Reserve.Expected.Reserver,
					Releaser:                  quoteRequest.FulfillmentVerifier.Account,
					SvmSignatureClusterID:     defaults.SvmSignatureClusterID,
					SvmSignatureDomainVersion: defaults.SvmSignatureDomainVersion,
					NowSec:                    &now,
				},
				DepositRequestHashV2Mode: DepositRequestHashV2Enforce,
			})
			require.NoError(t, err)
			assert.Equal(t, quoteRequest.Source.Account, got.RecoveredAccount)
		})
	}
}

// solanaAwardDepositHash is the escrow's deposit hash for a Solana award's signed record, under the
// signature domain the reserve names.
func solanaAwardDepositHash(t *testing.T, prehashJSON string, expected ReserveAuthExpectations) [32]byte {
	t.Helper()
	prehash, err := svm.ParseSolanaDepositPrehashV2(prehashJSON)
	require.NoError(t, err)
	number := func(s string) uint64 {
		n, err := strconv.ParseUint(s, 10, 64)
		require.NoError(t, err)
		return n
	}
	requestHash, err := hexutil.Decode(prehash.DepositRequestHash)
	require.NoError(t, err)
	require.Len(t, requestHash, 32)
	params := svm.EscrowDepositParams{
		DepositRequestHash: [32]byte(requestHash),
		Depositor:          svm.MustPubkeyFromBase58(prehash.Depositor),
		Mint:               svm.MustPubkeyFromBase58(prehash.Mint),
		Amount:             number(prehash.Amount),
		Reserver:           svm.MustPubkeyFromBase58(prehash.Reserver),
		Releaser:           svm.MustPubkeyFromBase58(prehash.Releaser),
		Nonce:              number(prehash.Nonce),
		IssuedAt:           number(prehash.IssuedAt),
		Deadline:           number(prehash.Deadline),
	}
	require.NotNil(t, expected.SvmSignatureDomainVersion)
	domain, err := svm.NewEscrowDomain(
		expected.SvmSignatureClusterID,
		uint8(*expected.SvmSignatureDomainVersion),
		svm.MustPubkeyFromBase58(expected.EscrowContract),
	)
	require.NoError(t, err)
	hash, err := svm.ComputeDepositHashV2(params, prehash.Destination, domain)
	require.NoError(t, err)
	return hash
}

// The deposit id the reserve binds is the escrow's id for the deposit the award signs.
func TestAwardSDKVectors_PaymentIDIsTheDepositID(t *testing.T) {
	for _, v := range readAwardSDKVectors(t) {
		t.Run(v.Name, func(t *testing.T) {
			deposit := v.body(t).SenderAuth.SignedMessages[0]
			namespace, _, _ := strings.Cut(v.Reserve.Expected.Network, ":")
			if namespace == "solana" {
				assert.Equal(t, strings.ToLower(deposit.Message), v.PaymentID)
				id := solanaAwardDepositHash(t, deposit.MessagePrehash, v.Reserve.Expected)
				assert.Equal(t, v.PaymentID, hexutil.Encode(id[:]))
				return
			}
			var quoteRequest struct {
				Source struct {
					Account string `json:"account"`
				} `json:"source"`
			}
			require.NoError(t, json.Unmarshal(v.QuoteRequest, &quoteRequest))
			var permit struct {
				Message struct {
					Nonce string `json:"nonce"`
				} `json:"message"`
			}
			require.NoError(t, json.Unmarshal([]byte(deposit.MessagePrehash), &permit))
			nonce, ok := new(big.Int).SetString(permit.Message.Nonce, 10)
			require.True(t, ok)
			signature, err := hexutil.Decode(deposit.Signature)
			require.NoError(t, err)

			var id []byte
			if namespace == "tron" {
				id, err = tvmencoding.NewEscrowPaymentIdEncoder().Digest(quoteRequest.Source.Account, signature, nonce)
			} else {
				id, err = evmencoding.NewEscrowPaymentIdEncoder().Digest(common.HexToAddress(quoteRequest.Source.Account), signature, nonce)
			}
			require.NoError(t, err)
			assert.Equal(t, v.PaymentID, hexutil.Encode(id))
		})
	}
}
