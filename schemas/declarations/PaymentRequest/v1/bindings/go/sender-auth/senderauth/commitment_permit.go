package senderauth

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"

	evmencoding "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/encoding"
	evmcontracts "github.com/atum-labs/protocol/contracts/evm/bindings/go/escrow-encoding/generated"
	tvmencoding "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/encoding"
	tvmcontracts "github.com/atum-labs/protocol/contracts/tvm/bindings/go/escrow-encoding/generated"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// verifyPermitCommitment is the EVM and Tron arm: the prehash is the Permit2 typed data the
// depositor signed, with the commitment in message.witness. Who signed is left to Permit2, which
// checks the signature on chain for key and contract (ERC-1271) accounts alike. tronChainIDs is the
// verifier's, as tronNumericChainID reads it.
func verifyPermitCommitment(r CommitmentResult, namespace, network string, deposit SignedMessageInput, expected CommitmentExpectation, tronChainIDs map[string]int64) (CommitmentResult, error) {
	root, outcome, detail := readPrehash(deposit.MessagePrehash)
	if outcome != "" {
		return refuse(r, outcome, detail)
	}
	destination, outcome, detail := readCommitmentMember(root, detailNoDestination, "message", "witness", "destination")
	if outcome != "" {
		return refuse(r, outcome, detail)
	}
	r.SignedDestination = echo(destination)
	hashText, outcome, detail := readCommitmentMember(root, detailNoRequestHash, "message", "witness", "depositRequestHash")
	if outcome != "" {
		return refuse(r, outcome, detail)
	}
	r.SignedDepositRequestHash = echo(hashText)
	hash, ok := parseHash32(hashText)
	if !ok {
		return refuse(r, OutcomePrehashMismatch, detailBadRequestHash)
	}
	r = compareExpected(r, destination, hash, expected)
	if !r.Verified() {
		return finish(r)
	}
	if detail := bindPermitDigest(namespace, network, root, deposit.Message, destination, hash, tronChainIDs); detail != "" {
		return refuse(r, OutcomePrehashMismatch, detail)
	}
	return finish(r)
}

// readPrehash scans message_prehash for ambiguous member names (with no exemption) and decodes it.
// Member names are unique afterwards, so the exact-key decode reads what every exact-key reader reads.
func readPrehash(prehash *string) (map[string]any, CommitmentOutcome, string) {
	if prehash == nil || isJSONBlank(*prehash) {
		return nil, OutcomeCommitmentAbsent, detailNoPrehash
	}
	path, err := firstAmbiguousMember([]byte(*prehash), false, nil)
	if err != nil {
		return nil, OutcomePrehashMismatch, "message_prehash is not a single valid JSON document"
	}
	if path != "" {
		return nil, OutcomePrehashMismatch, "message_prehash carries two members that differ only in letter case, at " + echo(path)
	}
	root, err := decodeScanned([]byte(*prehash))
	if err != nil {
		return nil, OutcomePrehashMismatch, "message_prehash is not a single valid JSON document"
	}
	obj, ok := root.(map[string]any)
	if !ok {
		return nil, OutcomePrehashMismatch, "message_prehash is not readable: the document is not an object"
	}
	return obj, "", ""
}

// decodeScanned decodes a document that FirstAmbiguousMember has already accepted.
func decodeScanned(document []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(document))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// memberAt follows an exact-name path. found is false when a member on the path is absent or null;
// notObject names the first value on the path that is present but not an object.
func memberAt(root map[string]any, path ...string) (value any, found bool, notObject string) {
	current := root
	for i, name := range path {
		v, ok := current[name]
		if !ok || v == nil {
			return nil, false, ""
		}
		if i == len(path)-1 {
			return v, true, ""
		}
		next, ok := v.(map[string]any)
		if !ok {
			return nil, false, strings.Join(path[:i+1], ".")
		}
		current = next
	}
	return nil, false, ""
}

// readCommitmentMember reads a committed string member. Absent, null or blank is commitment_absent
// (with absentDetail); any other non-string is prehash_mismatch.
func readCommitmentMember(root map[string]any, absentDetail string, path ...string) (string, CommitmentOutcome, string) {
	v, found, notObject := memberAt(root, path...)
	if notObject != "" {
		return "", OutcomePrehashMismatch, "message_prehash is not readable: " + notObject + " is not an object"
	}
	if !found {
		return "", OutcomeCommitmentAbsent, absentDetail
	}
	s, ok := v.(string)
	if !ok {
		return "", OutcomePrehashMismatch, "message_prehash is not readable: " + strings.Join(path, ".") + " is not a string"
	}
	if isJSONBlank(s) {
		return "", OutcomeCommitmentAbsent, absentDetail
	}
	return s, "", ""
}

