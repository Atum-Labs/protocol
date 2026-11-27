package lddataintegrity

import (
	"bytes"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// Shared payment request vectors, computed with ethers v6 TypedDataEncoder (hashDomain and hash)
// over proofHash = 0x11…11 and docHash = 0x22…22. The TS twin pins the same values.
const (
	vectorPaymentRequestDomainSeparator     = "0x46511acc2ec7ae34fc8dfa9e2f8bfbe3b069a5f382bf745e99792dde537be52f"
	vectorPaymentRequestProofDigest         = "0x833afd335452f4ec0fb55c8d5604a840e14d3be0b9402b226f56f0c773990bc1"
	vectorPaymentRequestEnvelopeProofDigest = "0x3b2810486db3c482e5ef804385bc5022975680cb8271b4415abca5c912f296ec"
)

func TestPaymentRequestDomain_SentinelDerivation(t *testing.T) {
	want := common.BytesToAddress(crypto.Keccak256([]byte("atum.payment-request.v1"))[12:])
	if got := common.HexToAddress(PaymentRequestVerifyingContract); got != want {
		t.Fatalf("sentinel = %s, want %s", got.Hex(), want.Hex())
	}
	if PaymentRequestVerifyingContract != want.Hex() {
		t.Fatalf("sentinel constant %s is not the EIP-55 form %s", PaymentRequestVerifyingContract, want.Hex())
	}
}

func TestPaymentRequestDomain_Vectors(t *testing.T) {
	if got := "0x" + common.Bytes2Hex(PaymentRequestDomainSeparator()); got != vectorPaymentRequestDomainSeparator {
		t.Errorf("domain separator = %s, want %s", got, vectorPaymentRequestDomainSeparator)
	}
	proofHash, docHash := bytes.Repeat([]byte{0x11}, 32), bytes.Repeat([]byte{0x22}, 32)
	for _, tc := range []struct {
		name     string
		digestOf TypedProofDigest
		want     string
	}{
		{PaymentRequestProofPrimaryType, PaymentRequestProofTypedDigest, vectorPaymentRequestProofDigest},
		{PaymentRequestEnvelopeProofPrimaryType, PaymentRequestEnvelopeProofTypedDigest, vectorPaymentRequestEnvelopeProofDigest},
	} {
		got, err := tc.digestOf(proofHash, docHash)
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if "0x"+common.Bytes2Hex(got) != tc.want {
			t.Errorf("%s digest = 0x%x, want %s", tc.name, got, tc.want)
		}
	}
}

// The two primary types and the settler domain are three different digests of the same hashes, so a
// signature made for one never recovers its signer under another.
func TestPaymentRequestDomain_DigestsAreDistinct(t *testing.T) {
	proofHash, docHash := bytes.Repeat([]byte{0x11}, 32), bytes.Repeat([]byte{0x22}, 32)
	pr, _ := PaymentRequestProofTypedDigest(proofHash, docHash)
	pre, _ := PaymentRequestEnvelopeProofTypedDigest(proofHash, docHash)
	settler, _ := SettlerProofTypedDigest(proofHash, docHash)
	raw := crypto.Keccak256(proofHash, docHash)
	all := [][]byte{pr, pre, settler, raw}
	for i := range all {
		for j := i + 1; j < len(all); j++ {
			if bytes.Equal(all[i], all[j]) {
				t.Fatalf("digests %d and %d are equal: %x", i, j, all[i])
			}
		}
	}
}

func TestPaymentRequestDomain_RejectsBadLengths(t *testing.T) {
	if _, err := PaymentRequestProofTypedDigest(make([]byte, 31), make([]byte, 32)); err == nil {
		t.Error("PaymentRequestProofTypedDigest accepted a 31-byte proofHash")
	}
	if _, err := PaymentRequestEnvelopeProofTypedDigest(make([]byte, 32), make([]byte, 33)); err == nil {
		t.Error("PaymentRequestEnvelopeProofTypedDigest accepted a 33-byte docHash")
	}
}

func TestRecoverSecp256k1ProofSignerFrom(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	want := crypto.PubkeyToAddress(priv.PublicKey)
	matchesWant := func(a common.Address) bool { return a == want }
	hr := proofHashResult()
	sign := func(t *testing.T, digest []byte) []byte {
		t.Helper()
		sig, err := crypto.Sign(digest, priv)
		if err != nil {
			t.Fatal(err)
		}
		return sig
	}
	typedSig := func(t *testing.T, digestOf TypedProofDigest) []byte {
		t.Helper()
		digest, err := digestOf(hr.ProofHash, hr.DocHash)
		if err != nil {
			t.Fatal(err)
		}
		return sign(t, digest)
	}

	t.Run("raw signature verifies whatever forms are listed", func(t *testing.T) {
		got, err := RecoverSecp256k1ProofSignerFrom(hr, sign(t, hr.SigningInput), matchesWant, PaymentRequestProofTypedDigest)
		if err != nil || got != want {
			t.Fatalf("got %s, %v; want %s", got.Hex(), err, want.Hex())
		}
	})
	t.Run("typed signature verifies when its form is listed", func(t *testing.T) {
		got, err := RecoverSecp256k1ProofSignerFrom(hr, typedSig(t, PaymentRequestProofTypedDigest), matchesWant, PaymentRequestProofTypedDigest)
		if err != nil || got != want {
			t.Fatalf("got %s, %v; want %s", got.Hex(), err, want.Hex())
		}
	})
	t.Run("a later listed form is tried after an earlier one", func(t *testing.T) {
		got, err := RecoverSecp256k1ProofSignerFrom(hr, typedSig(t, PaymentRequestEnvelopeProofTypedDigest), matchesWant,
			SettlerProofTypedDigest, PaymentRequestEnvelopeProofTypedDigest)
		if err != nil || got != want {
			t.Fatalf("got %s, %v; want %s", got.Hex(), err, want.Hex())
		}
	})
	t.Run("typed signature of an unlisted form does not verify", func(t *testing.T) {
		got, err := RecoverSecp256k1ProofSignerFrom(hr, typedSig(t, PaymentRequestEnvelopeProofTypedDigest), matchesWant, PaymentRequestProofTypedDigest)
		if err != nil {
			t.Fatal(err)
		}
		if got == want {
			t.Fatal("a PaymentRequestEnvelopeProof signature recovered its signer as a PaymentRequestProof")
		}
	})
	t.Run("no typed form listed is the raw form alone", func(t *testing.T) {
		got, err := RecoverSecp256k1ProofSignerFrom(hr, typedSig(t, PaymentRequestProofTypedDigest), matchesWant)
		if err != nil {
			t.Fatal(err)
		}
		if got == want {
			t.Fatal("a typed signature recovered its signer with no typed form listed")
		}
	})
	t.Run("the settler recovery does not accept the payment request forms", func(t *testing.T) {
		for _, digestOf := range []TypedProofDigest{PaymentRequestProofTypedDigest, PaymentRequestEnvelopeProofTypedDigest} {
			got, err := RecoverSecp256k1ProofSigner(hr, typedSig(t, digestOf), matchesWant)
			if err != nil {
				t.Fatal(err)
			}
			if got == want {
				t.Fatal("RecoverSecp256k1ProofSigner accepted a payment request typed signature")
			}
		}
	})
	t.Run("raw recovery error is returned before any typed form", func(t *testing.T) {
		if _, err := RecoverSecp256k1ProofSignerFrom(hr, make([]byte, 64), matchesWant, PaymentRequestProofTypedDigest); err == nil {
			t.Fatal("a 64-byte signature recovered")
		}
	})
}
