package svm_escrow_encoding

import (
	"bytes"
	"crypto/ed25519"
	"testing"
)

var witnessKinds = []WitnessKind{WitnessDeposit, WitnessReserve, WitnessRelease, WitnessRefund}

func TestSigningBytesText(t *testing.T) {
	h := seqHash()
	for _, kind := range witnessKinds {
		got, err := SigningBytes(SchemeEscrowTextV1, kind, h)
		if err != nil || !bytes.Equal(got, EscrowText(WitnessLabel(kind), h)) {
			t.Fatalf("SigningBytes(text, %d) = %q, %v", kind, got, err)
		}
	}
	if _, err := SigningBytes(SchemeEscrowTextV1, 0, h); err == nil {
		t.Fatal("SigningBytes(text, 0) accepted an unknown kind")
	}
}

// The text scheme signs exactly the frozen bare vector for every kind.
func TestSigningBytesTextMatchesFrozenVectors(t *testing.T) {
	byLabel := map[string]WitnessKind{}
	for _, k := range witnessKinds {
		byLabel[WitnessLabel(k)] = k
	}
	for _, v := range loadSignedTextFile(t).Vectors {
		var h [32]byte
		copy(h[:], mustHex(t, v.Hash))
		got, err := SigningBytes(SchemeEscrowTextV1, byLabel[v.Label], h)
		if err != nil || !bytes.Equal(got, mustHex(t, v.Bare)) {
			t.Errorf("%s: SigningBytes(text) = %x, %v, want %s", v.Name, got, err, v.Bare)
		}
	}
}

func TestSchemeForms(t *testing.T) {
	cases := []struct {
		scheme  MessageScheme
		forms   []EscrowMessageForm
		schemes []MessageScheme
	}{
		{SchemeRawHash, []EscrowMessageForm{EscrowFormRaw}, []MessageScheme{SchemeRawHash}},
		{SchemeEscrowTextV1, []EscrowMessageForm{EscrowFormBare, EscrowFormV1, EscrowFormV0}, []MessageScheme{SchemeEscrowTextV1}},
	}
	for _, tc := range cases {
		forms, err := MessageForms(tc.scheme)
		if err != nil || len(forms) != len(tc.forms) {
			t.Fatalf("MessageForms(%q) = %v, %v", tc.scheme, forms, err)
		}
		for i := range forms {
			if forms[i] != tc.forms[i] {
				t.Fatalf("MessageForms(%q) = %v, want %v", tc.scheme, forms, tc.forms)
			}
		}
		schemes, err := AcceptedForms(tc.scheme)
		if err != nil || len(schemes) != 1 || schemes[0] != tc.schemes[0] {
			t.Fatalf("AcceptedForms(%q) = %v, %v", tc.scheme, schemes, err)
		}
	}
	for _, s := range []MessageScheme{"text", " ", "escrow-text-v2", "ESCROW-TEXT-V1"} {
		if _, err := MessageForms(s); err == nil {
			t.Errorf("MessageForms(%q) accepted an unknown scheme", s)
		}
		if _, err := SigningBytes(s, WitnessDeposit, seqHash()); err == nil {
			t.Errorf("SigningBytes(%q) accepted an unknown scheme", s)
		}
	}
	// MessageForms hands out a copy.
	forms, _ := MessageForms(SchemeEscrowTextV1)
	forms[0] = EscrowFormRaw
	if EscrowMessageForms[0] != EscrowFormBare {
		t.Fatal("MessageForms aliases EscrowMessageForms")
	}
}

func TestEscrowFormRawIsTheZeroForm(t *testing.T) {
	var zero EscrowMessageForm
	if zero != EscrowFormRaw || zero.String() != "raw" {
		t.Fatalf("zero form = %v", zero)
	}
	h := seqHash()
	if got := EscrowMessage(zero, EscrowLabelDeposit, h, Pubkey{}); !bytes.Equal(got, h[:]) {
		t.Fatalf("raw form message = %x, want the hash", got)
	}
}

