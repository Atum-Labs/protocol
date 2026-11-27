package senderauth

import (
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/crypto"
)

// Escrow commitments for sender_auth producers: the deposit request hash and the plaintext
// destination. Both are pinned by PaymentRequest/v1/conformance/destination-vectors.json, which
// every implementation of this grammar must reproduce byte-for-byte.

// MaxDestinationBytes mirrors MAX_DESTINATION_BYTES in Escrow.sol. Over this the contract
// reverts DestinationTooLong, so a longer destination could never be redeemed.
const MaxDestinationBytes = 256

// namespaceEIP155 is the one CAIP-2 namespace whose identifiers are entirely
// case-insensitive hex, and therefore the only one safe to lowercase wholesale.
const namespaceEIP155 = "eip155"

// DeriveDepositRequestHash returns keccak256(bytes(requestID)), depositRequestHash v1: the
// depositor's commitment to the off-chain payment request id. The escrow treats the value as
// opaque, so this derivation is the specification, pinned by the depositRequestHashes conformance
// vectors. v1 covers the request id alone. depositRequestHash v2, the hash of the payment terms
// without sender_auth, is ReadDepositRequest's DepositRequestHashV2; a producer picks the version
// with BuildParams.DepositRequestHashVersion.
func DeriveDepositRequestHash(requestID string) ([32]byte, error) {
	if requestID == "" {
		return [32]byte{}, fmt.Errorf(
			"sender_auth: cannot derive deposit_request_hash: request_id is empty, and " +
				"keccak256(\"\") is a perfectly valid non-zero bytes32, so this would silently " +
				"commit every empty-id deposit to the same hash instead of failing")
	}
	return crypto.Keccak256Hash([]byte(requestID)), nil
}

// BuildEscrowDestination composes the plaintext destination committed in the deposit witness:
//
//	<caip2-chain-id>/<asset-namespace>:<asset-reference>@<account-address>
//	eip155:8453/erc20:0x833589f...02913@0xc0ffee2...54979
//
// The escrow stores only keccak256(bytes(destination)), so every producer and verifier must
// compose identical bytes. Casing is per-namespace: eip155 hex is lowercased (not EIP-55), and
// base58 values, including every Solana segment, are preserved byte-for-byte. Non-canonical input
// is rejected rather than normalised. The asset namespace has no allow-list, so compose the
// destination once per payment and carry it verbatim rather than re-deriving it.
func BuildEscrowDestination(assetIdentifier, account string) (string, error) {
	if assetIdentifier == "" {
		return "", fmt.Errorf("sender_auth: destination asset_identifier is empty")
	}
	if account == "" {
		return "", fmt.Errorf("sender_auth: destination account is empty")
	}
	// Every chain identifier and address is printable ASCII. Anything else is refused, so no
	// Unicode case mapping, whose tables differ between languages and versions, shapes the bytes.
	if !isPrintableASCII(assetIdentifier) || !isPrintableASCII(account) {
		return "", fmt.Errorf("sender_auth: destination asset_identifier and account must be printable ASCII")
	}
	// "@" is the field separator, so neither side may contain one or the composed string
	// would be ambiguous to any parser splitting on it.
	if strings.Contains(assetIdentifier, "@") || strings.Contains(account, "@") {
		return "", fmt.Errorf(
			"sender_auth: destination asset_identifier (%q) and account (%q) must not contain "+
				"'@': it is the separator between them in the committed destination grammar",
			assetIdentifier, account)
	}

	namespace, err := caip2Namespace(assetIdentifier)
	if err != nil {
		return "", err
	}

	if namespace == namespaceEIP155 {
		// Every segment of an eip155 destination is ASCII hex or a lowercase keyword, so
		// lowercasing the whole side is safe here and ONLY here.
		assetIdentifier = strings.ToLower(assetIdentifier)
		account = strings.ToLower(account)
	}

	destination := assetIdentifier + "@" + account
	// len() on a Go string counts BYTES, matching Solidity's bytes(destination).length.
	if len(destination) > MaxDestinationBytes {
		// The message names the escrow's own constant, as the TypeScript binding's does. It reaches
		// a commitment refusal's detail, which both languages must report identically.
		return "", fmt.Errorf(
			"sender_auth: composed destination is %d bytes, over the escrow's "+
				"MAX_DESTINATION_BYTES of %d: the contract reverts DestinationTooLong, so this "+
				"deposit could never be redeemed", len(destination), MaxDestinationBytes)
	}
	return destination, nil
}

