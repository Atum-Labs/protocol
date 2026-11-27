package senderauth

import (
	"encoding/hex"
	"encoding/json"
	"maps"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	paymentrequest "github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/generated"
)

// depositRequestV2Vectors is the shared fixture at
// PaymentRequest/v1/conformance/deposit-request-hash-v2-vectors.json, asserted by this suite and the
// TypeScript one. If a case fails, reconcile the implementations against the vector; do not edit
// the expectation to match the code.
type depositRequestV2Vectors struct {
	Golden []struct {
		Name     string `json:"name"`
		Request  string `json:"request"`
		Preimage string `json:"preimage"`
		Want     string `json:"want"`
		WantV1   string `json:"wantV1"`
	} `json:"golden"`
	Refused []struct {
		Name    string `json:"name"`
		Request string `json:"request"`
		Detail  string `json:"detail"`
	} `json:"refused"`
	Reencoded []struct {
		Golden  string `json:"golden"`
		Path    string `json:"path"`
		Request string `json:"request"`
	} `json:"reencoded"`
	ReencodedGaps []struct {
		Golden string `json:"golden"`
		Path   string `json:"path"`
		Reason string `json:"reason"`
	} `json:"reencodedGaps"`
}

func loadDepositRequestV2Vectors(t *testing.T) depositRequestV2Vectors {
	t.Helper()
	// senderauth -> sender-auth -> go -> bindings -> v1/conformance
	path := filepath.Join("..", "..", "..", "..", "conformance", "deposit-request-hash-v2-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read shared v2 vectors at %s: %v", path, err)
	}
	var v depositRequestV2Vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse shared v2 vectors: %v", err)
	}
	if len(v.Golden) == 0 || len(v.Refused) == 0 {
		// An empty fixture would make every assertion below vacuously pass.
		t.Fatalf("shared v2 vectors are incomplete (%d golden, %d refused)", len(v.Golden), len(v.Refused))
	}
	return v
}

func TestDepositRequestHashV2MatchesGoldenVectors(t *testing.T) {
	for _, c := range loadDepositRequestV2Vectors(t).Golden {
		t.Run(c.Name, func(t *testing.T) {
			read, err := ReadDepositRequest([]byte(c.Request))
			if err != nil {
				t.Fatalf("ReadDepositRequest refused a golden request: %v", err)
			}
			preimage, ok := depositRequestPreimageV2(read.Terms)
			if !ok {
				t.Fatal("depositRequestPreimageV2 refused a golden request's terms")
			}
			if got := "0x" + hex.EncodeToString(preimage); got != c.Preimage {
				t.Errorf("preimage\n got %s\nwant %s", got, c.Preimage)
			}
			if got := "0x" + hex.EncodeToString(read.DepositRequestHashV2[:]); got != c.Want {
				t.Errorf("ReadDepositRequest v2 = %s, want %s", got, c.Want)
			}
			if got := "0x" + hex.EncodeToString(read.DepositRequestHashV1[:]); got != c.WantV1 {
				t.Errorf("ReadDepositRequest v1 = %s, want %s", got, c.WantV1)
			}
			hash, err := DepositRequestHashV2([]byte(c.Request))
			if err != nil {
				t.Fatalf("DepositRequestHashV2 refused a golden request: %v", err)
			}
			if got := "0x" + hex.EncodeToString(hash[:]); got != c.Want {
				t.Errorf("DepositRequestHashV2 = %s, want %s", got, c.Want)
			}
		})
	}
}

func TestReadDepositRequestRefusesSharedVectors(t *testing.T) {
	for _, c := range loadDepositRequestV2Vectors(t).Refused {
		t.Run(c.Name, func(t *testing.T) {
			read, err := ReadDepositRequest([]byte(c.Request))
			if err == nil {
				t.Fatalf("ReadDepositRequest read a refused request, v2 = %x", read.DepositRequestHashV2)
			}
			r, ok := CommitmentResultOf(err)
			if !ok {
				t.Fatalf("refusal is not a *CommitmentError: %v", err)
			}
			if r.Outcome != OutcomeRequestMalformed {
				t.Errorf("outcome = %s, want %s", r.Outcome, OutcomeRequestMalformed)
			}
			if r.Detail != c.Detail {
				t.Errorf("detail\n got %q\nwant %q", r.Detail, c.Detail)
			}
			if _, err := DepositRequestHashV2([]byte(c.Request)); err == nil {
				t.Errorf("DepositRequestHashV2 hashed a refused request")
			}
		})
	}
}

