package ldverification

import (
	"errors"
	"fmt"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// JWSHeader is the parsed header of a detached ES256K-R JWS. Re-exported
// from the shared lib so callers that hold this struct (test fixtures
// inside this package, tests in dependents) keep compiling unchanged
// after the refactor. The struct shape is fixed by W3C Data Integrity +
// RFC 7797 + RFC 7515 §4.1.11 — see [lddataintegrity.JWSHeader] for the
// full invariant rationale.
type JWSHeader = lddataintegrity.JWSHeader

// ParseDetachedJWS parses a detached ES256K-R JWS (header..signature
// format) and returns the header and 65-byte ES256K-R signature.
//
// Thin wrapper over [lddataintegrity.ParseSecp256k1JWS]; converts the
// lib's [lddataintegrity.ErrMalformedProof] sentinel back to FQ's
// [ErrMalformedSignatureMaterial] so callers using
// `errors.Is(err, ErrMalformedSignatureMaterial)` to classify
// signature-material failures keep working unchanged.
func ParseDetachedJWS(jws string) (*JWSHeader, []byte, error) {
	header, sig, err := lddataintegrity.ParseSecp256k1JWS(jws)
	if err != nil {
		if errors.Is(err, lddataintegrity.ErrMalformedProof) {
			return nil, nil, fmt.Errorf("%w: %v", ErrMalformedSignatureMaterial, err)
		}
		return nil, nil, err
	}
	return header, sig, nil
}
