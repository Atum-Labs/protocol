package senderauth

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"

	tvmencoding "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/tvm/bindings/go/escrow-encoding/encoding"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// Permit2 authorises a deposit by checking the depositor's signature on chain, with one rule
// (SignatureVerification.verify, identical in the Tron port): an account with no code must have
// signed the digest with its own key, and an account with code must answer isValidSignature
// (ERC-1271) with the magic value. The functions in this file are that rule evaluated off chain,
// identical in Go and TypeScript. Mirrors depositor-signature.ts.
//
// RecoverSigner is not this rule: it refuses every contract account, requires low-s, accepts a
// recovery id of 0 or 1 that Permit2 refuses, and refuses the 64-byte form Permit2 accepts. It is
// unchanged, and VerifyDepositorSignature is the check to use where the question is "will Permit2
// accept this signature".
//
// The key check runs first and reads nothing, so an account whose key signed costs no chain read.
// That differs from Permit2 in one case: an EIP-7702 account that signs with its own key is admitted
// here, while Permit2 sends it to its delegate's isValidSignature. A delegate that refuses makes the
// deposit revert on chain, which is a failed deposit and not a loss of funds.

// SignaturePath is the Permit2 branch a verdict was reached on.
type SignaturePath string

const (
	// PathEOA: the account has no code, or its key signed; Permit2 recovers the signer.
	PathEOA SignaturePath = "eoa"
	// PathContract: the account has code; Permit2 asks its isValidSignature.
	PathContract SignaturePath = "contract"
	// PathNone: no branch was reached, because the input was refused or the code could not be read.
	PathNone SignaturePath = "none"
)

// SignatureReason is why a depositor signature was, or was not, found valid. Only ReasonVerified is
// valid. ReasonSignerMismatch and ReasonContractSignatureRejected are refusals Permit2 makes too, and
// ReasonMalformed is a refusal as well; ReasonSignatureUnverifiable says the chain could not be read
// and nothing about the signature.
type SignatureReason string

const (
	// ReasonVerified: the account's key signed, or its isValidSignature returned the magic value.
	ReasonVerified SignatureReason = "verified"
	// ReasonSignerMismatch: the account has no code and its key did not sign the digest.
	ReasonSignerMismatch SignatureReason = "signer_mismatch"
	// ReasonContractSignatureRejected: the account has code, and its isValidSignature reverted or
	// returned anything but the magic value.
	ReasonContractSignatureRejected SignatureReason = "contract_signature_rejected"
	// ReasonSignatureUnverifiable: a chain read the rule needs failed. Not a refusal.
	ReasonSignatureUnverifiable SignatureReason = "signature_unverifiable"
	// ReasonUnsupportedChain: the network is not an eip155 or tron chain, or no Permit2 is known for it.
	ReasonUnsupportedChain SignatureReason = "unsupported_chain"
	// ReasonMalformed: the account, digest or signature cannot be read, or the signature is longer
	// than maxDepositorSignatureLength. A refusal: the value breaks the payment request's spelling or
	// the length bound, and is the submitter's alone, so admitting it would let a respelled or padded
	// signature skip the check.
	ReasonMalformed SignatureReason = "malformed"
)

// DepositorSignature is one depositor signature to check the way Permit2 will. Field names and JSON
// tags match the TS `DepositorSignature`.
type DepositorSignature struct {
	// Network is the CAIP-2 source chain: eip155:<id> or tron:<cluster>.
	Network string `json:"network"`
	// Account is the depositor, the permit owner Permit2 checks the signature for (on Tron, base58
	// or hex).
	Account string `json:"account"`
	// Digest is the 0x-hex 32-byte digest the depositor signed: signed_messages[i].message.
	Digest string `json:"digest"`
	// Signature is the 0x-hex signature, of any length up to maxDepositorSignatureLength. A contract
	// account's signature is opaque: a multi-owner Safe's is 65 bytes per owner, and one approved on
	// chain is empty.
	Signature string `json:"signature"`
	// Permit2Contract is the Permit2 the escrow uses on Network, and so the msg.sender of the
	// isValidSignature call. It comes from the verifier's own configuration, never from the payment.
	// Empty means the canonical EVM address, or the pinned Tron one.
	Permit2Contract string `json:"permit2Contract,omitempty"`
}

