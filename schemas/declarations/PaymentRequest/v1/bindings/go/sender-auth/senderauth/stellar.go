package senderauth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"

	stellar "github.com/atum-labs/protocol/contracts/stellar/bindings/go/escrow-encoding/encoding"
	paymentrequest "github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/generated"
)

// stellarIssuedAtSkewSecs is how far issued_at is back-dated from the local clock when the caller
// supplies none. The escrow requires issued_at <= ledger time; a local clock ahead of the ledger
// would otherwise revert. Mirrors TS STELLAR_ISSUED_AT_SKEW_SECS.
const stellarIssuedAtSkewSecs = 30

// stellarDefaultValiditySecs is the validity of a deposit built with no explicit deadline, within the
// escrow's 24 hour bound. Mirrors TS STELLAR_DEFAULT_VALIDITY_SECS.
const stellarDefaultValiditySecs = 3600

// stellarAdapter is the Stellar ed25519 deposit sender_auth adapter. Mirrors the TS stellarAdapter.
// The payer authorises each deposit with an offchain ed25519 signature by its delegate signer over the
// escrow's deposit digest; the delegate itself is registered once on chain (create_delegate, plus a
// SEP-41 approve to the escrow), which is outside this adapter.
type stellarAdapter struct{}

// errStellarEpoch is the refusal of a Stellar build that names no usable delegate epoch. Same text as
// the TS builder's.
var errStellarEpoch = fmt.Errorf("sender_auth: a Stellar deposit needs delegateEpoch, the epoch of the payer's delegate record (get_delegate), as an integer from 1 to 2^64-1")

// ErrStellarIssuedAtOverflow is the refusal of a Stellar build that names no deadline and whose
// issued_at is within stellarDefaultValiditySecs of 2^64-1, so the default deadline would not fit
// u64. The sum would otherwise wrap to a small deadline, which only the later deadline-after-issued_at
// check refused, and with the wrong reason. A caller that supplies its own deadline is not affected.
var ErrStellarIssuedAtOverflow = errors.New("sender_auth: Stellar issued_at is too large for the default deadline: issued_at + 3600 exceeds 2^64-1")

func stellarDomainFor(network, escrow string) (stellar.EscrowDomain, error) {
	domain, detail := stellarEscrowDomain(network, escrow)
	if detail != "" {
		return stellar.EscrowDomain{}, fmt.Errorf("sender_auth: Stellar source: %s", detail)
	}
	return domain, nil
}

