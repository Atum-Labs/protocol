package senderauth

import (
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	paymentrequest "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/PaymentRequest/v1/bindings/go/generated"
)

// A payment states its payee twice: signed, inside the deposit witness (destination and
// depositRequestHash), and unsigned, in payment_request.destination[0] and request_id. The escrow
// stores only the signed copy, while settlement pays the unsigned one, so every party that acts on a
// payment must confirm the two agree. The functions in this file are that check, identical in Go
// and TypeScript. Mirrors commitment.ts.

// CommitmentOutcome is the verdict of a destination-commitment check. Only OutcomeVerified admits a
// payment; every other outcome is a refusal.
type CommitmentOutcome string

const (
	// OutcomeVerified: the signed deposit commits exactly the payment being settled.
	OutcomeVerified CommitmentOutcome = "verified"
	// OutcomeSchemeMismatch: the source chain is unsupported, or message_scheme cannot authorise a
	// payment from it.
	OutcomeSchemeMismatch CommitmentOutcome = "scheme_mismatch"
	// OutcomeCommitmentAbsent: the signed deposit commits no destination or no request hash.
	OutcomeCommitmentAbsent CommitmentOutcome = "commitment_absent"
	// OutcomePrehashMismatch: message_prehash is unreadable, ambiguous, or not the document behind
	// the signed digest.
	OutcomePrehashMismatch CommitmentOutcome = "prehash_mismatch"
	// OutcomeSignerMismatch: the deposit is not signed by, or not made out to, the payment's source
	// account.
	OutcomeSignerMismatch CommitmentOutcome = "signer_mismatch"
	// OutcomeDestinationMismatch: the signed destination is not the payment's destination.
	OutcomeDestinationMismatch CommitmentOutcome = "destination_mismatch"
	// OutcomeRequestHashMismatch: the signed depositRequestHash is not keccak256 of the payment's
	// request_id, nor the request's depositRequestHash v2 once a v2 mode reads it. In retire mode it
	// also refuses a deposit that commits keccak256(request_id), which retire no longer accepts.
	OutcomeRequestHashMismatch CommitmentOutcome = "request_hash_mismatch"
	// OutcomeRequestMalformed: the payment request document is unreadable or ambiguous.
	OutcomeRequestMalformed CommitmentOutcome = "request_malformed"
	// OutcomeVerifierMisconfigured: the verifier did not supply what the check needs.
	OutcomeVerifierMisconfigured CommitmentOutcome = "verifier_misconfigured"
	// OutcomeQuoteRequestMismatch: a quote's payment_request_json does not commit the same terms as
	// the stored payment request (VerifyQuoteRequestBinding).
	OutcomeQuoteRequestMismatch CommitmentOutcome = "quote_request_mismatch"
)

// DestinationLeg is one payment_request.destination entry, exactly as the request states it.
type DestinationLeg struct {
	AssetIdentifier string `json:"asset_identifier"`
	Account         string `json:"account"`
}

// CommitmentExpectation is the payment's unsigned copy of the payee: the request's destination
// legs and request_id, exactly as sent.
type CommitmentExpectation struct {
	Destinations []DestinationLeg `json:"destinations"`
	RequestID    string           `json:"requestId"`
	// DepositRequestHashV2, when set, is the request's depositRequestHash v2 (0x + 64 lowercase
	// hex, from ReadDepositRequest), and a deposit may commit it instead of keccak256(request_id).
	// Empty accepts only v1.
	DepositRequestHashV2 string `json:"depositRequestHashV2,omitempty"`
}

// SignedDeposit is the payment's signed side. SignedMessages[0] is the deposit. SourceAccount is
// the payer; a Solana deposit signature is verified against it.
type SignedDeposit struct {
	SourceAssetIdentifier string               `json:"sourceAssetIdentifier"`
	SourceAccount         string               `json:"sourceAccount"`
	MessageScheme         string               `json:"messageScheme"`
	SignedMessages        []SignedMessageInput `json:"signedMessages"`
}

// SolanaDomain is the Solana escrow's signature domain, taken from the verifier's own
// configuration and never from the payment.
type SolanaDomain struct {
	EscrowProgramID string `json:"escrowProgramId"`
	ClusterID       string `json:"clusterId"`
	DomainVersion   int    `json:"domainVersion"`
}

