package svm_escrow_encoding

import "fmt"

// MessageScheme is the form of the message an escrow version's ed25519 signers sign over a
// witness hash. The registry's svmMessage field names it.
type MessageScheme string

// SchemeRawHash signs the 32 byte witness hash itself, the only form the v4 program verifies.
const SchemeRawHash MessageScheme = ""

// SchemeEscrowTextV1 signs the escrow text `<label> <base64url-nopad(hash)>`. The program accepts
// it bare or inside a single-signer off-chain message envelope (v1, or v0 with a zero application
// domain), and never the raw hash.
const SchemeEscrowTextV1 MessageScheme = "escrow-text-v1"

// MessageSchemes lists every known scheme. The registry accepts exactly these names.
var MessageSchemes = []MessageScheme{SchemeRawHash, SchemeEscrowTextV1}

// WitnessKind is the escrow operation a witness hash authorizes.
type WitnessKind uint8

const (
	WitnessDeposit WitnessKind = iota + 1
	WitnessReserve
	WitnessRelease
	WitnessRefund
)

func (k WitnessKind) valid() bool { return k >= WitnessDeposit && k <= WitnessRefund }

// WitnessLabel returns the escrow text label of kind, or "" for an unknown kind.
func WitnessLabel(kind WitnessKind) string {
	switch kind {
	case WitnessDeposit:
		return EscrowLabelDeposit
	case WitnessReserve:
		return EscrowLabelReserve
	case WitnessRelease:
		return EscrowLabelRelease
	case WitnessRefund:
		return EscrowLabelRefund
	default:
		return ""
	}
}

// SigningBytes returns the message to sign for a witness hash under scheme. The raw hash scheme
// returns the hash itself and the text scheme the bare escrow text for kind; an unknown scheme or
// kind is an error.
func SigningBytes(scheme MessageScheme, kind WitnessKind, hash [32]byte) ([]byte, error) {
	if !kind.valid() {
		return nil, fmt.Errorf("unknown witness kind %d", kind)
	}
	switch scheme {
	case SchemeRawHash:
		return hash[:], nil
	case SchemeEscrowTextV1:
		return EscrowText(WitnessLabel(kind), hash), nil
	default:
		return nil, fmt.Errorf("unknown message scheme %q", scheme)
	}
}

// AcceptedForms returns the message schemes a client signature may take for an escrow signing
// with scheme: the scheme itself. MessageForms lists the exact forms within it.
func AcceptedForms(scheme MessageScheme) ([]MessageScheme, error) {
	switch scheme {
	case SchemeRawHash, SchemeEscrowTextV1:
		return []MessageScheme{scheme}, nil
	default:
		return nil, fmt.Errorf("unknown message scheme %q", scheme)
	}
}

// MessageForms returns the message forms a client witness signature may take under scheme: the
// raw hash only for the raw hash scheme, as the v4 program does, and the bare, v1 and v0 text
// forms for the text scheme, which never accepts the raw hash.
func MessageForms(scheme MessageScheme) ([]EscrowMessageForm, error) {
	switch scheme {
	case SchemeRawHash:
		return []EscrowMessageForm{EscrowFormRaw}, nil
	case SchemeEscrowTextV1:
		return append([]EscrowMessageForm(nil), EscrowMessageForms...), nil
	default:
		return nil, fmt.Errorf("unknown message scheme %q", scheme)
	}
}

// MatchEscrowWitness finds the form, among those scheme accepts, that sig signs for the kind
// witness over hash under pk, and returns that form and its exact signed bytes, the message an
// Ed25519SigVerify instruction must carry. It uses VerifyEd25519Strict, as the program does. ok is
// false for an unknown scheme or kind, a malformed key or signature, or no matching form.
func MatchEscrowWitness(scheme MessageScheme, kind WitnessKind, hash [32]byte, pk, sig []byte) (form EscrowMessageForm, message []byte, ok bool) {
	forms, err := MessageForms(scheme)
	if err != nil || !kind.valid() || len(pk) != 32 || len(sig) != 64 {
		return EscrowFormRaw, nil, false
	}
	var key Pubkey
	copy(key[:], pk)
	for _, f := range forms {
		msg := EscrowMessage(f, WitnessLabel(kind), hash, key)
		if VerifyEd25519Strict(pk, msg, sig) {
			return f, msg, true
		}
	}
	return EscrowFormRaw, nil, false
}
