package senderauth

import (
	"encoding/binary"
	"maps"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/crypto"
)

// depositRequestHash v2 commits the payment terms, not just request_id, so a copy of the request
// that any party edits no longer matches what the payer signed. It is keccak256 over a flat preimage
// of length-prefixed fields that leaves out sender_auth. The preimage is pinned by
// PaymentRequest/v1/conformance/deposit-request-hash-v2-vectors.json, which every implementation
// must reproduce byte-for-byte. Mirrors deposit-request-v2.ts.

// depositRequestV2Domain opens every v2 preimage. 0xFF never occurs in UTF-8, so no request_id
// hashed by v1 can equal a v2 preimage.
const depositRequestV2Domain = 0xFF

// depositRequestV2Tag follows the domain byte and names the derivation.
const depositRequestV2Tag = "atum:deposit-request:v2"

// ExecutorRole is who performs one leg of a payment. Its value is the leg's byte in the v2 preimage.
type ExecutorRole byte

const (
	ExecutorSettler    ExecutorRole = 0x00
	ExecutorOriginator ExecutorRole = 0x01
)

// ExecutorLegs is the executor expanded to its three legs. An absent executor, and "settler", are
// settler for every leg.
type ExecutorLegs struct {
	Deposit ExecutorRole `json:"deposit"`
	Reserve ExecutorRole `json:"reserve"`
	Fulfill ExecutorRole `json:"fulfill"`
}

// DepositTerms are the payment terms v2 commits, as the reader acts on them.
type DepositTerms struct {
	RequestID             string `json:"requestId"`
	SourceAssetIdentifier string `json:"sourceAssetIdentifier"`
	SourceAccount         string `json:"sourceAccount"`
	// Destination is the one destination leg, composed by BuildEscrowDestination.
	Destination string `json:"destination"`
	// FulfillmentAmount is the decimal amount with leading zeros stripped ("0" for zero).
	FulfillmentAmount string `json:"fulfillmentAmount"`
	// MaxSourceAmount is nil when the request omits it or sets it to null.
	MaxSourceAmount *string `json:"maxSourceAmount,omitempty"`
	// QuoteDeadline and FulfillmentDeadline are Unix seconds, floored.
	QuoteDeadline       uint64       `json:"quoteDeadline"`
	FulfillmentDeadline uint64       `json:"fulfillmentDeadline"`
	Executor            ExecutorLegs `json:"executor"`
	// FulfillmentProxy is nil when the request omits it or sets it to null; "" is present.
	FulfillmentProxy      *string `json:"fulfillmentProxy,omitempty"`
	EscrowContractAddress string  `json:"escrowContractAddress"`
	// QuoteSelector is nil when the request omits it or sets it to null; "" is present.
	QuoteSelector               *string `json:"quoteSelector,omitempty"`
	FulfillmentVerifierAccount  string  `json:"fulfillmentVerifierAccount"`
	FulfillmentVerifierEndpoint string  `json:"fulfillmentVerifierEndpoint"`
}

// DepositRequest is a payment request as ReadDepositRequest reads it: the terms it acts on, the v2
// hash of exactly those terms, and the v1 hash of its request_id. A deposit commits one of the two.
type DepositRequest struct {
	Terms                DepositTerms `json:"terms"`
	DepositRequestHashV1 [32]byte     `json:"depositRequestHashV1"`
	DepositRequestHashV2 [32]byte     `json:"depositRequestHashV2"`
	// DepositNonce is the originator-executed deposit's deposit_nonce exactly as sent, nil when
	// absent. Neither hash commits it: the deposit id does (DeriveDirectDeposit).
	DepositNonce *string `json:"depositNonce,omitempty"`
}

