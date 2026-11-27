# BidAwardEnvelope/v1 cross-language conformance

This directory pins the Go ↔ TypeScript interoperability contract for the
BidAwardEnvelope `award_hash` binding:

- `signing/go` (`ComputeAwardHash`, Go)
- `signing/typescript` (`computeAwardHash`, TS)

The contract is: **the `award_hash` computed in one language MUST equal the
value computed in the other**, byte-for-byte, for the same inputs.

`award_hash` is the `proof.challenge` of an award-authority VP — it binds a
holder-signed BidAwardEnvelope to a specific
`(payment_id, quote_hash, settler_id)` award decision so a captured VP cannot be
replayed across awards. It is **signature-binding, not an identifier**: never
index by it, look a record up by it, or commit it on-chain.

```
award_hash = "0x" + hex(keccak256(utf8(
    domain_separator "\n" payment_id "\n" quote_hash "\n" settler_id)))
```

## The golden file

`award-hash-golden.json` holds the frozen vectors:

- `domain_separator` — the exact namespacing string (`atum:award_hash:v1`).
  Both bindings assert their constant equals this.
- `cases[]` — `{name, payment_id, quote_hash, settler_id, award_hash}`. Each
  binding's conformance test recomputes `award_hash` from the inputs and asserts
  it equals the recorded value.

Because both languages assert against this one file, matching it on both sides
means they match each other. The Go side runs in
`signing/go/conformance_test.go` (`TestConformance_Golden`); the TS
side in `signing/typescript/src/conformance.test.ts`.

## Regenerating

The golden is generated from the Go binding (the canonical source). To change
it deliberately — a new case, or a preimage-layout change — regenerate from
`ComputeAwardHash` and update both bindings' expectations in the same commit:

1. Add/adjust the inputs.
2. Recompute every `award_hash` with the Go `ComputeAwardHash` (do **not**
   hand-edit the hashes — derive them from code).
3. Rerun `go test ./signing/go/...` and the TS
   `vitest run` — both conformance tests must pass against the new file.

**A preimage-layout change (different field set, order, separator byte, or
domain separator) MUST bump the `domain_separator` `v1` suffix** — the value
ships in `proof.challenge` to external clients, so an unversioned change
silently breaks verification everywhere.
