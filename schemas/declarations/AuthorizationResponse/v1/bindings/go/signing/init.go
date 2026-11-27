package authorizationresponse

import (
	_ "embed"
	"encoding/json"

	lddataintegrity "github.com/atum-labs/protocol/schemas/declarations/common/ld-data-integrity/go"
)

// AuthorizationResponseContextURL is the canonical JSON-LD context URL
// for AuthorizationResponse. Every signed AuthorizationResponse must
// include this URL in its @context array; the verifier resolves the
// embedded snapshot below through docLoader during canonicalization.
const AuthorizationResponseContextURL = "https://schemas.atum.network/declarations/AuthorizationResponse/v1/context.jsonld"

//go:embed contexts/authorization-response-context.jsonld
var authorizationResponseContext []byte

// docLoader is the process-level strict-no-network JSON-LD document loader
// used for AuthorizationResponse canonicalization. It overlays this
// declaration's context onto the shared ld-data-integrity generic
// base (W3C VC v1, secp256k1recovery-2020-v2, ed25519-2020-v1, ...), so an
// unknown @context URL fails closed (no network — the SSRF defense inherited
// from the lib). Immutable after construction; concurrency-safe.
var docLoader = lddataintegrity.NewDocumentLoader(map[string]any{
	AuthorizationResponseContextURL: mustParseContext(authorizationResponseContext),
})

// mustParseContext parses an embedded .jsonld context into the map form
// NewDocumentLoader expects. A parse failure is a build-time defect in the
// vendored snapshot, so we panic at init rather than fail closed silently.
func mustParseContext(b []byte) map[string]any {
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		panic("authorizationresponse: failed to parse embedded JSON-LD context: " + err.Error())
	}
	return m
}
