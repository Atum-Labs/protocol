package senderauth

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
)

// VerifyRequestCommitment runs VerifyCommitment on a payment request exactly as received. It refuses
// a request whose member names are ambiguous in what it reads, then reads every field by exact name,
// so the values it checks are the values any exact-key reader of the same bytes acts on. Prefer it over
// VerifyCommitment whenever the raw request is available.
//
// WithDepositRequestHashV2 opts it into depositRequestHash v2: the request is also read with
// ReadDepositRequest, and a deposit may commit either v1 or that reading's v2. Without it, it is
// exactly as before v2. In retire mode it admits only v2.
func VerifyRequestCommitment(request []byte, solana *SolanaDomain, opts ...CommitmentOption) (CommitmentResult, error) {
	_, signed, expected, r, err := readRequest(request)
	if err != nil {
		return r, err
	}
	reading, err := readRequestDepositRequestHashV2(request, commitmentOptionsOf(opts).depositRequestHashV2, &expected)
	if err != nil {
		r, _ := CommitmentResultOf(err)
		return r, err
	}
	return reading.verdict(verifyCommitment(signed, expected, solana, opts...))
}

// requestReading is how VerifyRequestCommitment and RequiredCommitmentOf read depositRequestHash v2
// in a request: why the strict reader refused it in audit, and whether v1 is retired.
type requestReading struct {
	strictDetail string
	v1Retired    bool
}

// readRequestDepositRequestHashV2 is readDepositRequestHashV2 for the two entry points that read
// retire, which reads the request as enforce does with v1 retired. VerifyPaymentRequestJSON calls
// readDepositRequestHashV2 itself, which refuses retire.
func readRequestDepositRequestHashV2(request []byte, mode DepositRequestHashV2Mode, expected *CommitmentExpectation) (requestReading, error) {
	retired := mode == DepositRequestHashV2Retire
	if retired {
		mode = DepositRequestHashV2Enforce
	}
	strictDetail, err := readDepositRequestHashV2(request, mode, expected)
	return requestReading{strictDetail: strictDetail, v1Retired: retired}, err
}

// verdict is the check's result on the request as read: marked as audit's reading by auditFallback,
// and, once v1 is retired, refused as request_hash_mismatch unless the deposit matched v2.
func (rd requestReading) verdict(r CommitmentResult, err error) (CommitmentResult, error) {
	r, err = auditFallback(rd.strictDetail)(r, err)
	if !rd.v1Retired || err != nil || r.DepositRequestHashVersion == "v2" {
		return r, err
	}
	r.DepositRequestHashVersion = ""
	return refuse(r, OutcomeRequestHashMismatch, detailDepositRequestHashV1Retired)
}

// required is c once v1 is retired: the v2 is the only value it names, so a consumer that admits
// either of its hashes admits only v2.
func (rd requestReading) required(c RequiredCommitment) RequiredCommitment {
	if rd.v1Retired {
		c.DepositRequestHash = c.DepositRequestHashV2
	}
	return c
}

// readDepositRequestHashV2 applies the depositRequestHash v2 mode to a request already read by
// exact name. When ReadDepositRequest admits the request, its v2 goes into expected. When it
// refuses it, enforce returns the refusal, and audit returns its detail for auditFallback. Off
// reads nothing. Any other mode, retire included, is refused as verifier_misconfigured, so
// VerifyPaymentRequestJSON, which reads its mode here as given, fails closed on retire.
func readDepositRequestHashV2(request []byte, mode DepositRequestHashV2Mode, expected *CommitmentExpectation) (string, error) {
	switch mode {
	case DepositRequestHashV2Off:
		return "", nil
	case DepositRequestHashV2Audit, DepositRequestHashV2Enforce:
	default:
		_, err := refuse(CommitmentResult{}, OutcomeVerifierMisconfigured,
			fmt.Sprintf("the depositRequestHash v2 mode %s is not one of audit or enforce", quoteValue(string(mode))))
		return "", err
	}
	read, err := ReadDepositRequest(request)
	if err == nil {
		expected.DepositRequestHashV2 = "0x" + hex.EncodeToString(read.DepositRequestHashV2[:])
		return "", nil
	}
	if mode == DepositRequestHashV2Enforce {
		return "", err
	}
	strict, _ := CommitmentResultOf(err)
	return strict.Detail, nil
}

