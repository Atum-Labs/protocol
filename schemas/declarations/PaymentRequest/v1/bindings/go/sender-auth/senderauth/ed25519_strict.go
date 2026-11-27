package senderauth

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
)

// smallOrderEncodings are the y-coordinates, as the 32-byte little-endian encodings with the sign
// bit cleared, of every ed25519 point whose order divides 8, canonical and not (y = p and y = p + 1).
// For such a public key or signature R, a signature can be made without the private key. Mirrors
// the TS SMALL_ORDER_ENCODINGS.
var smallOrderEncodings = func() [][]byte {
	list := make([][]byte, 0, 7)
	for _, h := range []string{
		"0000000000000000000000000000000000000000000000000000000000000000",
		"0100000000000000000000000000000000000000000000000000000000000000",
		"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
		"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
		"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	} {
		b, _ := hex.DecodeString(h)
		list = append(list, b)
	}
	return list
}()

// isSmallOrderEncoding reports whether a 32-byte point encoding, with either sign bit, is a point
// whose order divides 8.
func isSmallOrderEncoding(point []byte) bool {
	if len(point) != 32 {
		return false
	}
	masked := bytes.Clone(point)
	masked[31] &= 0x7f
	for _, e := range smallOrderEncodings {
		if bytes.Equal(masked, e) {
			return true
		}
	}
	return false
}

// verifyEd25519Strict is ed25519 verification as the Solana ed25519 program performs it
// (verify_strict): crypto/ed25519's check, which refuses a non-canonical S, plus a refusal of a
// small-order public key or signature R. Mirrors the TS `verifyEd25519Strict`.
func verifyEd25519Strict(publicKey, message, signature []byte) bool {
	if len(publicKey) != ed25519.PublicKeySize || len(signature) != ed25519.SignatureSize {
		return false
	}
	if isSmallOrderEncoding(publicKey) || isSmallOrderEncoding(signature[:32]) {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(publicKey), message, signature)
}
