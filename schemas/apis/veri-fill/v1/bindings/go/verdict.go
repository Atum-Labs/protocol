package verifill

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// verdictPreimageTag is the first line of every fulfillment verdict preimage, which the tron and
// solana schemes sign. eip155 verdicts are signed as EIP-712 typed data instead. It is what
// separates this signature from any other payload the same key signs, and the kind is named
// in it rather than left implicit: a key this service holds for a chain can sign every
// attestation kind for it, so a second kind would otherwise share a signing domain with this
// one and a signature over either could satisfy a verifier of the other.
const verdictPreimageTag = "atum-verdict/fulfillment/1"

// preimageMember is one rendered line's key and value. Named so that a second attestation
// kind renders through the same code rather than a second copy of it.
type preimageMember struct{ key, value string }

// verdictSignedMembers is the fixed order the preimage renders. Changing it, or the tag
// above, invalidates every signature ever issued.
func verdictSignedMembers(v *FulfillmentVerdict) []preimageMember {
	return []preimageMember{
		{"domain", v.Domain},
		{"payment_id", v.PaymentId},
		{"chain_id", v.ChainId},
		{"outcome", string(v.Outcome)},
		{"block_number", v.BlockNumber},
		{"block_hash", v.BlockHash},
		{"finality_policy", v.FinalityPolicy},
		{"transaction_hash", v.TransactionHash},
		{"fulfiller", v.Fulfiller},
	}
}

// verdictMemberIsRenderable rejects a value that cannot appear in a preimage: anything
// outside printable ASCII, and the two framing bytes.
func verdictMemberIsRenderable(key, value string) error {
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c < 0x20 || c > 0x7e {
			return fmt.Errorf("verdict member %s contains a non-printable or non-ASCII byte at offset %d", key, i)
		}
		if c == '\n' || c == '\r' || c == '=' {
			return fmt.Errorf("verdict member %s contains the framing byte %q", key, c)
		}
	}
	return nil
}

// VerdictSignedPayload derives the exact bytes a tip191-secp256k1 or ed25519-raw signature
// covers, so a producer and a consumer share one implementation rather than two readings of the
// spec. An eip712-secp256k1 signature covers VerdictTypedData instead.
//
// The mapping is injective because the eight keys are fixed and in fixed order, and each
// length prefix is digits-only and so self-delimited by the first colon after the key. A
// value may therefore contain a colon or lead with digits without being absorbed into a
// neighbour. The byte rejections below are independent belt and braces.
func VerdictSignedPayload(v *FulfillmentVerdict) (string, error) {
	if v == nil {
		return "", fmt.Errorf("verdict is nil")
	}

	return renderPreimage(verdictPreimageTag, verdictSignedMembers(v))
}

// renderPreimage builds the signed bytes for one attestation kind from its tag and its
// member list. The tag is the first line, so two kinds with different tags can never render
// to the same bytes however similar their member lists are.
func renderPreimage(tag string, members []preimageMember) (string, error) {
	var b strings.Builder
	b.WriteString(tag)
	b.WriteByte('\n')

	for _, m := range members {
		// The checks the schema patterns cannot make: nothing validates them at runtime in
		// either language binding. Non-ASCII is refused because Go measures the length in
		// bytes while a naive JavaScript renderer measures UTF-16 code units, so the two
		// would disagree on the preimage for the same verdict.
		if err := verdictMemberIsRenderable(m.key, m.value); err != nil {
			return "", err
		}
		b.WriteString(m.key)
		b.WriteByte('=')
		b.WriteString(strconv.Itoa(len(m.value)))
		b.WriteByte(':')
		b.WriteString(m.value)
		b.WriteByte('\n')
	}

	return b.String(), nil
}

// VerdictIsDelivered reports whether a verdict proves delivery. Positive form on purpose:
// there is no negation helper, because negating "delivered" is how an undetermined result
// becomes a failure.
func VerdictIsDelivered(v *FulfillmentVerdict) bool {
	return v != nil && v.Outcome == FulfillmentVerdictOutcomeDelivered
}

