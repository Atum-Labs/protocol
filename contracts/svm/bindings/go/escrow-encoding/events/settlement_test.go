package events

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"testing"
)

var (
	refundedFields = []string{"deposit_hash", "depositor", "amount", "quote_hash"}
	releasedFields = []string{"deposit_hash", "recipient", "gross_amount", "intended_amount",
		"surplus_amount", "fee_amount", "net_amount", "quote_hash"}
	depositedFields = []string{"deposit_hash", "depositor", "reserver", "releaser", "amount",
		"fee_amount", "nonce", "issued_at", "deadline"}
)

func TestSettlementDiscriminators_MatchTheIDL(t *testing.T) {
	idl := loadIDL(t, escrowIDLPath)
	if got, want := RefundedDiscriminator, idlDiscriminator(t, idl, "Refunded"); got != want {
		t.Errorf("RefundedDiscriminator = %x, IDL says %x", got, want)
	}
	if got, want := ReleasedDiscriminator, idlDiscriminator(t, idl, "Released"); got != want {
		t.Errorf("ReleasedDiscriminator = %x, IDL says %x", got, want)
	}
}

func TestDecodeSettlement_AgreesWithTheIDLLayout(t *testing.T) {
	idl := loadIDL(t, escrowIDLPath)
	for _, tc := range []struct {
		event  string
		fields []string
		tag    [8]byte
		length int
		kind   SettlementKind
	}{
		{"Refunded", refundedFields, RefundedDiscriminator, RefundedLen, SettlementRefunded},
		{"Released", releasedFields, ReleasedDiscriminator, ReleasedLen, SettlementReleased},
	} {
		body, want := idlBody(t, idl, tc.event, tc.fields)
		if len(body) != tc.length {
			t.Fatalf("IDL %s body is %d bytes, decoder expects %d", tc.event, len(body), tc.length)
		}
		s, err := DecodeSettlement(tagged(tc.tag, body))
		if err != nil {
			t.Fatalf("%s: DecodeSettlement: %v", tc.event, err)
		}
		if s.Kind != tc.kind {
			t.Errorf("%s: kind = %d, want %d", tc.event, s.Kind, tc.kind)
		}
		if !bytes.Equal(s.DepositHash[:], want["deposit_hash"]) {
			t.Errorf("%s: deposit_hash = %x, IDL layout puts %x there", tc.event, s.DepositHash, want["deposit_hash"])
		}
		if !bytes.Equal(s.QuoteHash[:], want["quote_hash"]) {
			t.Errorf("%s: quote_hash = %x, IDL layout puts %x there", tc.event, s.QuoteHash, want["quote_hash"])
		}
		var wantAmount uint64
		if tc.kind == SettlementRefunded {
			wantAmount = binary.LittleEndian.Uint64(want["amount"])
		}
		if s.Amount != wantAmount {
			t.Errorf("%s: amount = %d, want %d", tc.event, s.Amount, wantAmount)
		}
	}
}

func TestDecodeSettlement_RefundedAmountKeepsTheFullUint64(t *testing.T) {
	body := make([]byte, RefundedLen)
	binary.LittleEndian.PutUint64(body[64:72], math.MaxUint64)
	s, err := DecodeSettlement(tagged(RefundedDiscriminator, body))
	if err != nil || s.Amount != math.MaxUint64 {
		t.Fatalf("amount = %d, err = %v, want %d", s.Amount, err, uint64(math.MaxUint64))
	}
}

func TestDepositedDiscriminator_MatchesTheIDL(t *testing.T) {
	if got, want := DepositedDiscriminator, idlDiscriminator(t, loadIDL(t, escrowIDLPath), "Deposited"); got != want {
		t.Errorf("DepositedDiscriminator = %x, IDL says %x", got, want)
	}
}

// The pre-v4 escrow emitted the same Deposited layout, so deposits it took decode the same way.
func TestDecodeDeposited_AgreesWithTheIDLLayout(t *testing.T) {
	for _, path := range []string{escrowIDLPath, escrowPreV4IDLPath} {
		idl := loadIDL(t, path)
		if got := idlDiscriminator(t, idl, "Deposited"); got != DepositedDiscriminator {
			t.Fatalf("%s: Deposited tag %x, decoder expects %x", path, got, DepositedDiscriminator)
		}
		body, want := idlBody(t, idl, "Deposited", depositedFields)
		if len(body) != DepositedLen {
			t.Fatalf("%s: IDL Deposited body is %d bytes, decoder expects %d", path, len(body), DepositedLen)
		}
		d, err := DecodeDeposited(tagged(DepositedDiscriminator, body))
		if err != nil {
			t.Fatalf("%s: DecodeDeposited: %v", path, err)
		}
		if !bytes.Equal(d.DepositHash[:], want["deposit_hash"]) {
			t.Errorf("%s: deposit_hash = %x, IDL layout puts %x there", path, d.DepositHash, want["deposit_hash"])
		}
		if got, wantAmount := d.Amount, binary.LittleEndian.Uint64(want["amount"]); got != wantAmount {
			t.Errorf("%s: amount = %d, IDL layout puts %d there", path, got, wantAmount)
		}
	}
}

