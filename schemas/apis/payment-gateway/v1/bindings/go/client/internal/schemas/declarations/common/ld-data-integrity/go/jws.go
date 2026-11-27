package lddataintegrity

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
)

// JWSHeader is the parsed header of a detached ES256K-R JWS as produced
// by the EcdsaSecp256k1RecoverySignature2020 cryptosuite. The detached
// JWS format is `<base64url(header)>..<base64url(signature)>` with an
// empty payload segment — the payload is the canonicalized + hashed
// document, transmitted out-of-band via the document itself.
//
// b64=false + crit=["b64"] together signal RFC 7797 detached-payload
// mode. A strict JOSE validator that doesn't understand b64 MUST reject
// per RFC 7515 §4.1.11 — this prevents a split-trust bypass where a
// lenient peer accepts and ignores the unknown extension while a
// stricter peer rejects.
type JWSHeader struct {
	Alg  string   `json:"alg"`
	B64  bool     `json:"b64"`
	Crit []string `json:"crit"`
}

// ES256KRHeader is the canonical JWS header for the
// EcdsaSecp256k1RecoverySignature2020 cryptosuite (detached, b64=false,
// crit:[b64]). Pre-marshaled at init time so BuildSecp256k1JWS doesn't
// re-marshal it on every signing call.
var es256KRHeaderJSON = mustMarshalES256KRHeader()

func mustMarshalES256KRHeader() []byte {
	b, err := json.Marshal(JWSHeader{
		Alg:  "ES256K-R",
		B64:  false,
		Crit: []string{"b64"},
	})
	if err != nil {
		// Marshaling a static struct can't fail at runtime — defensive.
		panic(fmt.Errorf("lddataintegrity: marshal ES256K-R header: %w", err))
	}
	return b
}

// BuildSecp256k1JWS produces a detached ES256K-R JWS string from a
// 65-byte secp256k1 signature (r||s||v with v in {0,1}). The output
// shape is `<base64url(header)>..<base64url(signature)>` — the empty
// payload segment is intentional (detached payload per RFC 7797).
//
// The caller supplies the raw 65-byte signature; this function does
// NOT sign — see sign.go in each consumer package for the signing
// flow that composes HashDocument + crypto.Sign + BuildSecp256k1JWS.
//
// Returns an error only if `signature` is not exactly 65 bytes; this
// is a defensive check against caller error since crypto.Sign always
// returns 65-byte output.
func BuildSecp256k1JWS(signature []byte) (string, error) {
	if len(signature) != 65 {
		return "", fmt.Errorf("%w: signature must be 65 bytes, got %d", ErrMalformedProof, len(signature))
	}
	return base64.RawURLEncoding.EncodeToString(es256KRHeaderJSON) + ".." +
		base64.RawURLEncoding.EncodeToString(signature), nil
}

// ParseSecp256k1JWS parses a detached ES256K-R JWS (header..signature
// format) and returns the parsed header + 65-byte signature. Enforces
// RFC 7797 / W3C Data Integrity invariants:
//
//   - alg MUST be "ES256K-R"
//   - b64 MUST be false (detached payload)
//   - crit MUST contain "b64" (RFC 7515 §4.1.11 — recipient rejects
//     unrecognized crit values; we only understand b64, so any other
//     entry is an attacker-shaped strict-validator bypass)
//   - signature MUST decode to exactly 65 bytes (r||s||v)
//
// All failure modes return errors that wrap ErrMalformedProof so
// callers can classify via errors.Is.
func ParseSecp256k1JWS(jws string) (*JWSHeader, []byte, error) {
	parts := strings.Split(jws, "..")
	if len(parts) != 2 {
		return nil, nil, fmt.Errorf("%w: invalid detached JWS format: expected header..signature", ErrMalformedProof)
	}

	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, nil, fmt.Errorf("%w: decode JWS header: %v", ErrMalformedProof, err)
	}

	var header JWSHeader
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return nil, nil, fmt.Errorf("%w: parse JWS header: %v", ErrMalformedProof, err)
	}

	if header.Alg != "ES256K-R" {
		return nil, nil, fmt.Errorf("%w: unsupported alg %q (want ES256K-R)", ErrMalformedProof, header.Alg)
	}
	if header.B64 {
		return nil, nil, fmt.Errorf("%w: expected b64=false for detached JWS", ErrMalformedProof)
	}
	// W3C Data Integrity / RFC 7797 require b64 to be marked critical;
	// otherwise a strict JOSE validator could ignore the b64=false hint
	// and decode the (empty) payload as standard base64url. Reject any
	// unrecognized crit entry to prevent a strict-validator bypass like
	// crit:["b64","evil-extension"].
	for _, c := range header.Crit {
		if c != "b64" {
			return nil, nil, fmt.Errorf("%w: unrecognized crit header parameter %q", ErrMalformedProof, c)
		}
	}
	if !slices.Contains(header.Crit, "b64") {
		return nil, nil, fmt.Errorf("%w: expected crit to contain %q for detached JWS", ErrMalformedProof, "b64")
	}

	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, nil, fmt.Errorf("%w: decode JWS signature: %v", ErrMalformedProof, err)
	}

	if len(signature) != 65 {
		return nil, nil, errors.Join(
			ErrMalformedProof,
			fmt.Errorf("invalid signature length: expected 65 bytes, got %d", len(signature)),
		)
	}

	return &header, signature, nil
}
