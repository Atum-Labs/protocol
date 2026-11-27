package authorizationresponse

import (
	"encoding/json"
	"testing"
)

// FuzzVerifyAuthorizationResponse asserts the no-panic guarantee
// required by the PRD's "must handle malformed proofs without crashing"
// language. Goal is not to find new error reasons — only to confirm
// no input shape can panic the verifier.
//
// Run with:  go test -fuzz=FuzzVerifyAuthorizationResponse -fuzztime=30s
//
// Seed corpus covers: typical valid-shape JSON, truncated bytes,
// missing-proof, null doc, deeply-nested noise. The fuzzer mutates from
// these seeds.
func FuzzVerifyAuthorizationResponse(f *testing.F) {
	f.Add(`{"@context":["a"],"status":"authorized","payment_id":"x","counterparty_did":"did:pkh:eip155:1:0xabc","proof":{"type":"EcdsaSecp256k1RecoverySignature2020","created":"2026-05-01T12:00:00Z","verificationMethod":"did:pkh:eip155:1:0xabc#blockchainAccountId","proofPurpose":"assertionMethod","jws":"abc..def"}}`)
	f.Add(`{"@context":["a"],"status":"declined"}`)
	f.Add(`{"proof":{"jws":"a..b"}}`)
	f.Add(`{`)
	f.Add(`null`)
	f.Add(`{"proof":null}`)
	f.Add(`{"@context":[],"proof":[]}`)
	f.Add(``)

	f.Fuzz(func(t *testing.T, raw string) {
		var doc map[string]any
		// Ignore unmarshal errors — we still want to call the verifier
		// with whatever map (possibly nil) results, to confirm it
		// handles the nil case without panic.
		_ = json.Unmarshal([]byte(raw), &doc)
		defer func() {
			if r := recover(); r != nil {
				t.Fatalf("panic on input %q: %v", raw, r)
			}
		}()
		_ = VerifyAuthorizationResponse(
			doc,
			"did:pkh:eip155:1:0x0000000000000000000000000000000000000000",
			VerifyOptions{},
		)
	})
}
