package senderauth

import (
	"encoding/json"
	"strings"
	"testing"
)

// directDepositRequest returns the first shared golden request rewritten as an
// originator-executed deposit, with the nonce member set when nonce is non-empty.
func directDepositRequest(t *testing.T, nonce string) []byte {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal([]byte(loadDepositRequestV2Vectors(t).Golden[0].Request), &doc); err != nil {
		t.Fatalf("parse golden request: %v", err)
	}
	doc["executor"] = map[string]any{"deposit": "originator", "reserve": "settler", "fulfill": "originator"}
	delete(doc, "sender_auth")
	if nonce != "" {
		doc["deposit_nonce"] = nonce
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	return raw
}

// v2 does not commit the deposit nonce: the deposit id binds it. An originator-executed deposit
// carrying the nonce hashes exactly as the same request without it.
func TestDepositRequestHashV2IgnoresTheDepositNonce(t *testing.T) {
	without, err := ReadDepositRequest(directDepositRequest(t, ""))
	if err != nil {
		t.Fatalf("read request without the nonce: %v", err)
	}
	with, err := ReadDepositRequest(directDepositRequest(t, "7"))
	if err != nil {
		t.Fatalf("read request with the nonce: %v", err)
	}
	if with.DepositRequestHashV2 != without.DepositRequestHashV2 {
		t.Fatalf("v2 hash moved with the nonce: %x vs %x", with.DepositRequestHashV2, without.DepositRequestHashV2)
	}
}

// Only an originator-executed deposit carries the nonce. On any other request it is still not a
// member, so a reader that runs without the rules (x402 /verify) refuses what /settle would.
func TestReadDepositRequestRefusesTheDepositNonceOnASettlerDeposit(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal(directDepositRequest(t, "7"), &doc); err != nil {
		t.Fatal(err)
	}
	doc["executor"] = map[string]any{"deposit": "settler", "reserve": "settler", "fulfill": "originator"}
	raw, _ := json.Marshal(doc)
	_, err := ReadDepositRequest(raw)
	if err == nil || !strings.Contains(err.Error(), "$.deposit_nonce") {
		t.Fatalf("ReadDepositRequest = %v, want a refusal naming $.deposit_nonce", err)
	}
}

// v2 does not commit the nonce, so the quote binding compares it: a quote whose request names
// another nonce, or drops it, quotes another deposit than the one the payer funded.
func TestVerifyQuoteRequestBinding_ComparesTheDepositNonce(t *testing.T) {
	stored := directDepositRequest(t, "7")
	if _, err := VerifyQuoteRequestBinding(quoteFor(t, string(stored)), stored); err != nil {
		t.Fatalf("same nonce: %v", err)
	}
	for name, quoted := range map[string][]byte{
		"another nonce": directDepositRequest(t, "8"),
		"no nonce":      directDepositRequest(t, ""),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := VerifyQuoteRequestBinding(quoteFor(t, string(quoted)), stored)
			requireCommitmentOutcome(t, err, OutcomeQuoteRequestMismatch)
		})
	}
}
