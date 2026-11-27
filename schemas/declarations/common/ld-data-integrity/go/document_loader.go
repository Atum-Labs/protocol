package lddataintegrity

import (
	_ "embed"
	"encoding/json"
	"fmt"

	"github.com/piprate/json-gold/ld"
)

// Vendored generic JSON-LD contexts. Byte-identical to the snapshots
// held in the three pre-consolidation locations (FQ's bindings, atum-id-
// issuer's sign/, and the canonical sources upstream). The Makefile's
// `update-context` target keeps them in sync with the canonical sources
// under schemas/cryptosuites/ (where applicable); CI's verify-context
// guards drift.

// W3C VC v1 — the FULL vendored snapshot is kept here as an AUDIT
// REFERENCE ONLY. The active resolver entry below uses an inline
// minimal twin (see w3cVCv1MinimalTwin) because the full snapshot's
// nested VerifiableCredential / VerifiablePresentation scoped contexts
// carry `@protected: true` on terms (proof, holder, verifiableCredential)
// that VP-envelope outer contexts (e.g. FulfillmentQuoteEnvelope,
// PaymentRequestEnvelope) redefine at outer scope. URDNA2015 fires
// "protected term redefinition" on the VP path with the full snapshot
// active.
//
// The inline twin covers every term the MVP `KnownToAtumVerifiableCredential`
// body uses, so VC-level canonicalization is byte-identical to the
// issuer side for the current credential shape.
//
// Drift surface that remains: any future VC type using a term the
// inline twin doesn't bind (`credentialSchema`, `evidence`, `validFrom`)
// will canonicalize differently between the two and silently break
// signature verification. Mitigation: TestW3CVCv1MinimalTwinMatchesFull
// canonicalizes a representative MVP VC under both the inline twin and
// the vendored full snapshot, asserting byte-equal n-quads — fails
// loudly the moment a new VC term needs binding here.
//
//go:embed contexts/credentials-v1.jsonld
var credentialsV1FullSnapshotBytes []byte

//go:embed contexts/secp256k1recovery-2020-v2.jsonld
var secp256k1Recovery2020V2ContextBytes []byte

//go:embed contexts/ed25519-2020-v1.jsonld
var ed25519Signature2020V1ContextBytes []byte

//go:embed contexts/known-to-atum-v1.jsonld
var knownToAtumV1ContextBytes []byte

// known-to-atum-v2 keeps every v1 term as v1 defines it and adds the
// quoteAwarder and merchant roles. v1 is @protected, so a role can only be
// added in a new context. Its vocabulary stays v1's: a term both contexts
// define expands to the same IRI under either, so a credential using only
// v1-defined terms signs the same N-Quads under v1 and v2. A quoteAwarder
// or merchant credential does not: under v1 its role expands to a relative
// IRI, which URDNA2015 leaves out, so only v2 signs the role.
//
//go:embed contexts/known-to-atum-v2.jsonld
var knownToAtumV2ContextBytes []byte

//go:embed contexts/kyc-v1.jsonld
var kycV1ContextBytes []byte

//go:embed contexts/sender-compliance-v1.jsonld
var senderComplianceV1ContextBytes []byte

