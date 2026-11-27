package ldverification

import (
	"errors"
	"fmt"

	lddataintegrity "github.com/atum-labs/protocol/schemas/apis/payment-gateway/v1/bindings/go/client/internal/schemas/declarations/common/ld-data-integrity/go"
)

// JWSHeader is the parsed header of a detached ES256K-R JWS. Re-exported
// from the shared lib so callers that hold this struct (test fixtures
// inside this package, dependents) have a PR-local name. The struct
// shape is fixed by W3C Data Integrity + RFC 7797 + RFC 7515 §4.1.11 —
// see [lddataintegrity.JWSHeader] for the full invariant rationale.
type JWSHeader = lddataintegrity.JWSHeader

// ParseDetachedJWS parses a detached ES256K-R JWS (header..signature
// format) and returns the header and 65-byte ES256K-R signature.
//
// Thin wrapper over [lddataintegrity.ParseSecp256k1JWS]; converts the
// lib's [lddataintegrity.ErrMalformedProof] sentinel to PR's
// [ErrMalformedSignatureMaterial] so callers using
// `errors.Is(err, ErrMalformedSignatureMaterial)` to classify
// signature-material failures stay aligned with the FQ taxonomy.
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
