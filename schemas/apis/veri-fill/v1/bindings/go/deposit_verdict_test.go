package verifill

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

const depositVectorsPath = "../../conformance/deposit-verdict-preimage-vectors.json"

type depositVectors struct {
	Comment     string                `json:"_comment"`
	Tag         string                `json:"tag"`
	MemberOrder []string              `json:"memberOrder"`
	Accept      []depositAcceptVector `json:"accept"`
	Reject      []rejectVector        `json:"reject"`
}

type depositAcceptVector struct {
	Name        string         `json:"name"`
	Why         string         `json:"why"`
	Verdict     DepositVerdict `json:"verdict"`
	ByteLength  int            `json:"byteLength"`
	SHA256      string         `json:"sha256"`
	PreimageHex string         `json:"preimageHex"`
}

func loadDepositVectors(t *testing.T) depositVectors {
	t.Helper()
	raw, err := os.ReadFile(depositVectorsPath)
	if err != nil {
		t.Fatalf("read %s: %v", depositVectorsPath, err)
	}
	var v depositVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode %s: %v", depositVectorsPath, err)
	}
	if len(v.Accept) == 0 || len(v.Reject) == 0 {
		t.Fatalf("%s carries no expectations", depositVectorsPath)
	}
	return v
}

// TestDepositVerdictPreimageVectors is the cross-language contract for the deposit preimage.
// preimageHex is the authority rather than the rendered string, because it is what pins the
// trailing LF and the `key=0:` lines that a source-file fixture cannot show.
func TestDepositVerdictPreimageVectors(t *testing.T) {
	v := loadDepositVectors(t)

	if v.Tag != depositVerdictPreimageTag {
		t.Fatalf("vectors tag %q != implementation tag %q", v.Tag, depositVerdictPreimageTag)
	}

	// The member order is part of the signed bytes, so pin it here rather than hoping a
	// reordering shows up as a digest change somewhere else.
	got := make([]string, 0, len(v.MemberOrder))
	for _, m := range depositVerdictSignedMembers(&v.Accept[0].Verdict) {
		got = append(got, m.key)
	}
	if strings.Join(got, ",") != strings.Join(v.MemberOrder, ",") {
		t.Fatalf("member order drifted: implementation %v, vectors %v", got, v.MemberOrder)
	}

	for _, c := range v.Accept {
		t.Run(c.Name, func(t *testing.T) {
			p, err := DepositVerdictSignedPayload(&c.Verdict)
			if err != nil {
				t.Fatalf("DepositVerdictSignedPayload: %v", err)
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
			case "escrow_address":
				bad.EscrowAddress = c.Value
			case "outcome":
				bad.Outcome = DepositVerdictOutcome(c.Value)
			case "block_number":
				bad.BlockNumber = c.Value
			case "block_hash":
				bad.BlockHash = c.Value
			case "transaction_hash":
				bad.TransactionHash = c.Value
			default:
				t.Fatalf("reject vector names an unknown member %q", c.Member)
			}
			if _, err := DepositVerdictSignedPayload(&bad); err == nil {
				t.Fatalf("rendered a preimage for %s, which must be refused", c.Name)
			}
		})
	}
}

// TestDepositVerdictPreimageShapeIsFixed pins the frame rather than the contents: the tag
// line plus one line per signed member, every line LF-terminated including the last.
func TestDepositVerdictPreimageShapeIsFixed(t *testing.T) {
	v := loadDepositVectors(t)
	for _, c := range v.Accept {
		p, err := DepositVerdictSignedPayload(&c.Verdict)
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		if !strings.HasPrefix(p, depositVerdictPreimageTag+"\n") {
			t.Errorf("%s: preimage does not open with the tag and one LF", c.Name)
		}
		if !strings.HasSuffix(p, "\n") {
			t.Errorf("%s: preimage does not end with LF", c.Name)
		}
		if strings.Contains(p, "\r") {
			t.Errorf("%s: preimage contains 0x0D", c.Name)
		}
		want := 1 + len(v.MemberOrder)
		if n := strings.Count(p, "\n"); n != want {
			t.Errorf("%s: %d LF bytes, want %d", c.Name, n, want)
		}
	}
}

