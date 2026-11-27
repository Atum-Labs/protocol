package senderauth

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// conformanceVector is one case of the frozen vectors.json, read by BOTH this Go
// test and the TS conformance test. Each committed case must verify identically in
// both languages, proving Go<->TS byte parity via the shared escrow-encoding libs.
type conformanceVector struct {
	Name          string                `json:"name"`
	Network       string                `json:"network"`
	Source        SourceRef             `json:"source"`
	Commitment    CommitmentExpectation `json:"commitment"`
	Expected      Expectations          `json:"expected"`
	Signed        SignedMessageInput    `json:"signed"`
	ExpectedTerms AuthTerms             `json:"expectedTerms"`
}

// TestConformanceVectors verifies the committed, frozen sender_auth vectors. For each
// case, GetChainAdapter(network).RecoverAndVerify(signed, source, commitment, expected) must return
// the expected terms with no error. The vectors are frozen TS output — do not modify
// vectors.json; it is the correctness oracle.
func TestConformanceVectors(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "conformance", "sender-auth-vectors.json")
	raw, err := os.ReadFile(path)
	require.NoError(t, err, "read vectors.json")

	var doc struct {
		Cases []conformanceVector `json:"cases"`
	}
	require.NoError(t, json.Unmarshal(raw, &doc), "unmarshal vectors.json")
	require.Len(t, doc.Cases, 5, "expected 5 frozen vector cases")

	for _, c := range doc.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			adapter, err := GetChainAdapter(c.Network)
			require.NoError(t, err)

			result, err := adapter.RecoverAndVerify(c.Signed, c.Source, c.Commitment, c.Expected)
			require.NoError(t, err, "recoverAndVerify must succeed for the frozen vector")

			// Compare ONLY the signed terms {Amount, DeadlineSec} to expectedTerms; the
			// result also carries a parsed Permit, which the vectors do not pin.
			require.Equal(t, c.ExpectedTerms.Amount, result.Amount, "amount")
			require.Equal(t, c.ExpectedTerms.DeadlineSec, result.DeadlineSec, "deadlineSec")
			require.Equal(t, c.ExpectedTerms, result.AuthTerms, "signed terms equality")
		})
	}
}

// negativeVector is one frozen REJECT case: an input both languages must reject identically.
// Mirrors the TS NegativeVector. `expect` is the typed sentinel the error must match, or
// "Rejected" for a generic bind rejection whose message must contain expectMessageContains.
type negativeVector struct {
	Name                  string                `json:"name"`
	Network               string                `json:"network"`
	Call                  string                `json:"call"`
	Source                SourceRef             `json:"source"`
	Commitment            CommitmentExpectation `json:"commitment"`
	Expected              Expectations          `json:"expected"`
	Signed                SignedMessageInput    `json:"signed"`
	Expect                string                `json:"expect"`
	ExpectMessageContains string                `json:"expectMessageContains"`
	ExpectOutcome         CommitmentOutcome     `json:"expectOutcome"`
	ExpectDetail          string                `json:"expectDetail"`
}

// TestConformanceNegativeVectors verifies the committed, frozen REJECT vectors: each input
// must be rejected in Go with the same error class the TS conformance test asserts, locking
// Go<->TS reject-parity (not just accept-parity).
func TestConformanceNegativeVectors(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "conformance", "sender-auth-vectors.json")
	raw, err := os.ReadFile(path)
	require.NoError(t, err, "read vectors.json")

	var doc struct {
		NegativeCases []negativeVector `json:"negativeCases"`
	}
	require.NoError(t, json.Unmarshal(raw, &doc), "unmarshal vectors.json")
	require.Len(t, doc.NegativeCases, 69, "expected 69 frozen reject vectors")

	for _, c := range doc.NegativeCases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			adapter, err := GetChainAdapter(c.Network)
			require.NoError(t, err)

			var verr error
			switch c.Call {
			case "recoverSigner":
				_, verr = adapter.RecoverSigner(c.Signed, c.Source)
			case "recoverAndVerify":
				_, verr = adapter.RecoverAndVerify(c.Signed, c.Source, c.Commitment, c.Expected)
			default:
				t.Fatalf("unknown call %q", c.Call)
			}
			require.Error(t, verr, "reject vector must error")
			if c.ExpectOutcome != "" {
				r, ok := CommitmentResultOf(verr)
				require.True(t, ok, verr.Error())
				require.Equal(t, c.ExpectDetail, r.Detail)
			}

			switch c.Expect {
			case "MalformedPrehash":
				require.ErrorIs(t, verr, ErrMalformedPrehash)
				r, ok := CommitmentResultOf(verr)
				require.True(t, ok, "a malformed prehash must carry a commitment outcome")
				require.Equal(t, c.ExpectOutcome, r.Outcome, r.Detail)
			case "RecoveryFailed":
				require.ErrorIs(t, verr, ErrRecoveryFailed)
			case "SignerMismatch":
				require.ErrorIs(t, verr, ErrSignerMismatch)
			case "Rejected":
				require.Contains(t, verr.Error(), c.ExpectMessageContains)
			case "PermitAmountMismatch":
				require.ErrorIs(t, verr, ErrPermitAmountMismatch)
				require.Contains(t, verr.Error(), c.ExpectMessageContains)
			case "Commitment":
				require.NotErrorIs(t, verr, ErrMalformedPrehash)
				requireCommitmentOutcome(t, verr, c.ExpectOutcome)
			default:
				t.Fatalf("unknown expect %q", c.Expect)
			}
		})
	}
}

