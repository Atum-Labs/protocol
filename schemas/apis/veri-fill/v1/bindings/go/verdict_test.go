package verifill

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

const vectorsPath = "../../conformance/verdict-preimage-vectors.json"

type verdictVectors struct {
	Comment     string         `json:"_comment"`
	Tag         string         `json:"tag"`
	MemberOrder []string       `json:"memberOrder"`
	Accept      []acceptVector `json:"accept"`
	Reject      []rejectVector `json:"reject"`
}

type acceptVector struct {
	Name        string             `json:"name"`
	Why         string             `json:"why"`
	Verdict     FulfillmentVerdict `json:"verdict"`
	ByteLength  int                `json:"byteLength"`
	SHA256      string             `json:"sha256"`
	PreimageHex string             `json:"preimageHex"`
}

type rejectVector struct {
	Name   string `json:"name"`
	Why    string `json:"why"`
	Member string `json:"member"`
	Value  string `json:"value"`
}

func loadVectors(t *testing.T) *verdictVectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(vectorsPath))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v verdictVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(v.Accept) == 0 || len(v.Reject) == 0 {
		t.Fatal("vectors file has no accept or no reject cases")
	}
	return &v
}

// TestVerdictPreimageVectors is the cross-language anchor. Every implementation that signs
// or verifies a verdict must assert against this same file, because the preimage is the one
// part of this contract that cannot be renegotiated later: changing it invalidates every
// signature ever issued.
func TestVerdictPreimageVectors(t *testing.T) {
	v := loadVectors(t)

	if v.Tag != verdictPreimageTag {
		t.Fatalf("vectors tag %q != implementation tag %q", v.Tag, verdictPreimageTag)
	}

	// The member order is part of the signed bytes, so pin it rather than trusting that a
	// reordering would show up as a digest change in some other test.
	got := make([]string, 0, len(v.MemberOrder))
	for _, m := range verdictSignedMembers(&v.Accept[0].Verdict) {
		got = append(got, m.key)
	}
	if strings.Join(got, ",") != strings.Join(v.MemberOrder, ",") {
		t.Fatalf("member order drifted: implementation %v, vectors %v", got, v.MemberOrder)
	}

	for _, c := range v.Accept {
		t.Run(c.Name, func(t *testing.T) {
			p, err := VerdictSignedPayload(&c.Verdict)
			if err != nil {
				t.Fatalf("VerdictSignedPayload: %v", err)
			}
			if h := hex.EncodeToString([]byte(p)); h != c.PreimageHex {
				t.Errorf("preimage bytes drifted\n got %s\nwant %s", h, c.PreimageHex)
			}
			if len(p) != c.ByteLength {
				t.Errorf("byte length: got %d, want %d", len(p), c.ByteLength)
			}
			sum := sha256.Sum256([]byte(p))
			if h := hex.EncodeToString(sum[:]); h != c.SHA256 {
				t.Errorf("sha256: got %s, want %s", h, c.SHA256)
			}
		})
	}

	for _, c := range v.Reject {
		t.Run("reject/"+c.Name, func(t *testing.T) {
			bad := v.Accept[0].Verdict
			switch c.Member {
			case "domain":
				bad.Domain = c.Value
			case "payment_id":
				bad.PaymentId = c.Value
			case "chain_id":
				bad.ChainId = c.Value
			case "outcome":
				bad.Outcome = FulfillmentVerdictOutcome(c.Value)
			case "block_number":
				bad.BlockNumber = c.Value
			case "block_hash":
				bad.BlockHash = c.Value
			case "finality_policy":
				bad.FinalityPolicy = c.Value
			case "transaction_hash":
				bad.TransactionHash = c.Value
			case "fulfiller":
				bad.Fulfiller = c.Value
			default:
				t.Fatalf("reject vector names an unknown member %q", c.Member)
			}
			if _, err := VerdictSignedPayload(&bad); err == nil {
				t.Fatalf("rendered a preimage for %s, which must be refused", c.Name)
			}
		})
	}
}