// MatchEscrowWitness returns the exact signed bytes for each form its scheme accepts, and refuses
// every form the scheme does not.
func TestMatchEscrowWitness(t *testing.T) {
	priv := ed25519.NewKeyFromSeed(signedTextSeed)
	pub := []byte(priv.Public().(ed25519.PublicKey))
	var pk Pubkey
	copy(pk[:], pub)
	h := seqHash()
	allForms := []EscrowMessageForm{EscrowFormRaw, EscrowFormBare, EscrowFormV1, EscrowFormV0}
	for _, scheme := range MessageSchemes {
		accepted, _ := MessageForms(scheme)
		for _, kind := range []WitnessKind{WitnessDeposit, WitnessReserve} {
			for _, signed := range allForms {
				msg := EscrowMessage(signed, WitnessLabel(kind), h, pk)
				sig := ed25519.Sign(priv, msg)
				form, got, ok := MatchEscrowWitness(scheme, kind, h, pub, sig)
				want := false
				for _, a := range accepted {
					want = want || a == signed
				}
				if ok != want {
					t.Fatalf("scheme %q kind %d form %v: ok = %v, want %v", scheme, kind, signed, ok, want)
				}
				if ok && (form != signed || !bytes.Equal(got, msg)) {
					t.Fatalf("scheme %q kind %d form %v: matched %v %x", scheme, kind, signed, form, got)
				}
				if !ok && (form != EscrowFormRaw || got != nil) {
					t.Fatalf("scheme %q kind %d form %v: refusal returned %v %x", scheme, kind, signed, form, got)
				}
			}
		}
		// A deposit signature does not authorize a reserve.
		msg := EscrowMessage(accepted[0], EscrowLabelDeposit, h, pk)
		if scheme == SchemeEscrowTextV1 {
			if _, _, ok := MatchEscrowWitness(scheme, WitnessReserve, h, pub, ed25519.Sign(priv, msg)); ok {
				t.Fatalf("scheme %q: a deposit text matched a reserve", scheme)
			}
		}
	}
	sig := ed25519.Sign(priv, h[:])
	for name, call := range map[string]func() bool{
		"unknown scheme": func() bool { _, _, ok := MatchEscrowWitness("text", WitnessDeposit, h, pub, sig); return ok },
		"unknown kind":   func() bool { _, _, ok := MatchEscrowWitness(SchemeRawHash, 0, h, pub, sig); return ok },
		"short key":      func() bool { _, _, ok := MatchEscrowWitness(SchemeRawHash, WitnessDeposit, h, pub[:31], sig); return ok },
		"short sig":      func() bool { _, _, ok := MatchEscrowWitness(SchemeRawHash, WitnessDeposit, h, pub, sig[:63]); return ok },
		"other hash":     func() bool { _, _, ok := MatchEscrowWitness(SchemeRawHash, WitnessDeposit, createFilledBytes32(1), pub, sig); return ok },
	} {
		if call() {
			t.Errorf("%s: matched", name)
		}
	}
}

// The frozen vectors' signatures match under the text scheme with the vector's form and bytes.
func TestMatchEscrowWitnessFrozenVectors(t *testing.T) {
	f := loadSignedTextFile(t)
	pub := mustHex(t, f.PublicKey)
	for _, v := range f.Vectors {
		var h [32]byte
		copy(h[:], mustHex(t, v.Hash))
		for _, kind := range witnessKinds {
			if WitnessLabel(kind) != v.Label {
				continue
			}
			for _, p := range []struct {
				form     EscrowMessageForm
				msg, sig string
			}{{EscrowFormBare, v.Bare, v.SigBare}, {EscrowFormV1, v.V1, v.SigV1}, {EscrowFormV0, v.V0, v.SigV0}} {
				form, msg, ok := MatchEscrowWitness(SchemeEscrowTextV1, kind, h, pub, mustHex(t, p.sig))
				if !ok || form != p.form || !bytes.Equal(msg, mustHex(t, p.msg)) {
					t.Errorf("%s %v: got %v %x %v", v.Name, p.form, form, msg, ok)
				}
				if _, _, ok := MatchEscrowWitness(SchemeRawHash, kind, h, pub, mustHex(t, p.sig)); ok {
					t.Errorf("%s %v: a text signature matched the raw scheme", v.Name, p.form)
				}
			}
		}
	}
	for _, n := range f.NonCanonicalS {
		var h [32]byte
		copy(h[:], mustHex(t, f.Vectors[0].Hash))
		if _, _, ok := MatchEscrowWitness(SchemeEscrowTextV1, WitnessDeposit, h, pub, mustHex(t, n.Signature)); ok {
			t.Errorf("%s: a non-canonical S matched", n.Name)
		}
	}
}
