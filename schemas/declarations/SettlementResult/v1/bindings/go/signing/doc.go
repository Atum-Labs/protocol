// Package settlementresult derives the content hash of a SettlementResult declaration, the value its
// SettlementResultEnvelope binds as the holder VP proof.challenge.
//
// The declaration's JSON-LD context is embedded from the snapshot under contexts/; run
// `go generate ./...` (or `make update-context`) to refresh it from the canonical source.
package settlementresult

//go:generate sh -c "cp ../../../context.jsonld contexts/settlement-result-context.jsonld"
