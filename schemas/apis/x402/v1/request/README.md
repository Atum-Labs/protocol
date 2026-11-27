# AtumEscrowRequest (v1)

The MPP `charge` **challenge request** — the method-specific `request` blob inside
an mppx `Challenge`. Unlike the HTTP x402 transport (§3.1 of the scheme spec), MPP
has no `accepts[]` envelope, so the source option the payer funds from rides here
alongside the reused `extra` (`AtumEscrowExtra`, `../../extra/v1`) instead of at the
`accepts[]` top level.

Fields:

- `source` — `{network, asset, amount}` the payer funds from. `amount` is the source
  spend cap (`fulfillmentAmount` + markup), i.e. the authoritative `max_source_amount`
  the payer signs.
- `extra` — the destination/corridor block; `$ref`s the canonical `AtumEscrowExtra`
  so the receive-side definition is owned in one place.

One source option per challenge; a 402 may advertise several challenges to offer
several source options. `schema.json` is the source of truth; `example.json` is
validated against it.
