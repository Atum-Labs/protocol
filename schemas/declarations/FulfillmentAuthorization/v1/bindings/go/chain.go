package fulfillmentauthorization

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"

	"github.com/ethereum/go-ethereum/common"
)

// The signature on an EIP-3009 authorization is checked on chain by the token, through
// SignatureChecker.isValidSignatureNow, which a signer with no code answers by recovering a key and
// a signer with code answers by calling ERC-1271 isValidSignature and comparing the answer with the
// magic value, to a call whose msg.sender is the token. ValidateWithChain is that rule evaluated off
// chain, so a contract wallet's authorization is proved rather than left to the token. Mirrors the
// depositor side's senderauth.VerifyDepositorSignature and the TypeScript `signatureChecker` option.
//
// The tokens do not all order the two halves the same way, and this is where this proof can differ
// from a token for one kind of account: an EIP-7702 account (an EOA that delegated to code), which
// has code and may also sign with its own key.
//
//   - Code first. Circle's SignatureChecker (USDC's FiatTokenV2_2) tests isContract(signer) and
//     recovers a key only when there is no code, so a delegated account's own-key signature goes to
//     its delegate. ValidateWithChain reads the code first and always, and reaches that verdict.
//   - Key first. OpenZeppelin 4.9's SignatureChecker tries ECDSA recovery and calls ERC-1271 only
//     when that fails. PYUSD's two listed deployments use it, so a delegated settler whose own key
//     signed executes there even if its delegate would refuse the signature.
//
// For such an account on a key-first token ValidateWithChain returns ErrContractSignatureRejected
// where the token would accept. That is the safe direction, a refusal rather than a pass, and it is
// a divergence this binding does not close: it holds no per-token table, and which ordering a given
// deployed implementation has cannot be shown offline. USDT0's ArbitrumExtensionV2 and
// TetherTokenCeloExtension were not checked against either ordering. Every other account agrees
// with the token under both: an account with no code is a key check, and a contract that is not
// delegated has no key that signs for it.

// ErrContractSignatureRejected is wrapped by the error ValidateWithChain returns when the signer is
// a contract and its isValidSignature reverted or returned anything but the ERC-1271 magic value.
// It says the contract answered no, at the block that was asked. It does not say the token would
// refuse: a token whose SignatureChecker tries the key first accepts an EIP-7702 account whose own
// key signed, whatever its delegate answers, and an answer can change with contract state.
var ErrContractSignatureRejected = errors.New("contract signature rejected")

// ErrSignatureUnverifiable is wrapped by the error ValidateWithChain returns when a chain read the
// rule needs failed. It is a REFUSAL, not a pass, and not a signal to fall back to anything.
//
// Treat it as a refusal wherever a pass gates something (releasing funds, publishing an
// authorization, accepting a document from a counterparty). The only thing it licenses is a retry.
// Do not read "unverifiable" as "the token decides": that is AllowContractSignature's semantics,
// which accepts a signature nobody proved, and a settler can steer into it. The reader reports a
// failed isValidSignature call that is not a revert as an error, for example one that runs out of
// gas or hits an invalid opcode (atum-core's evmclient.IsValidSignatureAs does, deliberately, since
// the node's failure is indistinguishable from the contract's), so a wallet whose isValidSignature
// does that makes every proof of its authorizations unverifiable. It is never returned for a
// document that is wrong offline.
var ErrSignatureUnverifiable = errors.New("signature unverifiable: the chain could not be read")

// ContractSignatureAnswer is what an isValidSignature call returned: its return data, or a revert.
type ContractSignatureAnswer struct {
	// Reverted reports that the call reverted. A revert is the contract's answer (a Safe reverts on
	// a signature it does not accept), not a failure to ask.
	Reverted bool
	// ReturnData is the call's return data when it did not revert.
	ReturnData []byte
}

// SettlerSignatureChecker reads the two chain facts the token branches on. Accounts reach it as
// 0x-prefixed lowercase 20-byte hex and network is the CAIP-2 id (eip155:<chainId>) of the chain
// the authorization is for. An error from either method means the chain could not be read, and is
// reported as ErrSignatureUnverifiable, never as a refusal, and that is a refusal for the caller.
//
// A reader must return an error for a network it does not serve, rather than answer from another
// chain: this package passes the document's network, and an account has different code, or none,
// on a different chain.
//
// block is the block to read at, or nil for the latest. It is the same value for both methods of
// one proof (see AtBlock), so a caller that needs the code and the call to describe one state, or
// to ask about the block a transfer executed in, passes one. A reader must treat it as read-only.
//
// It has the shape of senderauth.DepositorSignatureChecker, so one chain reader can serve both;
// only the answer type is this package's own, to keep this module free of the sender-auth one.
type SettlerSignatureChecker interface {
	// HasCode reports whether account has code at block: the token's isContract(signer). An EIP-7702
	// delegation designator (0xef0100 || delegate) is code.
	HasCode(ctx context.Context, network, account string, block *big.Int) (bool, error)
	// IsValidSignatureFrom calls account.isValidSignature(digest, signature) at block with msg.sender
	// set to caller, which is the token: a contract may answer only the callers it trusts. A revert
	// must come back as ContractSignatureAnswer.Reverted, not as an error. The answer depends on
	// contract state (a rotated owner, an invalidated digest), so it must never be cached.
	IsValidSignatureFrom(ctx context.Context, network, account string, digest [32]byte, signature []byte, caller string, block *big.Int) (ContractSignatureAnswer, error)
}

