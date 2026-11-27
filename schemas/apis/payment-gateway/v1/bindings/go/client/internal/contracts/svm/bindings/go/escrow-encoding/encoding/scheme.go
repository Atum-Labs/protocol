package svm_escrow_encoding

import "fmt"

// MessageScheme is the form of the message an escrow version's ed25519 signers sign over a
// witness hash. The registry's svmMessage field names it.
type MessageScheme string

// SchemeRawHash signs the 32 byte witness hash itself, the only form the v4 program verifies.
const SchemeRawHash MessageScheme = ""

// WitnessKind is the escrow operation a witness hash authorizes.
type WitnessKind uint8

const (
	WitnessDeposit WitnessKind = iota + 1
	WitnessReserve
	WitnessRelease
	WitnessRefund
)

func (k WitnessKind) valid() bool { return k >= WitnessDeposit && k <= WitnessRefund }

// SigningBytes returns the message to sign for a witness hash under scheme. The raw hash scheme
// returns the hash itself; an unknown scheme or kind is an error.
func SigningBytes(scheme MessageScheme, kind WitnessKind, hash [32]byte) ([]byte, error) {
	if !kind.valid() {
		return nil, fmt.Errorf("unknown witness kind %d", kind)
	}
	switch scheme {
	case SchemeRawHash:
		return hash[:], nil
	default:
		return nil, fmt.Errorf("unknown message scheme %q", scheme)
	}
}

// AcceptedForms returns the message forms a client signature may take for an escrow signing with
// scheme. The raw hash scheme accepts the raw hash only, as the v4 program does.
func AcceptedForms(scheme MessageScheme) ([]MessageScheme, error) {
	switch scheme {
	case SchemeRawHash:
		return []MessageScheme{SchemeRawHash}, nil
	default:
		return nil, fmt.Errorf("unknown message scheme %q", scheme)
	}
}