// TestDepositVerdictEveryMemberIsSigned proves the member list is not merely documentation.
// Every signed member must change the bytes when it changes, and the envelope must not:
// a signature that covered its own scheme could not be checked before being trusted.
func TestDepositVerdictEveryMemberIsSigned(t *testing.T) {
	base := loadDepositVectors(t).Accept[0].Verdict
	original, err := DepositVerdictSignedPayload(&base)
	if err != nil {
		t.Fatal(err)
	}

	mutate := map[string]func(*DepositVerdict){
		"domain":           func(v *DepositVerdict) { v.Domain = "did:web:evil.example" },
		"payment_id":       func(v *DepositVerdict) { v.PaymentId = "0x" + strings.Repeat("9", 64) },
		"chain_id":         func(v *DepositVerdict) { v.ChainId = "eip155:137" },
		"escrow_address":   func(v *DepositVerdict) { v.EscrowAddress = "0x" + strings.Repeat("b", 40) },
		"outcome":          func(v *DepositVerdict) { v.Outcome = DepositVerdictOutcomeNotHeld },
		"block_number":     func(v *DepositVerdict) { v.BlockNumber = "1" },
		"block_hash":       func(v *DepositVerdict) { v.BlockHash = "0x" + strings.Repeat("c", 64) },
		"finality_policy":  func(v *DepositVerdict) { v.FinalityPolicy = "confirmations:1" },
		"transaction_hash": func(v *DepositVerdict) { v.TransactionHash = "0x" + strings.Repeat("d", 64) },
	}
	for _, key := range depositVerdictSignedMembers(&base) {
		f, ok := mutate[key.key]
		if !ok {
			t.Fatalf("signed member %q has no mutation here, so nothing proves it is signed", key.key)
		}
		v := base
		f(&v)
		p, err := DepositVerdictSignedPayload(&v)
		if err != nil {
			t.Fatalf("%s: %v", key.key, err)
		}
		if p == original {
			t.Errorf("changing %s left the preimage identical, so it is not signed", key.key)
		}
	}

	// The envelope is deliberately outside the preimage.
	for name, f := range map[string]func(*DepositVerdict){
		"signature":        func(v *DepositVerdict) { v.Signature = strings.Repeat("f", 130) },
		"signature_scheme": func(v *DepositVerdict) { v.SignatureScheme = VerdictSignatureSchemeEd25519Raw },
	} {
		v := base
		f(&v)
		p, err := DepositVerdictSignedPayload(&v)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if p != original {
			t.Errorf("changing %s changed the preimage, but it is the envelope and cannot be signed", name)
		}
	}
}

// TestDepositVerdictPredicates pins the three-way split and the one reading that would move
// funds wrongly. not_held is terminal but says nothing about why: the escrow answers the same
// for never deposited, already released and already refunded, and the released case means the
// recipient has already been paid.
func TestDepositVerdictPredicates(t *testing.T) {
	cases := []struct {
		name        string
		v           *DepositVerdict
		wantFinding bool
	}{
		{"nil", nil, false},
		{"zero value", &DepositVerdict{}, false},
		{"outcome added after this binding was compiled", &DepositVerdict{Outcome: DepositVerdictOutcome("clawed_back")}, false},
		{"held", &DepositVerdict{Outcome: DepositVerdictOutcomeHeld}, true},
		{"not held", &DepositVerdict{Outcome: DepositVerdictOutcomeNotHeld}, true},
		{"undetermined is an answer but not a finding", &DepositVerdict{Outcome: DepositVerdictOutcomeUndetermined}, false},
	}
	for _, c := range cases {
		if got := DepositHasFinding(c.v); got != c.wantFinding {
			t.Errorf("%s: DepositHasFinding = %v, want %v", c.name, got, c.wantFinding)
		}
	}

	for _, o := range []DepositVerdictOutcome{
		DepositVerdictOutcomeHeld,
		DepositVerdictOutcomeNotHeld,
		DepositVerdictOutcomeUndetermined,
	} {
		v := &DepositVerdict{Outcome: o}
		n := 0
		for _, hit := range []bool{DepositIsHeld(v), DepositIsNotHeld(v), DepositIsUndetermined(v)} {
			if hit {
				n++
			}
		}
		if n != 1 {
			t.Errorf("outcome %q satisfied %d predicates, want exactly 1", o, n)
		}
	}

	// Negating held is the mistake the three-value set exists to prevent.
	undetermined := &DepositVerdict{Outcome: DepositVerdictOutcomeUndetermined}
	if DepositIsNotHeld(undetermined) {
		t.Error("an undetermined deposit verdict reported as a proven absence")
	}
	if DepositHasFinding(undetermined) {
		t.Error("an undetermined deposit verdict reported a terminal finding, so a caller would stop asking")
	}
}