// VerdictIsNotDelivered reports whether a verdict proves non-delivery, which is the only
// finding that authorises a refund.
func VerdictIsNotDelivered(v *FulfillmentVerdict) bool {
	return v != nil && v.Outcome == FulfillmentVerdictOutcomeNotDelivered
}

// VerdictIsUndetermined reports whether a verdict says the chain was read to a final block
// and the delivery could still land. Positive form like the other two, because this is an
// answer and not the absence of one.
//
// It is NOT terminal. A caller that reaches this leaves the payment pending and asks again,
// which is the same handling as no verdict at all — the difference is that this one names
// the block it was evaluated at, so the wait is evidenced rather than assumed.
func VerdictIsUndetermined(v *FulfillmentVerdict) bool {
	return v != nil && v.Outcome == FulfillmentVerdictOutcomeUndetermined
}

// VerdictHasFinding reports whether a verdict carries a TERMINAL chain-derived finding. It
// defaults to false, so a nil verdict, an empty outcome and an outcome added after this
// binding was compiled all leave the payment pending rather than failing it.
//
// Undetermined is excluded deliberately: it is chain-derived but it settles nothing, and a
// caller that treated it as a finding would terminalise a payment that may still be paid.
//
// It says nothing about WHICH finding, so it must not be used to decide an action: both
// terminal outcomes return true, and a caller that treats that as permission to refund would
// refund a delivered payment. Branch on the positive predicates instead.
func VerdictHasFinding(v *FulfillmentVerdict) bool {
	return VerdictIsDelivered(v) || VerdictIsNotDelivered(v)
}

// VerdictSchemeForChain returns the one signature scheme a verdict on the given CAIP-2
// chain may declare. The mapping is a closed bijection, so an unknown namespace fails
// closed here rather than in a consumer's default branch.
func VerdictSchemeForChain(chainID string) (VerdictSignatureScheme, bool) {
	// A malformed identifier is rejected rather than mapped: chain_id is signed verbatim, so
	// accepting one would produce a preimage no canonical implementation reproduces.
	if !isValidCAIP2ChainID(chainID) {
		return "", false
	}
	switch {
	case isEVMChain(chainID):
		return VerdictSignatureSchemeEip712Secp256k1, true
	case isTronChain(chainID):
		return VerdictSignatureSchemeTip191Secp256k1, true
	case isSolanaChain(chainID):
		return VerdictSignatureSchemeEd25519Raw, true
	default:
		return "", false
	}
}

// VerdictSignatureHexLen returns the hex length a signature under the given scheme must
// have. The schema cannot tie the two together, since a pattern cannot see a sibling member.
func VerdictSignatureHexLen(scheme VerdictSignatureScheme) (int, bool) {
	switch scheme {
	case VerdictSignatureSchemeEip712Secp256k1, VerdictSignatureSchemeTip191Secp256k1:
		return 130, true
	case VerdictSignatureSchemeEd25519Raw:
		return 128, true
	default:
		return 0, false
	}
}

// depositVerdictPreimageTag is the first line of every deposit verdict preimage. Its kind
// differs from the fulfillment tag, which is what stops a signature over one satisfying a
// verifier of the other: both kinds can be signed by the same key wherever a chain is both
// source and destination.
const depositVerdictPreimageTag = "atum-verdict/deposit/1"

// depositVerdictSignedMembers is the fixed order the deposit preimage renders. Changing it,
// or the tag above, invalidates every signature ever issued.
//
// escrow_address is signed rather than left implicit because a deposit's existence is a fact
// about one contract, not about a chain. Without it a not_held verdict read against the wrong
// escrow is indistinguishable from a correct one.
func depositVerdictSignedMembers(v *DepositVerdict) []preimageMember {
	return []preimageMember{
		{"domain", v.Domain},
		{"payment_id", v.PaymentId},
		{"chain_id", v.ChainId},
		{"escrow_address", v.EscrowAddress},
		{"outcome", string(v.Outcome)},
		{"block_number", v.BlockNumber},
		{"block_hash", v.BlockHash},
		{"finality_policy", v.FinalityPolicy},
		{"transaction_hash", v.TransactionHash},
	}
}

