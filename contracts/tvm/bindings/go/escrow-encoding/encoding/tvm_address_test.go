package encoding

import (
	"encoding/hex"
	"testing"

	"github.com/fbsobreira/gotron-sdk/pkg/address"
)

const (
	// A perfectly ordinary 20-byte body whose first byte happens to be 0x41 --
	// the same value Tron uses as its mainnet marker byte. Canonicalization must
	// key off the input's length, not off a byte a legal body is free to contain,
	// or this address silently loses its first byte.
	affected41Body = "4100112233445566778899aabbccddeeff001122"
	// Paired ordinary body. Every assertion about affected41Body has a twin here,
	// so a reader can see the two are required to behave identically.
	controlBody = "e96051e8da2f0cc02c372252dfacfdb129b5d4d6"
)

// base58Spelling derives the base58check form of a 40-hex-character body by
// prepending Tron's 0x41 marker byte to make the 21-byte address value.
// Derived rather than written as a literal: a hand-computed base58 string would
// pin whatever typo it contained.
func base58Spelling(t *testing.T, body string) string {
	t.Helper()
	raw, err := hex.DecodeString(body)
	if err != nil {
		t.Fatalf("test body %q is not valid hex: %v", body, err)
	}
	if len(raw) != 20 {
		t.Fatalf("test body %q decoded to %d bytes, want 20", body, len(raw))
	}
	return address.Address(append([]byte{0x41}, raw...)).String()
}

