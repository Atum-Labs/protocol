package verifill

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

const signatureVectorsPath = "../../conformance/verdict-signature-vectors.json"

type signatureVectors struct {
	EIP712 struct {
		DomainType      string `json:"domainType"`
		DomainName      string `json:"domainName"`
		DomainVersion   string `json:"domainVersion"`
		FulfillmentType string `json:"fulfillmentType"`
		DepositType     string `json:"depositType"`
	} `json:"eip712"`
	Vectors []signatureVector `json:"vectors"`
}

type signatureVector struct {
	Name            string          `json:"name"`
	Kind            string          `json:"kind"`
	Verdict         json.RawMessage `json:"verdict"`
	TypedData       json.RawMessage `json:"typedData"`
	SigningInputHex string          `json:"signingInputHex"`
	Signer          string          `json:"signer"`
}

func loadSignatureVectors(t *testing.T) signatureVectors {
	t.Helper()
	raw, err := os.ReadFile(signatureVectorsPath)
	if err != nil {
		t.Fatalf("read %s: %v", signatureVectorsPath, err)
	}
	var v signatureVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode %s: %v", signatureVectorsPath, err)
	}
	return v
}

// assertTypedDataMatches compares the binding's typed data with the payload the independent
// signer signed, as JSON, so a producer handing ours to a typed-data signer signs the same thing.
func assertTypedDataMatches(t *testing.T, got TypedData, want json.RawMessage) {
	t.Helper()
	blob, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var g, w any
	if err := json.Unmarshal(blob, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatalf("vector typedData: %v", err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Errorf("typed data drifted\n got %s\nwant %s", blob, want)
	}
}

// typedDataDigest hashes an exported TypedData payload on its own, from its types, domain and
// message alone, so the payload handed to a signer is proven to hash to the signed digest.
func typedDataDigest(t *testing.T, td TypedData) []byte {
	t.Helper()
	if !reflect.DeepEqual(td.Types["EIP712Domain"], eip712DomainFields) {
		t.Fatalf("typed data domain type is %v", td.Types["EIP712Domain"])
	}
	fields := td.Types[td.PrimaryType]
	members := make([]typedMember, len(fields))
	for i, f := range fields {
		value, ok := td.Message[f.Name].(string)
		if !ok {
			t.Fatalf("message member %s is %T, want a string", f.Name, td.Message[f.Name])
		}
		members[i] = typedMember{name: f.Name, typ: f.Type, value: value}
	}
	chainWord, err := encodeUint256("chainId", td.Domain.ChainId)
	if err != nil {
		t.Fatal(err)
	}
	domainSeparator := keccak256(
		keccak256([]byte(encodeType("EIP712Domain", td.Types["EIP712Domain"]))),
		keccak256([]byte(td.Domain.Name)),
		keccak256([]byte(td.Domain.Version)),
		chainWord,
	)
	encoded := [][]byte{keccak256([]byte(encodeType(td.PrimaryType, fields)))}
	for _, m := range members {
		if m.typ == "bytes32" || m.typ == "address" {
			raw, err := hex.DecodeString(strings.TrimPrefix(m.value, "0x"))
			if err != nil {
				t.Fatalf("message member %s: %v", m.name, err)
			}
			encoded = append(encoded, append(make([]byte, 32-len(raw)), raw...))
			continue
		}
		word, _, err := encodeTypedValue(m)
		if err != nil {
			t.Fatalf("message member %s: %v", m.name, err)
		}
		encoded = append(encoded, word)
	}
	return keccak256([]byte{0x19, 0x01}, domainSeparator, keccak256(encoded...))
}

// TestVerdictSignatureVectors checks the binding against signatures made by independent signers:
// the signing input it derives, the typed data it hands a producer, and that it accepts each
// signature under the published signer and refuses it once a signed member changes.
func TestVerdictSignatureVectors(t *testing.T) {
	vectors := loadSignatureVectors(t)

	fulfillmentFields := encodeType(fulfillmentVerdictPrimaryType, typedFields(fulfillmentTypedMembers(&FulfillmentVerdict{})))
	depositFields := encodeType(depositVerdictPrimaryType, typedFields(depositTypedMembers(&DepositVerdict{})))
	for name, pair := range map[string][2]string{
		"domain type":      {encodeType("EIP712Domain", eip712DomainFields), vectors.EIP712.DomainType},
		"domain name":      {verdictTypedDataName, vectors.EIP712.DomainName},
		"domain version":   {verdictTypedDataVersion, vectors.EIP712.DomainVersion},
		"fulfillment type": {fulfillmentFields, vectors.EIP712.FulfillmentType},
		"deposit type":     {depositFields, vectors.EIP712.DepositType},
	} {
		if pair[0] != pair[1] {
			t.Errorf("%s: binding %q, independent signer %q", name, pair[0], pair[1])
		}
	}

	seen := map[string]bool{}
	for _, c := range vectors.Vectors {
		seen[c.Name] = true
		t.Run(c.Name, func(t *testing.T) {
			switch c.Kind {
			case "fulfillment":
				v, err := DecodeVerdict(c.Verdict)
				if err != nil {
					t.Fatalf("DecodeVerdict: %v", err)
				}
				if err := ValidateVerdictMembers(v); err != nil {
					t.Fatalf("ValidateVerdictMembers: %v", err)
				}
				digest, err := VerdictSigningDigest(v)
				if err != nil {
					t.Fatalf("VerdictSigningDigest: %v", err)
				}
				if got := hex.EncodeToString(digest); got != c.SigningInputHex {
					t.Errorf("signing input drifted\n got %s\nwant %s", got, c.SigningInputHex)
				}
				if v.SignatureScheme == VerdictSignatureSchemeEip712Secp256k1 {
					td, err := VerdictTypedData(v)
					if err != nil {
						t.Fatalf("VerdictTypedData: %v", err)
					}
					assertTypedDataMatches(t, td, c.TypedData)
					if got := hex.EncodeToString(typedDataDigest(t, td)); got != c.SigningInputHex {
						t.Errorf("VerdictTypedData hashes to %s, want %s", got, c.SigningInputHex)
					}
				}
				if err := VerifyVerdictSignature(v, c.Signer); err != nil {
					t.Fatalf("an independently made signature was rejected: %v", err)
				}
				tampered := *v
				tampered.BlockNumber += "1"
				if err := VerifyVerdictSignature(&tampered, c.Signer); err == nil {
					t.Error("the signature still verified after a signed member changed")
				}
			case "deposit":
				v, err := DecodeDepositVerdict(c.Verdict)
				if err != nil {
					t.Fatalf("DecodeDepositVerdict: %v", err)
				}
				if err := ValidateDepositVerdictMembers(v); err != nil {
					t.Fatalf("ValidateDepositVerdictMembers: %v", err)
				}
				digest, err := DepositVerdictSigningDigest(v)
				if err != nil {
					t.Fatalf("DepositVerdictSigningDigest: %v", err)
				}
				if got := hex.EncodeToString(digest); got != c.SigningInputHex {
					t.Errorf("signing input drifted\n got %s\nwant %s", got, c.SigningInputHex)
				}
				if v.SignatureScheme == VerdictSignatureSchemeEip712Secp256k1 {
					td, err := DepositVerdictTypedData(v)
					if err != nil {
						t.Fatalf("DepositVerdictTypedData: %v", err)
					}
					assertTypedDataMatches(t, td, c.TypedData)
					if got := hex.EncodeToString(typedDataDigest(t, td)); got != c.SigningInputHex {
						t.Errorf("DepositVerdictTypedData hashes to %s, want %s", got, c.SigningInputHex)
					}
				}
				if err := VerifyDepositVerdictSignature(v, c.Signer); err != nil {
					t.Fatalf("an independently made signature was rejected: %v", err)
				}
				tampered := *v
				tampered.BlockNumber += "1"
				if err := VerifyDepositVerdictSignature(&tampered, c.Signer); err == nil {
					t.Error("the signature still verified after a signed member changed")
				}
			default:
				t.Fatalf("unknown vector kind %q", c.Kind)
			}
		})
	}

	// Each scheme and both kinds are covered, so dropping a vector cannot pass silently.
	for _, name := range []string{
		"eip155/fulfillment/delivered",
		"eip155/fulfillment/not-delivered",
		"eip155/deposit/held",
		"tron/fulfillment/delivered",
		"tron/deposit/held",
		"solana/fulfillment/delivered",
		"solana/deposit/held",
	} {
		if !seen[name] {
			t.Errorf("signature vector %q is missing", name)
		}
	}
}

// TestVerdictTypedDataRefusesAnAmbiguousSpelling pins the injectivity the typed data relies on:
// empty is the only spelling of a zero member, and hex has one case.
func TestVerdictTypedDataRefusesAnAmbiguousSpelling(t *testing.T) {
	vectors := loadSignatureVectors(t)
	var base *FulfillmentVerdict
	for _, c := range vectors.Vectors {
		if c.Name == "eip155/fulfillment/not-delivered" {
			v, err := DecodeVerdict(c.Verdict)
			if err != nil {
				t.Fatal(err)
			}
			base = v
		}
	}
	if base == nil {
		t.Fatal("no eip155 not-delivered vector")
	}
	if _, err := VerdictTypedData(base); err != nil {
		t.Fatalf("the vector itself was refused: %v", err)
	}
	for name, mutate := range map[string]func(v *FulfillmentVerdict){
		"zero transaction hash spelled out": func(v *FulfillmentVerdict) { v.TransactionHash = "0x" + strings.Repeat("0", 64) },
		"zero fulfiller spelled out":        func(v *FulfillmentVerdict) { v.Fulfiller = "0x" + strings.Repeat("0", 40) },
		"uppercase block hash":              func(v *FulfillmentVerdict) { v.BlockHash = "0x" + strings.Repeat("A", 64) },
		"leading zero block number":         func(v *FulfillmentVerdict) { v.BlockNumber = "0" + v.BlockNumber },
		"non-eip155 chain":                  func(v *FulfillmentVerdict) { v.ChainId = "tron:mainnet" },
		"hex chain reference":               func(v *FulfillmentVerdict) { v.ChainId = "eip155:0xa4b1" },
	} {
		t.Run(name, func(t *testing.T) {
			v := *base
			mutate(&v)
			if _, err := VerdictTypedData(&v); err == nil {
				t.Error("typed data was built for a member with a second spelling")
			}
		})
	}
}