// DepositVerdictSignedPayload derives the exact bytes a tip191-secp256k1 or ed25519-raw deposit
// verdict signature covers, so a producer and a consumer share one implementation rather than
// two readings of the spec. On eip155 the signature covers EIP-712 typed data instead.
//
// Injective on the same grounds as the fulfillment preimage: the keys are fixed and in fixed
// order, and each length prefix is digits-only and so self-delimited by the first colon after
// its key.
func DepositVerdictSignedPayload(v *DepositVerdict) (string, error) {
	if v == nil {
		return "", fmt.Errorf("deposit verdict is nil")
	}
	return renderPreimage(depositVerdictPreimageTag, depositVerdictSignedMembers(v))
}

// DepositIsHeld reports whether a verdict attests the deposit was present at its block_number.
func DepositIsHeld(v *DepositVerdict) bool {
	return v != nil && v.Outcome == DepositVerdictOutcomeHeld
}

// DepositIsNotHeld reports whether a verdict proves no deposit was present at the attested
// block. Terminal, and deliberately says nothing about why.
//
// It is NOT permission to pay anyone. The escrow's getter returns the same answer for a
// deposit that never existed, one already released and one already refunded, because both
// settlement paths delete the record before transferring. One of those means the recipient
// has already been paid.
func DepositIsNotHeld(v *DepositVerdict) bool {
	return v != nil && v.Outcome == DepositVerdictOutcomeNotHeld
}

// DepositIsUndetermined reports whether the chain was read to a final block without
// establishing the deposit's state. Not terminal: the payment stays pending and is asked
// again, the difference from no verdict at all being that this one names its block.
func DepositIsUndetermined(v *DepositVerdict) bool {
	return v != nil && v.Outcome == DepositVerdictOutcomeUndetermined
}

// DepositHasFinding reports whether a deposit verdict carries a TERMINAL finding. It defaults
// to false, so a nil verdict, an empty outcome and an outcome added after this binding was
// compiled all leave the payment pending.
//
// Undetermined is excluded deliberately, and this predicate says nothing about WHICH finding,
// so it must not be used to decide an action. Branch on the positive predicates instead.
func DepositHasFinding(v *DepositVerdict) bool {
	return DepositIsHeld(v) || DepositIsNotHeld(v)
}

// VerdictMembersMatchOutcome enforces the one rule the schema states but OpenAPI 3.0.3 cannot
// express, since it has no way to make one member's requiredness depend on another's value:
// transaction_hash and fulfiller are populated exactly when outcome is delivered, and empty
// otherwise.
//
// Both directions matter and they fail differently. A delivered verdict missing either member
// is a producer that signed an observation it did not make, and fulfiller in particular MUST
// come from the matched event rather than from the request. A non-delivered or undetermined
// verdict carrying either member is a producer naming a transaction for something that did not
// happen, which a consumer may then put in front of a payer as a receipt.
//
// It does not validate the members themselves, only their presence against the outcome. A
// verdict whose outcome this binding does not recognise is left alone, because an unknown
// outcome is already no verdict.
func VerdictMembersMatchOutcome(v *FulfillmentVerdict) error {
	if v == nil {
		return fmt.Errorf("verdict is nil")
	}
	switch v.Outcome {
	case FulfillmentVerdictOutcomeDelivered:
		if v.TransactionHash == "" {
			return fmt.Errorf("outcome %q requires transaction_hash, which is empty", v.Outcome)
		}
		if v.Fulfiller == "" {
			return fmt.Errorf("outcome %q requires fulfiller, which is empty", v.Outcome)
		}
	case FulfillmentVerdictOutcomeNotDelivered, FulfillmentVerdictOutcomeUndetermined:
		if v.TransactionHash != "" {
			return fmt.Errorf("outcome %q requires an empty transaction_hash, got %q", v.Outcome, v.TransactionHash)
		}
		if v.Fulfiller != "" {
			return fmt.Errorf("outcome %q requires an empty fulfiller, got %q", v.Outcome, v.Fulfiller)
		}
	}
	return nil
}