// auditFallback marks a check that read the request as before v2 because ReadDepositRequest refused
// it with detail: StrictDetail is set on the result and on the result its refusal carries, and an
// admission matched v1, the only version that reading accepts. An empty detail changes nothing.
func auditFallback(detail string) func(CommitmentResult, error) (CommitmentResult, error) {
	return func(r CommitmentResult, err error) (CommitmentResult, error) {
		if detail == "" {
			return r, err
		}
		r.StrictDetail = detail
		if r.Verified() {
			r.DepositRequestHashVersion = "v1"
		}
		var ce *CommitmentError
		if errors.As(err, &ce) {
			ce.Result.StrictDetail = detail
		}
		return r, err
	}
}

// RequiredCommitment is the commitment any deposit for a payment request must carry. The keys are
// the same in both languages.
type RequiredCommitment struct {
	// Namespace is the CAIP-2 namespace of the source chain: eip155, tron or solana.
	Namespace string `json:"namespace"`
	// Destination is the destination the deposit must commit, as BuildEscrowDestination composes it.
	Destination string `json:"destination"`
	// DepositRequestHash is the depositRequestHash v1 the deposit must commit unless it commits
	// DepositRequestHashV2: keccak256(request_id), 0x + 64 lowercase hex. In retire mode it is
	// DepositRequestHashV2 instead, so a consumer that admits either value admits only v2.
	DepositRequestHash string `json:"depositRequestHash"`
	// DepositRequestHashV2 is the request's depositRequestHash v2, which the deposit may commit
	// instead of DepositRequestHash, once opted in with WithDepositRequestHashV2. Empty otherwise.
	DepositRequestHashV2 string `json:"depositRequestHashV2,omitempty"`
	// StrictDetail is why ReadDepositRequest refused the request, in DepositRequestHashV2Audit mode.
	// The commitment is then the one before v2. Empty in every other mode.
	StrictDetail string `json:"strictDetail,omitempty"`
}

