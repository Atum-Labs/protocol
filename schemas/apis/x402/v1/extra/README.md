# AtumEscrowExtra (v1)

The `extra.atum` object carried inside an `atum-escrow` x402 `PaymentRequirements`
entry (the 402 `accepts[]`). It is the scheme-specific data the standard x402
envelope treats as an opaque `extra` bag — so it is defined and owned here, and all
three role mechanisms (client, server, facilitator) plus documentation consume the
same generated bindings.

Fields:

- `destination` — `{network, asset, address}` the merchant receives on.
- `fulfillmentAmount` — exact amount the merchant receives (atomic units).
- `quoteDeadlineSeconds` / `fulfillmentDeadlineSeconds` — recommended deadline
  budgets, relative to signing time (the client materializes absolute deadlines).
- `escrow` / `fulfillmentProxy` — source escrow / destination proxy contract addresses.
- `reserver` / `releaser` — Atum role addresses for the escrow witnesses.
- `fulfillmentVerifierEndpoint` — source-chain fulfillment-verifier endpoint.

Addresses use `$defs/chainAddress`: an EVM `0x`-hex address or a base58 address
(Solana/Tron), per the field's CAIP-2 chain — the scheme is any-source to
any-destination.

Solana-source-only fields (optional at the schema level; the facilitator requires
them for a Solana source):

- `svmSignatureClusterId` — cluster name used to build the 32-byte `cluster_id` in
  the V3 escrow signature domain.
- `svmSignatureDomainVersion` — escrow signature-domain version (V3 domain separation).

Optional on every source:

- `depositRequestHashVersions` — the depositRequestHash versions the payer may sign:
  `1` is keccak256 of the `request_id`, `2` is the hash of the payment terms, computed
  over the request body the payer then posts unchanged. Absent means `[1]`. A client
  signs `2` when the list contains it and `1` otherwise.

  Publishing it has prerequisites. This object allows no member it does not define, and
  both the client and the TypeScript facilitator check it against this schema, so a
  client or facilitator that predates the field refuses a requirement carrying it, even
  `[1]`, and the payer cannot pay. Publish it only once every payer the server serves
  and its facilitator run this release or later. List exactly what the payment gateway's
  `GET /v1/defaults` lists in `deposit_request_hash_versions` for the source chain (from
  a gateway that predates that member, `[1, 2]` once `deposit_request_hash_version` is 2),
  as mppx-atum-escrow's `corridorFromDefaults` and x402-atum-escrow's
  `depositRequestHashVersionsFromDefaults` read it. A deposit signed with a version the
  gateway does not list is refused, so once it lists only `2`, a requirement that
  publishes nothing, which payers read as `[1]`, can no longer be paid. A facilitator
  from this release accepts a v2 deposit only where the requirement lists `2`. To roll a
  client or facilitator back, stop publishing the field first.

## The deposit's issue time is not in here

A Solana deposit authorization carries an `issued_at` that anchors the escrow's replay
window. It is **not** part of this object, for two independent reasons.

Every field here has to be reproducible. The payer echoes the requirement it was quoted,
the resource server rebuilds this block on the paid request, and x402 requires the rebuilt
block to agree with the echo — so a field read from a clock makes any payment that crosses
a second boundary unmatchable.

And the merchant cannot speak for the clock that judges it. The escrow compares `issued_at`
against Solana's `Clock` sysvar, which lags real time, so a merchant wall clock sits ahead
of the judge. The payer stamps `issued_at` at signing time — from the cluster clock when it
can read one, otherwise from a back-dated local clock — which is how the Atum
payment-gateway client already does it. Note that the shared `sender-auth` libraries
default to a *raw* wall clock, so a payer building on them directly has to supply the
cluster-clock reader itself.

## The purchase identifier is not in here

An `atum-escrow` payment derives its `request_id` from an identifier for the purchase
being paid for, and the Atum network de-duplicates on that `request_id` — which is
what makes re-attempting a purchase resolve to the original payment instead of taking
a second one. Payment identity is (page, identifier, account), and the page travels in
the sibling key `extra.atumResource`, not in this object.

That identifier is **not** part of this object. It travels in the standard x402
[`payment-identifier`](https://github.com/coinbase/x402/blob/main/specs/extensions/payment_identifier.md)
extension, in the `extensions` map of the 402 response and of the payment payload —
see [`../payload`](../payload) for the payload side.

Keeping it there rather than in a scheme-specific `extra` field means it is supplied
through a mechanism the x402 specification already defines for exactly this purpose,
by a payer that need not know anything about this scheme: the resource server declares
the extension, the payer names the purchase, and the facilitator re-derives
`request_id` from the value that arrives. `extra.atum` stays what its name suggests —
corridor data the payer reads to build the payment locally.
