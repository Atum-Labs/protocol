package stellar_escrow_encoding

import (
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// guardCase mirrors one entry of ../../../../conformance/guard-vectors.json.
type guardCase struct {
	Fn      string `json:"fn"`
	Field   string `json:"field"`
	Input   string `json:"input"`
	Error   string `json:"error"`
	GoError string `json:"goError"`
}

// TestGuardParity asserts which guard fires for each rejection case in the shared fixture, and fails
// when the fixture lists a case this file does not exercise.
//
// The conformance vectors compare digest bytes, so a guard present in one binding and absent in the
// other passes them both. This is the half that catches that: add a case to guard-vectors.json and both
// languages go red until each one asserts it.
func TestGuardParity(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "conformance", "guard-vectors.json"))
	if err != nil {
		t.Fatalf("read guard vectors: %v", err)
	}
	var fixture struct {
		Cases []guardCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("parse guard vectors: %v", err)
	}
	if len(fixture.Cases) == 0 {
		t.Fatal("guard fixture is empty, so this test proves nothing")
	}

	domain := validDomain(t)
	rejected := loadVectors(t).RejectedAddresses
	validStrkey := validAddr(0xe1).String()
	two127 := new(big.Int).Lsh(big.NewInt(1), 127)

	deposit := func(mutate func(*EscrowDepositParams)) func() error {
		return func() error {
			p := validDepositParams()
			mutate(&p)
			_, err := ComputeDepositHash(p, domain)
			return err
		}
	}
	reserve := func(mutate func(*EscrowReserveParams)) func() error {
		return func() error {
			p := validReserveParams()
			mutate(&p)
			_, err := ComputeReserveHash(p, domain)
			return err
		}
	}
	settle := func(compute func(EscrowSettlementParams, EscrowDomain) ([32]byte, error), mutate func(*EscrowSettlementParams)) func() error {
		return func() error {
			p := validSettlementParams()
			mutate(&p)
			_, err := compute(p, domain)
			return err
		}
	}
	parse := func(s string) func() error {
		return func() error { _, err := ParseAddress(s); return err }
	}

	// One entry per fixture case. A case with no entry here fails the coverage check below.
	triggers := map[string]func() error{
		"escrowDomainPrefixBytes/networkId/zero": func() error {
			d := domain
			d.NetworkID = [32]byte{}
			_, err := EscrowDomainPrefixBytes(d)
			return err
		},
		"escrowDomainPrefixBytes/contractId/zero": func() error {
			d := domain
			d.ContractID = [32]byte{}
			_, err := EscrowDomainPrefixBytes(d)
			return err
		},
		"newEscrowDomain/networkPassphrase/empty": func() error {
			_, err := NewEscrowDomain("", validAddr(0xc0))
			return err
		},
		"newEscrowDomain/escrow/notContract": func() error {
			_, err := NewEscrowDomain(PassphraseTestnet, NewAccountAddress([32]byte{0xc0}))
			return err
		},
		"newEscrowDomain/escrow/zero": func() error {
			_, err := NewEscrowDomain(PassphraseTestnet, NewContractAddress([32]byte{}))
			return err
		},
		"computeDepositHash/reserver/zero":           deposit(func(p *EscrowDepositParams) { p.Reserver = Pubkey{} }),
		"computeDepositHash/releaser/zero":           deposit(func(p *EscrowDepositParams) { p.Releaser = Pubkey{} }),
		"computeDepositHash/depositRequestHash/zero": deposit(func(p *EscrowDepositParams) { p.DepositRequestHash = [32]byte{} }),
		"computeDepositHash/destination/empty":       deposit(func(p *EscrowDepositParams) { p.Destination = "" }),
		"computeDepositHash/destination/tooLong":     deposit(func(p *EscrowDepositParams) { p.Destination = strings.Repeat("d", 257) }),
		// 129 two-byte characters: 129 runes but 258 bytes, so only a byte count rejects it
		"computeDepositHash/destination/tooLongMultibyte": deposit(func(p *EscrowDepositParams) { p.Destination = strings.Repeat("é", 129) }),
		"computeDepositHash/amount/zero":                  deposit(func(p *EscrowDepositParams) { p.Amount = big.NewInt(0) }),
		"computeDepositHash/amount/negative":              deposit(func(p *EscrowDepositParams) { p.Amount = big.NewInt(-1) }),
		"computeDepositHash/amount/overI128":              deposit(func(p *EscrowDepositParams) { p.Amount = two127 }),
		"computeDepositHash/issuedAt/afterDeadline": deposit(func(p *EscrowDepositParams) {
			p.IssuedAt, p.Deadline = 11, 10
		}),
		"computeDepositHash/deadline/windowTooLong": deposit(func(p *EscrowDepositParams) {
			p.IssuedAt, p.Deadline = 10, 10+MaxDepositValiditySecs+1
		}),
		"computeReserveHash/depositId/zero":        reserve(func(p *EscrowReserveParams) { p.DepositID = [32]byte{} }),
		"computeReserveHash/quoteHash/zero":        reserve(func(p *EscrowReserveParams) { p.QuoteHash = [32]byte{} }),
		"computeReserveHash/sourceAmount/zero":     reserve(func(p *EscrowReserveParams) { p.SourceAmount = big.NewInt(0) }),
		"computeReserveHash/sourceAmount/negative": reserve(func(p *EscrowReserveParams) { p.SourceAmount = big.NewInt(-1) }),
		"computeReserveHash/sourceAmount/overI128": reserve(func(p *EscrowReserveParams) { p.SourceAmount = two127 }),
		"checkSourceAmount/sourceAmount/aboveCeiling": func() error {
			return CheckSourceAmount(big.NewInt(10), big.NewInt(11))
		},
		"checkSourceAmount/sourceAmount/zero": func() error {
			return CheckSourceAmount(big.NewInt(10), big.NewInt(0))
		},
		"computeReleaseHash/quoteHash/zero":  settle(ComputeReleaseHash, func(p *EscrowSettlementParams) { p.QuoteHash = [32]byte{} }),
		"computeReleaseHash/depositId/zero":  settle(ComputeReleaseHash, func(p *EscrowSettlementParams) { p.DepositID = [32]byte{} }),
		"computeReleaseHash/amount/negative": settle(ComputeReleaseHash, func(p *EscrowSettlementParams) { p.Amount = big.NewInt(-1) }),
		"computeReleaseHash/feeAmount/overI128": settle(ComputeReleaseHash, func(p *EscrowSettlementParams) {
			p.FeeAmount = two127
		}),
		"computeRefundHash/quoteHash/zero":           settle(ComputeRefundHash, func(p *EscrowSettlementParams) { p.QuoteHash = [32]byte{} }),
		"computeRefundHash/depositId/zero":           settle(ComputeRefundHash, func(p *EscrowSettlementParams) { p.DepositID = [32]byte{} }),
		"parseAddress/strkey/muxed":                  parse(rejected["muxed"]),
		"parseAddress/strkey/claimableBalance":       parse(rejected["claimableBalance"]),
		"parseAddress/strkey/secretSeed":             parse(rejected["secretSeed"]),
		"parseAddress/strkey/badChecksum":            parse(validStrkey[:len(validStrkey)-1] + "A"),
		"parseAddress/strkey/lowercase":              parse(strings.ToLower(validStrkey)),
		"parseAddress/strkey/truncated":              parse(validStrkey[:len(validStrkey)-2]),
		"computeDepositHash/destination/invalidUtf8": deposit(func(p *EscrowDepositParams) { p.Destination = "ab\xffcd" }),
		// Go's base32 decoder silently skips \r and \n, so only the canonical re-encode check rejects these
		"parseAddress/strkey/embeddedNewline":        parse(validStrkey[:10] + "\n" + validStrkey[10:]),
		"parseAddress/strkey/embeddedCarriageReturn": parse(validStrkey[:10] + "\r" + validStrkey[10:]),
		"parseAddress/strkey/trailingNewline":        parse(validStrkey + "\n"),
		"parseAddress/strkey/empty":                  parse(""),
		"pubkeyFromStrkey/strkey/contract":           func() error { _, err := PubkeyFromStrkey(validStrkey); return err },
		"pubkeyFromHex/hex/oddLength":                func() error { _, err := PubkeyFromHex("abc"); return err },
		"pubkeyFromHex/hex/wrongLength":              func() error { _, err := PubkeyFromHex("abcd"); return err },
	}

	sentinels := map[string]error{
		"ErrInvalidEscrowDomain":    ErrInvalidEscrowDomain,
		"ErrZeroDepositRequestHash": ErrZeroDepositRequestHash,
		"ErrEmptyDestination":       ErrEmptyDestination,
		"ErrDestinationTooLong":     ErrDestinationTooLong,
		"ErrInvalidDestination":     ErrInvalidDestination,
		"ErrZeroReserver":           ErrZeroReserver,
		"ErrZeroReleaser":           ErrZeroReleaser,
		"ErrZeroAmount":             ErrZeroAmount,
		"ErrZeroSourceAmount":       ErrZeroSourceAmount,
		"ErrInvalidSourceAmount":    ErrInvalidSourceAmount,
		"ErrAmountOutOfRange":       ErrAmountOutOfRange,
		"ErrZeroDepositID":          ErrZeroDepositID,
		"ErrZeroQuoteHash":          ErrZeroQuoteHash,
		"ErrInconsistentTimestamps": ErrInconsistentTimestamps,
		"ErrDeadlineTooFarInFuture": ErrDeadlineTooFarInFuture,
		"ErrInvalidStrkey":          ErrInvalidStrkey,
		"ErrUnsupportedAddress":     ErrUnsupportedAddress,
		"ErrInvalidPubkeyLength":    ErrInvalidPubkeyLength,
		"ErrInvalidHex":             ErrInvalidHex,
	}

	seen := map[string]bool{}
	for _, c := range fixture.Cases {
		key := c.Fn + "/" + c.Field + "/" + c.Input
		seen[key] = true
		// A case Go cannot express (a fixed-size array makes the check structural) is recorded in the
		// fixture with an "n/a" note rather than silently skipped.
		if strings.HasPrefix(c.GoError, "n/a") {
			continue
		}
		trigger, ok := triggers[key]
		if !ok {
			t.Errorf("guard-vectors.json lists %q but this test does not exercise it", key)
			continue
		}
		want, ok := sentinels[c.GoError]
		if !ok {
			t.Errorf("case %q names unknown Go sentinel %q", key, c.GoError)
			continue
		}
		got := trigger()
		if got == nil {
			t.Errorf("case %q: expected a rejection, got nil", key)
			continue
		}
		if !errors.Is(got, want) {
			t.Errorf("case %q: got %v, want errors.Is(_, %s)", key, got, c.GoError)
		}
	}
	// The other direction: a guard this file exercises but the fixture does not list would be a Go-only
	// guard, which TypeScript would never be asked to mirror.
	for key := range triggers {
		if !seen[key] {
			t.Errorf("this test exercises %q but guard-vectors.json does not list it, so TypeScript is not held to it", key)
		}
	}
}

