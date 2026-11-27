package settlementresult

import (
	"encoding/json"
	"errors"
	"fmt"

	declaration "github.com/atum-labs/protocol/schemas/declarations/SettlementResult/v1/bindings/go"
	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// ErrMalformedSettlementResult is returned when the bytes handed to ComputeSettlementResultHash are not a schema-valid SettlementResult.
var ErrMalformedSettlementResult = errors.New("malformed SettlementResult")

// ComputeSettlementResultHash schema-validates the verbatim declared JSON and returns its content hash,
// the proof.challenge of the SettlementResultEnvelope that attests it. It verifies no signature.
func ComputeSettlementResultHash(raw []byte) (string, error) {
	if err := declaration.Validate(raw); err != nil {
		return "", fmt.Errorf("%w: %w", ErrMalformedSettlementResult, err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", fmt.Errorf("%w: %w", ErrMalformedSettlementResult, err)
	}
	return lddataintegrity.ComputeContentHash(doc, ContextURL, docLoader)
}
