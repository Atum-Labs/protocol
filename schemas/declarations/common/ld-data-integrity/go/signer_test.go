package lddataintegrity

import (
	"bytes"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
)

// TestNewECDSASigner_ByteIdenticalToCryptoSign pins the behavior-preserving
// contract: the raw-key adapter produces the EXACT bytes crypto.Sign does,
// so wrapping the existing raw-key sign path in NewECDSASigner is a no-op on
// the wire (v ∈ {0,1}, low-s, 65 bytes).
func TestNewECDSASigner_ByteIdenticalToCryptoSign(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	digest := crypto.Keccak256([]byte("the-32-byte-digest-under-test!!!"))

	signer, err := NewECDSASigner(priv)
	if err != nil {
		t.Fatalf("NewECDSASigner: %v", err)
	}

	got, err := signer.SignDigest(digest)
	if err != nil {
		t.Fatalf("SignDigest: %v", err)
	}
	want, err := crypto.Sign(digest, priv) // deterministic (RFC6979)
	if err != nil {
		t.Fatalf("crypto.Sign: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("adapter sig != crypto.Sign\n got=%x\nwant=%x", got, want)
	}
	if len(got) != 65 {
		t.Fatalf("sig len = %d, want 65", len(got))
	}
	if got[64] > 1 {
		t.Fatalf("recovery id v = %d, want 0 or 1 (pre-+27)", got[64])
	}

	wantPub := crypto.FromECDSAPub(&priv.PublicKey)
	if !bytes.Equal(signer.PublicKeyUncompressed(), wantPub) {
		t.Fatalf("PublicKeyUncompressed mismatch\n got=%x\nwant=%x", signer.PublicKeyUncompressed(), wantPub)
	}
	if len(wantPub) != 65 || wantPub[0] != 0x04 {
		t.Fatalf("PublicKeyUncompressed not 65-byte 0x04||X||Y (len=%d)", len(wantPub))
	}
}

func TestNewECDSASigner_NilKeyFailsClosed(t *testing.T) {
	if _, err := NewECDSASigner(nil); err == nil {
		t.Fatal("expected error for nil private key")
	}
}
