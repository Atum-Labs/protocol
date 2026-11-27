# Payment Gateway Client

TypeScript client for Atum Payment Gateway API with CLI support.
Full documentation: [docs.atum.xyz](https://docs.atum.xyz).

> Copyright 2026 Atum Labs, Inc.
>
> Licensed under the Apache License, Version 2.0. See the `LICENSE` file
> distributed with this package.

> NOTE: Before your first payment from an EVM or Tron chain, the source token must be approved
> for the Permit2 contract. Without it a payment is built, signed and accepted by the gateway,
> and then reverts on-chain at settlement. It is a one-off transaction per wallet and token —
> see [Approving the source token](#approving-the-source-token) for `ensureSourceApproval`,
> which does it for you.

## Installation

`@atumlabs/payment-gateway-client` is on the public npm registry.

To use the SDK in a project:

```bash
npm install @atumlabs/payment-gateway-client
```

To use the command-line tools, install globally so they are on your `PATH`:

```bash
npm install -g @atumlabs/payment-gateway-client
```

A project-local install also provides the commands, under `node_modules/.bin`, so
`npx send-payment ...` works without a global install.

## Supported corridors

A payment moves value from a source asset to a destination asset. The two can be on
different chains, and in different chain families.

Assets are named with [CAIP-19](https://chainagnostic.org/CAIPs/caip-19) identifiers:

| Chain family | Network      | Example asset identifier                                                                     |
| ------------ | ------------ | -------------------------------------------------------------------------------------------- |
| EVM          | Base Sepolia | `eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e`                              |
| Solana       | Devnet       | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Tron         | Shasta       | `tron:shasta/trc20:TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs`                                       |
| Stellar      | Testnet      | `stellar:testnet/sep41:<C... token contract id>`                                             |

Every row above is a testnet, so nothing here settles real value if it is copied by mistake.
The mainnet identifier for the same asset is a different string on every chain — take it from
[supported assets](https://docs.atum.xyz/get-started/reference/supported-assets), never by
editing one of these.

For the identifier of each supported token and network, see
[supported assets](https://docs.atum.xyz/get-started/reference/supported-assets) and
[supported networks](https://docs.atum.xyz/get-started/reference/supported-networks).

Copy identifiers exactly: base58 values, such as Solana chain references, token mints
and account addresses, are case-sensitive. The escrow and verifier addresses for a
chain are fetched by `preparePaymentRequest`, so you never supply them yourself.

Stellar needs a gateway that lists a Stellar chain: against one that does not, building the request
fails when the corridor addresses cannot be fetched, so these steps apply once your gateway supports
Stellar. A verifier that reads no chain admits a Stellar payment only when the signing key is the
payer's own account (registered as its own delegate); a payer that signs with a separate delegate key
can build and sign the request, but such a verifier refuses it.

A Stellar payment is authorized by a delegate signer: the payer registers it once on chain
(`create_delegate` on the escrow, plus a SEP-41 `approve` to the escrow, both signed by the payer's
Stellar account; `createStellarDelegate` below does both), and the SDK then signs each deposit digest
with that signer's ed25519 key. Pass the delegate signer's 32-byte seed as 64 hex digits to the raw signer;
signing with Turnkey is not supported for Stellar yet.

The deposit digest also commits to the `epoch` of the payer's delegate record, which rises each time
the payer re-registers a delegate, so a deposit signed under an earlier record is void. Pass it as
`stellarDelegateEpoch` (the escrow's `get_delegate` returns it), or let `preparePaymentRequest` read
it from the Soroban RPC, which needs the optional `@stellar/stellar-sdk` package and a payer that has
a delegate registered; it is never assumed. `stellarRpcUrl` overrides the RPC, which defaults to the
public testnet endpoint (other networks need one).

`createStellarDelegate` does the payer's one-time setup. It needs the optional `@stellar/stellar-sdk`
package and the payer's own account key as a 32-byte seed in 64 hex digits (Stellar's `S...` secret is
not accepted):

```ts
const { epoch } = await createStellarDelegate({
  sourceAsset: 'stellar:testnet/sep41:<C... token contract id>',
  escrow: '<C... escrow contract id from the payment>',
  trustedEscrow: '<C... escrow contract id from trusted deployment configuration>',
  depositorPrivateKey: payerSeedHex,
  delegateSigner: '<G... public key of the delegate signer>',
  capacity: 50_000_000n, // everything the delegate may deposit, in the token's smallest units
  maxTransferSize: 10_000_000n, // the most one deposit may take
  expiresInSeconds: 86_400, // or an absolute `expiration` in Unix seconds
});
```

Pin `trustedEscrow` in your application for the given Stellar network. The SDK compares the
requested escrow to that pin and checks the simulated authorization before signing.

It registers the delegate, reads the record back, and approves the escrow to pull the token (by
default for the whole `capacity`, until a ledger after the delegate expires; `allowance` and
`allowanceExpirationLedger` override both). The escrow assigns the `epoch`, so it is returned: pass it
as `stellarDelegateEpoch`. The escrow keeps one delegate record per payer and token, so the call
refuses when the payer already has one (revoke it with the escrow's `revoke_delegate` first). A
deposit counts against the delegate's remaining capacity and a refund does not give it back, so
register enough for the deposits you plan. Both allowance expiry options must fit the network's
maximum ledger-entry lifetime. For a delegate that outlives the allowance, pass a shorter
`allowanceExpirationLedger` and renew the allowance before it expires. If record readback or
approval fails after creation, `StellarDelegateSetupError` carries the creation transaction hash,
the epoch once it is known, and the original `expiration` and `allowanceExpirationLedger`. Check
the creation transaction and the on-chain delegate record and allowance. If the allowance still
needs approval, call `createStellarDelegate` with the same delegate parameters, set
`finishApprovalForEpoch` to the verified epoch, and pass the original absolute expiry values in
place of `expiresInSeconds`. This sends only the approval. It refuses a missing, changed, or
partially consumed delegate record.

The `delegateSigner` may be the payer's own key or a separate one; the escrow accepts both. A verifier
that reads no chain (`verifyPaymentRequest`, `verifyPaymentRequestJSON`) admits only the payer's own key
as its delegate, so a payment or award signed by a separate delegate is built and signed here but
refused offline with `DelegateUnverifiedError`; the party that pays it must read the escrow's
`get_delegate` for the payer and token.

`awardQuote` pays a Stellar quote the same way as on the other chains, with `stellarRpcUrl`,
`stellarClockReader`, `stellarDelegateEpoch`, `stellarDelegateEpochReader`,
`stellarDelegateRecordReader` and `stellarSigningKey` as for `preparePaymentRequest`, including the
refusal of an expired, spent or other-signer delegate record when the record is read. Before it signs
it runs the same guard as `signPaymentRequest`: the deposit message must be the deposit digest of its
own prehash, and a signer bound to another network is refused. On Stellar the quote request's `quote_selector` must be a `G...` account, and
the reserve must be signed by that account's key. Pass its signer as `selectorSigner` unless
`quote_selector` is the payer's own account and the payer is its own delegate. A reserve signed by
any other key is refused before the award is sent. The award is verifiable offline only when the payer is its own delegate (see above).

When it reads the record, `preparePaymentRequest` also refuses one the escrow would reject at
`deposit`, so the request does not pass the gateway and the auction only to revert: a record that has
expired at `issued_at`, one with no capacity left (renounced or spent), and, when you pass
`stellarSigningKey` (the `G...` strkey of the key that will sign; `send-payment` does), a record
whose registered signer is another key. A supplied `stellarDelegateEpoch` (or an epoch-only
`stellarDelegateEpochReader`) reads no record, so none of that is checked.

A Stellar key signs 32 bytes with plain ed25519, which is also how a Stellar transaction is signed, so
`signPaymentRequest` (and `send-payment`) sign a Stellar message only when it is the deposit digest of
its own `message_prehash` under the request's network and escrow, and refuse a Stellar key for a
request whose source is another network. A caller that signs with its own signer outside them calls
`assertRequestSignable(request, signer)` first.

## CLI Usage

The package provides six commands: `send-payment`, `approve-permit2`, `request-quote`,
`quote-status`, `award-quote`, and `payment-status`. After a global install:

```bash
send-payment [options] <sender> <amount> <sourceAsset> <receiver> <destinationAsset>
send-payment --submit <file> [options]
```

### Arguments

- `sender` - Depositor address (e.g., `0xF0D0...`)
- `amount` - Amount the receiver gets, in the destination token's smallest units (e.g., `100000` for 0.10 USDC)
- `sourceAsset` - Source asset in CAIP-19 format
- `receiver` - Destination account address
- `destinationAsset` - Destination asset in CAIP-19 format

### Options

- `-V, --version` - Output the version number
- `--gateway <url>` - Payment gateway URL (default: testnet)
- `--request-id <id>` - Idempotency key; seeds the on-chain deposit nonce. Re-run with the same id to re-attempt one payment. Omitted, an id is generated and printed, which makes every bare re-run a separate payment (see [Idempotency and retries](#idempotency-and-retries))
- `--request-id-prefix <prefix>` - Prefix for the auto-generated request id (default: `pmt-gw-cli`)
- `--max-source-amount <amount>` - Required to build a payment: the most the payer authorizes from source, in the source token's smallest units, signed into the Permit2. Never derived for you; the quoted `source_amount` from `request-quote` plus a slippage margin is the usual basis (the SDK's `capFromQuote` computes it). Not accepted with `--submit`
- `--allow-settler <did>` - Only take quotes from this settler DID; repeat it to allow several. `--whitelistSettler` still works
- `--prepare-only` - Build and sign the request, print it to stdout, and stop without submitting. For inspecting an authorization, or for review before paying; send it later with `--submit` (see [Preparing a payment for review](#preparing-a-payment-for-review)). Cannot be combined with `--wait`, `--wait-for`, `--wait-seconds` or `--auto-accept`
- `--submit <file>` - Send a request built earlier by `--prepare-only`, instead of building one. Signs nothing and needs no private key; `-` reads stdin. Takes no corridor arguments
- `--auto-accept` - Award the first valid quote at or under `max_source_amount` instead of waiting for `quote_deadline`; faster, but gives up competitive pricing. Not signed and never sent to settlers, so pass it when you submit, with `--submit` for a prepared request
- `--wait` - After submitting, keep checking until the payout is on chain (`finalizing`) or the payment fails
- `--wait-for <state>` - What `--wait` waits for: `finalizing` (default) or `completed`. `completed` waits until the payout is final, which takes minutes on some chains, so raise `--wait-seconds`. Implies `--wait`
- `--wait-seconds <n>` - How long `--wait` keeps checking (default: `60`). A convenience bound only; giving up does not affect the payment
- `-h, --help` - Display help

### Exit codes

`send-payment` reports the payment's ending, so `send-payment ... && <next step>`
runs the next step only for a final payment. If a payout on chain is enough for you,
treat `5` as success too:

| Code | Meaning                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------ |
| `0`  | `completed` — settled and final                                                                        |
| `2`  | `pending` or `refunding` — accepted, no result yet                                                     |
| `3`  | `failed` or `refunded` — terminal; a fresh attempt needs a new `--request-id`                          |
| `4`  | `refund_available` — not delivered, funds still in escrow; submit `refund_signature`, do not pay again |
| `5`  | `finalizing` — paid on chain, not yet final; normally becomes `completed`                              |
| `1`  | no outcome obtained (rejected, gateway unreachable, bad arguments)                                     |

On `2`, follow the payment with **`payment-status <payment_id>`** — the id is in the
output — or use `--wait` to have `send-payment` do it for you. Re-running
`send-payment` with the same `--request-id` also returns the current state, but it
rebuilds and re-sends the payment to do so, which is more work than a status
lookup.

`1` is the case that reverses that order. It means the outcome is **unknown**, not
that nothing happened: a request that timed out may still have been accepted, and
you may not have a `payment_id` to look up. Re-run with the same `--request-id`,
which resolves to the payment if one was created and creates it if not. The id is
printed on failure for exactly this.

`payment-status` is a lookup, so its exit code reports whether the lookup worked
(`0`) or not (`1`), never the payment's outcome — read `status` for that.

**The table describes a submitted payment, so it does not apply to `--prepare-only`.**
There, `0` means the request was built and signed — nothing was submitted and no
payment exists. Do not chain a payment-conditional step off a `--prepare-only` run.

### Asset format

`sourceAsset` and `destinationAsset` are CAIP-19 identifiers — see
[Supported corridors](#supported-corridors).

### Signing provider

Choose how the sender authorization is signed with `--provider` (default: `raw`).

Whichever provider you use, pass `pinnedAddress` to `createSenderSigner` with the payment's
source account. The SDK checks that the signing key resolves to that address before anything
is signed, so the wrong key fails immediately instead of producing a signature the gateway
rejects. This works on every chain and on both providers.

#### Private key (`--provider raw`, default)

Provide your private key via environment variable:

```bash
PRIVATE_KEY=0x... send-payment <args...>
```

If not provided, you will be prompted securely.

#### Turnkey (`--provider turnkey`)

Sign via a Turnkey-managed wallet instead of a local private key. Set the
Turnkey credentials in the environment; the `<sender>` argument is verified
against the wallet's address for the source chain (a mismatch fails fast):

```bash
export TURNKEY_ORGANIZATION_ID=...
export TURNKEY_WALLET_ID=...
export TURNKEY_API_PUBLIC_KEY=...
export TURNKEY_API_PRIVATE_KEY=...
send-payment --provider turnkey <args...>
```

Everything Turnkey signing needs is already declared as a dependency, so no extra
setup is required. The Turnkey code is loaded on demand, so the private-key path
does not pull in Turnkey or `@solana/web3.js`.

### Configuration file

The command-line tools also read an optional `.env` file from the directory you
run them in, so credentials and settings do not have to be retyped each time:

```bash
PRIVATE_KEY=0x...
GATEWAY_URL=https://payment-gw.production-testnet.atum.xyz
SOLANA_RPC_URL=
STELLAR_RPC_URL=
TURNKEY_ORGANIZATION_ID=
TURNKEY_WALLET_ID=
TURNKEY_API_PUBLIC_KEY=
TURNKEY_API_PRIVATE_KEY=
```

Where a setting has a matching flag, the flag takes precedence, then a value
already set in your environment, then `.env`, then the built-in default. Keep the
file out of version control — it holds signing keys.

This applies to the command-line tools only. The SDK does not read `.env`; pass
configuration as arguments, or set `GATEWAY_URL` in your own application's
environment.

### Output

- **PaymentRequest JSON** → `stderr` (for debugging/logging)
- **PaymentResponse JSON** → `stdout` (for parsing/automation)

Under `--prepare-only` there is no response, and the signed request is the result, so
it goes to `stdout` instead and the `stderr` copy is dropped. That keeps
`send-payment --prepare-only ... | jq` working.

### Example

```bash
PRIVATE_KEY=0xabc... send-payment \
  0xF0D0... \
  100000 \
  eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
  TRX123... \
  tron:shasta/trc20:TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs \
  --max-source-amount 101000
```

### Preparing a payment for review

`send-payment` builds, signs and submits in one step. To have the payment approved
before it is sent, split it in two: `--prepare-only` stops after signing and prints
the request instead, so you can see exactly what you are about to authorize — the
document is not a description of the payment, it _is_ the payment. `--submit` sends
one that was prepared earlier.

```bash
# 1. build and sign, submit nothing
send-payment --prepare-only --quote-deadline-seconds 30 --max-source-amount 101000 \
  0xF0D0... 100000 \
  eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
  0xMerchant... \
  eip155:42220/erc20:0xcebA9300f2b948710d2653dD7B07f33A8B32118C \
  > request.json

# 2. inspect it, have it reviewed

# 3. send it
send-payment --submit request.json --wait
```

Or piped, with no file on disk:

```bash
send-payment --prepare-only <args...> | send-payment --submit -
```

Four things to know:

- **`--prepare-only` still contacts the gateway.** The corridor addresses come from
  it, so this is not an offline signing mode.
- **Widen the quote window if you intend to submit later — but only by tens of seconds.**
  A prepared document is submittable only while its quote window is open, and the default
  is 3 seconds. That window is also the auction: the gateway waits it out before choosing
  a settler, and settler quotes expire on their own, so an over-long window ends in
  `QUOTES_EXPIRED`. That failure is terminal, and a fresh attempt needs a new request id.
  `--auto-accept` can award before the window closes, but settlers still decline a window
  longer than they hold their price, so keep it short either way. Give the reviewer enough
  time and no more.
- **`--submit` signs nothing and needs no private key** — the authorization is already
  in the file. It also cannot repair one: a request whose signature does not match its
  contents is rejected, and the fix is to prepare a new one.
- **Treat the prepared file like a signed cheque.** It is a signed authorization, not a
  draft: anyone who has it can send it, because `--submit` needs no key and the signature
  is already inside. Keep it where you would keep a credential, and delete it once the
  payment is sent or the request is abandoned.

`--submit` takes no corridor arguments, since the request already carries them, and it
rejects the options that only shape a request being built (`--request-id`,
`--quote-deadline-seconds`, `--provider` and the rest) rather than accepting and ignoring
them. It reports with the same exit codes and streams as an ordinary run.

Re-preparing with the same `--request-id` targets the **same payment** — the deposit nonce
is derived from the id, so it cannot pay twice — but it does not reproduce the same bytes.
The deadlines are stamped from the clock on each run and the signature covers them, so two
prepared documents for one payment always differ in `quote_deadline`,
`fulfillment_deadline` and the signature.

### Approving the source token from the CLI

`approve-permit2` grants the one-off approval described in
[Approving the source token](#approving-the-source-token). Run it once per wallet and token,
before the first `send-payment` from that token:

```bash
approve-permit2 <sender> <sourceAsset> --rpc-url <url>
```

```bash
# is one needed at all? reads the allowance, sends nothing, costs no gas
approve-permit2 0xF0D0... eip155:421614/erc20:0xaf88... --rpc-url https://... --check

# grant it
approve-permit2 0xF0D0... eip155:421614/erc20:0xaf88... --rpc-url https://...
```

This is the only command in the package that broadcasts a transaction and spends gas.

- `--rpc-url <url>` - RPC endpoint for the source chain. Also read from `RPC_URL`.
- `--check` - report whether an approval is needed, then exit. Needs no private key.
- `--amount <units>` - approve only this many smallest units instead of an unlimited approval.
- `--spender <address>` - approve a contract other than the canonical Permit2.

The private key comes from `PRIVATE_KEY` or an interactive prompt, never a flag — a flag would
put it in your shell history and in the process list. It is only requested once the allowance has
been read and an approval is genuinely due, so an already-approved wallet never has to produce
one, and it is checked against `<sender>` before anything is sent. The result JSON goes to stdout.

EVM and Tron. Solana needs no approval at all, and the command says so rather than doing nothing.

Tron additionally needs the `tronweb` package, which is an **optional** peer dependency so that
EVM-only installs do not carry it. Install it alongside the CLI when you pay from Tron:

```bash
npm install -g tronweb
```

### Paying with quotes from the CLI

`request-quote` asks settlers for quotes. Opening a quote request signs nothing.

At a terminal, it lists the quotes cheapest first. You pick one with ↑/↓ and Enter while each
quote's award window counts down, it shows what you pay and when an undelivered payment becomes
refundable, and pays it in the same run:

```text
$ request-quote 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 100000 \
    eip155:42161/erc20:0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
    0x90F79bf6EB2c4f870365E785982E1f101E93b906 \
    eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
    --max-source-amount 101000 --wait
Collecting quotes: 0.1 USDC (100000 units) on eip155:8453 to 0x90F79bf6EB2c4f870365E785982E1f101E93b906 …
3 quotes (qr_019f3c2a-7b1e-7d40-9a01-5e6f7a8b9c0d) for 0.1 USDC (100000 units) on eip155:8453 to 0x90F79bf6EB2c4f870365E785982E1f101E93b906

     you pay                      settler      award within
  ▶  0.10015 USDC (100150 units)  0x5A11…0b02  1m 52s
     0.10042 USDC (100420 units)  0x5A11…0a01  1m 52s
     0.10098 USDC (100980 units)  0x5A11…0c03  expired

  quote 0xe27041663d0a1063bfedb8a575959ca60be6e485ad7eb7c04a907179cd0dd866
  ↑/↓ move · 1-3 jump · Enter award · q quit
Pay 0.10015 USDC (100150 units) on eip155:42161 → 0.1 USDC (100000 units) on eip155:8453 to 0x90F79bf6EB2c4f870365E785982E1f101E93b906, refundable if not delivered by 2026-11-09T12:05:04.218Z (in 4m 52s)? [y/N] y
Enter private key (input hidden):
Awarded quote 0xe270…d866 → payment 0x9d418b65cb176ad0f0f863eb4c9c46a40fe5c0097289a6b58d388555372e5661
waiting up to 60s for 0x9d418b65cb176ad0f0f863eb4c9c46a40fe5c0097289a6b58d388555372e5661 to reach finalizing...
finalizing: payment 0x9d418b65… is paid on chain but not yet final. …
```

The table redraws every second. A quote whose award window runs out stays in its row, marked
`expired`, and the cursor skips it. Amounts read as tokens where `GET /v1/defaults` lists the token,
and always show the smallest units the deposit signs. Where keys cannot be read one at a time, or
stderr is not a terminal, it numbers the rows and asks for a number instead.

`q` stops without signing anything. `quote-status <quote_request_id>` shows the quotes again, and
`award-quote <quote_request_id>` lets you pick and pay one later, with the same table and the same
`Pay …? [y/N]` line. Quotes whose settler signature does not verify, or whose signer the quote
request's `settler_requirements` (`--allow-settler`) do not admit, are left out.

From a script or an agent (stdout or stdin is not a terminal), `request-quote` prints the quotes
and the quote request it sent as JSON, and signs nothing. `award-quote --from` pays from that
output without asking: the cheapest quote, or the `quote_id` you name. Awarding the cheapest without
naming it needs `--max-source-amount` on `request-quote`, so the price is bounded when no one is
asked.

```bash
request-quote <sender> <amount> <sourceAsset> <receiver> <destinationAsset> \
  --max-source-amount 101000 > quotes.json
PRIVATE_KEY=0x... award-quote --from quotes.json --wait
```

The deposit commits the quote request in that file, so the award pays exactly the receiver and
amount you asked for. From a script, `award-quote` takes only `--from`, not bare ids.

Amounts you pass are in each token's smallest units, and chains are CAIP-2 ids, as the API carries
them.
Signing (`PRIVATE_KEY`, the prompt, or `--provider turnkey`), `--wait` and the exit codes are those
of `send-payment`. Running the same award again resolves to the payment the first run made, and a
quote request is awarded once. Awarding for another account, when the quote request names a
different `quote_selector`, needs the SDK. See [docs/awarding.md](docs/awarding.md).

### Removing the command-line tools

```bash
npm uninstall -g @atumlabs/payment-gateway-client
```

## SDK Usage

### Basic Setup

```typescript
import {
  PaymentGatewayClient,
  createSenderSigner,
  signPaymentRequest,
  getErrorResponse,
  ApiError,
} from '@atumlabs/payment-gateway-client';

const client = new PaymentGatewayClient({
  BASE: 'https://payment-gw.production-testnet.atum.xyz', // or your gateway URL
});
```

### Gateway URL

The client uses the production-testnet gateway by default. To target another
environment, in order of precedence:

1. Pass it explicitly — SDK `new PaymentGatewayClient({ BASE })`, or the CLI `--gateway` flag.
2. Set the `GATEWAY_URL` environment variable.
3. Otherwise the built-in default `https://payment-gw.production-testnet.atum.xyz` is used.

Mainnet access is granted by Atum; use the mainnet gateway URL provided to you.

### Timeouts

Requests are bounded so an unresponsive gateway fails rather than hanging. There
are two budgets, because some endpoints are held open by the gateway on purpose
while it collects quotes or settles a payment:

| Budget              | Default | Applies to                                                                 |
| ------------------- | ------- | -------------------------------------------------------------------------- |
| `timeoutMs`         | 30s     | requests the gateway answers as soon as it can                             |
| `syncWaitTimeoutMs` | 120s    | `POST /v1/payments`, `POST /v1/payments/awards`, and any `wait: true` call |

```typescript
const client = new PaymentGatewayClient({ timeoutMs: 10_000, syncWaitTimeoutMs: 60_000 });
```

Exceeding either raises a `GatewayTimeoutError` (see Error Handling). Raise
`syncWaitTimeoutMs` if your gateway is configured with a larger
`payment_sync_wait_seconds` than the 30s default, since it must clear that cap.
For a single request, an interceptor that sets `timeout` takes precedence over
both.

### Example: Tron to Celo Sepolia Payment

```typescript
async function sendPayment() {
  // Private key from environment variable
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('PRIVATE_KEY environment variable required');
  }

  // Tron sender address (base58 format)
  const tronSender = 'TYourTronAddressHere';

  // Prepare the payment request
  const paymentRequest = await client.preparePaymentRequest({
    depositor: tronSender,
    fulfillmentAmount: '100000', // 0.10 USDT (6 decimals)
    sourceAsset: 'tron:shasta/trc20:TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs', // USDT on Tron Shasta
    destinationAccount: '0xYourEthereumAddressHere',
    destinationAsset: 'eip155:11142220/erc20:0x456a3D042C0DbD3db53D5489e98dFb038553B0d0', // USDC on Celo Sepolia
    // Required. The most the payer authorizes from source, in USDT's smallest units, signed into
    // the Permit2. The SDK never derives it; capFromQuote builds one from a settler quote.
    maxSourceAmount: '101000',
    // Required. Your stable idempotency key — reuse the SAME value on retry so a
    // retry never becomes a second payment (see "Idempotency and retries" below).
    requestId: 'order-4711',
  });

  // Sign the prepared request with the SDK signer helper. It handles the
  // per-chain signing differences internally (EVM typed-data, Tron hash,
  // Solana Ed25519), so you never touch a chain library directly.
  const sourceChainId = 'tron:shasta'; // CAIP-2 chain id, i.e. sourceAsset.split('/')[0]
  const signer = createSenderSigner(sourceChainId, {
    provider: 'raw',
    privateKey,
    pinnedAddress: tronSender,
  });
  await signPaymentRequest(paymentRequest, signer);

  try {
    // Submit the payment
    const response = await client.payments.submitPayment({
      requestBody: paymentRequest,
    });

    // A 2xx means the payment was accepted, NOT that it settled. Branch on `status`:
    // cross-chain settlement can outrun the gateway's synchronous window, so an accepted
    // payment may still have no result yet. See "Idempotency and retries" below.
    console.log('Payment ID:', response.payment_id);
    if (response.idempotent_replay) {
      // This request_id had been used before, so this is the payment your earlier attempt
      // created. Nothing additional was charged.
      console.log('Handed back an existing payment');
    }

    switch (response.status) {
      case 'completed':
        console.log('Settled.');
        console.log('Source TX:', response.transactions?.deposit?.transaction_hash);
        console.log('Destination TX:', response.transactions?.fulfillment?.transaction_hash);
        break;
      case 'finalizing':
        // Paid on chain, not yet final. It normally becomes `completed`; acting on it now is
        // accepting the risk that a chain reorganization drops it.
        console.log(
          'Paid on chain, not final yet:',
          response.transactions?.fulfillment?.transaction_hash,
        );
        break;
      case 'failed':
        // Terminal, and this request_id stays bound to it. A fresh attempt needs a NEW id.
        console.error('Failed:', response.error?.code, response.error?.message);
        break;
      case 'refunded':
        // Terminal and not delivered, so a fresh attempt needs a NEW id.
        console.error('Refunded:', response.payment_id);
        break;
      case 'refund_available':
        // Not delivered and the funds are still in escrow. getPaymentStatus(payment_id) returns
        // refund_signature, which returns them. Do not pay again: a late delivery can still land.
        console.error('Refund available:', response.payment_id);
        break;
      default:
        // Still settling. Do not release goods, and do not pay again under a new id.
        // Follow it with getPaymentStatus(payment_id); re-submitting this same request
        // also returns the current state, but it re-sends the payment to do so.
        console.log('Still settling — see "Tracking a payment" below.');
    }

    return response;
  } catch (error) {
    const gwError = getErrorResponse(error);
    if (gwError) {
      console.error('Gateway error:', gwError.code, gwError.message, gwError.request_id);
    } else if (error instanceof ApiError) {
      console.error('HTTP', error.status, error.statusText, error.url);
    }
    throw error;
  }
}
```

`submitPayment` also sends two optional headers, `X-Atum-Producer: sdk-ts` and the body's
depositRequestHash v2 in `X-Atum-Deposit-Request-Hash-V2`, unless you pass `xAtumProducer`
yourself. They are used for compatibility diagnostics only and never change how the payment is
processed.

### Tracking a payment

A 2xx from `submitPayment` means the payment was accepted, not that it settled. Read
`status` on the response, and follow the payment while it is still `pending`.

**Store your `request_id` before you call `submitPayment`, not after.** It is the only
handle that survives a crash between sending the request and receiving the response, and
it is what you need to find the payment again.

| Status             | Meaning                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending`          | Accepted, not yet settled                                                                                                                                                                                                    |
| `finalizing`       | Paid on chain, not yet final                                                                                                                                                                                                 |
| `completed`        | Delivered and final                                                                                                                                                                                                          |
| `failed`           | Did not settle                                                                                                                                                                                                               |
| `refunding`        | Not delivered, the escrowed funds are being returned. Not final                                                                                                                                                              |
| `refund_available` | Not delivered, funds still in escrow. `getPaymentStatus` returns `refund_signature`, which you submit to the source escrow to return them. Not final: it becomes `refunded`, or `completed` if a late delivery is paid first |
| `refunded`         | Not delivered, your funds were returned                                                                                                                                                                                      |

On the three refund statuses `refund_reason` says why the settler gave up, when it said. Act on
`status`, not on `refund_reason.retry_classification`.

`completed`, `failed` and `refunded` are final. A payment that reaches one of them keeps
its `request_id` for good, so re-submitting that id returns the same finished payment
rather than trying again — a genuine new attempt needs a **new** `request_id`. Any status
this client does not recognise is treated as still in flight. `isTerminalStatus` is exported
so you can ask that question without keeping your own copy of the list: a value added to the
contract then cannot silently read as finished in your code.

`getPaymentStatus` returns the payment's state at that moment:

```typescript
import { isTerminalStatus } from '@atumlabs/payment-gateway-client';

const snapshot = await client.payments.getPaymentStatus({ paymentId });

if (!isTerminalStatus(snapshot.status)) {
  // Still in flight. Do not release goods.
}

if (snapshot.error) {
  // Present when the payment failed. The chain, transaction hash and revert reason are
  // under `blockchain_context`, not on the error itself.
  console.error(
    snapshot.error.code,
    snapshot.error.message,
    snapshot.error.blockchain_context?.transaction_hash ?? '',
  );
}
```

#### Waiting for an outcome

`getPaymentStatus` answers once and does not wait. To follow a payment to its end, use
`waitForStatus`, which is the same helper behind the `send-payment --wait` flag:

```typescript
import { waitForStatus } from '@atumlabs/payment-gateway-client';

const outcome = await waitForStatus({
  fetchStatus: () => client.payments.getPaymentStatus({ paymentId }),
  budgetMs: 60_000,
  onError: (error) => console.warn('status check failed, still waiting:', error),
});

if (outcome.timedOut) {
  // Still in flight when the budget ran out. Not a failure — check again later.
} else {
  console.log(outcome.snapshot?.status);
}
```

A failed status check does not end the wait: a network blip while a payment is settling is
the worst moment to stop looking, so failures are counted in `outcome.errorCount`, reported
through `onError`, and polling continues.

`budgetMs` defaults to `DEFAULT_WAIT_BUDGET_MS` (one minute) and is in **milliseconds**.

By default the wait ends at `completed`, `failed` or `refunded`, and at `refund_available`, where
the refund is waiting on you. Pass `waitFor: 'finalizing'` to also end it as soon as the payout is
on chain, which on some chains is minutes before `completed`; `send-payment --wait` does this by
default.

Checks are `DEFAULT_POLL_INTERVAL_MS` apart
(2 seconds) by default; pass `intervalMs` to widen it, and if you are following many
payments at once, stagger their start times so their polls do not align.

Pass a `signal` to stop a wait early, for a process draining on shutdown or a request that
has been cancelled. The outcome then reports `aborted`, and still carries the last status it
read. `timedOut` is true whenever the wait ended before reaching a status it stops at, so
branching on it stays correct either way; read `aborted` when you need to tell the two apart.

```typescript
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());

const outcome = await waitForStatus({
  fetchStatus: () => client.payments.getPaymentStatus({ paymentId }),
  signal: controller.signal,
});

if (outcome.aborted) {
  // Shutting down. The payment is unaffected; pick it up again on the next start.
}
```

Running out of budget says nothing about the payment: `timedOut` means you stopped
watching, not that anything failed. Check again later rather than paying again — see
[Idempotency and retries](#idempotency-and-retries).

#### Finding a payment again

If a submit call threw, you may hold no `payment_id` — but the payment may still have been
created. `resolvePayment` turns the `request_id` you stored back into one. It throws an
`ApiError` with status `404` when the gateway has no payment recorded for that id:

```typescript
import { isApiError } from '@atumlabs/payment-gateway-client';

try {
  const { payment_id } = await client.payments.resolvePayment({ requestId: 'order-4711' });
  const snapshot = await client.payments.getPaymentStatus({ paymentId: payment_id });
  console.log(snapshot.status);
} catch (error) {
  if (isApiError(error) && error.status === 404) {
    // No payment recorded for that request_id yet.
  } else {
    throw error;
  }
}
```

A `404` is not proof that nothing happened. A submit that timed out may still be in flight,
and the gateway records the payment when it lands. **Never start a fresh payment under a new
`request_id` to recover** — that is a second payment, with real money on both. Re-submit the
**same** `request_id` instead: it returns the payment if one was created, and creates it if
not.

#### Step-by-step detail

`getPaymentTimeline` returns the payment's individual steps, each with its own status and,
for on-chain steps, a chain id and transaction hash. Use it to show progress, or to
investigate a payment that did not settle:

```typescript
const timeline = await client.payments.getPaymentTimeline({ paymentId });

for (const step of timeline.steps) {
  console.log(step.status, step.label, step.transaction_hash ?? '');
}

if (timeline.error) {
  // Why it failed, and where: for an on-chain failure this carries the chain id, the
  // transaction hash and the revert reason.
  console.error(
    timeline.error.code,
    timeline.error.message,
    timeline.error.blockchain_context?.revert_reason ?? '',
  );
}
```

A payment reads the same on every endpoint: `getPayment`, `getPaymentStatus` and
`getPaymentTimeline` all report the one `PaymentStatus`. `finalizing` means the
transaction paying your recipient is on chain but not yet final. Acting on it before
`completed` is accepting the risk that a chain reorganization drops it.

### Awarding a quote

`prepareQuoteRequest` and `quoteRequests.createQuoteRequest` open a quote request without signing
anything. `awardQuote` awards the quote you choose: it checks the quote against your quote request,
signs the deposit for exactly its `source_amount` and the reserve naming its settler, and sends the
award. `verifyFulfillmentQuote` in `/signing` checks a quote's settler signature before you choose
it. See [docs/awarding.md](docs/awarding.md).

### Solana signing

Solana signs with Ed25519, which does not let a verifier recover the signer's key from
the signature, so the key travels with the message as `payload.delegate_signer`.
`signPaymentRequest` and the command-line tools set it for you.

The key you sign with must be the payment's source account, which is what `pinnedAddress`
checks — see [Signing provider](#signing-provider).

### Error Handling

The gateway returns a typed, public error body — `ErrorResponse`
(`{ code, message, request_id?, payment_id?, docs_url?, domain? }`). Use
`getErrorResponse` to narrow a caught error to it; it returns `undefined` for
anything that is not a gateway error with that shape. `payment_id` is present only
when the error is about a specific payment, so it is absent on the validation and
authentication failures that happen before a payment exists. For transport-level
detail (HTTP status, URL), the thrown value is still an `ApiError`.

Input validation happens before any request, so those failures are a plain `Error` carrying the
message and no `ErrorResponse` — `getErrorResponse` returns `undefined` for them. Read
`error.message`.

```typescript
import {
  getErrorResponse,
  isGatewayTimeoutError,
  ApiError,
} from '@atumlabs/payment-gateway-client';

try {
  await client.payments.submitPayment({ requestBody: paymentRequest });
} catch (error) {
  const gwError = getErrorResponse(error);
  if (gwError) {
    console.error('Code:', gwError.code); // machine-readable category
    console.error('Message:', gwError.message); // safe, human-readable text
    console.error('Request ID:', gwError.request_id); // quote this to support
    console.error('Docs:', gwError.docs_url);
  } else if (isGatewayTimeoutError(error)) {
    // The gateway never answered within the client's budget. There is no
    // response and no status, so this is not an ApiError.
    console.error(error.message, error.timeoutMs);
  } else if (error instanceof ApiError) {
    // Transport-level failure with no typed body (e.g. a proxy/gateway error).
    console.error('HTTP', error.status, error.statusText, error.url);
  } else {
    throw error;
  }
}
```

A thrown error does **not** mean no payment was created — a request that timed out
may still have been accepted. Treat it as unknown rather than as a failure:

- If you already hold the `payment_id` from an earlier attempt, read
  `getPaymentStatus` — the cheapest way to find out what happened.
- If you do not, call `resolvePayment` with the same `request_id` to get the
  `payment_id`, then read its status. A `404` there means the gateway has no payment
  recorded for that id _yet_ — see [Finding a payment again](#finding-a-payment-again).
- Re-submitting the same `request_id` also works and needs no lookup: it resolves to
  the payment if one was created, and creates it if not. Never recover by starting a
  payment under a **new** `request_id`: that is a second payment, not a retry.

One code is worth handling by name:

```typescript
const gwError = getErrorResponse(error);
if (gwError?.code === 'IDEMPOTENCY_TERMS_MISMATCH') {
  // 409 — this request_id already identifies a payment with different economics.
  // Re-submitting cannot amend that payment; a genuinely different one needs a new
  // request_id. See "Idempotency and retries".
}
```

### Asset Identifiers

Assets are identified using the [CAIP-19](https://chainagnostic.org/CAIPs/caip-19) format,
`{chain_id}/{asset_namespace}:{asset_reference}` — see
[Supported corridors](#supported-corridors) for an example per chain family.

Identifiers are validated before a request is built, so a malformed one is reported with the value
and what to correct rather than surfacing from a chain library. The rules: both namespaces are
canonicalized to lowercase, an `eip155` chain id is decimal, an EVM token address is 20-byte hex
and, when mixed-case, must carry a valid [EIP-55](https://eips.ethereum.org/EIPS/eip-55) checksum,
and a native asset (`slip44`) has no contract to deposit so it is refused. `parseAssetIdentifier`
and `assetChainId` are exported if you want the same parsing and canonicalization in your own code.

The checksum rule applies to the destination as well as the source, which is stricter than the
gateway, and it is typo protection rather than a settlement guard. For a destination address you
cannot edit, the all-lowercase form is the same twenty bytes and is accepted. Do not reach for that
on the source: settler configuration matches the source asset identifier byte for byte, so
lowercasing it moves the failure to settlement instead of removing it.

## Approving the source token

On EVM and Tron the escrow moves your token through **Permit2**, so the token contract has to be
told that Permit2 may move it. That is a one-off transaction per `(wallet, token)` — every payment
afterwards is just an offline signature and costs nothing.

Skipping it produces the worst kind of failure: the request is built correctly, signed correctly
and accepted by the gateway, and then settlement reverts on-chain minutes later.

`ensureSourceApproval` reads the current allowance and sends an approval only if it falls short:

```ts
import { ensureSourceApproval, needsSourceApproval } from '@atumlabs/payment-gateway-client';
import { Wallet, JsonRpcProvider } from 'ethers';

const wallet = new Wallet(process.env.PRIVATE_KEY!, new JsonRpcProvider(RPC_URL));

const result = await ensureSourceApproval({
  network: 'eip155:11142220',
  token: '0x456a3D042C0DbD3db53D5489e98dFb038553B0d0',
  owner: wallet.address,
  signer: wallet,
});

if (!result.alreadySufficient) {
  console.log(`approved in ${result.txHash}`);
}
```

You supply the signer, so the SDK never picks an RPC endpoint for you — everything else in this
package is offline, and this is the one call that broadcasts a transaction and spends gas.

It waits for the approval to be mined before returning, so `txHash` means confirmed rather than
merely sent. That wait is bounded — one minute by default, `confirmation.timeoutMs` to change it —
and a timeout is reported as _unconfirmed_, not failed, because the transaction may still land.
Pass `onSubmitted` to receive the hash the moment it is broadcast, so a slow approval can still be
looked up:

```ts
await ensureSourceApproval({
  network,
  token,
  owner,
  signer,
  onSubmitted: (txHash) => console.log(`watching ${txHash}`),
  confirmation: { timeoutMs: 120_000 },
});
```

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

On EVM, some tokens — mainnet USDT is the one you are most likely to meet — refuse to move an
allowance straight from one non-zero value to another. If your wallet already holds a partial
allowance on such a token, the approval is reset to zero first, automatically, and the result
carries a `resetTxHash` alongside the usual `txHash`. The check costs nothing and sends nothing,
and a wallet with no allowance skips it entirely, so an ordinary approval still takes exactly one
transaction.

Tron does not do this. An ordinary TRC-20 accepts the change in place, so guessing otherwise would
burn an extra transaction at Tron's fee limit; if a Tron token ever does refuse, the error tells
you to approve zero first and retry.

Paying from Tron takes a TronWeb instance in place of the ethers signer. The Permit2 address for
the network is resolved for you:

```ts
await ensureSourceApproval({ network: 'tron:shasta', token, owner, tronWeb });
```

Solana needs no approval at all — the signed deposit authorizes the transfer itself — so the call
reports `alreadySufficient` without touching the chain.

### Checking without spending gas

`needsSourceApproval` takes the same arguments and answers the same question, read-only. Use it to
warn a payer that a transaction is coming before asking them to sign:

```ts
if (await needsSourceApproval({ network: 'eip155:11142220', token, owner, signer })) {
  // a one-off approval transaction is due first
}
```

### Bounded approvals

The approval sent is unlimited by default, which is why later payments need no further
transaction. Pass `approvalAmount` to bound the approval this sends instead.

On its own the amount is treated as its own requirement, so an allowance still holding the full
bound is left alone rather than re-approved — the right answer for a one-off approval. Across
repeated payments, pair it with `requiredAllowance`, as below: Permit2 **decrements** the
allowance on every payment, so a bound measured against itself stops covering itself the moment
the first charge lands, and every later call would send another approval. Either way a bounded
approval is consumed as it is spent and eventually has to be granted again:

```ts
await ensureSourceApproval({
  network: 'eip155:11142220',
  token,
  owner,
  signer,
  requiredAllowance: 1_000_000n, // what this payment needs
  approvalAmount: 5_000_000n, // approve only this much, not unlimited
});
```

These helpers raise an allowance to what a payment needs; they never lower one. A wallet already
holding more than `approvalAmount` is left exactly as it is and reports `alreadySufficient`
without sending anything. Reducing or revoking an allowance is a separate operation, and not one
these perform.

Permit2 contract addresses, if you would rather approve by hand:

| Chain                      | Address                                      |
| -------------------------- | -------------------------------------------- |
| EVM (virtually all chains) | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Tron mainnet               | `TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m`         |
| Tron Shasta                | `TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp`         |

## Funding the deposit yourself

`preparePaymentRequest` builds a request that the escrow funds from your Permit2 signature.
`prepareDirectDepositRequest` builds one that your wallet funds itself: it approves the escrow
and calls `directDeposit`, then submits a request with no `sender_auth`. Use it when the paying
account cannot sign a Permit2 permit, for example an access key allowed only plain token
approvals. The source must be an ERC-20 on an EVM chain.

The method signs nothing and sends nothing. It returns the request and the deposit that request
names, after checking the request against the rules the gateway applies, so a malformed request
is refused before you fund rather than after.

Two rules shape the flow:

- Submit only after the deposit is **final**: included in the source chain's `finalized`
  block. Finality can take tens of minutes on some chains. A number of confirmations is not
  the same thing, and finality observations can lag across providers.
- Settlers hold a price only briefly, so submit with a short remaining quote window, for
  example 45 seconds. A settler that holds its price for less declines with
  `QUOTE_WINDOW_TOO_LONG` in the failed payment's `decline_summary`, and one that needs more
  time to source the payout than the window leaves declines with `QUOTE_WINDOW_TOO_SHORT`.
  Either way, once the payment has failed, refund the deposit as
  [Direct deposits](docs/idempotency.md#direct-deposits) describes, then reissue with a shorter
  or longer `quote_deadline` to match.

**Leave `depositRequestHashVersion` unset.** The deposit commits the request through a
depositRequestHash, and the gateway derives a direct deposit's id at one version of it, which its
deployment sets. With the option unset, the method builds the deposit at the version the gateway
publishes for the source chain in `GET /v1/defaults` (`direct_deposit_request_hash_version`), so
a deposit you prepare after the gateway moves from version 1 to version 2 commits version 2, with
no change on your side. If you pass `resolvedDefaults`, read the source chain's defaults fresh for
each direct deposit: defaults read before the gateway changed version still build at the old one,
which the method cannot tell. The method throws a `DirectDepositError` before it returns anything,
so there is nothing to fund, when:

- you pass a version and the gateway publishes another: `reason` `gateway_version`;
- the gateway publishes no version and you pass none: `reason` `version_unpublished`. A gateway
  that predates that member publishes none, and there the option is required: pass the version
  its operator gives you. The method does not guess;
- the gateway publishes a version this release cannot commit: `reason` `version_unknown`,
  whatever you pass. Upgrade the package.

A version other than 1 or 2 is refused with `reason` `version` before any network call. The
result's `depositRequestHashVersion` is the version the deposit commits.

**Version 1 is deprecated** for direct deposits and will be retired. Every deposit prepared at
version 1 comes back with `deprecation` (`{ code: 'ATUM_DIRECT_DEPOSIT_V1', message }`), whose
`message` says what to do. With the option unset there is nothing to change on your side, so
nothing else is reported: your deposits move to version 2 when the gateway does. When you pass
version 1 yourself, the client also reports it as a `DeprecationWarning` with that code, once per
process. In Node.js it goes through `process.emitWarning`, so `process.on('warning')` sees it;
where `process.emitWarning` is not available, such as in a browser, it goes to `console.warn`.
`--no-deprecation` or `process.noDeprecation = true` silences it either way. Under
`--throw-deprecation` (`process.throwDeprecation = true`) the method rejects instead, every time
and before it returns a deposit, with an `Error` named `DeprecationWarning` whose `code` is
`ATUM_DIRECT_DEPOSIT_V1`, so you can catch it.

Build the request once, fund it, and submit those same bytes once the deposit is final. Give it a
`quoteDeadlineSeconds` comfortably longer than your deposit usually takes to become final, and
once the deposit is final, wait until a short quote window remains before you submit:

```ts
import { randomUUID } from 'node:crypto';
import { encodeDirectDepositCalldata } from '@atumlabs/payment-gateway-client';
import { Contract, Wallet, JsonRpcProvider } from 'ethers';

const provider = new JsonRpcProvider(RPC_URL);
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

// 1. Prepare once. With depositRequestHashVersion unset, the deposit commits the gateway's version.
const { request, deposit, depositRequestHashVersion } = await client.prepareDirectDepositRequest({
  depositor: wallet.address,
  sourceAsset: 'eip155:11142220/erc20:0x456a3D042C0DbD3db53D5489e98dFb038553B0d0',
  destinationAsset: 'eip155:84532/erc20:0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  destinationAccount: '0x742D35cC6634c0532925a3b844Bc9e7595F41360',
  fulfillmentAmount: '1000000',
  maxSourceAmount: '1030000', // the amount you deposit, fees included
  requestId: randomUUID(), // unguessable: see below
  depositNonce: 4711n, // any uint256 you have not used for a deposit from this wallet
  fulfill: 'settler',
  quoteDeadlineSeconds: 1800, // example; comfortably longer than finality takes on the source chain
  fulfillmentDeadlineSeconds: 2700, // example; the quote window plus the payout
});
// Persist requestId, depositNonce, depositRequestHashVersion and JSON.stringify(request) BEFORE funding.

// 2. Fund it, and wait until the chain's finalized block includes it.
const escrow = request.escrow_contract_address;
const token = new Contract(deposit.input.token, ['function approve(address,uint256) returns (bool)'], wallet);
await (await token.approve(escrow, deposit.input.amount)).wait();
const funding = await wallet.sendTransaction({ to: escrow, data: encodeDirectDepositCalldata(deposit.input) });
const receipt = (await funding.wait())!;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
while (((await provider.getBlock('finalized'))?.number ?? -1) < receipt.blockNumber) await pause(15_000);
await pause(15_000); // a settler's node can be a little behind yours

// 3. Submit the same request once a short quote window remains, here 45 seconds.
const remaining = Date.parse(request.quote_deadline) - Date.now();
if (remaining < 20_000) throw new Error('finality left no usable quote window: refund the deposit');
await pause(Math.max(0, remaining - 45_000));
const payment = await client.payments.submitPayment({ requestBody: request });
if (payment.payment_id !== deposit.depositId) {
  throw new Error('the gateway named another deposit: refund the deposit');
}
// A retry re-submits exactly the stored bytes.
```

This one flow serves both versions; at version 1 the deposit commits only the request id, so
submitting the bytes you funded works there too. Do not prepare the request again after funding:
under version 2 a second build names a different deposit, so once the gateway moves to version 2,
an integration that prepares twice submits a request naming a deposit it never funded, and the
deposit it did fund names no payment and must be refunded. If finality arrives too late to leave a
usable quote window, refund the deposit: with less than about 20 seconds left, settlers may not
read your deposit and quote before the auction closes.

The payment id the gateway returns is the deposit id only when the deposit commits the version
the gateway derives at when you submit. The method checks the version against the published one
when you prepare, so "no change on your side" holds for every deposit you prepare after the
gateway changes version. A deposit you funded but had not yet submitted when the gateway changed
version names no payment: the `payment_id` comparison after submitting catches it, before you wait
out a payment that cannot be served, and the deposit comes back only through `refundUnreserved`.
Keep the time between preparing and submitting as short as finality allows.

Set `fulfillmentDeadlineSeconds` to cover `quoteDeadlineSeconds` plus the payout. Larger payouts
can require a longer payout window, including time comparable to the source chain's finality
wait even when the deposit is already final, so allow more, for example 3600 seconds beyond the
quote window. A settler that needs more declines with `DEADLINE_TOO_SHORT` in the failed
payment's `decline_summary`; refund the deposit as
[Direct deposits](docs/idempotency.md#direct-deposits) describes.

What each input commits you to:

- **`depositRequestHashVersion`**: leave it unset, as above, also when you prepare a funded
  version 1 deposit again to recover it, as [Direct deposits](docs/idempotency.md#direct-deposits)
  describes. Submit the result only if the returned `depositRequestHashVersion` is the version you
  stored and `deposit.depositId` is the id of the deposit you funded; otherwise refund that deposit
  with `refundUnreserved`. Pass the option only to a gateway that does not publish
  `direct_deposit_request_hash_version`: the version its operator gives you, or, to recover a
  funded deposit there, the version you stored with it. At version 1 the method then reports the
  deprecation warning, and under `--throw-deprecation` it rejects: refund a funded version 1
  deposit there rather than prepare it again. The `deposit_request_hash_version` and
  `deposit_request_hash_versions` members of `GET /v1/defaults` describe Permit2 signatures only
  and say nothing about direct deposits.
- **`requestId`** has to be unguessable when the deposit commits version 1, because the deposit
  then commits only its hash: the method refuses anything but a UUIDv4 from `randomUUID()` there,
  an order number included, whether you passed version 1 or the gateway published it. Use
  `randomUUID()` for every direct deposit, so a gateway changing version never changes what you
  send. Under either version, keep it undisclosed until you submit: a submission that takes it
  first blocks yours. Generate it once, persist it before funding, and reuse it with
  `depositNonce` for this deposit.
- **`depositNonce`** is yours to choose, unlike the Permit2 path where the SDK derives it from
  `requestId`. The escrow accepts each nonce once per depositing wallet. Store it with
  `requestId` before you fund, and never pick a new one to retry the same payment: a new nonce
  is a second deposit.
- **`fulfill`** names who performs the payout leg. `'settler'` leaves it to the settler.
  `'originator'` gives it to you; it is delivered with an EIP-3009 `transferWithAuthorization`
  on the destination token, so a destination token without EIP-3009 is refused.

Before you fund, check that someone pays this pair: `prepareQuoteRequest` with the same
corridor and a separate `requestId`, then `quoteRequests.createQuoteRequest`. A batch that ends
`ready` with an empty `quotes` array means no settler would quote it now, so do not fund. Quotes
there do not guarantee a quote on your deposit, but their absence is a reliable stop.

**What to keep.** Store the request you submit as `JSON.stringify(request)`, with the
`depositRequestHashVersion` the method returned. `deriveDirectDeposit` gives the deposit back
from them, `unreserved` included, so you do not need to store the returned `deposit`, whose
amounts are bigints that `JSON.stringify` refuses:

```ts
import { deriveDirectDeposit, type DirectDepositPaymentRequest } from '@atumlabs/payment-gateway-client';

const stored: DirectDepositPaymentRequest = JSON.parse(storedRequestJson);
// the source chain id, the escrow the request names, and the depositRequestHashVersion you stored
const restored = deriveDirectDeposit(storedRequestJson, 11142220n, stored.escrow_contract_address, depositRequestHashVersion);
```

**Retrying.** Re-submit the stored request, byte for byte. A request built again has new
deadlines, and under version 2 it names a different deposit, one you did not fund. If the first
request was stored, the gateway answers the rebuilt one with that stored payment, so check that
its `payment_id` is the deposit you funded; if the first was never stored, the rebuilt one becomes
a payment for a deposit nobody funded. Never fund a second deposit while the first is still in
escrow; refund it first. See [docs/idempotency.md](docs/idempotency.md#direct-deposits) for each
gateway answer and what to do after it.

**Getting the deposit back.** A deposit no settler reserved can be returned by the wallet that
made it, with `refundUnreserved`. Do it only once the payment has failed
(`payments.getPaymentStatus({ paymentId: payment.payment_id })`), or the gateway never stored
it, or it stored it under another id, or it answered `409 IDEMPOTENCY_TERMS_MISMATCH` or
`409 CONFLICT` and none of your earlier bytes gets a `200`; a refund races a settler's
reservation, and whichever lands first wins. Compare against the deposit you funded, the
`depositId` of the request you funded, never one from a request you built again. If
`refundUnreserved` reverts because a settler already reserved the deposit, do not fund again:
follow the payment that holds it. `deposit.depositId` and `deposit.unreserved` hold every member it needs:

```ts
const escrowContract = new Contract(
  escrow,
  [
    'function refundUnreserved((bytes32 depositId, bytes32 depositRequestHash, bytes32 destinationHash, address token, uint256 amount, address reserver, address releaser) input)',
  ],
  wallet,
);
const { depositRequestHash, destinationHash, token: depositedToken, amount, reserver, releaser } =
  deposit.unreserved;
await (
  await escrowContract.refundUnreserved({
    depositId: deposit.depositId,
    depositRequestHash,
    destinationHash,
    token: depositedToken,
    amount,
    reserver,
    releaser,
  })
).wait();
```

## Idempotency and retries

Every write request carries a `request_id`. Pass a stable value and reuse the
exact same one on every retry (a timeout, a network blip, a restart) and you end
up with one payment, not two — and you get the same answer each time. One contract
covers `submitPayment` and `createQuoteRequest` alike.

- Using this SDK, `request_id` is **required** on both builders
  (`preparePaymentRequest`, `prepareQuoteRequest`) and neither invents one — an id
  the library chose is an id you cannot reuse on a retry. On the payment path it is
  the only thing you manage: the SDK derives the on-chain deposit nonce
  deterministically from it, so retries line up on their own.
- On the CLIs, `--request-id` is optional; when omitted an id is generated and
  printed, so you can re-run with `--request-id <id>` to re-attempt the same
  payment or recover the same batch. A bare re-run, with no `--request-id`, is a
  **separate** payment or batch.
- Re-sending an id returns what it created the first time — the original payment,
  or the original quote-request batch — and creates nothing new.
- A genuinely new request needs a **new** `request_id`. Reusing one with different
  economics (a corrected amount, a different token) is rejected with `409`
  `IDEMPOTENCY_TERMS_MISMATCH` — one id identifies one payment, or one batch.
- Deadlines and the signature are exempt, so a re-submission of the original
  bytes is fine even though its deadlines have expired by then. This is what makes
  a lost `createQuoteRequest` response recoverable: re-send it and you get your
  `quote_request_id` back.
- `idempotent_replay` on the response tells you whether you were handed something
  that already existed.
- `pending` is not success. It means accepted and still settling: re-submit the
  same `request_id` to collect the result. A `failed` payment is terminal and
  keeps its id, so recovering from one needs a new id.

See [docs/idempotency.md](docs/idempotency.md) for the full model: the two
guarantees and which endpoints each covers, when the `409` applies, how to read
the outcome, and the per-chain differences (EVM/Tron vs Solana).

## Signing

A PaymentRequest carries three unrelated signatures: `signPaymentRequest` authorizes the
on-chain transfer, `signDeclaration` attests the document, and an identity envelope carries the
originator. None substitutes for another.

Both signing surfaces take a **signer**, never a private key, so a key held in a KMS, an HSM or
a custodial provider works without leaving its boundary; `signerFromEthersWallet` covers a local
key. See [docs/signing.md](docs/signing.md) for which signature to use when, what the proof does
and does not cover, and the two details a custodial signer must get right. An award signs the
deposit and a reserve; see [docs/awarding.md](docs/awarding.md).

## What is in the package

- `dist/` — compiled JavaScript and TypeScript declarations, ready to use
- `dist/cli/` — the six command-line tools
- `docs/` — reference documentation, including [idempotency and retries](docs/idempotency.md),
  [signing](docs/signing.md) and [awarding a quote](docs/awarding.md)
- `LICENSE`, `THIRD-PARTY-NOTICES.txt` — license terms and third-party attribution