// CommitmentOption is verifier configuration for a commitment check beyond the Solana domain.
// Mirrors the TS CommitmentOptions.
type CommitmentOption func(*commitmentOptions)

type commitmentOptions struct {
	tronChainIDs         map[string]int64
	depositRequestHashV2 DepositRequestHashV2Mode
	stellarEscrow        string
}

// DepositRequestHashV2Mode is how a check reads depositRequestHash v2. The zero value is off. The
// values are the TS depositRequestHashV2Mode option's.
type DepositRequestHashV2Mode string

const (
	// DepositRequestHashV2Off reads the request by exact name and accepts only v1, as before v2.
	DepositRequestHashV2Off DepositRequestHashV2Mode = ""
	// DepositRequestHashV2Audit reads the request with ReadDepositRequest too, but does not refuse
	// what it refuses: the check reads the request as DepositRequestHashV2Off does and reports the
	// refusal in CommitmentResult.StrictDetail.
	DepositRequestHashV2Audit DepositRequestHashV2Mode = "audit"
	// DepositRequestHashV2Enforce reads the request with ReadDepositRequest first, and refuses
	// what it refuses as request_malformed.
	DepositRequestHashV2Enforce DepositRequestHashV2Mode = "enforce"
	// DepositRequestHashV2Retire is DepositRequestHashV2Enforce with depositRequestHash v1 retired:
	// only a deposit that commits the request's v2 is admitted, and one committing
	// keccak256(request_id) is refused as request_hash_mismatch. VerifyRequestCommitment and
	// RequiredCommitmentOf read it; VerifyCommitment and VerifyPaymentRequestJSON refuse it as
	// verifier_misconfigured.
	DepositRequestHashV2Retire DepositRequestHashV2Mode = "retire"
)

// WithDepositRequestHashV2 sets how the check reads depositRequestHash v2. Without it, or with
// DepositRequestHashV2Off, the check is exactly as before v2. A later WithDepositRequestHashV2
// replaces an earlier one.
func WithDepositRequestHashV2(mode DepositRequestHashV2Mode) CommitmentOption {
	return func(o *commitmentOptions) { o.depositRequestHashV2 = mode }
}

// detailDepositRequestHashV1Retired is the refusal of a deposit that commits v1 in retire mode.
const detailDepositRequestHashV1Retired = "the deposit commits depositRequestHash v1, keccak256(request_id), which this verifier no longer accepts: sign depositRequestHash v2"

// WithStellarEscrow supplies the Stellar escrow's contract id (a C... strkey), from the verifier's own
// configuration and never from the payment. The network id comes from the payment's own
// stellar:<reference> source chain. Without it a Stellar payment is refused as
// verifier_misconfigured. Mirrors the TS stellarEscrow option.
func WithStellarEscrow(escrow string) CommitmentOption {
	return func(o *commitmentOptions) { o.stellarEscrow = escrow }
}

// WithTronChainIDs supplies TIP-712 chain ids by Tron cluster, from the verifier's own
// configuration, for networks TronChainIDs does not know, such as a local node's tron:localnet.
// TronChainIDs stays authoritative: an entry for a cluster it knows must repeat its id, an entry
// for any other cluster must not repeat an id it gives a cluster, and an entry must be in
// 1..4294967295, or a payment sourced on that cluster is refused as verifier_misconfigured. Only
// the entry for a Tron source's own cluster is read. A later WithTronChainIDs replaces an earlier
// one. Mirrors the TS tronChainIds option.
func WithTronChainIDs(ids map[string]int64) CommitmentOption {
	return func(o *commitmentOptions) { o.tronChainIDs = ids }
}

// commitmentOptionsOf applies opts in order, skipping nil ones.
func commitmentOptionsOf(opts []CommitmentOption) commitmentOptions {
	var o commitmentOptions
	for _, opt := range opts {
		if opt != nil {
			opt(&o)
		}
	}
	return o
}