// ReadDepositRequest reads a payment request exactly as received and returns the terms v2 commits
// together with their v2 hash and the v1 hash of the request. Act on the returned terms, never on
// another decode of the same bytes, so the decoder that hashes is the decoder that acts. A refusal
// is a *CommitmentError with outcome request_malformed.
//
// Repeated member names, including names that differ only in letter case, are refused everywhere
// except inside sender_auth, presentation and verifiableCredential (see requestShape). Every root
// member name is still checked, so a twin of sender_auth or verifiableCredential itself is refused.
// Inside those three v2 hashes nothing and this reader acts on nothing, and they are scanned where
// they are read: sender_auth by the commitment check (requestReadMembers), a presentation and its
// credentials by VerifyVP and VerifyVCProof. The other opaque members, proof, originator_auth and
// settler_auth_required, are scanned here, because their readers do not scan them. In audit the
// commitment check only reports this reader's refusals, so ingress keeps its whole-body twin scan
// until it enforces.
func ReadDepositRequest(request []byte) (DepositRequest, error) {
	path, err := FirstAmbiguousMemberIn(request, strictReadMembers)
	if err != nil {
		return refuseDepositRequest("the payment request is not a single valid JSON document")
	}
	if path != "" {
		return refuseDepositRequest("the payment request carries two members that differ only in letter case, at " + echo(path))
	}
	root, err := decodeScanned(request)
	if err != nil {
		return refuseDepositRequest("the payment request is not a single valid JSON document")
	}
	doc, ok := root.(map[string]any)
	if !ok {
		return refuseDepositRequest("the payment request is not readable: the document is not an object")
	}
	if path := firstUnknownMember(doc, requestShape, "$"); path != "" {
		return refuseDepositRequest("the payment request is not readable: " + echo(path) + " is not a PaymentRequest member")
	}
	terms, problem := readDepositTerms(doc)
	if problem != "" {
		return refuseDepositRequest("the payment request is not readable: " + problem)
	}
	// The nonce names a deposit the payer funded itself. On any other request it is not a member,
	// as before the schema had it, so this reader and the rules agree without the rules running.
	var depositNonce *string
	if raw, present := doc["deposit_nonce"]; present {
		if terms.Executor.Deposit != ExecutorOriginator {
			return refuseDepositRequest("the payment request is not readable: $.deposit_nonce is only a member of an originator-executed deposit")
		}
		text, ok := raw.(string)
		if !ok {
			return refuseDepositRequest("the payment request is not readable: $.deposit_nonce is not a string")
		}
		depositNonce = &text
	}
	preimage, ok := depositRequestPreimageV2(terms)
	if !ok {
		return refuseDepositRequest("the payment request is not readable: a member is longer than a uint32 length prefix can count")
	}
	return DepositRequest{
		Terms:        terms,
		DepositNonce: depositNonce,
		// The request_id pattern already refused an empty id, the one DeriveDepositRequestHash refuses.
		DepositRequestHashV1: crypto.Keccak256Hash([]byte(terms.RequestID)),
		DepositRequestHashV2: crypto.Keccak256Hash(preimage),
	}, nil
}

// DepositRequestHashV2 returns the v2 depositRequestHash of a payment request exactly as received:
// ReadDepositRequest's hash.
func DepositRequestHashV2(request []byte) ([32]byte, error) {
	read, err := ReadDepositRequest(request)
	if err != nil {
		return [32]byte{}, err
	}
	return read.DepositRequestHashV2, nil
}

func refuseDepositRequest(detail string) (DepositRequest, error) {
	_, err := refuse(CommitmentResult{}, OutcomeRequestMalformed, detail)
	return DepositRequest{}, err
}

// memberShape is what the PaymentRequest schema allows at one position of a request: the members of
// an object and their shapes, and the shape of an array's elements. A position with neither holds a
// scalar. An opaque position is never walked for unknown members: v2 does not hash it, and no reader
// acts on it from a copy authenticated by v2. It is still scanned for repeated names unless
// scannedWhereRead: its readers scan it themselves.
type memberShape struct {
	members          map[string]*memberShape
	elems            *memberShape
	opaque           bool
	scannedWhereRead bool
}

