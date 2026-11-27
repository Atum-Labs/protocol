package events

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

func TestDiscriminators_MatchTheIDL(t *testing.T) {
	idl := loadIDL(t, fulfillmentProxyIDLPath)
	if got, want := FulfilledDiscriminator, idlDiscriminator(t, idl, "Fulfilled"); got != want {
		t.Errorf("FulfilledDiscriminator = %x, IDL says %x", got, want)
	}
	if got, want := StrictFulfilledDiscriminator, idlDiscriminator(t, idl, "StrictFulfilled"); got != want {
		t.Errorf("StrictFulfilledDiscriminator = %x, IDL says %x", got, want)
	}
}

// fulfillmentBody builds a Fulfilled body whose every byte says which field it belongs to, so a
// decoder reading any field from the wrong offset produces a value the test can see is wrong.
func fulfillmentBody() []byte {
	body := make([]byte, 0, FulfillmentLen)
	for i := 0; i < 32; i++ {
		body = append(body, byte(0x00+i)) // quote_hash
	}
	for i := 0; i < 32; i++ {
		body = append(body, byte(0x40+i)) // to
	}
	for i := 0; i < 32; i++ {
		body = append(body, byte(0x80+i)) // token
	}
	return append(body, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08) // amount, little-endian
}

// assertSharedFields checks the fields both fulfillment events carry against the IDL's layout.
func assertSharedFields(t *testing.T, got Fulfillment, want map[string][]byte) {
	t.Helper()
	if !bytes.Equal(got.QuoteHash[:], want["quote_hash"]) {
		t.Errorf("QuoteHash = %x, IDL layout puts %x there", got.QuoteHash, want["quote_hash"])
	}
	if !bytes.Equal(got.To[:], want["to"]) {
		t.Errorf("To = %x, IDL layout puts %x there", got.To[:], want["to"])
	}
	if !bytes.Equal(got.Token[:], want["token"]) {
		t.Errorf("Token = %x, IDL layout puts %x there", got.Token[:], want["token"])
	}
	if w := binary.LittleEndian.Uint64(want["amount"]); got.Amount != w {
		t.Errorf("Amount = %#x, IDL layout puts %#x there", got.Amount, w)
	}
}

func TestDecodeFulfillment_AgreesWithTheIDLLayout(t *testing.T) {
	idl := loadIDL(t, fulfillmentProxyIDLPath)
	body, want := idlBody(t, idl, "Fulfilled", []string{"quote_hash", "to", "token", "amount"})
	if len(body) != FulfillmentLen {
		t.Fatalf("IDL Fulfilled body is %d bytes, FulfillmentLen is %d", len(body), FulfillmentLen)
	}
	got, err := DecodeFulfillment(tagged(FulfilledDiscriminator, body))
	if err != nil {
		t.Fatalf("DecodeFulfillment: %v", err)
	}
	assertSharedFields(t, got, want)
}

func TestDecodeFulfillment_RejectsAnotherEventsTag(t *testing.T) {
	_, err := DecodeFulfillment(tagged(Discriminator("Paused"), fulfillmentBody()))
	if !errors.Is(err, ErrUnknownDiscriminator) {
		t.Fatalf("err = %v, want ErrUnknownDiscriminator", err)
	}
}

// A payload too short to hold a tag cannot be one of these events, so it is a miss rather than a
// truncated delivery. Callers on the refund path rely on that: treating it as truncated would make
// every short line a reason to leave the escrow neither released nor returned.
func TestDecodeFulfillment_APayloadShorterThanATagIsAMiss(t *testing.T) {
	for n := 0; n < 8; n++ {
		_, err := DecodeFulfillment(FulfilledDiscriminator[:n])
		if !errors.Is(err, ErrUnknownDiscriminator) {
			t.Errorf("%d bytes: err = %v, want ErrUnknownDiscriminator", n, err)
		}
	}
}

// Our tag with a body too short to read is a delivery of something whose terms cannot be learned.
// It must be told apart from a miss: on the refund path, reading it as one is the absence that
// pays the depositor back.
func TestDecodeFulfillment_OurTagWithAShortBodyIsTruncated(t *testing.T) {
	for _, tag := range [][8]byte{FulfilledDiscriminator, StrictFulfilledDiscriminator} {
		for n := 0; n < FulfillmentLen; n++ {
			_, err := DecodeFulfillment(tagged(tag, fulfillmentBody()[:n]))
			if !errors.Is(err, ErrTruncated) {
				t.Fatalf("tag %x, %d-byte body: err = %v, want ErrTruncated", tag, n, err)
			}
		}
	}
}

