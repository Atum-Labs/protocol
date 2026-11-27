package senderauth

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"math/big"
	"reflect"
	"slices"
	"strconv"
	"strings"

	evmencoding "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/evm/bindings/go/escrow-encoding/encoding"
	tvmencoding "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/tvm/bindings/go/escrow-encoding/encoding"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// A deposit that pays a chosen quote carries two signatures: the depositor's Permit2 deposit, which
// names a reserver in its witness, and that reserver's signature over the escrow's reserve witness
// {depositId, quoteHash, settler, sourceAmount}, which names the quote's settler and amount. The
// escrow checks the reserve signature on chain with OpenZeppelin's SignatureChecker: a reserver with
// no code must have signed with its own key (65 bytes, low-s), and a reserver with code must answer
// isValidSignature (ERC-1271), called from the escrow, with the magic value. On Solana the program
// requires the reserver's ed25519 signature over its reserve hash, which binds the same four values.
// VerifyReserveAuth is that check evaluated off chain, identical in Go and TypeScript. Mirrors
// reserve-auth.ts.
//
// The digest is rebuilt from the verifier's own expected values, never from message_prehash: the
// prehash is only compared with them, member by member, so a refusal names the member that differs.
//
// As in VerifyDepositorSignature, the key check runs first and reads nothing. An EIP-7702 account
// that signs with its own key is admitted here, while the escrow sends it to its delegate's
// isValidSignature; a delegate that refuses makes the deposit revert, which is a failed deposit and
// not a loss of funds.

// ReserveAuth is the reserver's signed reserve witness.
type ReserveAuth struct {
	// Message is the 0x-hex 32-byte digest the reserver signed.
	Message string `json:"message"`
	// MessagePrehash is required; without it the result is malformed. On EVM and Tron it is the
	// reserve witness as typed data JSON; on Solana it is the reserve record {deposit_hash,
	// recipient, quote_hash, source_amount}.
	MessagePrehash string `json:"message_prehash,omitempty"`
	// Signature is the 0x-hex signature, up to 65536 characters with the 0x.
	Signature string `json:"signature"`
}

// ReserveAuthExpectations is what the verifier knows the reserve must say. Every value comes from the
// verifier's own records, never from the reserve_auth being checked.
type ReserveAuthExpectations struct {
	// Network is the CAIP-2 source chain: eip155:<id>, tron:<cluster> or solana:<cluster>.
	Network string `json:"network"`
	// EscrowContract is the source chain's escrow: the EIP-712 verifying contract and the
	// msg.sender of the isValidSignature call, or on Solana the escrow program id.
	EscrowContract string `json:"escrowContract"`
	// DepositID is the payment's deposit id, 0x-hex 32 bytes.
	DepositID string `json:"depositId"`
	// QuoteHash is the chosen quote's hash, 0x-hex 32 bytes.
	QuoteHash string `json:"quoteHash"`
	// Settler is the chosen quote's settler on the source chain.
	Settler string `json:"settler"`
	// SourceAmount is the chosen quote's source amount, a decimal string above zero.
	SourceAmount string `json:"sourceAmount"`
	// Reserver is the reserver the verified deposit witness names, and so the required signer.
	Reserver string `json:"reserver"`
	// TronChainIDs supplies TIP-712 chain ids by Tron cluster for networks TronChainIDs does not
	// know, such as a local node's, as WithTronChainIDs does for the commitment check.
	TronChainIDs map[string]int64 `json:"tronChainIds,omitempty"`
	// SvmSignatureClusterID and SvmSignatureDomainVersion are the Solana escrow's signature domain,
	// required on Solana. The reserve hash binds the source amount from domain version 5.
	SvmSignatureClusterID     string `json:"svmSignatureClusterId,omitempty"`
	SvmSignatureDomainVersion *int   `json:"svmSignatureDomainVersion,omitempty"`
}

// ReserveAuthReason is why a reserve_auth was, or was not, found valid. Only
// ReserveReasonVerified is valid. ReserveReasonSignatureUnverifiable says a chain read failed and
// nothing about the signature; ReserveReasonVerifierMisconfigured and ReserveReasonUnsupportedChain
// are about the expectations, not the reserve_auth; every other reason is a refusal of it.
type ReserveAuthReason string