func (stellarAdapter) BuildAuthMessage(params BuildParams) (AuthMessageResult, error) {
	if params.PaymentRequestJSON == nil && params.RequestID == "" {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: request_id is required")
	}
	network := strings.SplitN(params.SourceAsset, "/", 2)[0]
	token, err := assetAddress(params.SourceAsset)
	if err != nil {
		return AuthMessageResult{}, err
	}
	domain, err := stellarDomainFor(network, params.SourceDefaults.EscrowContract)
	if err != nil {
		return AuthMessageResult{}, err
	}

	// Required: the digest commits to the delegate record's epoch, which is on-chain state. Guessing 1
	// would sign a deposit the escrow voids whenever the payer has ever re-created the delegate.
	if params.DelegateEpoch == nil || *params.DelegateEpoch == 0 {
		return AuthMessageResult{}, errStellarEpoch
	}

	// The nonce is an unordered per-depositor u64 the escrow never reuses. A caller that supplies none
	// gets a random one; a supplied one must fit u64, which would otherwise fail on chain after the
	// payer has signed.
	var nonce uint64
	if params.Nonce != nil {
		if params.Nonce.Sign() < 0 || !params.Nonce.IsUint64() {
			return AuthMessageResult{}, fmt.Errorf("sender_auth: Stellar nonce must fit an unsigned 64-bit integer (0 <= nonce < 2^64)")
		}
		nonce = params.Nonce.Uint64()
	} else {
		var b [8]byte
		_, _ = rand.Read(b[:])
		nonce = binary.BigEndian.Uint64(b[:])
	}
	var issuedAt uint64
	if params.IssuedAt != nil {
		issuedAt = *params.IssuedAt
	} else {
		issuedAt = uint64(time.Now().Unix() - stellarIssuedAtSkewSecs)
	}
	var deadline uint64
	if params.Deadline != nil {
		if params.Deadline.Sign() < 0 || !params.Deadline.IsUint64() {
			return AuthMessageResult{}, fmt.Errorf("sender_auth: Stellar deadline must fit an unsigned 64-bit integer")
		}
		deadline = params.Deadline.Uint64()
	} else {
		if issuedAt > math.MaxUint64-stellarDefaultValiditySecs {
			return AuthMessageResult{}, ErrStellarIssuedAtOverflow
		}
		deadline = issuedAt + stellarDefaultValiditySecs
	}
	if deadline <= issuedAt {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: Stellar deadline must be after issued_at")
	}
	if deadline-issuedAt > stellar.MaxDepositValiditySecs {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: Stellar deposit validity %ds exceeds the escrow's %ds bound", deadline-issuedAt, stellar.MaxDepositValiditySecs)
	}
	// The amount the permit authorizes: the chosen quote's source amount when one is set, else the
	// request's maximum, as on every other chain.
	amountField, amountText, err := params.depositAmount()
	if err != nil {
		return AuthMessageResult{}, err
	}
	amount, ok := new(big.Int).SetString(amountText, 10)
	if !ok || !uintPattern.MatchString(amountText) {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: invalid %s %q", amountField, amountText)
	}

	requestHash, destination, err := params.commitments(sameAddress)
	if err != nil {
		return AuthMessageResult{}, err
	}
	prehash := stellarDepositPrehash{
		DepositRequestHash: "0x" + hex.EncodeToString(requestHash[:]),
		Destination:        destination,
		Depositor:          params.Depositor,
		Token:              token,
		Epoch:              strconv.FormatUint(*params.DelegateEpoch, 10),
		Amount:             amount.String(),
		Reserver:           params.SourceDefaults.QuoteSelector,
		Releaser:           params.SourceDefaults.FulfillmentVerifierAccount,
		Nonce:              strconv.FormatUint(nonce, 10),
		IssuedAt:           strconv.FormatUint(issuedAt, 10),
		Deadline:           strconv.FormatUint(deadline, 10),
	}
	// Hashing validates every member (strkeys, ranges, non-zero), so an unusable deposit is refused
	// here, before the payer signs, rather than reverting on chain.
	digest, err := stellarDepositDigest(prehash, domain)
	if err != nil {
		return AuthMessageResult{}, err
	}
	prehashJSON, err := json.Marshal(prehash)
	if err != nil {
		return AuthMessageResult{}, err
	}
	return AuthMessageResult{
		MessageScheme:  paymentrequest.SenderAuthMessageSchemeSTELLAR,
		MessageHash:    "0x" + hex.EncodeToString(digest[:]),
		MessagePrehash: string(prehashJSON),
	}, nil
}

// stellarDepositPrehash is the flat record the builder emits in message_prehash: the members the
// escrow's deposit digest is computed from. Mirrors TS StellarDepositPrehash.
type stellarDepositPrehash struct {
	DepositRequestHash string `json:"deposit_request_hash"`
	Destination        string `json:"destination"`
	Depositor          string `json:"depositor"`
	Token              string `json:"token"`
	Epoch              string `json:"epoch"`
	Amount             string `json:"amount"`
	Reserver           string `json:"reserver"`
	Releaser           string `json:"releaser"`
	Nonce              string `json:"nonce"`
	IssuedAt           string `json:"issued_at"`
	Deadline           string `json:"deadline"`
}

// stellarDepositDigest hashes a prehash with the shared Stellar escrow encoder, reading it through
// the same strict record reader the verifier uses.
func stellarDepositDigest(prehash stellarDepositPrehash, domain stellar.EscrowDomain) ([32]byte, error) {
	raw, err := json.Marshal(prehash)
	if err != nil {
		return [32]byte{}, err
	}
	var root map[string]any
	if err := json.Unmarshal(raw, &root); err != nil {
		return [32]byte{}, err
	}
	rec, reason := readStellarRecord(root)
	if reason != "" {
		return [32]byte{}, fmt.Errorf("sender_auth: Stellar deposit is not usable: %s", reason)
	}
	return stellar.ComputeDepositHash(rec.params, domain)
}

// ErrStellarNotADeposit is the refusal of AssertStellarSignable: the message is not the deposit
// digest of its own message_prehash, so signing it could authorize something other than a deposit.
var ErrStellarNotADeposit = errors.New("sender_auth: Stellar message is not the deposit digest of its message_prehash")

