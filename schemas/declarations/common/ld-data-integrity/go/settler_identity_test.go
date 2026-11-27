package lddataintegrity

import (
	"bytes"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// Shared settler identity vectors, computed with ethers v6 TypedDataEncoder.hash.
const (
	vectorDomainSeparator    = "0xedd0bf5f50d6e9b28d004421809379ed0faf50b860ce2e99d7ba54c0b7badeac"
	vectorSettlerProofDigest = "0x073a9ae5f5f24d3e1e2264d95d0b4721e23c6550288c210e8eb35b0d5869b0e2"
	vectorWalletProofDigest  = "0x2504f2b96d7675eaa3b4ea78c60d977a259301bd804e8ad5705efe3bc41b10c6"
)

func TestSettlerIdentity_SentinelDerivation(t *testing.T) {
	want := common.BytesToAddress(crypto.Keccak256([]byte("atum.settler.identity.v1"))[12:])
	if got := common.HexToAddress(SettlerIdentityVerifyingContract); got != want {
		t.Fatalf("sentinel = %s, want %s", got.Hex(), want.Hex())
	}
	if SettlerIdentityVerifyingContract != want.Hex() {
		t.Fatalf("sentinel constant %s is not the EIP-55 form %s", SettlerIdentityVerifyingContract, want.Hex())
	}
}

func TestSettlerIdentity_Vectors(t *testing.T) {
	if got := common.Bytes2Hex(SettlerIdentityDomainSeparator()); "0x"+got != vectorDomainSeparator {
		t.Errorf("domain separator = 0x%s, want %s", got, vectorDomainSeparator)
	}
	sp, err := SettlerProofTypedDigest(bytes.Repeat([]byte{0x11}, 32), bytes.Repeat([]byte{0x22}, 32))
	if err != nil {
		t.Fatalf("SettlerProofTypedDigest: %v", err)
	}
	if got := "0x" + common.Bytes2Hex(sp); got != vectorSettlerProofDigest {
		t.Errorf("SettlerProof digest = %s, want %s", got, vectorSettlerProofDigest)
	}
	wp, err := WalletProofTypedDigest(bytes.Repeat([]byte{0x33}, 32))
	if err != nil {
		t.Fatalf("WalletProofTypedDigest: %v", err)
	}
	if got := "0x" + common.Bytes2Hex(wp); got != vectorWalletProofDigest {
		t.Errorf("WalletProof digest = %s, want %s", got, vectorWalletProofDigest)
	}
}

func TestSettlerIdentity_RejectsBadLengths(t *testing.T) {
	if _, err := SettlerProofTypedDigest(make([]byte, 31), make([]byte, 32)); err == nil {
		t.Error("SettlerProofTypedDigest accepted a 31-byte proofHash")
	}
	if _, err := WalletProofTypedDigest(make([]byte, 33)); err == nil {
		t.Error("WalletProofTypedDigest accepted a 33-byte digest")
	}
}

func proofHashResult() HashResult {
	proofHash := crypto.Keccak256([]byte("proof options"))
	docHash := crypto.Keccak256([]byte("document"))
	return HashResult{
		SigningInput: crypto.Keccak256(proofHash, docHash),
		Cryptosuite:  CryptosuiteSecp256k1Recovery2020,
		ProofHash:    proofHash,
		DocHash:      docHash,
	}
}

func TestRecoverSecp256k1ProofSigner_DualAccept(t *testing.T) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	want := crypto.PubkeyToAddress(priv.PublicKey)
	matchesWant := func(a common.Address) bool { return a == want }
	hr := proofHashResult()

	t.Run("legacy signature verifies", func(t *testing.T) {
		sig, err := crypto.Sign(hr.SigningInput, priv)
		if err != nil {
			t.Fatal(err)
		}
		got, err := RecoverSecp256k1ProofSigner(hr, sig, matchesWant)
		if err != nil || got != want {
			t.Fatalf("got %s, %v; want %s", got.Hex(), err, want.Hex())
		}
	})

	t.Run("typed signature verifies", func(t *testing.T) {
		digest, err := SettlerProofTypedDigest(hr.ProofHash, hr.DocHash)
		if err != nil {
			t.Fatal(err)
		}
		sig, err := crypto.Sign(digest, priv)
		if err != nil {
			t.Fatal(err)
		}
		got, err := RecoverSecp256k1ProofSigner(hr, sig, matchesWant)
		if err != nil || got != want {
			t.Fatalf("got %s, %v; want %s", got.Hex(), err, want.Hex())
		}
	})

	t.Run("typed signature by the wrong key fails", func(t *testing.T) {
		other, err := crypto.GenerateKey()
		if err != nil {
			t.Fatal(err)
		}
		digest, err := SettlerProofTypedDigest(hr.ProofHash, hr.DocHash)
		if err != nil {
			t.Fatal(err)
		}
		sig, err := crypto.Sign(digest, other)
		if err != nil {
			t.Fatal(err)
		}
		got, err := RecoverSecp256k1ProofSigner(hr, sig, matchesWant)
		if err != nil {
			t.Fatalf("unexpected recovery error: %v", err)
		}
		if got == want {
			t.Fatal("a typed signature by another key matched the expected signer")
		}
		legacy, _ := RecoverSecp256k1Signer(hr.SigningInput, sig)
		if got != legacy {
			t.Fatalf("mismatch should return the legacy recovery %s, got %s", legacy.Hex(), got.Hex())
		}
	})
}