const permitWitnessPrimaryType = "PermitWitnessTransferFrom"

var (
	chainIDPattern    = regexp.MustCompile(`^0x[1-9a-fA-F][0-9a-fA-F]*$`)
	hexAddressPattern = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)
	uintPattern       = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)
	digestPattern     = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)
	maxUint256        = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 256), big.NewInt(1))
)

// bindPermitDigest rebuilds the Permit2 digest from the prehash and requires it to equal the signed
// message, so the commitment read above is the one inside the signature. The verifying contract comes
// from the prehash: an attacker who changes it changes the digest. It returns "" when bound, else the
// refusal detail.
func bindPermitDigest(namespace, network string, root map[string]any, message, destination string, hash [32]byte, tronChainIDs map[string]int64) string {
	digest, _, detail := permitDigest(namespace, network, root, destination, hash, "", tronChainIDs)
	if detail != "" {
		return detail
	}
	return signedDigestProblem(message, digest, detailPermitDigestMismatch)
}

// signedDigestProblem reports why message is not the signed digest, or "" when it is. Mirrors the
// TS `signedDigestProblem`.
func signedDigestProblem(message string, digest []byte, mismatch string) string {
	if !digestPattern.MatchString(message) {
		return detailBadDigest
	}
	if !strings.EqualFold(message[2:], hex.EncodeToString(digest)) {
		return mismatch
	}
	return ""
}

// permitDigest reads the prehash strictly and rebuilds its Permit2 digest over the canonical types,
// with the chain id of the payment's source network, read with tronChainIDs on Tron.
// verifyingContract, when non-empty, replaces the prehash's own (RecoverAndVerify pins the Permit2
// the escrow actually uses). detail is "" on success.
func permitDigest(namespace, network string, root map[string]any, destination string, hash [32]byte, verifyingContract string, tronChainIDs map[string]int64) ([]byte, permitFields, string) {
	const undecodable = "message_prehash commits a destination but is not decodable typed data: "
	var fields permitFields
	var (
		chainID int64
		err     error
	)
	switch namespace {
	case "eip155":
		chainID, err = evmChainID(network)
	case "tron":
		chainID, err = tronNumericChainID(network, tronChainIDs)
	default:
		err = fmt.Errorf("unsupported namespace %s", namespace)
	}
	if err != nil {
		return nil, fields, undecodable + err.Error()
	}
	if reason := fields.read(root, chainID); reason != "" {
		return nil, fields, undecodable + reason
	}
	permit2 := fields.verifyingContract
	if verifyingContract != "" {
		permit2 = verifyingContract
	}
	reserver, releaser := common.HexToAddress(fields.reserver), common.HexToAddress(fields.releaser)

	var (
		digest    []byte
		typedData apitypes.TypedData
	)
	if namespace == "eip155" {
		digest, typedData, err = evmencoding.NewEscrowDepositEncoder().DigestWithDestination(
			common.HexToAddress(permit2), common.HexToAddress(fields.token), common.HexToAddress(fields.spender),
			evmcontracts.IEscrowDepositWitness{DepositRequestHash: hash, Destination: destination, Reserver: reserver, Releaser: releaser},
			fields.amount, fields.nonce, fields.deadline, big.NewInt(chainID))
	} else {
		digest, typedData, err = tvmencoding.NewEscrowDepositEncoder().DigestWithDestination(
			common.HexToAddress(permit2), common.HexToAddress(fields.token), common.HexToAddress(fields.spender),
			tvmcontracts.IEscrowDepositWitness{DepositRequestHash: hash, Destination: destination, Reserver: reserver, Releaser: releaser},
			fields.amount, fields.nonce, fields.deadline, big.NewInt(chainID))
	}
	if err != nil {
		return nil, fields, undecodable + err.Error()
	}
	if !sameMessageTypes(root["types"], typedData.Types) {
		return nil, fields, undecodable + "types are not the Permit2 deposit witness types"
	}
	return digest, fields, ""
}

// maxDeadlineSec is the largest deadline, in Unix seconds, a verifier accepts: the largest integer
// both languages represent exactly.
const maxDeadlineSec int64 = 1<<53 - 1

// deadlineSeconds returns a deadline as an int, or false when it is outside 0..maxDeadlineSec or does
// not fit the platform's int.
func deadlineSeconds(v int64) (int, bool) {
	if v < 0 || v > maxDeadlineSec || v > math.MaxInt {
		return 0, false
	}
	return int(v), true
}

// verifiedPermit is a Permit2 deposit read strictly for RecoverAndVerify.
type verifiedPermit struct {
	fields      permitFields
	destination string
	hashText    string
	hash        [32]byte
	digest      []byte
	deadlineSec int
}