// DepositorSignatureResult is the verdict. It is returned for every input, so admissions and
// refusals can be logged and counted alike.
type DepositorSignatureResult struct {
	Valid  bool            `json:"valid"`
	Path   SignaturePath   `json:"path"`
	Reason SignatureReason `json:"reason"`
	// Detail says what was found, for logs. It is the same text in both languages, but Reason is the
	// value to branch on.
	Detail string `json:"detail"`
}

// ContractSignatureAnswer is what an isValidSignature call returned: its return data, or a revert.
type ContractSignatureAnswer struct {
	// Reverted reports that the call reverted. A revert is the contract's answer (a Safe reverts on
	// a signature it does not accept), not a failure to ask.
	Reverted bool
	// ReturnData is the call's return data when it did not revert.
	ReturnData []byte
}

// DepositorSignatureChecker reads the two chain facts Permit2 branches on. Accounts reach it as
// 0x-prefixed lowercase 20-byte hex, on Tron too (prefix 0x41 for the 21-byte form), and network is
// the input's CAIP-2 id. An error from either method means the chain could not be read, and is
// reported as ReasonSignatureUnverifiable, never as a refusal.
type DepositorSignatureChecker interface {
	// HasCode reports whether account has code at the latest block. It is Permit2's
	// code.length != 0, so an EIP-7702 delegation designator (0xef0100 || delegate) is code.
	HasCode(ctx context.Context, network, account string) (bool, error)
	// IsValidSignatureFrom calls account.isValidSignature(digest, signature) at the latest block,
	// as a static call the way the chain makes it, with msg.sender set to caller, the contract that
	// asks on chain: the chain's Permit2 for a deposit, the escrow for a reserve (VerifyReserveAuth).
	// A contract may answer only the callers it trusts, as a module account that trusts only Permit2
	// does. A revert must come back as ContractSignatureAnswer.Reverted, not as an error. The answer
	// depends on contract state (a paused module, an invalidated digest, a rotated owner), so it must
	// never be cached.
	IsValidSignatureFrom(ctx context.Context, network, account string, digest [32]byte, signature []byte, caller string) (ContractSignatureAnswer, error)
}

// maxDepositorSignatureLength is the longest signature accepted, in characters with the 0x: 32767
// bytes, room for about 500 Safe owners. It equals the veri-fill signature-validity route's
// maxLength, so the library and the route refuse the same values. Mirrors the TS
// MAX_SIGNATURE_LENGTH.
const maxDepositorSignatureLength = 65536

var (
	hexBytesPattern = regexp.MustCompile(`^0x(?:[0-9a-fA-F]{2})*$`)
	// erc1271MagicWord is the only return data Permit2 accepts: isValidSignature's own selector,
	// 0x1626ba7e, as an ABI-encoded bytes4. Anything shorter, or with a non-zero pad, fails the decode.
	erc1271MagicWord = common.RightPadBytes([]byte{0x16, 0x26, 0xba, 0x7e}, 32)
)

// RecoverPermit2EOA recovers the signer of a 0x-hex 32-byte digest exactly as Permit2 does for an
// account with no code. The signature is 65 bytes, r || s || v with v 27 or 28, or 64 bytes in the
// EIP-2098 form r || vs. A high-s signature is accepted, because Permit2 accepts it. A recovery id of
// 0 or 1 is refused, because Permit2 passes v to ecrecover unchanged and gets the zero address.
// Returns the signer's EIP-55 address; on Tron it is the 20-byte body. A failure wraps
// ErrRecoveryFailed. Mirrors the TS `recoverPermit2EOA`.
func RecoverPermit2EOA(message, signature string) (string, error) {
	signer, err := recoverPermit2EOA(message, signature)
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrRecoveryFailed, err)
	}
	return signer.Hex(), nil
}

