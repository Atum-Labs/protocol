package senderauth

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// destinationVectors is the shared fixture at PaymentRequest/v1/conformance/destination-vectors.json,
// asserted by this suite and the TypeScript one. If a case fails, reconcile the implementations
// against the vector; do not edit the expectation to match the code.
type destinationVectors struct {
	MaxDestinationBytes int `json:"maxDestinationBytes"`
	Destinations        []struct {
		Asset   string `json:"asset"`
		Account string `json:"account"`
		Want    string `json:"want"`
		WantErr bool   `json:"wantErr"`
	} `json:"destinations"`
	DepositRequestHashes []struct {
		RequestID string `json:"requestId"`
		Want      string `json:"want"`
		WantErr   bool   `json:"wantErr"`
	} `json:"depositRequestHashes"`
}

func loadDestinationVectors(t *testing.T) destinationVectors {
	t.Helper()
	// senderauth -> sender-auth -> go -> bindings -> v1/conformance
	path := filepath.Join("..", "..", "..", "..", "conformance", "destination-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shared destination vectors at %s: %v", path, err)
	}
	var v destinationVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse shared destination vectors: %v", err)
	}
	if len(v.Destinations) == 0 || len(v.DepositRequestHashes) == 0 {
		// An empty fixture would make every assertion below vacuously pass.
		t.Fatalf("shared destination vectors are empty (%d destinations, %d hashes)",
			len(v.Destinations), len(v.DepositRequestHashes))
	}
	return v
}

