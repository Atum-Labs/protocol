package senderauth

import (
	"encoding/hex"
	"math/big"
	"slices"
	"strings"

	svm "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/svm/bindings/go/escrow-encoding/encoding"
	"github.com/mr-tron/base58"
)

// svmReserveSourceAmountVersion is the first Solana signature domain version whose reserve hash
// binds the source amount.
const svmReserveSourceAmountVersion = 5

// solanaReserveMembers is every member the Solana reserve record may carry.
var solanaReserveMembers = []string{"deposit_hash", "recipient", "quote_hash", "source_amount"}

var maxUint64 = new(big.Int).SetUint64(^uint64(0))

// verifySolanaReserveAuth is VerifyReserveAuth on Solana: the reserve hash is rebuilt from the
// expectations with the escrow's signature domain, message must be it, and the reserver's ed25519
// signature must verify over it. Solana has no contract accounts, so no chain is read.
func verifySolanaReserveAuth(auth ReserveAuth, expected ReserveAuthExpectations) ReserveAuthResult {
	if parts := strings.Split(expected.Network, ":"); len(parts) != 2 || parts[1] == "" {
		return reserveVerdict(PathNone, ReserveReasonUnsupportedChain, "the network is not a known solana chain")
	}
	misconfigured := func(detail string) ReserveAuthResult {
		return reserveVerdict(PathNone, ReserveReasonVerifierMisconfigured, detail)
	}
	if expected.SvmSignatureDomainVersion == nil {
		return misconfigured("the Solana escrow domain (program id, cluster, domain version) was not supplied")
	}
	domain, detail := solanaEscrowDomain(SolanaDomain{
		EscrowProgramID: expected.EscrowContract,
		ClusterID:       expected.SvmSignatureClusterID,
		DomainVersion:   *expected.SvmSignatureDomainVersion,
		MessageScheme:   expected.SvmMessageScheme,
	})
	if detail != "" {
		return misconfigured(detail)
	}
	if domain.SignatureDomainVersion < svmReserveSourceAmountVersion {
		return misconfigured("the Solana escrow signature domain version must be 5 or later to bind the source amount")
	}
	depositHash, ok := readExpectedHash(expected.DepositID)
	if !ok {
		return misconfigured("the expected depositId is not a non-zero 0x-prefixed 32-byte hex value")
	}
	quoteHash, ok := readExpectedHash(expected.QuoteHash)
	if !ok {
		return misconfigured("the expected quoteHash is not a non-zero 0x-prefixed 32-byte hex value")
	}
	settler, ok := readSolanaKey(expected.Settler)
	if !ok {
		return misconfigured("the expected settler is not a non-zero base58 32-byte public key")
	}
	reserver, ok := readSolanaKey(expected.Reserver)
	if !ok {
		return misconfigured("the expected reserver is not a non-zero base58 32-byte public key")
	}
	if !positiveUintPattern.MatchString(expected.SourceAmount) {
		return misconfigured("the expected sourceAmount is not a positive decimal integer string")
	}
	amount, _ := new(big.Int).SetString(expected.SourceAmount, 10)
	if amount.Cmp(maxUint64) > 0 {
		return misconfigured("the expected sourceAmount exceeds u64")
	}

	if !digestPattern.MatchString(auth.Message) {
		return reserveVerdict(PathNone, ReserveReasonMalformed, "the message is not a 0x-prefixed 32-byte hex digest")
	}
	if !hexBytesPattern.MatchString(auth.Signature) {
		return reserveVerdict(PathNone, ReserveReasonMalformed, "the signature is not 0x-prefixed hex")
	}
	if len(auth.Signature) > maxDepositorSignatureLength {
		return reserveVerdict(PathNone, ReserveReasonMalformed, "the signature is longer than 65536 characters")
	}
	if reason, detail := matchSolanaReservePrehash(auth.MessagePrehash, expected, depositHash, quoteHash, settler); reason != "" {
		return reserveVerdict(PathNone, reason, detail)
	}

	digest, err := svm.ComputeReserveHashV3(svm.EscrowReserveParams{DepositHash: depositHash, Recipient: settler},
		quoteHash, amount.Uint64(), domain)
	if err != nil {
		return misconfigured("the reserve digest cannot be built: " + err.Error())
	}
	if !strings.EqualFold(auth.Message[2:], hex.EncodeToString(digest[:])) {
		return reserveVerdict(PathNone, ReserveReasonMessageMismatch, "the message is not the digest of the expected reserve witness")
	}
	if !ed25519SigPattern.MatchString(auth.Signature) {
		return reserveVerdict(PathEOA, ReserveReasonSignerMismatch, "the signature is not a 64-byte hex ed25519 signature")
	}
	signature, _ := hex.DecodeString(auth.Signature[2:])
	if _, _, ok := svm.MatchEscrowWitness(svm.MessageScheme(expected.SvmMessageScheme), svm.WitnessReserve, digest, reserver[:], signature); !ok {
		return reserveVerdict(PathEOA, ReserveReasonSignerMismatch, "the ed25519 signature does not verify against the reserver")
	}
	return reserveVerdict(PathEOA, ReserveReasonVerified, "the signature verifies against the reserver")
}

// readSolanaKey reads a base58 32-byte public key other than the zero key.
func readSolanaKey(s string) (svm.Pubkey, bool) {
	if !base58Pattern.MatchString(s) {
		return svm.Pubkey{}, false
	}
	raw, err := base58.Decode(s)
	if err != nil || len(raw) != 32 {
		return svm.Pubkey{}, false
	}
	key := svm.Pubkey(raw)
	return key, !key.IsZero()
}

// matchSolanaReservePrehash compares the reserve record with the expectations, or returns why it
// differs. The record is required: the settler builds the reserve instruction from its quote_hash
// and source_amount.
func matchSolanaReservePrehash(prehash string, expected ReserveAuthExpectations, depositHash, quoteHash [32]byte, settler svm.Pubkey) (ReserveAuthReason, string) {
	if isJSONBlank(prehash) {
		return ReserveReasonMalformed, "message_prehash is required on this chain"
	}
	if len(prehash) > maxReservePrehashLength {
		return ReserveReasonMalformed, "message_prehash is longer than 4096 bytes"
	}
	root, outcome, detail := readPrehash(&prehash)
	if outcome != "" {
		return ReserveReasonMalformed, detail
	}
	if memberSpelledTwice(root) {
		return ReserveReasonMalformed, "message_prehash spells one member two ways"
	}
	for name := range root {
		if !slices.Contains(solanaReserveMembers, name) {
			return ReserveReasonMalformed, "message_prehash carries a member the reserve record does not define"
		}
	}
	if v, ok := root["deposit_hash"].(string); !ok || !sameHash(v, depositHash) {
		return ReserveReasonDepositIDMismatch, "deposit_hash is not the expected depositId"
	}
	if v, ok := root["recipient"].(string); !ok || v != settler.String() {
		return ReserveReasonSettlerMismatch, "recipient is not the expected settler"
	}
	if v, ok := root["quote_hash"].(string); !ok || !sameHash(v, quoteHash) {
		return ReserveReasonQuoteHashMismatch, "quote_hash is not the expected quoteHash"
	}
	if v, ok := root["source_amount"].(string); !ok || v != expected.SourceAmount {
		return ReserveReasonSourceAmountMismatch, "source_amount is not the expected sourceAmount"
	}
	return "", ""
}