// nonceVector is one frozen deterministic-nonce case. Mirrors the TS NonceVector; asserted in
// both languages so the derivation is byte-identical (idempotency depends on it).
type nonceVector struct {
	Name          string `json:"name"`
	Kind          string `json:"kind"`
	RequestID     string `json:"requestId"`
	Depositor     string `json:"depositor"`
	ExpectedNonce string `json:"expectedNonce"`
}

// TestConformanceNonceVectors verifies the frozen deterministic-nonce vectors: Go must derive
// the exact nonce TS froze, locking Go<->TS parity of the nonce derivation.
func TestConformanceNonceVectors(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "conformance", "sender-auth-vectors.json")
	raw, err := os.ReadFile(path)
	require.NoError(t, err, "read vectors.json")

	var doc struct {
		NonceVectors []nonceVector `json:"nonceVectors"`
	}
	require.NoError(t, json.Unmarshal(raw, &doc), "unmarshal vectors.json")
	require.Len(t, doc.NonceVectors, 6, "expected 6 frozen nonce vectors")

	for _, v := range doc.NonceVectors {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			var got string
			switch v.Kind {
			case "solana":
				n, err := DeterministicSolanaNonce(v.RequestID, v.Depositor)
				require.NoError(t, err)
				got = strconv.FormatUint(n, 10)
			case "permit":
				n, err := DeterministicPermitNonce(v.RequestID, v.Depositor)
				require.NoError(t, err)
				got = n.String()
			default:
				t.Fatalf("unknown nonce kind %q", v.Kind)
			}
			require.Equal(t, v.ExpectedNonce, got, "Go must derive the frozen TS nonce")
		})
	}
}

type requestIDVector struct {
	Name              string `json:"name"`
	Anchor            string `json:"anchor"`
	Account           string `json:"account"`
	Prefix            string `json:"prefix"`
	ExpectedRequestID string `json:"expectedRequestId"`
}

// TestConformanceRequestIDVectors verifies the frozen request_id vectors: Go must derive the
// exact id TS froze. request_id is the gateway's idempotency key, so a divergence would charge a
// cross-language retry twice.
func TestConformanceRequestIDVectors(t *testing.T) {
	path := filepath.Join("..", "..", "..", "..", "conformance", "sender-auth-vectors.json")
	raw, err := os.ReadFile(path)
	require.NoError(t, err, "read vectors.json")

	var doc struct {
		RequestIDVectors []requestIDVector `json:"requestIdVectors"`
	}
	require.NoError(t, json.Unmarshal(raw, &doc), "unmarshal vectors.json")
	require.Len(t, doc.RequestIDVectors, 6, "expected 6 frozen request_id vectors")

	for _, v := range doc.RequestIDVectors {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			got, err := DeterministicRequestID(v.Anchor, v.Account, v.Prefix)
			require.NoError(t, err)
			require.Equal(t, v.ExpectedRequestID, got, "Go must derive the frozen TS request_id")

			full, err := DeterministicFullRequestID(v.Anchor, v.Account, v.Prefix)
			require.NoError(t, err)
			require.Regexp(t, "^"+regexp.QuoteMeta(v.Prefix)+"[0-9a-f]{64}$", full)
			require.True(t, strings.HasPrefix(full, v.ExpectedRequestID), "the full id keeps the truncated id as its start")
		})
	}
}

// TestDeterministicRequestIDCaseInvariance pins that EVM address casing does not change the
// derived id: a signer may return a checksummed address on one attempt and a lowercase one on
// the retry, and both must derive the same idempotency key.
func TestDeterministicRequestIDCaseInvariance(t *testing.T) {
	const anchor = "order-case"
	checksummed, err := DeterministicRequestID(anchor, "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01", "req_x402_")
	require.NoError(t, err)
	lowercase, err := DeterministicRequestID(anchor, "0xabcdef0123456789abcdef0123456789abcdef01", "req_x402_")
	require.NoError(t, err)
	upperPrefix, err := DeterministicRequestID(anchor, "0XABCDEF0123456789ABCDEF0123456789ABCDEF01", "req_x402_")
	require.NoError(t, err)

	require.Equal(t, lowercase, checksummed)
	require.Equal(t, lowercase, upperPrefix)

	// Base58 is case-SENSITIVE, so it must NOT be folded: lowercasing a Solana address yields a
	// different account, and conflating them would dedup two distinct payers onto one payment.
	solana, err := DeterministicRequestID(anchor, "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse", "req_mpp_")
	require.NoError(t, err)
	solanaLowered, err := DeterministicRequestID(anchor, "gygkxmyg1p9sshfm15mknuu1u9tn2jttspcdmrtgudse", "req_mpp_")
	require.NoError(t, err)
	require.NotEqual(t, solana, solanaLowered)
}

