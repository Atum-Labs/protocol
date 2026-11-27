package paymentrequest

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

// originatorFulfillVectors is the shared conformance file the TypeScript binding reads too, so a
// rule that drifts between the languages fails here rather than in a consumer.
type originatorFulfillVectors struct {
	OriginatorFulfillDestinations []struct {
		Name         string   `json:"name"`
		Executor     any      `json:"executor"`
		Destinations []string `json:"destinations"`
		WantErr      bool     `json:"wantErr"`
		WantAsset    string   `json:"wantAsset"`
	} `json:"originatorFulfillDestinations"`
}

// rawDocumentVectors drive both languages from identical bytes. They are kept as text and handed
// to ValidateRules unchanged: re-serializing a parsed document would drop the folded member twins
// these vectors exist to pin, so the vector would prove nothing.
type rawDocumentVectors struct {
	RawDocuments []struct {
		Name        string `json:"name"`
		Document    string `json:"document"`
		WantErrKind string `json:"wantErrKind"`
		WantAsset   string `json:"wantAsset"`
	} `json:"rawDocuments"`
}

func loadRawDocumentVectors(t *testing.T) rawDocumentVectors {
	t.Helper()
	raw, err := os.ReadFile("../../conformance/originator-fulfill-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors rawDocumentVectors
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("conformance vectors are not valid JSON: %v", err)
	}
	if len(vectors.RawDocuments) == 0 {
		t.Fatal("conformance file carries no raw-document vectors")
	}
	return vectors
}

// encoding/json folds member names and keeps the last match, so a document carrying both
// "executor" and "Executor" decodes here as one of them while JSON.parse keeps both and the
// TypeScript binding reads the other. ValidateRules refuses such a document before it decodes,
// so the two readers cannot disagree about what a payment says.
func TestValidateRules_RawDocuments(t *testing.T) {
	for _, vector := range loadRawDocumentVectors(t).RawDocuments {
		t.Run(vector.Name, func(t *testing.T) {
			err := ValidateRules([]byte(vector.Document))

			var unsupported *UnsupportedDestinationAssetError
			switch vector.WantErrKind {
			case "":
				if err != nil {
					t.Fatalf("want the document admitted, got %v", err)
				}
			case "ambiguous":
				if err == nil {
					t.Fatal("want an ambiguous-member refusal, got nil")
				}
				if !strings.Contains(err.Error(), "ambiguous member") {
					t.Fatalf("want an ambiguous-member refusal, got %v", err)
				}
				// An ambiguous document is malformed, not an unsupported destination: the two are
				// meant to reach the caller as different API errors, so they must stay apart.
				if errors.As(err, &unsupported) || errors.Is(err, ErrUnsupportedOriginatorDestination) {
					t.Fatalf("an ambiguous document must not read as an unsupported destination: %v", err)
				}
			case "unsupported":
				if !errors.As(err, &unsupported) {
					t.Fatalf("want an *UnsupportedDestinationAssetError, got %#v", err)
				}
				if unsupported.AssetIdentifier != vector.WantAsset {
					t.Fatalf("refusal names %q, want %q", unsupported.AssetIdentifier, vector.WantAsset)
				}
			default:
				t.Fatalf("unknown wantErrKind %q", vector.WantErrKind)
			}
		})
	}
}

