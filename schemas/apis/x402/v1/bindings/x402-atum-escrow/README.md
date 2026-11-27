> Copyright 2026 Atum Labs, Inc.
>
> Licensed under the Apache License, Version 2.0. See the `LICENSE` file
> distributed with this package.
>
> The public x402 protocol and third-party x402 packages remain subject to
> their own terms. This license covers Atum's implementation only.

# @atumlabs/x402-atum-escrow

The `atum-escrow` x402 scheme, as installable mechanisms. Drop it into a standard
x402 client or resource server and the pair becomes "Atum-aware": the payer spends
any source asset/chain Atum supports, and the merchant receives its chosen asset on
its chosen chain, for an exact amount — Atum converts between them.
Full documentation: [docs.atum.xyz](https://docs.atum.xyz).

`atum-escrow` rides standard x402 v2 envelopes. The generic parts (catching the 402,
parsing `accepts[]`, selecting a requirement, retrying) are handled by the stock x402
HTTP wrappers; this package supplies only the scheme-specific pieces: how the 402 is
built (server) and how the `PAYMENT-SIGNATURE` payload is constructed and signed
(client).

## Install

```bash
pnpm add @atumlabs/x402-atum-escrow
```

Peer stack: `@x402/core`, `ethers` v6 (EVM/Tron signing). Solana signing uses
`tweetnacl`/`bs58`, bundled with the package.

## Roles

Each role is a separate subpath, mirroring the stock scheme packages:

| Subpath                                   | Role                                       | Registers onto       |
| ----------------------------------------- | ------------------------------------------ | -------------------- |
| `@atumlabs/x402-atum-escrow/server`      | resource server (merchant): builds the 402 | `x402ResourceServer` |
| `@atumlabs/x402-atum-escrow/client`      | payer: builds + signs the payment          | `x402Client`         |
| `@atumlabs/x402-atum-escrow/facilitator` | facilitator: keyless relay to Atum         | `x402Facilitator`    |

```
Payer (client)              Merchant (server)            Facilitator
   |  GET /resource               |                            |
   | ---------------------------> |                            |
   |  402 + accepts[] (sources),  |                            |
   |  asking for a purchase id    |                            |
   | <--------------------------- |                            |
   | pick a source option, name   |                            |
   | the purchase, sign deposit   |                            |
   |  GET /resource               |                            |
   |  (PAYMENT-SIGNATURE)         |                            |
   | ---------------------------> |  /verify then /settle      |
   |                              | -------------------------> |
   |                              |  settled (+ receipt)       |
   |                              | <------------------------- |
   |  200 + resource              |                            |
   | <--------------------------- |                            |
```

Naming the purchase is what makes re-attempting it resolve to the original payment instead of a
second charge — see [Idempotency](#idempotency).

## Server (merchant)

Register the scheme onto an `x402ResourceServer` with your corridor config, then
build the route's `accepts[]` from the same config so there is a single source of
truth for which source chains you offer.

```ts
import { x402ResourceServer } from '@x402/core/server';
import { paymentMiddleware } from '@x402/express';
import {
  atumEscrowPrice,
  registerAtumEscrowScheme,
  type AtumEscrowServerConfig,
} from '@atumlabs/x402-atum-escrow/server';

const config: AtumEscrowServerConfig = {
  // Where you receive: chain, token, and address, plus the token's symbol and decimals.
  // Copy symbol and decimals from GET /v1/defaults for that chain (its `tokens` list) or from
  // the supported-assets reference: the cap is computed in each token's own units.
  destination: {
    network: 'eip155:42161',
    asset: '0x…USDC',
    address: '0x…merchant',
    symbol: 'USDC',
    decimals: 6,
  },
  // Exact amount you receive, in atomic units of the destination token.
  fulfillmentAmount: '10000000',
  // Markup over fulfillmentAmount to derive each source cap, in basis points (300 = 3%).
  markupBps: 300,
  fulfillmentProxy: '0x…proxy',
  reserver: '0x…reserver',
  releaser: '0x…releaser',
  // Bidding closes this many seconds after the payer builds the payment. 3s covers signing,
  // the hop to you, /verify, /settle and the auction for a route handler that answers in a
  // few hundred ms; add your handler's typical run time on top. The payer's clock skew also
  // comes out of this budget, and only you can widen it.
  quoteDeadlineSeconds: 3,
  fulfillmentDeadlineSeconds: 300,
  // The source chains you accept, keyed by CAIP-2 network. A single instance can serve
  // EVM, Tron, and Solana sources at once; each signs its native deposit authorization.
  sources: {
    // EVM (Permit2 / EIP-712 deposit).
    'eip155:8453': { asset: '0x…baseUSDC', escrow: '0x…baseEscrow', symbol: 'USDC', decimals: 6 },
    // Tron (TIP-712 deposit; base58 addresses).
    'tron:mainnet': { asset: 'T…usdt', escrow: 'T…tronEscrow', symbol: 'USDT', decimals: 6 },
    // Solana (Ed25519 deposit; base58 addresses + the escrow signature-domain).
    'solana:mainnet': {
      asset: '…mint',
      escrow: '…solEscrow',
      symbol: 'USDC',
      decimals: 6,
      svmSignatureClusterId: 'mainnet',
      svmSignatureDomainVersion: 5,
    },
  },
};

const server = registerAtumEscrowScheme(new x402ResourceServer(facilitatorClient), config);

// One accepts[] entry per source option, from the same config.
const accepts = Object.entries(config.sources).map(([network, source]) => ({
  scheme: 'atum-escrow',
  network,
  payTo: source.escrow, // funds lock in escrow, not with the merchant
  price: atumEscrowPrice(config), // must restate the config; any other price is refused
  maxTimeoutSeconds: 60,
}));

app.use(paymentMiddleware({ 'GET /paid': { accepts } }, server));
```

`registerAtumEscrowScheme` registers under the `eip155:*` wildcard by default; pass an
explicit network list as the third argument to pin it.

Each 402 binds its accepts to the requested page: the scheme adds `extra.atumResource` (method,
path and parsed query) automatically. Two things decide how precise that page is:

- **Mount the payment middleware at the app root.** The page uses the framework's mount-relative
  path (`req.path` in Express), so with `app.use('/tenants/:id', paymentMiddleware(…))` the pages
  `/tenants/1/report` and `/tenants/2/report` are both `/report` and one payment buys both. If the
  middleware must be mounted, put every segment that tells paid resources apart in the paid routes.
- **Read the query from `req.query`, never from the raw URL.** The page holds the query as the
  framework parsed it, so a handler that reads the raw URL can serve something the payment did not
  pay for. A request whose URL has a query the framework did not parse is refused, and so is an
  HTTP adapter without `getQueryParams`.
- **The binding is per route, nothing finer.** The page is the method, the routed path and the
  parsed query only. Resources chosen by the request body, headers, the Host (several virtual hosts
  served by one app), the session (`GET /me/…`) or MCP tool arguments share one page, so one
  payment can buy any of them. Give each such purchase its own identifier, declared by the server.
  Under Hono only the first value of a repeated query key is kept, so read `c.req.query()`, not
  `c.req.queries()`.

See [Idempotency](#idempotency).

A config that cannot serve payers throws `AtumEscrowConfigError`, whose `code` says why:

| `code`                  | When          | Meaning                                                                                    |
| ----------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| `INVALID_CONFIG`        | at startup    | a field is malformed; the message names its path                                           |
| `ASSETS_NOT_COMPARABLE` | at startup    | a source token is not the same money as the destination token (`network` names the source) |
| `CAP_BELOW_PRICE`       | at startup    | a source's cap, rounded down to whole units, would be worth less than `fulfillmentAmount`  |
| `PRICE_CONFLICT`        | first request | a route's `price` is not `atumEscrowPrice(config)`; x402 does not price routes at startup  |
| `SOURCE_NOT_CONFIGURED` | first request | a route's network has no source in `sources` (`network` names it)                          |

Two tokens are the same money when they share a symbol or sit in one peg group. The default groups
are the payer client's `DEFAULT_PEG_GROUPS` (the US-dollar stablecoins); `pegGroups` in the config
replaces them, and should match the groups your payers use.

### Which chains and assets can you accept?

The `sources` map above uses placeholders. The real values come from our documentation: every
supported token is listed with its identifier under
[supported assets](https://docs.atum.xyz/get-started/reference/supported-assets), and the chain ids
under [supported networks](https://docs.atum.xyz/get-started/reference/supported-networks). Assets
are named with [CAIP-19](https://chainagnostic.org/CAIPs/caip-19) identifiers, for example
`eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e` for USDC on Base Sepolia.

Copy identifiers exactly: base58 values, such as Solana token mints and Tron addresses, are
case-sensitive, and re-casing one produces a different valid value rather than a different spelling
of the same one.

### Which depositRequestHash versions to publish

A source may publish `depositRequestHashVersions`, the versions a payer may sign its deposit with:
`1` is keccak256 of the `request_id`, `2` is the hash of the payment terms. Absent publishes
nothing, which payers read as `[1]`. Derive it from the payment gateway before you register the
scheme, so each requirement lists exactly what the gateway accepts for that chain:

```ts
import { PaymentGatewayClient } from '@atumlabs/payment-gateway-client';
import { depositRequestHashVersionsFromDefaults } from '@atumlabs/x402-atum-escrow/server';

const gateway = new PaymentGatewayClient();
for (const [network, source] of Object.entries(config.sources)) {
  const defaults = await gateway.fetchChainDefaults(network);
  source.depositRequestHashVersions = depositRequestHashVersionsFromDefaults(network, defaults);
}
```

A deposit signed with a version the gateway does not list is refused, so once it lists only `2`, a
source that publishes nothing can no longer be paid. Publish the field only once your payers and
facilitator run a release that knows it: an older one refuses a requirement carrying it, even `[1]`.

## Client (payer)

Register the scheme onto an `x402Client` with a signer, then wrap `fetch`. Build the client once
and reuse it; each call says which purchase it is paying for.

```ts
import { ethers } from 'ethers';
import { x402Client } from '@x402/core/client';
import { registerAtumEscrowScheme } from '@atumlabs/x402-atum-escrow/client';
import { wrapFetchWithAtumPayment } from '@atumlabs/x402-atum-escrow/fetch';

const client = new x402Client();
registerAtumEscrowScheme(client, { signer: new ethers.Wallet(PRIVATE_KEY) });

const pay = wrapFetchWithAtumPayment(fetch, client);

// Required. One value per purchase — see Idempotency below.
const res = await pay('https://merchant.example/paid', {}, { paymentIdentifier: orderId });
```

The client reads the selected 402 option's `extra.atum` (destination, deadlines,
escrow/proxy/role addresses), checks those addresses and the spend cap against what the payer
trusts (see [Trusted corridors and the spend cap](#trusted-corridors-and-the-spend-cap)), builds
the Atum payment request, signs the source-side escrow-deposit authorization, and emits the
`PAYMENT-SIGNATURE`. The signature is
chain-specific: EVM and Tron sign a Permit2/TIP-712 typed-data deposit with an `ethers`
signer; Solana signs an Ed25519 deposit with a `SolanaSigner`. It registers under
`eip155:*` by default; pass `networks` to fund from Solana/Tron or to restrict the
source chains.

For a Solana source, pass a `SolanaSigner` — a `{ publicKey, sign }` capability (a local
`tweetnacl` keypair or a remote signer), so key material never reaches the mechanism:

```ts
import { registerAtumEscrowScheme, type SolanaSigner } from '@atumlabs/x402-atum-escrow/client';

const solanaSigner: SolanaSigner = {
  publicKey: '…base58',
  async sign(message) {
    /* Ed25519-sign `message`, return the 64-byte detached signature */
  },
};
registerAtumEscrowScheme(client, {
  signer: solanaSigner,
  networks: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
});
```

### Trusted corridors and the spend cap

The merchant writes the 402, but the addresses in it decide where the payer's deposit can go and
who may release it, and the cap decides how much the escrow may take. So, before anything is
signed, the client checks them against a source the **payer** controls — the way a browser checks
a site's certificate against the authorities it trusts. The check cannot be turned off; only the
trust source is configurable, and it never comes from the 402.

What is checked:

- on the source chain: `extra.atum.escrow` and `payTo` against the trusted escrow,
  `extra.atum.reserver` against the trusted quote selector, and `extra.atum.releaser` against the
  trusted fulfillment verifier account;
- on the destination chain: `extra.atum.fulfillmentProxy` against the trusted fulfillment proxy;
- both tokens must be ones the trust source lists for their chain, and must be the same money:
  the same symbol, or in one peg group;
- the cap (`amount`) may exceed `fulfillmentAmount` by at most `maxMarkupBps`, after both are put
  in one unit using the tokens' decimals.

**The trust source.** By default the client asks `GET /v1/defaults` on Atum's production
gateways (`ATUM_DEFAULT_TRUST_GATEWAYS`: production mainnet and production testnet) and caches a
successful answer per chain for five minutes. Pass `trust` to use another source:

```ts
import {
  AtumEscrowTrustError,
  atumGatewayTrust,
  registerAtumEscrowScheme,
  type TrustedRoles,
} from '@atumlabs/x402-atum-escrow/client';

// Another deployment's gateway (a staging environment, a local devnet, another operator)…
registerAtumEscrowScheme(client, {
  signer,
  trust: atumGatewayTrust({ gateways: ['http://localhost:8080'] }),
});

// …or a fixed set of addresses, with no network call. Each entry carries escrowContract,
// quoteSelector, fulfillmentVerifierAccount, fulfillmentProxy and the payable tokens.
const TRUSTED_CORRIDORS: Record<string, TrustedRoles> = {/* "eip155:8453": { ... } */};
registerAtumEscrowScheme(client, {
  signer,
  trust: async (network) => {
    const roles = TRUSTED_CORRIDORS[network];
    if (!roles) {
      throw new AtumEscrowTrustError({
        code: 'CHAIN_NOT_TRUSTED',
        network,
        message: `no trusted corridor on ${network}`,
      });
    }
    return roles;
  },
});
```

> **Devnet and staging must pass `trust`.** A local devnet forks mainnet and keeps mainnet chain
> ids, and staging runs its own escrow and roles, so the default would answer with production's
> addresses and every payment would be refused. A devnet whose tokens are test stand-ins (for
> example `TUSDC`, `TUSDT`) must also pass `pegGroups` naming them, or the client cannot price one
> against the other and refuses with `ASSETS_NOT_COMPARABLE`:
> `pegGroups: [[...DEFAULT_PEG_GROUPS[0], "TUSDC", "TUSDT"]]`.

**The cap.** `maxMarkupBps` (default `DEFAULT_MAX_MARKUP_BPS`, 500) is the most the cap may exceed
`fulfillmentAmount`, in basis points. `pegGroups` (default `DEFAULT_PEG_GROUPS`, the US-dollar
stablecoins on the network's allowlists) lists the token symbols the payer treats as
interchangeable 1:1; passing it replaces the default. Tokens that are neither the same symbol nor
in one group are not priced against each other at all.

**Refusals.** Every refusal is an `AtumEscrowTrustError`, and nothing is signed. Branch on `code`:

| `code`                        | Meaning                                                               |
| ----------------------------- | --------------------------------------------------------------------- |
| `UNTRUSTED_ESCROW`            | `extra.atum.escrow` is not the trusted escrow                         |
| `UNTRUSTED_PAY_TO`            | `payTo` is not the trusted escrow                                     |
| `UNTRUSTED_RESERVER`          | `extra.atum.reserver` is not the trusted quote selector               |
| `UNTRUSTED_RELEASER`          | `extra.atum.releaser` is not the trusted fulfillment verifier         |
| `UNTRUSTED_FULFILLMENT_PROXY` | the fulfillment proxy is not the destination chain's trusted proxy    |
| `UNTRUSTED_ASSET`             | a token is unlisted for its chain, or listed with decimals not 0–77   |
| `ASSETS_NOT_COMPARABLE`       | the two tokens are not the same money                                 |
| `MARKUP_EXCEEDED`             | `amount` is above the bound; `expected` is the largest amount allowed |
| `CHAIN_NOT_TRUSTED`           | the trust source serves nothing on the chain                          |
| `TRUST_SOURCE_UNAVAILABLE`    | the trust source could not answer; the payment may be retried         |

For the `UNTRUSTED_*` codes and `MARKUP_EXCEEDED`, `field`, `expected` (the trusted value or
bound) and `actual` (what the 402 asked for) say exactly what failed.

**For facilitator operators.** The gateway adapter you pass as `submitter` must return the
gateway's `payment_id`, `status` and `transactions`; the payout the settle response carries is read
from `transactions.fulfillment`. Its second argument carries a `shadow`: forward it with the
gateway client as `submitPayment({ requestBody, ...submitPaymentShadow(context?.shadow) })`. It is
used for compatibility diagnostics only and never changes how the payment is processed. `settleAt` is `'finalizing'` (default) or `'completed'`; see
[Settlement outcomes](#settlement-outcomes). `AtumEscrowFacilitatorScheme` takes the same `trust` option, with
the same default. After a payment's signature is verified, it refuses (`isValid: false`, and so
`settle` relays nothing) a payment whose escrow, `payTo` or reserver is not trusted on the source
chain, or whose fulfillment proxy is not trusted on the destination chain. The releaser is not
compared: which verifier to rely on is the settler's choice. Verification is local apart from this
lookup, which is cached once it succeeds. A facilitator relaying to anything other than Atum's
production deployments must pass `trust` for that deployment, or it refuses every payment. The
trust API is exported from `@atumlabs/x402-atum-escrow/facilitator` too.

### Precondition: source authorization state

The payer must have the source-side authorization already in place, or the escrow
deposit reverts at settlement — arranging it is the payer/app's responsibility (this
mechanism assumes it and does not check on-chain):

- **EVM / Tron**: an `approve(Permit2)` allowance covering the spend.
- **Solana**: an escrow **delegate** (created out-of-band) authorizing the deposit.

Do this _before_ signing. A deposit that reverts on-chain is a terminal settlement failure, and
a terminal failure belongs to the purchase identifier that caused it — so re-attempting that
purchase then needs a new identifier (see [Settlement outcomes](#settlement-outcomes)). Getting
the allowance right up front keeps the identifier usable.

For an EVM or Tron source, `ensureSourceApproval` is offered as an optional convenience — use it if
you would rather not write the ERC-20 calls yourself:

```ts
import { Wallet, JsonRpcProvider } from 'ethers';
import { ensureSourceApproval } from '@atumlabs/x402-atum-escrow/client';

const wallet = new Wallet(PRIVATE_KEY, new JsonRpcProvider(SOURCE_RPC_URL));
await ensureSourceApproval({
  network: 'eip155:8453',
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
  owner: wallet.address,
  signer: wallet,
  // Pass the amount this charge needs (the 402 option's `amount`), so a leftover smaller
  // allowance isn't mistaken for enough.
  requiredAllowance: 1_000_000n,
});
```

It reads the current allowance and sends an approval only if it falls short. The approval it sends
is unlimited, so later charges on the same token need no further transaction — and it stays
sufficient as payments consume it, because Permit2 decrements the allowance each time. On Solana
there is no allowance to grant, so the call does nothing.

Paying from Tron takes a TronWeb instance in place of the ethers signer; the Permit2 address for
the network is resolved for you:

```ts
await ensureSourceApproval({ network: 'tron:mainnet', token, owner, tronWeb });
```

The approval waits to be mined before returning, bounded by `confirmation.timeoutMs` (one minute
by default); a timeout is reported as unconfirmed rather than failed, since the transaction may
still land. `onSubmitted` hands you the hash the moment it is broadcast.

`isUnconfirmed(error)` tells the two apart. It matters because the responses are opposite: a
failed approval needs another one, an unconfirmed approval needs a look at the transaction and
nothing else. Sending a second one on top of the first only pays for an allowance you are already
getting.

```ts
try {
  await ensureSourceApproval({ network, token, owner, signer });
} catch (error) {
  if (isUnconfirmed(error)) {
    // Broadcast, not yet seen to confirm. Check the hash from onSubmitted; do not re-send.
  } else {
    throw error;
  }
}
```

On EVM, tokens that refuse to overwrite a non-zero allowance — mainnet USDT most notably — are
reset to zero first, automatically and only where the token demands it; the result then carries a
`resetTxHash` too. Tron does not do this, because an ordinary TRC-20 accepts the change in place.

To bound the approval that gets sent, pass `approvalAmount`. On its own the amount is treated as
its own requirement, so an allowance still holding the full bound is left alone rather than
re-approved — the right answer for a one-off approval. Across repeated payments, pair it with
`requiredAllowance`: a bound measured against itself stops covering itself the moment the first
charge is decremented from it, and every later call would send another approval. Either way a
bounded approval is consumed as it is spent and eventually has to be granted again.

These helpers raise an allowance to what a payment needs; they never lower one. A wallet already
holding more than `approvalAmount` is left exactly as it is and reports `alreadySufficient`
without sending anything. Reducing or revoking an allowance is a separate operation, and not one
these perform.

`needsSourceApproval(params)` takes the same arguments and answers the same question without
sending anything, so it is safe to call as a preflight before asking a payer to sign:

```ts
if (await needsSourceApproval({ network, token, owner, signer })) {
  // a one-off approval transaction is due first
}
```

## Idempotency

A retry must not become a second payment. HTTP requests get retried — by an agent, by a proxy,
by a user pressing the button again — and each retry re-fetches the resource and gets a **fresh**
402, so nothing about the rebuilt payment is byte-identical to the first attempt. The scheme gives
the payment a stable identity instead, and the Atum gateway de-duplicates on it.

That identity comes from **you** and from the page you pay for. You name the purchase being paid
for, and the client derives the payment's `request_id` from that name, the page and the paying
account:

```
pay(url, {}, { paymentIdentifier: "order-4711" })
   ↓  travels in the standard x402 `payment-identifier` extension
   ↓  client derives request_id from (page, identifier, source account)
   ↓  gateway de-duplicates on request_id
re-attempt of the same page under the same identifier → the ORIGINAL payment, not a second charge
```

The **page** is the request's method plus its path and parsed query, for example
`GET /reports/42?{"format":"pdf"}`. The resource server publishes it in each accept as
`extra.atumResource`, and the facilitator checks the `request_id` against the page the resource
server is charging for. So:

- **The same identifier on another page is a new payment.** A payment for one page can never be
  presented as payment for another, even at the same price.
- **A query value that changes between attempts makes a new payment.** A cache buster or a
  timestamp in the query is part of the page, so keep the URL of a re-attempt identical. The same
  holds when a merchant deploy changes the page between attempts (its query parser, framework or
  mount): the re-attempt is charged again. This differs from the `payment-identifier` advice to
  answer 409 for the same id with a different payload, because here another page is another
  payment.
- **Pages that differ only in the request body or headers are the same page.** Two purchases sent
  to one URL with different bodies or headers (for example `Accept`) still need a unique
  identifier each.

The carrier is the x402 specification's own
[`payment-identifier`](https://github.com/coinbase/x402/blob/main/specs/extensions/payment_identifier.md)
extension, so nothing about this is specific to Atum: the resource server declares that it needs
an identifier, and the payer names the purchase.

### The contract

| Rule                                                  | Why                                                                                                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Same identifier for every attempt at one purchase** | This is what makes the re-attempt safe. A new identifier is a new payment.                                                                               |
| **Different identifier for a different purchase**     | Reusing one across two genuine purchases of the same page de-duplicates the second onto the first — the payer receives twice, the merchant is paid once. |
| **Nothing can detect a reused identifier**            | Same as every idempotency-key API. The identifier IS the identity; correctness is the caller's.                                                          |

The third rule is the one with teeth, so it is worth being concrete about the failure and the
defence. If a payer reuses one identifier across two genuine purchases of the same page, the network
cannot tell them apart: the second resolves onto the first payment and only one payment is made.
Reused on a different page, the identifier names a different payment, so the second purchase is
paid for separately.

**A merchant can close that on its own side, and should.** Both purchases resolve to the _same
payment_, so both are served the _same receipt_ — the same `payment_id` and the same
`destination_tx_hash`. A merchant that keys fulfilment on the receipt rather than on the request
therefore fulfils once and recognises the second as already-fulfilled, instead of shipping twice
against a single payment. Treat receipt-keyed fulfilment as a merchant responsibility: the scheme
guarantees you will not be paid twice for one identifier, and this is how you avoid _delivering_
twice for one.

A natural per-purchase reference — an order id, a cart id, an invoice number — is the right value.
A UUID minted once per purchase and reused across that purchase's attempts works equally well.
What does not work is a value derived from the payment terms (two identical orders would collide)
or one minted fresh per attempt (every re-attempt becomes a new payment).

Any non-empty string is accepted. The extension itself permits 16-128 characters of letters,
digits, hyphen and underscore, and a reference outside that — `order/0001`, or simply one that is
too short — is mapped onto a conforming identifier by digest. The mapping is stable, so the same
reference always yields the same payment identity; a reference that already conforms travels
unchanged, so pass a conforming one if you want the wire value to match your own id.

### Both sides

**Payer** — pass `paymentIdentifier` on each call. Omitting it is not "opting out of idempotency":
the client **refuses to sign**, naming what to supply. There is deliberately no generated
fallback — one would look like an idempotency key while letting every re-attempt double-charge.

Note that the wrapped `fetch` stays assignable to `typeof fetch`, so a library that accepts a
`fetch` implementation can call it as `fetch(url, init)` and drop the third argument. Such a call
is refused rather than paid unsafely.

**Payer, driving the client directly** — if you fetch the `402` yourself and call
`createPaymentPayload`, there is no per-call channel to carry the identifier, so name the purchase
on the `402` first:

```ts
import { withPaymentIdentifier } from '@atumlabs/x402-atum-escrow/client';

// paymentRequired: the 402 you decoded yourself
const payload = await client.createPaymentPayload(withPaymentIdentifier(paymentRequired, orderId));
```

Same function the wrapped `fetch` uses, so the two paths enforce the same rules: it refuses when
neither you nor the resource server named the purchase, and refuses when you and the resource server
name it differently (a payer may not overwrite a declared identifier). Writing the extension by hand
instead is what to avoid — that is how a payment ends up carrying no identity at all.

**Merchant** — nothing to write. The server mechanism declares the extension automatically, so a
payer knows an identifier is required before it builds anything, and adds `extra.atumResource` to
every atum-escrow accept from the live request, so the payment is bound to the page that was
requested rather than to the route pattern. Outside HTTP it uses the 402's `resource.url`.

A merchant that already tracks the purchase server-side may name it itself instead, by declaring
the identifier on the route:

```ts
app.use(
  paymentMiddleware(
    {
      'GET /paid': {
        accepts,
        extensions: {
          'payment-identifier': { info: { required: true, id: 'order_4711_a1b2c3d4' } },
        },
      },
    },
    server,
  ),
);
```

The scheme never overwrites an identifier the resource server declared — a payer may add to a
declaration but not replace it — and a payer that supplies a _different_ one gets an error rather
than a payment made under an identity it did not choose. Note that a route declaration is static;
naming a purchase per request means declaring it dynamically, which x402 supports through an
extension's own `enrichDeclaration` hook.

### Scheme rules

Three behaviours are part of the `atum-escrow` scheme rather than of any one implementation of it. A
third-party client or server built against this scheme has to match them, so they are stated
normatively here.

**1. A payment with no purchase identifier is refused, not guessed at.** The client will not build a
payment when neither the caller nor the resource server has named the purchase, and it does **not**
generate an identifier of its own. A generated one would look like an idempotency key while letting
every re-attempt become a second payment — the precise failure the identifier exists to prevent. The
resource server declares `payment-identifier` with `required: true` on every `402`, so a payer that
knows nothing else about this scheme still learns that an identifier is mandatory and what shape it
takes.

**2. That refusal surfaces as `402`, not `400`.** A missing identifier is not a malformed request; it
is a payment that cannot yet be made safely, and the remedy is for the payer to attempt again with
the purchase named. So the resource server answers `402` with the requirement re-declared, and a
payer should treat it as "attempt again, naming the purchase" rather than as an error to report and
abandon.

> Note for implementers: the HTTP status is chosen by the x402 framework, not by the scheme — in
> `@x402/core` the mapping is fixed (`permit2_allowance_required` becomes `412`, everything else
> `402`). A scheme therefore cannot select its own status, which is why this is stated as a rule
> about what a payer should expect rather than as something the scheme enforces.

**3. The payment is bound to its page.** The resource server adds `extra.atumResource` to every
atum-escrow accept: the upper-cased method, a space, the routed request path exactly as received
(mount-relative, `req.path` in Express), then the canonical query. The canonical query is empty
when the parsed query (`req.query`) has no keys, and otherwise `?` followed by its JSON with object
keys sorted at every level and array order kept, so `a=1&a=2` and `a=2&a=1` are different pages.
The page is never read from the full URL or the Host header, which headers such as
`X-Forwarded-Proto` can rewrite. A URL with a query that was not parsed, an HTTP adapter without
`getQueryParams`, and a page over 2048 UTF-8 bytes are refused. Mount the payment middleware at the
app root, and have handlers read `req.query`, since the page is only as precise as those two.
Leaving out the Host means virtual hosts served by one app share pages. The
`request_id` is derived with the anchor `identifier + ":" + hex(keccak256(utf8(resource)))`
(lowercase, no `0x`), and keeps the whole 256-bit digest (`req_x402_` plus 64 hex characters),
because the payer picks the identifier and a shorter id would let it search for two identifiers
that collide across pages. A client refuses a requirement without the key, and a facilitator reads it
from the requirements the resource server passes, never from the payer's echoed `accepted`, and
refuses a payment whose `request_id` does not match. `test-vectors/request-id-resource.json` holds
cross-language vectors for the recipe.

## Settlement outcomes

x402 models settlement as a boolean, so everything short of settled arrives as `success: false` on
a **402**. That single flag covers three situations that call for three different responses, and
`errorReason` is what separates them:

| `errorReason`                                       | What happened                                                                                | What the payer should do                                                                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none — `success: true`)_                          | Payout on chain: `state` is `finalizing` (not yet final, the default) or `completed` (final) | Nothing; the resource is served                                                                                                                                                          |
| `settlement_pending`                                | Accepted, still settling                                                                     | **Re-attempt under the SAME identifier** — it resolves to this payment                                                                                                                   |
| `settlement_pending`, `state` is `refund_available` | Not delivered; the deposit is still in escrow                                                | Read `refund_signature` from the payment's status and submit it to the source escrow to return the funds. Do not pay again under a new identifier: a late delivery can still complete it |
| `settlement_failed`                                 | Terminal failure, or `refunded`: not delivered and the funds were returned                   | **Start a new purchase under a NEW identifier** — this one can never settle                                                                                                              |
| `payment_expired`                                   | Refused before relay; nothing charged                                                        | Pay the same purchase again: the client signs fresh deadlines, and the same identifier is safe because nothing was accepted                                                              |
| _a gateway code_                                    | Refused; nothing charged                                                                     | Fix the request and pay the same purchase again                                                                                                                                          |

Three of the four settlement outcomes carry the payment id, so a merchant can reconcile without
parsing a message — the refusal is the one exception, because nothing was charged and there is no
payment to name:

```jsonc
{
  "success": true,
  "transaction": "0x…payout",
  "extensions": {
    "atum": { "paymentId": "pay_…", "state": "finalizing", "statusUrl": "https://…" },
  },
}
```

`finalizing` means the payout is on chain but not yet final, and serving the resource then is
accepting the risk that a chain reorganization drops it. A facilitator that passes
`settleAt: 'completed'` reports `settlement_pending` until the payout is final instead, which
takes minutes on some chains. How long a payout stays `finalizing`, and so how long that risk
lasts, depends on the destination chain and can change over time, for example when a chain moves
to a stricter finality rule. The fulfillment verifier publishes the current estimate per chain as
`time_to_final_ms` on `GET /v1/finality-config`.

```jsonc
{
  "success": false,
  "errorReason": "settlement_pending",
  "extensions": {
    "atum": { "paymentId": "pay_…", "state": "pending", "statusUrl": "https://…" },
  },
}
```

### Pending: retry, don't poll

A pending payment is real and may already be moving funds. Do not release the goods, and **do not
pay again under a new identifier**.

Re-attempting the same purchase — the same `paymentIdentifier` on the same page — is how you
collect the result. The gateway resolves the re-attempt onto the same payment and replays its
receipt once it has one, so re-attempting costs nothing. `statusUrl` is there for out-of-band
reconciliation (dashboards, support, a ledger job); it is not a step the payment flow has to take,
and this client does not poll it.

Note that a pending attempt is **not** served: the resource is withheld until the payout is on
chain, because goods must not be released against a payment that has not been made.

### Failed: a retry cannot recover it

`settlement_failed` is the opposite instruction. That purchase's identifier now resolves to a dead
payment forever, so re-attempting it returns the same failure indefinitely. Recovering means
treating it as a new purchase, under a new identifier.

This is why the two are distinguished rather than collapsed into one failure: reading pending as
failed abandons a payment that was about to succeed (and invites a second charge under a fresh identifier),
while reading failed as pending strands the payer in a retry loop that can never finish.

### Reusing a key for different terms

The gateway refuses a key that comes back on the same page with different economics — a different
source, destination, or `fulfillmentAmount` — instead of silently resolving it onto the first
payment. It
arrives as a refusal carrying the gateway's code:

```jsonc
{ "success": false, "errorReason": "IDEMPOTENCY_TERMS_MISMATCH", "errorMessage": "…" }
```

Nothing was charged and nothing is in flight, so this is a request to fix rather than a payment to
wait on — the fix is always a distinct key per purchase. Deadlines are deliberately **not** part of
the comparison: every retry re-signs with fresh deadlines, so including them would make the
mismatch fire on every legitimate retry.

A transport or server failure is deliberately _not_ reported as a refusal. When the outcome is
unknown the response is a 5xx, because calling it a definite "did not settle" would invite a second
payment for a purchase that may have gone through.

## How pricing works

The merchant pins an exact `fulfillmentAmount` (what it receives, in the destination token's
atomic units) and adds a static markup to derive each source option's cap (`amount`): the
fulfillment plus markup, converted into the source token's atomic units with both tokens'
declared decimals and rounded down. A corridor whose rounded cap would be worth less than the
fulfillment is refused at startup. The payer signs a
`max_source_amount` no greater than that cap; the merchant always receives exactly
`fulfillmentAmount`, and the headroom covers settlement margin and gas. The payer refuses a cap
more than `maxMarkupBps` above `fulfillmentAmount` (compared in one unit, and only between tokens
it treats as the same money), so the markup also bounds what the payer can lose — see
[Trusted corridors and the spend cap](#trusted-corridors-and-the-spend-cap). A payer may
sign a lower cap, which only lowers its own escrow lock and risks the auction not
clearing — it can never reduce the merchant's receive side.

## Status

The client, server, and facilitator roles are all shipped, across EVM, Solana, and Tron
sources. The current profile emits the source-side authorization only; the holder-signed
identity binding (a Verifiable Presentation over the request) required for full x402
conformance is added in a later revision.

## Further reading

- [Accepting and making x402 payments with Atum](https://docs.atum.xyz/payment-protocols/x402/overview)
- [x402 Facilitator API reference](https://docs.atum.xyz/api-reference/x402/introduction)
- [Supported assets](https://docs.atum.xyz/get-started/reference/supported-assets) and [supported networks](https://docs.atum.xyz/get-started/reference/supported-networks)
- [x402 protocol](https://x402.org)
- [Atum documentation](https://docs.atum.xyz)