var (
	scalarShape = &memberShape{}
	opaqueShape = &memberShape{opaque: true}
	// scannedWhereReadShape is an opaque member whose readers scan it for repeated names: sender_auth
	// by the commitment check (requestReadMembers), a presentation and its credentials by VerifyVP
	// and VerifyVCProof. A repeated name there is theirs to refuse, so a credential a reader accepts
	// does not make the request unreadable.
	scannedWhereReadShape = &memberShape{opaque: true, scannedWhereRead: true}

	ownedAssetShape = &memberShape{members: map[string]*memberShape{
		"asset_identifier": scalarShape,
		"account":          scalarShape,
	}}
	// requestShape is the PaymentRequest schema outside the opaque subtrees. It is checked against
	// schema.json by TestRequestShapeMatchesSchema.
	requestShape = &memberShape{members: map[string]*memberShape{
		"@context":             {elems: scalarShape},
		"version":              scalarShape,
		"request_id":           scalarShape,
		"source":               ownedAssetShape,
		"destination":          {elems: ownedAssetShape},
		"fulfillment_amount":   scalarShape,
		"max_source_amount":    scalarShape,
		"quote_deadline":       scalarShape,
		"fulfillment_deadline": scalarShape,
		"executor": {members: map[string]*memberShape{
			"deposit": scalarShape,
			"reserve": scalarShape,
			"fulfill": scalarShape,
		}},
		// Read, never hashed: the deposit id binds the nonce (TestDepositRequestHashV2IgnoresTheDepositNonce).
		"deposit_nonce":           scalarShape,
		"fulfillment_proxy":       scalarShape,
		"escrow_contract_address": scalarShape,
		"quote_selector":          scalarShape,
		"fulfillment_verifier": {members: map[string]*memberShape{
			"account":  scalarShape,
			"endpoint": scalarShape,
		}},
		"settler_requirements": {members: map[string]*memberShape{
			"whitelist": {elems: scalarShape},
			"blacklist": {elems: scalarShape},
		}},
		// Opaque, but scanned here: their readers do not scan them.
		"settler_auth_required": opaqueShape,
		"originator_auth":       opaqueShape,
		"proof":                 opaqueShape,
		"sender_auth":           scannedWhereReadShape,
		"presentation":          scannedWhereReadShape,
		"verifiableCredential":  scannedWhereReadShape,
	}}
	// strictReadMembers are the root members whose values ReadDepositRequest scans for repeated
	// names: every member of requestShape except those scanned where they are read.
	strictReadMembers = membersScannedHere(requestShape)
)

// membersScannedHere returns the names of the members of shape not scanned where they are read,
// sorted.
func membersScannedHere(shape *memberShape) []string {
	var names []string
	for _, name := range slices.Sorted(maps.Keys(shape.members)) {
		if !shape.members[name].scannedWhereRead {
			names = append(names, name)
		}
	}
	return names
}

// firstUnknownMember returns the path of the first member under value that its position does not
// allow, or "" when there is none. Members are visited in code point order, not document order, so
// Go and TypeScript name the same member.
func firstUnknownMember(value any, shape *memberShape, path string) string {
	// The path is one stack of segments shared by every frame and joined only for the member
	// refused, so memory stays linear in the depth. Mirrors the TS firstUnknownMember.
	segments := []string{path}
	if !walkKnownMembers(value, shape, &segments) {
		return strings.Join(segments, "")
	}
	return ""
}

// walkKnownMembers reports whether every member under value is allowed at its position. When one is
// not, it returns false with segments ending at that member's path.
func walkKnownMembers(value any, shape *memberShape, segments *[]string) bool {
	if shape.opaque {
		return true
	}
	switch v := value.(type) {
	case map[string]any:
		for _, name := range slices.Sorted(maps.Keys(v)) {
			*segments = append(*segments, "."+name)
			child, ok := shape.members[name]
			if !ok || !walkKnownMembers(v[name], child, segments) {
				return false
			}
			*segments = (*segments)[:len(*segments)-1]
		}
	case []any:
		elems := shape.elems
		if elems == nil {
			elems = scalarShape
		}
		for i, elem := range v {
			*segments = append(*segments, "["+strconv.Itoa(i)+"]")
			if !walkKnownMembers(elem, elems, segments) {
				return false
			}
			*segments = (*segments)[:len(*segments)-1]
		}
	}
	return true
}

// requestVersionPattern is the schema's version pattern. v2 does not hash version, but a request of
// another major is not a PaymentRequest v1 and is refused.
var requestVersionPattern = regexp.MustCompile(`^1\.[0-9]+$`)

// requestIDPattern bounds request_id to ASCII that can never contain the 0xFF domain byte, so no v1
// hash of a request_id can equal a v2 hash.
var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

