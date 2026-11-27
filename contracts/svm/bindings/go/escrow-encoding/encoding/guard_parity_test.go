package svm_escrow_encoding

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// guardCase mirrors one entry of ../guard-vectors.json.
type guardCase struct {
	Fn      string `json:"fn"`
	Field   string `json:"field"`
	Input   string `json:"input"`
	Error   string `json:"error"`
	GoError string `json:"goError"`
}

// TestGuardParity asserts which guard fires for each rejection case in the shared fixture, and
// fails when the fixture lists a case this file does not exercise.
//
// The parity-golden tests compare hash bytes, so a guard present in one binding and absent in the
// other passed them both. This is the half that catches that: add a case to guard-vectors.json and
// both languages go red until each one asserts it.
func TestGuardParity(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "conformance", "guard-vectors.json")
	raw, err := os.ReadFile(path)
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

	validDomain, err := NewEscrowDomain("localnet", 3, mustPubkey(t, 1))
	if err != nil {
		t.Fatalf("build reference domain: %v", err)
	}

	// One entry per fixture case. A case with no entry here fails the coverage check below.
	triggers := map[string]func() error{
		"escrowDomainPrefixBytes/signatureDomainVersion/zero": func() error {
			d := validDomain
			d.SignatureDomainVersion = 0
			_, err := EscrowDomainPrefixBytes(d)
			return err
		},
		"escrowDomainPrefixBytes/programId/zero": func() error {
			d := validDomain
			d.ProgramID = Pubkey{}
			_, err := EscrowDomainPrefixBytes(d)
			return err
		},
		"newEscrowDomain/clusterName/empty": func() error {
			_, err := NewEscrowDomain("  ", 3, mustPubkey(t, 1))
			return err
		},
		"newEscrowDomain/clusterName/tooLong": func() error {
			_, err := NewEscrowDomain(strings.Repeat("x", 33), 3, mustPubkey(t, 1))
			return err
		},
		"newEscrowDomain/signatureDomainVersion/zero": func() error {
			_, err := NewEscrowDomain("localnet", 0, mustPubkey(t, 1))
			return err
		},
		"newEscrowDomain/programId/zero": func() error {
			_, err := NewEscrowDomain("localnet", 3, Pubkey{})
			return err
		},
		"computeDepositHash/depositRequestHash/zero": func() error {
			return depositHashErr(t, validDomain, func(p *EscrowDepositParams) { p.DepositRequestHash = [32]byte{} })
		},
		"computeDepositHash/depositor/zero": func() error {
			return depositHashErr(t, validDomain, func(p *EscrowDepositParams) { p.Depositor = Pubkey{} })
		},
		"computeDepositHash/mint/zero": func() error {
			return depositHashErr(t, validDomain, func(p *EscrowDepositParams) { p.Mint = Pubkey{} })
		},
		"computeDepositHash/amount/zero": func() error {
			return depositHashErr(t, validDomain, func(p *EscrowDepositParams) { p.Amount = 0 })
		},
		"computeDepositHash/reserver/zero": func() error {
			return depositHashErr(t, validDomain, func(p *EscrowDepositParams) { p.Reserver = Pubkey{} })
		},
		"computeDepositHash/releaser/zero": func() error {
			return depositHashErr(t, validDomain, func(p *EscrowDepositParams) { p.Releaser = Pubkey{} })
		},
		"computeDepositHash/destination/empty": func() error {
			p := validDepositParams(t)
			_, err := ComputeDepositHashV2(p, "", validDomain)
			return err
		},
		"computeDepositHash/destination/tooLong": func() error {
			p := validDepositParams(t)
			_, err := ComputeDepositHashV2(p, strings.Repeat("d", 257), validDomain)
			return err
		},
		"computeReserveHash/depositHash/zero": func() error {
			_, err := ComputeReserveHash(EscrowReserveParams{Recipient: mustPubkey(t, 6)}, validDomain)
			return err
		},
		"computeReserveHash/recipient/zero": func() error {
			_, err := ComputeReserveHash(
				EscrowReserveParams{DepositHash: [32]byte{7}},
				validDomain,
			)
			return err
		},
		"computeReserveHash/quoteHash/zero": func() error {
			_, err := ComputeReserveHashV2(validReserveParams(t), [32]byte{}, validDomain)
			return err
		},
		"computeReserveHash/sourceAmount/zero": func() error {
			_, err := ComputeReserveHashV3(validReserveParams(t), [32]byte{9}, 0, validDomain)
			return err
		},
		"pubkeyFromHex/hex/oddLength": func() error {
			_, err := PubkeyFromHex("abc")
			return err
		},
	}

	sentinels := map[string]error{
		"ErrInvalidEscrowDomain":    ErrInvalidEscrowDomain,
		"ErrZeroDepositRequestHash": ErrZeroDepositRequestHash,
		"ErrZeroDepositor":          ErrZeroDepositor,
		"ErrZeroMint":               ErrZeroMint,
		"ErrZeroAmount":             ErrZeroAmount,
		"ErrZeroReserver":           ErrZeroReserver,
		"ErrZeroReleaser":           ErrZeroReleaser,
		"ErrZeroRecipient":          ErrZeroRecipient,
		"ErrZeroDepositHash":        ErrZeroDepositHash,
		"ErrZeroQuoteHash":          ErrZeroQuoteHash,
		"ErrZeroSourceAmount":       ErrZeroSourceAmount,
		"ErrEmptyDestination":       ErrEmptyDestination,
		"ErrDestinationTooLong":     ErrDestinationTooLong,
		"ErrInvalidHex":             ErrInvalidHex,
	}

	for _, c := range fixture.Cases {
		key := c.Fn + "/" + c.Field + "/" + c.Input
		// A case Go cannot express (a fixed-size array makes the check structural) is recorded in
		// the fixture with an "n/a" note rather than silently skipped.
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
}

func mustPubkey(t *testing.T, seed byte) Pubkey {
	t.Helper()
	var p Pubkey
	p[0] = seed
	return p
}

func validDepositParams(t *testing.T) EscrowDepositParams {
	t.Helper()
	return EscrowDepositParams{
		DepositRequestHash: [32]byte{1},
		Depositor:          mustPubkey(t, 2),
		Mint:               mustPubkey(t, 3),
		Amount:             1,
		Reserver:           mustPubkey(t, 4),
		Releaser:           mustPubkey(t, 5),
		Nonce:              1,
		IssuedAt:           1,
		Deadline:           2,
	}
}

func depositHashErr(t *testing.T, d EscrowDomain, mutate func(*EscrowDepositParams)) error {
	t.Helper()
	p := validDepositParams(t)
	mutate(&p)
	_, err := ComputeDepositHash(p, d)
	return err
}

func validReserveParams(t *testing.T) EscrowReserveParams {
	t.Helper()
	return EscrowReserveParams{DepositHash: [32]byte{7}, Recipient: mustPubkey(t, 6)}
}
