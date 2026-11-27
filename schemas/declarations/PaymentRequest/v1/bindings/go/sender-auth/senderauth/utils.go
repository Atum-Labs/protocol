package senderauth

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/crypto"
)

// resolvePermitDeadline normalizes a caller-supplied absolute permit deadline (Unix seconds). It
// is required: a low-level builder cannot know a payment's settlement horizon, so the calling
// layer derives it from the payment's fulfillment_deadline. Mirrors TS resolvePermitDeadline.
func resolvePermitDeadline(deadline *big.Int) *big.Int {
	return new(big.Int).Set(deadline)
}

// GeneratePermitNonce builds a unique permit nonce: ms timestamp in the high bits, 32 random
// low bits so permits signed in the same millisecond never collide. It is the explicit opt-in
// for one-shot builds; a retryable build needs DeterministicPermitNonce. Mirrors TS
// generatePermitNonce.
func GeneratePermitNonce() *big.Int {
	var b [4]byte
	_, _ = rand.Read(b[:])
	low := uint64(binary.BigEndian.Uint32(b[:]))
	ms := big.NewInt(time.Now().UnixMilli())
	ms.Lsh(ms, 32)
	return ms.Add(ms, new(big.Int).SetUint64(low))
}

// generateValidSolanaNonce builds a random Solana deposit nonce in the on-chain replay layout: a
// bucket from the bounded set (bits 32-63) and a rejection-sampled slot in [0,235) in the low
// byte. The Solana builder uses it when no nonce is supplied. Mirrors TS generateNonce
// (contracts/svm/bindings/typescript/escrow-encoding nonce-generator.ts).
func generateValidSolanaNonce() uint64 {
	var bb [4]byte
	_, _ = rand.Read(bb[:])
	// Modulo, matching every other generator: a mask would silently shrink the set if the
	// count were ever changed to a non-power-of-two.
	bucketID := binary.LittleEndian.Uint32(bb[:]) % solanaReplayBuckets
	// Rejection-sample the slot so the low byte is always a valid on-chain replay slot (< 235).
	var slot byte
	for {
		var sb [1]byte
		_, _ = rand.Read(sb[:])
		if int(sb[0]) < solanaReplaySlots {
			slot = sb[0]
			break
		}
	}
	return uint64(bucketID)<<32 | uint64(slot)
}

// resolvePermitNonce normalizes a caller-supplied permit nonce. The nonce is required, with no
// random fallback: a random nonce is not retry-safe, so derive it from a stable request id
// (DeterministicPermitNonce) so a retry reproduces the same permit. One-shot builds opt in via
// GeneratePermitNonce. Mirrors TS resolvePermitNonce.
func resolvePermitNonce(nonce *big.Int) *big.Int {
	return new(big.Int).Set(nonce)
}

// ─── Deterministic permit nonce ──────────────────────────────────────────────
// Derived from the payment's stable identity (request_id + depositor only, not the full
// parameter set) so a rebuild on retry produces the same single-use permit. The permit already
// binds token, amount and deadline, so the nonce needs only uniqueness and reproducibility.

// PermitNonceDomain is the domain separator for the deterministic permit-nonce seed.
const PermitNonceDomain = "atum-permit:v1:"

// On-chain Solana replay-nonce layout (mirrors the escrow program / nonce-generator).
const solanaReplaySlots = 235

// solanaReplayBuckets bounds the bucket set so the replay PDAs are reused instead of one
// created per payment. Mirrors SOLANA_REPLAY_BUCKETS in the TypeScript sender-auth binding.
const solanaReplayBuckets = 256

// canonicalDepositor canonicalizes a depositor address for the nonce and request_id seeds. EVM
// 0x hex is case-insensitive (EIP-55 casing is only a checksum), so it is lowercased; base58
// (Solana, Tron) is case-sensitive, so it is used verbatim. A caller that checksums the address on
// one attempt and lowercases it on the retry therefore derives the same values. Lowercasing
// before the prefix test also covers an uppercase 0X prefix. Must stay byte-identical to the TS
// canonicalDepositor.
func canonicalDepositor(depositor string) string {
	if strings.HasPrefix(strings.ToLower(depositor), "0x") {
		return strings.ToLower(depositor)
	}
	return depositor
}