// verdictMemberPatterns mirrors the patterns declared for FulfillmentVerdict in openapi.yaml.
// A test pins the two together, since nothing in either generated binding enforces them.
var verdictMemberPatterns = map[string]string{
	"domain":           `^did:web:[a-z0-9][a-z0-9.-]{0,252}$`,
	"payment_id":       `^0x[0-9a-f]{64}$`,
	"chain_id":         `^[a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$`,
	"outcome":          `^(delivered|not_delivered|undetermined)$`,
	"block_number":     `^(0|[1-9][0-9]{0,18})$`,
	"block_hash":       `^0x[0-9a-f]{64}$|^[1-9A-HJ-NP-Za-km-z]{32,88}$`,
	"finality_policy":  `^(confirmations:(0|[1-9][0-9]{0,9})|commitment:(confirmed|finalized))$`,
	"transaction_hash": `^$|^0x[0-9a-f]{64}$|^[1-9A-HJ-NP-Za-km-z]{32,88}$`,
	"fulfiller":        `^$|^0x[0-9a-f]{40}$|^T[1-9A-HJ-NP-Za-km-z]{33}$|^[1-9A-HJ-NP-Za-km-z]{32,44}$`,
}

// verdictEnvelopePatterns covers the members that are not preimage input.
var verdictEnvelopePatterns = map[string]string{
	"signature": `^[0-9a-f]{128}$|^[0-9a-f]{130}$`,
}

// The declared patterns are unions across chain families. These are each family's own form:
// hex on eip155 and tron, base58 on solana, and the fulfiller's account encoding.
var (
	hexHashRe     = regexp.MustCompile(`^0x[0-9a-f]{64}$`)
	base58HashRe  = regexp.MustCompile(`^[1-9A-HJ-NP-Za-km-z]{32,88}$`)
	evmAccountRe  = regexp.MustCompile(`^0x[0-9a-f]{40}$`)
	tronAccountRe = regexp.MustCompile(`^T[1-9A-HJ-NP-Za-km-z]{33}$`)
	base58AcctRe  = regexp.MustCompile(`^[1-9A-HJ-NP-Za-km-z]{32,44}$`)
)

// verdictFamilyEncodings rejects a hash or account in another family's encoding, which the union
// patterns alone accept, and on tron and solana one that does not decode to that family's bytes.
// account is the fulfiller or the escrow address, and an empty hash or account is skipped.
func verdictFamilyEncodings(chainID, blockHash, transactionHash string, account preimageMember) error {
	var hash, accountRe *regexp.Regexp
	switch {
	case isEVMChain(chainID):
		hash, accountRe = hexHashRe, evmAccountRe
	case isTronChain(chainID):
		hash, accountRe = hexHashRe, tronAccountRe
	case isSolanaChain(chainID):
		hash, accountRe = base58HashRe, base58AcctRe
	default:
		return fmt.Errorf("chain %q is not a family a verdict can name", chainID)
	}
	if !hash.MatchString(blockHash) {
		return fmt.Errorf("verdict block_hash %q is not in the encoding chain %q uses", blockHash, chainID)
	}
	if transactionHash != "" && !hash.MatchString(transactionHash) {
		return fmt.Errorf("verdict transaction_hash %q is not in the encoding chain %q uses", transactionHash, chainID)
	}
	if account.value != "" && !accountRe.MatchString(account.value) {
		return fmt.Errorf("verdict %s %q is not in the encoding chain %q uses", account.key, account.value, chainID)
	}
	// The patterns admit any base58 of the right length, so the decoded bytes are checked too.
	switch {
	case isTronChain(chainID) && account.value != "":
		if _, err := decodeServedTronAddress(account.value); err != nil {
			return fmt.Errorf("verdict %s is not a Tron account: %w", account.key, err)
		}
	case isSolanaChain(chainID):
		for _, m := range []struct {
			name, value string
			size        int
		}{
			{"block_hash", blockHash, 32},
			{"transaction_hash", transactionHash, 64},
			{account.key, account.value, 32},
		} {
			if m.value == "" {
				continue
			}
			if raw, err := base58Decode(m.value); err != nil || len(raw) != m.size {
				return fmt.Errorf("verdict %s %q does not decode to %d bytes", m.name, m.value, m.size)
			}
		}
	}
	return nil
}