const (
	ReserveReasonVerified                  ReserveAuthReason = "verified"
	ReserveReasonUnsupportedChain          ReserveAuthReason = "unsupported_chain"
	ReserveReasonVerifierMisconfigured     ReserveAuthReason = "verifier_misconfigured"
	ReserveReasonMalformed                 ReserveAuthReason = "malformed"
	ReserveReasonDomainMismatch            ReserveAuthReason = "domain_mismatch"
	ReserveReasonDepositIDMismatch         ReserveAuthReason = "deposit_id_mismatch"
	ReserveReasonQuoteHashMismatch         ReserveAuthReason = "quote_hash_mismatch"
	ReserveReasonSettlerMismatch           ReserveAuthReason = "settler_mismatch"
	ReserveReasonSourceAmountMismatch      ReserveAuthReason = "source_amount_mismatch"
	ReserveReasonMessageMismatch           ReserveAuthReason = "message_mismatch"
	ReserveReasonSignerMismatch            ReserveAuthReason = "signer_mismatch"
	ReserveReasonContractSignatureRejected ReserveAuthReason = "contract_signature_rejected"
	ReserveReasonSignatureUnverifiable     ReserveAuthReason = "signature_unverifiable"
)

// ReserveAuthResult is the verdict. It is returned for every input, so admissions and refusals can
// be logged and counted alike.
type ReserveAuthResult struct {
	Valid  bool              `json:"valid"`
	Path   SignaturePath     `json:"path"`
	Reason ReserveAuthReason `json:"reason"`
	// Detail says what was found, for logs. It is the same text in both languages, but Reason is the
	// value to branch on.
	Detail string `json:"detail"`
}

// maxReservePrehashLength bounds message_prehash, in UTF-8 bytes: the reserve typed data is under
// 1 KiB.
const maxReservePrehashLength = 4096

// reserveWitnessMembers is every member the reserve typed data may carry, per object. Anything else
// is refused: no reader needs it, and an unread member is room for a second meaning. domain.salt is
// allowed only empty, as go-ethereum's TypedDataDomain always writes it.
var reserveWitnessMembers = []struct {
	path    []string
	allowed []string
}{
	{nil, []string{"types", "primaryType", "domain", "message"}},
	{[]string{"domain"}, []string{"name", "version", "chainId", "verifyingContract", "salt"}},
	{[]string{"message"}, []string{"depositId", "quoteHash", "settler", "sourceAmount"}},
}