// TestDepositAndFulfillmentVerdictsCannotBeConfused is the reason the tag names the kind.
// On a same-chain corridor both attestations can be signed by the same key. If their
// preimages could coincide, a signature over one would verify as the other and a consumer
// would have no way to tell — a fulfillment verdict for a delivered payment would read as a
// deposit verdict, or worse in the other direction.
//
// The two are given every member they have in common with identical values, so the test
// cannot pass merely because the fixtures differ.
func TestDepositAndFulfillmentVerdictsCannotBeConfused(t *testing.T) {
	const (
		domain = "did:web:atum.network"
		pid    = "0x1234567890123456789012345678901234567890123456789012345678901234"
		chain  = "eip155:1"
		height = "21500000"
		bhash  = "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321"
		thash  = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
	)

	dep, err := DepositVerdictSignedPayload(&DepositVerdict{
		Domain: domain, PaymentId: pid, ChainId: chain,
		EscrowAddress: "0x742d35cc6634c0532925a3b844bc9e7595f0beb4",
		Outcome:       DepositVerdictOutcomeHeld,
		BlockNumber:   height, BlockHash: bhash, TransactionHash: thash,
	})
	if err != nil {
		t.Fatal(err)
	}
	ful, err := VerdictSignedPayload(&FulfillmentVerdict{
		Domain: domain, PaymentId: pid, ChainId: chain,
		Outcome:     FulfillmentVerdictOutcomeDelivered,
		BlockNumber: height, BlockHash: bhash, TransactionHash: thash,
		Fulfiller: "0x742d35cc6634c0532925a3b844bc9e7595f0beb4",
	})
	if err != nil {
		t.Fatal(err)
	}

	if dep == ful {
		t.Fatal("a deposit and a fulfillment verdict rendered identical bytes, so one signature satisfies both verifiers")
	}
	// Neither may be a prefix of the other either. A verifier that compared only the bytes it
	// expected to read would accept the longer one as the shorter.
	if strings.HasPrefix(dep, ful) || strings.HasPrefix(ful, dep) {
		t.Fatal("one verdict's preimage is a prefix of the other's")
	}
	// And the separation must come from the first line, not from the member lists happening
	// to differ, so that it still holds if a future member set makes them coincide.
	if strings.SplitN(dep, "\n", 2)[0] == strings.SplitN(ful, "\n", 2)[0] {
		t.Fatal("the two kinds share a first line, so their signing domains are not separated")
	}
}