func validAddr(seed byte) Address {
	var k [32]byte
	for i := range k {
		k[i] = seed
	}
	return NewContractAddress(k)
}

func validDomain(t *testing.T) EscrowDomain {
	t.Helper()
	d, err := NewEscrowDomain(PassphraseTestnet, validAddr(0xc0))
	if err != nil {
		t.Fatalf("build reference domain: %v", err)
	}
	return d
}

func validDepositParams() EscrowDepositParams {
	return EscrowDepositParams{
		DepositRequestHash: [32]byte{1},
		Destination:        "dest",
		Depositor:          NewAccountAddress([32]byte{2}),
		Token:              validAddr(3),
		Epoch:              1,
		Amount:             big.NewInt(10),
		Reserver:           Pubkey{4},
		Releaser:           Pubkey{5},
		Nonce:              1,
		IssuedAt:           1,
		Deadline:           2,
	}
}

func validReserveParams() EscrowReserveParams {
	return EscrowReserveParams{
		DepositID:    [32]byte{7},
		QuoteHash:    [32]byte{8},
		Settler:      NewAccountAddress([32]byte{6}),
		SourceAmount: big.NewInt(5),
	}
}

func validSettlementParams() EscrowSettlementParams {
	return EscrowSettlementParams{
		DepositID: [32]byte{7},
		EscrowActiveDeposit: EscrowActiveDeposit{
			Depositor:          NewAccountAddress([32]byte{2}),
			QuoteHash:          [32]byte{8},
			DepositRequestHash: [32]byte{1},
			DestinationHash:    [32]byte{9},
			Token:              validAddr(3),
			Amount:             big.NewInt(5),
			FeeAmount:          big.NewInt(1),
			Reserver:           Pubkey{4},
			Releaser:           Pubkey{5},
			Settler:            NewAccountAddress([32]byte{6}),
		},
	}
}