// CommitmentResult is the outcome of a check plus the values it compared. It is returned for
// admissions and refusals alike, so both can be logged and counted.
type CommitmentResult struct {
	Outcome                    CommitmentOutcome `json:"outcome"`
	Detail                     string            `json:"detail,omitempty"`
	Namespace                  string            `json:"namespace,omitempty"`
	Scheme                     string            `json:"scheme,omitempty"`
	SignedDestination          string            `json:"signedDestination,omitempty"`
	ExpectedDestination        string            `json:"expectedDestination,omitempty"`
	SignedDepositRequestHash   string            `json:"signedDepositRequestHash,omitempty"`
	ExpectedDepositRequestHash string            `json:"expectedDepositRequestHash,omitempty"`
	// ExpectedDepositRequestHashV2 is the request's depositRequestHash v2, when the check was given
	// one (CommitmentExpectation.DepositRequestHashV2).
	ExpectedDepositRequestHashV2 string `json:"expectedDepositRequestHashV2,omitempty"`
	// StrictDetail is why ReadDepositRequest refused the request, in DepositRequestHashV2Audit mode.
	// The check then read it as it did before v2. Empty in every other mode.
	StrictDetail string `json:"strictDetail,omitempty"`
	// DepositRequestHashVersion is the depositRequestHash version the deposit matched, v1 or v2,
	// once the check is opted in with WithDepositRequestHashV2. Empty otherwise, and on a refusal.
	// The values are the version label of the deposit_request_hash.match metric; empty is none.
	DepositRequestHashVersion string `json:"depositRequestHashVersion,omitempty"`
}

// Verified reports whether the payment is admitted.
func (r CommitmentResult) Verified() bool { return r.Outcome == OutcomeVerified }

// LogFields returns the result as structured log fields. The keys are the same in both languages.
func (r CommitmentResult) LogFields() map[string]string {
	fields := map[string]string{
		"sender_auth_result":           string(r.Outcome),
		"scheme":                       r.Scheme,
		"source_namespace":             r.Namespace,
		"signed_destination":           r.SignedDestination,
		"request_destination":          r.ExpectedDestination,
		"signed_deposit_request_hash":  r.SignedDepositRequestHash,
		"request_deposit_request_hash": r.ExpectedDepositRequestHash,
		"detail":                       r.Detail,
	}
	// The depositRequestHash v2 fields, only when set, so an unopted check logs the same keys.
	for key, value := range map[string]string{
		"deposit_request_hash_version":    r.DepositRequestHashVersion,
		"request_deposit_request_hash_v2": r.ExpectedDepositRequestHashV2,
		"strict_detail":                   r.StrictDetail,
	} {
		if value != "" {
			fields[key] = value
		}
	}
	return fields
}

// CommitmentError is the error returned with every refusal. Its Result carries the outcome.
type CommitmentError struct{ Result CommitmentResult }

// Error implements error.
func (e *CommitmentError) Error() string {
	return "sender_auth: " + string(e.Result.Outcome) + ": " + e.Result.Detail
}

// permittedSchemes lists, per source namespace, the message schemes that can authorise a payment
// from it. The scheme is not signed, so it is checked against the namespace and never dispatched on.
var permittedSchemes = map[string][]SenderAuthMessageScheme{
	"eip155":  {paymentrequest.SenderAuthMessageSchemeEVMPERMIT2, paymentrequest.SenderAuthMessageSchemeEVMPERMIT2ESCROW},
	"tron":    {paymentrequest.SenderAuthMessageSchemeEVMPERMIT2, paymentrequest.SenderAuthMessageSchemeEVMPERMIT2ESCROW, paymentrequest.SenderAuthMessageSchemeTRON},
	"solana":  {paymentrequest.SenderAuthMessageSchemeSOLANA},
	"stellar": {paymentrequest.SenderAuthMessageSchemeSTELLAR},
}

// VerifyCommitment checks that the signed deposit commits to exactly the payee and request the
// payment states, reading the source chain from the payment and never from message_scheme. On
// Solana it also verifies the ed25519 signature against the source account. On EVM and Tron the
// signature is checked on chain by Permit2, which accepts contract accounts (ERC-1271) whose
// signature comes from an owner key, so this check does not recover the signer; RecoverAndVerify
// does, for key accounts. The token, amount, roles and freshness are RecoverAndVerify's. solana is
// required for a Solana source and ignored otherwise; WithTronChainIDs is read for a Tron source
// and ignored otherwise. The error is a *CommitmentError exactly when the result is not verified.
//
// Deprecated: the caller reads the inputs out of the request itself, so the check cannot see the
// bytes it acts on, and it accepts depositRequestHash v2 only if the caller derives it: any
// WithDepositRequestHashV2 mode, retire included, is refused as verifier_misconfigured, so it never
// admits a v1 deposit a retiring caller meant to refuse. Use VerifyRequestCommitment with the
// request as received.
func VerifyCommitment(signed SignedDeposit, expected CommitmentExpectation, solana *SolanaDomain, opts ...CommitmentOption) (CommitmentResult, error) {
	if commitmentOptionsOf(opts).depositRequestHashV2 != DepositRequestHashV2Off {
		return refuse(CommitmentResult{}, OutcomeVerifierMisconfigured,
			"VerifyCommitment cannot read depositRequestHash v2 from the request; use VerifyRequestCommitment for depositRequestHashV2")
	}
	return verifyCommitment(signed, expected, solana, opts...)
}