// permitNonceSeed is keccak256 of the domain-separated (request_id, depositor) identity,
// as a big-endian 256-bit integer (byte-identical to the TS BigInt(keccak256(...))).
func permitNonceSeed(requestID, depositor string) (*big.Int, error) {
	if requestID == "" {
		return nil, fmt.Errorf("sender_auth: request_id is required to derive a deterministic permit nonce")
	}
	h := crypto.Keccak256([]byte(PermitNonceDomain + requestID + ":" + canonicalDepositor(depositor)))
	return new(big.Int).SetBytes(h), nil
}

// DeterministicPermitNonce returns the EVM/Tron Permit2 nonce (unordered 256-bit, single-use
// on-chain) for a stable request_id + depositor. Mirrors TS deterministicPermitNonce.
//
// One request_id pins exactly one payment's permit: reusing a request_id for different terms
// reproduces the same nonce, so the second deposit is rejected on-chain as a duplicate. Use a
// fresh request_id per distinct payment.
func DeterministicPermitNonce(requestID, depositor string) (*big.Int, error) {
	return permitNonceSeed(requestID, depositor)
}

// DeterministicSolanaNonce returns the Solana deposit nonce in the on-chain replay layout: low
// byte = slot (< 235), bits 32-63 = bucket from the bounded set (the replay PDA seed). The same
// request_id + depositor yields the same slot and bucket, so a rebuild, or a reused request_id
// with different terms, is rejected on-chain as a duplicate, but only while the program still
// remembers the nonce (the 256s slice it was issued in and the next one, so 256 to 512s): a signed
// authorization is valid for 128 seconds and the program then forgets its nonce. Unlike the EVM
// and Tron Permit2 nonce (DeterministicPermitNonce), it is not single-use forever. A rebuild
// signed after that window, with a fresh issued_at, is a new authorization and can create a
// second deposit. One request, one deposit therefore rests on resubmitting the same signed
// credential and on the gateway's request_id dedup, not on the chain. Two distinct requests from
// one depositor that hash to the same bucket and slot collide for that long, and a retry repeats
// the collision until it ages out. Use a fresh request_id per distinct payment. Mirrors TS
// deterministicSolanaNonce.
//
// The pair is publicly derivable, but the replay PDA is seeded per depositor
// (["replay", escrow_delegate.authority, bucket]), so another party's deposit cannot occupy it.
func DeterministicSolanaNonce(requestID, depositor string) (uint64, error) {
	seed, err := permitNonceSeed(requestID, depositor)
	if err != nil {
		return 0, err
	}
	slot := new(big.Int).Mod(seed, big.NewInt(solanaReplaySlots))
	bucketMod := big.NewInt(solanaReplayBuckets)
	bucket := new(big.Int).Mod(new(big.Int).Rsh(seed, 8), bucketMod)
	nonce := new(big.Int).Or(new(big.Int).Lsh(bucket, 32), slot)
	return nonce.Uint64(), nil
}

// DeterministicStellarNonce returns the Stellar deposit nonce: the escrow keeps an unordered
// per-depositor bitmap over u64 nonces and never reuses one, so any u64 is valid. It is the top 64
// bits of the seed the other chains use, so one request_id + depositor pins exactly one deposit.
// Mirrors TS deterministicStellarNonce.
func DeterministicStellarNonce(requestID, depositor string) (uint64, error) {
	seed, err := permitNonceSeed(requestID, depositor)
	if err != nil {
		return 0, err
	}
	return new(big.Int).Rsh(seed, 192).Uint64(), nil
}

// ─── Deterministic request id ────────────────────────────────────────────────
// Must stay byte-identical to the TS deterministicRequestId: the result is the gateway's
// idempotency key, so a divergence would charge a cross-language retry twice.