// TestMembersMatchOutcome pins the conditional-emptiness rule the schema states and OpenAPI
// cannot express. Every accept vector must satisfy it, so the frozen fixtures cannot drift
// away from the rule they illustrate.
func TestMembersMatchOutcome(t *testing.T) {
	for _, c := range loadVectors(t).Accept {
		if err := VerdictMembersMatchOutcome(&c.Verdict); err != nil {
			t.Errorf("fulfillment vector %s violates its own outcome rule: %v", c.Name, err)
		}
	}
	for _, c := range loadDepositVectors(t).Accept {
		if err := DepositMembersMatchOutcome(&c.Verdict); err != nil {
			t.Errorf("deposit vector %s violates its own outcome rule: %v", c.Name, err)
		}
	}

	const (
		hash = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
		addr = "0x742d35cc6634c0532925a3b844bc9e7595f0beb4"
	)

	fulfillment := []struct {
		name    string
		v       *FulfillmentVerdict
		wantErr bool
	}{
		{"nil", nil, true},
		{"delivered, complete", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcomeDelivered, TransactionHash: hash, Fulfiller: addr}, false},
		{"delivered without a transaction, so nothing was observed", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcomeDelivered, Fulfiller: addr}, true},
		{"delivered without a fulfiller, which is the member most likely to be skipped", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcomeDelivered, TransactionHash: hash}, true},
		{"not delivered, both empty", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcomeNotDelivered}, false},
		{"not delivered but naming a transaction, which a payer could be shown as a receipt", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcomeNotDelivered, TransactionHash: hash}, true},
		{"not delivered but naming a fulfiller", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcomeNotDelivered, Fulfiller: addr}, true},
		{"undetermined, both empty", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcomeUndetermined}, false},
		{"undetermined but naming a transaction", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcomeUndetermined, TransactionHash: hash}, true},
		{"unrecognised outcome is left alone, because it is already no verdict", &FulfillmentVerdict{Outcome: FulfillmentVerdictOutcome("reorged"), TransactionHash: hash}, false},
	}
	for _, c := range fulfillment {
		err := VerdictMembersMatchOutcome(c.v)
		if (err != nil) != c.wantErr {
			t.Errorf("%s: err = %v, wantErr = %v", c.name, err, c.wantErr)
		}
	}

	deposit := []struct {
		name    string
		v       *DepositVerdict
		wantErr bool
	}{
		{"nil", nil, true},
		{"held with its deposit transaction", &DepositVerdict{Outcome: DepositVerdictOutcomeHeld, TransactionHash: hash}, false},
		{"held without one, so the state read succeeded where the lookup did not", &DepositVerdict{Outcome: DepositVerdictOutcomeHeld}, true},
		{"not held, empty", &DepositVerdict{Outcome: DepositVerdictOutcomeNotHeld}, false},
		{"not held but naming the transaction that removed it, which is not what was observed", &DepositVerdict{Outcome: DepositVerdictOutcomeNotHeld, TransactionHash: hash}, true},
		{"undetermined, empty", &DepositVerdict{Outcome: DepositVerdictOutcomeUndetermined}, false},
		{"unrecognised outcome is left alone", &DepositVerdict{Outcome: DepositVerdictOutcome("clawed_back"), TransactionHash: hash}, false},
	}
	for _, c := range deposit {
		err := DepositMembersMatchOutcome(c.v)
		if (err != nil) != c.wantErr {
			t.Errorf("%s: err = %v, wantErr = %v", c.name, err, c.wantErr)
		}
	}
}

// TestVerdictBindsTo pins verification steps 2 and 3, the ones whose absence is invisible:
// every cryptographic check passes on a genuine verdict about the wrong payment.
func TestVerdictBindsTo(t *testing.T) {
	const (
		pid   = "0x1234567890123456789012345678901234567890123456789012345678901234"
		other = "0x9999999999999999999999999999999999999999999999999999999999999999"
		chain = "eip155:42161"
		sol   = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
	)

	cases := []struct {
		name       string
		v          *FulfillmentVerdict
		pid, chain string
		wantErr    bool
	}{
		{"nil", nil, pid, chain, true},
		{"bound", &FulfillmentVerdict{PaymentId: pid, ChainId: chain}, pid, chain, false},
		{"a genuine verdict about another payment", &FulfillmentVerdict{PaymentId: other, ChainId: chain}, pid, chain, true},
		{"a genuine verdict about another chain", &FulfillmentVerdict{PaymentId: pid, ChainId: "eip155:137"}, pid, chain, true},
		{"caller asked with uppercase hex, which is the same payment", &FulfillmentVerdict{PaymentId: pid, ChainId: chain}, strings.ToUpper("0X") + strings.ToUpper(pid[2:]), chain, false},
		{"caller asked with an uppercase namespace, which is the same chain", &FulfillmentVerdict{PaymentId: pid, ChainId: chain}, pid, "EIP155:42161", false},
		{"solana reference case is load-bearing and must not be folded", &FulfillmentVerdict{PaymentId: pid, ChainId: sol}, pid, strings.ToLower(sol), true},
		{"solana matches when the reference is spelled identically", &FulfillmentVerdict{PaymentId: pid, ChainId: sol}, pid, sol, false},
	}
	for _, c := range cases {
		err := VerdictBindsTo(c.v, c.pid, c.chain)
		if (err != nil) != c.wantErr {
			t.Errorf("%s: err = %v, wantErr = %v", c.name, err, c.wantErr)
		}
	}
}