// AssertStellarSignable refuses a Stellar message that is not the deposit digest of its own
// message_prehash, before any key signs it. Sign signs the 32 bytes it is given, and an ed25519
// signature over 32 bytes is also how a Stellar transaction is signed (over the transaction's hash),
// so a requester that sets message to a transaction hash would otherwise get a transaction signature
// from the payer's key. A digest rebuilt from the prehash, the network and the escrow cannot be a
// transaction hash, so a message that equals it is a deposit and nothing else.
//
// The escrow only has to be the one the request names: this does not decide whether that escrow is
// trustworthy (VerifyPaymentRequest binds it to the payer's own configuration), only that the bytes
// are a deposit digest for it. Sign cannot run this itself because it is given the message and no
// network or escrow, so every entry point that holds a request runs it first. Mirrors the TS
// assertStellarSignable. The error wraps ErrStellarNotADeposit when the digests differ.
func AssertStellarSignable(signed SignedMessageInput, network, escrow string) error {
	if !digestPattern.MatchString(signed.Message) {
		return fmt.Errorf("sender_auth: message must be the 0x-prefixed 32-byte deposit digest")
	}
	if signed.MessagePrehash == nil || *signed.MessagePrehash == "" {
		return fmt.Errorf("sender_auth: a Stellar message is signed only with its message_prehash, which the deposit digest is rebuilt from")
	}
	var root map[string]any
	if err := json.Unmarshal([]byte(*signed.MessagePrehash), &root); err != nil || root == nil {
		return fmt.Errorf("sender_auth: message_prehash must be a JSON object")
	}
	domain, err := stellarDomainFor(network, escrow)
	if err != nil {
		return err
	}
	rec, reason := readStellarRecord(root)
	if reason != "" {
		return fmt.Errorf("sender_auth: Stellar deposit is not usable: %s", reason)
	}
	digest, err := stellar.ComputeDepositHash(rec.params, domain)
	if err != nil {
		return err
	}
	if "0x"+hex.EncodeToString(digest[:]) != strings.ToLower(signed.Message) {
		return fmt.Errorf("%w: message_prehash implies 0x%s but message is %s", ErrStellarNotADeposit, hex.EncodeToString(digest[:]), signed.Message)
	}
	return nil
}

func (stellarAdapter) Sign(signed SignedMessageInput, privateKey string) (string, error) {
	if !digestPattern.MatchString(signed.Message) {
		return "", fmt.Errorf("sender_auth: message must be the 0x-prefixed 32-byte deposit digest")
	}
	messageBytes, err := hexToBytes(signed.Message)
	if err != nil {
		return "", fmt.Errorf("sender_auth: invalid message: %w", err)
	}
	secretKey, err := stellarSecretKey(privateKey)
	if err != nil {
		return "", err
	}
	return "0x" + hex.EncodeToString(ed25519.Sign(secretKey, messageBytes)), nil
}

func (stellarAdapter) DeriveDelegateSigner(privateKey string) (string, error) {
	secretKey, err := stellarSecretKey(privateKey)
	if err != nil {
		return "", err
	}
	pk, err := stellar.PubkeyFromBytes(secretKey.Public().(ed25519.PublicKey))
	if err != nil {
		return "", err
	}
	return pk.String(), nil
}

// RecoverSigner verifies the signature against payload.delegate_signer and returns source.account
// when that key is source.account (the payer's own key registered as its delegate). A signature that
// verifies under any other key is ErrDelegateUnverified: the requester named that key, and whether
// it is registered for the depositor is on-chain state (get_delegate for the depositor and token)
// that no offline check reads, so it is not shown to be the depositor's signer. A bad signature is
// ErrSignerMismatch. Mirrors the TS recoverSigner.
func (stellarAdapter) RecoverSigner(signed SignedMessageInput, source SourceRef) (string, error) {
	key, reason := stellarDelegateKey(signed.Payload)
	if reason != "" {
		return "", fmt.Errorf("%w: %s", ErrRecoveryFailed, reason)
	}
	if !digestPattern.MatchString(signed.Message) {
		return "", fmt.Errorf("%w: message must be the 0x-prefixed 32-byte deposit digest", ErrRecoveryFailed)
	}
	if !ed25519SigPattern.MatchString(signed.Signature) {
		return "", fmt.Errorf("%w: signature must be 0x-prefixed 64-byte hex", ErrRecoveryFailed)
	}
	msg, _ := hex.DecodeString(signed.Message[2:])
	sig, _ := hex.DecodeString(signed.Signature[2:])
	if !verifyEd25519Strict(key, msg, sig) {
		return "", fmt.Errorf("%w: ed25519 verification failed", ErrSignerMismatch)
	}
	pk, _ := stellar.PubkeyFromBytes(key)
	if pk.String() != source.Account {
		return "", fmt.Errorf("%w: delegate_signer %s", ErrDelegateUnverified, pk.String())
	}
	return source.Account, nil
}