// w3cVCv1MinimalTwin is the active resolver entry for the W3C VC v1
// context URL. Mirrors the TS signer's local definition so canonical
// n-quads are byte-identical across Go + TS. See the
// credentialsV1FullSnapshotBytes docstring above for why the full
// snapshot can't be the active entry.
//
// The terms here are the union of what:
//   - W3C VC v1 itself defines (VerifiableCredential, VerifiablePresentation,
//     credentialSubject, credentialStatus, issuer, issuanceDate,
//     expirationDate, holder, verifiableCredential, proof, id, type)
//   - VP envelopes redefine at outer scope (proof, holder,
//     verifiableCredential — with @container: @graph for the array
//     shape)
//
// Add a new term ONLY after confirming a representative VC carrying
// it canonicalizes byte-identically under the full snapshot and an
// updated twin — the drift guard test pins this.
func w3cVCv1MinimalTwin() any {
	return map[string]any{
		"@context": map[string]any{
			"@version":               1.1,
			"@protected":             true,
			"id":                     "@id",
			"type":                   "@type",
			"cred":                   "https://www.w3.org/2018/credentials#",
			"sec":                    "https://w3id.org/security#",
			"xsd":                    "http://www.w3.org/2001/XMLSchema#",
			"VerifiableCredential":   map[string]any{"@id": "cred:VerifiableCredential", "@type": "@id"},
			"VerifiablePresentation": map[string]any{"@id": "cred:VerifiablePresentation", "@type": "@id"},
			"credentialSubject":      map[string]any{"@id": "cred:credentialSubject", "@type": "@id"},
			"credentialStatus":       map[string]any{"@id": "cred:credentialStatus", "@type": "@id"},
			"issuer":                 map[string]any{"@id": "cred:issuer", "@type": "@id"},
			"issuanceDate":           map[string]any{"@id": "cred:issuanceDate", "@type": "xsd:dateTime"},
			"expirationDate":         map[string]any{"@id": "cred:expirationDate", "@type": "xsd:dateTime"},
			"holder":                 map[string]any{"@id": "cred:holder", "@type": "@id"},
			"verifiableCredential": map[string]any{
				"@id":        "cred:verifiableCredential",
				"@type":      "@id",
				"@container": "@graph",
			},
			"proof": map[string]any{"@id": "sec:proof", "@type": "@id", "@container": "@graph"},
			// Forward-compatible W3C VC v1 terms — bound here so a
			// representative future VC carrying these fields
			// canonicalizes byte-identically under the twin and the
			// full vendored snapshot (drift_test.go pins this against
			// a fixture that uses each of these terms). The full
			// snapshot also defines nested @contexts on credentialSchema
			// and refreshService, but those scoped contexts only matter
			// if the VC carries an object value (e.g. {"id": "...",
			// "type": "JsonSchemaValidator2018"}) — for the URI-string
			// shape consumers use today, @type: @id is sufficient and
			// matches the snapshot's canonical n-quads.
			"credentialSchema": map[string]any{"@id": "cred:credentialSchema", "@type": "@id"},
			"evidence":         map[string]any{"@id": "cred:evidence", "@type": "@id"},
			"refreshService":   map[string]any{"@id": "cred:refreshService", "@type": "@id"},
			"termsOfUse":       map[string]any{"@id": "cred:termsOfUse", "@type": "@id"},
			"validFrom":        map[string]any{"@id": "cred:validFrom", "@type": "xsd:dateTime"},
			"validUntil":       map[string]any{"@id": "cred:validUntil", "@type": "xsd:dateTime"},
			"issued":           map[string]any{"@id": "cred:issued", "@type": "xsd:dateTime"},
		},
	}
}

// Generic context URL constants. Exported so callers can reference them
// when building proof blocks or registering schema-specific contexts
// alongside them in NewDocumentLoader.
const (
	W3CVCV1ContextURL             = "https://www.w3.org/2018/credentials/v1"
	Secp256k1Recovery2020V2CtxURL = "https://w3id.org/security/suites/secp256k1recovery-2020/v2"
	Ed25519Signature2020V1CtxURL  = "https://w3id.org/security/suites/ed25519-2020/v1"
	KnownToAtumV1ContextURL       = "https://schemas.atum.xyz/credentials/known-to-atum/v1"
	KnownToAtumV2ContextURL       = "https://schemas.atum.xyz/credentials/known-to-atum/v2"
	KYCV1ContextURL               = "https://schemas.atum.xyz/credentials/kyc/v1"
	SenderComplianceV1ContextURL  = "https://schemas.atum.xyz/credentials/sender-compliance/v1"
)

// genericContexts builds the map of URL → parsed context for the
// vendored generic contexts. Each consumer-side loader starts from this
// map and overlays its schema-specific contexts via NewDocumentLoader's
// Extra parameter.
//
// W3C VC v1 resolves to the inline minimal twin (NOT the full vendored
// snapshot file) — see w3cVCv1MinimalTwin's docstring for the protected-
// term-redefinition rationale.
func genericContexts() map[string]any {
	return map[string]any{
		W3CVCV1ContextURL:             w3cVCv1MinimalTwin(),
		Secp256k1Recovery2020V2CtxURL: mustParseJSONContext(secp256k1Recovery2020V2ContextBytes),
		Ed25519Signature2020V1CtxURL:  mustParseJSONContext(ed25519Signature2020V1ContextBytes),
		KnownToAtumV1ContextURL:       mustParseJSONContext(knownToAtumV1ContextBytes),
		KnownToAtumV2ContextURL:       mustParseJSONContext(knownToAtumV2ContextBytes),
		KYCV1ContextURL:               mustParseJSONContext(kycV1ContextBytes),
		SenderComplianceV1ContextURL:  mustParseJSONContext(senderComplianceV1ContextBytes),
	}
}

