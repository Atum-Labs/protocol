package biddecline

import (
	_ "embed"
	"encoding/json"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// ContextURL is the canonical JSON-LD context URL of the BidDecline declaration.
const ContextURL = "https://schemas.atum.network/declarations/BidDecline/v1/context.jsonld"

//go:embed contexts/bid-decline-context.jsonld
var declarationContext []byte

// docLoader is the strict no-network loader for BidDecline canonicalization: this declaration's
// context over the shared ld-data-integrity base. Immutable after construction.
var docLoader = lddataintegrity.NewDocumentLoader(map[string]any{
	ContextURL: mustParseContext(declarationContext),
})

// mustParseContext panics at init on a malformed embedded snapshot, a build-time defect.
func mustParseContext(b []byte) map[string]any {
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		panic("biddecline: failed to parse embedded JSON-LD context: " + err.Error())
	}
	return m
}