// readPermitForVerify reads a Permit2 deposit for RecoverAndVerify: the same strict reading the
// commitment check uses, with the digest rebuilt over permit2 (hex), which the signed message must
// equal. Every refusal carries its commitment outcome. A prehash that commits no destination or request
// hash is a *CommitmentError; any other unusable prehash is also ErrMalformedPrehash.
func readPermitForVerify(namespace string, signed SignedMessageInput, source SourceRef, permit2 string, commitment CommitmentExpectation) (verifiedPermit, error) {
	var p verifiedPermit
	root, outcome, detail := readPrehash(signed.MessagePrehash)
	if outcome != "" {
		return p, malformedPrehash(namespace, outcome, detail)
	}
	p.destination, outcome, detail = readCommitmentMember(root, detailNoDestination, "message", "witness", "destination")
	if outcome == OutcomeCommitmentAbsent {
		return p, commitmentRefusal(namespace, outcome, detail)
	}
	if outcome != "" {
		return p, malformedPrehash(namespace, outcome, detail)
	}
	p.hashText, outcome, detail = readCommitmentMember(root, detailNoRequestHash, "message", "witness", "depositRequestHash")
	if outcome == OutcomeCommitmentAbsent {
		return p, &CommitmentError{Result: CommitmentResult{Outcome: outcome, Detail: detail, Namespace: namespace, SignedDestination: echo(p.destination)}}
	}
	if outcome != "" {
		return p, malformedPrehash(namespace, outcome, detail)
	}
	var ok bool
	if p.hash, ok = parseHash32(p.hashText); !ok {
		return p, malformedPrehash(namespace, OutcomePrehashMismatch, detailBadRequestHash)
	}
	// The encoders take the signed destination as it is, so one that can never match is refused
	// first, with the outcome the commitment check gives it.
	if !isWellFormedText(p.destination) || len(p.destination) > MaxDestinationBytes {
		if _, err := requireCommitment(namespace, p.destination, p.hashText, p.hash, commitment); err != nil {
			return p, err
		}
		return p, malformedPrehash(namespace, OutcomeDestinationMismatch, "the signed destination cannot be committed to")
	}
	var reason string
	if p.digest, p.fields, reason = permitDigest(namespace, source.Network, root, p.destination, p.hash, permit2, nil); reason != "" {
		return p, malformedPrehash(namespace, OutcomePrehashMismatch, reason)
	}
	if problem := signedDigestProblem(signed.Message, p.digest, detailPermitDigestMismatch); problem != "" {
		return p, commitmentRefusal(namespace, OutcomePrehashMismatch, problem)
	}
	if !p.fields.deadline.IsInt64() {
		return p, malformedPrehash(namespace, OutcomePrehashMismatch, detailDeadlineRange)
	}
	if p.deadlineSec, ok = deadlineSeconds(p.fields.deadline.Int64()); !ok {
		return p, malformedPrehash(namespace, OutcomePrehashMismatch, detailDeadlineRange)
	}
	return p, nil
}

// permitSignerIs reports whether the secp256k1 signature over the signed digest recovers to
// account (EVM hex, or a Tron address in base58 or hex).
func permitSignerIs(namespace string, deposit SignedMessageInput, account string) bool {
	recovered, err := recoverEVMAddress(deposit.Message, deposit.Signature)
	if err != nil {
		return false
	}
	if namespace == "tron" {
		account = tronNormalize(account)
	}
	return sameAddress(recovered.Hex(), account)
}

// requireCommitment compares a signed commitment with the payment's own and returns the result; a
// mismatch is a *CommitmentError.
func requireCommitment(namespace, signedDestination, signedHashText string, signedHash [32]byte, commitment CommitmentExpectation) (CommitmentResult, error) {
	r := compareExpected(CommitmentResult{Namespace: namespace, SignedDepositRequestHash: echo(signedHashText)}, signedDestination, signedHash, commitment)
	if r.Verified() {
		return r, nil
	}
	return r, &CommitmentError{Result: r}
}

// commitmentRefusal is a *CommitmentError with the given outcome.
func commitmentRefusal(namespace string, outcome CommitmentOutcome, detail string) error {
	return &CommitmentError{Result: CommitmentResult{Outcome: outcome, Detail: detail, Namespace: namespace}}
}

// malformedPrehash reports an unusable prehash both as ErrMalformedPrehash and as the commitment
// outcome it maps to.
func malformedPrehash(namespace string, outcome CommitmentOutcome, detail string) error {
	return fmt.Errorf("%w: %w", ErrMalformedPrehash, commitmentRefusal(namespace, outcome, detail))
}