// RequiredCommitmentOf returns the commitment any deposit for this payment request must carry: its
// source namespace, the destination and the depositRequestHash. Use it where you quote or bid,
// before the deposit exists, whether or not the request is signed yet. It never judges a deposit:
// once the deposit is signed into the request, judge it with VerifyRequestCommitment on the request
// as received.
//
// WithDepositRequestHashV2 opts it into depositRequestHash v2 as it does VerifyRequestCommitment:
// the request is also read with ReadDepositRequest, and the commitment carries both candidates,
// DepositRequestHash (v1) and DepositRequestHashV2; the deposit may commit either. Enforce refuses
// a request ReadDepositRequest refuses; audit returns the v1 commitment with the refusal in
// StrictDetail. Without it, it is exactly as before v2. Retire refuses what enforce refuses and
// requires v2, as it does in VerifyRequestCommitment: DepositRequestHash is the v2 too.
//
// It reads the request exactly as VerifyRequestCommitment does, so the same bytes are refused with
// the same outcome and detail. If signed_messages[0] carries a message_prehash, even a blank one,
// it then runs the check VerifyRequestCommitment runs, with solana as the Solana escrow domain and
// opts as given, and refuses exactly as it does; on success it returns the commitment that check
// compared. On EVM and Tron that check binds the prehash to signed_messages[0].message but verifies
// no signature (Permit2 does, on chain); on Solana it verifies the ed25519 signature. Otherwise no
// signed commitment can be read (sender_auth or signed_messages is absent, or signed_messages[0] has
// no message_prehash, absent or null), and it applies only the payment's side of the rules: a
// supported source chain (reading WithTronChainIDs for a Tron source), exactly one destination that
// can be composed, and a well-formed, non-empty request_id.
// That path reads no Solana domain, does not require sender_auth, never compares message_scheme and
// verifies no signature, so its refusals never carry a scheme. It is not verification: it refuses
// only a request no deposit could satisfy, and a signed request whose message_prehash or
// sender_auth was removed takes it with whatever payee it names.
//
// A refusal returns the zero RequiredCommitment and a *CommitmentError; CommitmentResultOf reads
// the outcome, the detail and the values known before the refusal. Mirrors TS requiredCommitmentOf.
func RequiredCommitmentOf(request []byte, solana *SolanaDomain, opts ...CommitmentOption) (RequiredCommitment, error) {
	o := commitmentOptionsOf(opts)
	_, signed, expected, r, err := readRequest(request)
	if err != nil {
		return RequiredCommitment{}, err
	}
	reading, err := readRequestDepositRequestHashV2(request, o.depositRequestHashV2, &expected)
	if err != nil {
		return RequiredCommitment{}, err
	}
	r.StrictDetail = reading.strictDetail
	if len(signed.SignedMessages) > 0 && signed.SignedMessages[0].MessagePrehash != nil {
		v, err := reading.verdict(verifyCommitment(signed, expected, solana, opts...))
		if err != nil {
			return RequiredCommitment{}, err
		}
		return reading.required(RequiredCommitment{
			Namespace:            v.Namespace,
			Destination:          v.ExpectedDestination,
			DepositRequestHash:   v.ExpectedDepositRequestHash,
			DepositRequestHashV2: v.ExpectedDepositRequestHashV2,
			StrictDetail:         reading.strictDetail,
		}), nil
	}
	_, namespace, sourceOutcome, sourceDetail := sourceNetwork(signed.SourceAssetIdentifier, o.tronChainIDs)
	r.Namespace = echo(namespace)
	if sourceDetail != "" {
		return refuseRequiredCommitment(r, sourceOutcome, sourceDetail)
	}
	destination, outcome, detail := requestDestination(expected.Destinations)
	if outcome != "" {
		return refuseRequiredCommitment(r, outcome, detail)
	}
	r.ExpectedDestination = destination
	hash, outcome, detail := requestDepositRequestHash(expected.RequestID)
	if outcome != "" {
		return refuseRequiredCommitment(r, outcome, detail)
	}
	return reading.required(RequiredCommitment{Namespace: namespace, Destination: destination, DepositRequestHash: hash, DepositRequestHashV2: expected.DepositRequestHashV2, StrictDetail: reading.strictDetail}), nil
}

// refuseRequiredCommitment is RequiredCommitmentOf's refusal: no commitment, and an error with r.
func refuseRequiredCommitment(r CommitmentResult, outcome CommitmentOutcome, detail string) (RequiredCommitment, error) {
	_, err := refuse(r, outcome, detail)
	return RequiredCommitment{}, err
}

// readRequest refuses an ambiguous or unreadable request and returns its decoded document with the
// commitment inputs read by exact name. Every root member name is checked, but only the values of
// the root members it reads are scanned, so a twin inside a member carried for others, such as a
// credential, does not refuse the request.
func readRequest(request []byte) (map[string]any, SignedDeposit, CommitmentExpectation, CommitmentResult, error) {
	var r CommitmentResult
	fail := func(detail string) (map[string]any, SignedDeposit, CommitmentExpectation, CommitmentResult, error) {
		r, err := refuse(r, OutcomeRequestMalformed, detail)
		return nil, SignedDeposit{}, CommitmentExpectation{}, r, err
	}
	path, err := FirstAmbiguousMemberIn(request, requestReadMembers)
	if err != nil {
		return fail("the payment request is not a single valid JSON document")
	}
	if path != "" {
		return fail("the payment request carries two members that differ only in letter case, at " + echo(path))
	}
	root, err := decodeScanned(request)
	if err != nil {
		return fail("the payment request is not a single valid JSON document")
	}
	doc, ok := root.(map[string]any)
	if !ok {
		return fail("the payment request is not readable: the document is not an object")
	}
	signed, expected, problem := readPaymentRequest(doc)
	if problem != "" {
		return fail("the payment request is not readable: " + problem)
	}
	return doc, signed, expected, r, nil
}

