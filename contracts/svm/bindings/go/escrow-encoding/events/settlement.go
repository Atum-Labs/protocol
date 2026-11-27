package events

import (
	"bytes"
	"errors"
)

// SettlementKind says how the escrow settled a deposit. The zero value is no settlement.
type SettlementKind int

const (
	SettlementRefunded SettlementKind = iota + 1
	SettlementReleased
)

// The tags of the two escrow events that close a deposit, computed from the event names as Anchor
// does. TestSettlementDiscriminators_MatchTheIDL pins both against the committed escrow IDL.
var (
	RefundedDiscriminator = Discriminator("Refunded")
	ReleasedDiscriminator = Discriminator("Released")
)

// ErrNotSettlement is returned for a payload that carries neither settlement tag: some other
// event, or not an event at all. It is an ordinary miss.
var ErrNotSettlement = errors.New("not a settlement event")

// ErrSettlementTruncated is returned for a payload that carries a settlement tag but is too short
// to read its quote_hash, which is what a pre-v4 escrow emits. It is NOT a miss: the deposit
// settled, and under which quote cannot be learned from it.
var ErrSettlementTruncated = errors.New("settlement event too short to read")

// RefundedLen is the byte length of a v4 Refunded body: deposit_hash + depositor + amount +
// quote_hash. The escrow appends new fields at the end, so it is a minimum.
const RefundedLen = 32 + 32 + 8 + 32

// ReleasedLen is the byte length of a v4 Released body: deposit_hash + recipient + five u64
// amounts + quote_hash. Also a minimum, for the same reason.
const ReleasedLen = 32 + 32 + 5*8 + 32

// Settlement is a decoded Refunded or Released event. QuoteHash is all zero on a refund of a
// deposit that was never reserved, since the escrow sets it only at reserve: read zero as no quote.
type Settlement struct {
	Kind        SettlementKind
	DepositHash [32]byte
	QuoteHash   [32]byte
}

// DecodeSettlement reads the deposit_hash and quote_hash out of a Refunded or Released payload,
// tag included. Both fields are fixed-width, so the offsets are an unambiguous Borsh decode.
func DecodeSettlement(raw []byte) (Settlement, error) {
	if len(raw) < 8 {
		return Settlement{}, ErrNotSettlement
	}
	body := raw[8:]
	var s Settlement
	var quoteAt int
	switch {
	case bytes.Equal(raw[:8], RefundedDiscriminator[:]):
		s.Kind, quoteAt = SettlementRefunded, RefundedLen-32
	case bytes.Equal(raw[:8], ReleasedDiscriminator[:]):
		s.Kind, quoteAt = SettlementReleased, ReleasedLen-32
	default:
		return Settlement{}, ErrNotSettlement
	}
	if len(body) < quoteAt+32 {
		return Settlement{}, ErrSettlementTruncated
	}
	copy(s.DepositHash[:], body[0:32])
	copy(s.QuoteHash[:], body[quoteAt:quoteAt+32])
	return s, nil
}