func (stellarAdapter) RecoverAndVerify(signed SignedMessageInput, source SourceRef, commitment CommitmentExpectation, expected Expectations) (VerifiedSenderAuth, error) {
	// The network is the payment's own source chain; the escrow is the verifier's configuration.
	rec, destination, domain, err := stellarCanonical(signed, source.Network, expected)
	if err != nil {
		return VerifiedSenderAuth{}, err
	}
	if outcome, detail := bindStellarDeposit(domain, rec, signed, source.Account); outcome != "" {
		return VerifiedSenderAuth{}, commitmentRefusal("stellar", outcome, detail)
	}
	f := rec.fields
	parsedDeadline, err := strconv.ParseInt(f["deadline"], 10, 64)
	if err != nil {
		return VerifiedSenderAuth{}, malformedPrehash("stellar", OutcomePrehashMismatch, detailDeadlineRange)
	}
	deadline, ok := deadlineSeconds(parsedDeadline)
	if !ok {
		return VerifiedSenderAuth{}, malformedPrehash("stellar", OutcomePrehashMismatch, detailDeadlineRange)
	}
	// No freshness check here: the escrow's ledger-time window and nonce bitmap are the authority.
	if err := assertToken(f["token"], source.Asset, identityAddr); err != nil {
		return VerifiedSenderAuth{}, err
	}
	if err := assertPermitAmount("stellar", f["amount"], expected); err != nil {
		return VerifiedSenderAuth{}, err
	}
	// Both roles are required (stellarCanonical refuses otherwise), so unlike EVM and Solana the
	// comparison is never skipped.
	if err := assertWitnessRoles(f["reserver"], f["releaser"], expected.Reserver, expected.Releaser, identityAddr); err != nil {
		return VerifiedSenderAuth{}, err
	}
	delegate, _ := stellarDelegateKey(signed.Payload)
	delegateSigner, _ := stellar.PubkeyFromBytes(delegate)
	hash, _ := parseHash32(f["deposit_request_hash"])
	result, err := requireCommitment("stellar", destination, f["deposit_request_hash"], hash, commitment)
	if err != nil {
		return VerifiedSenderAuth{}, err
	}
	result.Scheme = string(paymentrequest.SenderAuthMessageSchemeSTELLAR)
	// Last, so every other refusal keeps its own outcome: the signature, the record and the
	// commitment all held, and the signer is still only the requester's word for the depositor.
	if delegateSigner.String() != source.Account {
		return VerifiedSenderAuth{}, fmt.Errorf("%w: delegate_signer %s", ErrDelegateUnverified, delegateSigner.String())
	}
	return VerifiedSenderAuth{
		AuthTerms: AuthTerms{Amount: f["amount"], DeadlineSec: deadline},
		Permit: ParsedPermit{
			Scheme:      paymentrequest.SenderAuthMessageSchemeSTELLAR,
			Token:       f["token"],
			Amount:      f["amount"],
			DeadlineSec: deadline,
			Reserver:    f["reserver"],
			Releaser:    f["releaser"],
			Depositor:   f["depositor"],
			// Equal to the depositor here, and still not shown to be registered for it on chain.
			DelegateSigner:            delegateSigner.String(),
			DelegateOnchainUnverified: true,
			DelegateEpoch:             f["epoch"],
			Destination:               destination,
			DepositRequestHash:        f["deposit_request_hash"],
		},
		Commitment: result,
	}, nil
}

