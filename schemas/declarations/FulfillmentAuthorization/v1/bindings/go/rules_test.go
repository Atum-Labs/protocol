package fulfillmentauthorization

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// settlerKey is Hardhat account #0, the settler in the conformance vectors.
const settlerKey = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

type conformanceVector struct {
	File          string `json:"file"`
	Valid         bool   `json:"valid"`
	Description   string `json:"description"`
	ErrorContains string `json:"error_contains"`
	// ContractSignaturesAllowed is the verdict when the caller passes AllowContractSignature.
	// Absent means the option does not change this vector, so it runs only in the default mode.
	ContractSignaturesAllowed *conformanceVerdict `json:"contract_signatures_allowed"`
}

type conformanceVerdict struct {
	Valid         bool   `json:"valid"`
	Description   string `json:"description"`
	ErrorContains string `json:"error_contains"`
}

// expectVerdict asserts one verdict, so the default and the opt-in are checked the same way.
func expectVerdict(t *testing.T, err error, valid bool, errorContains, description string) {
	t.Helper()
	if valid {
		if err != nil {
			t.Fatalf("%s: %v", description, err)
		}
		return
	}
	// Case-insensitive: the two schema validators spell the same refusal differently
	// ("Additional property ..." against "must NOT have additional properties"), and one
	// manifest phrase has to hold for both languages.
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(errorContains)) {
		t.Fatalf("%s: want an error containing %q, got %v", description, errorContains, err)
	}
}

func TestConformanceVectors(t *testing.T) {
	var vectors []conformanceVector
	if err := json.Unmarshal(readConformance(t, "vectors.json"), &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors) == 0 {
		t.Fatal("no conformance vectors")
	}
	for _, vector := range vectors {
		t.Run(vector.File, func(t *testing.T) {
			raw := readConformance(t, vector.File)
			expectVerdict(t, Validate(raw), vector.Valid, vector.ErrorContains, vector.Description)

			// A vector that names a second verdict is run both ways, so the option is covered by
			// the same oracle as the default and cannot quietly stop mattering.
			if vector.ContractSignaturesAllowed != nil {
				expectVerdict(t, Validate(raw, AllowContractSignature()),
					vector.ContractSignaturesAllowed.Valid,
					vector.ContractSignaturesAllowed.ErrorContains,
					vector.Description+" (with AllowContractSignature)")
			}
		})
	}
}

// Every fixture is listed in the manifest, so neither language can run a vector the other skips.
// The manifest is the shared oracle: both suites assert each vector's verdict against it, which
// only holds the two in step for the vectors both actually run. An unlisted file would be skipped
// silently by both, and a file listed but absent would pass vacuously.
func TestConformanceManifestCoversEveryFixture(t *testing.T) {
	var vectors []conformanceVector
	if err := json.Unmarshal(readConformance(t, "vectors.json"), &vectors); err != nil {
		t.Fatal(err)
	}
	// chain-vectors.json is the second manifest: the same documents judged with a chain reader.
	listed := map[string]bool{"vectors.json": true, "chain-vectors.json": true}
	for _, vector := range vectors {
		listed[vector.File] = true
	}
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("caller")
	}
	entries, err := os.ReadDir(filepath.Join(filepath.Dir(filename), "..", "..", "conformance", "fixtures"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !listed[entry.Name()] {
			t.Errorf("fixture %s is not listed in vectors.json, so only one language may be running it", entry.Name())
		}
	}
}

// SOROBAN-AUTH is a scheme the schema names and the validators do not implement. It has to get past
// the schema, so a Stellar document is refused for the right reason, and it must not fall through
// to the EIP-3009 parser: a settler-signed EIP-3009 document relabelled with it is still refused.
func TestSorobanAuthSchemeIsNamedButNotImplemented(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal(readConformance(t, "settler-signed-declaration-only.json"), &doc); err != nil {
		t.Fatal(err)
	}
	doc["scheme"] = "SOROBAN-AUTH"
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	err = Validate(raw)
	if err == nil || !strings.Contains(err.Error(), `scheme "SOROBAN-AUTH" is not implemented`) {
		t.Fatalf("want a not-implemented refusal, got %v", err)
	}
	if !errors.Is(err, ErrSchemeNotImplemented) {
		t.Fatalf("the refusal must wrap ErrSchemeNotImplemented so a caller can tell it from malformed, got %v", err)
	}

	doc["scheme"] = "SOROBAN-AUTH-TYPO"
	raw, err = json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err = Validate(raw); err == nil || strings.Contains(err.Error(), "is not implemented") || errors.Is(err, ErrSchemeNotImplemented) {
		t.Fatalf("want the schema to refuse an unnamed scheme, got %v", err)
	}
}