var (
	verdictMemberRegexps   = compilePatterns(verdictMemberPatterns)
	verdictEnvelopeRegexps = compilePatterns(verdictEnvelopePatterns)
)

func compilePatterns(patterns map[string]string) map[string]*regexp.Regexp {
	out := make(map[string]*regexp.Regexp, len(patterns))
	for k, p := range patterns {
		out[k] = regexp.MustCompile(p)
	}
	return out
}

// ValidateVerdictMembers checks a complete, signed verdict against the schema's encodings: each
// member's declared pattern, the one encoding the chain_id family admits for each hash and the
// fulfiller, the outcome-conditional members, the scheme the chain admits and the signature
// length that scheme requires. It does not verify the signature itself.
//
// A producer runs this before emitting, because a non-conforming consumer may drop the whole
// response a malformed verdict rides in, not just the verdict.
func ValidateVerdictMembers(v *FulfillmentVerdict) error {
	if v == nil {
		return fmt.Errorf("verdict is nil")
	}
	if err := matchMemberPatterns(verdictSignedMembers(v), verdictMemberRegexps); err != nil {
		return err
	}
	if err := verdictFamilyEncodings(v.ChainId, v.BlockHash, v.TransactionHash, preimageMember{"fulfiller", v.Fulfiller}); err != nil {
		return err
	}
	if err := VerdictMembersMatchOutcome(v); err != nil {
		return err
	}
	return validateSignatureShape(v.ChainId, v.SignatureScheme, v.Signature)
}

// depositVerdictMemberPatterns mirrors the patterns declared for DepositVerdict in openapi.yaml,
// pinned to the spec by a test like the fulfillment patterns.
var depositVerdictMemberPatterns = map[string]string{
	"domain":           verdictMemberPatterns["domain"],
	"payment_id":       verdictMemberPatterns["payment_id"],
	"chain_id":         verdictMemberPatterns["chain_id"],
	"escrow_address":   `^0x[0-9a-f]{40}$|^T[1-9A-HJ-NP-Za-km-z]{33}$|^[1-9A-HJ-NP-Za-km-z]{32,44}$`,
	"outcome":          `^(held|not_held|undetermined)$`,
	"block_number":     verdictMemberPatterns["block_number"],
	"block_hash":       verdictMemberPatterns["block_hash"],
	"finality_policy":  verdictMemberPatterns["finality_policy"],
	"transaction_hash": verdictMemberPatterns["transaction_hash"],
}

var depositVerdictMemberRegexps = compilePatterns(depositVerdictMemberPatterns)

// ValidateDepositVerdictMembers is ValidateVerdictMembers for a deposit verdict: each member's
// declared pattern, the one encoding the chain_id family admits for each hash and the escrow
// address, the outcome-conditional transaction hash, the scheme the chain admits and the
// signature length. It does not verify the signature itself.
func ValidateDepositVerdictMembers(v *DepositVerdict) error {
	if v == nil {
		return fmt.Errorf("deposit verdict is nil")
	}
	if err := matchMemberPatterns(depositVerdictSignedMembers(v), depositVerdictMemberRegexps); err != nil {
		return err
	}
	if err := verdictFamilyEncodings(v.ChainId, v.BlockHash, v.TransactionHash, preimageMember{"escrow_address", v.EscrowAddress}); err != nil {
		return err
	}
	if err := DepositMembersMatchOutcome(v); err != nil {
		return err
	}
	return validateSignatureShape(v.ChainId, v.SignatureScheme, v.Signature)
}

// matchMemberPatterns checks every signed member against its declared pattern, and refuses a
// member that has none.
func matchMemberPatterns(members []preimageMember, patterns map[string]*regexp.Regexp) error {
	for _, m := range members {
		re, ok := patterns[m.key]
		if !ok {
			return fmt.Errorf("verdict member %s has no declared pattern", m.key)
		}
		if !re.MatchString(m.value) {
			return fmt.Errorf("verdict member %s = %q violates its declared pattern", m.key, m.value)
		}
	}
	return nil
}