// w3cVCv1FullVendoredSnapshot returns the parsed FULL W3C VC v1
// snapshot from the embedded credentials-v1.jsonld file. Exposed so
// the drift guard test can canonicalize a representative VC under
// both the minimal twin AND the full snapshot, asserting byte-equal
// n-quads. NOT used as an active resolver entry — see the file's
// docstring for why.
func w3cVCv1FullVendoredSnapshot() any {
	return mustParseJSONContext(credentialsV1FullSnapshotBytes)
}

// mustParseJSONContext panics if a vendored context asset can't be
// parsed. The asset is bundled at build time via go:embed, so a parse
// failure means the binary is corrupt — surfacing it at init beats
// silent-drop behavior, which would let canonicalization proceed
// without the context and produce signatures the verifier would later
// reject for a non-obvious reason.
func mustParseJSONContext(asset []byte) any {
	var ctx any
	if err := json.Unmarshal(asset, &ctx); err != nil {
		panic(fmt.Errorf("lddataintegrity: embedded JSON-LD context is corrupt: %w", err))
	}
	return ctx
}

// DocumentLoader is a strict-no-network json-gold DocumentLoader. Any
// JSON-LD `@context` URL not in its registered set fails closed with
// ErrUnknownContext. Construct via NewDocumentLoader; callers should
// hold one instance per process (loaders are concurrency-safe for
// concurrent LoadDocument calls because the map is immutable after
// construction).
type DocumentLoader struct {
	contexts map[string]any
}

// NewDocumentLoader returns a loader registering the generic vendored
// contexts (W3C VC v1, secp256k1recovery-2020-v2, ed25519-2020-v1,
// known-to-atum-v1 and v2, kyc-v1, sender-compliance-v1) plus any
// schema-specific contexts the caller supplies via `extra`.
//
// `extra` keys are JSON-LD context URLs (e.g.
// "https://schemas.atum.network/declarations/FulfillmentQuote/v1/context.jsonld");
// values are the PARSED context content (typically the result of
// json.Unmarshal-ing a vendored .jsonld file). Callers that pass raw
// bytes should parse first; this function does not accept []byte for
// schema-specific contexts because parse failures at registration time
// have no meaningful default fallback (unlike the lib's own vendored
// generic contexts, which panic via mustParseJSONContext).
//
// Pass nil / empty `extra` if no schema-specific contexts are needed.
func NewDocumentLoader(extra map[string]any) *DocumentLoader {
	contexts := genericContexts()
	for url, ctx := range extra {
		contexts[url] = ctx
	}
	return &DocumentLoader{contexts: contexts}
}

// WithExtraContexts returns a NEW loader whose registered set is this
// loader's contexts overlaid with `extra` (extra wins on URL collision).
// The receiver is left untouched — the new loader gets an independent
// copy of the context map, so both stay concurrency-safe (the map is
// immutable after construction, same invariant NewDocumentLoader holds).
//
// The VP-envelope verifier reuses the shared canonicalization path but
// the OUTER envelope's top-level @context URL is declaration-specific
// (FulfillmentQuoteEnvelope vs PaymentRequestEnvelope). Rather than
// teach the process-global loader about every envelope declaration —
// which would violate the layering boundary — the verify entry point
// overlays the
// caller-supplied envelope context onto a per-call loader via this
// method. `extra` nil / empty returns a copy of the receiver unchanged
// (cheap, but still a distinct instance so callers can't mutate the
// shared base by reference).
func (l *DocumentLoader) WithExtraContexts(extra map[string]any) *DocumentLoader {
	contexts := make(map[string]any, len(l.contexts)+len(extra))
	for url, ctx := range l.contexts {
		contexts[url] = ctx
	}
	for url, ctx := range extra {
		contexts[url] = ctx
	}
	return &DocumentLoader{contexts: contexts}
}

// LoadDocument satisfies json-gold's ld.DocumentLoader interface. Any
// URL not registered fails closed with ErrUnknownContext. Wraps in
// fmt.Errorf to preserve the unknown URL for log diagnostics; callers
// use errors.Is(err, ErrUnknownContext) to classify.
func (l *DocumentLoader) LoadDocument(u string) (*ld.RemoteDocument, error) {
	ctx, ok := l.contexts[u]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnknownContext, u)
	}
	return &ld.RemoteDocument{DocumentURL: u, Document: ctx}, nil
}