func TestNormalizeAddress(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
		wantErr  bool
	}{
		{
			name:     "TVM base58 encoded address",
			input:    "TY2ABh37QFZ7kjB9yWit8q51SccrQJdy1H",
			expected: "f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			wantErr:  false,
		},
		{
			name:     "Hex encoded address with 41 prefix (21-byte hex)",
			input:    "41f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			expected: "f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			wantErr:  false,
		},
		{
			name:     "Hex encoded with 0x41 prefix",
			input:    "0x41f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			expected: "f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			wantErr:  false,
		},
		{
			name:     "Plain 20-byte hex address",
			input:    "f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			expected: "f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			wantErr:  false,
		},
		{
			name:     "0x prefixed 20-byte hex address",
			input:    "0xf1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			expected: "f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			wantErr:  false,
		},
		{
			name:     "Uppercase hex address",
			input:    "F1E1A9F3C39E7C6B6B7B8C9D0E1F2A3B4C5D6E7F",
			expected: "f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			wantErr:  false,
		},
		{
			name:     "Invalid hex character",
			input:    "f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7g",
			expected: "",
			wantErr:  true,
		},
		{
			name:     "Wrong length (too short)",
			input:    "f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e",
			expected: "",
			wantErr:  true,
		},
		{
			name:     "Empty string",
			input:    "",
			expected: "",
			wantErr:  true,
		},
		{
			name:     "Invalid base58",
			input:    "Tinvalid123",
			expected: "",
			wantErr:  true,
		},
		{
			name:     "Hex with wrong prefix (not 41)",
			input:    "42f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			expected: "",
			wantErr:  true,
		},
		{
			// Rejection parity with the TS reference encoder:
			// a base58 address whose checksum is corrupted but whose length is still
			// 25 bytes must be rejected on the checksum, not slip through. This is
			// the typo case base58check exists to catch — accepting it would sign a
			// wrong address that only fails on-chain.
			name:     "Base58 with corrupted checksum (same 25-byte length)",
			input:    "TEDjSzRsnkhQNEeptyKaSgvmaREdttQ4qS",
			expected: "",
			wantErr:  true,
		},
		{
			// Go's TrimPrefix("0x") is case-sensitive, so an uppercase "0X" prefix
			// is left intact and fails the length check. The TS reference rejects
			// this too; pinning it here keeps the two reject-identical.
			name:     "Uppercase 0X prefix",
			input:    "0X2e9fbe1886fa094573e3bd25c554e827873bb9fc",
			expected: "",
			wantErr:  true,
		},
		{
			// A 20-byte body is already canonical. Its leading 0x41 is address
			// data, not the Tron marker byte, so nothing may be stripped.
			name:     "Bare 40-char hex, body begins with 0x41",
			input:    affected41Body,
			expected: affected41Body,
			wantErr:  false,
		},
		{
			name:     "Bare 40-char hex, control body",
			input:    controlBody,
			expected: controlBody,
			wantErr:  false,
		},
		{
			name:     "0x-prefixed 40-char hex, body begins with 0x41",
			input:    "0x" + affected41Body,
			expected: affected41Body,
			wantErr:  false,
		},
		{
			name:     "0x-prefixed 40-char hex, control body",
			input:    "0x" + controlBody,
			expected: controlBody,
			wantErr:  false,
		},
		{
			// 42 chars: marker byte + body. Exactly one "41" comes off, leaving
			// 40 chars -- stripping the body's own leading 41 as well would
			// leave 38.
			name:     "Full 42-char hex, body begins with 0x41",
			input:    "41" + affected41Body,
			expected: affected41Body,
			wantErr:  false,
		},
		{
			name:     "Full 42-char hex, control body",
			input:    "41" + controlBody,
			expected: controlBody,
			wantErr:  false,
		},
		{
			name:     "0x-prefixed 42-char hex, body begins with 0x41",
			input:    "0x41" + affected41Body,
			expected: affected41Body,
			wantErr:  false,
		},
		{
			name:     "0x-prefixed 42-char hex, control body",
			input:    "0x41" + controlBody,
			expected: controlBody,
			wantErr:  false,
		},
		{
			// Only 40 and 42 hex characters are legal lengths; 44 is neither.
			name:    "Too long (44 hex chars), body begins with 0x41",
			input:   affected41Body + "0000",
			wantErr: true,
		},
		{
			name:    "Too long (44 hex chars), control body",
			input:   controlBody + "0000",
			wantErr: true,
		},
		{
			name:    "Too short (38 hex chars), body begins with 0x41",
			input:   affected41Body[:38],
			wantErr: true,
		},
		{
			name:    "Too short (38 hex chars), control body",
			input:   controlBody[:38],
			wantErr: true,
		},
		{
			// 42 chars means the first byte is claiming to be the Tron marker.
			// 0x42 is not it, so the input is not a Tron address at all.
			name:    "42-char hex with non-41 marker, body begins with 0x41",
			input:   "42" + affected41Body,
			wantErr: true,
		},
		{
			name:    "42-char hex with non-41 marker, control body",
			input:   "42" + controlBody,
			wantErr: true,
		},
		{
			// An interior "0x" is address data, not a prefix. Only a leading one
			// comes off, so these stay 42 characters and are refused. A strip that
			// matched "0x" anywhere would delete the pair and leave 40 valid hex.
			name:    "interior 0x mid-body, body begins with 0x41",
			input:   affected41Body[:20] + "0x" + affected41Body[20:],
			wantErr: true,
		},
		{
			name:    "interior 0x mid-body, control body",
			input:   controlBody[:20] + "0x" + controlBody[20:],
			wantErr: true,
		},
		{
			name:    "interior 0x near the end, body begins with 0x41",
			input:   affected41Body[:38] + "0x" + affected41Body[38:],
			wantErr: true,
		},
		{
			name:    "interior 0x near the end, control body",
			input:   controlBody[:38] + "0x" + controlBody[38:],
			wantErr: true,
		},
		{
			// Where the two strips meet. The marker comes off and the 0x stays,
			// leaving 40 characters that fail the hex check; a strip scanning a
			// leading window would take the 0x instead and leave 40 that pass.
			// The mid-body cases above cannot tell those two apart.
			name:    "interior 0x right after the 41 marker",
			input:   affected41Body[:2] + "0x" + affected41Body[2:],
			wantErr: true,
		},
		{
			name:    "interior 0x at index 2, control body",
			input:   controlBody[:2] + "0x" + controlBody[2:],
			wantErr: true,
		},
		{
			name:    "interior 0x at index 1, body begins with 0x41",
			input:   affected41Body[:1] + "0x" + affected41Body[1:],
			wantErr: true,
		},
		{
			name:    "interior 0x at index 1, control body",
			input:   controlBody[:1] + "0x" + controlBody[1:],
			wantErr: true,
		},
		{
			// Exactly one leading prefix comes off, not a run of them. A loop would
			// take both pairs and read a 44-character string as a 20-byte address.
			name:    "repeated 0x prefix, body begins with 0x41",
			input:   "0x0x" + affected41Body,
			wantErr: true,
		},
		{
			name:    "repeated 0x prefix, control body",
			input:   "0x0x" + controlBody,
			wantErr: true,
		},
		{
			// The marker byte is compared as a whole byte, not digit by digit.
			// "a1" differs from "41" only in the first hex digit, so an
			// implementation that checks just the second digit accepts it.
			name:    "42-char hex, marker a1 differs in first digit only, body begins with 0x41",
			input:   "a1" + affected41Body,
			wantErr: true,
		},
		{
			name:    "42-char hex, marker a1 differs in first digit only, control body",
			input:   "a1" + controlBody,
			wantErr: true,
		},
		{
			name:    "42-char hex, marker 01 differs in first digit only, body begins with 0x41",
			input:   "01" + affected41Body,
			wantErr: true,
		},
		{
			name:    "42-char hex, marker 01 differs in first digit only, control body",
			input:   "01" + controlBody,
			wantErr: true,
		},
		{
			// Mirror of the a1/01 cases: "4f" differs from "41" only in the
			// second hex digit, so an implementation that checks just the first
			// digit accepts it. Both halves of the marker must be load-bearing.
			name:    "42-char hex, marker 4f differs in second digit only, body begins with 0x41",
			input:   "4f" + affected41Body,
			wantErr: true,
		},
		{
			name:    "42-char hex, marker 4f differs in second digit only, control body",
			input:   "4f" + controlBody,
			wantErr: true,
		},
		{
			// 0x40 is adjacent to the real marker: off-by-one on the low nibble
			// is the likeliest way a hand-rolled check goes wrong.
			name:    "42-char hex, marker 40 differs in second digit only, body begins with 0x41",
			input:   "40" + affected41Body,
			wantErr: true,
		},
		{
			name:    "42-char hex, marker 40 differs in second digit only, control body",
			input:   "40" + controlBody,
			wantErr: true,
		},
		{
			// Both digits wrong. 0x00 is what a zero-filled or truncated buffer
			// produces, so it must never be mistaken for a Tron address.
			name:    "42-char hex, marker 00 differs in both digits, body begins with 0x41",
			input:   "00" + affected41Body,
			wantErr: true,
		},
		{
			name:    "42-char hex, marker 00 differs in both digits, control body",
			input:   "00" + controlBody,
			wantErr: true,
		},
		{
			name:    "42-char hex, marker ff differs in both digits, body begins with 0x41",
			input:   "ff" + affected41Body,
			wantErr: true,
		},
		{
			name:    "42-char hex, marker ff differs in both digits, control body",
			input:   "ff" + controlBody,
			wantErr: true,
		},
		{
			// Stripping "0x" leaves 42 hex characters, so the marker check must
			// apply to the prefixed spelling exactly as it does to the bare one.
			name:    "0x-prefixed 42-char hex, marker a1 differs in first digit only, body begins with 0x41",
			input:   "0xa1" + affected41Body,
			wantErr: true,
		},
		{
			name:    "0x-prefixed 42-char hex, marker a1 differs in first digit only, control body",
			input:   "0xa1" + controlBody,
			wantErr: true,
		},
		{
			name:    "0x-prefixed 42-char hex, marker 4f differs in second digit only, body begins with 0x41",
			input:   "0x4f" + affected41Body,
			wantErr: true,
		},
		{
			name:    "0x-prefixed 42-char hex, marker 4f differs in second digit only, control body",
			input:   "0x4f" + controlBody,
			wantErr: true,
		},
		{
			name:    "0x-prefixed 42-char hex, marker ff differs in both digits, body begins with 0x41",
			input:   "0xff" + affected41Body,
			wantErr: true,
		},
		{
			name:    "0x-prefixed 42-char hex, marker ff differs in both digits, control body",
			input:   "0xff" + controlBody,
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := NormalizeAddress(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Error("expected an error but got none")
				}
				return
			}
			if err != nil {
				t.Errorf("unexpected error: %v", err)
				return
			}
			if got != tt.expected {
				t.Errorf("got %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestEncodeTIP712Address(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string // hex-encoded 32-byte word
		wantErr  bool
	}{
		{
			name:     "TVM base58 encoded address",
			input:    "TY2ABh37QFZ7kjB9yWit8q51SccrQJdy1H",
			expected: "000000000000000000000000f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			wantErr:  false,
		},
		{
			name:     "Hex encoded address with 41 prefix",
			input:    "41f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			expected: "000000000000000000000000f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			wantErr:  false,
		},
		{
			name:     "Hex encoded with 0x41 prefix",
			input:    "0x41f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			expected: "000000000000000000000000f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			wantErr:  false,
		},
		{
			name:     "Plain 20-byte hex address",
			input:    "f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			expected: "000000000000000000000000f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			wantErr:  false,
		},
		{
			name:     "0x prefixed 20-byte hex address",
			input:    "0xf1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			expected: "000000000000000000000000f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			wantErr:  false,
		},
		{
			name:     "Uppercase hex address",
			input:    "F1E1A9F3C39E7C6B6B7B8C9D0E1F2A3B4C5D6E7F",
			expected: "000000000000000000000000f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7f",
			wantErr:  false,
		},
		{
			name:    "Invalid hex character",
			input:   "f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e7g",
			wantErr: true,
		},
		{
			name:    "Wrong length",
			input:   "f1e1a9f3c39e7c6b6b7b8c9d0e1f2a3b4c5d6e",
			wantErr: true,
		},
		{
			name:    "Empty string",
			input:   "",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := EncodeTIP712Address(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Error("expected an error but got none")
				}
				return
			}
			if err != nil {
				t.Errorf("unexpected error: %v", err)
				return
			}
			actualHex := hex.EncodeToString(got)
			if actualHex != tt.expected {
				t.Errorf("got %q, want %q", actualHex, tt.expected)
			}
		})
	}
}

