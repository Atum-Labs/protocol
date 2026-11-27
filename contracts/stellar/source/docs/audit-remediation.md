# Audit remediation: error code and layout reservations

This file holds what the independent fixes for the external audit must agree on, so that
fixes written separately merge without clashing. It is not a statement of audit status.

## Error codes

Escrow and proxy codes are append-only and number-keyed clients match on them. The Stellar Asset
Contract uses codes 1 to 15 for its own errors (read from the host source at version 30), so a new proxy code must be 16 or higher.

| Contract | Code | Name | Status | Added by finding |
|---|---|---|---|---|
| Escrow | 78 | `QuoteAlreadyUsed` | shipped | 1 |
| Escrow | 79 | `DelegateEpochMismatch` | reserved, unused | 3 |
| Escrow | 80 | `FeeAboveReserveMaximum` | reserved, unused | 10 |
| Escrow | 81 | `SettlerCannotBeSelf` | shipped | 11 |
| Escrow | 82 | `TokenCallFailed` | reserved, unused | 9 |
| Proxy | 16 | `NonceAlreadyUsed` | shipped | 2 |
| Proxy | 17 | `TokenCallFailed` | reserved, unused | 9 |

Findings 3, 9 and 10 were acknowledged with no code change, so codes 79, 80 and 82 on the escrow and 17
on the proxy are not in the enums. They stay reserved so that no later error reuses a number a
reservation named; a client must not expect them.

A fix that ships does not need every row: it adds only the codes it uses, with the number reserved
here, and leaves the others unused so that fixes can land in any order.

## Layout changes

Only finding 22 changes a signed layout: it appends `deadline` to the renounce preimage. It changed the Go
and TypeScript encoders, the shared conformance vectors and `witness-layouts.md` in the same change.

The reserve preimage does not change. Finding 10 (a fee ceiling on the reserve) was acknowledged with no
code change, so the reserve digest in `witness-layouts.md` carries no `max_fee_amount` member and the
escrow does not hash one. An encoder for the reserve digest follows `witness-layouts.md`, not this file.

## Storage and ABI changes

Finding 19 changes a proxy storage key and one view, and no error code. The strict marker
`DataKey::StrictFulfilled` is keyed on `(quote_hash, to, token, amount)` instead of the quote hash, and
`is_strictly_fulfilled` takes those four fields. Markers written under the old key are not read by the new
code and nothing migrates them, so the new wasm belongs on a fresh deployment. The wasm hash moves. Disposition: fixed (it was acknowledged before).