// RequestIDDomain is the domain separator for the request_id derivation. It names the derivation
// rather than a payment scheme, is versioned like PermitNonceDomain, and differs from it so the
// two derivations never share a preimage. Changing it changes every derived request_id (an
// idempotency key), so treat it as a wire change.
const RequestIDDomain = "atum-request:v1:"

// DeterministicRequestID returns the request_id derived from a per-intent anchor and the payer
// account. Mirrors TS deterministicRequestId.
//
// The gateway de-duplicates on (source_account, originator_did, request_id), so rebuilding the
// payment for the same intent resolves to the original payment instead of creating a second one.
//
// The anchor must be per intent, not per attempt or per challenge: an anchor that changes when the
// payer re-fetches its challenge derives a new request_id on retry, and the payer is charged
// twice. An anchor on the payment terms instead makes two identical purchases collide, and the
// second is swallowed as a retry.
//
// The account is folded in, canonicalized like the nonce seed, so two payers sharing an anchor
// cannot collide. The prefix is an origin marker for logs, prepended after the digest so it never
// enters the hash; letters, digits, '_' and '-' only, and it may be empty. The domain is fixed, not
// a parameter. The digest is truncated to 96 bits (~2^48 payments for an even chance of a
// collision).
func DeterministicRequestID(anchor, account, prefix string) (string, error) {
	full, err := DeterministicFullRequestID(anchor, account, prefix)
	if err != nil {
		return "", err
	}
	// The first 24 hex characters (12 bytes), the same bytes TS slices [2,26) off its 0x-prefixed digest.
	return full[:len(prefix)+24], nil
}

// DeterministicFullRequestID is DeterministicRequestID without the truncation: the same preimage
// and all 256 bits of the digest (64 hex characters), for anchors the payer chooses freely.
// Mirrors TS deterministicFullRequestId.
func DeterministicFullRequestID(anchor, account, prefix string) (string, error) {
	if anchor == "" {
		return "", fmt.Errorf("sender_auth: a per-intent anchor is required to derive a deterministic request_id " +
			"(a random one would silently break idempotency and let a retry double-charge)")
	}
	if account == "" {
		return "", fmt.Errorf("sender_auth: account is required to derive a deterministic request_id")
	}
	// The prefix is the only caller-supplied part that survives verbatim into the returned id, and
	// request_id carries no character constraint of its own on the wire. Restrict it so a stray
	// separator or control character cannot travel into the gateway's dedup key or a log line.
	if !requestIDPrefixPattern.MatchString(prefix) {
		return "", fmt.Errorf("sender_auth: request_id prefix must contain only letters, digits, '_' or '-' (got %q)", prefix)
	}
	return prefix + hex.EncodeToString(crypto.Keccak256([]byte(RequestIDDomain+anchor+":"+canonicalDepositor(account)))), nil
}

// requestIDPrefixPattern mirrors the TS prefix guard. Compiled once at package load.
var requestIDPrefixPattern = regexp.MustCompile(`^[A-Za-z0-9_-]*$`)

