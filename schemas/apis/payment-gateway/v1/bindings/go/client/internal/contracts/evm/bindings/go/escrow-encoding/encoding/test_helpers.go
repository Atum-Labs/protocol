package encoding

import (
	"encoding/json"
	"math/big"
	"os"
	"testing"

	"github.com/ethereum/go-ethereum/common"
)

// Raw JSON structures (for unmarshaling)
type rawPaymentIdExample struct {
	Depositor         string `json:"depositor"`
	Signature         string `json:"signature"`
	Nonce             int64  `json:"nonce"`
	ExpectedPaymentId string `json:"expectedPaymentId"`
}

type rawDepositExample struct {
	ChainID        int64  `json:"chainID"`
	Permit2        string `json:"permit2"`
	Token          string `json:"token"`
	Amount         string `json:"amount"`
	Nonce          int64  `json:"nonce"`
	Deadline       int64  `json:"deadline"`
	Spender        string `json:"spender"`
	Reserver       string `json:"reserver"`
	Releaser       string `json:"releaser"`
	ExpectedDigest string `json:"expectedDigest"`
}

type rawReserveExample struct {
	ChainID        int64  `json:"chainID"`
	Escrow         string `json:"escrow"`
	PaymentId      string `json:"paymentId"`
	Settler        string `json:"settler"`
	ExpectedDigest string `json:"expectedDigest"`
}

type rawReleaseExample struct {
	ChainID        int64  `json:"chainID"`
	Escrow         string `json:"escrow"`
	PaymentId      string `json:"paymentId"`
	Depositor      string `json:"depositor"`
	Token          string `json:"token"`
	Amount         string `json:"amount"`
	FeeAmount      string `json:"feeAmount"`
	Reserver       string `json:"reserver"`
	Releaser       string `json:"releaser"`
	Settler        string `json:"settler"`
	ExpectedDigest string `json:"expectedDigest"`
}

type rawRefundExample struct {
	ChainID        int64  `json:"chainID"`
	Escrow         string `json:"escrow"`
	PaymentId      string `json:"paymentId"`
	Depositor      string `json:"depositor"`
	Token          string `json:"token"`
	Amount         string `json:"amount"`
	FeeAmount      string `json:"feeAmount"`
	Reserver       string `json:"reserver"`
	Releaser       string `json:"releaser"`
	Settler        string `json:"settler"`
	ExpectedDigest string `json:"expectedDigest"`
}

type rawEncodingExamples struct {
	PaymentId []rawPaymentIdExample `json:"paymentId"`
	Deposit   []rawDepositExample   `json:"deposit"`
	Reserve   []rawReserveExample   `json:"reserve"`
	Release   []rawReleaseExample   `json:"release"`
	Refund    []rawRefundExample    `json:"refund"`
}

// Parsed structures (ready to use)

// PaymentIdExample is a payment-id vector from the shared cross-language encoding fixtures.
type PaymentIdExample struct {
	Depositor         common.Address
	Signature         []byte
	Nonce             *big.Int
	ExpectedPaymentId []byte
}

// DepositExample is a deposit vector from the shared cross-language encoding fixtures.
type DepositExample struct {
	ChainID        *big.Int
	Permit2        common.Address
	Token          common.Address
	Amount         *big.Int
	Nonce          *big.Int
	Deadline       *big.Int
	Spender        common.Address
	Reserver       common.Address
	Releaser       common.Address
	ExpectedDigest []byte
}

// ReserveExample is a reserve vector from the shared cross-language encoding fixtures.
type ReserveExample struct {
	ChainID        *big.Int
	Escrow         common.Address
	PaymentId      [32]byte
	Settler        common.Address
	ExpectedDigest []byte
}

// ReleaseExample is a release vector from the shared cross-language encoding fixtures.
type ReleaseExample struct {
	ChainID        *big.Int
	Escrow         common.Address
	PaymentId      [32]byte
	Depositor      common.Address
	Token          common.Address
	Amount         *big.Int
	FeeAmount      *big.Int
	Reserver       common.Address
	Releaser       common.Address
	Settler        common.Address
	ExpectedDigest []byte
}

// RefundExample is a refund vector from the shared cross-language encoding fixtures.
type RefundExample struct {
	ChainID        *big.Int
	Escrow         common.Address
	PaymentId      [32]byte
	Depositor      common.Address
	Token          common.Address
	Amount         *big.Int
	FeeAmount      *big.Int
	Reserver       common.Address
	Releaser       common.Address
	Settler        common.Address
	ExpectedDigest []byte
}

// EncodingExamples holds every vector in the shared cross-language encoding fixtures.
type EncodingExamples struct {
	PaymentId []PaymentIdExample
	Deposit   []DepositExample
	Reserve   []ReserveExample
	Release   []ReleaseExample
	Refund    []RefundExample
}

