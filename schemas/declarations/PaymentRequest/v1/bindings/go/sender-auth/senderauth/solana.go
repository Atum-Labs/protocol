package senderauth

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	svm "github.com/atum-labs/protocol/contracts/svm/bindings/go/escrow-encoding/encoding"
	paymentrequest "github.com/atum-labs/protocol/schemas/declarations/PaymentRequest/v1/bindings/go/generated"

	"github.com/mr-tron/base58"
)

// replayHorizonSecs is the replay horizon in seconds — the deposit deadline must be
// within this window of issuedAt. Mirrors TS REPLAY_HORIZON_SECS.
const replayHorizonSecs = 128

// solanaAdapter is the Solana ed25519 deposit sender_auth adapter. Mirrors the TS Solana adapter.
type solanaAdapter struct{}

func (solanaAdapter) BuildAuthMessage(params BuildParams) (AuthMessageResult, error) {
	// request_id is the idempotency key and is hashed into payment_id below; reject an empty one
	// loudly (matching the deterministic-nonce seed) instead of hashing the empty string.
	if params.PaymentRequestJSON == nil && params.RequestID == "" {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: request_id is required")
	}
	sourceChainID := strings.SplitN(params.SourceAsset, "/", 2)[0]
	tokenMint, err := assetAddress(params.SourceAsset)
	if err != nil {
		return AuthMessageResult{}, err
	}

	var issuedAt uint64
	if params.SolanaClock != nil {
		issuedAt, err = params.SolanaClock(sourceChainID)
		if err != nil {
			return AuthMessageResult{}, err
		}
	} else {
		issuedAt = uint64(time.Now().Unix())
	}
	deadline := issuedAt + uint64(replayHorizonSecs-8) // 120s, safely within 128s window

	amountField, amountText, err := params.depositAmount()
	if err != nil {
		return AuthMessageResult{}, err
	}
	amount, err := strconv.ParseUint(amountText, 10, 64)
	if err != nil {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: invalid %s %q", amountField, amountText)
	}
	// Honor a caller-supplied nonce (e.g. DeterministicSolanaNonce); otherwise generate a random
	// valid replay-window nonce. A supplied nonce is validated here because both failures would
	// otherwise surface only on-chain, after the payer has signed: a value that does not fit the
	// 8-byte little-endian field, and a low byte in the reserved replay-slot range (slot =
	// nonce & 0xFF must be < 235). Bits 8..31 are ignored on-chain and the bucket uses the upper
	// 4 bytes, so those are not constrained.
	nonce := generateValidSolanaNonce()
	if params.Nonce != nil {
		if params.Nonce.Sign() < 0 || !params.Nonce.IsUint64() {
			return AuthMessageResult{}, fmt.Errorf("sender_auth: Solana nonce must fit an unsigned 64-bit integer (0 <= nonce < 2^64)")
		}
		nonce = params.Nonce.Uint64()
		if nonce&0xFF >= uint64(solanaReplaySlots) {
			return AuthMessageResult{}, fmt.Errorf("sender_auth: Solana nonce low byte (replay slot = nonce & 0xFF = %d) must be < %d; slots %d-255 are reserved", nonce&0xFF, solanaReplaySlots, solanaReplaySlots)
		}
	}
	domain, err := solanaDomainFrom(
		params.SourceDefaults.SvmSignatureClusterID,
		params.SourceDefaults.SvmSignatureDomainVersion,
		params.SourceDefaults.EscrowContract,
	)
	if err != nil {
		return AuthMessageResult{}, err
	}
	// The destination is committed from signature domain version 4, so a lower version is refused.
	if domain.SignatureDomainVersion < svmDestinationCommitmentVersion {
		return AuthMessageResult{}, fmt.Errorf("sender_auth: Solana signature domain version %d commits no destination; version %d or later is required",
			domain.SignatureDomainVersion, svmDestinationCommitmentVersion)
	}
	requestHash, destination, err := params.commitments(sameAddress)
	if err != nil {
		return AuthMessageResult{}, err
	}
	prehash := svm.SolanaDepositPrehashV2{
		DepositRequestHash: "0x" + hex.EncodeToString(requestHash[:]),
		Destination:        destination,
		Depositor:          params.Depositor,
		Mint:               tokenMint,
		Amount:             strconv.FormatUint(amount, 10),
		Reserver:           params.SourceDefaults.QuoteSelector,
		Releaser:           params.SourceDefaults.FulfillmentVerifierAccount,
		Nonce:              strconv.FormatUint(nonce, 10),
		IssuedAt:           strconv.FormatUint(issuedAt, 10),
		Deadline:           strconv.FormatUint(deadline, 10),
	}
	hash, err := solanaDepositHashV2(prehash, domain)
	if err != nil {
		return AuthMessageResult{}, err
	}
	prehashJSON, err := json.Marshal(prehash)
	if err != nil {
		return AuthMessageResult{}, err
	}
	return AuthMessageResult{
		MessageScheme:  paymentrequest.SenderAuthMessageSchemeSOLANA,
		MessageHash:    "0x" + hex.EncodeToString(hash[:]),
		MessagePrehash: string(prehashJSON),
	}, nil
}