// A document of an implemented scheme that passes the schema and fails a binding rule is a refusal,
// and it is not ErrSchemeNotImplemented: a caller that defers to a scheme-specific verifier on the
// sentinel must never be sent there by a rule failure. The document is re-signed after the edit, so
// the rule, not the digest or the signature, is what refuses it. (Deleting a required member would
// not do: the schema refuses that before the scheme lookup, and never reaches the rules.)
func TestRuleFailureOfAnImplementedSchemeIsNotSchemeNotImplemented(t *testing.T) {
	doc := settlerSigned(t)
	typed := typedData(t, doc)
	message(typed)["value"] = "99999"
	resign(t, doc, typed)
	err := validate(t, doc)
	if err == nil || !strings.Contains(err.Error(), "does not equal fulfillment_amount") {
		t.Fatalf("want the amount rule to refuse the re-signed document, got %v", err)
	}
	if errors.Is(err, ErrSchemeNotImplemented) {
		t.Fatalf("a rule failure must not wrap ErrSchemeNotImplemented, got %v", err)
	}
}

// Rules the vectors do not cover, each on a settler-signed document re-signed after the edit
// so that the rule under test, not the digest or signature check, is what rejects it.
func TestValidateEIP3009Rules(t *testing.T) {
	cases := []struct {
		name    string
		edit    func(doc, typed map[string]any)
		wantErr string
	}{
		{"amount", func(_, typed map[string]any) { message(typed)["value"] = "99999" }, "does not equal fulfillment_amount"},
		{"asset", func(_, typed map[string]any) {
			typed["domain"].(map[string]any)["verifyingContract"] = "0x0000000000000000000000000000000000000009"
		}, "domain.verifyingContract 0x0000000000000000000000000000000000000009 is not the quote destination's token"},
		{"chain", func(_, typed map[string]any) { typed["domain"].(map[string]any)["chainId"] = 8453 }, "domain.chainId 8453 is not the quote destination's chain eip155:84532"},
		// The domain binds to the token by address; the asset namespace is the shared asset rule's.
		{"destination asset namespace", func(doc, _ map[string]any) {
			var quote map[string]any
			if err := json.Unmarshal([]byte(doc["fulfillment_quote_json"].(string)), &quote); err != nil {
				panic(err)
			}
			destination := quote["destination"].(map[string]any)
			destination["id"] = strings.Replace(destination["id"].(string), "/erc20:", "/erc721:", 1)
			quoteJSON, err := json.Marshal(quote)
			if err != nil {
				panic(err)
			}
			doc["fulfillment_quote_json"] = string(quoteJSON)
		}, "does not equal quote destination"},
		// Neither U+FEFF nor U+0085 is ASCII whitespace, so a destination led by one is refused in
		// both languages; strings.TrimSpace and JavaScript's trim() each strip only one of them.
		{"destination led by U+FEFF", func(doc, _ map[string]any) { padDestination(doc, "\ufeff", "") }, "domain.chainId 84532 is not the quote destination's chain"},
		{"destination led by U+0085", func(doc, _ map[string]any) { padDestination(doc, "\u0085", "") }, "domain.chainId 84532 is not the quote destination's chain"},
		{"recipient", func(_, typed map[string]any) {
			message(typed)["to"] = "0x0000000000000000000000000000000000000009"
		}, "does not equal a payment request destination"},
		{"valid after equals valid before", func(_, typed map[string]any) {
			message(typed)["validAfter"] = message(typed)["validBefore"]
		}, "validAfter must be 0"},
		{"non-canonical value", func(_, typed map[string]any) { message(typed)["value"] = "0100000" }, "uint256 decimal strings"},
		{"extra domain field", func(_, typed map[string]any) {
			typed["domain"].(map[string]any)["salt"] = "0x" + strings.Repeat("00", 32)
		}, "not EIP-3009 typed data"},
		{"other primary type", func(_, typed map[string]any) { typed["primaryType"] = "ReceiveWithAuthorization" }, "primaryType"},
		{"payload beside message_prehash", func(doc, _ map[string]any) {
			doc["authorization"].(map[string]any)["payload"] = map[string]any{}
		}, "must not carry payload"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			doc := settlerSigned(t)
			typed := typedData(t, doc)
			tc.edit(doc, typed)
			resign(t, doc, typed)
			err := validate(t, doc)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("want an error containing %q, got %v", tc.wantErr, err)
			}
			if errors.Is(err, ErrSchemeNotImplemented) {
				t.Fatalf("a rule failure must not wrap ErrSchemeNotImplemented, got %v", err)
			}
		})
	}
}

// A destination id padded with spaces is the same asset and chain, as it is for the shared asset
// rule, in both languages. (Tab, CR and LF padding never gets this far: the quote's canonicalizer
// refuses them first.)
func TestValidateAcceptsAsciiPaddedDestination(t *testing.T) {
	for _, pad := range []string{" ", "   "} {
		doc := settlerSigned(t)
		padDestination(doc, pad, pad)
		resign(t, doc, typedData(t, doc))
		if err := validate(t, doc); err != nil {
			t.Fatalf("destination padded with %q should validate: %v", pad, err)
		}
	}
}

