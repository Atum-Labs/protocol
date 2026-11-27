// Package biddecline derives the content hash of a BidDecline declaration, the value its
// BidDeclineEnvelope binds as the holder VP proof.challenge.
//
// The declaration's JSON-LD context is embedded from the snapshot under contexts/; run
// `go generate ./...` (or `make update-context`) to refresh it from the canonical source.
package biddecline

//go:generate sh -c "cp ../../../context.jsonld contexts/bid-decline-context.jsonld"