// TestVerdictPreimageShapeIsFixed pins the property the length prefixes buy: the preimage has
// the same line count whatever the outcome, so there is exactly one shape to agree on.
func TestVerdictPreimageShapeIsFixed(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Accept {
		p, err := VerdictSignedPayload(&c.Verdict)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		// Derived from the member order, not hardcoded: a member added to the preimage must show
		// up as a changed vector digest, not as this count silently going stale.
		want := 1 + len(v.MemberOrder)
		if n := strings.Count(p, "\n"); n != want {
			t.Errorf("%s: %d LF bytes, want %d", c.Name, n, want)
		}
		if !strings.HasSuffix(p, "\n") {
			t.Errorf("%s: preimage must end in LF", c.Name)
		}
		if strings.Contains(p, "\r") {
			t.Errorf("%s: preimage must never contain CR", c.Name)
		}
		if !strings.HasPrefix(p, verdictPreimageTag+"\n") {
			t.Errorf("%s: preimage must start with the tag line", c.Name)
		}
	}
}

// TestVerdictPreimageIsUnforgeable pins the property the framing buys. The two verdicts below
// differ in chain_id yet render to identical bytes under a bare key=value encoding, which is
// the collision the length prefixes remove. Both sides must carry a newline for the bare
// collision to exist, so the byte rejection alone would also stop it; the test asserts each
// defence separately rather than assuming either one is doing the work.
func TestVerdictPreimageIsUnforgeable(t *testing.T) {
	base := loadVectors(t).Accept[0].Verdict

	a := base
	a.PaymentId = "0xaa"
	a.ChainId = "eip155:1\nchain_id=eip155:42161"

	b := base
	b.PaymentId = "0xaa\nchain_id=eip155:1"
	b.ChainId = "eip155:42161"

	// Under a bare encoding the two are indistinguishable, which is why that encoding was
	// rejected. If this stops being true the test below is no longer proving anything.
	if bareRender(&a) != bareRender(&b) {
		t.Fatal("the fixture no longer collides under a bare encoding, so it proves nothing")
	}

	// Length-prefixed, they must differ even with the byte rejection removed.
	if framedRender(&a) == framedRender(&b) {
		t.Error("length prefixes failed to separate two verdicts that collide when bare")
	}

	// And the byte rejection must refuse both outright.
	if _, err := VerdictSignedPayload(&a); err == nil {
		t.Error("a verdict carrying a newline must be refused, not rendered")
	}
	if _, err := VerdictSignedPayload(&b); err == nil {
		t.Error("a verdict carrying a newline must be refused, not rendered")
	}
}

// bareRender is the rejected encoding, kept only so the test above can show what it costs.
func bareRender(v *FulfillmentVerdict) string {
	out := verdictPreimageTag + "\n"
	for _, m := range verdictSignedMembers(v) {
		out += m.key + "=" + m.value + "\n"
	}
	return out
}

// framedRender is the chosen encoding with the byte rejection removed, so the framing can be
// tested on its own.
func framedRender(v *FulfillmentVerdict) string {
	out := verdictPreimageTag + "\n"
	for _, m := range verdictSignedMembers(v) {
		out += m.key + "=" + strconv.Itoa(len(m.value)) + ":" + m.value + "\n"
	}
	return out
}