func TestDecodeStrictFulfilled_AgreesWithTheIDLLayout(t *testing.T) {
	idl := loadIDL(t, fulfillmentProxyIDLPath)
	body, want := idlBody(t, idl, "StrictFulfilled",
		[]string{"quote_hash", "to", "token", "amount", "nonce", "issued_at", "deadline"})
	if len(body) != StrictFulfilledLen {
		t.Fatalf("IDL StrictFulfilled body is %d bytes, StrictFulfilledLen is %d", len(body), StrictFulfilledLen)
	}
	got, err := DecodeStrictFulfilled(tagged(StrictFulfilledDiscriminator, body))
	if err != nil {
		t.Fatalf("DecodeStrictFulfilled: %v", err)
	}
	assertSharedFields(t, got.Fulfillment, want)
	for name, gotField := range map[string]uint64{
		"nonce": got.Nonce, "issued_at": got.IssuedAt, "deadline": got.Deadline,
	} {
		if w := binary.LittleEndian.Uint64(want[name]); gotField != w {
			t.Errorf("%s = %#x, IDL layout puts %#x there", name, gotField, w)
		}
	}
}

func TestDecodeStrictFulfilled_RejectsAPlainFulfilled(t *testing.T) {
	body := append(fulfillmentBody(), make([]byte, StrictFulfilledLen-FulfillmentLen)...)
	_, err := DecodeStrictFulfilled(tagged(FulfilledDiscriminator, body))
	if !errors.Is(err, ErrUnknownDiscriminator) {
		t.Fatalf("err = %v, want ErrUnknownDiscriminator", err)
	}
}

func TestDecodeStrictFulfilled_AShortTailIsTruncated(t *testing.T) {
	full := append(fulfillmentBody(), make([]byte, StrictFulfilledLen-FulfillmentLen)...)
	for n := 0; n < len(full); n++ {
		_, err := DecodeStrictFulfilled(tagged(StrictFulfilledDiscriminator, full[:n]))
		if !errors.Is(err, ErrTruncated) {
			t.Fatalf("%d-byte body: err = %v, want ErrTruncated", n, err)
		}
	}
}

// The trailing space is part of the prefix: without it a caller's trimmed payload starts with a
// space and fails to base64-decode, and the line reads as no event at all.
func TestProgramDataPrefix_IsTheRuntimesExactSpelling(t *testing.T) {
	if ProgramDataPrefix != "Program data: " {
		t.Fatalf("ProgramDataPrefix = %q, want %q", ProgramDataPrefix, "Program data: ")
	}
}

// StrictFulfilled appends its fields after the shared ones, so one decoder reads both events and
// its length check is a minimum. An equality check would reject every strict fulfillment, and a
// rejected delivery is indistinguishable from one that never happened.
func TestDecodeFulfillment_ReadsTheSharedPartOfAStrictFulfilled(t *testing.T) {
	body := append(fulfillmentBody(), bytes.Repeat([]byte{0xff}, StrictFulfilledLen-FulfillmentLen)...)
	got, err := DecodeFulfillment(tagged(StrictFulfilledDiscriminator, body))
	if err != nil {
		t.Fatalf("DecodeFulfillment: %v", err)
	}
	if want := uint64(0x0807060504030201); got.Amount != want {
		t.Errorf("Amount = %#x, want %#x", got.Amount, want)
	}
}

func TestIsFulfillment_RequiresTheWholeTag(t *testing.T) {
	for _, tag := range [][8]byte{FulfilledDiscriminator, StrictFulfilledDiscriminator} {
		if !IsFulfillment(tag[:]) {
			t.Errorf("IsFulfillment(%x) = false, want true", tag)
		}
		if IsFulfillment(tag[:7]) {
			t.Errorf("IsFulfillment(%x) = true for a 7-byte prefix", tag[:7])
		}
		flipped := tag
		flipped[7] ^= 0x01
		if IsFulfillment(flipped[:]) {
			t.Errorf("IsFulfillment(%x) = true with the last byte changed", flipped)
		}
	}
}
