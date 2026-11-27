package stellar_escrow_encoding

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// strkeyVectors is contracts/stellar/conformance/strkey-vectors.json, the one file every hand-written
// strkey decoder in this repo is tested against: this package (the single Go decoder), its TypeScript
// sibling, and the chain-address and FulfillmentQuote signing packages, which call it.
type strkeyVectors struct {
	Valid []struct {
		Name       string `json:"name"`
		Address    string `json:"address"`
		Kind       string `json:"kind"`
		PayloadHex string `json:"payloadHex"`
	} `json:"valid"`
	Invalid []struct {
		Name    string `json:"name"`
		Address string `json:"address"`
		Error   string `json:"error"`
	} `json:"invalid"`
}

func loadStrkeyVectors(t *testing.T) strkeyVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "conformance", "strkey-vectors.json"))
	if err != nil {
		t.Fatalf("read strkey vectors: %v", err)
	}
	var v strkeyVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse strkey vectors: %v", err)
	}
	if len(v.Valid) == 0 || len(v.Invalid) == 0 {
		t.Fatal("strkey vector tables are empty, so this test proves nothing")
	}
	return v
}

func TestStrkeyVectorsValid(t *testing.T) {
	for _, c := range loadStrkeyVectors(t).Valid {
		t.Run(c.Name, func(t *testing.T) {
			got, err := ParseAddress(c.Address)
			if err != nil {
				t.Fatalf("ParseAddress(%q): %v", c.Address, err)
			}
			wantType := map[string]AddressType{"account": AccountAddress, "contract": ContractAddress}[c.Kind]
			if got.Type != wantType || hex.EncodeToString(got.Key[:]) != c.PayloadHex {
				t.Errorf("decoded to %d/%x, want %s/%s", got.Type, got.Key, c.Kind, c.PayloadHex)
			}
			if got.String() != c.Address {
				t.Errorf("re-encoded to %s, want %s", got.String(), c.Address)
			}
		})
	}
}

func TestStrkeyVectorsInvalid(t *testing.T) {
	want := map[string]error{"invalid_strkey": ErrInvalidStrkey, "unsupported_address": ErrUnsupportedAddress}
	for _, c := range loadStrkeyVectors(t).Invalid {
		t.Run(c.Name, func(t *testing.T) {
			target, ok := want[c.Error]
			if !ok {
				t.Fatalf("unknown error class %q in the vector file", c.Error)
			}
			_, err := ParseAddress(c.Address)
			if !errors.Is(err, target) {
				t.Errorf("ParseAddress(%q) = %v, want %v", c.Address, err, target)
			}
		})
	}
}