// validateSignatureShape checks the scheme against the one the chain admits, and the signature
// against its pattern and the length that scheme requires.
func validateSignatureShape(chainID string, scheme VerdictSignatureScheme, signature string) error {
	want, ok := VerdictSchemeForChain(chainID)
	if !ok || want != scheme {
		return fmt.Errorf("signature_scheme %q is not the scheme chain %q admits", scheme, chainID)
	}
	if !verdictEnvelopeRegexps["signature"].MatchString(signature) {
		return fmt.Errorf("verdict signature violates its declared pattern")
	}
	if n, _ := VerdictSignatureHexLen(want); len(signature) != n {
		return fmt.Errorf("verdict signature is %d hex characters, want %d for %q", len(signature), n, want)
	}
	return nil
}

// DepositMembersMatchOutcome is the same rule for a deposit verdict: transaction_hash is
// populated exactly when outcome is held, and empty otherwise.
//
// An empty hash on a held verdict is a producer that established the deposit exists without
// finding the transaction that made it, which is the state read succeeding where the targeted
// lookup did not. That is an undetermined answer about the transaction rather than a held one,
// and signing it as held hands an originator half a receipt with no way to tell.
func DepositMembersMatchOutcome(v *DepositVerdict) error {
	if v == nil {
		return fmt.Errorf("deposit verdict is nil")
	}
	switch v.Outcome {
	case DepositVerdictOutcomeHeld:
		if v.TransactionHash == "" {
			return fmt.Errorf("outcome %q requires transaction_hash, which is empty", v.Outcome)
		}
	case DepositVerdictOutcomeNotHeld, DepositVerdictOutcomeUndetermined:
		if v.TransactionHash != "" {
			return fmt.Errorf("outcome %q requires an empty transaction_hash, got %q", v.Outcome, v.TransactionHash)
		}
	}
	return nil
}

// verdictNormalizeChainID applies the one normalization a CAIP-2 reference admits: the
// namespace is lowercase and the reference is case-sensitive and signed verbatim.
//
// Lowercasing the whole string would break `solana:*`, whose reference is a mixed-case base58
// genesis-hash prefix encoded into on-chain state, so a consumer that folded case would fetch
// a key for a chain the verdict never named.
func verdictNormalizeChainID(chainID string) string {
	i := strings.IndexByte(chainID, ':')
	if i < 0 {
		return strings.ToLower(chainID)
	}
	return strings.ToLower(chainID[:i]) + chainID[i:]
}

// verdictNormalizePaymentID folds a payment identifier to the single spelling a verdict may
// carry, which is lowercase hex. It does not add or remove a 0x prefix, because a value
// missing one is a different value rather than the same one spelled differently.
func verdictNormalizePaymentID(paymentID string) string {
	return strings.ToLower(paymentID)
}

// VerdictBindsTo performs verification steps 2 and 3: the verdict is about the payment and the
// chain the caller asked about.
//
// This is the step whose absence is invisible in testing, because a signature proves what was
// attested and never which question it answers. A genuine verdict about another payment passes
// every cryptographic check, and accepting one lets that payment's delivery mark this one
// complete.
//
// The comparison is against the normalized form rather than the caller's own bytes, because
// both members are narrower in a verdict than in a request: a caller comparing verbatim would
// reject every valid verdict whose request used another legal spelling. Normalizing BOTH sides
// is what makes the check reject only genuine mismatches.
func VerdictBindsTo(v *FulfillmentVerdict, paymentID, chainID string) error {
	if v == nil {
		return fmt.Errorf("verdict is nil")
	}
	if got, want := verdictNormalizePaymentID(v.PaymentId), verdictNormalizePaymentID(paymentID); got != want {
		return fmt.Errorf("verdict is about payment %s, not %s", got, want)
	}
	if got, want := verdictNormalizeChainID(v.ChainId), verdictNormalizeChainID(chainID); got != want {
		return fmt.Errorf("verdict is about chain %s, not %s", got, want)
	}
	return nil
}

