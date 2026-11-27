package events

import (
	"bytes"
	"errors"
	"testing"
)

var (
	refundedFields = []string{"deposit_hash", "depositor", "amount", "quote_hash"}
	releasedFields = []string{"deposit_hash", "recipient", "gross_amount", "intended_amount",
		"surplus_amount", "fee_amount", "net_amount", "quote_hash"}
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
	}
}

// The escrow appends fields at the end, so trailing bytes past quote_hash are ignored.
func TestDecodeSettlement_IgnoresTrailingBytes(t *testing.T) {
	body := bytes.Repeat([]byte{0x11}, ReleasedLen+16)
	s, err := DecodeSettlement(tagged(ReleasedDiscriminator, body))
	if err != nil || s.Kind != SettlementReleased {
		t.Fatalf("kind = %d, err = %v, want SettlementReleased", s.Kind, err)
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