// stellarCanonical reads message_prehash for RecoverAndVerify with the commitment check's rules and
// outcomes, and returns the deposit record, the signed destination and the verifier's escrow domain. A missing or unusable escrow, or a record that commits no destination
// or request hash, is a *CommitmentError; any other unusable prehash is also ErrMalformedPrehash.
func stellarCanonical(signed SignedMessageInput, network string, expected Expectations) (stellarRecord, string, stellar.EscrowDomain, error) {
	fail := func(outcome CommitmentOutcome, detail string) (stellarRecord, string, stellar.EscrowDomain, error) {
		return stellarRecord{}, "", stellar.EscrowDomain{}, malformedPrehash("stellar", outcome, detail)
	}
	refuse := func(outcome CommitmentOutcome, detail string) (stellarRecord, string, stellar.EscrowDomain, error) {
		return stellarRecord{}, "", stellar.EscrowDomain{}, commitmentRefusal("stellar", outcome, detail)
	}
	domain, detail := stellarEscrowDomain(network, expected.EscrowContract)
	if detail != "" {
		return refuse(OutcomeVerifierMisconfigured, detail)
	}
	if expected.Reserver == "" || expected.Releaser == "" {
		return refuse(OutcomeVerifierMisconfigured, stellarRolesUnset)
	}
	root, outcome, detail := readPrehash(signed.MessagePrehash)
	if outcome != "" {
		return fail(outcome, detail)
	}
	if memberSpelledTwice(root) {
		return fail(OutcomePrehashMismatch, "message_prehash spells one member two ways")
	}
	for _, member := range []struct{ name, detail string }{{"destination", detailNoDestination}, {"deposit_request_hash", detailNoRequestHash}} {
		if _, outcome, detail := readCommitmentMember(root, member.detail, member.name); outcome == OutcomeCommitmentAbsent {
			return refuse(outcome, detail)
		}
	}
	destination, outcome, detail := readCommitmentMember(root, detailNoDestination, "destination")
	if outcome != "" {
		return fail(outcome, detail)
	}
	hashText, outcome, detail := readCommitmentMember(root, detailNoRequestHash, "deposit_request_hash")
	if outcome != "" {
		return fail(outcome, detail)
	}
	if _, ok := parseHash32(hashText); !ok {
		return fail(OutcomePrehashMismatch, detailBadRequestHash)
	}
	rec, reason := readStellarRecord(root)
	if reason != "" {
		return fail(OutcomePrehashMismatch, "message_prehash commits a destination but is not a readable Stellar deposit record: "+reason)
	}
	return rec, destination, domain, nil
}

// stellarSecretKey resolves an ed25519 secret key from a 64 hex digit 32-byte seed (a 0x prefix is
// allowed). Stellar's S... strkey is not accepted: the caller decodes it, so a secret never passes
// through a string this package parses or could echo. Mirrors TS secretKeyFromPrivate.
func stellarSecretKey(privateKey string) (ed25519.PrivateKey, error) {
	text := strings.TrimPrefix(privateKey, "0x")
	if len(text) != 2*ed25519.SeedSize || !isHex(text) {
		return nil, fmt.Errorf("invalid Stellar private key: expected a 32-byte ed25519 seed as 64 hex digits")
	}
	seed, err := hex.DecodeString(text)
	if err != nil {
		return nil, err
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// ParseStellarNonce reads a deposit nonce given as text, for BuildParams.Nonce. Only a plain decimal
// string is accepted, as in the TS builder: no sign, prefix, space or leading zero, so the nonce
// that is signed is the one the caller wrote. Range (u64) is checked by BuildAuthMessage.
func ParseStellarNonce(text string) (*big.Int, error) {
	n, ok := new(big.Int).SetString(text, 10)
	if !ok || !uintPattern.MatchString(text) {
		return nil, fmt.Errorf("sender_auth: Stellar nonce must be a decimal integer string")
	}
	return n, nil
}

// ParseStellarEpoch reads a delegate epoch given as text, for BuildParams.DelegateEpoch: a plain
// decimal string from 1 to 2^64-1, as the TS builder reads it.
func ParseStellarEpoch(text string) (uint64, error) {
	if !uintPattern.MatchString(text) {
		return 0, errStellarEpoch
	}
	n, err := strconv.ParseUint(text, 10, 64)
	if err != nil || n == 0 {
		return 0, errStellarEpoch
	}
	return n, nil
}