// requestReadMembers are the root members readPaymentRequest reads.
var requestReadMembers = []string{"source", "destination", "request_id", "sender_auth"}

// readPaymentRequest extracts the commitment inputs by exact member name. problem names the first
// member that is present with the wrong type. A root member read here must be in
// requestReadMembers.
func readPaymentRequest(doc map[string]any) (SignedDeposit, CommitmentExpectation, string) {
	var signed SignedDeposit
	var expected CommitmentExpectation

	source, ok := doc["source"].(map[string]any)
	if !ok {
		return signed, expected, "source is not an object"
	}
	if signed.SourceAssetIdentifier, ok = source["asset_identifier"].(string); !ok {
		return signed, expected, "source.asset_identifier is not a string"
	}
	if signed.SourceAccount, ok = source["account"].(string); !ok {
		return signed, expected, "source.account is not a string"
	}

	legs, ok := doc["destination"].([]any)
	if !ok {
		return signed, expected, "destination is not an array"
	}
	for i, raw := range legs {
		leg, ok := raw.(map[string]any)
		name := "destination[" + strconv.Itoa(i) + "]"
		if !ok {
			return signed, expected, name + " is not an object"
		}
		asset, aok := leg["asset_identifier"].(string)
		account, cok := leg["account"].(string)
		if !aok || !cok {
			return signed, expected, name + " asset_identifier and account must be strings"
		}
		expected.Destinations = append(expected.Destinations, DestinationLeg{AssetIdentifier: asset, Account: account})
	}
	if expected.RequestID, ok = doc["request_id"].(string); !ok {
		return signed, expected, "request_id is not a string"
	}

	auth, present := doc["sender_auth"]
	if !present || auth == nil {
		return signed, expected, ""
	}
	senderAuth, ok := auth.(map[string]any)
	if !ok {
		return signed, expected, "sender_auth is not an object"
	}
	if scheme, present := senderAuth["message_scheme"]; present && scheme != nil {
		if signed.MessageScheme, ok = scheme.(string); !ok {
			return signed, expected, "sender_auth.message_scheme is not a string"
		}
	}
	messages, present := senderAuth["signed_messages"]
	if !present || messages == nil {
		return signed, expected, ""
	}
	list, ok := messages.([]any)
	if !ok {
		return signed, expected, "sender_auth.signed_messages is not an array"
	}
	for i, raw := range list {
		name := "sender_auth.signed_messages[" + strconv.Itoa(i) + "]"
		m, ok := raw.(map[string]any)
		if !ok {
			return signed, expected, name + " is not an object"
		}
		var input SignedMessageInput
		if input.Message, ok = optionalString(m, "message"); !ok {
			return signed, expected, name + ".message is not a string"
		}
		if input.Signature, ok = optionalString(m, "signature"); !ok {
			return signed, expected, name + ".signature is not a string"
		}
		if v, present := m["message_prehash"]; present && v != nil {
			prehash, ok := v.(string)
			if !ok {
				return signed, expected, name + ".message_prehash is not a string"
			}
			input.MessagePrehash = &prehash
		}
		if v, present := m["payload"]; present && v != nil {
			payload, ok := v.(map[string]any)
			if !ok {
				return signed, expected, name + ".payload is not an object"
			}
			input.Payload = payload
		}
		signed.SignedMessages = append(signed.SignedMessages, input)
	}
	return signed, expected, ""
}

// optionalString reads an optional string member: absent or null reads as "".
func optionalString(m map[string]any, name string) (string, bool) {
	v, present := m[name]
	if !present || v == nil {
		return "", true
	}
	s, ok := v.(string)
	return s, ok
}