// sameAddress is address equality that is case-insensitive for EVM `0x` hex and exact for
// case-sensitive base58 (Solana, Tron). Mirrors TS sameAddress.
func sameAddress(a, b string) bool {
	if strings.HasPrefix(a, "0x") && strings.HasPrefix(b, "0x") {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// ─── Binding checks ─────────────────────────────────────────────────────────
// `normalize` maps an expected address into the signed message's canonical form
// (identity for EVM/Solana; base58->hex for Tron), so both sides compare in the same
// form. Each helper mirrors the equivalently named TS util verbatim.

// identityAddr is the no-op normalizer used by the EVM and Solana adapters.
func identityAddr(a string) string { return a }

// assertToken is UNIVERSAL: the permit token must equal the payment's source asset.
func assertToken(token, sourceAsset string, normalize func(string) string) error {
	if !sameAddress(token, normalize(sourceAsset)) {
		return fmt.Errorf("sender_auth: permit token does not match the source asset")
	}
	return nil
}

// assertPermitAmount binds the permit amount: to expected.QuoteSourceAmount when it is set, else to
// expected.MaxSourceAmount.
func assertPermitAmount(namespace, amount string, expected Expectations) error {
	if expected.QuoteSourceAmount == "" {
		return assertAmountMatches(amount, expected.MaxSourceAmount)
	}
	if expected.MaxSourceAmount != "" {
		return commitmentRefusal(namespace, OutcomeVerifierMisconfigured, detailQuoteAndMaxAmount)
	}
	if !positiveUintPattern.MatchString(expected.QuoteSourceAmount) {
		return commitmentRefusal(namespace, OutcomeVerifierMisconfigured, detailQuoteAmountMalformed)
	}
	if !sameDecimal(amount, expected.QuoteSourceAmount) {
		return fmt.Errorf("%w the quote source_amount", ErrPermitAmountMismatch)
	}
	return nil
}

const (
	detailQuoteAndMaxAmount    = "a quote source amount and a max source amount were both supplied"
	detailQuoteAmountMalformed = "the quote source amount is not a positive decimal integer string"
)

var positiveUintPattern = regexp.MustCompile(`^[1-9][0-9]*$`)

// assertAmountMatches is UNIVERSAL: the permit amount must equal max_source_amount.
func assertAmountMatches(amount, maxSourceAmount string) error {
	if !uintPattern.MatchString(maxSourceAmount) {
		return fmt.Errorf("sender_auth: max_source_amount is not a decimal integer string")
	}
	if !sameDecimal(amount, maxSourceAmount) {
		return fmt.Errorf("%w max_source_amount", ErrPermitAmountMismatch)
	}
	return nil
}

// sameDecimal reports whether amount, spelled as a decimal integer with no leading zero, equals
// want, which the caller has already validated.
func sameDecimal(amount, want string) bool {
	if !uintPattern.MatchString(amount) {
		return false
	}
	a, aok := new(big.Int).SetString(amount, 10)
	b, bok := new(big.Int).SetString(want, 10)
	return aok && bok && a.Cmp(b) == 0
}

// assertFresh is UNIVERSAL (EVM/Tron): the permit deadline must be in the future (anti
// stale-replay). Solana relies on its on-chain issued_at/nonce replay window instead.
func assertFresh(deadlineSec, nowSec int) error {
	if deadlineSec <= nowSec {
		return fmt.Errorf("sender_auth: permit deadline is not in the future")
	}
	return nil
}

// assertSpender is OPT-IN (atum-escrow scheme): the Permit2 spender must be the escrow.
func assertSpender(spender, escrow string, normalize func(string) string) error {
	if !sameAddress(spender, normalize(escrow)) {
		return fmt.Errorf("sender_auth: permit spender is not the source escrow")
	}
	return nil
}

// assertWitnessRoles is OPT-IN (atum-escrow scheme): the deposit witness roles must
// match the challenge.
func assertWitnessRoles(reserver, releaser, expectedReserver, expectedReleaser string, normalize func(string) string) error {
	if !sameAddress(reserver, normalize(expectedReserver)) || !sameAddress(releaser, normalize(expectedReleaser)) {
		return fmt.Errorf("sender_auth: deposit witness roles do not match the challenge")
	}
	return nil
}

// nowSec is the current unix time in seconds (verify-time clock; not part of any
// signed output). Mirrors TS nowSec.
func nowSec() int {
	return int(time.Now().Unix())
}

// expectedNow resolves the verify-time clock the freshness check compares against: the
// caller-pinned Expectations.NowSec when set, otherwise the real clock. Mirrors TS
// `expected.nowSec ?? nowSec()`.
func expectedNow(e Expectations) int {
	if e.NowSec != nil {
		return *e.NowSec
	}
	return nowSec()
}

// assertRolePairComplete guards the opt-in witness binding: reserver and releaser must be
// supplied together, so a half-configured verifier is rejected rather than skipping the
// witness-role check. Mirrors TS assertRolePairComplete.
func assertRolePairComplete(reserver, releaser string) error {
	if (reserver == "") != (releaser == "") {
		return fmt.Errorf("sender_auth: reserver and releaser must be supplied together")
	}
	return nil
}