// TestVerdictEveryMemberIsSigned catches a member being dropped from the preimage, which
// would leave it unauthenticated while still looking attested on the wire.
func TestVerdictEveryMemberIsSigned(t *testing.T) {
	base := loadVectors(t).Accept[0].Verdict
	ref, err := VerdictSignedPayload(&base)
	if err != nil {
		t.Fatal(err)
	}

	mutate := map[string]func(*FulfillmentVerdict){
		"domain":           func(v *FulfillmentVerdict) { v.Domain = "did:web:other.example" },
		"payment_id":       func(v *FulfillmentVerdict) { v.PaymentId = "0xdead" },
		"chain_id":         func(v *FulfillmentVerdict) { v.ChainId = "eip155:1" },
		"outcome":          func(v *FulfillmentVerdict) { v.Outcome = FulfillmentVerdictOutcomeNotDelivered },
		"block_number":     func(v *FulfillmentVerdict) { v.BlockNumber = "21500001" },
		"block_hash":       func(v *FulfillmentVerdict) { v.BlockHash = "0x00" },
		"finality_policy":  func(v *FulfillmentVerdict) { v.FinalityPolicy = "confirmations:1" },
		"transaction_hash": func(v *FulfillmentVerdict) { v.TransactionHash = "0x01" },
		"fulfiller":        func(v *FulfillmentVerdict) { v.Fulfiller = "0x02" },
	}
	// Driven off the implementation's own member list rather than the map's keys, so a member added
	// to the preimage without a mutation here fails instead of going quietly unproven. The deposit
	// equivalent has always done this; this one did not, which is how finality_policy first landed
	// here untested.
	for _, key := range verdictSignedMembers(&base) {
		f, ok := mutate[key.key]
		if !ok {
			t.Fatalf("signed member %q has no mutation here, so nothing proves it is signed", key.key)
		}
		v := base
		f(&v)
		p, err := VerdictSignedPayload(&v)
		if err != nil {
			t.Fatalf("%s: %v", key.key, err)
		}
		if p == ref {
			t.Errorf("changing %s did not change the preimage, so it is not signed", key.key)
		}
	}

	// The envelope is deliberately outside the preimage: a signature cannot cover itself.
	for name, f := range map[string]func(*FulfillmentVerdict){
		"signature":        func(v *FulfillmentVerdict) { v.Signature = strings.Repeat("ab", 65) },
		"signature_scheme": func(v *FulfillmentVerdict) { v.SignatureScheme = VerdictSignatureSchemeEd25519Raw },
	} {
		v := base
		f(&v)
		p, err := VerdictSignedPayload(&v)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if p != ref {
			t.Errorf("%s must not appear in the preimage", name)
		}
	}
}

// TestVerdictHexCaseIsSignedVerbatim pins that a consumer which normalises before deriving
// the preimage fails to verify, which is why each member admits one encoding per family.
func TestVerdictHexCaseIsSignedVerbatim(t *testing.T) {
	base := loadVectors(t).Accept[0].Verdict
	ref, err := VerdictSignedPayload(&base)
	if err != nil {
		t.Fatal(err)
	}
	upper := base
	upper.Fulfiller = strings.ToUpper(base.Fulfiller)
	p, err := VerdictSignedPayload(&upper)
	if err != nil {
		t.Fatal(err)
	}
	if p == ref {
		t.Fatal("address case must be part of the signed bytes")
	}
}

// TestVerdictHasFindingDefaultsToFalse is the funds-safety test. Anything this binding cannot
// positively recognise as a chain-derived finding must leave the payment pending.
func TestVerdictHasFindingDefaultsToFalse(t *testing.T) {
	cases := []struct {
		name string
		v    *FulfillmentVerdict
		want bool
	}{
		{"nil verdict", nil, false},
		{"zero value", &FulfillmentVerdict{}, false},
		{"empty outcome", &FulfillmentVerdict{Outcome: ""}, false},
		{"outcome added after this binding was compiled", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcome("reorged")}, false},
		{"near miss", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcome("delivered_probably")}, false},
		{"delivered", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcomeDelivered}, true},
		{"not delivered", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcomeNotDelivered}, true},
		{"undetermined is an answer but not a finding", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcomeUndetermined}, false},
	}
	for _, c := range cases {
		if got := VerdictHasFinding(c.v); got != c.want {
			t.Errorf("%s: VerdictHasFinding = %v, want %v", c.name, got, c.want)
		}
	}

	// Only the positive predicates may authorise anything, and none fires on an unknown value.
	for _, v := range []*FulfillmentVerdict{nil, {}, {Outcome: FulfillmentVerdictOutcome("reorged")}} {
		if VerdictIsDelivered(v) || VerdictIsNotDelivered(v) || VerdictIsUndetermined(v) {
			t.Errorf("a verdict with no recognised outcome reported an outcome: %+v", v)
		}
	}
}

