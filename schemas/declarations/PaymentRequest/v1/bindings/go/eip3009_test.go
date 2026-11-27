package paymentrequest

import (
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"testing"
)

func TestEIP3009TokensCopyMatchesSource(t *testing.T) {
	source, err := os.ReadFile("../../eip3009-tokens.json")
	if err != nil {
		t.Fatalf("read source list: %v", err)
	}
	if !bytes.Equal(source, eip3009TokensJSON) {
		t.Fatal("eip3009_tokens.json differs from ../../eip3009-tokens.json; run make -C schemas generate-go-bindings")
	}
}

func TestEIP3009TokensAreWellFormed(t *testing.T) {
	caip2 := regexp.MustCompile(`^eip155:[0-9]+$`)
	address := regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
	if len(eip3009Tokens) == 0 {
		t.Fatal("list is empty")
	}
	for chain, tokens := range eip3009Tokens {
		if !caip2.MatchString(chain) {
			t.Errorf("chain %q is not an EVM CAIP-2 ID; EIP-3009 is EVM only", chain)
		}
		if len(tokens) == 0 {
			t.Errorf("chain %s lists no tokens", chain)
		}
		seen := map[string]bool{}
		for _, token := range tokens {
			if token.Symbol == "" {
				t.Errorf("%s %s has no symbol", chain, token.Address)
			}
			if !address.MatchString(token.Address) {
				t.Errorf("%s %s: address %q is not 20-byte hex", chain, token.Symbol, token.Address)
			}
			key := string(bytes.ToLower([]byte(token.Address)))
			if seen[key] {
				t.Errorf("%s lists %s twice", chain, token.Address)
			}
			seen[key] = true
		}
	}
}

func TestSupportsEIP3009(t *testing.T) {
	cases := []struct {
		name    string
		chain   string
		address string
		want    bool
	}{
		{"listed", "eip155:84532", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", true},
		{"listed lowercase", "eip155:84532", "0x036cbd53842c5426634e7929541ec2318f3dcf7e", true},
		{"listed on another chain only", "eip155:8453", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", false},
		{"USDT on Ethereum", "eip155:1", "0xdAC17F958D2ee523a2206206994597C13D831ec7", false},
		{"Tempo USDC.e", "eip155:4217", "0x20C000000000000000000000b9537d11c60E8b50", false},
		{"unknown chain", "eip155:999999", "0x036CbD53842c5426634e7929541eC2318f3dCF7e", false},
		{"empty", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SupportsEIP3009(tc.chain, tc.address); got != tc.want {
				t.Fatalf("SupportsEIP3009(%q, %q) = %v, want %v", tc.chain, tc.address, got, tc.want)
			}
		})
	}
}

func TestEIP3009TokensReturnsCopy(t *testing.T) {
	tokens := EIP3009Tokens()
	tokens["eip155:84532"][0].Address = "0x0000000000000000000000000000000000000000"
	delete(tokens, "eip155:1")
	if !SupportsEIP3009("eip155:84532", "0x036CbD53842c5426634e7929541eC2318f3dCF7e") {
		t.Fatal("mutating the returned map changed the package list")
	}
	if _, ok := EIP3009Tokens()["eip155:1"]; !ok {
		t.Fatal("deleting from the returned map changed the package list")
	}
}

func TestFulfillsAsOriginator(t *testing.T) {
	decode := func(s string) any {
		var v any
		if err := json.Unmarshal([]byte(s), &v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	cases := []struct {
		name     string
		executor any
		want     bool
	}{
		{"absent", nil, false},
		{"settler", "settler", false},
		{"originator", "originator", true},
		{"split originator fulfill", decode(`{"deposit":"settler","reserve":"settler","fulfill":"originator"}`), true},
		{"split settler fulfill", decode(`{"deposit":"originator","reserve":"originator","fulfill":"settler"}`), false},
		{"unknown type", 1, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := FulfillsAsOriginator(tc.executor); got != tc.want {
				t.Fatalf("FulfillsAsOriginator(%v) = %v, want %v", tc.executor, got, tc.want)
			}
		})
	}
}

func TestDepositsAsOriginator(t *testing.T) {
	decode := func(s string) any {
		var v any
		if err := json.Unmarshal([]byte(s), &v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	cases := []struct {
		name     string
		executor any
		want     bool
	}{
		{"absent", nil, false},
		{"settler", "settler", false},
		{"originator", "originator", true},
		{"split originator deposit", decode(`{"deposit":"originator","reserve":"settler","fulfill":"originator"}`), true},
		{"split settler deposit", decode(`{"deposit":"settler","reserve":"settler","fulfill":"originator"}`), false},
		{"unknown type", 1, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := DepositsAsOriginator(tc.executor); got != tc.want {
				t.Fatalf("DepositsAsOriginator(%v) = %v, want %v", tc.executor, got, tc.want)
			}
		})
	}
}
