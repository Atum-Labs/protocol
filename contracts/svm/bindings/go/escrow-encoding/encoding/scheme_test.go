package svm_escrow_encoding

import (
	"bytes"
	"strings"
	"testing"
)

func TestSigningBytes(t *testing.T) {
	var hash [32]byte
	for i := range hash {
		hash[i] = byte(i + 1)
	}
	cases := []struct {
		name    string
		scheme  MessageScheme
		kind    WitnessKind
		want    []byte
		wantErr string
	}{
		{"raw deposit", SchemeRawHash, WitnessDeposit, hash[:], ""},
		{"raw reserve", SchemeRawHash, WitnessReserve, hash[:], ""},
		{"raw release", SchemeRawHash, WitnessRelease, hash[:], ""},
		{"raw refund", SchemeRawHash, WitnessRefund, hash[:], ""},
		{"zero hash is signed as is", SchemeRawHash, WitnessRelease, make([]byte, 32), ""},
		{"unknown scheme", "text", WitnessRelease, nil, `unknown message scheme "text"`},
		{"scheme of one space", " ", WitnessRelease, nil, "unknown message scheme"},
		{"kind zero", SchemeRawHash, 0, nil, "unknown witness kind 0"},
		{"kind past refund", SchemeRawHash, WitnessRefund + 1, nil, "unknown witness kind 5"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var in [32]byte
			copy(in[:], tc.want)
			got, err := SigningBytes(tc.scheme, tc.kind, in)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) || got != nil {
					t.Fatalf("SigningBytes = %x, %v, want error containing %q", got, err, tc.wantErr)
				}
				return
			}
			if err != nil || !bytes.Equal(got, tc.want) {
				t.Fatalf("SigningBytes = %x, %v, want %x", got, err, tc.want)
			}
		})
	}
}

func TestAcceptedForms(t *testing.T) {
	got, err := AcceptedForms(SchemeRawHash)
	if err != nil || len(got) != 1 || got[0] != SchemeRawHash {
		t.Fatalf("AcceptedForms(raw) = %q, %v, want raw only", got, err)
	}
	if got, err := AcceptedForms("text"); err == nil || got != nil {
		t.Fatalf("AcceptedForms(text) = %q, %v, want an error", got, err)
	}
}