// verifyCommitment is VerifyCommitment, for the entry points that read the request themselves.
func verifyCommitment(signed SignedDeposit, expected CommitmentExpectation, solana *SolanaDomain, opts ...CommitmentOption) (CommitmentResult, error) {
	o := commitmentOptionsOf(opts)
	r := CommitmentResult{Scheme: echo(signed.MessageScheme)}
	network, namespace, sourceOutcome, sourceDetail := sourceNetwork(signed.SourceAssetIdentifier, o.tronChainIDs)
	r.Namespace = echo(namespace)
	if len(signed.SignedMessages) == 0 {
		return refuse(r, OutcomeCommitmentAbsent, "no signed messages, so the destination the payer signed cannot be read")
	}
	if sourceDetail != "" {
		return refuse(r, sourceOutcome, sourceDetail)
	}
	if !slices.Contains(permittedSchemes[namespace], SenderAuthMessageScheme(signed.MessageScheme)) {
		return refuse(r, OutcomeSchemeMismatch,
			fmt.Sprintf("message_scheme %s cannot authorise a payment sourced on %s", quoteValue(signed.MessageScheme), namespace))
	}
	deposit := signed.SignedMessages[0]
	if namespace == "solana" {
		return verifySolanaCommitment(r, signed.SourceAccount, deposit, expected, solana)
	}
	if namespace == "stellar" {
		return verifyStellarCommitment(r, network, signed.SourceAccount, deposit, expected, o.stellarEscrow)
	}
	return verifyPermitCommitment(r, namespace, network, deposit, expected, o.tronChainIDs)
}

// CompareCommitment compares already-extracted signed commitment values with the payment's own
// (rules: exactly one destination leg, byte-exact destination, depositRequestHash equal to
// keccak256(request_id), or to expected.DepositRequestHashV2 when set). Use it when the signed
// values come from a deposit builder rather than a message_prehash.
//
// Deprecated: it compares values the caller extracted, and accepts depositRequestHash v2 only if
// the caller derives it. Judge a deposit with VerifyRequestCommitment on the signed request as
// received. When the deposit's values come from your own builder, compare them with the
// Destination and the DepositRequestHash or DepositRequestHashV2 that RequiredCommitmentOf returns.
func CompareCommitment(signedDestination, signedDepositRequestHash string, expected CommitmentExpectation) (CommitmentResult, error) {
	r := CommitmentResult{SignedDestination: echo(signedDestination), SignedDepositRequestHash: echo(signedDepositRequestHash)}
	if isJSONBlank(signedDestination) {
		return refuse(r, OutcomeCommitmentAbsent, detailNoDestination)
	}
	if isJSONBlank(signedDepositRequestHash) {
		return refuse(r, OutcomeCommitmentAbsent, detailNoRequestHash)
	}
	hash, ok := parseHash32(signedDepositRequestHash)
	if !ok {
		return refuse(r, OutcomePrehashMismatch, detailBadRequestHash)
	}
	return finish(compareExpected(r, signedDestination, hash, expected))
}

const (
	detailNoPrehash      = "no message_prehash, so the destination the payer signed cannot be read"
	detailNoDestination  = "the deposit witness commits no destination, and every deployed escrow requires one"
	detailNoRequestHash  = "the deposit witness commits no depositRequestHash, and every deployed escrow requires one"
	detailBadRequestHash = "the signed depositRequestHash is not a 32-byte hex value"

	detailBadDigest            = "the signed message is not a 32-byte hex digest"
	detailPermitDigestMismatch = "the signed digest is not the EIP-712 hash of message_prehash"
	detailSignerMismatch       = "the deposit signature does not recover to the payment's source account"
	detailDeadlineRange        = "the signed deadline is beyond the largest supported value"
	detailNoTronPermit2        = "no Permit2 contract is known for this Tron network; the verifier must supply one"
)

