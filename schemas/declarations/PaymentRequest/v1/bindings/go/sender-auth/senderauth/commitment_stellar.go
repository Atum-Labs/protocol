package senderauth

import (
	"crypto/ed25519"
	"encoding/hex"
	"math/big"
	"slices"
	"strconv"

	stellar "github.com/atum-labs/protocol/contracts/stellar/bindings/go/escrow-encoding/encoding"
)

// verifyStellarCommitment is the Stellar arm. The payer's delegate signer signs, with ed25519, the
// escrow's deposit digest; the prehash is the flat record that digest is computed from. The digest is
// recomputed with the network the payment names and the escrow the verifier is configured with, and
// the signature is checked against it, so the commitment read from the record is the one the delegate
// signed. Whether that delegate is registered for the depositor is on chain state (create_delegate),
// which no offline check can read. Mirrors the TS verifyStellarCommitment.
func verifyStellarCommitment(r CommitmentResult, network, sourceAccount string, deposit SignedMessageInput, expected CommitmentExpectation, escrow string) (CommitmentResult, error) {
	domain, detail := stellarEscrowDomain(network, escrow)
	if detail != "" {
		return refuse(r, OutcomeVerifierMisconfigured, detail)
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
	rec, reason := readStellarRecord(root)
	if reason != "" {
		return refuse(r, OutcomePrehashMismatch, stellarUnreadable+reason)
	}
	if outcome, detail := bindStellarDeposit(domain, rec, deposit, sourceAccount); outcome != "" {
		return refuse(r, outcome, detail)
	}
	return finish(r)
}

// stellarEscrowDomain is the escrow domain for a `stellar:<reference>` network and the verifier's
// own escrow contract; detail is the reason it is unusable. The escrow comes from verifier
// configuration, never from the payment.
func stellarEscrowDomain(network, escrow string) (stellar.EscrowDomain, string) {
	networkString, err := stellarNetworkString(network)
	if err != nil {
		return stellar.EscrowDomain{}, "the Stellar network is not one the verifier knows"
	}
	if escrow == "" {
		return stellar.EscrowDomain{}, "the Stellar escrow contract was not supplied"
	}
	address, err := stellar.ParseAddress(escrow)
	if err != nil || address.Type != stellar.ContractAddress {
		return stellar.EscrowDomain{}, "the Stellar escrow is not a contract (C...) address"
	}
	domain, err := stellar.NewEscrowDomain(networkString, address)
	if err != nil {
		return stellar.EscrowDomain{}, "the Stellar escrow is not a usable contract (C...) address"
	}
	return domain, ""
}

// stellarRecordMembers is every member a Stellar deposit record carries.
var stellarRecordMembers = []string{
	"deposit_request_hash", "destination", "depositor", "token", "epoch", "amount", "reserver", "releaser", "nonce", "issued_at", "deadline",
}

// stellarRolesUnset is why a Stellar verification is refused when the expected reserver or releaser is
// absent. Fail closed, deliberately stricter than EVM and Solana (where omitted roles skip the check):
// the reserver and releaser are free members of the signed record, so a verifier that does not pin
// them would admit a deposit whose releaser the requester controls.
const stellarRolesUnset = "the Stellar verifier must be given the expected reserver and releaser, and none was"

// stellarUnreadable prefixes the reason a Stellar deposit record cannot be read.
const stellarUnreadable = "message_prehash commits a destination but is not a readable Stellar deposit record: "

// maxI128 is the largest amount the escrow's i128 carries.
var maxI128 = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 127), big.NewInt(1))

// stellarRecord is a Stellar deposit record read strictly: every member it defines, and nothing else.
type stellarRecord struct {
	params stellar.EscrowDepositParams
	fields map[string]string // each member as signed
}