// requestContextLists are the @context lists a PaymentRequest v1 signer injects, one per signature
// suite (signing/hash.go and signing/sign_ed25519.go).
var requestContextLists = [][]string{
	{"https://schemas.atum.network/declarations/PaymentRequest/v1/context.jsonld", "https://w3id.org/security/suites/secp256k1recovery-2020/v2"},
	{"https://schemas.atum.network/declarations/PaymentRequest/v1/context.jsonld", "https://w3id.org/security/suites/ed25519-2020/v1"},
}

// isRequestContext reports whether a top-level @context value is absent (or null), or exactly one
// of requestContextLists, in order.
func isRequestContext(value any) bool {
	if value == nil {
		return true
	}
	list, ok := value.([]any)
	if !ok {
		return false
	}
	return slices.ContainsFunc(requestContextLists, func(want []string) bool {
		return slices.EqualFunc(list, want, func(got any, w string) bool { return got == w })
	})
}

// readDepositTerms reads the terms by exact member name. problem names the first member that cannot
// be read.
func readDepositTerms(doc map[string]any) (DepositTerms, string) {
	var t DepositTerms
	var ok bool
	if !isRequestContext(doc["@context"]) {
		return t, "@context is neither absent nor one of the PaymentRequest v1 context lists"
	}
	version, ok := doc["version"].(string)
	if !ok {
		return t, "version is not a string"
	}
	if !requestVersionPattern.MatchString(version) {
		return t, "version is not a PaymentRequest v1 version (1.<minor>)"
	}
	if t.RequestID, ok = doc["request_id"].(string); !ok {
		return t, "request_id is not a string"
	}
	if !requestIDPattern.MatchString(t.RequestID) {
		return t, `request_id is not 1 to 128 of A-Z, a-z, 0-9, ".", "_" and "-"`
	}
	source, ok := doc["source"].(map[string]any)
	if !ok {
		return t, "source is not an object"
	}
	if t.SourceAssetIdentifier, ok = source["asset_identifier"].(string); !ok {
		return t, "source.asset_identifier is not a string"
	}
	if t.SourceAccount, ok = source["account"].(string); !ok {
		return t, "source.account is not a string"
	}
	legs, ok := doc["destination"].([]any)
	if !ok {
		return t, "destination is not an array"
	}
	var destinations []DestinationLeg
	for i, raw := range legs {
		name := "destination[" + strconv.Itoa(i) + "]"
		leg, ok := raw.(map[string]any)
		if !ok {
			return t, name + " is not an object"
		}
		asset, aok := leg["asset_identifier"].(string)
		account, cok := leg["account"].(string)
		if !aok || !cok {
			return t, name + " asset_identifier and account must be strings"
		}
		destinations = append(destinations, DestinationLeg{AssetIdentifier: asset, Account: account})
	}
	destination, outcome, detail := requestDestination(destinations)
	if outcome != "" {
		return t, detail
	}
	t.Destination = destination
	amount, ok := doc["fulfillment_amount"].(string)
	if !ok {
		return t, "fulfillment_amount is not a string"
	}
	var problem string
	if t.FulfillmentAmount, problem = readAmount(amount, "fulfillment_amount"); problem != "" {
		return t, problem
	}
	if t.MaxSourceAmount, problem = readOptionalString(doc, "max_source_amount"); problem != "" {
		return t, problem
	}
	if t.MaxSourceAmount != nil {
		amount, problem := readAmount(*t.MaxSourceAmount, "max_source_amount")
		if problem != "" {
			return t, problem
		}
		t.MaxSourceAmount = &amount
	}
	if t.QuoteDeadline, problem = readDeadline(doc, "quote_deadline"); problem != "" {
		return t, problem
	}
	if t.FulfillmentDeadline, problem = readDeadline(doc, "fulfillment_deadline"); problem != "" {
		return t, problem
	}
	if t.Executor, problem = readExecutor(doc); problem != "" {
		return t, problem
	}
	if t.FulfillmentProxy, problem = readOptionalString(doc, "fulfillment_proxy"); problem != "" {
		return t, problem
	}
	if t.EscrowContractAddress, ok = doc["escrow_contract_address"].(string); !ok {
		return t, "escrow_contract_address is not a string"
	}
	if t.QuoteSelector, problem = readOptionalString(doc, "quote_selector"); problem != "" {
		return t, problem
	}
	verifier, ok := doc["fulfillment_verifier"].(map[string]any)
	if !ok {
		return t, "fulfillment_verifier is not an object"
	}
	if t.FulfillmentVerifierAccount, ok = verifier["account"].(string); !ok {
		return t, "fulfillment_verifier.account is not a string"
	}
	if t.FulfillmentVerifierEndpoint, ok = verifier["endpoint"].(string); !ok {
		return t, "fulfillment_verifier.endpoint is not a string"
	}
	return t, ""
}