// compareExpected applies the comparison rules to values already read and validated.
func compareExpected(r CommitmentResult, signedDestination string, signedHash [32]byte, expected CommitmentExpectation) CommitmentResult {
	r.SignedDestination = echo(signedDestination)
	if !isWellFormedText(signedDestination) {
		return withOutcome(r, OutcomePrehashMismatch, "the signed destination is not well-formed text")
	}
	destination, outcome, detail := requestDestination(expected.Destinations)
	if outcome != "" {
		return withOutcome(r, outcome, detail)
	}
	r.ExpectedDestination = destination
	if signedDestination != destination {
		return withOutcome(r, OutcomeDestinationMismatch, fmt.Sprintf("the payer signed a deposit payable to %s, but this payment pays %s",
			quoteValue(signedDestination), quoteValue(destination)))
	}
	want, outcome, detail := requestDepositRequestHash(expected.RequestID)
	if outcome != "" {
		return withOutcome(r, outcome, detail)
	}
	r.ExpectedDepositRequestHash = want
	v2 := expected.DepositRequestHashV2
	r.ExpectedDepositRequestHashV2 = v2
	switch signed := "0x" + hex.EncodeToString(signedHash[:]); {
	case signed == want:
		if v2 != "" {
			r.DepositRequestHashVersion = "v1"
		}
	case v2 != "" && signed == v2:
		r.DepositRequestHashVersion = "v2"
	case v2 != "":
		return withOutcome(r, OutcomeRequestHashMismatch, fmt.Sprintf(
			"the payer signed a deposit for another request: depositRequestHash %s is neither keccak256 of request_id %s nor this request's depositRequestHash v2 %s",
			r.SignedDepositRequestHash, quoteValue(expected.RequestID), v2))
	default:
		return withOutcome(r, OutcomeRequestHashMismatch, fmt.Sprintf(
			"the payer signed a deposit for another request: depositRequestHash %s is not keccak256 of request_id %s",
			r.SignedDepositRequestHash, quoteValue(expected.RequestID)))
	}
	return withOutcome(r, OutcomeVerified, "")
}

// The payment's side of the comparison: two rules that read the request alone, one per signed value.
// RequiredCommitmentOf applies them to a request with no signed prehash, so it returns exactly what
// compareExpected compares against rather than a copy of the rules. They are two, not one,
// because compareExpected compares the destination before it reads request_id, and that order
// decides which refusal a payment wrong in both gets.

// requestDestination returns the destination a deposit for this payment must commit:
// BuildEscrowDestination of its one leg. It refuses, with a non-empty outcome, a payment that does
// not name exactly one destination, or whose destination cannot be composed. Mirrors TS
// requestDestination.
func requestDestination(legs []DestinationLeg) (string, CommitmentOutcome, string) {
	if len(legs) != 1 {
		return "", OutcomeDestinationMismatch, fmt.Sprintf("the payment names %d destinations; exactly one can be committed to", len(legs))
	}
	destination, err := BuildEscrowDestination(legs[0].AssetIdentifier, legs[0].Account)
	if err != nil {
		return "", OutcomeDestinationMismatch, echo("the payment's destination cannot be committed to: " + err.Error())
	}
	return destination, "", ""
}

// requestDepositRequestHash returns the depositRequestHash a deposit for this payment must commit:
// keccak256(request_id) as 0x + 64 lowercase hex. It refuses, with a non-empty outcome, a request_id
// that is not well-formed text, since Go and TypeScript would hash different bytes, or that is empty,
// since every empty id would commit to the same hash. Mirrors TS requestDepositRequestHash.
func requestDepositRequestHash(requestID string) (string, CommitmentOutcome, string) {
	if !isWellFormedText(requestID) {
		return "", OutcomeRequestHashMismatch, "the payment's request_id is not well-formed text"
	}
	if requestID == "" {
		return "", OutcomeRequestHashMismatch, "the payment's request_id is empty, so no deposit request hash can be derived"
	}
	hash, err := DeriveDepositRequestHash(requestID)
	if err != nil {
		return "", OutcomeRequestHashMismatch, "the payment's request_id cannot be hashed: " + err.Error()
	}
	return "0x" + hex.EncodeToString(hash[:]), "", ""
}

