# Awarding a quote

A quote request lets settlers compete on price before anything is signed. You open it, read the
quotes, choose one, and award it. Only the award signs, and it signs for the chosen quote's exact
`source_amount`.

| Step | Call | Signs |
|---|---|---|
| 1. Build the quote request | `prepareQuoteRequest` | nothing |
| 2. Open it and collect quotes | `quoteRequests.createQuoteRequest` | nothing |
| 3. Check a quote (optional) | `verifyFulfillmentQuote` from `/signing` | nothing |
| 4. Award the chosen quote | `awardQuote` | the deposit and the reserve |

## On Stellar

A Stellar award is signed as on the other chains, with these differences:

- `sender_auth` is signed by the payer's delegate signer, not by the `source.account` key, so pass
  the delegate signer's signer as `depositorSigner`. The payer registers it once with
  `createStellarDelegate` (see the [README](../README.md)). The signer may be the payer's own key or a
  separate one. An award signed by a separate delegate is built and signed here, but an offline
  verifier (`verifyPaymentRequest`) refuses it with `DelegateUnverifiedError`, because the delegate
  record is on chain: only a verifier that reads the escrow's `get_delegate` can admit it.
- The deposit commits to the epoch of that delegate record. `awardQuote` reads it from the escrow
  through the Soroban RPC (`stellarRpcUrl`), or takes `stellarDelegateEpoch`; it fails when the payer
  has no delegate registered. When it reads the record it also refuses one the escrow would reject at
  `deposit` (expired at `issued_at`, no capacity left, or, when you pass `stellarSigningKey`, a
  registered signer that is not that key) before anything is signed. A supplied epoch or an
  epoch-only `stellarDelegateEpochReader` reads no record, so none of that is checked.