// TestVerdictUndeterminedIsNotANegative pins the distinction the third outcome exists for.
// An undetermined verdict is a signed statement about a named block, so it must be
// distinguishable from a proven negative by both predicates and by the terminal check. The
// failure this guards is a consumer branching on `outcome != delivered`, which collapses
// "may still be paid" into "was not paid" and refunds a payment that is still in flight.
func TestVerdictUndeterminedIsNotANegative(t *testing.T) {
	undetermined := &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcomeUndetermined}

	if VerdictIsNotDelivered(undetermined) {
		t.Error("an undetermined verdict reported as a proven negative, which would authorise a refund")
	}
	if VerdictIsDelivered(undetermined) {
		t.Error("an undetermined verdict reported as delivered")
	}
	if !VerdictIsUndetermined(undetermined) {
		t.Error("VerdictIsUndetermined did not recognise its own outcome")
	}
	if VerdictHasFinding(undetermined) {
		t.Error("an undetermined verdict reported a terminal finding, so a caller would stop asking")
	}

	// The three outcomes are mutually exclusive, so no verdict satisfies two predicates.
	for _, o := range []FulfillmentVerdictOutcome{
		FulfillmentVerdictOutcomeDelivered,
		FulfillmentVerdictOutcomeNotDelivered,
		FulfillmentVerdictOutcomeUndetermined,
	} {
		v := &FulfillmentVerdict{Outcome: o}
		n := 0
		for _, hit := range []bool{VerdictIsDelivered(v), VerdictIsNotDelivered(v), VerdictIsUndetermined(v)} {
			if hit {
				n++
			}
		}
		if n != 1 {
			t.Errorf("outcome %q satisfied %d predicates, want exactly 1", o, n)
		}
	}
}

// TestPreimageTagSeparatesAttestationKinds pins the property the tag exists for. A key this
// service holds for a chain can sign every attestation kind for it. If two kinds shared a
// first line, then wherever their member lists agreed a signature over one would verify as
// the other, and the verifier would have no way to tell.
//
// The test renders an IDENTICAL member list under two tags and requires the bytes to differ,
// which is what makes the separation a property of the framing rather than of the member
// lists happening to be unequal today.
func TestPreimageTagSeparatesAttestationKinds(t *testing.T) {
	members := []preimageMember{
		{"domain", "did:web:atum.network"},
		{"payment_id", "0x1234567890123456789012345678901234567890123456789012345678901234"},
		{"chain_id", "eip155:42161"},
		{"outcome", "delivered"},
	}

	mine, err := renderPreimage(verdictPreimageTag, members)
	if err != nil {
		t.Fatalf("render under this kind's tag: %v", err)
	}
	other, err := renderPreimage("atum-verdict/some-other-kind/1", members)
	if err != nil {
		t.Fatalf("render under another kind's tag: %v", err)
	}
	if mine == other {
		t.Fatal("two attestation kinds rendered to identical bytes, so one signature would satisfy both verifiers")
	}

	// The tag must be the whole first line, not a prefix of it. A tag that only had to be a
	// prefix would let a longer tag beginning with this one render a preimage that a lenient
	// verifier of this kind accepts.
	if got := mine[:len(verdictPreimageTag)+1]; got != verdictPreimageTag+"\n" {
		t.Errorf("preimage does not open with the tag and one LF, got %q", got)
	}

	// And the tag names a kind rather than only a version, so a second kind has somewhere to
	// differ. A bare version would leave the kinds sharing a domain.
	if !strings.Contains(verdictPreimageTag, "fulfillment") {
		t.Errorf("tag %q does not name the attestation kind", verdictPreimageTag)
	}
}

