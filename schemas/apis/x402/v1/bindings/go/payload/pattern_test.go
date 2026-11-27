package payload

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/atum-labs/protocol/schemas/apis/x402/v1/bindings/go/extra"
	"github.com/atum-labs/protocol/schemas/apis/x402/v1/bindings/go/request"
)

// Every address field takes every supported chain's address spelling, a Stellar G account or C
// contract strkey included, and nothing near it. The cases are unmarshalled into the GENERATED types
// of the payload, extra and request schemas, whose UnmarshalJSON applies each schema's pattern.
//
// "Near it" is chosen against the mutations that matter: the pattern widened to admit W (a muxed
// contract is not a payable account), the Stellar alternative dropped, and the {55} quantifier
// loosened to {55,}.
var addressCases = []struct {
	name    string
	address string
	ok      bool
}{
	{"evm", "0x90f79bf6eb2c4f870365e785982e1f101e93b906", true},
	{"solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", true},
	{"stellar contract", "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5", true},
	{"stellar account", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH", true},
	{"stellar lowercase", "cddpu6xtx3n22or5mxzwvk6joqy3do7eyljpnyhepstaea2ff5owcte5", false},
	{"stellar too short", "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE", false},
	// One character past the 56-character strkey: the pattern is anchored with an exact quantifier.
	{"stellar 57 characters", "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5A", false},
	{"stellar account 57 characters", "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYHA", false},
	{"stellar muxed contract", "WADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4RQG", false},
	// A 56-character string with a W or M lead and a valid body shape: only the prefix refuses it.
	{"stellar 56 characters led by W", "WDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5", false},
	{"stellar 56 characters led by M", "MDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5", false},
	{"stellar seed", "SA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCTOLY", false},
	{"stellar with a trailing newline", "CDDPU6XTX3N22OR5MXZWVK6JOQY3DO7EYLJPNYHEPSTAEA2FF5OWCTE5\n", false},
	{"empty", "", false},
}

// addressTarget is one schema's generated type and the dotted paths of every address-typed field it
// checks. The paths are listed here by hand; the rest of the document comes from the schema's own
// example, so it is valid and only the address under test can refuse it.
type addressTarget struct {
	schema string
	paths  []string
	decode func([]byte) error
}

func targets() []addressTarget {
	return []addressTarget{
		{
			schema: "payload",
			paths:  []string{"accepted.asset", "accepted.payTo", "payload.paymentRequest.source.account", "payload.paymentRequest.destination.0.account"},
			decode: func(b []byte) error { var v SchemaJson; return json.Unmarshal(b, &v) },
		},
		{
			schema: "extra",
			paths:  []string{"destination.asset", "destination.address", "escrow", "fulfillmentProxy", "reserver", "releaser"},
			decode: func(b []byte) error { var v extra.SchemaJson; return json.Unmarshal(b, &v) },
		},
		{
			schema: "request",
			paths: []string{
				"source.asset", "extra.destination.asset", "extra.destination.address", "extra.escrow",
				"extra.fulfillmentProxy", "extra.reserver", "extra.releaser",
			},
			decode: func(b []byte) error { var v request.AtumEscrowRequest; return json.Unmarshal(b, &v) },
		},
	}
}

func readExampleBytes(t *testing.T, schema string) []byte {
	t.Helper()
	raw, err := os.ReadFile(fmt.Sprintf("../../../%s/example.json", schema))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// parseExample returns a fresh document each call, since setPath edits it in place.
func parseExample(t *testing.T, raw []byte) any {
	t.Helper()
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func readExample(t *testing.T, schema string) any {
	t.Helper()
	return parseExample(t, readExampleBytes(t, schema))
}

// setPath replaces the string at a dotted path; a numeric segment indexes an array.
func setPath(t *testing.T, doc any, path, value string) {
	t.Helper()
	segments := strings.Split(path, ".")
	cur := doc
	for i, seg := range segments {
		last := i == len(segments)-1
		switch node := cur.(type) {
		case map[string]any:
			next, ok := node[seg]
			if !ok {
				t.Fatalf("path %s: no member %q", path, seg)
			}
			if last {
				node[seg] = value
				return
			}
			cur = next
		case []any:
			idx, err := strconv.Atoi(seg)
			if err != nil || idx >= len(node) {
				t.Fatalf("path %s: bad index %q", path, seg)
			}
			if last {
				node[idx] = value
				return
			}
			cur = node[idx]
		default:
			t.Fatalf("path %s: cannot descend into %T at %q", path, cur, seg)
		}
	}
}

func TestAddressPatternThroughGeneratedTypes(t *testing.T) {
	for _, target := range targets() {
		// The example itself must decode, or every refusal below could be about something else.
		example := readExampleBytes(t, target.schema)
		if err := target.decode(example); err != nil {
			t.Fatalf("%s example does not decode into its generated type: %v", target.schema, err)
		}

		for _, path := range target.paths {
			for _, tc := range addressCases {
				t.Run(target.schema+"/"+path+"/"+tc.name, func(t *testing.T) {
					doc := parseExample(t, example)
					setPath(t, doc, path, tc.address)
					raw, err := json.Marshal(doc)
					if err != nil {
						t.Fatal(err)
					}
					err = target.decode(raw)
					if tc.ok && err != nil {
						t.Fatalf("refused %q: %v", tc.address, err)
					}
					if !tc.ok && err == nil {
						t.Fatalf("accepted %q", tc.address)
					}
				})
			}
		}
	}
}

// accepted.extra.atum is an open map in the generated payload type, so the payload type does not
// check the corridor addresses inside it. The extra and request types do, above; this pins the gap
// so that closing it is a visible change.
func TestPayloadTypeDoesNotCheckAcceptedExtra(t *testing.T) {
	doc := readExample(t, "payload")
	setPath(t, doc, "accepted.extra.atum.escrow", "not-an-address")
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	var v SchemaJson
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("the open extra map was expected to accept this: %v", err)
	}
}

func TestSenderAuthMessageSchemeNamesStellar(t *testing.T) {
	var scheme SchemaJsonPayloadPaymentRequestSenderAuthMessageScheme
	if err := json.Unmarshal([]byte(`"STELLAR"`), &scheme); err != nil {
		t.Fatalf("STELLAR must be a wire-valid message_scheme: %v", err)
	}
	if err := json.Unmarshal([]byte(`"STELLAR_PERMIT"`), &scheme); err == nil {
		t.Fatal("a message_scheme the enum does not name must be refused")
	}
}
