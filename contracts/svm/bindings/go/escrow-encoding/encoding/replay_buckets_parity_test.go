package svm_escrow_encoding

import (
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// The replay-bucket count exists in four places in this repo across two languages and must agree
// in all of them, so this test reads the other three as text rather than trusting them to be
// copied correctly. A fifth copy lives in settler-agent's Solana fulfill builder, which no
// cross-repo guard can reach; its own fulfill-nonce test pins it. The sender-auth bindings are a separate Go module and a separate npm package, so
// importing the value is not available; text-scanning the siblings is the same technique the
// deposit compute-unit guard already uses.
//
// What goes wrong without it: the count decides how many replay_bucket PDAs a client can create.
// If one generator is widened and the others are not, that generator silently goes back to
// creating a fresh rent-paying PDA per payment while the others stay bounded, and nothing fails.
func TestReplayBucketsAgreeEverywhere(t *testing.T) {
	for _, src := range []struct {
		name  string
		path  string
		re    *regexp.Regexp
		human string
	}{
		{
			name:  "TypeScript escrow-encoding mirror",
			path:  "../../../typescript/escrow-encoding/src/nonce-generator.ts",
			re:    regexp.MustCompile(`REPLAY_BUCKETS\s*=\s*([0-9_]+)`),
			human: "contracts/svm/bindings/typescript/escrow-encoding/src/nonce-generator.ts",
		},
		{
			name:  "Go sender-auth binding",
			path:  "../../../../../../schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/senderauth/utils.go",
			re:    regexp.MustCompile(`solanaReplayBuckets\s*=\s*([0-9_]+)`),
			human: "schemas/declarations/PaymentRequest/v1/bindings/go/sender-auth/senderauth/utils.go",
		},
		{
			name:  "TypeScript sender-auth binding",
			path:  "../../../../../../schemas/declarations/PaymentRequest/v1/bindings/typescript/sender-auth/src/utils.ts",
			re:    regexp.MustCompile(`SOLANA_REPLAY_BUCKETS\s*=\s*([0-9_]+)n`),
			human: "schemas/declarations/PaymentRequest/v1/bindings/typescript/sender-auth/src/utils.ts",
		},
	} {
		raw, err := os.ReadFile(src.path)
		if err != nil {
			// A rename must fail loudly rather than silently stop comparing: a guard that
			// quietly finds nothing is worse than no guard.
			t.Fatalf("could not read %s (%s): %v — if this file moved, update this test rather "+
				"than deleting it, or the copies of the bucket count stop being checked",
				src.human, src.name, err)
		}
		m := src.re.FindSubmatch(raw)
		if m == nil {
			t.Fatalf("no replay-bucket count assignment found in %s; the declaration was renamed "+
				"or removed, so this guard is no longer comparing anything", src.human)
		}
		got, err := strconv.Atoi(strings.ReplaceAll(string(m[1]), "_", ""))
		if err != nil {
			t.Fatalf("could not parse the replay-bucket count %q from %s: %v", m[1], src.human, err)
		}
		if got != ReplayBuckets {
			t.Errorf("%s declares %d replay buckets, ReplayBuckets is %d; every generator must "+
				"draw from the same bounded set or the wider one leaks a PDA per payment",
				src.human, got, ReplayBuckets)
		}
	}
}

// The bucket is chosen with an unbiased modulo of a uniform draw, which requires the count to
// divide the draw range, and it must fit the width the nonce layout carries.
func TestReplayBucketsIsUnbiasedAndFitsTheNonce(t *testing.T) {
	if ReplayBuckets <= 0 || ReplayBuckets&(ReplayBuckets-1) != 0 {
		t.Errorf("ReplayBuckets is %d; it must be a power of two so the generators' modulo is unbiased", ReplayBuckets)
	}
	if ReplayBuckets > NonceBucketMask+1 {
		t.Errorf("ReplayBuckets is %d but the nonce layout carries at most %d", ReplayBuckets, NonceBucketMask+1)
	}
}