// TestDepositBindsTo adds the escrow step. A not_held verdict read against the wrong contract
// is indistinguishable from a correct one, so an absence proven elsewhere must not read as an
// absence here.
func TestDepositBindsTo(t *testing.T) {
	const (
		pid    = "0x1234567890123456789012345678901234567890123456789012345678901234"
		chain  = "eip155:1"
		escrow = "0x742d35cc6634c0532925a3b844bc9e7595f0beb4"
		other  = "0x0000000000000000000000000000000000000001"
		tronA  = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"
	)
	base := func() *DepositVerdict {
		return &DepositVerdict{PaymentId: pid, ChainId: chain, EscrowAddress: escrow}
	}

	if err := DepositBindsTo(base(), pid, chain, escrow); err != nil {
		t.Errorf("a bound deposit verdict was rejected: %v", err)
	}
	if err := DepositBindsTo(base(), pid, chain, other); err == nil {
		t.Error("a verdict about another escrow was accepted, so an absence proven elsewhere reads as one here")
	}
	if err := DepositBindsTo(nil, pid, chain, escrow); err == nil {
		t.Error("a nil verdict was accepted")
	}
	// EIP-55 mixed case is the same account, so folding it is correct on this family.
	if err := DepositBindsTo(base(), pid, chain, "0x742D35Cc6634C0532925a3b844Bc9e7595f0bEb4"); err != nil {
		t.Errorf("the same EVM account in mixed case was rejected: %v", err)
	}
	// Tron base58check is case-sensitive, so folding it would accept a different account.
	tron := &DepositVerdict{PaymentId: pid, ChainId: "tron:mainnet", EscrowAddress: tronA}
	if err := DepositBindsTo(tron, pid, "tron:mainnet", strings.ToLower(tronA)); err == nil {
		t.Error("a case-folded base58 address matched, but that encoding is case-sensitive")
	}
}

// TestVerdictHasNoUnsignedMembers is the guard the schema's "deliberately does not carry" list
// needs in order to be a rule rather than a hope.
//
// Every field on a verdict must be either in the signed member list or in the envelope, and
// the envelope is closed at two fields by definition: a signature cannot cover itself or the
// rule used to check it. Anything else is an UNSIGNED MEMBER ON A SIGNED OBJECT, which is the
// worst shape available here — a consumer reads it as attested because it arrived inside a
// verified verdict, and an attacker edits it freely because the signature does not cover it.
//
// This is what would catch a later block_timestamp, deadline, confirmation depth or expiry
// being added without also being signed. Adding one to the preimage instead is a deliberate
// break that regenerates the vectors, which is the intended cost.
func TestVerdictHasNoUnsignedMembers(t *testing.T) {
	envelope := map[string]bool{"Signature": true, "SignatureScheme": true}

	t.Run("FulfillmentVerdict", func(t *testing.T) {
		signed := map[string]bool{}
		for _, m := range verdictSignedMembers(&FulfillmentVerdict{}) {
			signed[goFieldName(m.key)] = true
		}
		assertNoUnsignedMembers(t, reflect.TypeOf(FulfillmentVerdict{}), signed, envelope)
	})

	t.Run("DepositVerdict", func(t *testing.T) {
		signed := map[string]bool{}
		for _, m := range depositVerdictSignedMembers(&DepositVerdict{}) {
			signed[goFieldName(m.key)] = true
		}
		assertNoUnsignedMembers(t, reflect.TypeOf(DepositVerdict{}), signed, envelope)
	})
}

// goFieldName maps a preimage key to the generated Go field name, so the check reads the
// implementation's own member list rather than a second copy of it that could drift.
func goFieldName(key string) string {
	parts := strings.Split(key, "_")
	out := ""
	for _, p := range parts {
		if p == "" {
			continue
		}
		out += strings.ToUpper(p[:1]) + p[1:]
	}
	// The generator emits Id and PaymentId rather than ID, so match that rather than fighting it.
	return out
}

func assertNoUnsignedMembers(t *testing.T, typ reflect.Type, signed, envelope map[string]bool) {
	t.Helper()
	for i := 0; i < typ.NumField(); i++ {
		name := typ.Field(i).Name
		switch {
		case signed[name], envelope[name]:
		default:
			t.Errorf("%s.%s is neither signed nor part of the envelope, so it would arrive inside a verified verdict while an attacker could edit it freely. Sign it, or remove it.", typ.Name(), name)
		}
	}
	// And the other direction: a signed member the struct does not have would mean the preimage
	// renders a field that no longer exists, which the compiler cannot catch through a map.
	for name := range signed {
		if _, ok := typ.FieldByName(name); !ok {
			t.Errorf("%s has no field %s, but the preimage renders it", typ.Name(), name)
		}
	}
}