// Sign signs the 32 byte escrow hash in signed.Message: the raw hash by default, or its escrow text
// when the SDK-local signed.SvmMessageScheme names the text scheme (the reserve text for a reserve
// record, the deposit text otherwise).
func (solanaAdapter) Sign(signed SignedMessageInput, privateKey string) (string, error) {
	messageBytes, err := hexToBytes(signed.Message)
	if err != nil {
		return "", fmt.Errorf("sender_auth: invalid message: %w", err)
	}
	secretKey, err := solanaSecretKey(privateKey)
	if err != nil {
		return "", err
	}
	toSign := messageBytes
	if signed.SvmMessageScheme != "" {
		if len(messageBytes) != 32 {
			return "", fmt.Errorf("sender_auth: Solana message must be the 32-byte escrow hash, got %d bytes", len(messageBytes))
		}
		if toSign, err = svm.SigningBytes(svm.MessageScheme(signed.SvmMessageScheme), solanaWitnessKind(signed.MessagePrehash), [32]byte(messageBytes)); err != nil {
			return "", fmt.Errorf("sender_auth: %w", err)
		}
	}
	sig := ed25519.Sign(secretKey, toSign)
	return "0x" + hex.EncodeToString(sig), nil
}

func (solanaAdapter) DeriveDelegateSigner(privateKey string) (string, error) {
	secretKey, err := solanaSecretKey(privateKey)
	if err != nil {
		return "", err
	}
	pub := secretKey.Public().(ed25519.PublicKey)
	return base58.Encode(pub), nil
}

