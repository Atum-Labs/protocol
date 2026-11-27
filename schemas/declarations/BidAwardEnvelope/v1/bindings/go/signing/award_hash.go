// Package awardhash is the single cross-language source of the
// BidAwardEnvelope award_hash binding. It is consumed by every producer
// and verifier of an award-authority VP so the value can never drift:
//
//   - The awarding party (Go) computes it as the proof.challenge it signs
//     into the BidAwardEnvelope when awarding a bid.
//   - The verifier (Go/TS) recomputes it from the award event to assert the
//     holder-signed VP is bound to THIS award.
//   - A client SDK (TS) computes it when signing the award-authority VP on the
//     quote-award flow.
//
// The TS port (signing/typescript) and this Go implementation are pinned
// byte-for-byte by the frozen vectors in
// schemas/declarations/BidAwardEnvelope/v1/conformance/award-hash-golden.json:
// both assert their output equals those values, so if both match the file
// they match each other. Changing the domain separator, the field set, the
// field order, or the separator byte MUST regenerate the golden and bump the
// "v1" suffix.
package awardhash

import (
	"errors"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	ethcrypto "github.com/ethereum/go-ethereum/crypto"
)

// DomainSeparator namespaces the award_hash preimage so a value can never
// collide with another protocol hash that happens to concatenate the same
// fields. The separator is hashed into proof.challenge, which ships to external
// clients once an SDK signs awards on the quote-award flow, so it stays a
// stable public string with no environment or ticket tagging that could not be
// changed later without breaking verification everywhere. The "v1" suffix
// versions the layout; bump it only if the preimage layout changes. Every
// producer and verifier MUST pin this identical string or every signed award
// fails authority verification.
const DomainSeparator = "atum:award_hash:v1"

// ComputeAwardHash returns the award_hash binding for an award decision:
//
//	award_hash = "0x" + hex(keccak256(utf8(
//	    DomainSeparator "\n" payment_id "\n" quote_hash "\n" settler_id)))
//
// The field order is FIXED; cross-language consumers MUST build the preimage in
// this exact order. award_hash binds an award-authority VP to a specific award:
// it is the proof.challenge the producer signs into the envelope and the
// verifier recomputes from the award event to assert the VP is bound to THIS
// award. The same authority key signing a different payment, quote, or settler
// yields a different challenge, so a captured VP cannot be replayed across
// awards.
//
//   - payment_id: the deposit / settlement key (BidAwardEnvelope.payment_id).
//   - quote_hash: the canonical content hash of the awarded FulfillmentQuote.
//     It MUST be the same canonical value used everywhere else, never a
//     separately re-derived one, so the signature-binding quote_hash and the
//     quote_hash identifier can't drift apart.
//   - settler_id:  the awarded settler id (BidAwardEnvelope.settler_id).
//
// The "\n" separator is unambiguous because all three inputs are newline-free
// hex hashes / ids; ComputeAwardHash rejects any input containing "\n" rather
// than risk a separator collision, and rejects empty inputs.
//
// SECURITY: this does NOT verify any signature — an equal award_hash does not
// imply a valid VP; callers MUST verify the proof independently. award_hash is
// a SIGNATURE-BINDING value, NOT an identifier: it is not the content hash of
// any object, not an on-chain handle, and not a lookup key — never index by it,
// look a record up by it, or commit it on-chain.
func ComputeAwardHash(paymentID, quoteHash, settlerID string) (string, error) {
	fields := []struct {
		name, value string
	}{
		{"payment_id", paymentID},
		{"quote_hash", quoteHash},
		{"settler_id", settlerID},
	}
	for _, f := range fields {
		if f.value == "" {
			return "", fmt.Errorf("award_hash: %s is empty", f.name)
		}
		if strings.ContainsRune(f.value, '\n') {
			return "", errors.New("award_hash: input contains newline (separator collision risk)")
		}
	}
	preimage := strings.Join([]string{DomainSeparator, paymentID, quoteHash, settlerID}, "\n")
	return "0x" + common.Bytes2Hex(ethcrypto.Keccak256([]byte(preimage))), nil
}
