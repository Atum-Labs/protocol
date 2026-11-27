# Counterparty gateway webhook contract changelog

This contract is implemented by **external beneficiary PSPs**, so a change here
is a change to somebody else's code. Every entry states whether an existing
integration has to do anything.

The spec itself is the source of truth. This file exists so an integrator can
see what moved and when without diffing the spec against a previous release.

## Unreleased

### The error body is documented as advisory rather than required reading

`ErrorResponse`'s description now says what Atum actually does with a 4xx or 5xx
body: nothing. The webhook caller records a non-200 as a webhook error from the
status code alone and never parses the body.

**Action for integrators: none.** This corrects the description, not the schema.
A PSP already returning this shape keeps working, and one returning a different
body was never treated differently.

The previous description asked a PSP to emit a `code` from Atum's own error
catalog and to use `request_id` to correlate against an Atum-side record. Both
read as requirements on the PSP and neither was ever enforced or read.

## 2026-07 — the error body became the shared Atum error shape

Landed in atum-core `0991eac70`, "Adopt the shared ErrorResponse in
beneficiary-psp and align the webhook error contract" (#1147), as part of a
wider internal move onto one error shape.

The 4xx and 5xx response bodies changed from the previous webhook-local shape to
the shared shape, which requires `code` and `message` and adds optional
`request_id`, `payment_id`, `docs_url` and `domain`.

**Action for integrators: none, in practice.** Atum reads only the HTTP status
on this path, so a PSP still returning the old body is unaffected. That is why
nothing broke when this shipped.

**What went wrong with it.** This is an externally implemented contract and the
change went out inside an internal cleanup, with no ticket and no notice to the
PSPs who implement it. CORE-2226 exists because of that rather than because the
new shape is wrong. The new shape is the right one.