- Before it signs, `awardQuote` runs the Stellar signing guard that `signPaymentRequest` runs: the
  deposit message must be the digest of its own `message_prehash` under the quote request's network and
  escrow, and a signer bound to another network (`signer.network`, as the private-key signer's is) is
  refused, for the deposit and for the reserve. A custom signer with no `network` is admitted.
- The `quote_selector` must be a `G...` account, and its ed25519 key signs the reserve. Pass its signer
  as `selectorSigner`; a reserve signed by any other key is refused before the award is sent.
- The deposit must fall within 24 hours: its `fulfillment_deadline` has to be less than a day after
  you award.
- The payment id is the deposit digest the delegate signer signed.

## Who signs what

An award carries two signatures:

| Signature | Signed by | What it authorizes |
|---|---|---|
| `sender_auth` | the owner of `source.account` | the escrow deposit, for exactly the quote's `source_amount` |
| `reserve_auth` | the quote request's `quote_selector` | reserving that deposit for the chosen settler, at that amount |

`quote_selector` is the account that chooses the quote. The deposit names it, and only its
signature can reserve the deposit for a settler. There are two ways to set it:

- **You choose for your own deposit.** Leave `quoteSelector` unset. `prepareQuoteRequest` names
  the depositor, and one signer signs both messages.
- **Someone else chooses for the depositor**, for example a payment provider that awards quotes for
  its customer's wallet. Pass that account as `quoteSelector` when you build the quote request,
  and pass its signer as `selectorSigner` when you award.

The gateway's own selector from `GET /v1/defaults` cannot sign an award, so `prepareQuoteRequest`
refuses it.

## Awarding from the SDK

```typescript
import { PaymentGatewayClient, createSenderSigner } from '@atumlabs/payment-gateway-client';
import { verifyFulfillmentQuote } from '@atumlabs/payment-gateway-client/signing';

const client = new PaymentGatewayClient({ BASE: 'https://payment-gw.production-testnet.atum.xyz' });

// 1-2. Build and open the quote request. Keep the body: the award signs it.
const quoteRequest = await client.prepareQuoteRequest({
  depositor: '0xF0D07a1c182Bc68a757C641014e0bAE7C4f17640',
  fulfillmentAmount: '100000',
  sourceAsset: 'eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  destinationAccount: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  destinationAsset: 'eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
  maxSourceAmount: '101000',
  requestId: 'quote-order-1234',
});
const opened = await client.quoteRequests.createQuoteRequest({
  requestBody: quoteRequest,
  wait: true,
});

// 3. Read the quotes. While the status is `collecting`, more may still arrive.
const batch = await client.quoteRequests.getQuoteRequestStatus({
  quoteRequestId: opened.quote_request_id,
});

// Choose one. Here: the cheapest signed by a settler you accept.
const trustedSettlers = new Set(['did:pkh:eip155:1:0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc']);
let chosen;
for (const quote of batch.quotes ?? []) {
  const check = await verifyFulfillmentQuote(quote);
  if (!check.valid || !trustedSettlers.has(check.signerDID!)) continue;
  const amount = BigInt(quote.fulfillment_quote.source_amount as string);
  if (!chosen || amount < BigInt(chosen.fulfillment_quote.source_amount as string)) {
    chosen = quote;
  }
}
if (!chosen) throw new Error('no quote to award');

// 4. Award it.
const { paymentId, response } = await client.awardQuote({
  requestId: 'award-order-1234',
  quoteRequestId: opened.quote_request_id,
  quoteRequest,
  quote: chosen,
  depositorSigner: createSenderSigner('eip155:42161', { privateKey: process.env.PRIVATE_KEY! }),
});
console.log(paymentId, response.status);
```

From here the payment is tracked like any other, with `getPaymentStatus` or `waitForStatus`. See
[Tracking a payment](../README.md#tracking-a-payment).

### What `awardQuote` checks before it signs

It refuses these before it signs anything:

- a quote that is not for this quote request: its `payment_request_json` must commit this body, and
  its `source.account` must be this body's;
- a quote whose `award_deadline` has passed, unless it carries `awarded_payment_id` (see
  [Retries](#retries));
- a quote whose `source_amount` is above the request's `max_source_amount`;
- a quote request that names no `quote_selector`, or a blank one;
- a quote request that names another account as `quote_selector`, when no `selectorSigner` is
  passed.

It does not judge the settler, and it signs the quote's `source_amount` and `settler_address` as
given. `verifyFulfillmentQuote` checks that a quote's signature verifies and that `quote_id` is its
hash, and returns the signer's DID as `signerDID`. A valid signature alone says only that some key
signed the quote: compare `signerDID` with the settlers you accept, as the example does. When the
quote request sets `max_source_amount`, no quote above it is signed, so open quote requests with
one.

### Retries

`requestId` is the award's idempotency key, and the deposit nonce derives from it. Re-sending an
award with the same `requestId` resolves to the payment the first one made, so a lost response is
safe to retry. It shares one namespace with the `request_id` of `POST /v1/payments`, so use a value
you do not use there, such as an `award-` prefix.

The gateway answers a re-sent award even after the quote's `award_deadline`. To retry then, pass the
quote as `getQuoteRequestStatus` lists it: the awarded quote carries `awarded_payment_id`, and
`awardQuote` skips its deadline check.

`paymentId` is the id the escrow gives the deposit this call signed. It equals
`response.payment_id`, except on a retry whose first attempt signed a different deposit. On Solana a
retry stamps a fresh `issued_at`, so it signs a different deposit; the gateway then answers with
the first payment, and `response.payment_id` is the one to track.

One quote request is awarded once. After a successful award, awarding another of its quotes is
refused with `409 QUOTE_REQUEST_ALREADY_AWARDED`.

## Awarding from the command line

At a terminal, `request-quote` lists the quotes, lets you pick one with the arrow keys, and pays it
in the same run. From a script it prints the quotes and the quote request it sent as JSON, and
`award-quote --from` pays from that output:

```bash
# 1-3. open the quote request and read the quotes; nothing is signed
request-quote 0xF0D07a1c182Bc68a757C641014e0bAE7C4f17640 100000 \
  eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
  0x90F79bf6EB2c4f870365E785982E1f101E93b906 \
  eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C \
  --max-source-amount 101000 > quotes.json

# 4. award the cheapest quote and wait for the payout (at a terminal, you pick it).
#    From a script this needs the quote request to have --max-source-amount.
PRIVATE_KEY=0x... award-quote --from quotes.json --wait

# or award one quote by its quote_id
PRIVATE_KEY=0x... award-quote --from quotes.json <quote_id>
```

With `--from`, the deposit commits the quote request `request-quote` sent, as `awardQuote` does,
and a quote that does not quote it is refused before anything is signed. `award-quote` reads the
quotes from the gateway, so quotes listed after `request-quote` returned can be awarded too. Before
it signs, it checks each quote's settler signature, that its `quote_id` is the quote's hash, and that
the quote request's `settler_requirements` admit its signer. A list entry names the signer on the
source chain, `did:pkh:<source chain>:<address>`, as the gateway compares it.

`request-quote --request-id <id>` run again with the same id recovers the quote request that id
opened. The gateway keeps the deadlines of the first attempt, so the output carries those, and
`award-quote --from` pays it as before.

At a terminal, `award-quote <quote_request_id>` awards without a file: you pick the quote with the
arrow keys, or name it as a second argument. It signs the quote request as the chosen quote carries
it in `payment_request_json`, which the gateway checks against the quote request it stored, and it
prints what you pay, receiver in full, and the `fulfillment_deadline` after which an undelivered
payment is refundable, and asks before signing. It refuses a quote request whose escrow,
fulfillment verifier or fulfillment proxy is not the one `/v1/defaults` lists, which is what
`request-quote` sets. From a script it refuses bare ids.

It reads the depositor key as `send-payment` does: `PRIVATE_KEY`, a prompt, or
`--provider turnkey`. One key signs both the deposit and the reserve, so the CLI awards only quote
requests that name the depositor as `quote_selector`, which is what `request-quote` sends. To award
for another account, use `awardQuote` with a `selectorSigner`.

Its `--request-id` defaults to `award-<quote_id hex>`, so running the same award again resolves to
the same payment. Exit codes are those of `send-payment`; see
[Exit codes](../README.md#exit-codes). The terminal flow is shown in
[Paying with quotes from the CLI](../README.md#paying-with-quotes-from-the-cli).