// DepositBindsTo performs the same two steps for a deposit verdict, plus the third its own
// recipe adds: the escrow the deposit was made into.
//
// The escrow comparison is not optional padding. A not_held verdict read against the wrong
// contract is indistinguishable from a correct one, and a chain may carry more than one escrow
// deployment, so without this step an absence proven somewhere else reads as an absence here.
func DepositBindsTo(v *DepositVerdict, paymentID, chainID, escrowAddress string) error {
	if v == nil {
		return fmt.Errorf("deposit verdict is nil")
	}
	if got, want := verdictNormalizePaymentID(v.PaymentId), verdictNormalizePaymentID(paymentID); got != want {
		return fmt.Errorf("deposit verdict is about payment %s, not %s", got, want)
	}
	if got, want := verdictNormalizeChainID(v.ChainId), verdictNormalizeChainID(chainID); got != want {
		return fmt.Errorf("deposit verdict is about chain %s, not %s", got, want)
	}
	// Addresses are lowercase hex on eip155 and case-sensitive base58 elsewhere, so this folds
	// on the same rule as a chain reference: only where the encoding itself is case-insensitive.
	got, want := v.EscrowAddress, escrowAddress
	if strings.HasPrefix(got, "0x") && strings.HasPrefix(want, "0x") {
		got, want = strings.ToLower(got), strings.ToLower(want)
	}
	if got != want {
		return fmt.Errorf("deposit verdict is about escrow %s, not %s", got, want)
	}
	return nil
}

// verdictRequiredMembers is the member set a wire verdict must carry, matching the component's
// required list. Kept as data so the decoder and the schema cannot drift apart silently.
var verdictRequiredMembers = []string{
	"domain", "payment_id", "chain_id", "outcome",
	"block_number", "block_hash", "finality_policy", "transaction_hash", "fulfiller",
	"signature_scheme", "signature",
}

// depositVerdictRequiredMembers is the same for a deposit verdict.
var depositVerdictRequiredMembers = []string{
	"domain", "payment_id", "chain_id", "escrow_address", "outcome",
	"block_number", "block_hash", "finality_policy", "transaction_hash",
	"signature_scheme", "signature",
}

// requireMembers rejects an object that is missing any required key.
//
// This has to happen BEFORE decoding, and that is the whole reason it exists. Go fills an
// absent field with its zero value, so by the time a verdict is a struct an omitted member and
// an empty one are the same thing — and the empty string is a LEGAL value for two members. A
// verdict that arrived without `transaction_hash` is therefore indistinguishable from a
// not_delivered one that carried it empty, and the preimage renders identically for both, so
// the signature check cannot recover the difference either.
func requireMembers(raw []byte, required []string, what string) error {
	var present map[string]json.RawMessage
	if err := json.Unmarshal(raw, &present); err != nil {
		return fmt.Errorf("%s is not a JSON object: %w", what, err)
	}
	missing := make([]string, 0, len(required))
	for _, key := range required {
		if _, ok := present[key]; !ok {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("%s is missing required members: %s", what, strings.Join(missing, ", "))
	}
	return nil
}

// DecodeVerdict decodes a fulfillment verdict from its wire bytes, refusing an incomplete one.
//
// Use this rather than json.Unmarshal on the type directly. The schema makes rejecting an
// incomplete verdict a requirement and a plain decode cannot honour it, for the reason given on
// requireMembers.
func DecodeVerdict(raw []byte) (*FulfillmentVerdict, error) {
	if err := requireMembers(raw, verdictRequiredMembers, "verdict"); err != nil {
		return nil, err
	}
	var v FulfillmentVerdict
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, fmt.Errorf("verdict does not decode: %w", err)
	}
	if err := VerdictMembersMatchOutcome(&v); err != nil {
		return nil, err
	}
	return &v, nil
}

// DecodeDepositVerdict is the same for a deposit verdict.
func DecodeDepositVerdict(raw []byte) (*DepositVerdict, error) {
	if err := requireMembers(raw, depositVerdictRequiredMembers, "deposit verdict"); err != nil {
		return nil, err
	}
	var v DepositVerdict
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, fmt.Errorf("deposit verdict does not decode: %w", err)
	}
	if err := DepositMembersMatchOutcome(&v); err != nil {
		return nil, err
	}
	return &v, nil
}