func (solanaAdapter) RecoverAndVerify(signed SignedMessageInput, source SourceRef, commitment CommitmentExpectation, expected Expectations) (VerifiedSenderAuth, error) {
	// Read and bind the deposit with the same rules and outcomes as the commitment check: the
	// deposit hash is rebuilt with the verifier's escrow domain, must be the signed message, and the
	// ed25519 signature must verify against source.account (a delegate_signer, when present, must
	// be that same key).
	prehash, destination, root, domain, err := solanaCanonical(signed, expected)
	if err != nil {
		return VerifiedSenderAuth{}, err
	}
	if outcome, detail := bindSolanaDeposit(domain, svm.MessageScheme(expected.SvmMessageScheme), root, signed, source.Account); outcome != "" {
		return VerifiedSenderAuth{}, commitmentRefusal("solana", outcome, detail)
	}

	parsedDeadline, err := strconv.ParseInt(prehash.Deadline, 10, 64)
	if err != nil {
		return VerifiedSenderAuth{}, malformedPrehash("solana", OutcomePrehashMismatch, detailDeadlineRange)
	}
	deadline, ok := deadlineSeconds(parsedDeadline)
	if !ok {
		return VerifiedSenderAuth{}, malformedPrehash("solana", OutcomePrehashMismatch, detailDeadlineRange)
	}
	// Universal binding. There is no freshness check on Solana: the escrow's on-chain
	// issued_at/nonce replay window is the authority.
	if err := assertToken(prehash.Mint, source.Asset, identityAddr); err != nil {
		return VerifiedSenderAuth{}, err
	}
	if err := assertPermitAmount("solana", prehash.Amount, expected); err != nil {
		return VerifiedSenderAuth{}, err
	}
	// Opt-in atum-escrow scheme fail-fast (Solana has no separate spender — the escrow is
	// bound via the deposit-hash domain above).
	if err := assertRolePairComplete(expected.Reserver, expected.Releaser); err != nil {
		return VerifiedSenderAuth{}, err
	}
	if expected.Reserver != "" && expected.Releaser != "" {
		if err := assertWitnessRoles(prehash.Reserver, prehash.Releaser, expected.Reserver, expected.Releaser, identityAddr); err != nil {
			return VerifiedSenderAuth{}, err
		}
	}
	hash, _ := parseHash32(prehash.DepositRequestHash)
	result, err := requireCommitment("solana", destination, prehash.DepositRequestHash, hash, commitment)
	if err != nil {
		return VerifiedSenderAuth{}, err
	}
	result.Scheme = string(paymentrequest.SenderAuthMessageSchemeSOLANA)

	return VerifiedSenderAuth{
		AuthTerms: AuthTerms{Amount: prehash.Amount, DeadlineSec: deadline},
		Permit: ParsedPermit{
			Scheme:      paymentrequest.SenderAuthMessageSchemeSOLANA,
			Token:       prehash.Mint,
			Amount:      prehash.Amount,
			DeadlineSec: deadline,
			Reserver:    prehash.Reserver,
			Releaser:    prehash.Releaser,
			Depositor:   prehash.Depositor,
			// The two commitments as signed.
			Destination:        destination,
			DepositRequestHash: prehash.DepositRequestHash,
		},
		Commitment: result,
	}, nil
}

// RecoverSigner verifies the ed25519 signature against payload.delegate_signer and confirms
// it is source.account — WITHOUT parsing or binding the deposit prehash. The recover-only
// primitive a multi-message verifier runs over every signed_messages[] entry. It accepts a
// signature over the raw hash or over its escrow text in any form, since it proves the signer
// only; the escrow's scheme is enforced by the commitment check. Returns source.account on
// success. Mirrors the TS `recoverSigner`.
func (solanaAdapter) RecoverSigner(signed SignedMessageInput, source SourceRef) (string, error) {
	// The ed25519 signer is source.account. A payload.delegate_signer, when present, must equal
	// it; when absent, source.account is the verifying key. ed25519 is not key-recoverable, so
	// encoding failures are recovery_failed and a clean but failing verify is signer_mismatch.
	if !solanaDelegateIs(signed.Payload, source.Account) {
		return "", fmt.Errorf("%w: delegate_signer is not source.account", ErrSignerMismatch)
	}
	pub, err := base58.Decode(source.Account)
	if err != nil || len(pub) != ed25519.PublicKeySize || !base58Pattern.MatchString(source.Account) {
		return "", fmt.Errorf("%w: source.account is not a valid base58 ed25519 pubkey", ErrRecoveryFailed)
	}
	if !digestPattern.MatchString(signed.Message) {
		return "", fmt.Errorf("%w: message must be the 0x-prefixed 32-byte deposit hash", ErrRecoveryFailed)
	}
	if !ed25519SigPattern.MatchString(signed.Signature) {
		return "", fmt.Errorf("%w: signature must be 0x-prefixed 64-byte hex", ErrRecoveryFailed)
	}
	msg, _ := hex.DecodeString(signed.Message[2:])
	sig, _ := hex.DecodeString(signed.Signature[2:])
	if !solanaSignerMatches([32]byte(msg), pub, sig) {
		return "", fmt.Errorf("%w: ed25519 verification failed", ErrSignerMismatch)
	}
	return source.Account, nil
}