// ValidateWithChain is Validate, plus a proof of the settler's signature that Validate cannot make
// because it is pure: the signer's code is read through checker, and a signer with code must
// answer ERC-1271 with the magic value, as the token will ask it on chain.
//
// Everything Validate checks is checked first, in the same order, and the chain is read only after
// every offline rule has passed, so a document that is wrong costs no chain read. A pass means the
// settler's key signed (no code) or its contract vouched for the signature (code), at the latest
// block. It is not a promise about the block the transfer lands in: the answer depends on contract
// state, so keep the token as the authority and never cache a verdict.
//
// A refusal wraps ErrContractSignatureRejected only when the contract answered; a chain that could
// not be read wraps ErrSignatureUnverifiable, so the two are told apart with errors.Is. BOTH ARE
// REFUSALS. ErrSignatureUnverifiable permits a retry and nothing else: do not fall back to the
// token as the authority, which is AllowContractSignature's semantics and accepts a signature
// nobody proved. A settler can make its own authorizations unverifiable (a wallet whose
// isValidSignature runs out of gas or hits an invalid opcode is an error to a reader that cannot
// tell it from a node fault), so wherever a pass gates anything, an unverifiable result must gate
// it shut. A nil checker is Validate.
//
// By default both chain reads are at the latest block, and they are two reads, so they can land on
// different blocks. Pass AtBlock to read both at one block, for example the block a transfer
// executed in.
//
// For an EIP-7702 account the verdict follows the code-first ordering of USDC's SignatureChecker,
// and can be a refusal where a key-first token (PYUSD) would execute; see the comment above.
//
// This is a second entry point and Validate keeps its signature, so no existing caller changes.
// AllowContractSignature has no effect here: the signature is proved, not allowed.
//
// What this does not prove: that the token accepts the signature. The token still checks the
// nonce, the balance, the validity window and its own domain name and version, and a 64-byte
// EIP-2098 signature from an account with no code, which FiatTokenV2_2 accepts, is refused here
// because only the 65-byte form is.
func ValidateWithChain(ctx context.Context, jsonData []byte, checker SettlerSignatureChecker, opts ...Option) error {
	resolved := newOptions(opts)
	if checker != nil {
		resolved.chain = &chainAccess{ctx: ctx, checker: checker, block: resolved.block}
	}
	return validateWith(jsonData, resolved)
}

type chainAccess struct {
	ctx     context.Context
	checker SettlerSignatureChecker
	block   *big.Int
}

// maxContractSignatureLength bounds what is handed to an eth_call: in characters with the 0x,
// 32767 bytes, as the depositor side bounds it, so one reader refuses the same values for both.
const maxContractSignatureLength = 65536

var signatureHexPattern = regexp.MustCompile(`^0x(?:[0-9a-fA-F]{2})*$`)

// requireSignatureHex is the offline check a signature gets before the chain is read: hex, and
// bounded. Whether it is empty is the chain's business, since a wallet that approved the digest on
// chain answers for an empty one.
func requireSignatureHex(signature string) error {
	if !signatureHexPattern.MatchString(signature) {
		return fmt.Errorf("authorization.signature must be 0x-prefixed hex of whole bytes")
	}
	if len(signature) > maxContractSignatureLength {
		return fmt.Errorf("authorization.signature is longer than %d characters", maxContractSignatureLength)
	}
	return nil
}

// erc1271MagicWord is the only return data the token accepts: isValidSignature's own selector,
// 0x1626ba7e, as a left-aligned bytes32.
var erc1271MagicWord = common.RightPadBytes([]byte{0x16, 0x26, 0xba, 0x7e}, 32)

func (c *chainAccess) verify(from string, chainID *big.Int, token string, digest []byte, signature string) error {
	network := "eip155:" + chainID.String()
	account := strings.ToLower(from)
	hasCode, err := c.checker.HasCode(c.ctx, network, account, c.block)
	if err != nil {
		return fmt.Errorf("%w: the signer's code could not be read: %v", ErrSignatureUnverifiable, err)
	}
	if !hasCode {
		// No code: the token recovers a key, so the rule is the offline one. A signature that is
		// not 65 bytes cannot be one.
		if !isEOASignature(signature) {
			return fmt.Errorf("authorization.signature must be 65 bytes, got %d: the signer %s has no code on %s, so only its key can sign", len(common.FromHex(signature)), from, network)
		}
		return requireEOASigner(digest, signature, from)
	}
	answer, err := c.checker.IsValidSignatureFrom(c.ctx, network, account, [32]byte(digest), common.FromHex(signature), strings.ToLower(token), c.block)
	if err != nil {
		return fmt.Errorf("%w: isValidSignature could not be called on %s: %v", ErrSignatureUnverifiable, from, err)
	}
	if answer.Reverted {
		return fmt.Errorf("%w: isValidSignature on %s reverted", ErrContractSignatureRejected, from)
	}
	if len(answer.ReturnData) >= 32 && bytes.Equal(answer.ReturnData[:32], erc1271MagicWord) {
		return nil
	}
	head := answer.ReturnData[:min(len(answer.ReturnData), 32)]
	return fmt.Errorf("%w: isValidSignature on %s returned 0x%x, not the ERC-1271 magic value", ErrContractSignatureRejected, from, head)
}