// TestVerdictSchemeForChain pins the closed bijection, so an unrecognised namespace fails
// closed here rather than in a consumer's default branch.
func TestVerdictSchemeForChain(t *testing.T) {
	cases := []struct {
		chainID string
		want    VerdictSignatureScheme
		ok      bool
	}{
		{"eip155:42161", VerdictSignatureSchemeEip712Secp256k1, true},
		{"tron:mainnet", VerdictSignatureSchemeTip191Secp256k1, true},
		{"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", VerdictSignatureSchemeEd25519Raw, true},
		{"sui:mainnet", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := VerdictSchemeForChain(c.chainID)
		if ok != c.ok || got != c.want {
			t.Errorf("%q: got (%q, %v), want (%q, %v)", c.chainID, got, ok, c.want, c.ok)
		}
	}
}

// TestVerdictSignatureHexLen pins the length-to-scheme agreement the schema cannot express,
// since a pattern cannot see a sibling member.
func TestVerdictSignatureHexLen(t *testing.T) {
	cases := []struct {
		scheme VerdictSignatureScheme
		want   int
		ok     bool
	}{
		{VerdictSignatureSchemeEip712Secp256k1, 130, true},
		{VerdictSignatureSchemeTip191Secp256k1, 130, true},
		{VerdictSignatureSchemeEd25519Raw, 128, true},
		{VerdictSignatureScheme("bls12-381"), 0, false},
	}
	for _, c := range cases {
		got, ok := VerdictSignatureHexLen(c.scheme)
		if ok != c.ok || got != c.want {
			t.Errorf("%q: got (%d, %v), want (%d, %v)", c.scheme, got, ok, c.want, c.ok)
		}
	}
}

// TestVerdictWireContract pins the wire names and that every member the contract names is
// actually carried, independently of the generated struct's field names.
func TestVerdictWireContract(t *testing.T) {
	v := loadVectors(t).Accept[0].Verdict
	blob, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(blob, &wire); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"payment_id", "outcome", "block_number", "block_hash",
		"transaction_hash", "chain_id", "fulfiller",
		"domain", "signature", "signature_scheme",
	} {
		if _, ok := wire[key]; !ok {
			t.Errorf("verdict does not carry %q on the wire", key)
		}
	}
	if want := len(verdictRequiredMembers); len(wire) != want {
		t.Errorf("verdict carries %d members, want %d", len(wire), want)
	}
	// block_number is a string on the wire on purpose: a JSON number admits spellings that a
	// Go int64 decode rejects outright and that render differently into the preimage.
	if _, ok := wire["block_number"].(string); !ok {
		t.Errorf("block_number must be a JSON string, got %T", wire["block_number"])
	}
}

// TestVerdictIncompletenessIsOnlyVisibleBeforeDecoding pins where the all-or-nothing rule can
// be enforced. Go cannot tell an absent member from an empty one, so a consumer that needs the
// rule must count the members on the wire, which is what the contract asks of it.
func TestVerdictIncompletenessIsOnlyVisibleBeforeDecoding(t *testing.T) {
	const missingMember = `{
		"domain":"did:web:verifier.atum.network",
		"payment_id":"0x00",
		"chain_id":"eip155:1",
		"outcome":"delivered",
		"block_number":"1",
		"block_hash":"0x00",
		"fulfiller":"0x00",
		"signature":"ab",
		"signature_scheme":"eip712-secp256k1"
	}`

	var wire map[string]json.RawMessage
	if err := json.Unmarshal([]byte(missingMember), &wire); err != nil {
		t.Fatal(err)
	}
	if _, present := wire["transaction_hash"]; present {
		t.Fatal("fixture is wrong: transaction_hash should be absent")
	}
	if len(wire) != 9 {
		t.Fatalf("fixture carries %d members, want 9", len(wire))
	}

	// Decoding erases the distinction, which is the point: the zero value here is
	// indistinguishable from a verdict that legitimately carried an empty transaction_hash.
	var v FulfillmentVerdict
	if err := json.Unmarshal([]byte(missingMember), &v); err != nil {
		t.Fatalf("unexpected decode error: %v", err)
	}
	if v.TransactionHash != "" {
		t.Fatal("expected the absent member to decode to the zero value")
	}

	var complete FulfillmentVerdict
	if err := json.Unmarshal([]byte(missingMember), &complete); err != nil {
		t.Fatal(err)
	}
	complete.TransactionHash = ""
	if v != complete {
		t.Fatal("an absent member and an empty member must decode identically, or this test is moot")
	}
}

