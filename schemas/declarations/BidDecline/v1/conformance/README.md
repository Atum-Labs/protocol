# BidDecline/v1 cross-language conformance

`content-hash-golden.json` pins the content hash of the BidDecline declaration carried in
`BidDeclined.bid_decline_json`. It is the `proof.challenge` of the BidDeclineEnvelope that attests the declaration:

```
content_hash = "0x" + hex(keccak256(DocHash))
```

DocHash is keccak256 of the URDNA2015 n-quads of the declaration with `@context` replaced by
`[BidDecline context, secp256k1recovery-2020/v2]`. The derivation is `ComputeContentHash` /
`computeContentHash` in `common/ld-data-integrity`, the same one `ComputeResponseHash` uses.

Each case holds `{name, declaration, content_hash}`. Every implementation recomputes
`content_hash` from `declaration` and asserts equality:

- Go: `bindings/go/signing` (`ComputeBidDeclineHash`), `TestConformance_Golden`
- TypeScript: `common/ld-data-integrity/typescript/src/content-hash.test.ts`
- the settler's own port, which reads this file through its `protocol` submodule

The vectors cover every `apis/decline/v1/catalog.json` code, the quote-request flow (empty `payment_id`), an empty `message`, and non-ASCII and control characters in `message`. A protocol Go test fails if a proto value gains no vector.

A string value holding a raw TAB is refused before hashing (Go and TypeScript write it
differently in N-Quads), so a producer must not put one in a declared field.

## Regenerating

The vectors live in `bindings/go/signing/conformance_test.go`. Never edit hashes by hand:

```
make -C bindings/go/signing gen-conformance
```

then rerun the Go and TypeScript tests. A changed hash for an unchanged declaration changes
every envelope's challenge and breaks verification for every deployed producer.
