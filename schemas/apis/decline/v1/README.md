# Atum Bid Decline v1

## Overview

When a settler will not bid on a payment, it reports a `BidDeclined`. This directory owns
the reason set for that report, in the same shape the `apis/error/v1` catalog owns the
error code set: one `catalog.json` is the single source of truth, and every binding, wire
contract and public API projects from it.

Before this existed the reason set lived in three hand-maintained places at once. The
settler-gateway proto carried an enum with field numbers, the payment-gateway OpenAPI
carried a parallel closed enum, and payment-gw carried a Go map wiring the two together.
Adding one reason meant editing all three in lockstep, across three repositories, and a
count-pinning test existed only to make the omission loud.

## Structure

| Path | What it is |
| --- | --- |
| `catalog.json` | The reason set. Internal reason code to `{public_code, public_message}`, plus the `fallback`. |
| `schema.json` | `BidDecline`, the internal object a settler reports. |
| `openapi.yaml` | The public `DeclineReason` and `DeclineSummaryEntry` shapes to copy into a serving API. |
| `gen-codes.js` | Generates the Go constants and the TypeScript union from the catalog keys. |
| `bindings/go` | `atumdecline`: `ReasonFor`, `Known`, `AllReasonCodes`, and the generated types. |
| `bindings/typescript` | `@atum-labs/common-decline`: `reasonFor`, `known`, `ALL_DECLINE_REASON_CODES`. |

## Why a catalog and not an enum

**An unknown reason has to be counted, not rejected.** Settlers deploy independently, and
third parties run their own. A settler on a newer catalog than the gateway reading it is
the normal case. `ReasonFor` projects an uncatalogued code onto the fallback, so a decline
summary still sums to the number of settlers that declined. A closed enum cannot do this:
a generated client that closes the set rejects the whole response on a value it has not
seen, which is why the public `DeclineReason` is a pattern-constrained string.

**A reason has to survive the hop it is stored on.** The settler gateway persists the reason as text.
Reading a proto enum value the generated code does not know yields the decimal field
number, so version skew writes `14` into the database and the meaning is unrecoverable. A
catalog code writes `AWARD_WINDOW_TOO_SHORT`, which is legible immediately and resolvable
later.

**`Known` is what separates the two OTHERs.** `HOOK_DECLINED` maps to `OTHER` on purpose,
because its detail is settler-authored free text this gateway neither authors nor
validates. An uncatalogued code maps to `OTHER` because nobody here has heard of it.
`ReasonFor` cannot tell them apart and is not meant to. `Known` can.

## Adding a reason

1. Add the entry to `catalog.json`. The key is the internal code, in SCREAMING_SNAKE_CASE.
2. Run `make generate-decline` in `schemas/apis` and commit what it writes.
3. Add the matching value to the settler-gateway `DeclineReason` enum, which mirrors these
   codes for the wire.

`make check-decline-catalog` fails if the generated mirrors drift from the catalog, and
the Go and TypeScript tests fail if a generated constant names a reason the catalog does
not, or an entry carries an empty public message.

## The two reason fields on the wire

`BidDeclined` carries both `reason` (the enum) and `reason_code` (the catalog code), and a
settler populates both. Readers prefer `reason_code`. The enum stays while readers are
still migrating, since a settler and the gateway reading it deploy separately and a reader
on an older build must keep working.

## The documentation link

Every entry carries a `docs_slug`, and `docs_base_url` ends in `#` so each one is an anchor
on a single page rather than a page of its own, matching the error catalog. `ReasonFor`
joins the two into `docs_url`, and returns it empty when either is missing, so an absent
link is visibly absent rather than one pointing at the site root.

This was deferred while every error response still linked to a page that did not exist
(CORE-2224). That page is now rendered, so the links resolve rather than adding to the
dead ones, and the decline reference is generated from this catalog by the same pipeline.

## The retry classification

Every entry carries a `retry_classification` drawn from the error catalog's closed set, so
a caller reads one vocabulary across both catalogs. It answers one question: what would
have to change for a settler giving this reason to submit a price quote.

It is not the payment's instruction. A payment can fail for a reason no settler named, and
it can succeed while several settlers declined, so the authoritative value is always the
`retry_classification` on the payment's own error response. A test pins the two values a
decline may never carry, `RECONCILE_THEN_DECIDE` and `ALREADY_DONE`: a decline means that
settler did no work, and both would send a caller looking for a payment never made.