// caip2Namespace extracts the CAIP-2 namespace from a CAIP-19 asset identifier and
// validates the surrounding shape. Only the namespace is needed (it selects the casing
// rule), but a malformed identifier is rejected rather than passed through, because the
// destination is signed and the contract cannot check it.
func caip2Namespace(assetIdentifier string) (string, error) {
	chainPart, assetPart, found := strings.Cut(assetIdentifier, "/")
	if !found || chainPart == "" || assetPart == "" {
		// The `solana:<chain-ref>:<mint>` form lands here: the commitment is over exact bytes, so
		// only the CAIP-19 spelling is accepted.
		hint := ""
		if strings.Count(assetIdentifier, ":") == 2 && !strings.Contains(assetIdentifier, "/") {
			hint = " (this looks like the deprecated `<chain>:<ref>:<asset>` form; " +
				"migrate it to `<chain>:<ref>/<asset-namespace>:<asset-reference>`)"
		}
		return "", fmt.Errorf(
			"sender_auth: destination asset_identifier %q is not CAIP-19: expected "+
				"<caip2-chain-id>/<asset-namespace>:<asset-reference>%s", assetIdentifier, hint)
	}
	assetNamespace, assetReference, ok := strings.Cut(assetPart, ":")
	if !ok || assetNamespace == "" || assetReference == "" {
		return "", fmt.Errorf(
			"sender_auth: destination asset_identifier %q has a malformed asset part %q: "+
				"expected <asset-namespace>:<asset-reference>", assetIdentifier, assetPart)
	}
	// Namespaces must be lowercase, and a variant spelling is refused rather than normalised: only
	// eip155 is lowercased wholesale, so "Token" and "token" would otherwise commit two different
	// hashes for one payee. The asset reference is case-significant (base58 mints, Tron addresses).
	if assetNamespace != strings.ToLower(assetNamespace) {
		return "", fmt.Errorf(
			"sender_auth: destination asset_identifier %q has a non-canonical asset namespace %q: "+
				"the ratified grammar requires it lowercase (%q). It is rejected rather than "+
				"normalised because the destination commitment is over these exact bytes",
			assetIdentifier, assetNamespace, strings.ToLower(assetNamespace))
	}
	namespace, reference, ok := strings.Cut(chainPart, ":")
	if !ok || namespace == "" || reference == "" {
		return "", fmt.Errorf(
			"sender_auth: destination asset_identifier %q has a malformed chain part %q: "+
				"expected <namespace>:<reference>", assetIdentifier, chainPart)
	}
	// The chain namespace selects the casing rule, so it must already be lowercase: lowercasing
	// "SOLANA:..." to normalise it would corrupt the base58 segments that follow.
	if namespace != strings.ToLower(namespace) {
		return "", fmt.Errorf(
			"sender_auth: destination asset_identifier %q has a non-canonical chain namespace %q: "+
				"the ratified grammar requires it lowercase (%q). It is rejected rather than "+
				"normalised because the destination commitment is over these exact bytes",
			assetIdentifier, namespace, strings.ToLower(namespace))
	}
	return namespace, nil
}

// isPrintableASCII reports whether every byte of s is a printable ASCII character (0x21-0x7E).
func isPrintableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x21 || s[i] > 0x7e {
			return false
		}
	}
	return true
}
