# Atum Common Error Schema v1

## Overview

The `AtumError` schema defines a standardized error structure used across all Atum services. This provides consistent error reporting, machine-readable error codes, and rich contextual information for debugging and automatic retry logic.

## Design Philosophy

The error schema follows a **hybrid approach** that combines:

1. **Ethereum JSON-RPC style** - structured error objects with codes and messages
2. **HTTP REST conventions** - domain tracking and severity levels
3. **Distributed systems patterns** - request IDs, retry information, and rich context

## Schema Structure

### Core Fields (Required)

- **`code`** - Machine-readable error identifier in SCREAMING_SNAKE_CASE
  - Pattern: `^[A-Z][A-Z0-9_]*$`
  - Examples: `TX_REVERTED`, `CHAIN_NOT_SUPPORTED`, `COUNTERPARTY_TIMEOUT`

- **`message`** - Human-readable error description (max 500 chars)
  - Should be clear and actionable
  - Avoid exposing sensitive information

- **`timestamp`** - ISO 8601 formatted time when error occurred
  - Critical for debugging and correlation

- **`request_id`** - Distributed request identifier
  - Enables correlation across multiple services
  - Use existing request ID from request context

### Context Fields (Optional but Recommended)

- **`domain`** - Service domain where the error originated
  - Helps trace errors across service boundaries
  - Values: `PAYMENT_GATEWAY`, `SETTLER_GATEWAY`, `SETTLER_AGENT`, etc.

### Extended Context

- **`details`** - Flexible key-value pairs for additional context
  - Service-specific error details
  - Request parameters that caused the error
  - Available vs required values

- **`blockchain_context`** - Blockchain-specific error information
  - Chain ID, transaction hash, revert reasons
  - Gas usage and estimates
  - Contract addresses involved

## Error Code Conventions

### Code Structure

Error codes should follow this pattern:
```
{CATEGORY}_{SPECIFIC_ERROR}
```

### Common Categories

Prefixes group by what was wrong with the request:

- **`INVALID_*`** (11) - the value is malformed (e.g. `INVALID_REQUEST`, `INVALID_AMOUNT`). `INVALID_PRESENTATION` is the exception: it is a 401 for a presentation that did not verify, which can be well formed.
- **`UNSUPPORTED_*`** (4) - the value is well formed but not served (e.g. `UNSUPPORTED_DESTINATION_CHAIN`)
- **`MISSING_*`** (6) - a required field or parameter is absent (e.g. `MISSING_DESTINATION`)

Prefixes also group by the subsystem that failed:

- **`WALLET_*`** (6) - wallet orchestration (e.g. `WALLET_KMS_ERROR`)
- **`FULFILLMENT_*`** (5) - fulfillment deadlines and verification (e.g. `FULFILLMENT_DEADLINE_EXPIRED`)
- **`COUNTERPARTY_*`** (4) - counterparty gateway and its webhooks (e.g. `COUNTERPARTY_TIMEOUT`)
- **`QUOTE_*`** (7) - quoting, auctions and awards (e.g. `QUOTE_DEADLINE_EXPIRED`, `QUOTE_REQUEST_ALREADY_AWARDED`)
- **`CHALLENGE_*`** (2) - session nonces and challenges (e.g. `CHALLENGE_REPLAYED`)
- **`CREDENTIAL_*`** (2) - credentials carried in a presentation (e.g. `CREDENTIAL_UNTRUSTED`)

Suffixes group by outcome, so read them as `*_SUFFIX` rather than `SUFFIX_*`:

- **`*_UNAVAILABLE`** (5) - a dependency is down (e.g. `SERVICE_UNAVAILABLE`)
- **`*_EXPIRED`** (6) - e.g. `PAYMENT_EXPIRED`, `QUOTE_DEADLINE_EXPIRED`, `CHALLENGE_EXPIRED`, `TOKEN_EXPIRED`
- **`*_NOT_FOUND`** (6) - e.g. `NOT_FOUND`, `COUNTERPARTY_NOT_FOUND`, `QUOTE_NOT_FOUND`
- **`*_TIMEOUT`** (2) - `COUNTERPARTY_TIMEOUT`, `VERIFICATION_TIMEOUT`
- **`*_MISMATCH`** (7) - e.g. `IDEMPOTENCY_TERMS_MISMATCH`, `AMOUNT_MISMATCH`, `PERMIT_AMOUNT_MISMATCH`
- **`*_LIMIT_EXCEEDED`** (3) - a limit refused the request: `RATE_LIMIT_EXCEEDED`, `AMOUNT_LIMIT_EXCEEDED`, `VOLUME_LIMIT_EXCEEDED`

`catalog.json` is the full list. Do not invent a code without adding it there.

## The Error Catalog

`catalog.json` maps each internal reason a request can fail to the single error a
caller actually receives: a public `code`, a human-readable `message`, an HTTP
status, and a documentation link. Services resolve an error through the catalog
rather than writing a status and a message at the point of failure, so the same
condition always presents identically no matter which service produced it.

For an integrator, that means:

- **`code` is the stable contract.** Branch on it. Many internal conditions can
  collapse onto one public code — several distinct settlement faults all surface
  as `SETTLEMENT_FAILED`, because the distinction between them is ours to act on,
  not yours.
- **`message` is safe to show a person** and safe to log. It never contains
  internal identifiers, addresses, or the name of the component that failed.
- **`http_status` follows the code**, not the endpoint. A given code always
  arrives with the same status.
- Any code the catalog does not recognise resolves to `INTERNAL_ERROR` / `500`,
  so an unknown failure is never reported as a client mistake.

### Codes that carry a factual guarantee

Most codes describe *what went wrong*. A few also promise *what did not happen*,
and those promises are part of the contract:

| Code | Guarantee |
|---|---|
| `SERVICE_PAUSED` | The request performed no work and left no state behind. Nothing was signed, submitted, or recorded for it. Retrying the identical request once the pause is lifted is safe and cannot produce a duplicate. |
| `SETTLEMENT_FAILED` | The opposite — the on-chain outcome is **not** known. Reconcile by payment id before retrying. |

A service may only return `SERVICE_PAUSED` for a request that genuinely did
nothing. A request that was already accepted, or that resolved against work
recorded earlier, must be answered on its own merits — with its existing result,
or with the error that actually applies. Returning `SERVICE_PAUSED` for such a
request would tell the caller that nothing happened when something did, which is
the one mistake this code exists to prevent.

### Limit refusals

A payment refused for a dollar limit names the limit, so a caller can tell it from any
other decline:

| Code | Limit | What the caller does |
|---|---|---|
| `AMOUNT_LIMIT_EXCEEDED` | The per-payment amount limit for the paying account. | Contact support: a larger payment needs a higher limit. |
| `VOLUME_LIMIT_EXCEEDED` | The paying account's daily limit on the total it can pay. | Retry after a delay: the daily total resets at 00:00 UTC. |

Both are `403`, the status these refusals had before they had their own codes. Neither
message states the limit's amount, what is left of it, or the caller's tier.

Every other decline, including any sanctions or screening decline, stays
`AUTHORIZATION_DECLINED` with no reason. A decline is reported as a limit only when the
limit is the one check that refused the payment.

## Example Files

The following example files demonstrate different error scenarios:

- **`example.json`** - Service-level error (BROADCAST_REJECTED)
- **`blockchain-example.json`** - Blockchain transaction error (TX_REVERTED)
- **`validation-example.json`** - Input validation error (UNSUPPORTED_DESTINATION_CHAIN)

Validate examples using:
```bash
./bin/schema-validator --examples apis/error/v1/
```