package ldverification

import (
	"crypto/ed25519"
	"errors"
	"fmt"

	stellarencoding "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/contracts/stellar/bindings/go/escrow-encoding/encoding"
)

// A Stellar account is a strkey: base32 of a version byte, the 32-byte ed25519 public key and a
// CRC-16/XMODEM checksum stored little-endian. Only the G (ed25519 public key) form can sign, so it
// is the only one accepted here.
//
// The strkey rules themselves (alphabet first, canonical base32, checksum, payload size) live in one
// place, the Stellar escrow-encoding package, which chain-address and the escrow encoders call too.
// This file adds only what a signer needs: the G type and the ed25519 key type.

// decodeStellarAccount returns the public key of a G... strkey. It refuses any other strkey type
// (a C contract cannot sign, an S seed is a secret), lowercase, and a bad checksum.
func decodeStellarAccount(strkey string) (ed25519.PublicKey, error) {
	pk, err := stellarencoding.PubkeyFromStrkey(strkey)
	if errors.Is(err, stellarencoding.ErrUnsupportedAddress) {
		return nil, fmt.Errorf("stellar account strkey must be a G account: %w", err)
	}
	if err != nil {
		return nil, fmt.Errorf("stellar account strkey: %w", err)
	}
	return ed25519.PublicKey(pk[:]), nil
}

// encodeStellarAccount renders a public key as its G... strkey. A key that is not 32 bytes renders as
// the empty string, which no holder address or verificationMethod equals.
func encodeStellarAccount(pub ed25519.PublicKey) string {
	if len(pub) != ed25519.PublicKeySize {
		return ""
	}
	return stellarencoding.NewAccountAddress([32]byte(pub)).String()
}
