# @atumlabs/mppx-atum-escrow

> Copyright 2026 Atum Labs, Inc.
>
> Licensed under the Apache License, Version 2.0. See the `LICENSE` file
> distributed with this package.

An [`mppx`](https://www.npmjs.com/package/mppx) payment method that lets a merchant accept
**cross-chain stablecoin payments** through Atum, over the Machine Payments Protocol (MPP).
Full documentation: [docs.atum.xyz](https://docs.atum.xyz).

- The **payer** funds the payment in any supported source asset and chain (e.g. USDC on Base,
  USDT on Tron, or USDC on Solana).
- The **merchant** receives an exact, pinned amount of the asset it chose, on the chain it chose
  (e.g. USDC on Arbitrum).
- Atum's escrow, auction, and settlement network bridges the two. Neither side has to hold or
  move the other's asset.

If you have used MPP with a card or same-chain method before, this is the same integration shape
— you register a method and MPP does the 402 dance for you — except the money can cross chains.

## What is MPP, in one paragraph

MPP is an "HTTP 402" protocol: a client requests a resource, the server answers `402 Payment
Required` with a machine-readable description of how to pay, the client pays and retries, and the
server returns `200` plus a receipt. Unlike some 402 protocols, **MPP has no central "facilitator"
service** — the logic that validates and settles a payment runs **inside the merchant's own
process**, as a _payment method_ plugged into the `mppx` SDK. This package **is** that method for
Atum. Its one `verify()` hook both checks the payment and settles it through the Atum Payment
Gateway.

## How a payment flows

```text
Payer (client)              Merchant (server)              Atum Payment Gateway
      |                            |                                |
      | ─ GET /paid-resource ────> |                                |
      | <─ 402 + atum-escrow ───── |  (what to pay, where it lands) |
      |    challenge               |                                |
      | (registerClient builds &   |                                |
      |  signs the deposit auth)   |                                |
      | ─ retry + credential ────> |                                |
      |                            | (registerServer.verify:        |
      |                            |  checks signature & terms)     |
      |                            | ─ submit payment request ────> |
      |                            | <─ payout on chain ─────────── |
      | <─ 200 + resource + ────── |                                |
      |    receipt                 |                                |
```

1. The merchant answers a request with a `402` **challenge** describing what it receives
   (destination asset, chain, exact amount) and the source option a payer may fund from. You build
   this challenge from a **corridor** with `buildChargeChallenge`.
2. The payer's `registerClient` reads the challenge, builds an Atum payment request, signs the
   source-chain deposit authorization for that chain, and returns it as an MPP **credential**.
3. The merchant's `registerServer` **verifies** the credential (recovers the signature, matches
   every term against the challenge) and **submits** it to the Atum Payment Gateway. Once the
   payout to the recipient is on chain it returns a **receipt** naming that transaction. A payment
   that is not on chain within the gateway's synchronous window reports as _pending_, and the
   payer's retry of the same purchase collects the result — see
   [Settlement outcomes](#settlement-outcomes).

The source-chain authorization is built and signed through the Atum
[`@atumlabs/payment-gateway-client`](https://www.npmjs.com/package/@atumlabs/payment-gateway-client),
so **one code path supports EVM, Tron, and Solana sources** — you configure a source
and the method picks the right signing scheme for its chain.

## Install

```sh
npm install @atumlabs/mppx-atum-escrow "mppx@^0.8.12" "zod@^4.4.3" "viem@>=2.54.0 <2.57.16"
```

This package is an `mppx` plugin, so **`mppx` and `zod` are peer dependencies** — it registers into
_your_ `mppx` instance and must share the same `mppx` and `zod` as the rest of your integration.
It supports `mppx` 0.8.x. `viem` is a peer of `mppx`, and viem 2.57.16 and later only accept
`mppx` 0.17 or newer, so keep `viem` below 2.57.16; without that bound npm fails with `ERESOLVE`.
The command adds that `viem` range to your own dependencies, so a project already on `viem` 2.57.16
or later is moved back below it.

The merchant examples below also use
[`@atumlabs/payment-gateway-client`](https://www.npmjs.com/package/@atumlabs/payment-gateway-client)
for the gateway connection and corridor defaults.

## Key concepts

| Term                    | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Corridor**            | The merchant's payment configuration: what it receives (destination), and which source chains/tokens it accepts. You define it once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Source option**       | A source chain (with its escrow and role addresses) and one or more tokens (`assets`) a payer may pay from on it. A corridor may list several; each challenge offers one `(chain, token)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **`fulfillmentAmount`** | The exact amount, in the destination token's atomic units, the merchant will receive. USDC/USDT use 6 decimals, so `"10000000"` = 10 USDC. Set per charge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Source cap**          | The most the payer can spend on the source side: `fulfillmentAmount` + a markup (`markupBps`) to cover the cross-chain spread, converted into the source token's units with both tokens' declared `decimals` and rounded down. A charge whose rounded cap would be worth less than `fulfillmentAmount` is refused (`CAP_BELOW_PRICE`), and so is one whose cap exceeds what the source chain's amount type holds (`AMOUNT_EXCEEDS_CHAIN_LIMIT`). The payer signs this cap. This package's payer client refuses a cap more than 500 bps above `fulfillmentAmount` unless the payer raises its `maxMarkupBps`, so keep `markupBps` at or below 500. |
| **Escrow**              | The source-chain contract the payer's funds lock into until the merchant is paid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Deadlines**           | Two budgets in seconds: `quoteDeadlineSeconds` (how long the auction runs) and `fulfillmentDeadlineSeconds` (how long settlement may take). Required order: `now < quote < fulfillment`. Both count from when the payer builds the payment, so the payer's clock skew comes out of them, and only the merchant can widen them.                                                                                                                                                                                                                                                                                                                    |
| **`PaymentSubmitter`**  | A small adapter _you_ provide that hands a signed payment request to the Atum Payment Gateway and returns the result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **`intentId`**          | Identifies the _purchase_ (your order or invoice id): one value per purchase, reused on every retry of it. The payment's identity derives from it, so it is what makes a retry safe.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Receipt**             | What `verify()` returns on success: the MPP receipt plus the payment id, its state (`finalizing` or `completed`) and the payout transaction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

All addresses and amounts are strings; all amounts are **atomic units** (never floats). Addresses
are in each chain's native form — `0x…` hex for EVM, base58 for Tron and Solana.

### Which chains and assets can a corridor use?

Atum supports many corridors. The identifier for every supported token is listed under
[supported assets](https://docs.atum.xyz/get-started/reference/supported-assets), and the chain ids
under [supported networks](https://docs.atum.xyz/get-started/reference/supported-networks). Assets
are named with [CAIP-19](https://chainagnostic.org/CAIPs/caip-19) identifiers, for example
`eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e` for USDC on Base Sepolia.

Copy identifiers exactly: base58 values, such as Solana token mints and account addresses, are
case-sensitive. The escrow and role addresses for each chain are filled in by
`corridorFromDefaults`, so you never paste those by hand.

## Quick start — merchant (server)

```ts
import { Mppx } from 'mppx/server';
import { PaymentGatewayClient, submitPaymentShadow } from '@atumlabs/payment-gateway-client';
import {
  registerServer,
  buildChargeChallenge,
  corridorFromDefaults,
  gatewayRefusalOf,
  type AtumEscrowCorridor,
  type PaymentSubmitter,
} from '@atumlabs/mppx-atum-escrow/server';

const gateway = new PaymentGatewayClient({ BASE: 'https://gateway.example.com' });

// 1. Describe your corridor: you receive 10 USDC on Arbitrum, and accept USDC on Base and
//    USDT on Tron as sources. `corridorFromDefaults` fills the escrow/role/proxy addresses
//    from the gateway, so you only specify what you receive, the sources, and your budgets.
//    Each token declares its `symbol` and `decimals`: take them from the `tokens` the
//    gateway's `GET /v1/defaults` lists for that chain, which is what payers price against.
const corridor: AtumEscrowCorridor = await corridorFromDefaults(gateway, {
  destination: {
    network: 'eip155:42161', // Arbitrum One (CAIP-2)
    asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC on Arbitrum
    account: '0xYourMerchantReceiveAddress',
    symbol: 'USDC',
    decimals: 6,
  },
  sources: [
    // One entry per source chain; list several tokens in `assets` to accept more than one
    // on that chain (they share the same escrow/role addresses — no need to duplicate).
    {
      network: 'eip155:8453', // Base
      assets: [
        { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
        { address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', symbol: 'USDT', decimals: 6 },
      ],
    },
    {
      network: 'tron:mainnet',
      assets: [{ address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', decimals: 6 }],
    },
  ],
  markupBps: 300, // allow up to +3% on the source side to cover the spread
  quoteDeadlineSeconds: 3, // bidding closes this many seconds after the payment is built
  fulfillmentDeadlineSeconds: 300,
});

// You can also build a corridor by hand if you already hold the addresses — see AtumEscrowCorridor.

// 2. Provide the gateway adapter. The gateway response maps 1:1 onto what the method needs.
//    Pass `status` and `transactions` through: `status` distinguishes a payment still settling
//    from one that failed, and `transactions` carries the payout the receipt names. Submit and
//    return — do not poll for completion (see "Settlement outcomes"). When the gateway answers
//    with an error, `gatewayRefusalOf` turns a refusal into the error that tells the payer
//    whether to fix the request or retry it shortly; anything else is rethrown as it is.
//    `context.shadow` carries compatibility headers, used for diagnostics only; it never changes
//    how the payment is processed.
const submitter: PaymentSubmitter = {
  async submit(request, context) {
    try {
      const res = await gateway.payments.submitPayment({
        requestBody: request,
        ...submitPaymentShadow(context?.shadow),
      });
      return {
        payment_id: res.payment_id,
        status: res.status,
        transactions: res.transactions,
      };
    } catch (err) {
      throw gatewayRefusalOf(err) ?? err;
    }
  },
};

// 3. Register the method and create your mppx server. The corridor is NOT part of the server
//    config — verification trusts the signed challenge, so one registration serves every corridor.
const method = registerServer({ submitter });
const mppx = Mppx.create({
  realm: 'api.example.com',
  secretKey: process.env.MPP_SECRET_KEY, // recommended: binds each challenge to its contents
  methods: [method],
});

// 4. Guard a route. buildChargeChallenge turns your corridor + a chosen source + the price into
//    the challenge. Set the price per charge, so one corridor serves any amount.
app.get('/paid-resource', async (req) => {
  const { request, meta } = buildChargeChallenge(
    corridor,
    { network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, // offer Base USDC
    '10000000', // receive exactly 10 USDC
    // Identifies the purchase, NOT the attempt: the same value every time this order is
    // re-offered or retried, a different one for a new order. See "Retries and idempotency".
    { intentId: orderIdFor(req) },
  );
  const result = await mppx.compose(['atum-escrow/charge', { ...request, meta }])(req);
  if (result.status === 402) return result.challenge; // not paid yet — ask for payment
  return result.withReceipt(new Response('here is your resource')); // paid & settled
});
```

> Before production: `mppx.fetch`/a single `verify()` call is enough for this quickstart, but not
> for a corridor whose settlement can genuinely take minutes — see
> [Settlement outcomes](#settlement-outcomes) for handling that without polling.

## Quick start — payer (client)

```ts
import { Mppx } from 'mppx/client';
import { registerClient } from '@atumlabs/mppx-atum-escrow/client';

// The signer is chain-agnostic: pass private-key options (bound to the challenge's source chain
// automatically) or a ready-made SenderSigner. `account` is your source-chain address.
// Use a TESTNET-ONLY wallet for PAYER_PRIVATE_KEY while trying this out — never one holding real funds.
const method = registerClient({
  signer: { privateKey: process.env.PAYER_PRIVATE_KEY! },
  account: process.env.PAYER_ADDRESS!,
});
const mppx = Mppx.create({ methods: [method] });

// mppx.fetch handles the 402 automatically: it reads the atum-escrow challenge, builds and
// signs the payment, retries with the credential attached, and returns the final 200 response.
const res = await mppx.fetch('https://api.example.com/paid-resource');
const resource = await res.text();
```

> Before production: `mppx.fetch` retries only a few times with no delay, which isn't enough for a
> corridor whose settlement can genuinely take minutes — see
> [Settlement outcomes](#settlement-outcomes) for the retry pattern that handles it.

### Trusted corridors and the spend cap

**Who the escrow protects, and against whom.** The escrow protects the payer against a settler
that does not pay: it holds the payer's funds until the fulfillment verifier confirms that the
settler paid the merchant on the destination chain. (It does not cover the merchant failing to
deliver the HTTP resource.) That protection only holds if the escrow, the reserver (who picks the
settler and how much of the cap it is paid) and the releaser (who opens the escrow) are ones the
payer trusts. The merchant writes all of them into the
challenge, so a merchant that named its own contract as the escrow, or itself as reserver or
releaser, could take up to the cap without delivering anything. The client therefore protects the
**payer** against the **merchant's** choice of corridor: before anything is signed, it checks the
challenge against a source the payer controls, the way a browser checks a site's certificate
against the authorities it trusts. The check cannot be turned off; only the trust source is
configurable, and it never comes from the challenge. The merchant's `verify()` checks the opposite
direction — that the credential matches the merchant's own terms — so it offers the payer nothing
here.

What is checked:

- on the source chain: `extra.escrow` against the trusted escrow, `extra.reserver` against the
  trusted quote selector, and `extra.releaser` against the trusted fulfillment verifier account;
- on the destination chain: `extra.fulfillmentProxy` against the trusted fulfillment proxy;
- both tokens must be ones the trust source lists for their chain, and must be the same money:
  the same symbol, or in one peg group;
- the cap (`source.amount`) may exceed `fulfillmentAmount` by at most `maxMarkupBps`, after both
  are put in one unit using the tokens' decimals.

**The trust source.** By default the client asks `GET /v1/defaults` on Atum's production
gateways (`ATUM_DEFAULT_TRUST_GATEWAYS`: production mainnet and production testnet) and caches a
successful answer per chain for five minutes. Building the signed request itself makes no network
call; this lookup does, and so does a Turnkey signer when it signs. Pass `trust` to use another
source:

```ts
import {
  AtumEscrowTrustError,
  atumGatewayTrust,
  registerClient,
  type TrustedRoles,
} from '@atumlabs/mppx-atum-escrow/client';

// Another deployment's gateway (a staging environment, a local devnet, another operator)…
const method = registerClient({
  signer: { privateKey: process.env.PAYER_PRIVATE_KEY! },
  account: process.env.PAYER_ADDRESS!,
  trust: atumGatewayTrust({ gateways: ['http://localhost:8080'] }),
});

// …or a fixed set of addresses, with no network call. Each entry carries escrowContract,
// quoteSelector, fulfillmentVerifierAccount, fulfillmentProxy and the payable tokens.
const TRUSTED_CORRIDORS: Record<string, TrustedRoles> = {/* "eip155:8453": { ... } */};
const pinned = registerClient({
  signer: { privateKey: process.env.PAYER_PRIVATE_KEY! },
  account: process.env.PAYER_ADDRESS!,
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
> `pegGroups: [[...DEFAULT_PEG_GROUPS[0], "TUSDC", "TUSDT"]]`. The merchant's corridor needs the
> same `pegGroups`, or `validateCorridor` refuses it with the same code.

**The cap.** `maxMarkupBps` (default `DEFAULT_MAX_MARKUP_BPS`, 500) is the most the cap may exceed
`fulfillmentAmount`, in basis points. `pegGroups` (default `DEFAULT_PEG_GROUPS`, the US-dollar
stablecoins on the network's allowlists) lists the token symbols the payer treats as
interchangeable 1:1; passing it replaces the default. Tokens that are neither the same symbol nor
in one group are not priced against each other at all.

**Refusals.** Every refusal is an `AtumEscrowTrustError`, and nothing is signed. Branch on `code`
(or `name`), not on `instanceof`: each published Atum package bundles its own copy of this class,
so an error from one package is not an instance of another package's class.

| `code`                        | Meaning                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `UNTRUSTED_ESCROW`            | `extra.escrow` is not the trusted escrow                                                                                  |
| `UNTRUSTED_RESERVER`          | `extra.reserver` is not the trusted quote selector                                                                        |
| `UNTRUSTED_RELEASER`          | `extra.releaser` is not the trusted fulfillment verifier                                                                  |
| `UNTRUSTED_FULFILLMENT_PROXY` | the fulfillment proxy is not the destination chain's trusted proxy                                                        |
| `UNTRUSTED_ASSET`             | a token is not one the trust source lists for its chain; `field` says which (`source.asset` or `extra.destination.asset`) |
| `ASSETS_NOT_COMPARABLE`       | the two tokens are not the same money                                                                                     |
| `MARKUP_EXCEEDED`             | `source.amount` is above the bound; `expected` is the largest amount allowed                                              |
| `CHAIN_NOT_TRUSTED`           | the trust source serves nothing on the chain                                                                              |
| `TRUST_SOURCE_UNAVAILABLE`    | the trust source could not answer, or answered with something other than roles; retry only if the failure was transient   |

For the `UNTRUSTED_*` codes and `MARKUP_EXCEEDED`, `field`, `expected` (the trusted value or
bound) and `actual` (what the challenge asked for) say exactly what failed.

Before any of these checks, a challenge whose `fulfillmentAmount` is not a base-10 integer is
refused with a plain `Error`: it is a malformed challenge, not a trust verdict.

### Approving the source token

On EVM and Tron, the payer must approve the token-transfer contract (Permit2) to move the source
token before paying, or the escrow deposit reverts at settlement. `ensureSourceApproval` reads the
current allowance and sends an approval only if it falls short (it is a no-op on Solana, which
authorizes the transfer in the signed deposit itself):

```ts
import { Wallet, JsonRpcProvider } from 'ethers';
import { ensureSourceApproval } from '@atumlabs/mppx-atum-escrow/client';

const wallet = new Wallet(process.env.PAYER_PRIVATE_KEY!, new JsonRpcProvider(RPC_URL));
await ensureSourceApproval({
  network: 'eip155:8453',
  token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
  owner: wallet.address,
  signer: wallet,
  // Pass the source cap this charge needs (from the challenge). A leftover smaller allowance
  // then won't be mistaken for enough.
  requiredAllowance: BigInt(challenge.request.source.amount),
});
```

Paying from Tron takes a TronWeb instance instead of an ethers signer; everything else is the
same, and the Permit2 address for the network is resolved for you:

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

The approval sent is unlimited, so later charges on the same token need no further transaction.
To bound the approval that gets sent, pass `approvalAmount`. On its own the amount is treated as
its own requirement, so an allowance still holding the full bound is left alone rather than
re-approved — the right answer for a one-off approval. Across repeated payments, pair it with
`requiredAllowance`: Permit2 decrements the allowance on every payment, so a bound measured
against itself stops covering itself the moment the first charge lands, and every later call
would send another approval. Either way a bounded approval is consumed as it is spent and
eventually has to be granted again.

These helpers raise an allowance to what a payment needs; they never lower one. A wallet already
holding more than `approvalAmount` is left exactly as it is and reports `alreadySufficient`
without sending anything. Reducing or revoking an allowance is a separate operation, and not one
these perform.

`needsSourceApproval(params)` takes the same arguments and answers the same question without
sending anything, so it is safe to call before every charge:

```ts
if (await needsSourceApproval({ network, token, owner, signer })) {
  // tell the payer a one-off approval transaction is coming, before asking them to sign
}
```

## What the merchant `verify()` guarantees

`verify()` fails fast (no chain I/O) before submitting, and throws if any check fails. The Atum
Payment Gateway independently re-validates everything on submit; these checks just reject
obviously-bad input early:

- the source-chain deposit signature **recovers to the payer's own `source.account`** (an EVM/Tron
  secp256k1 recovery, or a Solana ed25519 verification against the signer's public key);
- the signed deposit's **token, escrow, and witness roles** match the challenge's source option;
- `max_source_amount` **does not exceed the source cap**, and the deposit authorizes exactly that;
- the **destination account, asset, and `fulfillment_amount`** are exactly what the merchant
  advertised (the deposit signature does not bind the receive side, so the method does);
- the **settlement-routing fields** — `escrow_contract_address`, `quote_selector`,
  `fulfillment_proxy`, and `fulfillment_verifier` — match the challenge. These travel in
  plaintext and aren't covered by the deposit signature, so the method checks them explicitly
  to stop a payer from redirecting settlement;
- the deadlines satisfy `now < quote_deadline < fulfillment_deadline`, and do not exceed the
  challenge's advertised budgets; and (for EVM/Tron) the deposit authorization **does not expire
  before `fulfillment_deadline`**, so a slow-but-valid settlement never lands on an expired signature.

On success you get an `AtumEscrowReceipt` — the MPP receipt plus the Atum payment it settled:

```ts
{
  method: "atum-escrow",
  status: "success",
  timestamp: string,               // when the receipt was issued (ISO 8601)
  reference: string,               // the payout transaction hash on destinationChainId
  paymentId: string,               // the Atum payment id, for status lookups
  state: "finalizing" | "completed",  // on chain but not yet final, or final
  destinationChainId: string,      // CAIP-2, e.g. "eip155:42161"
}
```

`state` is `finalizing` by default: the payout is on chain, not yet final, and serving the
resource then is accepting the risk that a chain reorganization drops it. Pass
`settleAt: 'completed'` to `registerServer` to get a receipt only once the payout is final, which
takes minutes on some chains; until then `verify()` throws `SettlementPendingError` and the payer
retries the purchase. How long a payout stays `finalizing`, and so how long that risk lasts,
depends on the destination chain and can change over time, for example when a chain moves to a
stricter finality rule. The fulfillment verifier publishes the current estimate per chain as
`time_to_final_ms` on `GET /v1/finality-config`. `AtumEscrowReceipt` is exported, so you can
name it in your own function signatures.

## Retries and idempotency

A retry must never become a second charge, and two different purchases must never collapse into
one. Both come down to a single value: the **per-purchase identifier** the merchant stamps into the
challenge.

```ts
const { request, meta } = buildChargeChallenge(corridor, source, amount, {
  intentId: order.id, // ← identifies the purchase
});
```

The payer derives the payment's `request_id` from `intentId`, and the gateway de-duplicates on that
`request_id`. So the identifier's lifetime _is_ the definition of "the same payment":

- **one value per purchase** — a value shared by two purchases makes the second resolve onto the
  first and go unpaid (see the merchant-side defence below);
- **the same value on every retry** of that purchase, including every re-issued `402` for it — a
  value that changes per attempt makes each retry a fresh charge;
- **never derived from the terms** — two orders for the same item have identical terms and must
  still be two payments.

Use the merchant's own order, invoice, or cart id. Notably it is _not_ the challenge id: that is an
HMAC over the challenge's own contents, so it moves whenever the expiry or the quote moves, neither
of which tracks the purchase.

A challenge carrying no identifier is **refused** by the payer's client rather than paid. There is
no fallback, deliberately: a per-attempt value would look like an idempotency key while letting
every retry be charged again.

On top of that, EVM and Tron sources get an on-chain backstop — the deposit nonce is derived from
the same identifier, and the escrow reverts a second deposit reusing it. Solana's replay nonce only
guards a short window, so there the gateway's `request_id` de-duplication is the durable protection.

### The merchant-side defence, and why you want it

Nothing can detect an identifier reused across two genuine purchases — the identifier _is_ the
identity, so the second purchase resolves onto the first payment and only one payment is made. As the
merchant, you can close that on your own side.

Both purchases resolve to the **same payment**, so `verify()` hands you the **same receipt** for
both — the same `paymentId` and the same destination transaction. Key fulfilment on the receipt
rather than on the incoming request, and the second purchase is recognised as already-fulfilled
instead of being shipped a second time against a single payment.

Treat this as your responsibility rather than the network's: `atum-escrow` guarantees you will not be
paid twice for one identifier, and receipt-keyed fulfilment is how you avoid _delivering_ twice for
one.

### Reusing an identifier with different terms

The gateway rejects a purchase identifier that comes back with different economics — who pays, who
receives, in which assets, or for how much — instead of silently resolving it to the first payment.
Surface it as a `PaymentRejectedError` from your submitter and the payer sees the cause; the fix is
always a distinct identifier per purchase.

## Settlement outcomes

A payment whose payout is on chain returns a receipt. A payment that is not on chain within the
gateway's synchronous window is **not** a failure, and the two are distinguished because they call
for opposite responses:

| `verify()` outcome                                      | Meaning                                                                                                         | What the payer should do                                                                                                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| receipt, `state: "finalizing"`                          | payout on chain, not yet final (the default)                                                                    | nothing — the resource is served                                                                                                                                                         |
| receipt, `state: "completed"`                           | payout final                                                                                                    | nothing — the resource is served                                                                                                                                                         |
| `SettlementPendingError`                                | accepted, still settling                                                                                        | re-attempt the **same** purchase; it resolves to this payment and returns its result                                                                                                     |
| `SettlementPendingError`, `state` is `refund_available` | not delivered; the deposit is still in escrow                                                                   | read `refund_signature` from the payment's status and submit it to the source escrow to return the funds. Do not pay again under a new identifier: a late delivery can still complete it |
| `SettlementFailedError`                                 | terminal failure, or `refunded`: not delivered and the funds were returned                                      | start a **new** purchase under a new identifier — this one can never settle                                                                                                              |
| `PaymentRejectedError`                                  | refused, nothing charged; also a rate limit (`429`)                                                             | fix the request and pay the same purchase again; for a `429`, wait before paying again                                                                                                   |
| `PaymentRetryableError`                                 | the gateway could not take the payment this time (for example `503 AUTHORIZATION_UNAVAILABLE`), nothing charged | wait a moment and re-attempt the **same** purchase, unchanged                                                                                                                            |

The pending and failed rows call for **opposite** actions, and the reason is worth stating: a
terminal failure keeps its identifier. The gateway does not release it, so re-attempting that
purchase under the same `intentId` resolves to the same dead payment for good — which is exactly what
you want for a pending payment and exactly what you must not do after a terminal one. Recovering from
a terminal failure therefore means minting a **new** `intentId`; it is a new purchase as far as the
network is concerned. Getting these two the wrong way round is how a payer either charges twice or
waits forever.

### What re-attempting a purchase means

Run the purchase again: request a fresh challenge, sign it again, and keep the **same `intentId`**.

That split — rebuild the authorization, reuse the identifier — is the whole contract, and each half
matters for a different reason. The `intentId` must not change because the payment's identity derives
from it; change it and the re-attempt is a second charge rather than a retry. Everything time-bound
must change because `quote_deadline` and `fulfillment_deadline` are **absolute timestamps**, fixed at
the moment the challenge was built.

So a credential you have already signed cannot simply be presented a second time. Once its quote
window has closed, `verify()` refuses it and says so — and on Solana it is worse than a policy
refusal, because the deposit authorization carries its own on-chain replay window that expires along
with the deadlines.

A payment-enabled `fetch` handles the rebuild-and-resubmit mechanics for you, since every attempt
fetches a new challenge — but its own retry loop is a fixed, short number of attempts with no delay
between them (3, by default; configurable via `maxPaymentRetries`, but that only changes how many
times it hammers the endpoint, not how long it waits). That is enough when settlement finishes almost
immediately, but not for a corridor that can genuinely take minutes: raising `maxPaymentRetries`
turns "retry a few times" into "retry rapidly, still for no longer," which is not the same thing as
waiting for settlement. For that, drive the retry yourself, with a real interval between attempts.

The example below is a _payer_ driving a _merchant_ over real HTTP — two separate processes, not two
functions called back to back — since that is the case `mppx.fetch` does not cover and this package
provides no shortcut for. `method.createCredential` (payer) and the merchant's own endpoint are on
opposite ends of the request; nothing here runs the merchant's `verify()` in the payer's process.

```ts
import { Transport } from 'mppx/client';
import type { AtumEscrowChallenge } from '@atumlabs/mppx-atum-escrow/client';

// `method` is the client from "Quick start — payer" above. The merchant is what keeps `intentId`
// stable across attempts (it must derive the same value from the order on every request); the
// payer never supplies or sees it directly, only the challenge that already carries it.
const transport = Transport.http();

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  // 1. Ask for the resource. The merchant answers 402 with a fresh challenge.
  const firstResponse = await fetch(url);
  if (!(await transport.isPaymentRequired(firstResponse))) return firstResponse; // free, or already paid

  // 2. Build and sign a payment for THIS challenge. The challenge arrives off the wire, so confirm
  //    it is this scheme's before signing against it — a bare cast would sign whatever the
  //    response contained. Each attempt re-signs — a full round trip for a Turnkey/KMS signer — so
  //    pick an interval below with that cost in mind, not one copied from a lightweight status poller.
  const offered = await transport.getChallenge(firstResponse);
  if (offered.method !== 'atum-escrow' || offered.intent !== 'charge') {
    throw new Error(`unexpected challenge ${offered.method}.${offered.intent}`);
  }
  const challenge = offered as AtumEscrowChallenge;
  const credential = await method.createCredential({ challenge });

  // 3. Resubmit with the credential attached. `response.ok` (200) is the only success case — a
  //    non-402 failure (e.g. PaymentRejectedError, a 400) is neither settled nor a fresh challenge
  //    to retry, so check for it explicitly rather than falling into the pending/failed handling
  //    below, which assumes a 402.
  const response = await fetch(url, transport.setCredential({}, credential, { challenge }));
  if (response.ok) return response; // paid & settled
  if (!(await transport.isPaymentRequired(response))) {
    const problem = await response.json();
    throw new Error(problem.detail ?? `request failed with ${response.status}`);
  }

  // Pending and failed are BOTH a 402 — the wire-visible discriminator is the problem-details
  // `type`, which the mppx framework's error classes fix per outcome (see isSettlementPending /
  // isSettlementFailed below for the merchant-side equivalent check). `paymentId` is its own
  // field too, not just interpolated into `detail`'s prose, so the payer can log/reconcile it
  // without parsing a sentence.
  const problem = await response.json();
  if (problem.type !== 'https://paymentauth.org/problems/payment-action-required') {
    throw new Error(problem.detail); // terminal — a new purchase needs a new intentId
  }
  // `payment-action-required` covers three different causes: a payment genuinely still settling
  // (paymentId present — it reached the gateway), a gateway that could not take the payment this
  // time (code present — nothing was charged), and this attempt's authorization having gone stale
  // before it could be submitted (neither — nothing reached the gateway yet). All three are
  // retried the same way; log accordingly rather than always saying "still settling".
  const why = problem.paymentId
    ? `still settling (payment ${problem.paymentId})`
    : problem.code
      ? `not taken this time (${problem.code}), nothing was charged`
      : 'authorization expired before submission';
  console.log(`attempt ${attempt}: ${why}, retrying with a fresh authorization`);
  await sleep(interval);
}
throw new Error(`purchase never settled after ${maxAttempts} attempts`);
```

Both settlement errors carry the gateway's `paymentId` for reconciliation — as its own field on
`toProblemDetails()`, not only interpolated into `detail`'s prose — and both extend the framework's
error types, so a merchant that does not distinguish them still gets the standard `402` +
problem-details response. A same-process merchant discriminates with `isSettlementPending` /
`isSettlementFailed` / `isPaymentRejected` / `isPaymentRetryable` on the thrown error object; a
payer, receiving only the wire response, discriminates on `type` as shown above, and within
`payment-action-required` on `paymentId` and `code`.

`PaymentRetryableError` is what a submitter throws when the gateway's error is classified
`RETRY_AFTER_DELAY` with `request_id_reusable: true`: the condition is transient and the purchase
identifier is still unused, so nothing about the request has to change. A `429` is the exception:
it stays a `PaymentRejectedError` whatever its classification, because a payment-enabled `fetch`
would re-attempt it at once, and every re-attempt spends the rate limit that ran out, which the
merchant's other payers share. Any other `4xx` is a `PaymentRejectedError` too, including one
whose body is not the gateway's error, such as an HTML 403 or 429 page from a proxy in front of
the gateway: its code is built from the status (`HTTP_403`), so a request refused in front of the
gateway is not reported as an unknown outcome. An error that names a `payment_id`, or that is
classified `RECONCILE_THEN_DECIDE` (such as `409 CONFLICT`), is neither: a payment may exist, and
only its own state can say whether anything was charged. That, and anything else — a `5xx`
without the retryable classification, a timeout, a transport failure — is an unknown outcome,
which the submitter rethrows unchanged.
`gatewayRefusalOf(err)` applies these rules to the gateway's own errors, as in the quick start.
A payment-enabled `fetch` re-attempts a `PaymentRetryableError` at once, a fixed number of times;
a payer that drives its own retries, as above, should wait between them.

Because the payer's retry is what collects a pending result, a `PaymentSubmitter` should submit and
return what the gateway said — **not** poll for completion. Polling holds the merchant's request
open for the whole settlement window and hides the pending state the retry depends on.

## Scope

This version supports the **`charge`** intent with **EVM, Tron, and Solana** source chains and a
merchant-configured destination chain. One source option is offered per challenge; a corridor may
list several and offer a different one per `402`.

> **Solana deadline constraint:** a Solana deposit authorization expires within the escrow's fixed
> on-chain replay window (~2 minutes), independent of the corridor budget. So a corridor that
> includes a Solana source must keep `fulfillmentDeadlineSeconds` within that window —
> `validateCorridor` (run by `buildChargeRequest`) enforces this and rejects a longer budget. If you
> need a longer budget for EVM/Tron sources, put the Solana source in its own corridor.

## API

Import everything from the root, or from the role-specific entry points (which expose only what
each side needs):

- `@atumlabs/mppx-atum-escrow` — everything below
- `@atumlabs/mppx-atum-escrow/client` — `registerClient`, `ensureSourceApproval`, `needsSourceApproval`, the trust API + payer types
- `@atumlabs/mppx-atum-escrow/server` — `registerServer`, `buildChargeChallenge`,
  `buildChargeRequest`, `validateCorridor`, `corridorFromDefaults`, the settlement errors +
  merchant types

| Export                                                                                             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerClient(config)`                                                                           | Payer-side method. `config`: `{ signer, account, now?, solanaClockReader?, trust?, maxMarkupBps?, pegGroups? }`. See [Trusted corridors and the spend cap](#trusted-corridors-and-the-spend-cap).                                                                                                                                                                                                                                                                                                                                                                                                   |
| `atumGatewayTrust(options?)`                                                                       | A trust source backed by gateways' `GET /v1/defaults` (default: `ATUM_DEFAULT_TRUST_GATEWAYS`), cached per chain. The default `trust`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `AtumEscrowTrustError`                                                                             | Why the client refused to sign a challenge; branch on `code`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DEFAULT_MAX_MARKUP_BPS`, `DEFAULT_PEG_GROUPS`                                                     | The client's defaults for `maxMarkupBps` (500) and `pegGroups`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `registerServer(config)`                                                                           | Merchant-side method. `config`: `{ submitter, now?, onCommitmentResult?, settleAt? }`; `settleAt` is `'finalizing'` (default) or `'completed'`; `onCommitmentResult(result, logFields)` receives every payee-check result, so you can count payments by `logFields.sender_auth_result` and log refusals. Returns an `AtumEscrowServer`, whose `verify()` resolves with an `AtumEscrowReceipt`.                                                                                                                                                                                                      |
| `buildChargeChallenge(corridor, select, fulfillmentAmount, { intentId, issuedAt? })`               | Builds a `charge` challenge — the payment terms plus the per-purchase identifier that makes a retry safe. **Use this.** Returns `{ request, meta }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `buildChargeRequest(corridor, select, fulfillmentAmount, options?)`                                | The payment terms alone, without the identifier. For supplying challenge metadata by hand.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `validateCorridor(corridor)`                                                                       | Validates a corridor's shape, per-source addresses and token metadata, and that every source token is the same money as the destination token (run automatically by both builders). Throws `AtumEscrowConfigError`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `corridorFromDefaults(defaults, params)`                                                           | Builds a corridor by fetching escrow/role/proxy addresses from the gateway `/defaults`. Token `symbol` and `decimals` are declared in `params`, not fetched.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `AtumEscrowConfigError`                                                                            | Why the server refused a corridor or a charge; branch on `code`: `INVALID_CONFIG` (a malformed field, named in the message), `ASSETS_NOT_COMPARABLE` (a source token that is not the same money as the destination token under the corridor's `pegGroups`; `network` names the source), `INVALID_AMOUNT` (a `fulfillmentAmount` that is not a plain base-10 integer), `CAP_BELOW_PRICE` (a cap that rounds to less than the price; `network` names the source) or `AMOUNT_EXCEEDS_CHAIN_LIMIT` (a fulfillment or cap larger than uint256 on EVM/Tron or u64 on Solana; `network` names that chain). |
| `ensureSourceApproval(params)`                                                                     | Ensures the payer has approved Permit2 to move the source token. `signer` for EVM, `tronWeb` for Tron; no-op on Solana.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `needsSourceApproval(params)`                                                                      | Whether `ensureSourceApproval` would send a transaction. Read-only, spends no gas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `SettlementPendingError`, `SettlementFailedError`, `PaymentRejectedError`, `PaymentRetryableError` | The non-receipt outcomes of `verify()`. See [Settlement outcomes](#settlement-outcomes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `isSettlementPending`, `isSettlementFailed`, `isPaymentRejected`, `isPaymentRetryable`             | Guards for the above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `gatewayRefusalOf(err)`                                                                            | The refusal a `PaymentSubmitter` throws for a gateway error — `PaymentRetryableError` or `PaymentRejectedError` — or `undefined` when the error does not show the payment was refused.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `atumEscrowChargeMethod`                                                                           | The base `mppx` method (advanced/custom wiring).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ChargeRequestSchema`, `CredentialPayloadSchema`                                                   | The `zod` wire schemas.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `METHOD_NAME` (`"atum-escrow"`), `INTENT` (`"charge"`)                                             | The method/intent identifiers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `INTENT_ID_META_KEY`                                                                               | The challenge-metadata key carrying the per-purchase identifier.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

Key types: `AtumEscrowCorridor`, `AtumEscrowSource`, `AtumEscrowAsset`, `AtumEscrowConfigErrorCode`, `SenderSigner`, `SenderSignerOptions`,
`PaymentSubmitter`, `PaymentSubmitResult`, `PaymentSettlementStatus`, `AtumEscrowClientConfig`,
`TrustResolver`, `TrustedRoles`, `TrustedToken`, `AtumEscrowTrustErrorCode`, `AtumGatewayTrustOptions`,
`AtumEscrowServer`, `AtumEscrowServerConfig`, `ChainDefaultsSource`, `EnsureApprovalResult`,
`AtumEscrowChallenge`, `AtumEscrowCredential`, `AtumEscrowReceipt`, `ChargeChallenge`, `ChargeRequest`,
`SettlementErrorDetails`, `PaymentRequest`.

> **EVM implementation note:** on EVM the deposit authorization is a Permit2
> `PermitWitnessTransferFrom` signature; Tron uses the equivalent TIP-712 typed data, and Solana
> uses an ed25519-signed deposit. The public API is the same across all three.

## Further reading

- [Accepting and making MPP payments with Atum](https://docs.atum.xyz/payment-protocols/mpp/overview)
- [Supported assets](https://docs.atum.xyz/get-started/reference/supported-assets) and [supported networks](https://docs.atum.xyz/get-started/reference/supported-networks)
- [MPP](https://mpp.dev)
- [Atum documentation](https://docs.atum.xyz)
