# Pre-v4 Solana IDLs

The Anchor IDLs of the Solana programs that were served before v4. Use them to decode events
those programs emitted. `../../src/generated/` describes v4 and does not decode them.

| Program | Id | Active on mainnet | IDL |
|---|---|---|---|
| escrow | `44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs` | 2026-04-15 to 2026-09-16 | `escrow.json` |
| fulfillment_proxy | `77AqGeSh3GLFcBwSxdTnefgv92Cosi9o6NsK992TZsRe` | 2026-04-15 to 2026-09-21 | `fulfillment_proxy.json` |

These are snapshots, not build output, so `sync-idl` does not touch them and they must never
be refreshed from a current build. `escrow.json` is `src/generated/escrow.json` as of
`1d11a479`, and `fulfillment_proxy.json` is `src/generated/fulfillment_proxy.json` as of
`c4a94818`, byte for byte.

## How they were verified

`node scripts/check-deployed-events.mjs --program <id> --idl idl-history/pre-v4/<file> --limit 5000`
was run against each program's whole mainnet history: 276 successful escrow transactions
and 161 successful proxy transactions. Every event either program emitted has the
discriminator and payload length these IDLs give, and the money events decoded with them
agree with what each transaction shows independently (token transfers, balances, the
deposit PDA, the instruction's args and accounts):

| Event | Seen | Fields value-checked |
|---|---|---|
| escrow `Deposited` | 131 | 9 of 9 |
| escrow `Reserved` | 131 | 2 of 2 |
| escrow `Released` | 122 | 7 of 7 |
| fulfillment_proxy `StrictFulfilled` | 151 | 8 of 8 |

Pre-v4 `reserve` left the deposit's fee alone, so `Deposited.fee_amount` is checked against
the fee the treasury received on release. `StrictFulfilled.payment_id` and `from` are
checked against the `strict_fulfill` arg and the settler account.

`deployed-events.test.ts` pins the layouts below so a refresh fails, and
`event-values.test.ts` checks a real pre-v4 deposit, reserve and release
(`testdata/mainnet-pre-v4-*.json`) against these IDLs.

## What differs from v4

The discriminators are the same; the payloads are not.

| Event | Pre-v4 bytes | v4 bytes | Change |
|---|---|---|---|
| escrow `Released` | 104 | 136 | `quote_hash` appended |
| escrow `Reserved` | 64 | 112 | `quote_hash`, `source_amount`, `fee_amount` appended |
| fulfillment_proxy `StrictFulfilled` | 160 | 128 | `payment_id` replaced by `quote_hash`, `from` removed |

For the two escrow events a pre-v4 payload is a prefix of the v4 one, but `StrictFulfilled`
was restructured: from `token` on its fields do not line up, so it needs this IDL, not the v4
one truncated. `Deposited` is unchanged.

The pre-v4 escrow never emitted `Refunded` on mainnet, so its `Refunded` layout here (72 bytes)
comes from the IDL alone and has not been checked against the chain.