func recoverPermit2EOA(message, signature string) (common.Address, error) {
	if !digestPattern.MatchString(message) {
		return common.Address{}, errors.New("the message is not a 0x-prefixed 32-byte hex digest")
	}
	if !hexBytesPattern.MatchString(signature) {
		return common.Address{}, errors.New("the signature is not 0x-prefixed hex")
	}
	digest, _ := hex.DecodeString(message[2:])
	raw, _ := hex.DecodeString(signature[2:])
	var (
		r, s *big.Int
		v    byte
	)
	switch len(raw) {
	case 65:
		r, s, v = new(big.Int).SetBytes(raw[:32]), new(big.Int).SetBytes(raw[32:64]), raw[64]
	case 64:
		// EIP-2098: the top bit of the second word is the y parity and the rest is s.
		vs := bytes.Clone(raw[32:64])
		v = vs[0]>>7 + 27
		vs[0] &= 0x7f
		r, s = new(big.Int).SetBytes(raw[:32]), new(big.Int).SetBytes(vs)
	default:
		return common.Address{}, errors.New("the signature is neither 64 nor 65 bytes")
	}
	if v != 27 && v != 28 {
		return common.Address{}, errors.New("the signature recovery id is not 27 or 28")
	}
	// The ecrecover precompile's own range check. Not homestead: the precompile has no low-s rule.
	if !crypto.ValidateSignatureValues(v-27, r, s, false) {
		return common.Address{}, errors.New("the signature r or s is not in [1, n-1]")
	}
	sig := make([]byte, 65)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:64])
	sig[64] = v - 27
	pub, err := crypto.SigToPub(digest, sig)
	if err != nil {
		return common.Address{}, errors.New("the signature recovers no public key")
	}
	return crypto.PubkeyToAddress(*pub), nil
}

// VerifyDepositorSignature reports whether Permit2 would accept input.Signature as the account's
// signature over input.Digest, reading the chain through checker only when the account's key did
// not sign:
//
//  1. The signature recovers, by RecoverPermit2EOA, to the account: valid on the EOA path, with no
//     chain read.
//  2. Otherwise the account's code is read. No code: Permit2 would recover a different signer, or
//     none, and refuse (ReasonSignerMismatch).
//  3. Code, including an EIP-7702 designator: isValidSignature is called from the chain's Permit2.
//     The magic value is valid; any other return data, or a revert, is ReasonContractSignatureRejected.
//
// A read that fails is ReasonSignatureUnverifiable. The verdict is about the latest block, and the
// chain can change before the deposit lands, so Permit2 stays the authority and the verdict is never
// to be cached. A nil checker answers every read as unavailable, which gives the offline verdict:
// valid on the EOA path, otherwise unverifiable. Mirrors the TS `verifyDepositorSignature`.
func VerifyDepositorSignature(ctx context.Context, input DepositorSignature, checker DepositorSignatureChecker) DepositorSignatureResult {
	namespace := namespaceOf(input.Network)
	permit2, detail := depositorPermit2(namespace, input)
	if detail != "" {
		return depositorVerdict(PathNone, ReasonUnsupportedChain, detail)
	}
	account, ok := depositorAddress(namespace, input.Account)
	if !ok {
		return depositorVerdict(PathNone, ReasonMalformed, "the account is not an address on this chain")
	}
	if !digestPattern.MatchString(input.Digest) {
		return depositorVerdict(PathNone, ReasonMalformed, "the digest is not a 0x-prefixed 32-byte hex string")
	}
	if !hexBytesPattern.MatchString(input.Signature) {
		return depositorVerdict(PathNone, ReasonMalformed, "the signature is not 0x-prefixed hex")
	}
	if len(input.Signature) > maxDepositorSignatureLength {
		return depositorVerdict(PathNone, ReasonMalformed, "the signature is longer than 65536 characters")
	}

	signer, recoverErr := recoverPermit2EOA(input.Digest, input.Signature)
	if recoverErr == nil && strings.EqualFold(signer.Hex(), account) {
		return depositorVerdict(PathEOA, ReasonVerified, "the signature recovers to the account")
	}
	if checker == nil {
		checker = offlineChecker{}
	}
	hasCode, err := checker.HasCode(ctx, input.Network, account)
	if err != nil {
		return depositorVerdict(PathNone, ReasonSignatureUnverifiable, "the account's code could not be read: "+err.Error())
	}
	if !hasCode {
		if recoverErr != nil {
			return depositorVerdict(PathEOA, ReasonSignerMismatch, "no signer recovers from the signature ("+recoverErr.Error()+"), and the account has no code")
		}
		return depositorVerdict(PathEOA, ReasonSignerMismatch, "the signature recovers to "+signer.Hex()+", and the account has no code")
	}

	digest, _ := hex.DecodeString(input.Digest[2:])
	signature, _ := hex.DecodeString(input.Signature[2:])
	answer, err := checker.IsValidSignatureFrom(ctx, input.Network, account, [32]byte(digest), signature, permit2)
	if err != nil {
		return depositorVerdict(PathContract, ReasonSignatureUnverifiable, "isValidSignature could not be called: "+err.Error())
	}
	if answer.Reverted {
		return depositorVerdict(PathContract, ReasonContractSignatureRejected, "isValidSignature reverted")
	}
	// Permit2 decodes the return data as a bytes4: it reads the first word and ignores the rest.
	if len(answer.ReturnData) >= 32 && bytes.Equal(answer.ReturnData[:32], erc1271MagicWord) {
		return depositorVerdict(PathContract, ReasonVerified, "isValidSignature returned the ERC-1271 magic value")
	}
	head := answer.ReturnData[:min(len(answer.ReturnData), 32)]
	return depositorVerdict(PathContract, ReasonContractSignatureRejected, "isValidSignature returned 0x"+hex.EncodeToString(head)+", not the ERC-1271 magic value")
}