// opaqueRequestMembers are the subtrees v2 never hashes, so the reader does not walk them.
var opaqueRequestMembers = []string{
	"presentation", "proof", "verifiableCredential", "originator_auth", "sender_auth", "settler_auth_required",
}

// requestShape must be exactly the PaymentRequest schema outside the opaque subtrees, so a member
// added to or removed from schema.json fails here instead of being refused, or allowed, silently.
// Mirrors the TS request-shape test.
func TestRequestShapeMatchesSchema(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "schema.json"))
	if err != nil {
		t.Fatalf("read schema.json: %v", err)
	}
	var schema map[string]any
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("parse schema.json: %v", err)
	}
	defs, _ := schema["$defs"].(map[string]any)
	var shapeOf func(node map[string]any) *memberShape
	shapeOf = func(node map[string]any) *memberShape {
		if ref, ok := node["$ref"].(string); ok {
			node, _ = defs[strings.TrimPrefix(ref, "#/$defs/")].(map[string]any)
		}
		shape := &memberShape{}
		// A union allows what any of its branches allows.
		for _, key := range []string{"oneOf", "anyOf"} {
			branches, _ := node[key].([]any)
			for _, b := range branches {
				branch := shapeOf(b.(map[string]any))
				if branch.members != nil {
					shape.members = branch.members
				}
				if branch.elems != nil {
					shape.elems = branch.elems
				}
			}
		}
		if properties, ok := node["properties"].(map[string]any); ok {
			shape.members = map[string]*memberShape{}
			for name, child := range properties {
				shape.members[name] = shapeOf(child.(map[string]any))
			}
		}
		if items, ok := node["items"].(map[string]any); ok {
			shape.elems = shapeOf(items)
		}
		return shape
	}
	want := shapeOf(schema)
	for _, name := range opaqueRequestMembers {
		if _, ok := want.members[name]; !ok {
			t.Fatalf("opaque member %s is not in the PaymentRequest schema", name)
		}
		want.members[name] = opaqueShape
	}
	if got, want := describeShape(requestShape), describeShape(want); got != want {
		t.Errorf("requestShape does not match schema.json\n got %s\nwant %s", got, want)
	}
}

// describeShape renders a shape canonically, members in code point order.
func describeShape(s *memberShape) string {
	switch {
	case s.opaque:
		return "opaque"
	case s.members == nil && s.elems == nil:
		return "scalar"
	}
	var b strings.Builder
	if s.members != nil {
		b.WriteString("{")
		for i, name := range slices.Sorted(maps.Keys(s.members)) {
			if i > 0 {
				b.WriteString(",")
			}
			b.WriteString(name + ":" + describeShape(s.members[name]))
		}
		b.WriteString("}")
	}
	if s.elems != nil {
		b.WriteString("[" + describeShape(s.elems) + "]")
	}
	return b.String()
}

// daysFromCivil must agree with the standard library's calendar on every day it can be asked about:
// the arithmetic, not a date parser, decides the instant v2 commits.
func TestDaysFromCivilMatchesTimeDate(t *testing.T) {
	for day := time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC); day.Year() <= 9999; day = day.AddDate(0, 0, 1) {
		got := daysFromCivil(int64(day.Year()), int64(day.Month()), int64(day.Day()))
		if want := day.Unix() / 86400; got != want {
			t.Fatalf("daysFromCivil(%s) = %d, want %d", day.Format(time.DateOnly), got, want)
		}
	}
}

