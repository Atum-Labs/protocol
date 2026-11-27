package awardhash

import (
	"strings"
	"testing"
)

func TestComputeAwardHash_Deterministic(t *testing.T) {
	a, err := ComputeAwardHash("0xpay", "0xquote", "settler-1")
	if err != nil {
		t.Fatalf("ComputeAwardHash errored: %v", err)
	}
	b, err := ComputeAwardHash("0xpay", "0xquote", "settler-1")
	if err != nil {
		t.Fatalf("ComputeAwardHash errored: %v", err)
	}
	if a != b {
		t.Fatalf("award_hash not deterministic: %q != %q", a, b)
	}
	if !strings.HasPrefix(a, "0x") || len(a) != 66 { // 0x + 32-byte keccak in hex
		t.Fatalf("award_hash shape unexpected: %q (len %d)", a, len(a))
	}
}

func TestComputeAwardHash_BindsEveryField(t *testing.T) {
	base, err := ComputeAwardHash("0xpay", "0xquote", "settler-1")
	if err != nil {
		t.Fatalf("base errored: %v", err)
	}
	// Mutating any one field MUST change the hash — otherwise a captured VP
	// could be replayed across a different payment / quote / settler.
	variants := map[string][3]string{
		"payment_id": {"0xpay2", "0xquote", "settler-1"},
		"quote_hash": {"0xpay", "0xquote2", "settler-1"},
		"settler_id": {"0xpay", "0xquote", "settler-2"},
	}
	for field, v := range variants {
		got, err := ComputeAwardHash(v[0], v[1], v[2])
		if err != nil {
			t.Fatalf("%s variant errored: %v", field, err)
		}
		if got == base {
			t.Errorf("award_hash did not change when %s mutated", field)
		}
	}
}

func TestComputeAwardHash_NoFieldTransposition(t *testing.T) {
	// Swapping two fields must yield a different hash (the "\n" separator +
	// fixed field order prevents (a,b) and (b,a) from colliding).
	ab, err := ComputeAwardHash("aaa", "bbb", "ccc")
	if err != nil {
		t.Fatalf("ab errored: %v", err)
	}
	ba, err := ComputeAwardHash("bbb", "aaa", "ccc")
	if err != nil {
		t.Fatalf("ba errored: %v", err)
	}
	if ab == ba {
		t.Fatal("transposed fields collided — separator/order not binding")
	}
}

func TestComputeAwardHash_Rejects(t *testing.T) {
	cases := [][3]string{
		{"", "0xquote", "settler-1"},        // empty payment_id
		{"0xpay", "", "settler-1"},          // empty quote_hash
		{"0xpay", "0xquote", ""},            // empty settler_id
		{"0xpay\n", "0xquote", "settler-1"}, // newline injection
		{"0xpay", "0xquote", "settler\n1"},  // newline injection
	}
	for _, c := range cases {
		if _, err := ComputeAwardHash(c[0], c[1], c[2]); err == nil {
			t.Errorf("ComputeAwardHash(%q,%q,%q) accepted, want error", c[0], c[1], c[2])
		}
	}
}
