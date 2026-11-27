package ldverification

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/mr-tron/base58"
)

// RecoverSignerIdentity cryptographically recovers the inner
// PaymentRequest's CHAIN-CANONICAL signer identity, used as the trusted
// ExpectedHolder for the PRE envelope's holder consistency check. Mirror of
// quote_signature.go's recoverSignerIdentity but over the
// PaymentRequest verifier (the inner-document path) — the identity
// encoding is byte-identical so the PRE holder DID composed downstream
// matches what the originator signed.
//
// Distinct from RecoverSigner (the CLI shim that returns only the raw EVM
// 0x-hex address): this returns the per-chain canonical form — lowercased
// 0x-hex for eip155, Tron base58check for tron, ed25519 base58 for solana, the G... strkey for stellar.
//
// sourceChainCAIP2 MUST come from the authoritative source asset in the
// PaymentRequest (already chain-bound by the topic-routing parse), NOT
// from the envelope — the envelope's holder is the value we're
// validating, so trusting it here would defeat the consistency check.
//
// Returns ("", nil) when the inner request carries no Data Integrity
// proof: older requests are unsigned, and an empty identity lets
// VerifyVP fall through to its own holder check (which fails closed under
// strict). Returns a non-nil error only on a malformed / mis-signed
// inner proof.
//
// Single source of truth for both gateway PRE perimeters (the requester
// perimeter's request check and the counterparty perimeter's VP check) call
// this canonical copy rather than maintaining verbatim duplicates.
func RecoverSignerIdentity(rawRequestJSON []byte, sourceChainCAIP2 string) (string, error) {
	return RecoverSignerIdentityWithOptions(rawRequestJSON, sourceChainCAIP2, VerifyOptions{})
}

// RecoverSignerIdentityWithOptions is RecoverSignerIdentity with the proof forms opts accepts: a
// verifier of an originator's own payment request sets AcceptPaymentRequestTypedProof to recover
// a payer whose wallet signed the request as EIP-712 typed data.
func RecoverSignerIdentityWithOptions(rawRequestJSON []byte, sourceChainCAIP2 string, opts VerifyOptions) (string, error) {
	// Cheap presence check — an unsigned request has no proof block.
	var probe struct {
		Proof json.RawMessage `json:"proof"`
	}
	if err := json.Unmarshal(rawRequestJSON, &probe); err != nil || len(probe.Proof) == 0 {
		return "", nil
	}

	chain := strings.ToLower(strings.TrimSpace(sourceChainCAIP2))
	isEVM := strings.HasPrefix(chain, "eip155:")
	isTron := strings.HasPrefix(chain, "tron:")
	isSolana := strings.HasPrefix(chain, "solana:")
	isStellar := strings.HasPrefix(chain, "stellar:")
	if !isEVM && !isTron && !isSolana && !isStellar {
		return "", fmt.Errorf("ldverification: unsupported source chain %q", sourceChainCAIP2)
	}

	res, err := VerifyPaymentRequestWithOptions(rawRequestJSON, opts)
	if err != nil {
		return "", fmt.Errorf("ldverification: inner PaymentRequest signature: %w", err)
	}

	switch signer := res.Signer.(type) {
	case RecoveredSecp256k1Signer:
		switch {
		case isEVM:
			return strings.ToLower(signer.Address.Hex()), nil
		case isTron:
			return evmHashToTronBase58(signer.Address), nil
		default:
			return "", fmt.Errorf("ldverification: source %q requires %s, got %s",
				chain, ProofTypeEd25519Signature2020, ProofTypeSecp256k1Recovery2020)
		}
	case SelfAssertedEd25519Signer:
		if !isSolana && !isStellar {
			return "", fmt.Errorf("ldverification: source %q requires %s, got %s",
				chain, ProofTypeSecp256k1Recovery2020, ProofTypeEd25519Signature2020)
		}
		// The namespace is part of the binding: "devnet" or "testnet" alone does not say
		// which chain family the key was named under.
		if err := signer.MatchesChain(chain); err != nil {
			return "", fmt.Errorf("ldverification: %w", err)
		}
		if isStellar {
			return encodeStellarAccount(signer.PublicKey), nil
		}
		return base58.Encode(signer.PublicKey), nil
	default:
		return "", fmt.Errorf("ldverification: unreachable signer type %T for source %q", res.Signer, sourceChainCAIP2)
	}
}

// evmHashToTronBase58 converts a 20-byte EVM address to a Tron
// base58check address. Prepend 0x41 (mainnet prefix) to the 20-byte hash,
// append the first 4 bytes of SHA256(SHA256(0x41||hash)) as the checksum,
// then base58-encode the resulting 25 bytes. EVM and Tron derive their
// addresses from the same secp256k1 pubkey hash; this is purely a format
// change. Inlined so this module carries no extra dependency.
func evmHashToTronBase58(addr common.Address) string {
	payload := make([]byte, 21)
	payload[0] = 0x41
	copy(payload[1:], addr.Bytes())
	h1 := sha256.Sum256(payload)
	h2 := sha256.Sum256(h1[:])
	out := make([]byte, 25)
	copy(out[:21], payload)
	copy(out[21:], h2[:4])
	return base58.Encode(out)
}