// readStellarRecord reads the deposit record the escrow hashes; reason is "" when readable.
func readStellarRecord(root map[string]any) (stellarRecord, string) {
	rec := stellarRecord{fields: map[string]string{}}
	for name := range root {
		if !slices.Contains(stellarRecordMembers, name) {
			return rec, "it carries a member the Stellar deposit record does not define"
		}
	}
	for _, name := range stellarRecordMembers {
		s, ok := stringMember(root, name)
		if !ok {
			return rec, name + " is not a string"
		}
		rec.fields[name] = s
	}
	rec.params.Destination = rec.fields["destination"]
	if isJSONBlank(rec.params.Destination) {
		return rec, "destination is blank"
	}
	hash, ok := parseHash32(rec.fields["deposit_request_hash"])
	if !ok {
		return rec, "deposit_request_hash is not a 32-byte hex value"
	}
	rec.params.DepositRequestHash = hash
	// The depositor and token are G or C strkeys. A muxed (M, W) or other strkey has no 33 byte form
	// the contract accepts, so it is refused here rather than hashed into a digest no deposit can use.
	for _, a := range []struct {
		name string
		dst  *stellar.Address
	}{{"depositor", &rec.params.Depositor}, {"token", &rec.params.Token}} {
		address, err := stellar.ParseAddress(rec.fields[a.name])
		if err != nil {
			return rec, a.name + " is not a G or C strkey"
		}
		*a.dst = address
	}
	for _, k := range []struct {
		name string
		dst  *stellar.Pubkey
	}{{"reserver", &rec.params.Reserver}, {"releaser", &rec.params.Releaser}} {
		pk, err := stellar.PubkeyFromStrkey(rec.fields[k.name])
		if err != nil {
			return rec, k.name + " is not a G strkey"
		}
		if pk.IsZero() {
			return rec, k.name + " is the zero key"
		}
		*k.dst = pk
	}
	for _, name := range []string{"epoch", "amount", "nonce", "issued_at", "deadline"} {
		if !uintPattern.MatchString(rec.fields[name]) {
			return rec, name + " is not a decimal integer string"
		}
	}
	for _, n := range []struct {
		name string
		dst  *uint64
	}{{"epoch", &rec.params.Epoch}, {"nonce", &rec.params.Nonce}, {"issued_at", &rec.params.IssuedAt}, {"deadline", &rec.params.Deadline}} {
		v, err := strconv.ParseUint(rec.fields[n.name], 10, 64)
		if err != nil {
			return rec, n.name + " exceeds u64"
		}
		*n.dst = v
	}
	// The first record of a (depositor, token) has epoch 1: the contract never assigns 0.
	if rec.params.Epoch == 0 {
		return rec, "epoch is zero"
	}
	amount, _ := new(big.Int).SetString(rec.fields["amount"], 10)
	if rec.params.Deadline <= rec.params.IssuedAt {
		return rec, "deadline is not after issued_at"
	}
	if rec.params.Deadline-rec.params.IssuedAt > stellar.MaxDepositValiditySecs {
		return rec, "deadline is more than 86400 seconds after issued_at"
	}
	if amount.Cmp(maxI128) > 0 {
		return rec, "amount exceeds i128"
	}
	if amount.Sign() == 0 {
		return rec, "amount is zero"
	}
	rec.params.Amount = amount
	return rec, ""
}

// stellarDelegateKey is the delegate signer a Stellar signed message names: payload.delegate_signer,
// a G strkey. It is required, because the signature is by that key and not by the depositor. reason
// is "" when the key is usable. Mirrors the TS stellarDelegateKey.
func stellarDelegateKey(payload map[string]any) (ed25519.PublicKey, string) {
	v, present := payload["delegate_signer"]
	s, isString := v.(string)
	if !present || !isString {
		return nil, "payload.delegate_signer is required and must be a G strkey"
	}
	pk, err := stellar.PubkeyFromStrkey(s)
	if err != nil {
		return nil, "payload.delegate_signer is not a G strkey"
	}
	return ed25519.PublicKey(pk.Bytes()), ""
}

// bindStellarDeposit recomputes the deposit digest from the record (already read by readStellarRecord), requires it to be the signed
// message, and verifies the delegate signer's ed25519 signature over it. The record's depositor must
// be the payment's source account. It returns an empty outcome when bound.
func bindStellarDeposit(domain stellar.EscrowDomain, rec stellarRecord, deposit SignedMessageInput, sourceAccount string) (CommitmentOutcome, string) {
	digest, err := stellar.ComputeDepositHash(rec.params, domain)
	if err != nil {
		return OutcomePrehashMismatch, stellarUnreadable + err.Error()
	}
	if problem := signedDigestProblem(deposit.Message, digest[:], "the signed digest is not the Stellar deposit digest of message_prehash"); problem != "" {
		return OutcomePrehashMismatch, problem
	}
	if rec.fields["depositor"] != sourceAccount {
		return OutcomeSignerMismatch, "the signed deposit's depositor is not the payment's source account"
	}
	key, reason := stellarDelegateKey(deposit.Payload)
	if reason != "" {
		return OutcomeSignerMismatch, reason
	}
	if !ed25519SigPattern.MatchString(deposit.Signature) {
		return OutcomeSignerMismatch, "the signature is not a 64-byte hex ed25519 signature"
	}
	sig, _ := hex.DecodeString(deposit.Signature[2:])
	if !verifyEd25519Strict(key, digest[:], sig) {
		return OutcomeSignerMismatch, "the ed25519 signature does not verify against the payload's delegate signer"
	}
	return "", ""
}