func TestBuildEscrowDestinationMatchesSharedVectors(t *testing.T) {
	v := loadDestinationVectors(t)
	if MaxDestinationBytes != v.MaxDestinationBytes {
		t.Fatalf("MaxDestinationBytes = %d, shared fixture says %d",
			MaxDestinationBytes, v.MaxDestinationBytes)
	}
	for _, c := range v.Destinations {
		got, err := BuildEscrowDestination(c.Asset, c.Account)
		if c.WantErr {
			if err == nil {
				t.Errorf("BuildEscrowDestination(%q, %q) = %q, want an error", c.Asset, c.Account, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("BuildEscrowDestination(%q, %q) unexpected error: %v", c.Asset, c.Account, err)
			continue
		}
		if got != c.Want {
			t.Errorf("BuildEscrowDestination(%q, %q) = %q, want %q", c.Asset, c.Account, got, c.Want)
		}
	}
}

func TestDeriveDepositRequestHashMatchesSharedVectors(t *testing.T) {
	v := loadDestinationVectors(t)
	for _, c := range v.DepositRequestHashes {
		got, err := DeriveDepositRequestHash(c.RequestID)
		if c.WantErr {
			if err == nil {
				t.Errorf("DeriveDepositRequestHash(%q) = 0x%s, want an error",
					c.RequestID, hex.EncodeToString(got[:]))
			}
			continue
		}
		if err != nil {
			t.Errorf("DeriveDepositRequestHash(%q) unexpected error: %v", c.RequestID, err)
			continue
		}
		if want := "0x" + hex.EncodeToString(got[:]); want != c.Want {
			t.Errorf("DeriveDepositRequestHash(%q) = %s, want %s", c.RequestID, want, c.Want)
		}
	}
}

// The `<chain>:<ref>:<asset>` form is the malformed identifier a caller is most likely to
// produce, and other guards reject malformed shapes too, so assert the migration hint rather
// than merely an error.
func TestColonSeparatedSolanaAssetFormCarriesMigrationHint(t *testing.T) {
	_, err := BuildEscrowDestination("solana:ref:mint", "acct")
	if err == nil {
		t.Fatal("`<chain>:<ref>:<asset>` form was accepted; it must be rejected")
	}
	if want := "deprecated `<chain>:<ref>:<asset>` form"; !contains(err.Error(), want) {
		t.Errorf("error %q does not name the deprecated form; want it to contain %q", err, want)
	}
}

// A non-canonical chain namespace is rejected, never signed as written. Assert the specific
// error: other guards in caip2Namespace reject malformed shapes too.
func TestNonCanonicalChainNamespaceIsRejected(t *testing.T) {
	for _, asset := range []string{
		"EIP155:42220/erc20:0xabc",
		"Eip155:42220/erc20:0xabc",
		"SOLANA:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo",
		"Solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo",
		"Tron:0x2b6653dc/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
	} {
		got, err := BuildEscrowDestination(asset, "0xabc")
		if err == nil {
			t.Errorf("BuildEscrowDestination(%q, ...) = %q, want a rejection: the ratified "+
				"grammar requires a lowercase chain namespace", asset, got)
			continue
		}
		if want := "non-canonical chain namespace"; !contains(err.Error(), want) {
			t.Errorf("BuildEscrowDestination(%q, ...) error %q does not contain %q, so it was "+
				"rejected by some other guard rather than the casing rule", asset, err, want)
		}
	}
}

// The asset namespace half of the same rule: "token" and "Token" would hash to two different
// destinations for one payee. Assert the specific message, since the shared fixture's wantErr
// rows check only for an error.
func TestNonCanonicalAssetNamespaceIsRejected(t *testing.T) {
	for _, asset := range []string{
		"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/Token:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo",
		"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/TOKEN:A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo",
		"tron:0x2b6653dc/TRC20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
		// eip155 is held to the rule too, although its branch lowercases the whole side, so the
		// grammar has one policy for both halves.
		"eip155:8453/ERC20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
	} {
		got, err := BuildEscrowDestination(asset, "7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4")
		if err == nil {
			t.Errorf("BuildEscrowDestination(%q, ...) = %q, want a rejection: the ratified "+
				"grammar requires a lowercase asset namespace", asset, got)
			continue
		}
		if want := "non-canonical asset namespace"; !contains(err.Error(), want) {
			t.Errorf("BuildEscrowDestination(%q, ...) error %q does not contain %q, so it was "+
				"rejected by some other guard rather than the asset casing rule", asset, err, want)
		}
	}
}

// The over-rejection counterpart: the gate must not touch the asset reference, which is
// case-significant base58.
func TestCanonicalLowercaseAssetNamespaceStillComposes(t *testing.T) {
	const mint = "A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo"
	got, err := BuildEscrowDestination(
		"solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:"+mint,
		"7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4")
	if err != nil {
		t.Fatalf("canonical lowercase asset namespace was rejected: %v", err)
	}
	if !contains(got, "/token:"+mint) {
		t.Errorf("BuildEscrowDestination = %q: the asset namespace or its mixed-case base58 "+
			"reference was altered; only the namespace segment is subject to the casing rule", got)
	}
}

// The guard must not over-reject: a canonical lowercase namespace still composes, and eip155
// still lowercases its hex (not EIP-55).
func TestCanonicalLowercaseNamespaceStillComposes(t *testing.T) {
	got, err := BuildEscrowDestination(
		"eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		"0xC0FFEE254729296a45a3885639AC7E10F9d54979")
	if err != nil {
		t.Fatalf("canonical eip155 destination was rejected: %v", err)
	}
	want := "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@" +
		"0xc0ffee254729296a45a3885639ac7e10f9d54979"
	if got != want {
		t.Errorf("BuildEscrowDestination = %q, want %q", got, want)
	}
}

// Why non-canonical input is rejected rather than normalised: a Solana destination carries
// three case-significant base58 segments (the chain reference, the SPL mint and the account),
// and lowercasing would corrupt all three.
func TestSolanaDestinationPreservesEveryBase58Segment(t *testing.T) {
	const (
		genesisRef = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
		mint       = "A347WT7YBHsnBvy1g8ReHFBmfiLG3DKHr2mYRRmD4aEo"
		account    = "7hEM4QZEsz7e9BXXSxfbDLXi4GHt9dXwndvX3gr2uwX4"
	)
	got, err := BuildEscrowDestination("solana:"+genesisRef+"/token:"+mint, account)
	if err != nil {
		t.Fatalf("canonical solana destination was rejected: %v", err)
	}
	if want := "solana:" + genesisRef + "/token:" + mint + "@" + account; got != want {
		t.Fatalf("BuildEscrowDestination = %q, want %q", got, want)
	}
	// Named individually so a failure says WHICH segment was re-cased.
	for _, seg := range []struct{ name, value string }{
		{"CAIP-2 chain reference (genesis hash)", genesisRef},
		{"SPL mint (asset reference)", mint},
		{"account address", account},
	} {
		if !contains(got, seg.value) {
			t.Errorf("%s was not preserved byte-for-byte in %q; base58 is case-significant, "+
				"so re-casing it yields a different value and a different commitment",
				seg.name, got)
		}
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}

// Solidity measures bytes(destination).length, and the destination is printable ASCII, so one
// character is one byte.
func TestBuildEscrowDestinationBounds(t *testing.T) {
	prefix := "eip155:1/erc20:0xab@"
	built, err := BuildEscrowDestination("eip155:1/erc20:0xab", strings.Repeat("a", MaxDestinationBytes-len(prefix)))
	require.NoError(t, err)
	require.Len(t, built, MaxDestinationBytes)

	_, err = BuildEscrowDestination("eip155:1/erc20:0xab", strings.Repeat("a", MaxDestinationBytes-len(prefix)+1))
	require.ErrorContains(t, err, "256")

	_, err = BuildEscrowDestination("eip155:1/erc20:0xab", strings.Repeat("é", 10))
	require.ErrorContains(t, err, "printable ASCII")
}