// solanaCanonical reads message_prehash for RecoverAndVerify with the commitment check's rules and
// outcomes, and returns the deposit record, the signed destination, the decoded prehash and the
// verifier's escrow domain. A missing or unusable escrow domain, or a record that commits no
// destination or request hash, is a *CommitmentError; any other unusable prehash is also
// ErrMalformedPrehash.
func solanaCanonical(signed SignedMessageInput, expected Expectations) (SolanaDepositPrehash, string, map[string]any, svm.EscrowDomain, error) {
	fail := func(outcome CommitmentOutcome, detail string) (SolanaDepositPrehash, string, map[string]any, svm.EscrowDomain, error) {
		return SolanaDepositPrehash{}, "", nil, svm.EscrowDomain{}, malformedPrehash("solana", outcome, detail)
	}
	refuse := func(outcome CommitmentOutcome, detail string) (SolanaDepositPrehash, string, map[string]any, svm.EscrowDomain, error) {
		return SolanaDepositPrehash{}, "", nil, svm.EscrowDomain{}, commitmentRefusal("solana", outcome, detail)
	}
	configured := solanaDomainOf(expected)
	if configured == nil {
		return refuse(OutcomeVerifierMisconfigured, "the Solana escrow domain (program id, cluster, domain version) was not supplied")
	}
	domain, detail := solanaEscrowDomain(*configured)
	if detail != "" {
		return refuse(OutcomeVerifierMisconfigured, detail)
	}
	if domain.SignatureDomainVersion < svmDestinationCommitmentVersion {
		return refuse(OutcomeCommitmentAbsent, fmt.Sprintf(
			"the escrow's signature domain version %d commits no destination; every deployed escrow requires version %d or later",
			domain.SignatureDomainVersion, svmDestinationCommitmentVersion))
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
	rec, reason := readSolanaRecord(root)
	if reason != "" {
		return fail(OutcomePrehashMismatch, "message_prehash commits a destination but is not a readable Solana deposit record: "+reason)
	}
	f := rec.fields
	return SolanaDepositPrehash{
		DepositRequestHash: f["deposit_request_hash"],
		Depositor:          f["depositor"],
		Mint:               f["mint"],
		Amount:             f["amount"],
		Reserver:           f["reserver"],
		Releaser:           f["releaser"],
		Nonce:              f["nonce"],
		IssuedAt:           f["issued_at"],
		Deadline:           f["deadline"],
	}, destination, root, domain, nil
}

// solanaDomainFrom builds the escrow domain from the escrow program id and cluster fields.
// Mirrors TS domainFrom: escrowContract is required first, then the svm fields.
func solanaDomainFrom(clusterName string, domainVersion *int, escrowContract string) (svm.EscrowDomain, error) {
	if escrowContract == "" {
		return svm.EscrowDomain{}, fmt.Errorf(
			"sender_auth: Solana source requires escrowContract (escrow program id) for the deposit-hash domain")
	}
	if clusterName == "" || domainVersion == nil {
		return svm.EscrowDomain{}, fmt.Errorf(
			"sender_auth: Solana source requires svmSignatureClusterId and svmSignatureDomainVersion (the escrow's signature domain)")
	}
	if *domainVersion < 1 || *domainVersion > math.MaxUint8 {
		return svm.EscrowDomain{}, fmt.Errorf("sender_auth: svmSignatureDomainVersion %d is not between 1 and 255", *domainVersion)
	}
	clusterID, err := clusterIDFromName(clusterName)
	if err != nil {
		return svm.EscrowDomain{}, err
	}
	programID, err := svm.PubkeyFromBase58(escrowContract)
	if err != nil {
		return svm.EscrowDomain{}, err
	}
	return svm.EscrowDomain{
		ClusterID:              clusterID,
		SignatureDomainVersion: uint8(*domainVersion),
		ProgramID:              programID,
	}, nil
}

// svmDestinationCommitmentVersion is the signature_domain_version at which the Solana deposit
// preimage starts committing to keccak256(destination). The escrow's version is read from its
// configuration, never assumed.
const svmDestinationCommitmentVersion = 4

// solanaDepositHashV2 is the domain >= 4 deposit hash: the deposit fields plus
// keccak256(destination) immediately after the request hash. Mirrors TS hashDepositV2.
func solanaDepositHashV2(prehash svm.SolanaDepositPrehashV2, domain svm.EscrowDomain) ([32]byte, error) {
	// Reuse the shared field decoding; the destination is passed separately.
	v1 := SolanaDepositPrehash{
		DepositRequestHash: prehash.DepositRequestHash,
		Depositor:          prehash.Depositor,
		Mint:               prehash.Mint,
		Amount:             prehash.Amount,
		Reserver:           prehash.Reserver,
		Releaser:           prehash.Releaser,
		Nonce:              prehash.Nonce,
		IssuedAt:           prehash.IssuedAt,
		Deadline:           prehash.Deadline,
	}
	params, err := solanaDepositParams(v1)
	if err != nil {
		return [32]byte{}, err
	}
	// Plaintext, NOT pre-hashed: the encoder hashes it, and hashing an already-hashed
	// destination yields a well-formed commitment no on-chain state can satisfy.
	return svm.ComputeDepositHashV2(params, prehash.Destination, domain)
}

// solanaDepositParams decodes a prehash's string fields into the encoder's typed parameters.
func solanaDepositParams(prehash SolanaDepositPrehash) (svm.EscrowDepositParams, error) {
	paymentIDBytes, err := hexToBytes(prehash.DepositRequestHash)
	if err != nil {
		return svm.EscrowDepositParams{}, err
	}
	if len(paymentIDBytes) != 32 {
		return svm.EscrowDepositParams{}, fmt.Errorf("sender_auth: payment_id must be 32 bytes, got %d", len(paymentIDBytes))
	}
	var paymentID [32]byte
	copy(paymentID[:], paymentIDBytes)

	depositor, err := svm.PubkeyFromBase58(prehash.Depositor)
	if err != nil {
		return svm.EscrowDepositParams{}, err
	}
	mint, err := svm.PubkeyFromBase58(prehash.Mint)
	if err != nil {
		return svm.EscrowDepositParams{}, err
	}
	reserver, err := svm.PubkeyFromBase58(prehash.Reserver)
	if err != nil {
		return svm.EscrowDepositParams{}, err
	}
	releaser, err := svm.PubkeyFromBase58(prehash.Releaser)
	if err != nil {
		return svm.EscrowDepositParams{}, err
	}
	amount, err := strconv.ParseUint(prehash.Amount, 10, 64)
	if err != nil {
		return svm.EscrowDepositParams{}, err
	}
	nonce, err := strconv.ParseUint(prehash.Nonce, 10, 64)
	if err != nil {
		return svm.EscrowDepositParams{}, err
	}
	issuedAt, err := strconv.ParseUint(prehash.IssuedAt, 10, 64)
	if err != nil {
		return svm.EscrowDepositParams{}, err
	}
	deadline, err := strconv.ParseUint(prehash.Deadline, 10, 64)
	if err != nil {
		return svm.EscrowDepositParams{}, err
	}

	return svm.EscrowDepositParams{
		DepositRequestHash: paymentID,
		Depositor:          depositor,
		Mint:               mint,
		Amount:             amount,
		Reserver:           reserver,
		Releaser:           releaser,
		Nonce:              nonce,
		IssuedAt:           issuedAt,
		Deadline:           deadline,
	}, nil
}

// solanaSecretKey resolves a 64-byte ed25519 secret key from the supported encodings:
//   - 64-char hex string: a 32-byte seed
//   - base58 32 bytes: a seed
//   - base58 64 bytes: a full secret key
//
// Mirrors TS secretKeyFromPrivate.
func solanaSecretKey(privateKey string) (ed25519.PrivateKey, error) {
	if len(privateKey) == 64 && isHex(privateKey) {
		seed, err := hex.DecodeString(privateKey)
		if err != nil {
			return nil, err
		}
		return ed25519.NewKeyFromSeed(seed), nil
	}
	decoded, err := base58.Decode(privateKey)
	if err != nil {
		return nil, err
	}
	switch len(decoded) {
	case ed25519.PrivateKeySize:
		return ed25519.PrivateKey(decoded), nil
	case ed25519.SeedSize:
		return ed25519.NewKeyFromSeed(decoded), nil
	default:
		return nil, fmt.Errorf("invalid Solana private key length: expected 32 or 64 bytes, got %d", len(decoded))
	}
}

func isHex(s string) bool {
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}