// The escrow appends fields at the end, so trailing bytes past deadline are ignored.
func TestDecodeDeposited_IgnoresTrailingBytes(t *testing.T) {
	body := make([]byte, DepositedLen+16)
	binary.LittleEndian.PutUint64(body[128:136], 1_000)
	d, err := DecodeDeposited(tagged(DepositedDiscriminator, body))
	if err != nil || d.Amount != 1_000 {
		t.Fatalf("amount = %d, err = %v, want 1000", d.Amount, err)
	}
}

func TestDecodeDeposited_RejectsAShortBodyAndOtherTags(t *testing.T) {
	for n := 0; n < DepositedLen; n++ {
		if _, err := DecodeDeposited(tagged(DepositedDiscriminator, make([]byte, n))); !errors.Is(err, ErrDepositedTruncated) {
			t.Fatalf("%d-byte body: err = %v, want ErrDepositedTruncated", n, err)
		}
	}
	for _, name := range []string{"Refunded", "Released", "Reserved"} {
		if _, err := DecodeDeposited(tagged(Discriminator(name), make([]byte, DepositedLen))); !errors.Is(err, ErrNotDeposited) {
			t.Errorf("%s: err = %v, want ErrNotDeposited", name, err)
		}
	}
	for n := 0; n < 8; n++ {
		if _, err := DecodeDeposited(DepositedDiscriminator[:n]); !errors.Is(err, ErrNotDeposited) {
			t.Errorf("%d bytes: err = %v, want ErrNotDeposited", n, err)
		}
	}
}

// The escrow appends fields at the end, so trailing bytes past quote_hash are ignored and every
// field is still read from its IDL offset.
func TestDecodeSettlement_IgnoresTrailingBytes(t *testing.T) {
	body := bytes.Repeat([]byte{0x11}, ReleasedLen+16)
	s, err := DecodeSettlement(tagged(ReleasedDiscriminator, body))
	if err != nil || s.Kind != SettlementReleased {
		t.Fatalf("kind = %d, err = %v, want SettlementReleased", s.Kind, err)
	}

	idlRefunded, want := idlBody(t, loadIDL(t, escrowIDLPath), "Refunded", refundedFields)
	s, err = DecodeSettlement(tagged(RefundedDiscriminator, append(idlRefunded, bytes.Repeat([]byte{0xee}, 16)...)))
	if err != nil || s.Kind != SettlementRefunded {
		t.Fatalf("refunded: kind = %d, err = %v, want SettlementRefunded", s.Kind, err)
	}
	if got, wantAmount := s.Amount, binary.LittleEndian.Uint64(want["amount"]); got != wantAmount {
		t.Errorf("refunded amount = %d, IDL layout puts %d there", got, wantAmount)
	}
	if !bytes.Equal(s.DepositHash[:], want["deposit_hash"]) || !bytes.Equal(s.QuoteHash[:], want["quote_hash"]) {
		t.Errorf("refunded hashes = %x / %x, want %x / %x", s.DepositHash, s.QuoteHash, want["deposit_hash"], want["quote_hash"])
	}
}

func TestDecodeSettlement_RejectsAnotherEventsTag(t *testing.T) {
	for _, name := range []string{"Deposited", "Reserved", "Fulfilled", "Paused"} {
		_, err := DecodeSettlement(tagged(Discriminator(name), make([]byte, ReleasedLen)))
		if !errors.Is(err, ErrNotSettlement) {
			t.Errorf("%s: err = %v, want ErrNotSettlement", name, err)
		}
	}
}

func TestDecodeSettlement_APayloadShorterThanATagIsAMiss(t *testing.T) {
	for n := 0; n < 8; n++ {
		_, err := DecodeSettlement(RefundedDiscriminator[:n])
		if !errors.Is(err, ErrNotSettlement) {
			t.Errorf("%d bytes: err = %v, want ErrNotSettlement", n, err)
		}
	}
}

func TestDecodeSettlement_OurTagWithAShortBodyIsTruncated(t *testing.T) {
	for _, tc := range []struct {
		tag    [8]byte
		length int
	}{{RefundedDiscriminator, RefundedLen}, {ReleasedDiscriminator, ReleasedLen}} {
		for n := 0; n < tc.length; n++ {
			s, err := DecodeSettlement(tagged(tc.tag, make([]byte, n)))
			if !errors.Is(err, ErrSettlementTruncated) || s.Kind != 0 {
				t.Fatalf("tag %x, %d-byte body: kind = %d, err = %v, want ErrSettlementTruncated", tc.tag, n, s.Kind, err)
			}
		}
	}
}

// A pre-v4 escrow emits the same tags without quote_hash; it must never decode as v4.
func TestDecodeSettlement_APreV4PayloadIsTruncated(t *testing.T) {
	idl := loadIDL(t, escrowPreV4IDLPath)
	for _, tc := range []struct {
		event  string
		fields []string
		tag    [8]byte
	}{
		{"Refunded", refundedFields[:len(refundedFields)-1], RefundedDiscriminator},
		{"Released", releasedFields[:len(releasedFields)-1], ReleasedDiscriminator},
	} {
		if got := idlDiscriminator(t, idl, tc.event); got != tc.tag {
			t.Fatalf("pre-v4 %s tag %x differs from v4 %x", tc.event, got, tc.tag)
		}
		body, _ := idlBody(t, idl, tc.event, tc.fields)
		if _, err := DecodeSettlement(tagged(tc.tag, body)); !errors.Is(err, ErrSettlementTruncated) {
			t.Errorf("pre-v4 %s: err = %v, want ErrSettlementTruncated", tc.event, err)
		}
	}
}
