package svm_escrow_encoding

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
)

// Labels of the escrow signed text, one per signed escrow instruction. They match the
// program's constants.rs.
const (
	EscrowLabelDeposit = "atum deposit v1"
	EscrowLabelReserve = "atum reserve v1"
	EscrowLabelRelease = "atum release v1"
	EscrowLabelRefund  = "atum refund v1"
)

// EscrowMessageForm is the exact message an escrow witness signature is over. The zero value is
// EscrowFormRaw, so a defaulted form never becomes text.
type EscrowMessageForm int

const (
	// EscrowFormRaw signs the 32 byte witness hash itself, the only form the v4 program verifies.
	EscrowFormRaw EscrowMessageForm = iota
	// EscrowFormBare signs the escrow text itself.
	EscrowFormBare
	// EscrowFormV1 signs the text inside a v1 off-chain message envelope with one signer.
	EscrowFormV1
	// EscrowFormV0 signs the text inside a v0 off-chain message envelope (zero application
	// domain, format 0, one signer).
	EscrowFormV0
)

// String returns "raw", "bare", "v1" or "v0".
func (f EscrowMessageForm) String() string {
	switch f {
	case EscrowFormRaw:
		return "raw"
	case EscrowFormBare:
		return "bare"
	case EscrowFormV1:
		return "v1"
	case EscrowFormV0:
		return "v0"
	default:
		return fmt.Sprintf("EscrowMessageForm(%d)", int(f))
	}
}

// OffchainSigningDomain is the 16-byte prefix of every off-chain message envelope.
var OffchainSigningDomain = [16]byte{0xff, 's', 'o', 'l', 'a', 'n', 'a', ' ', 'o', 'f', 'f', 'c', 'h', 'a', 'i', 'n'}

// EscrowText returns `<label> <base64url-nopad(hash)>`, the text the program requires the
// signer of an escrow instruction to have signed.
func EscrowText(label string, hash [32]byte) []byte {
	out := make([]byte, 0, len(label)+1+43)
	out = append(out, label...)
	out = append(out, ' ')
	return base64.RawURLEncoding.AppendEncode(out, hash[:])
}

// EscrowMessage returns the exact bytes signed for the given form: the hash itself for
// EscrowFormRaw, otherwise the text under label. pk is the signer and is embedded by the envelope
// forms. It panics on an unknown form.
func EscrowMessage(form EscrowMessageForm, label string, hash [32]byte, pk Pubkey) []byte {
	if form == EscrowFormRaw {
		return append([]byte(nil), hash[:]...)
	}
	text := EscrowText(label, hash)
	switch form {
	case EscrowFormBare:
		return text
	case EscrowFormV1:
		out := make([]byte, 0, 16+2+32+len(text))
		out = append(out, OffchainSigningDomain[:]...)
		out = append(out, 1, 1)
		out = append(out, pk[:]...)
		return append(out, text...)
	case EscrowFormV0:
		out := make([]byte, 0, 16+1+32+2+32+2+len(text))
		out = append(out, OffchainSigningDomain[:]...)
		out = append(out, 0)
		out = append(out, make([]byte, 32)...)
		out = append(out, 0, 1)
		out = append(out, pk[:]...)
		out = binary.LittleEndian.AppendUint16(out, uint16(len(text)))
		return append(out, text...)
	default:
		panic(fmt.Sprintf("svm_escrow_encoding: unknown EscrowMessageForm %d", int(form)))
	}
}

// EscrowMessageForms lists every text form, the forms an escrow-text-v1 program accepts.
var EscrowMessageForms = []EscrowMessageForm{EscrowFormBare, EscrowFormV1, EscrowFormV0}
