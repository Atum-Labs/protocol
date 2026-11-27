package senderauth

import (
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/crypto"
)

// hexToBytes decodes a 0x-prefixed (or bare) hex string into bytes.
func hexToBytes(s string) ([]byte, error) {
	return hex.DecodeString(strings.TrimPrefix(s, "0x"))
}

// assetAddress extracts the on-chain address from a "<caip2>/<ns>:<address>" asset id, or errors
// naming the identifier. Every segment is required and none may be empty. Mirrors TS
// parseSourceAsset.
func assetAddress(sourceAsset string) (string, error) {
	// The CAIP-19 token-id form names one token of a non-fungible collection. A deposit binds a
	// fungible amount, so reading its collection address as the token would sign a permit for
	// something this flow cannot settle. Mirrors the TS message.
	//
	// Otherwise exactly two segments on each separator, none empty, so a second separator cannot
	// make the two bindings read different addresses.
	parts := strings.Split(sourceAsset, "/")
	if len(parts) == 3 && parts[0] != "" && parts[1] != "" && parts[2] != "" {
		return "", fmt.Errorf("sender_auth: source asset %q names a token id, which a deposit cannot bind", sourceAsset)
	}
	if len(parts) != 2 || parts[0] == "" {
		return "", fmt.Errorf("sender_auth: invalid source asset %q", sourceAsset)
	}
	nsParts := strings.Split(parts[1], ":")
	if len(nsParts) != 2 || nsParts[0] == "" || nsParts[1] == "" {
		return "", fmt.Errorf("sender_auth: invalid source asset %q", sourceAsset)
	}
	return nsParts[1], nil
}

// secp256k1SignDigest signs a 32-byte 0x-hex digest with a local secp256k1 key and returns the
// 65-byte signature as 0x-hex, r || s || v with v 27/28. Permit2 passes v to ecrecover
// unchanged, so a v of 0/1 recovers the zero address and the deposit reverts. The digest is the
// canonical EIP-712/TIP-712 digest, so signing it with a local key is byte-identical to signing
// the typed data, as the TS `sign` (ethers `signTypedData`) does.
//
// Do not reuse it behind a remote, policy-aware signer (Turnkey, cloud KMS): such a signer must
// receive the typed data, not the digest, or no field-level policy is expressible. See
// `signSecp256k1TypedDataAndVerify` in the Turnkey provider for the shape to follow.
func secp256k1SignDigest(message, privateKey string) (string, error) {
	digest, err := hexToBytes(message)
	if err != nil {
		return "", fmt.Errorf("sender_auth: invalid message digest: %w", err)
	}
	key, err := crypto.HexToECDSA(strings.TrimPrefix(privateKey, "0x"))
	if err != nil {
		return "", fmt.Errorf("sender_auth: invalid private key: %w", err)
	}
	sig, err := crypto.Sign(digest, key)
	if err != nil {
		return "", err
	}
	sig[64] += 27
	return "0x" + hex.EncodeToString(sig), nil
}