// TestLegacyResponseWithoutVerdictStillDecodes is the backward-compatibility guard. The
// verdict is optional, so today's responses must be unaffected.
func TestLegacyResponseWithoutVerdictStillDecodes(t *testing.T) {
	const legacy = `{"verified":true,"payment_id":"0xabc","signature":"deadbeef"}`
	var resp VerifyFulfillmentResponse
	if err := json.Unmarshal([]byte(legacy), &resp); err != nil {
		t.Fatalf("legacy response failed to decode: %v", err)
	}
	if resp.Verdict != nil {
		t.Error("a response with no verdict must leave Verdict nil, not a zero struct")
	}
	if !resp.Verified || resp.PaymentId != "0xabc" {
		t.Error("legacy members did not survive the round trip")
	}
	if VerdictHasFinding(resp.Verdict) {
		t.Error("an absent verdict must not authorise a terminal state")
	}
}

// TestVerdictVectorsAreValidUnderTheirOwnEncodings guards the frozen vectors. A vector that
// violates the schema it demonstrates, or that carries a base58 value of the wrong length or
// with a bad checksum, would be rejected by any implementation that follows the contract -
// while still passing a test that only compares preimage bytes.
func TestVerdictVectorsAreValidUnderTheirOwnEncodings(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.Accept {
		t.Run(c.Name, func(t *testing.T) {
			members := map[string]string{}
			for _, m := range verdictSignedMembers(&c.Verdict) {
				members[m.key] = m.value
			}
			// Iterating the SIGNED MEMBERS, not the pattern map: a member with no declared pattern
			// here would otherwise be validated by nothing and read as covered.
			for key, value := range members {
				pat, ok := verdictMemberPatterns[key]
				if !ok {
					t.Fatalf("signed member %s has no declared pattern here, so nothing validates it", key)
				}
				re := regexp.MustCompile(pat)
				if !re.MatchString(value) {
					t.Errorf("member %s = %q violates its declared pattern %s", key, value, pat)
				}
				for i := 0; i < len(value); i++ {
					if value[i] < 0x20 || value[i] > 0x7e {
						t.Errorf("member %s carries a non-printable-ASCII byte at offset %d", key, i)
					}
				}
			}

			// The envelope members, and the length agreement the schema cannot express.
			if !regexp.MustCompile(verdictEnvelopePatterns["signature"]).MatchString(c.Verdict.Signature) {
				t.Errorf("signature %q violates its declared pattern", c.Verdict.Signature)
			}
			if want, ok := VerdictSignatureHexLen(c.Verdict.SignatureScheme); !ok {
				t.Errorf("signature_scheme %q is not a known scheme", c.Verdict.SignatureScheme)
			} else if len(c.Verdict.Signature) != want {
				t.Errorf("signature is %d hex chars, want %d for scheme %q", len(c.Verdict.Signature), want, c.Verdict.SignatureScheme)
			}
			if got, ok := VerdictSchemeForChain(c.Verdict.ChainId); !ok || got != c.Verdict.SignatureScheme {
				t.Errorf("scheme %q does not match chain %q (expected %q)", c.Verdict.SignatureScheme, c.Verdict.ChainId, got)
			}

			// Per-family encodings the patterns cannot express.
			switch {
			case strings.HasPrefix(c.Verdict.ChainId, "tron:"):
				if f := c.Verdict.Fulfiller; f != "" {
					b, err := base58Decode(f)
					if err != nil {
						t.Fatalf("tron fulfiller is not base58: %v", err)
					}
					if len(b) != 25 {
						t.Errorf("tron fulfiller decodes to %d bytes, want 25", len(b))
					} else if b[0] != 0x41 {
						t.Errorf("tron fulfiller first byte is 0x%02x, want 0x41", b[0])
					} else {
						first := sha256.Sum256(b[:21])
						second := sha256.Sum256(first[:])
						if !bytes.Equal(second[:4], b[21:25]) {
							t.Error("tron fulfiller base58check checksum does not verify")
						}
					}
				}
			case strings.HasPrefix(c.Verdict.ChainId, "solana:"):
				for key, want := range map[string]int{"block_hash": 32, "transaction_hash": 64, "fulfiller": 32} {
					value := members[key]
					if value == "" {
						continue
					}
					b, err := base58Decode(value)
					if err != nil {
						t.Fatalf("solana %s is not base58: %v", key, err)
					}
					if len(b) != want {
						t.Errorf("solana %s decodes to %d bytes, want %d", key, len(b), want)
					}
				}
			}
		})
	}
}