// LoadEncodingExamples loads and parses the frozen contract-derived digest
// examples vendored alongside the parity vectors in testdata/.
func LoadEncodingExamples(t *testing.T) *EncodingExamples {
	data, err := os.ReadFile("testdata/encoding-examples.json")
	if err != nil {
		t.Fatalf("Failed to read encoding examples: %v", err)
	}

	var raw rawEncodingExamples
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Failed to parse encoding examples: %v", err)
	}

	examples := &EncodingExamples{}

	// Parse PaymentId examples
	for _, r := range raw.PaymentId {
		examples.PaymentId = append(examples.PaymentId, PaymentIdExample{
			Depositor:         common.HexToAddress(r.Depositor),
			Signature:         common.FromHex(r.Signature),
			Nonce:             big.NewInt(r.Nonce),
			ExpectedPaymentId: common.FromHex(r.ExpectedPaymentId),
		})
	}

	// Parse Deposit examples
	for _, r := range raw.Deposit {
		amount, ok := new(big.Int).SetString(r.Amount, 10)
		if !ok {
			t.Fatalf("Failed to parse deposit amount: %s", r.Amount)
		}
		examples.Deposit = append(examples.Deposit, DepositExample{
			ChainID:        big.NewInt(r.ChainID),
			Permit2:        common.HexToAddress(r.Permit2),
			Token:          common.HexToAddress(r.Token),
			Amount:         amount,
			Nonce:          big.NewInt(r.Nonce),
			Deadline:       big.NewInt(r.Deadline),
			Spender:        common.HexToAddress(r.Spender),
			Reserver:       common.HexToAddress(r.Reserver),
			Releaser:       common.HexToAddress(r.Releaser),
			ExpectedDigest: common.FromHex(r.ExpectedDigest),
		})
	}

	// Parse Reserve examples
	for _, r := range raw.Reserve {
		var paymentId [32]byte
		copy(paymentId[:], common.FromHex(r.PaymentId))

		examples.Reserve = append(examples.Reserve, ReserveExample{
			ChainID:        big.NewInt(r.ChainID),
			Escrow:         common.HexToAddress(r.Escrow),
			PaymentId:      paymentId,
			Settler:        common.HexToAddress(r.Settler),
			ExpectedDigest: common.FromHex(r.ExpectedDigest),
		})
	}

	// Parse Release examples
	for _, r := range raw.Release {
		var paymentId [32]byte
		copy(paymentId[:], common.FromHex(r.PaymentId))

		amount, ok := new(big.Int).SetString(r.Amount, 10)
		if !ok {
			t.Fatalf("Failed to parse release amount: %s", r.Amount)
		}
		feeAmount, ok := new(big.Int).SetString(r.FeeAmount, 10)
		if !ok {
			t.Fatalf("Failed to parse release feeAmount: %s", r.FeeAmount)
		}

		examples.Release = append(examples.Release, ReleaseExample{
			ChainID:        big.NewInt(r.ChainID),
			Escrow:         common.HexToAddress(r.Escrow),
			PaymentId:      paymentId,
			Depositor:      common.HexToAddress(r.Depositor),
			Token:          common.HexToAddress(r.Token),
			Amount:         amount,
			FeeAmount:      feeAmount,
			Reserver:       common.HexToAddress(r.Reserver),
			Releaser:       common.HexToAddress(r.Releaser),
			Settler:        common.HexToAddress(r.Settler),
			ExpectedDigest: common.FromHex(r.ExpectedDigest),
		})
	}

	// Parse Refund examples
	for _, r := range raw.Refund {
		var paymentId [32]byte
		copy(paymentId[:], common.FromHex(r.PaymentId))

		amount, ok := new(big.Int).SetString(r.Amount, 10)
		if !ok {
			t.Fatalf("Failed to parse refund amount: %s", r.Amount)
		}
		feeAmount, ok := new(big.Int).SetString(r.FeeAmount, 10)
		if !ok {
			t.Fatalf("Failed to parse refund feeAmount: %s", r.FeeAmount)
		}

		examples.Refund = append(examples.Refund, RefundExample{
			ChainID:        big.NewInt(r.ChainID),
			Escrow:         common.HexToAddress(r.Escrow),
			PaymentId:      paymentId,
			Depositor:      common.HexToAddress(r.Depositor),
			Token:          common.HexToAddress(r.Token),
			Amount:         amount,
			FeeAmount:      feeAmount,
			Reserver:       common.HexToAddress(r.Reserver),
			Releaser:       common.HexToAddress(r.Releaser),
			Settler:        common.HexToAddress(r.Settler),
			ExpectedDigest: common.FromHex(r.ExpectedDigest),
		})
	}

	return examples
}
