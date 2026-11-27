# Idempotency

Send the same request twice — a retry, a timeout, a network blip — and it should
count once, not twice, and give you the **same** answer both times. On a payment
that means you are charged once. The key to both properties is the `request_id`
you send.

One contract covers every write endpoint. Today that is `submitPayment` and
`createQuoteRequest`; they use the same key, reject the same misuse the same way,
and report a replay the same way, so what you learn on one applies to the other.
Where an endpoint genuinely differs it is called out inline.

## Using the SDK

With `@atumlabs/payment-gateway-client` this is automatic. Pass a stable
`request_id` and reuse it on retry. `request_id` is required on the payment path
(`preparePaymentRequest`); the SDK derives the on-chain deposit nonce
deterministically from it, so both guarantees below line up on their own. You
never manage nonces — `request_id` is the only value you control.

Reuse the same `request_id` across attempts of the same logical request. Use a
fresh `request_id` only when you genuinely mean a new one.

A deposit you fund yourself with `prepareDirectDepositRequest` is the exception: you choose its
nonce, and the rules change. See [Direct deposits](#direct-deposits).

Both builders require it: `preparePaymentRequest` and `prepareQuoteRequest` each
take `requestId` explicitly, and neither invents one. That is deliberate — an id
the library chose for you is an id you cannot reuse on a retry, so the retry would
create a second payment or open a second batch rather than recovering the first.

The CLIs are the exception, because a command invocation is a one-shot request:
`send-payment` and `request-quote` generate an id when `--request-id` is omitted
and print it back, so you can re-run with `--request-id <id>` to retry the same
one. A bare re-run, with no `--request-id`, is a **separate** payment or batch.

## The two guarantees

### 1. Gateway dedup — every write endpoint, every caller

The gateway records your `request_id` (scoped to your source account and signing
identity). If the same `request_id` arrives again, the gateway returns what it
created the first time and creates nothing new:

| Endpoint | A repeat returns | And does not |
| -- | -- | -- |
| `submitPayment` | the original payment — same `payment_id`, status and receipt | create a second payment or broadcast a second deposit |
| `createQuoteRequest` | the original batch — same `quote_request_id` and its quotes | open a second batch or re-broadcast to settlement agents |

This holds whether you use the SDK or call the API directly, as long as you send a
stable `request_id` and reuse it on retry.

"The same request" is the one condition: an id re-used for *different* economics
is rejected rather than replayed. See
[Reusing an id for different terms is rejected](#reusing-an-id-for-different-terms-is-rejected).

### 2. On-chain single-settlement — payments only, enforced by the blockchain

This second guarantee applies where funds move, which today means `submitPayment`.
A quote-request authorizes no spend — it carries no `sender_auth` and no deposit
nonce — so guarantee 1 is the whole mechanism there. Nothing is charged either
way; what a retry protects on that endpoint is your ability to find the batch
again.

Each deposit authorization carries a nonce, and the chain guarantees a given
nonce can settle at most once. This ties your retries together on-chain **only
if** each retry carries the **same** nonce. The SDK derives that nonce from your
`request_id`, so retries reuse it automatically. A direct caller sets the nonce
themselves in the signed permit.

A changing `request_id` defeats both guarantees, because each attempt is then
treated as a different request — keep it stable and reuse it on retry.

## Reusing an id for different terms is rejected

One `request_id` identifies one payment, or one quote-request batch, so it cannot
be pointed at different economics. Re-submit an id you have already used with a
changed amount, token, account or destination and the gateway answers **`409`**
with `IDEMPOTENCY_TERMS_MISMATCH` rather than acting on it, and rather than
quietly serving you the original.

What counts as "different economics" is who pays, who receives, in which assets,
and for how much — the terms that decide where the money goes. Change any of them
and you get the `409`; the error's `message` names the category that differed. A
genuinely different request needs a new `request_id`, which is what the error is
telling you.

On a quote-request the `409` is doing the same job one step earlier: without it
you would silently receive the batch you opened *earlier*, whose quotes price the
corridor you asked for then — and awarding one of those settles a payment on that
corridor, not the one you meant.

Anything outside that list is taken from what already exists, and the value you
sent is not applied. So a re-submission is not a way to amend something in flight;
it is a way to ask for the one you already made.

### Deadlines and the signature are exempt

Two things you may freely change on a re-submission, because neither identifies
the request:

- **Deadlines.** Re-send the original bytes unchanged and the deadlines will
  usually have expired by then: `quote_deadline` is short — it bounds the auction
  on a payment and the collection window on a quote-request — and either endpoint
  can take longer than that to answer. An expired deadline on a re-submission is
  **not** an error; the request resolves onto what already exists, so nothing is
  scheduled against it.
- **The signature.** Re-signing is fine. So is re-sending the original signature.

Which means both retry styles work: keep the exact bytes from the first attempt,
or rebuild and re-sign. What must not change is the `request_id`.

One consequence is specific to quote-requests: **the collection window belongs to
the batch, not to your request.** Asking again with a later `quote_deadline` does
not extend a window already open. The `quote_deadline` you get back is the
batch's own, and `status` tells you whether collection is still running. This is
the one place where a re-submission returns something that may not match what you
just sent — by design, because the response has to describe the batch you
actually received.

## Telling a retry from a first attempt

`idempotent_replay` is `true` when you have been handed something that already
existed, and `false` when this request created it. Every write response carries
it — `PaymentResponse`, `QuoteRequestResponse` and `QuoteRequestAccepted`. Read it
if you need to distinguish "this went through just now" from "this was already
there" — for logging, for reconciliation, or to avoid double-counting a
conversion.

It is always present, so `false` means `false`. A response missing the field
altogether is from a gateway predating it.

## Reading the outcome (payments)

`status` is on every payment response, and its endings mean different things for a retry:

| `status`               | What it means                     | What to do                                             |
| ---------------------- | --------------------------------- | ------------------------------------------------------ |
| `completed`            | Settled and final.                | Nothing. `transactions` carries the deposit and payout transactions. |
| `pending`              | Accepted, still settling.         | Re-submit the **same** `request_id`, or read the status endpoint. Do not start a new payment. |
| `finalizing`           | Paid on chain, not yet final.     | As `pending` for a retry. Acting on it before `completed` is your risk. |
| `failed`               | Terminal — it can never complete. | A fresh attempt needs a **new** `request_id`.          |
| `refunding`            | Not delivered, the escrowed funds are being returned. Not final. | As `pending`. |
| `refund_available`     | Not delivered, funds still in escrow. The status endpoint returns `refund_signature`. Not final. | Submit `refund_signature` to the source escrow to return the funds. Do not start a new payment until it is `refunded`: a late delivery can still complete it. |
| `refunded`             | Terminal, not delivered. The funds were returned. | A fresh attempt needs a **new** `request_id`. |

`pending` is not success. Cross-chain settlement can outrun the gateway's
synchronous window, so a payment that has been accepted may still have no result
when you get your response.

A terminal payment **keeps** its `request_id`. Re-submitting that id returns the
same payment for good, which is why recovering from one means minting a
new id — the opposite of what a pending payment needs. Getting these two the
wrong way round is how a caller either pays twice or waits for something that
will never happen.

### How to learn the outcome

Either works, and you can mix them:

- **Poll `GET /v1/payments/{payment_id}/status`** — cheapest once you hold a
  `payment_id`. This is what the `payment-status` CLI does, and what
  `send-payment --wait` does after submitting.
- **Re-submit the same request** — idempotent, and it returns the payment's
  current state. Useful when you would rather not track `payment_id`, or when the
  first attempt failed before you learned one.

If you are building a *merchant* that mediates someone else's HTTP request,
prefer having the payer re-attempt over polling inside that request: polling
holds the connection open for the whole settlement window. That constraint is
specific to sitting in the middle of someone else's request, and does not apply
to a backend calling this SDK directly.

## Recovering a lost quote-request response

The rules above are all you need for payments. On `createQuoteRequest` they add up
to one workflow worth spelling out, because it is the reason the endpoint behaves
this way.

If you lose the create response, re-send the request. You get your
`quote_request_id` back and can read the batch's quotes — rather than being told
your `quote_deadline` has expired while holding no id to look the batch up with.
The collection window is short, so by the time you retry it usually *has* expired;
that is exactly the case the deadline exemption exists to cover.

## Chain-specific behavior

The SDK gives you the same guarantee on every chain; the on-chain half works
slightly differently underneath:

- **EVM / Tron:** the on-chain nonce is spent permanently, so guarantee 2 lasts
  indefinitely.
- **Stellar:** the escrow records every spent deposit nonce permanently, so guarantee 2
  lasts indefinitely, as on EVM. The SDK derives the nonce from `request_id` and the
  depositor, so a rebuild reuses it; a rebuilt deposit has a later `issued_at` and is a
  different signature, but the escrow accepts only the first that reaches it.
- **Solana:** the on-chain guard covers only a short, bounded window (roughly two
  minutes). Beyond that window the durable protection is guarantee 1 (the
  gateway's `request_id` record). The SDK keeps a rebuild inside the window by
  pinning `issued_at` through its Solana clock reader, so you do not have to.

Either way, a stable `request_id` keeps you safe on every chain.

## Direct deposits

A deposit you fund yourself (`prepareDirectDepositRequest`, then `approve` and `directDeposit`)
keeps guarantee 1 but changes guarantee 2, because the on-chain nonce is yours rather than
derived from `request_id`:

- The escrow accepts each `depositNonce` once per depositing wallet. A retry that uses a new
  nonce is a second deposit, so store `requestId`, `depositNonce` and the returned
  `depositRequestHashVersion` before you fund, and the request as you submit it, and reuse them.
  `deriveDirectDeposit` gives the deposit back from the stored request and version.
- Nothing expires an unreserved deposit. It stays in escrow until a settler reserves it or you
  refund it with `refundUnreserved` from the wallet that made it.
- Prepare once, and submit the bytes you funded. A rebuilt request has new deadlines, and under
  depositRequestHash version 2 the deadlines are part of the deposit, so it names a different
  deposit, one you did not fund. If this `request_id` already holds a payment that differs from
  the rebuilt request only in its deadlines, the gateway answers with that payment; if not, the
  rebuilt request becomes a payment for a deposit nobody funded.

The payment id is the deposit id (`deposit.depositId`) when the deposit commits the
depositRequestHash version the gateway derives direct deposits at when you submit. Leave
`depositRequestHashVersion` unset and `prepareDirectDepositRequest` builds at the version the
gateway publishes in `GET /v1/defaults`, and refuses a version you pass that differs from it,
before you fund, so a deposit you prepare after the gateway changes version needs no change on
your side. That does not hold for a deposit you funded but had not yet submitted when the
gateway changed version: the gateway derives the payment at its new version, the `payment_id` it
returns differs, the payment names no deposit, no settler can reserve yours, and you refund it
with `refundUnreserved`. Keep the time between preparing and submitting as short as finality
allows.

What to do after each answer, once you have funded. Below, `deposit.depositId` is the id of the
deposit you funded, returned with the request you funded; never take it from a request you
prepared again, which names another deposit.

| Gateway answer | What it means here | What to do |
| --- | --- | --- |
| `200` with the original payment | The stored bytes were accepted, or replayed. This holds even after `quote_deadline`. | Check that `payment_id` is `deposit.depositId`, then follow the payment's status. |
| `200` with a `payment_id` that is not `deposit.depositId` | The gateway derived the payment at another depositRequestHash version than the deposit commits, or this `request_id` holds another submission's payment, one with your terms and other deadlines. No payment holds your deposit. | Refund the deposit now, and prepare again with `depositRequestHashVersion` unset (or, where the gateway publishes none, the version its operator gives you) and a new `request_id` and `depositNonce`. If the refund reverts because the deposit is already reserved, do not fund again: contact support with the `request_id` and `deposit.depositId`. |
| `409 CONFLICT` with a `payment_id` | That payment holds terms other than the ones you sent, and it may hold your deposit. | Do not use a new `request_id` and do not fund again, whatever the error's retry guidance says. Re-submit the exact bytes you funded: a `200` whose `payment_id` is your `deposit.depositId` is your payment, so follow it. `CONFLICT` again means no payment holds your deposit on your terms: attempt `refundUnreserved` at once, and once it succeeds start again with a new `request_id` and a new `depositNonce`. If it reverts because the deposit is already reserved, contact support with the `request_id` and `deposit.depositId`. |
| `409 IDEMPOTENCY_TERMS_MISMATCH`, and re-submitting the exact bytes of an earlier submission gets a `200` | The gateway accepted those earlier bytes. The bytes you just sent differ from them. | Check that the `200`'s `payment_id` is `deposit.depositId`, then follow that payment. Do not use a new `request_id` and do not fund again, whatever the error's retry guidance says: on this path that is a second deposit. If you funded more than one deposit, refund only the one no payment names. |
| `409 IDEMPOTENCY_TERMS_MISMATCH` on your first submission, or when no earlier submission's exact bytes get a `200` | Another submission already holds this `request_id`, with other terms. An earlier attempt answered `400` or `503` stored nothing, and one that got no answer was stored only if its bytes now get a `200`. | Attempt `refundUnreserved` at once, without waiting for any payment to fail. Once the refund succeeds, prepare and fund again with a new `request_id`, a new `depositNonce` and `depositRequestHashVersion` unset (or, where the gateway publishes none, the version its operator gives you). If it reverts because the deposit is already reserved, do not fund again: contact support with the `request_id` and `deposit.depositId`. |
| `400 QUOTE_DEADLINE_NOT_FUTURE` or `FULFILLMENT_DEADLINE_NOT_FUTURE` | Nothing was stored. | Deposit at version 1: prepare again with the same `requestId` and `depositNonce` you stored and `depositRequestHashVersion` unset where the gateway publishes one, and submit only if the returned `depositRequestHashVersion` is the one you stored and `deposit.depositId` is the one you funded; otherwise refund the deposit with `refundUnreserved` and start again. Pass the stored version only to a gateway that publishes none: at version 1 the method then reports the deprecation warning, and under `--throw-deprecation` it rejects, so refund the deposit there. Version 2: refund the deposit, then prepare and fund a new one with a new `depositNonce`. |
| Another `400`, such as `MALFORMED_REQUEST_BODY` or `INVALID_REQUEST_ID` | Nothing was stored. | Deposit at version 1: if `requestId` is invalid, refund the original deposit before starting again. Otherwise prepare with corrected terms, the same `requestId` and `depositNonce`, and `depositRequestHashVersion` as in the deadline row above: unset where the gateway publishes one, the stored version only where it publishes none. Submit only if the returned `depositRequestHashVersion` is the one you stored and the new `deposit.depositId` is the one you funded; otherwise, or if the method rejects under `--throw-deprecation`, refund the original deposit with `refundUnreserved` before starting again. Version 2: refund the deposit before preparing and funding a corrected request with a new `depositNonce`. |
| `503 SERVICE_PAUSED` | Nothing was stored. | Re-submit the same bytes later. If the deadlines have passed by then, follow the deadline row. |
| Payment `failed` with `NO_QUOTES_RECEIVED`, `QUOTES_EXPIRED` or `NO_SETTLER_FOR_CORRIDOR` | No settler reserved the deposit. | Refund the deposit. A new attempt needs a new `request_id` and a new `depositNonce`, whatever the error's retry guidance says about the `request_id` alone. |
| Payment `failed` with any other code | A settler may have reserved the deposit before the payment failed, or it may already be settled. | Try `refundUnreserved`. If it reverts while the escrow is paused, try again later; otherwise contact support with the `payment_id`, and do not fund again. |

Refund only once the payment has failed, the gateway never stored it, it stored it under
another id, or you got one of the `409` answers above and none of your earlier bytes gets a `200`. A refund
succeeds only while the deposit is unreserved. A refund and a settler's reservation race on the
source chain, and whichever lands first wins.

Keep `request_id` undisclosed until you submit it, under either version: a submission that
takes it first blocks yours, and under version 1 it can also bind your deposit to other terms.
When the deposit commits version 1, whether you passed it or the gateway published it,
`request_id` has to be a UUIDv4 from `randomUUID()`; `prepareDirectDepositRequest` refuses any
other id at that version. Use `randomUUID()` for every direct deposit, so a gateway changing
version never changes what you send. Persist it with `depositNonce` and the returned
`depositRequestHashVersion` before funding, and reuse them for this deposit. Version 1 is
deprecated for direct deposits and will be retired.

## A note on addresses

EVM `0x` addresses are case-insensitive, so casing never affects your payment.
Solana and Tron base58 addresses **are** case-sensitive — pass them exactly as
issued.