// maxAmount is 2^256-1, the largest amount v2 commits. Per-chain limits stay in the chain adapters.
const maxAmount = "115792089237316195423570985008687907853269984665640564039457584007913129639935"

var amountPattern = regexp.MustCompile(`^[0-9]+$`)

// readAmount reads a decimal amount and strips its leading zeros, so "0010" and "10" commit the
// same value. Zero is "0". The bound is compared on the stripped digits, so no big-integer parse
// decides it.
func readAmount(text, name string) (string, string) {
	if !amountPattern.MatchString(text) {
		return "", name + " is not a decimal amount up to 2^256-1"
	}
	amount := strings.TrimLeft(text, "0")
	if amount == "" {
		amount = "0"
	}
	if len(amount) > len(maxAmount) || (len(amount) == len(maxAmount) && amount > maxAmount) {
		return "", name + " is not a decimal amount up to 2^256-1"
	}
	return amount, ""
}

// readOptionalString reads an optional string member: nil when it is absent or null.
func readOptionalString(doc map[string]any, name string) (*string, string) {
	v, present := doc[name]
	if !present || v == nil {
		return nil, ""
	}
	s, ok := v.(string)
	if !ok {
		return nil, name + " is not a string"
	}
	return &s, ""
}

// readExecutor expands the executor to its three legs: a role names every leg, and the object form
// must name each leg.
func readExecutor(doc map[string]any) (ExecutorLegs, string) {
	v, present := doc["executor"]
	if !present || v == nil {
		return ExecutorLegs{}, ""
	}
	if text, ok := v.(string); ok {
		role, problem := readExecutorRole(text, "executor")
		return ExecutorLegs{Deposit: role, Reserve: role, Fulfill: role}, problem
	}
	legs, ok := v.(map[string]any)
	if !ok {
		return ExecutorLegs{}, "executor is neither a string nor an object"
	}
	var e ExecutorLegs
	for _, leg := range []struct {
		name string
		role *ExecutorRole
	}{{"deposit", &e.Deposit}, {"reserve", &e.Reserve}, {"fulfill", &e.Fulfill}} {
		name := "executor." + leg.name
		text, ok := legs[leg.name].(string)
		if !ok {
			return ExecutorLegs{}, name + " is not a string"
		}
		var problem string
		if *leg.role, problem = readExecutorRole(text, name); problem != "" {
			return ExecutorLegs{}, problem
		}
	}
	return e, ""
}

func readExecutorRole(text, name string) (ExecutorRole, string) {
	role, ok := executorRoles[text]
	if !ok {
		return 0, name + " is neither settler nor originator"
	}
	return role, ""
}

var executorRoles = map[string]ExecutorRole{"settler": ExecutorSettler, "originator": ExecutorOriginator}

