package ldverification

import (
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
)

func TestRecoverAddress_RoundTrip(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("gen key: %v", err)
	}
	expected := crypto.PubkeyToAddress(priv.PublicKey)

	hash := crypto.Keccak256([]byte("test"))
	sig, err := crypto.Sign(hash, priv)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}

	for _, recoveryByte := range []byte{sig[64], sig[64] + 27} {
		variant := make([]byte, 65)
		copy(variant, sig)
		variant[64] = recoveryByte

		got, err := RecoverAddress(hash, variant)
		if err != nil {
			t.Fatalf("recovery byte %d: %v", recoveryByte, err)
		}
		if got != expected {
			t.Errorf("recovery byte %d: got %s, want %s", recoveryByte, got.Hex(), expected.Hex())
		}
	}
}

func TestRecoverAddress_Errors(t *testing.T) {
	cases := []struct {
		name string
		hash []byte
		sig  []byte
		want string
	}{
		{"short signature", make([]byte, 32), make([]byte, 64), "65 bytes"},
		{"short hash", make([]byte, 16), make([]byte, 65), "32 bytes"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := RecoverAddress(tc.hash, tc.sig)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %v, want substring %q", err, tc.want)
			}
		})
	}
}