// depositorPermit2 resolves the chain's Permit2 in the checker's address form, or returns why the
// network is not one the rule can be evaluated on.
func depositorPermit2(namespace string, input DepositorSignature) (string, string) {
	switch namespace {
	case "eip155":
		if _, err := evmChainID(input.Network); err != nil {
			return "", "the network is not a valid eip155 chain"
		}
		permit2 := permit2ContractAddress
		if input.Permit2Contract != "" {
			permit2 = input.Permit2Contract
		}
		if address, ok := depositorAddress(namespace, permit2); ok {
			return address, ""
		}
		return "", "the Permit2 contract is not an address on this chain"
	case "tron":
		if parts := strings.Split(input.Network, ":"); len(parts) != 2 || parts[1] == "" {
			return "", "the network is not a valid tron chain"
		}
		permit2 := input.Permit2Contract
		if permit2 == "" {
			var err error
			if permit2, err = resolveTronPermit2(input.Network); err != nil {
				return "", "no Permit2 contract is known for this tron network"
			}
		}
		if address, ok := depositorAddress(namespace, permit2); ok {
			return address, ""
		}
		return "", "the Permit2 contract is not an address on this chain"
	default:
		return "", "the network is not an eip155 or tron chain"
	}
}

// depositorAddress reads an address in the checker's form: 0x-prefixed lowercase 20-byte hex, which
// on Tron is the body of the base58 or 41-prefixed hex address.
func depositorAddress(namespace, address string) (string, bool) {
	if namespace == "tron" {
		body, err := tvmencoding.NormalizeAddress(address)
		if err != nil {
			return "", false
		}
		return "0x" + body, true
	}
	if !hexAddressPattern.MatchString(address) {
		return "", false
	}
	return strings.ToLower(address), true
}

func depositorVerdict(path SignaturePath, reason SignatureReason, detail string) DepositorSignatureResult {
	return DepositorSignatureResult{Valid: reason == ReasonVerified, Path: path, Reason: reason, Detail: detail}
}

// offlineChecker is the nil checker: no chain can be read.
type offlineChecker struct{}

var errNoChainReader = errors.New("no chain reader was supplied")

func (offlineChecker) HasCode(context.Context, string, string) (bool, error) {
	return false, errNoChainReader
}

func (offlineChecker) IsValidSignatureFrom(context.Context, string, string, [32]byte, []byte, string) (ContractSignatureAnswer, error) {
	return ContractSignatureAnswer{}, errNoChainReader
}
