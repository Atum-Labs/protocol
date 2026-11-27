// Package authorizationresponse builds and verifies W3C Data Integrity
// proofs (EcdsaSecp256k1RecoverySignature2020) on AuthorizationResponses,
// and derives the content-addressed response_hash the
// AuthorizationResponseEnvelope binds as its holder-VP challenge.
//
// The schema's JSON-LD context is embedded at compile time via the
// snapshot under contexts/. Run `go generate ./...` (or `make
// update-context`) to refresh that snapshot from the canonical schema
// source.
package authorizationresponse

//go:generate sh -c "cp ../../../context.jsonld contexts/authorization-response-context.jsonld"
