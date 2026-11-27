package fulfillmentauthorization

import "math/big"

// options carries the caller's choices through the rules. The zero value is the strict default,
// so a caller that passes nothing gets a verdict that proves the settler signed.
type options struct {
	allowContractSignature bool
	// chain is set only by ValidateWithChain. It carries the context and the chain reader the
	// signer's signature is proved with.
	chain *chainAccess
	// block is the block ValidateWithChain reads at; nil is the latest.
	block *big.Int
}

// An Option changes what Validate accepts. There is one today, and it only ever widens.
type Option func(*options)

// AllowContractSignature accepts a signature that is not the 65-byte r‖s‖v form an EOA produces,
// on the token's authority rather than this validator's.
//
// Without it, a signature that is not 65 bytes is refused. That is the default because this
// validator cannot tell an EOA settler from a contract one — that needs an eth_call, and this
// function is pure — so the permissive branch is reachable for any settler, not only a contract
// wallet. A caller passing nothing therefore gets the stronger guarantee: a pass means the
// signature recovered to message.from.
//
// Pass this only when the settler genuinely may be a contract wallet. The authorization is then
// accepted with a byte-validity check and nothing more: no offline check can prove an ERC-1271
// signature, so a pass under this option does NOT show the settler authorised the transfer. Every
// token in the EIP-3009 list does accept contract signatures through
// SignatureChecker.isValidSignatureNow, so such an authorization is executable on chain; the
// question this option answers is who vouches for it, the token or this validator.
//
// Deprecated: ValidateWithChain proves a contract signature instead of leaving it to the token,
// which is the better answer wherever the caller can read the chain. This option stays for a
// caller that cannot, and for the callers that already compile against it.
func AllowContractSignature() Option {
	return func(o *options) { o.allowContractSignature = true }
}

func newOptions(opts []Option) options {
	var resolved options
	for _, opt := range opts {
		if opt != nil {
			opt(&resolved)
		}
	}
	return resolved
}

// AtBlock makes ValidateWithChain read the signer's code and make the isValidSignature call at one
// block, instead of at the latest block. Without it the two reads are at the latest block and are
// two reads, so they can land on different blocks. Use it to ask about the block a transfer executed
// in. It has no effect on Validate, or on ValidateWithChain without a checker. A nil block is the
// latest, and the block is copied.
func AtBlock(block *big.Int) Option {
	return func(o *options) {
		if block == nil {
			o.block = nil
			return
		}
		o.block = new(big.Int).Set(block)
	}
}