// TestNormalizeAddressSpellingsAgree pins the core invariant: one address has
// several legal spellings, and all of them must canonicalize to one value. The
// table above checks each spelling against a literal; this checks the spellings
// against each other, which is what callers actually depend on when the same
// address arrives from a base58 config file and a hex event log.
func TestNormalizeAddressSpellingsAgree(t *testing.T) {
	bodies := []struct {
		name string
		body string
	}{
		{name: "body begins with 0x41", body: affected41Body},
		{name: "control body", body: controlBody},
	}

	for _, b := range bodies {
		t.Run(b.name, func(t *testing.T) {
			spellings := []struct {
				name  string
				input string
			}{
				{name: "bare 40-char hex", input: b.body},
				{name: "0x-prefixed 40-char hex", input: "0x" + b.body},
				{name: "full 42-char hex", input: "41" + b.body},
				{name: "0x-prefixed 42-char hex", input: "0x41" + b.body},
				{name: "base58check", input: base58Spelling(t, b.body)},
			}

			for _, s := range spellings {
				got, err := NormalizeAddress(s.input)
				if err != nil {
					t.Errorf("%s (%q): unexpected error: %v", s.name, s.input, err)
					continue
				}
				if got != b.body {
					t.Errorf("%s (%q): got %q, want %q", s.name, s.input, got, b.body)
				}
				// Length is asserted separately: it distinguishes "stripped the
				// marker twice" (38) and "stripped nothing" (42) from a plain
				// value mismatch.
				if len(got) != 40 {
					t.Errorf("%s (%q): got %d hex chars, want 40", s.name, s.input, len(got))
				}
			}
		})
	}
}
