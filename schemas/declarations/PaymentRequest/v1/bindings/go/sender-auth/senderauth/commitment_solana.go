package senderauth

import (
	"crypto/ed25519"
	"encoding/hex"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"

	svm "github.com/atum-labs/protocol/contracts/svm/bindings/go/escrow-encoding/encoding"
	"github.com/mr-tron/base58"
)

// verifySolanaCommitment is the Solana arm. The payer signs, with ed25519, the escrow program's
// deposit hash; the prehash is the flat record that hash is computed from. The hash is recomputed
// with the verifier's escrow domain, and the signature is checked against it, so the commitment read
// from the record is the one the payer signed.
func verifySolanaCommitment(r CommitmentResult, sourceAccount string, deposit SignedMessageInput, expected CommitmentExpectation, solana *SolanaDomain) (CommitmentResult, error) {
	if solana == nil {
		return refuse(r, OutcomeVerifierMisconfigured, "the Solana escrow domain (program id, cluster, domain version) was not supplied")
	}
	domain, detail := solanaEscrowDomain(*solana)
	if detail != "" {
		return refuse(r, OutcomeVerifierMisconfigured, detail)
	}
	if domain.SignatureDomainVersion < svmDestinationCommitmentVersion {
		return refuse(r, OutcomeCommitmentAbsent, fmt.Sprintf(
			"the escrow's signature domain version %d commits no destination; every deployed escrow requires version %d or later",
			domain.SignatureDomainVersion, svmDestinationCommitmentVersion))
	}
	root, outcome, detail := readPrehash(deposit.MessagePrehash)
	if outcome != "" {
		return refuse(r, outcome, detail)
	}
	if memberSpelledTwice(root) {
		return refuse(r, OutcomePrehashMismatch, "message_prehash spells one member two ways")
	}
	destination, outcome, detail := readCommitmentMember(root, detailNoDestination, "destination")
	if outcome != "" {
		return refuse(r, outcome, detail)
	}
	r.SignedDestination = echo(destination)
	hashText, outcome, detail := readCommitmentMember(root, detailNoRequestHash, "deposit_request_hash")
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
	if outcome, detail := bindSolanaDeposit(domain, root, deposit, sourceAccount); outcome != "" {
		return refuse(r, outcome, detail)
	}
	return finish(r)
}

// solanaEscrowDomain validates the verifier-supplied domain.
func solanaEscrowDomain(d SolanaDomain) (svm.EscrowDomain, string) {
	programID, err := svm.PubkeyFromBase58(d.EscrowProgramID)
	if err != nil {
		return svm.EscrowDomain{}, "the Solana escrow program id is not a base58 32-byte public key"
	}
	if programID.IsZero() {
		return svm.EscrowDomain{}, "the Solana escrow program id is the zero key"
	}
	if d.ClusterID == "" {
		return svm.EscrowDomain{}, "the Solana escrow cluster id is empty"
	}
	clusterID, err := clusterIDFromName(d.ClusterID)
	if err != nil {
		return svm.EscrowDomain{}, "the Solana escrow cluster id is longer than 32 bytes"
	}
	if d.DomainVersion < 1 || d.DomainVersion > math.MaxUint8 {
		return svm.EscrowDomain{}, "the Solana escrow signature domain version must be between 1 and 255"
	}
	return svm.EscrowDomain{ClusterID: clusterID, SignatureDomainVersion: uint8(d.DomainVersion), ProgramID: programID}, ""
}

// memberKey is the member a name denotes once case, underscores and the payment_id alias are
// set aside (Solana and Stellar deposit records). A deposit record naming one member twice this way is ambiguous to a reader that
// rewrites snake_case to camelCase or accepts that alias.
func memberKey(name string) string {
	key := foldMemberName(strings.ReplaceAll(name, "_", ""))
	if key == paymentIDKey {
		return requestHashKey
	}
	return key
}

var (
	paymentIDKey   = foldMemberName("paymentid")
	requestHashKey = foldMemberName("depositrequesthash")
)

func memberSpelledTwice(root map[string]any) bool {
	seen := map[string]bool{}
	for name := range root {
		key := memberKey(name)
		if seen[key] {
			return true
		}
		seen[key] = true
	}
	return false
}

// solanaRecordMembers is every member a Solana deposit record carries.
var solanaRecordMembers = []string{
	"deposit_request_hash", "destination", "depositor", "mint", "amount", "reserver", "releaser", "nonce", "issued_at", "deadline",
}

var (
	base58Pattern       = regexp.MustCompile(`^[1-9A-HJ-NP-Za-km-z]+$`)
	ed25519SigPattern   = regexp.MustCompile(`^0x[0-9a-fA-F]{128}$`)
	solanaZeroPublicKey = svm.Pubkey{}
)

