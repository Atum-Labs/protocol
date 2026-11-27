package biddecline

import (
	"encoding/json"
	"errors"
	"fmt"

	declaration "github.com/atum-labs/protocol/schemas/declarations/BidDecline/v1/bindings/go"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// ErrMalformedBidDecline is returned when the bytes handed to ComputeBidDeclineHash are not a schema-valid BidDecline.
var ErrMalformedBidDecline = errors.New("malformed BidDecline")

// ComputeBidDeclineHash schema-validates the verbatim declared JSON and returns its content hash,
// the proof.challenge of the BidDeclineEnvelope that attests it. It verifies no signature.
func ComputeBidDeclineHash(raw []byte) (string, error) {
	if err := declaration.Validate(raw); err != nil {
		return "", fmt.Errorf("%w: %w", ErrMalformedBidDecline, err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", fmt.Errorf("%w: %w", ErrMalformedBidDecline, err)
	}
	return lddataintegrity.ComputeContentHash(doc, ContextURL, docLoader)
}