// deadlinePattern is the one RFC 3339 form v2 accepts: uppercase T and Z, at most nine fractional
// digits, and a numeric offset. It is checked, and the instant computed, by this code alone, never
// by a date parser, so Go and TypeScript cannot read one deadline as two instants.
var deadlinePattern = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$`)

// readDeadline reads an RFC 3339 instant as Unix seconds, floored. Fractional seconds are dropped:
// the offset is whole minutes, so the floor of the instant is its whole-second part.
func readDeadline(doc map[string]any, name string) (uint64, string) {
	text, ok := doc[name].(string)
	if !ok {
		return 0, name + " is not a string"
	}
	m := deadlinePattern.FindStringSubmatch(text)
	if m == nil || (m[7] == "-" && m[8] == "00" && m[9] == "00") {
		return 0, name + " is not an RFC 3339 date-time of the form YYYY-MM-DDTHH:MM:SS[.fraction](Z|+HH:MM|-HH:MM)"
	}
	var f [10]int64
	for i := 1; i < len(m); i++ {
		f[i], _ = strconv.ParseInt(m[i], 10, 64) // the pattern admits only digits, or "" for Z
	}
	year, month, day, hour, minute, second, offsetHour, offsetMinute := f[1], f[2], f[3], f[4], f[5], f[6], f[8], f[9]
	if month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
		hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59 {
		return 0, name + " is not a valid date and time"
	}
	seconds := daysFromCivil(year, month, day)*86400 + hour*3600 + minute*60 + second
	switch m[7] {
	case "+":
		seconds -= offsetHour*3600 + offsetMinute*60
	case "-":
		seconds += offsetHour*3600 + offsetMinute*60
	}
	if seconds < 0 {
		return 0, name + " is before 1970-01-01T00:00:00Z"
	}
	// The spec (thread 1) also refuses a deadline above 2^53-1 seconds. No check is needed: the
	// latest instant this grammar admits, 9999-12-31T23:59:59-23:59, is 253402387139 seconds.
	return uint64(seconds), ""
}

func daysInMonth(year, month int64) int64 {
	switch month {
	case 2:
		if year%4 == 0 && (year%100 != 0 || year%400 == 0) {
			return 29
		}
		return 28
	case 4, 6, 9, 11:
		return 30
	}
	return 31
}

// daysFromCivil returns the days from 1970-01-01 to a proleptic Gregorian date, for years 0 to 9999
// (Howard Hinnant's days_from_civil).
func daysFromCivil(year, month, day int64) int64 {
	if month <= 2 {
		year--
	}
	era := year / 400
	if year < 0 {
		era = (year - 399) / 400
	}
	yearOfEra := year - era*400
	shifted := month - 3
	if month <= 2 {
		shifted = month + 9
	}
	dayOfYear := (153*shifted+2)/5 + day - 1
	dayOfEra := yearOfEra*365 + yearOfEra/4 - yearOfEra/100 + dayOfYear
	return era*146097 + dayOfEra - 719468
}

// depositRequestPreimageV2 is the keccak256 input of v2: the domain byte, then every field in the
// specified order, each variable-length field prefixed with its byte length as a big-endian uint32.
// It reports false when a field is too long for its prefix to count.
func depositRequestPreimageV2(t DepositTerms) ([]byte, bool) {
	p := v2Preimage{b: []byte{depositRequestV2Domain}}
	p.field(depositRequestV2Tag)
	p.field(t.RequestID)
	p.field(t.SourceAssetIdentifier)
	p.field(t.SourceAccount)
	p.field(t.Destination)
	p.field(t.FulfillmentAmount)
	p.optional(t.MaxSourceAmount)
	p.b = binary.BigEndian.AppendUint64(p.b, t.QuoteDeadline)
	p.b = binary.BigEndian.AppendUint64(p.b, t.FulfillmentDeadline)
	p.b = append(p.b, byte(t.Executor.Deposit), byte(t.Executor.Reserve), byte(t.Executor.Fulfill))
	p.optional(t.FulfillmentProxy)
	p.field(t.EscrowContractAddress)
	p.optional(t.QuoteSelector)
	p.field(t.FulfillmentVerifierAccount)
	p.field(t.FulfillmentVerifierEndpoint)
	return p.b, !p.tooLong
}

// The presence byte of an optional member: v2Absent is followed by nothing, v2Present by the value
// as a length-prefixed field.
const (
	v2Absent  = 0x00
	v2Present = 0x01
)

// v2Preimage accumulates a preimage. tooLong records a field whose length a uint32 cannot count.
type v2Preimage struct {
	b       []byte
	tooLong bool
}

func (p *v2Preimage) optional(value *string) {
	if value == nil {
		p.b = append(p.b, v2Absent)
		return
	}
	p.b = append(p.b, v2Present)
	p.field(*value)
}

func (p *v2Preimage) field(value string) {
	n, ok := v2FieldLength(uint64(len(value)))
	if !ok {
		p.tooLong = true
		return
	}
	p.b = binary.BigEndian.AppendUint32(p.b, n)
	p.b = append(p.b, value...)
}

// v2FieldLength is a field's length prefix. A length a uint32 cannot count is refused rather than
// wrapped: a wrapped prefix would let a longer field encode like a shorter one.
func v2FieldLength(n uint64) (uint32, bool) {
	if n > math.MaxUint32 {
		return 0, false
	}
	return uint32(n), true
}