// A request may nest as deep as MaxJSONDepth, or carry a very large array, where the schema has a
// scalar. Each is refused like any other wrong type, not with a crash. Built here rather than stored
// in the shared vectors to keep that file reviewable. Mirrors the TS stress cases.
func TestReadDepositRequestRefusesDeepAndWideValues(t *testing.T) {
	base := loadDepositRequestV2Vectors(t).Golden[0].Request
	for name, value := range map[string]string{
		"nested 9990 deep":     strings.Repeat("[", 9990) + strings.Repeat("]", 9990),
		"200000 elements wide": "[" + strings.TrimSuffix(strings.Repeat("0,", 200000), ",") + "]",
	} {
		t.Run(name, func(t *testing.T) {
			request := strings.TrimSuffix(base, "}") + `,"quote_selector":` + value + "}"
			_, err := ReadDepositRequest([]byte(request))
			r, ok := CommitmentResultOf(err)
			if !ok {
				t.Fatalf("refusal is not a *CommitmentError: %v", err)
			}
			if want := "the payment request is not readable: quote_selector is not a string"; r.Detail != want {
				t.Errorf("detail\n got %q\nwant %q", r.Detail, want)
			}
		})
	}
}

// The member walk runs before any type check, and nothing reads settler_requirements.whitelist
// elements afterwards, so arrays nested there as deep as MaxJSONDepth allows are accepted. Walking
// them must cost memory linear in the depth: a path kept per frame costs its square, about 900 MB
// for this request, which fits under payment-gw's 128 KiB body cap.
func TestReadDepositRequestWalksDeepValuesInLinearMemory(t *testing.T) {
	golden := loadDepositRequestV2Vectors(t).Golden[0]
	// The request object, settler_requirements and whitelist take three levels of MaxJSONDepth.
	chain := strings.Repeat("[", MaxJSONDepth-3) + strings.Repeat("]", MaxJSONDepth-3)
	chains := strings.TrimSuffix(strings.Repeat(chain+",", 6), ",")
	request := strings.TrimSuffix(golden.Request, "}") + `,"settler_requirements":{"whitelist":[` + chains + "]}}"

	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	read, err := ReadDepositRequest([]byte(request))
	runtime.ReadMemStats(&after)

	if err != nil {
		t.Fatalf("ReadDepositRequest refused the request: %v", err)
	}
	if got := "0x" + hex.EncodeToString(read.DepositRequestHashV2[:]); got != golden.Want {
		t.Errorf("v2 = %s, want %s", got, golden.Want)
	}
	const limit = 32 << 20
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > limit {
		t.Errorf("reading a %d-byte request allocated %d MB, want at most %d MB", len(request), allocated>>20, limit>>20)
	}
}

// reencodePaths are the honest re-encodes between the payer and a reader that the vectors replay.
var reencodePaths = []string{"go-schemajson", "settler-zod-jcs", "postgres-jsonb"}

// Every golden carries exactly one row per re-encode path, unless reencodedGaps names that pair with
// the reason the path never re-encodes it, and then it carries none. So a row lost from the file, or
// a gap left behind once its path re-encodes the golden, fails here. Mirrors the TS re-encode suite.
func TestDepositRequestHashV2ReencodesEveryGolden(t *testing.T) {
	v := loadDepositRequestV2Vectors(t)
	type pair struct{ golden, path string }
	rows := map[pair]int{}
	for _, c := range v.Reencoded {
		rows[pair{c.Golden, c.Path}]++
	}
	gaps := map[pair]bool{}
	for _, g := range v.ReencodedGaps {
		if g.Reason == "" {
			t.Errorf("gap %s/%s gives no reason", g.Path, g.Golden)
		}
		gaps[pair{g.Golden, g.Path}] = true
	}
	for _, g := range v.Golden {
		for _, path := range reencodePaths {
			p := pair{g.Name, path}
			want := 1
			if gaps[p] {
				want = 0
				delete(gaps, p)
			}
			if rows[p] != want {
				t.Errorf("%s/%s has %d re-encoded rows, want %d", path, g.Name, rows[p], want)
			}
			delete(rows, p)
		}
	}
	for p := range gaps {
		t.Errorf("gap %s/%s names no golden or path", p.path, p.golden)
	}
	for p := range rows {
		t.Errorf("re-encoded row %s/%s names no golden or path", p.path, p.golden)
	}
}