// padDestination wraps the quote's destination id in the given prefix and suffix.
func padDestination(doc map[string]any, prefix, suffix string) {
	var quote map[string]any
	if err := json.Unmarshal([]byte(doc["fulfillment_quote_json"].(string)), &quote); err != nil {
		panic(err)
	}
	destination := quote["destination"].(map[string]any)
	destination["id"] = prefix + destination["id"].(string) + suffix
	quoteJSON, err := json.Marshal(quote)
	if err != nil {
		panic(err)
	}
	doc["fulfillment_quote_json"] = string(quoteJSON)
}

func TestValidateRejectsHighS(t *testing.T) {
	doc := settlerSigned(t)
	authorization := doc["authorization"].(map[string]any)
	sig := common.FromHex(authorization["signature"].(string))
	s := new(big.Int).SetBytes(sig[32:64])
	copy(sig[32:64], common.LeftPadBytes(new(big.Int).Sub(crypto.S256().Params().N, s).Bytes(), 32))
	sig[64] = 55 - sig[64] // 27 <-> 28: the same signer, as a high-s signature
	authorization["signature"] = hexutilEncode(sig)
	if err := validate(t, doc); err == nil || !strings.Contains(err.Error(), "not a canonical secp256k1 signature") {
		t.Fatalf("want a high-s rejection, got %v", err)
	}
}

func TestValidateAcceptsResignedDocument(t *testing.T) {
	doc := settlerSigned(t)
	resign(t, doc, typedData(t, doc))
	if err := validate(t, doc); err != nil {
		t.Fatalf("re-signing the unchanged typed data should still validate: %v", err)
	}
}

func readConformance(t *testing.T, name string) []byte {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("caller")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(filename), "..", "..", "conformance", "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func settlerSigned(t *testing.T) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(readConformance(t, "settler-signed.json"), &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func typedData(t *testing.T, doc map[string]any) map[string]any {
	t.Helper()
	var typed map[string]any
	if err := json.Unmarshal([]byte(doc["authorization"].(map[string]any)["message_prehash"].(string)), &typed); err != nil {
		t.Fatal(err)
	}
	return typed
}

func message(typed map[string]any) map[string]any {
	return typed["message"].(map[string]any)
}

// resign writes typed back as message_prehash and signs it with the settler's key. When the
// edited typed data no longer decodes, the digest and signature are left as they were, so
// the decode error is what the validator reports.
func resign(t *testing.T, doc, typed map[string]any) {
	t.Helper()
	prehash, err := json.Marshal(typed)
	if err != nil {
		t.Fatal(err)
	}
	authorization := doc["authorization"].(map[string]any)
	authorization["message_prehash"] = string(prehash)
	decoded, err := decodeEIP3009(string(prehash))
	if err != nil {
		return
	}
	digest := decoded.digest
	key, err := crypto.HexToECDSA(settlerKey)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := crypto.Sign(digest, key)
	if err != nil {
		t.Fatal(err)
	}
	sig[64] += 27
	authorization["message"] = hexutilEncode(digest)
	authorization["signature"] = hexutilEncode(sig)
}

func validate(t *testing.T, doc map[string]any) error {
	t.Helper()
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return Validate(raw)
}

func hexutilEncode(b []byte) string {
	return fmt.Sprintf("0x%x", b)
}

// CORE-2955's reproduction: before strict became the default, each of these passed Validate on a
// document whose settler is an EOA, so a pass did not show the settler signed. The option is the
// only way back to that behaviour.
func TestNonEOASignatureRefusedByDefault(t *testing.T) {
	cases := map[string]string{
		"one byte":       "0x11",
		"64 bytes":       "0x" + strings.Repeat("ab", 64),
		"100 bytes":      "0x" + strings.Repeat("cd", 100),
		"odd length":     "0x" + strings.Repeat("ab", 32) + "a",
		"not hex at all": "deadbeef",
		"empty but 0x":   "0x",
	}
	for name, signature := range cases {
		t.Run(name, func(t *testing.T) {
			doc := settlerSigned(t)
			doc["authorization"].(map[string]any)["signature"] = signature
			raw, err := json.Marshal(doc)
			if err != nil {
				t.Fatal(err)
			}
			if err := Validate(raw); err == nil {
				t.Fatal("accepted a signature nobody verified, on an EOA settler's document")
			}
			// The empty and non-hex cases stay refused even when the caller allows a contract
			// signature: there is nothing there to hand the token.
			err = Validate(raw, AllowContractSignature())
			switch name {
			case "not hex at all", "empty but 0x":
				if err == nil {
					t.Fatal("allowed a signature with no bytes to verify")
				}
			default:
				if err != nil {
					t.Fatalf("AllowContractSignature should accept this on the token's authority: %v", err)
				}
			}
		})
	}
}
