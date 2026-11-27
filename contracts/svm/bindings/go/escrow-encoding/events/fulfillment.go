// Package events decodes the events the Solana fulfillment proxy and escrow emit into their
// program logs: the proxy's fulfillments and the escrow's Refunded and Released settlements.
//
// It is the contract-level mapping only: event tags and layouts. Which program wrote a given
// log line, and what a match or a miss authorises, belong to the caller.
//
// The layouts are the v4 programs'. The pre-v4 proxy emitted the same tags over a different body
// (with a `from` field), so its logs must be decoded with idl-history/pre-v4 in the TypeScript
// binding, never with this package. A pre-v4 escrow settlement lacks quote_hash and decodes as
// ErrSettlementTruncated.
package events

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"

	escrow "github.com/atum-labs/protocol/contracts/svm/bindings/go/escrow-encoding/encoding"
)

// ProgramDataPrefix is how the runtime writes an event emitted with Anchor's emit! into the
// program log: the prefix, then the base64 payload (tag followed by Borsh body).
const ProgramDataPrefix = "Program data: "

// Discriminator is the eight-byte tag Anchor prefixes to an emitted event: sha256("event:<Name>")[:8].
//
// The tag is derived from the event NAME alone, so it does not pin the layout: removing a field
// leaves the tag unchanged. The layout's authority is the program source.
func Discriminator(name string) [8]byte {
	sum := sha256.Sum256([]byte("event:" + name))
	var out [8]byte
	copy(out[:], sum[:8])
	return out
}

// The tags of the two events that mean a delivery happened, computed from the event names as
// Anchor does. TestDiscriminators_MatchTheIDL pins both against the committed IDL.
var (
	FulfilledDiscriminator       = Discriminator("Fulfilled")
	StrictFulfilledDiscriminator = Discriminator("StrictFulfilled")
)

// ErrUnknownDiscriminator is returned for a payload that does not carry the tag the decoder reads.
// From DecodeFulfillment it is an ordinary miss: the payload is some other event, or not an event
// at all. From DecodeStrictFulfilled it is also returned for a Fulfilled event, which IS a
// delivery, so a caller that must not miss one reads with DecodeFulfillment.
var ErrUnknownDiscriminator = errors.New("not a fulfillment event")

// ErrTruncated is returned for a payload that carries a fulfillment tag but is too short to read.
// It is NOT a miss: the payload is a delivery of something, and which payment it settles cannot
// be learned from it.
var ErrTruncated = errors.New("fulfillment event too short to read")

// FulfillmentLen is the byte length of the body both fulfillment events share: quote_hash + to +
// token + amount. StrictFulfilled appends its own fields after these, so it is a minimum.
const FulfillmentLen = 32 + 32 + 32 + 8

// IsFulfillment reports whether an eight-byte tag is one a delivery carries.
func IsFulfillment(tag []byte) bool {
	return bytes.Equal(tag, FulfilledDiscriminator[:]) || bytes.Equal(tag, StrictFulfilledDiscriminator[:])
}

// Fulfillment is the part both fulfillment events share: quote_hash, to, token, amount.
type Fulfillment struct {
	QuoteHash [32]byte
	To        escrow.Pubkey
	Token     escrow.Pubkey
	Amount    uint64
}

// DecodeFulfillment reads the shared part out of an event payload, tag included.
//
// Every field is fixed-width, so a direct offset read is an unambiguous Borsh decode. The offsets
// follow the program's event definition, and Amount is little-endian because Borsh is.
func DecodeFulfillment(raw []byte) (Fulfillment, error) {
	if len(raw) < 8 || !IsFulfillment(raw[:8]) {
		return Fulfillment{}, ErrUnknownDiscriminator
	}
	body := raw[8:]
	if len(body) < FulfillmentLen {
		return Fulfillment{}, ErrTruncated
	}
	return readShared(body), nil
}

// readShared reads the shared fields out of a body the caller has checked is at least
// FulfillmentLen bytes.
func readShared(body []byte) Fulfillment {
	var ev Fulfillment
	copy(ev.QuoteHash[:], body[0:32])
	copy(ev.To[:], body[32:64])
	copy(ev.Token[:], body[64:96])
	ev.Amount = binary.LittleEndian.Uint64(body[96:104])
	return ev
}

// StrictFulfilledLen is the byte length of a StrictFulfilled body: the shared fields plus nonce,
// issued_at and deadline.
const StrictFulfilledLen = FulfillmentLen + 8 + 8 + 8

// StrictFulfilled is the StrictFulfilled event in full: the shared fields, then the strict
// fulfillment's nonce, issued_at and deadline.
type StrictFulfilled struct {
	Fulfillment
	Nonce    uint64
	IssuedAt uint64
	Deadline uint64
}

// DecodeStrictFulfilled reads a StrictFulfilled event out of its payload, tag included. It reads
// that event only: a Fulfilled payload returns ErrUnknownDiscriminator. A caller deciding whether
// a delivery happened at all wants DecodeFulfillment, which reads the shared fields of both.
func DecodeStrictFulfilled(raw []byte) (StrictFulfilled, error) {
	if len(raw) < 8 || !bytes.Equal(raw[:8], StrictFulfilledDiscriminator[:]) {
		return StrictFulfilled{}, ErrUnknownDiscriminator
	}
	body := raw[8:]
	if len(body) < StrictFulfilledLen {
		return StrictFulfilled{}, ErrTruncated
	}
	return StrictFulfilled{
		Fulfillment: readShared(body),
		Nonce:       binary.LittleEndian.Uint64(body[104:112]),
		IssuedAt:    binary.LittleEndian.Uint64(body[112:120]),
		Deadline:    binary.LittleEndian.Uint64(body[120:128]),
	}, nil
}