// permitFields are the typed-data members the digest is rebuilt from, validated strictly.
type permitFields struct {
	verifyingContract, token, spender, reserver, releaser string
	amount, nonce, deadline                               *big.Int
}

// permitMembers is every member the Permit2 deposit typed data may carry, per object. Anything else
// is refused: no reader needs it, and an unread member is room for a second meaning.
var permitMembers = []struct {
	path    []string
	allowed []string
}{
	{nil, []string{"types", "primaryType", "domain", "message"}},
	{[]string{"domain"}, []string{"name", "version", "chainId", "verifyingContract", "salt"}},
	{[]string{"message"}, []string{"permitted", "spender", "nonce", "deadline", "witness"}},
	{[]string{"message", "permitted"}, []string{"token", "amount"}},
	{[]string{"message", "witness"}, []string{"depositRequestHash", "destination", "reserver", "releaser"}},
}

func (f *permitFields) read(root map[string]any, chainID int64) string {
	for _, m := range permitMembers {
		obj := root
		if m.path != nil {
			v, _, _ := memberAt(root, m.path...)
			var ok bool
			if obj, ok = v.(map[string]any); !ok {
				return strings.Join(m.path, ".") + " is not an object"
			}
		}
		for name := range obj {
			if !slices.Contains(m.allowed, name) {
				return pathName(m.path) + " carries a member the Permit2 deposit typed data does not define"
			}
		}
	}
	if pt, _ := root["primaryType"].(string); pt != permitWitnessPrimaryType {
		return "primaryType is not " + permitWitnessPrimaryType
	}
	if name, _ := stringMember(root, "domain", "name"); name != "Permit2" {
		return "domain.name is not Permit2"
	}
	for _, optional := range []string{"version", "salt"} {
		if v, present := root["domain"].(map[string]any)[optional]; present && v != "" {
			return "domain." + optional + " must be empty"
		}
	}
	if id, ok := stringMember(root, "domain", "chainId"); !ok || !chainIDPattern.MatchString(id) ||
		!strings.EqualFold(strings.TrimPrefix(id, "0x"), strconv.FormatInt(chainID, 16)) {
		return "domain.chainId is not the source chain"
	}
	addresses := []struct {
		dst  *string
		path []string
	}{
		{&f.verifyingContract, []string{"domain", "verifyingContract"}},
		{&f.token, []string{"message", "permitted", "token"}},
		{&f.spender, []string{"message", "spender"}},
		{&f.reserver, []string{"message", "witness", "reserver"}},
		{&f.releaser, []string{"message", "witness", "releaser"}},
	}
	for _, a := range addresses {
		s, ok := stringMember(root, a.path...)
		if !ok || !hexAddressPattern.MatchString(s) {
			return strings.Join(a.path, ".") + " is not a 0x-prefixed 20-byte hex address"
		}
		*a.dst = s
	}
	numbers := []struct {
		dst  **big.Int
		path []string
	}{
		{&f.amount, []string{"message", "permitted", "amount"}},
		{&f.nonce, []string{"message", "nonce"}},
		{&f.deadline, []string{"message", "deadline"}},
	}
	for _, n := range numbers {
		s, ok := stringMember(root, n.path...)
		if !ok || !uintPattern.MatchString(s) {
			return strings.Join(n.path, ".") + " is not a decimal integer string"
		}
		v, _ := new(big.Int).SetString(s, 10)
		if v.Cmp(maxUint256) > 0 {
			return strings.Join(n.path, ".") + " exceeds uint256"
		}
		*n.dst = v
	}
	return ""
}

func pathName(path []string) string {
	if path == nil {
		return "the typed data"
	}
	return strings.Join(path, ".")
}

func stringMember(root map[string]any, path ...string) (string, bool) {
	v, found, _ := memberAt(root, path...)
	if !found {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

// sameMessageTypes reports whether the prehash declares exactly the canonical message types. An
// EIP712Domain entry is ignored on both sides: the digest is rebuilt over the canonical domain.
func sameMessageTypes(declared any, canonical apitypes.Types) bool {
	declaredTypes, ok := declared.(map[string]any)
	if !ok {
		return false
	}
	want := map[string]any{}
	for name, fields := range canonical {
		if name == "EIP712Domain" {
			continue
		}
		list := make([]any, 0, len(fields))
		for _, f := range fields {
			list = append(list, map[string]any{"name": f.Name, "type": f.Type})
		}
		want[name] = list
	}
	got := map[string]any{}
	for name, v := range declaredTypes {
		if name != "EIP712Domain" {
			got[name] = v
		}
	}
	return reflect.DeepEqual(got, want)
}