// solanaRecord is a Solana deposit record read strictly: every member it defines, and nothing else.
type solanaRecord struct {
	params      svm.EscrowDepositParams
	destination string
	fields      map[string]string // each member as signed
}

// readSolanaRecord reads the deposit record the escrow program hashes; reason is "" when readable.
func readSolanaRecord(root map[string]any) (solanaRecord, string) {
	rec := solanaRecord{fields: map[string]string{}}
	for name := range root {
		if !slices.Contains(solanaRecordMembers, name) {
			return rec, "it carries a member the Solana deposit record does not define"
		}
	}
	for _, name := range solanaRecordMembers {
		s, ok := stringMember(root, name)
		if !ok {
			return rec, name + " is not a string"
		}
		rec.fields[name] = s
	}
	rec.destination = rec.fields["destination"]
	if isJSONBlank(rec.destination) {
		return rec, "destination is blank"
	}
	hash, ok := parseHash32(rec.fields["deposit_request_hash"])
	if !ok {
		return rec, "deposit_request_hash is not a 32-byte hex value"
	}
	rec.params.DepositRequestHash = hash
	keys := []struct {
		name string
		dst  *svm.Pubkey
	}{
		{"depositor", &rec.params.Depositor}, {"mint", &rec.params.Mint}, {"reserver", &rec.params.Reserver}, {"releaser", &rec.params.Releaser},
	}
	for _, k := range keys {
		pk, err := svm.PubkeyFromBase58(rec.fields[k.name])
		if !base58Pattern.MatchString(rec.fields[k.name]) || err != nil || pk == solanaZeroPublicKey {
			return rec, k.name + " is not a non-zero base58 32-byte public key"
		}
		*k.dst = pk
	}
	numbers := []struct {
		name string
		dst  *uint64
	}{
		{"amount", &rec.params.Amount}, {"nonce", &rec.params.Nonce}, {"issued_at", &rec.params.IssuedAt}, {"deadline", &rec.params.Deadline},
	}
	for _, n := range numbers {
		if !uintPattern.MatchString(rec.fields[n.name]) {
			return rec, n.name + " is not a decimal integer string"
		}
		v, err := strconv.ParseUint(rec.fields[n.name], 10, 64)
		if err != nil {
			return rec, n.name + " exceeds u64"
		}
		*n.dst = v
	}
	if rec.params.Amount == 0 {
		return rec, "amount is zero"
	}
	return rec, ""
}

// bindSolanaDeposit recomputes the deposit hash from the record, requires it to be the signed message,
// and verifies the ed25519 signature over it with the payer's key. It returns an empty outcome when
// bound.
func bindSolanaDeposit(domain svm.EscrowDomain, root map[string]any, deposit SignedMessageInput, sourceAccount string) (CommitmentOutcome, string) {
	rec, reason := readSolanaRecord(root)
	if reason != "" {
		return OutcomePrehashMismatch, "message_prehash commits a destination but is not a readable Solana deposit record: " + reason
	}
	digest, err := svm.ComputeDepositHashV2(rec.params, rec.destination, domain)
	if err != nil {
		return OutcomePrehashMismatch, "message_prehash commits a destination but is not a readable Solana deposit record: " + err.Error()
	}
	if problem := signedDigestProblem(deposit.Message, digest[:], "the signed digest is not the Solana deposit hash of message_prehash"); problem != "" {
		return OutcomePrehashMismatch, problem
	}
	if rec.fields["depositor"] != sourceAccount {
		return OutcomeSignerMismatch, "the signed deposit's depositor is not the payment's source account"
	}
	if !solanaDelegateIs(deposit.Payload, sourceAccount) {
		return OutcomeSignerMismatch, "the delegate signer is not the payment's source account"
	}
	key, err := base58.Decode(sourceAccount)
	if err != nil || len(key) != ed25519.PublicKeySize || !base58Pattern.MatchString(sourceAccount) {
		return OutcomeSignerMismatch, "the payment's source account is not a base58 ed25519 public key"
	}
	if !ed25519SigPattern.MatchString(deposit.Signature) {
		return OutcomeSignerMismatch, "the signature is not a 64-byte hex ed25519 signature"
	}
	sig, _ := hex.DecodeString(deposit.Signature[2:])
	if !verifyEd25519Strict(key, digest[:], sig) {
		return OutcomeSignerMismatch, "the ed25519 signature does not verify against the payment's source account"
	}
	return "", ""
}

// solanaDelegateIs reports whether payload.delegate_signer is absent, null, or exactly account.
func solanaDelegateIs(payload map[string]any, account string) bool {
	v, present := payload["delegate_signer"]
	if !present || v == nil {
		return true
	}
	s, ok := v.(string)
	return ok && s == account
}