func loadOriginatorFulfillVectors(t *testing.T) originatorFulfillVectors {
	t.Helper()
	raw, err := os.ReadFile("../../conformance/originator-fulfill-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors originatorFulfillVectors
	if err := json.Unmarshal(raw, &vectors); err != nil {
		t.Fatalf("conformance vectors are not valid JSON: %v", err)
	}
	if len(vectors.OriginatorFulfillDestinations) == 0 {
		t.Fatal("conformance file carries no vectors")
	}
	return vectors
}

// vectorRequest builds the smallest document the rule reads: the executor and the destinations.
// ValidateRules does not run the schema, so the other required members are beside the point here
// — TestValidateAppliesTheOriginatorFulfillRule covers the whole-document path.
func vectorRequest(t *testing.T, executor any, destinations []string) []byte {
	t.Helper()
	legs := make([]map[string]any, 0, len(destinations))
	for _, assetIdentifier := range destinations {
		legs = append(legs, map[string]any{
			"asset_identifier": assetIdentifier,
			"account":          "0x1234567890123456789012345678901234567890",
		})
	}
	doc := map[string]any{"destination": legs}
	if executor != nil {
		doc["executor"] = executor
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestValidateRules_OriginatorFulfillDestinations(t *testing.T) {
	for _, vector := range loadOriginatorFulfillVectors(t).OriginatorFulfillDestinations {
		t.Run(vector.Name, func(t *testing.T) {
			err := ValidateRules(vectorRequest(t, vector.Executor, vector.Destinations))

			if !vector.WantErr {
				if err != nil {
					t.Fatalf("want the request admitted, got %v", err)
				}
				return
			}

			// The sentinel is what a consumer branches on, so every refusal must carry it.
			if !errors.Is(err, ErrUnsupportedOriginatorDestination) {
				t.Fatalf("refusal must match ErrUnsupportedOriginatorDestination, got %#v", err)
			}
			var unsupported *UnsupportedDestinationAssetError
			if !errors.As(err, &unsupported) {
				t.Fatalf("want an *UnsupportedDestinationAssetError, got %#v", err)
			}
			if unsupported.AssetIdentifier != vector.WantAsset {
				t.Fatalf("refusal names %q, want %q", unsupported.AssetIdentifier, vector.WantAsset)
			}
			if asset, ok := parseAssetIdentifier(vector.WantAsset); ok && unsupported.Chain != asset.Chain {
				t.Fatalf("refusal carries chain %q, want %q", unsupported.Chain, asset.Chain)
			}
			// The message is the contract the TypeScript binding matches, and the text a gateway
			// surfaces, so it is pinned rather than left to the error type alone.
			want := "destination asset \"" + vector.WantAsset + "\" does not support EIP-3009 transferWithAuthorization, which originator fulfill requires"
			if unsupported.Error() != want {
				t.Fatalf("message is %q, want %q", unsupported.Error(), want)
			}
		})
	}
}

// Validate runs the schema and then the rules, so a schema-valid request with an originator
// fulfill to an unlisted destination is refused by the one call every consumer already makes.
func TestValidateAppliesTheOriginatorFulfillRule(t *testing.T) {
	raw, err := os.ReadFile("../../example.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}

	destinations, ok := doc["destination"].([]any)
	if !ok || len(destinations) == 0 {
		t.Fatal("example.json must carry a destination")
	}
	firstLeg := destinations[0].(map[string]any)

	// The example settles with the settler, so it validates whatever its destination is.
	if err := Validate(raw); err != nil {
		t.Fatalf("example.json must validate: %v", err)
	}

	// Handing fulfill to the originator refuses it, because the example's destination is not a
	// listed token. If the example ever moves to one, this reads as a pass and the next case is
	// what keeps the rule honest.
	const unlisted = "eip155:1/erc20:0xdAC17F958D2ee523a2206206994597C13D831ec7"
	firstLeg["asset_identifier"] = unlisted
	doc["executor"] = map[string]any{"deposit": "settler", "reserve": "settler", "fulfill": "originator"}
	withOriginator, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	err = Validate(withOriginator)
	var unsupported *UnsupportedDestinationAssetError
	if !errors.As(err, &unsupported) {
		t.Fatalf("want an *UnsupportedDestinationAssetError from Validate, got %#v", err)
	}
	if unsupported.AssetIdentifier != unlisted {
		t.Fatalf("refusal names %q, want %q", unsupported.AssetIdentifier, unlisted)
	}

	// The same document to a listed destination validates, so the rule refuses the pairing rather
	// than originator fulfill as such.
	firstLeg["asset_identifier"] = "eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
	toListed, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := Validate(toListed); err != nil {
		t.Fatalf("originator fulfill to a listed destination must validate: %v", err)
	}
}

// A shape failure and a rule failure have to stay distinguishable, because a consumer is meant
// to answer the rule failure with UNSUPPORTED_DESTINATION_ASSET and everything else with a
// malformed-body error.
func TestValidateKeepsSchemaFailuresDistinctFromRuleFailures(t *testing.T) {
	err := Validate([]byte(`{}`))
	if err == nil {
		t.Fatal("expected an empty object to fail validation")
	}
	var unsupported *UnsupportedDestinationAssetError
	if errors.As(err, &unsupported) {
		t.Fatal("a schema failure must not read as an unsupported destination")
	}
	// A consumer branches on the sentinel, so a shape failure matching it would answer the caller
	// with the wrong API error.
	if errors.Is(err, ErrUnsupportedOriginatorDestination) {
		t.Fatal("a schema failure must not match ErrUnsupportedOriginatorDestination")
	}
	if !strings.Contains(err.Error(), "validation error") {
		t.Fatalf("want a schema validation error, got %v", err)
	}
}

// The sentinel has to survive wrapping, because a consumer that adds context to the error still
// has to be able to branch on it.
func TestUnsupportedDestinationSurvivesWrapping(t *testing.T) {
	err := ValidateRules(vectorRequest(t, "originator", []string{"eip155:1/erc20:0xdAC17F958D2ee523a2206206994597C13D831ec7"}))
	wrapped := fmt.Errorf("validating the payment request: %w", err)

	if !errors.Is(wrapped, ErrUnsupportedOriginatorDestination) {
		t.Fatal("errors.Is must match through a wrap")
	}
	var unsupported *UnsupportedDestinationAssetError
	if !errors.As(wrapped, &unsupported) {
		t.Fatal("errors.As must match through a wrap")
	}
	if unsupported.Chain != "eip155:1" {
		t.Fatalf("refusal carries chain %q, want %q", unsupported.Chain, "eip155:1")
	}
}

// The rule reads CAIP-19, which the schema's pattern guarantees for a validated document. A
// caller running the rules on their own gets a refusal rather than an admission.
func TestValidateRulesRefusesAnUnreadableDestination(t *testing.T) {
	for _, assetIdentifier := range []string{"", "eip155:1", "eip155:1/erc20", "/erc20:0xabc", "eip155:1/erc20:"} {
		t.Run("identifier "+assetIdentifier, func(t *testing.T) {
			err := ValidateRules(vectorRequest(t, "originator", []string{assetIdentifier}))
			var unsupported *UnsupportedDestinationAssetError
			if !errors.As(err, &unsupported) {
				t.Fatalf("want an *UnsupportedDestinationAssetError, got %#v", err)
			}
		})
	}
}

func TestParseAssetIdentifier(t *testing.T) {
	cases := []struct {
		assetIdentifier string
		want            assetIdentifier
		ok              bool
	}{
		{"eip155:1/erc20:0xA0b8", assetIdentifier{Chain: "eip155:1", Namespace: "erc20", Reference: "0xA0b8"}, true},
		{"solana:5eykt/spltoken:EPjF", assetIdentifier{Chain: "solana:5eykt", Namespace: "spltoken", Reference: "EPjF"}, true},
		{"tron:mainnet/trc20:TR7N", assetIdentifier{Chain: "tron:mainnet", Namespace: "trc20", Reference: "TR7N"}, true},
		// CAIP-19 allows a token ID on a non-fungible asset. It is reported, not dropped, so the
		// rule can refuse a document that names one token of a collection.
		{"eip155:1/erc721:0xA0b8/1234", assetIdentifier{Chain: "eip155:1", Namespace: "erc721", Reference: "0xA0b8", TokenID: "1234"}, true},
		{"eip155:1", assetIdentifier{}, false},
		{"eip155:1/erc20", assetIdentifier{}, false},
		{"eip155:1/erc20:", assetIdentifier{}, false},
		{"eip155:1/:0xA0b8", assetIdentifier{}, false},
		{"/erc20:0xA0b8", assetIdentifier{}, false},
		{"", assetIdentifier{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.assetIdentifier, func(t *testing.T) {
			got, ok := parseAssetIdentifier(tc.assetIdentifier)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("parseAssetIdentifier(%q) = (%+v, %v), want (%+v, %v)",
					tc.assetIdentifier, got, ok, tc.want, tc.ok)
			}
		})
	}
}

// Being on the list is necessary but not sufficient: the list is keyed by chain and address, so
// the namespace and a token-id suffix have to be judged separately.
func TestDeliverableByEIP3009(t *testing.T) {
	const baseUSDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
	cases := []struct {
		name            string
		assetIdentifier string
		want            bool
	}{
		{"listed erc20", "eip155:8453/erc20:" + baseUSDC, true},
		{"listed erc20, address in another case", "eip155:8453/erc20:" + strings.ToLower(baseUSDC), true},
		{"listed address under erc721", "eip155:8453/erc721:" + baseUSDC, false},
		{"listed address under an unknown namespace", "eip155:8453/zzz:" + baseUSDC, false},
		{"listed address with a token id", "eip155:8453/erc20:" + baseUSDC + "/1", false},
		{"unlisted address under erc20", "eip155:8453/erc20:0x00000000000000000000000000000000deadbeef", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			asset, ok := parseAssetIdentifier(tc.assetIdentifier)
			if !ok {
				t.Fatalf("fixture %q must parse", tc.assetIdentifier)
			}
			if got := deliverableByEIP3009(asset); got != tc.want {
				t.Fatalf("deliverableByEIP3009(%q) = %v, want %v", tc.assetIdentifier, got, tc.want)
			}
		})
	}
}