// VerifyReserveAuth reports whether the escrow would accept auth as the expected reserver's
// signature over the expected reserve witness, reading the chain through checker only when the
// reserver's key did not sign:
//
//  1. The expectations are read; one the escrow could never accept is verifier_misconfigured.
//  2. message_prehash must be the reserve typed data for this escrow and chain, naming the expected
//     depositId, quoteHash, settler and sourceAmount; the first member that differs is its own
//     reason.
//  3. message must be the digest rebuilt from the expectations.
//  4. The signature recovers, by OpenZeppelin's ECDSA rule, to the reserver: valid, no chain read.
//  5. Otherwise the reserver's code is read. No code: signer_mismatch. Code: isValidSignature is
//     called from the escrow; the magic value is valid, anything else contract_signature_rejected.
//
// A read that fails is signature_unverifiable. A nil checker answers every read as unavailable. The
// verdict is about the latest block and must never be cached. Mirrors the TS `verifyReserveAuth`.
func VerifyReserveAuth(ctx context.Context, auth ReserveAuth, expected ReserveAuthExpectations, checker DepositorSignatureChecker) ReserveAuthResult {
	namespace := namespaceOf(expected.Network)
	if namespace == "solana" {
		return verifySolanaReserveAuth(auth, expected)
	}
	if namespace != "eip155" && namespace != "tron" {
		return reserveVerdict(PathNone, ReserveReasonUnsupportedChain, "the network is not an eip155, tron or solana chain")
	}
	w, reason, detail := readReserveExpectations(namespace, expected)
	if reason != "" {
		return reserveVerdict(PathNone, reason, detail)
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
	if reason, detail := w.matchPrehash(auth.MessagePrehash); reason != "" {
		return reserveVerdict(PathNone, reason, detail)
	}

	digest, err := w.digest()
	if err != nil {
		return reserveVerdict(PathNone, ReserveReasonVerifierMisconfigured, "the reserve digest cannot be built: "+err.Error())
	}
	if !strings.EqualFold(auth.Message[2:], hex.EncodeToString(digest)) {
		return reserveVerdict(PathNone, ReserveReasonMessageMismatch, "the message is not the digest of the expected reserve witness")
	}

	signer, recoverErr := recoverReserveEOA(digest, auth.Signature)
	if recoverErr == nil && strings.EqualFold(signer.Hex(), w.reserver) {
		return reserveVerdict(PathEOA, ReserveReasonVerified, "the signature recovers to the reserver")
	}
	if checker == nil {
		checker = offlineChecker{}
	}
	hasCode, err := checker.HasCode(ctx, expected.Network, w.reserver)
	if err != nil {
		return reserveVerdict(PathNone, ReserveReasonSignatureUnverifiable, "the reserver's code could not be read: "+err.Error())
	}
	if !hasCode {
		if recoverErr != nil {
			return reserveVerdict(PathEOA, ReserveReasonSignerMismatch, "no signer recovers from the signature ("+recoverErr.Error()+"), and the reserver has no code")
		}
		return reserveVerdict(PathEOA, ReserveReasonSignerMismatch, "the signature recovers to "+signer.Hex()+", and the reserver has no code")
	}
	signature, _ := hex.DecodeString(auth.Signature[2:])
	answer, err := checker.IsValidSignatureFrom(ctx, expected.Network, w.reserver, [32]byte(digest), signature, w.escrow)
	if err != nil {
		return reserveVerdict(PathContract, ReserveReasonSignatureUnverifiable, "isValidSignature could not be called: "+err.Error())
	}
	if answer.Reverted {
		return reserveVerdict(PathContract, ReserveReasonContractSignatureRejected, "isValidSignature reverted")
	}
	// SignatureChecker decodes the return data as a bytes32: it reads the first word.
	if len(answer.ReturnData) >= 32 && bytes.Equal(answer.ReturnData[:32], erc1271MagicWord) {
		return reserveVerdict(PathContract, ReserveReasonVerified, "isValidSignature returned the ERC-1271 magic value")
	}
	head := answer.ReturnData[:min(len(answer.ReturnData), 32)]
	return reserveVerdict(PathContract, ReserveReasonContractSignatureRejected, "isValidSignature returned 0x"+hex.EncodeToString(head)+", not the ERC-1271 magic value")
}

// reserveWitness is the expected reserve, read: addresses in the checker's form (0x-prefixed
// lowercase 20-byte hex, on Tron too).
type reserveWitness struct {
	namespace          string
	chainID            int64
	escrow, settler    string
	reserver           string
	depositID, quote   [32]byte
	sourceAmount       *big.Int
	sourceAmountString string
}

func readReserveExpectations(namespace string, expected ReserveAuthExpectations) (reserveWitness, ReserveAuthReason, string) {
	w := reserveWitness{namespace: namespace}
	var err error
	if namespace == "eip155" {
		w.chainID, err = evmChainID(expected.Network)
	} else {
		w.chainID, err = tronNumericChainID(expected.Network, expected.TronChainIDs)
	}
	var misconfiguredTron *tronChainIDError
	if errors.As(err, &misconfiguredTron) {
		return w, ReserveReasonVerifierMisconfigured, misconfiguredTron.detail
	}
	if err != nil {
		return w, ReserveReasonUnsupportedChain, "the network is not a known " + namespace + " chain"
	}
	misconfigured := func(detail string) (reserveWitness, ReserveAuthReason, string) {
		return w, ReserveReasonVerifierMisconfigured, detail
	}
	var ok bool
	if w.escrow, ok = depositorAddress(namespace, expected.EscrowContract); !ok {
		return misconfigured("the expected escrow is not an address on this chain")
	}
	if w.depositID, ok = readExpectedHash(expected.DepositID); !ok {
		return misconfigured("the expected depositId is not a non-zero 0x-prefixed 32-byte hex value")
	}
	if w.quote, ok = readExpectedHash(expected.QuoteHash); !ok {
		return misconfigured("the expected quoteHash is not a non-zero 0x-prefixed 32-byte hex value")
	}
	if w.settler, ok = depositorAddress(namespace, expected.Settler); !ok || w.settler == zeroAddressHex {
		return misconfigured("the expected settler is not a non-zero address on this chain")
	}
	if w.reserver, ok = depositorAddress(namespace, expected.Reserver); !ok || w.reserver == zeroAddressHex {
		return misconfigured("the expected reserver is not a non-zero address on this chain")
	}
	if !positiveUintPattern.MatchString(expected.SourceAmount) {
		return misconfigured("the expected sourceAmount is not a positive decimal integer string")
	}
	w.sourceAmount, _ = new(big.Int).SetString(expected.SourceAmount, 10)
	if w.sourceAmount.Cmp(maxUint256) > 0 {
		return misconfigured("the expected sourceAmount exceeds uint256")
	}
	w.sourceAmountString = expected.SourceAmount
	return w, "", ""
}

var (
	errReserveSignatureLength = errors.New("the signature is not 65 bytes")
	errReserveRecoveryID      = errors.New("the signature recovery id is not 27 or 28")
	errReserveSignatureValues = errors.New("the signature r is not in [1, n-1] or s is not in [1, n/2]")
	errReserveNoPublicKey     = errors.New("the signature recovers no public key")
)

const zeroAddressHex = "0x0000000000000000000000000000000000000000"

func readExpectedHash(s string) ([32]byte, bool) {
	if !digestPattern.MatchString(s) {
		return [32]byte{}, false
	}
	h, _ := parseHash32(s)
	return h, h != [32]byte{}
}

// matchPrehash compares message_prehash with the expected reserve, or returns why it differs.
func (w reserveWitness) matchPrehash(prehash string) (ReserveAuthReason, string) {
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
	for _, m := range reserveWitnessMembers {
		obj := root
		if m.path != nil {
			v, _, _ := memberAt(root, m.path...)
			var ok bool
			if obj, ok = v.(map[string]any); !ok {
				return ReserveReasonMalformed, strings.Join(m.path, ".") + " is not an object"
			}
		}
		for name := range obj {
			if !slices.Contains(m.allowed, name) {
				return ReserveReasonMalformed, pathName(m.path) + " carries a member the reserve typed data does not define"
			}
		}
	}
	if pt, _ := root["primaryType"].(string); pt != "ReserveWitness" {
		return ReserveReasonMalformed, "primaryType is not ReserveWitness"
	}
	if !sameMessageTypes(root["types"], w.typedData().Types) || !canonicalDomainType(root["types"]) {
		return ReserveReasonMalformed, "types are not the reserve witness types"
	}

	if name, _ := stringMember(root, "domain", "name"); name != "Escrow" {
		return ReserveReasonDomainMismatch, "domain.name is not Escrow"
	}
	if version, _ := stringMember(root, "domain", "version"); version != "3" {
		return ReserveReasonDomainMismatch, "domain.version is not 3"
	}
	id, ok := stringMember(root, "domain", "chainId")
	if !ok || !chainIDPattern.MatchString(id) {
		return ReserveReasonDomainMismatch, "domain.chainId is not 0x-prefixed hex without leading zeros"
	}
	if !strings.EqualFold(strings.TrimPrefix(id, "0x"), strconv.FormatInt(w.signedChainID(), 16)) {
		return ReserveReasonDomainMismatch, "domain.chainId is not this chain"
	}
	if contract, ok := stringMember(root, "domain", "verifyingContract"); !ok || !hexAddressPattern.MatchString(contract) ||
		!strings.EqualFold(contract, w.escrow) {
		return ReserveReasonDomainMismatch, "domain.verifyingContract is not the expected escrow"
	}
	if salt, present := root["domain"].(map[string]any)["salt"]; present && salt != "" {
		return ReserveReasonDomainMismatch, "domain.salt is not empty"
	}

	if v, ok := stringMember(root, "message", "depositId"); !ok || !sameHash(v, w.depositID) {
		return ReserveReasonDepositIDMismatch, "message.depositId is not the expected depositId"
	}
	if v, ok := stringMember(root, "message", "quoteHash"); !ok || !sameHash(v, w.quote) {
		return ReserveReasonQuoteHashMismatch, "message.quoteHash is not the expected quoteHash"
	}
	if v, ok := stringMember(root, "message", "settler"); !ok || !hexAddressPattern.MatchString(v) || !strings.EqualFold(v, w.settler) {
		return ReserveReasonSettlerMismatch, "message.settler is not the expected settler"
	}
	if v, ok := stringMember(root, "message", "sourceAmount"); !ok || v != w.sourceAmountString {
		return ReserveReasonSourceAmountMismatch, "message.sourceAmount is not the expected sourceAmount"
	}
	return "", ""
}

// canonicalDomainType reports whether types declares EIP712Domain, when it does, as the four
// members of the escrow's domain: the digest is rebuilt over that domain, so any other declaration
// would describe a domain the signature is not over.
func canonicalDomainType(types any) bool {
	declaredTypes, ok := types.(map[string]any)
	if !ok {
		return false
	}
	declared, present := declaredTypes["EIP712Domain"]
	if !present {
		return true
	}
	want := []any{}
	for _, member := range [][2]string{{"name", "string"}, {"version", "string"}, {"chainId", "uint256"}, {"verifyingContract", "address"}} {
		want = append(want, map[string]any{"name": member[0], "type": member[1]})
	}
	return reflect.DeepEqual(declared, want)
}

func sameHash(v string, want [32]byte) bool {
	return digestPattern.MatchString(v) && strings.EqualFold(v[2:], hex.EncodeToString(want[:]))
}

// signedChainID is the chain id the escrow's domain carries: TIP712 masks it to 32 bits on Tron.
func (w reserveWitness) signedChainID() int64 {
	if w.namespace == "tron" {
		return w.chainID & 0xffffffff
	}
	return w.chainID
}

func (w reserveWitness) typedData() apitypes.TypedData {
	args := w.encoderArgs()
	if w.namespace == "tron" {
		return tvmencoding.NewEscrowReserveEncoder().BuildTypedDataWithQuoteSource(args.escrow, args.depositID, args.quote, args.settler, args.amount, args.chainID)
	}
	return evmencoding.NewEscrowReserveEncoder().BuildTypedDataWithQuoteSource(args.escrow, args.depositID, args.quote, args.settler, args.amount, args.chainID)
}

func (w reserveWitness) digest() ([]byte, error) {
	args := w.encoderArgs()
	if w.namespace == "tron" {
		return tvmencoding.NewEscrowReserveEncoder().DigestWithQuoteSource(args.escrow, args.depositID, args.quote, args.settler, args.amount, args.chainID)
	}
	return evmencoding.NewEscrowReserveEncoder().DigestWithQuoteSource(args.escrow, args.depositID, args.quote, args.settler, args.amount, args.chainID)
}

type reserveEncoderArgs struct {
	escrow, settler  common.Address
	depositID, quote [32]byte
	amount, chainID  *big.Int
}

func (w reserveWitness) encoderArgs() reserveEncoderArgs {
	return reserveEncoderArgs{
		escrow:    common.HexToAddress(w.escrow),
		settler:   common.HexToAddress(w.settler),
		depositID: w.depositID,
		quote:     w.quote,
		amount:    new(big.Int).Set(w.sourceAmount),
		chainID:   big.NewInt(w.chainID),
	}
}

// recoverReserveEOA recovers the signer of digest as OpenZeppelin's ECDSA.tryRecover does: exactly
// 65 bytes r || s || v, v 27 or 28, r in [1, n-1] and s in [1, n/2]. Permit2's rule is looser (it
// takes high-s and the 64-byte form), so RecoverPermit2EOA is not this rule.
func recoverReserveEOA(digest []byte, signature string) (common.Address, error) {
	raw, _ := hex.DecodeString(signature[2:])
	if len(raw) != 65 {
		return common.Address{}, errReserveSignatureLength
	}
	r, s, v := new(big.Int).SetBytes(raw[:32]), new(big.Int).SetBytes(raw[32:64]), raw[64]
	if v != 27 && v != 28 {
		return common.Address{}, errReserveRecoveryID
	}
	if !crypto.ValidateSignatureValues(v-27, r, s, true) {
		return common.Address{}, errReserveSignatureValues
	}
	sig := slices.Clone(raw)
	sig[64] = v - 27
	pub, err := crypto.SigToPub(digest, sig)
	if err != nil {
		return common.Address{}, errReserveNoPublicKey
	}
	return crypto.PubkeyToAddress(*pub), nil
}

func reserveVerdict(path SignaturePath, reason ReserveAuthReason, detail string) ReserveAuthResult {
	return ReserveAuthResult{Valid: reason == ReserveReasonVerified, Path: path, Reason: reason, Detail: detail}
}