// TestDeterministicRequestIDRejectsEmptyInputs pins the fail-closed contract: there is no random
// fallback, because one would look like a working idempotency key while letting every retry
// become a new payment.
func TestDeterministicRequestIDRejectsEmptyInputs(t *testing.T) {
	_, err := DeterministicRequestID("", "0x5555555555555555555555555555555555555555", "req_x402_")
	require.Error(t, err)
	require.Contains(t, err.Error(), "per-intent anchor is required")

	_, err = DeterministicRequestID("order-4711", "", "req_x402_")
	require.Error(t, err)
	require.Contains(t, err.Error(), "account is required")
}

// TestDeterministicRequestIDRejectsUnsafePrefix pins the prefix guard, mirroring TS. The prefix is
// the only caller-supplied part that survives verbatim into the id, and request_id carries no
// character constraint of its own on the wire — so a control character or separator here would
// reach the gateway's dedup key and the log line.
func TestDeterministicRequestIDRejectsUnsafePrefix(t *testing.T) {
	for _, bad := range []string{"req x402_", "req\nx402_", "req:x402_", "req/x402_", "req _"} {
		_, err := DeterministicRequestID("order-4711", "0x5555555555555555555555555555555555555555", bad)
		require.Error(t, err, "prefix %q must be rejected", bad)
		require.Contains(t, err.Error(), "prefix must contain only")
	}

	// An empty prefix is valid: a consumer may want no origin marker.
	id, err := DeterministicRequestID("order-4711", "0x5555555555555555555555555555555555555555", "")
	require.NoError(t, err)
	require.Len(t, id, 24)
}

// TestRequestIDDomainIsSeparateFromNonceDomain pins the domain separation. Both derivations hash
// (identity, account); sharing a preimage would mean a request_id and a deposit nonce derived
// from the same bytes.
func TestRequestIDDomainIsSeparateFromNonceDomain(t *testing.T) {
	require.NotEqual(t, PermitNonceDomain, RequestIDDomain)
	require.Equal(t, "atum-request:v1:", RequestIDDomain)
}

// The vector files carry exactly the members the suites read, so a renamed member fails here rather
// than being ignored by a decoder.
func TestConformanceVectorMembers(t *testing.T) {
	for _, f := range []struct {
		file     string
		top      []string
		sections map[string][]string
	}{
		{"sender-auth-vectors.json", []string{"_comment", "cases", "negativeCases", "nonceVectors", "requestIdVectors"}, map[string][]string{
			"cases":            {"name", "network", "source", "commitment", "expected", "signed", "expectedTerms"},
			"negativeCases":    {"name", "network", "call", "source", "commitment", "expected", "signed", "expect", "expectMessageContains", "expectOutcome", "expectDetail"},
			"nonceVectors":     {"name", "kind", "requestId", "depositor", "expectedNonce"},
			"requestIdVectors": {"name", "anchor", "account", "prefix", "expectedRequestId"},
		}},
		{"commitment-vectors.json", []string{"_comment", "requests", "compare"}, map[string][]string{
			"requests": {"name", "request", "solana", "tronChainIds", "want", "result"},
			"compare":  {"name", "signedDestination", "signedDepositRequestHash", "expected", "want", "result"},
		}},
		{"json-member-vectors.json", []string{"_comment", "ambiguous", "invalid", "scoped", "scopedInvalid"}, map[string][]string{
			"ambiguous":     {"name", "document", "want"},
			"invalid":       {"name", "document", "detailContains"},
			"scoped":        {"name", "document", "read", "want"},
			"scopedInvalid": {"name", "document", "read", "detailContains"},
		}},
		{"verify-json-vectors.json", []string{"_comment", "vectors"}, map[string][]string{
			"vectors": {"name", "request", "expected", "expect"},
		}},
		{"required-commitment-vectors.json", []string{"_comment", "vectors"}, map[string][]string{
			"vectors": {"name", "request", "solana", "tronChainIds", "want", "result"},
		}},
	} {
		raw, err := os.ReadFile(conformancePath(f.file))
		require.NoError(t, err)
		var doc map[string]json.RawMessage
		require.NoError(t, json.Unmarshal(raw, &doc))
		requireOnlyMembers(t, f.file, doc, f.top)
		for section, allowed := range f.sections {
			var items []map[string]json.RawMessage
			require.NoError(t, json.Unmarshal(doc[section], &items), "%s %s", f.file, section)
			for _, item := range items {
				requireOnlyMembers(t, f.file+" "+section, item, allowed)
			}
		}
	}
}

func requireOnlyMembers(t *testing.T, where string, object map[string]json.RawMessage, allowed []string) {
	t.Helper()
	for name := range object {
		require.Contains(t, allowed, name, "%s carries an unknown member", where)
	}
}