// v2 must not change under an honest re-encode between the payer and a reader. Each row is a golden
// request as one such path re-encoded it: solver-gw's typed decode and json.Marshal, the settler's
// zod parse and RFC 8785 JCS on the Quote API flow, and a Postgres JSONB round-trip. Mirrors the TS
// re-encode suite.
func TestDepositRequestHashV2IsInvariantUnderReencodes(t *testing.T) {
	v := loadDepositRequestV2Vectors(t)
	want := map[string][2]string{}
	for _, g := range v.Golden {
		want[g.Name] = [2]string{g.WantV1, g.Want}
	}
	for _, c := range v.Reencoded {
		t.Run(c.Path+"/"+c.Golden, func(t *testing.T) {
			w, ok := want[c.Golden]
			if !ok {
				t.Fatalf("no golden vector named %q", c.Golden)
			}
			read, err := ReadDepositRequest([]byte(c.Request))
			if err != nil {
				t.Fatalf("ReadDepositRequest refused the re-encoded request: %v", err)
			}
			if got := "0x" + hex.EncodeToString(read.DepositRequestHashV1[:]); got != w[0] {
				t.Errorf("v1 = %s, want %s", got, w[0])
			}
			if got := "0x" + hex.EncodeToString(read.DepositRequestHashV2[:]); got != w[1] {
				t.Errorf("v2 = %s, want %s", got, w[1])
			}
		})
	}
}

// solver-gw decodes a request into the generated SchemaJson and json.Marshals it on. Run that path
// live, not only through the committed go-schemajson rows, so a change to the generated type that
// loses a preimage member fails here. Only the golden named below may be refused by the typed decode:
// it never reaches a reader that way. Any other refusal fails, so a schema change that makes the
// typed decode refuse honest requests cannot pass by skipping them.
func TestDepositRequestHashV2SurvivesTheGeneratedType(t *testing.T) {
	// Its opaque sender_auth omits message_prehash, which SignedMessage requires.
	const refusedByTypedDecode = "opaque subtrees are not walked or hashed"
	for _, c := range loadDepositRequestV2Vectors(t).Golden {
		t.Run(c.Name, func(t *testing.T) {
			var typed paymentrequest.SchemaJson
			err := json.Unmarshal([]byte(c.Request), &typed)
			if c.Name == refusedByTypedDecode {
				if err == nil {
					t.Fatal("the typed decode now admits this request: drop the exemption")
				}
				return
			}
			if err != nil {
				t.Fatalf("the typed decode refuses this request: %v", err)
			}
			reencoded, err := json.Marshal(typed)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			hash, err := DepositRequestHashV2(reencoded)
			if err != nil {
				t.Fatalf("the re-encoded request is refused: %v\n%s", err, reencoded)
			}
			if got := "0x" + hex.EncodeToString(hash[:]); got != c.Want {
				t.Errorf("v2 after the typed round trip = %s, want %s\n%s", got, c.Want, reencoded)
			}
		})
	}
}

// A field's length prefix is a uint32, so a field it cannot count is refused, never wrapped into a
// shorter prefix that another request could share. Mirrors the TS v2FieldLength test.
func TestV2FieldLengthRefusesWhatAUint32CannotCount(t *testing.T) {
	if n, ok := v2FieldLength(math.MaxUint32); !ok || n != math.MaxUint32 {
		t.Errorf("v2FieldLength(MaxUint32) = %d, %v; want MaxUint32, true", n, ok)
	}
	if n, ok := v2FieldLength(math.MaxUint32 + 1); ok {
		t.Errorf("v2FieldLength(MaxUint32+1) = %d, true; want a refusal", n)
	}
}