// sourceNetwork reads the CAIP-2 network and namespace of the payment's source asset, and a refusal
// when the chain is not one the check supports: scheme_mismatch, or verifier_misconfigured when a
// supplied Tron chain id cannot be used. Mirrors TS sourceNetwork.
func sourceNetwork(assetIdentifier string, tronChainIDs map[string]int64) (network, namespace string, outcome CommitmentOutcome, detail string) {
	if _, err := assetAddress(assetIdentifier); err != nil {
		return "", "", OutcomeSchemeMismatch, fmt.Sprintf("source asset_identifier %s is not a valid CAIP-19 asset", quoteValue(assetIdentifier))
	}
	network = strings.SplitN(assetIdentifier, "/", 2)[0]
	namespace = namespaceOf(network)
	var err error
	switch namespace {
	case "eip155":
		var id int64
		if id, err = evmChainID(network); err == nil && network != "eip155:"+strconv.FormatInt(id, 10) {
			err = fmt.Errorf("non-canonical chain reference")
		}
	case "tron":
		_, err = tronNumericChainID(network, tronChainIDs)
	case "solana":
	case "stellar":
		_, err = stellarNetworkString(network)
	default:
		return network, namespace, OutcomeSchemeMismatch, fmt.Sprintf("source chain namespace %s has no destination commitment rule", quoteValue(namespace))
	}
	var misconfigured *tronChainIDError
	if errors.As(err, &misconfigured) {
		return network, namespace, OutcomeVerifierMisconfigured, misconfigured.detail
	}
	if err != nil {
		return network, namespace, OutcomeSchemeMismatch, fmt.Sprintf("source chain %s is not a supported %s network", quoteValue(network), namespace)
	}
	return network, namespace, "", ""
}

var hash32Pattern = regexp.MustCompile(`^(0x)?[0-9a-fA-F]{64}$`)

// parseHash32 reads a 32-byte hex value: optional lowercase 0x prefix, no whitespace.
func parseHash32(s string) ([32]byte, bool) {
	var out [32]byte
	if !hash32Pattern.MatchString(s) {
		return out, false
	}
	b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil {
		return out, false
	}
	copy(out[:], b)
	return out, true
}

// isJSONBlank reports whether s is empty or only JSON whitespace (space, tab, LF, CR).
func isJSONBlank(s string) bool {
	return strings.Trim(s, " \t\n\r") == ""
}

// maxEchoLength bounds, in code points, every input value a result or detail echoes, so an oversized
// input cannot bloat logs. Every honest value is far shorter.
const maxEchoLength = 512

// echo returns s, cut to maxEchoLength code points. It reads no further than the cut, so an
// oversized value costs no more than the part it keeps.
func echo(s string) string {
	count := 0
	for i := range s {
		if count == maxEchoLength {
			return string([]rune(s[:i])) + "..."
		}
		count++
	}
	return s
}

// isWellFormedText reports whether s is valid UTF-8 with no U+FFFD. A lone surrogate escape decodes
// to U+FFFD in Go but stays a lone surrogate in JavaScript, so neither may reach a comparison.
func isWellFormedText(s string) bool {
	return utf8.ValidString(s) && !strings.ContainsRune(s, utf8.RuneError)
}

// quoteValue quotes s for a detail message, escaping only '"', '\' and control characters so both
// languages render the same text.
func quoteValue(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range echo(s) {
		switch {
		case r == '"' || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r < 0x20:
			fmt.Fprintf(&b, "\\u%04x", r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func withOutcome(r CommitmentResult, outcome CommitmentOutcome, detail string) CommitmentResult {
	r.Outcome = outcome
	r.Detail = detail
	return r
}

// CommitmentResultOf returns the commitment result an error carries, and whether it carries one.
// Refusals from VerifyCommitment, VerifyRequestCommitment, CompareCommitment, RequiredCommitmentOf
// and RecoverAndVerify's commitment rules all carry one.
func CommitmentResultOf(err error) (CommitmentResult, bool) {
	var ce *CommitmentError
	if errors.As(err, &ce) {
		return ce.Result, true
	}
	return CommitmentResult{}, false
}

func refuse(r CommitmentResult, outcome CommitmentOutcome, detail string) (CommitmentResult, error) {
	return finish(withOutcome(r, outcome, detail))
}

func finish(r CommitmentResult) (CommitmentResult, error) {
	if r.Verified() {
		return r, nil
	}
	return r, &CommitmentError{Result: r}
}
