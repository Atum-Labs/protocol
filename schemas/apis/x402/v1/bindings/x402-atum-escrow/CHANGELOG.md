# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Stellar source and destination addresses. The server config accepts a Stellar `G…` account or
  `C…` contract strkey wherever it accepts an EVM or base58 address, and a Stellar token is named
  `stellar:<network>/sep41:<contract>`. `StellarSigner` (`{ publicKey, sign }`, the same shape as
  `SolanaSigner`) is exported from `/client`, and the facilitator recognises the `STELLAR` deposit
  scheme on `stellar:*` networks. The payer's account key is also its delegate key: the facilitator
  (through the shared sender_auth library) refuses a deposit whose `delegate_signer` is not
  `source.account`, so the payer registers that key
  as its own delegate on the escrow (`create_delegate`, then the token `approve`) before paying.
  A Stellar payment cannot settle yet: this package builds, verifies and relays one, but no
  payment gateway accepts a Stellar source until the gateway ships its own Stellar support.
- `stellarDelegateEpochReader` (required for a Stellar source) and `stellarClockReader` (optional)
  on the client config. The deposit commits to the epoch of the payer's delegate record, which is
  on-chain state, so the client reads it and refuses to sign without a reader. The server config
  refuses a `fulfillmentDeadlineSeconds` above a day for a Stellar source, the longest the escrow
  admits.

### Changed
- The bundled signing libraries' `verifyVP` passes a credential of an unreserved type through untouched, in the new `passThroughClaims`, instead of checking it against the verifier's trusted issuers; a credential of a reserved type (`reservedVCTypes` together with `requiredVCTypes`) is checked as before, in any JSON-LD spelling of that type. It also gains `extraCredentialContexts`, the pinned contexts of credentials that aren't Atum's. This package does not verify presentations, so its behavior is unchanged.
- The bundled signing libraries can verify a payer's wallet-signed (EIP-712) payment request and payment request envelope where the verifier asks, and no longer accept the settler identity typed form on a payment request envelope. The facilitator verifies neither, so payments behave as before.
- The bundled PaymentRequest schema describes `quote_selector` as the account that picks the settler and signs the reserve. Only the description changed: payments are validated as before.
- The facilitator verifies a Solana deposit signature the way the Solana ed25519 program does, so a
  signature for a small-order public key, or one whose `R` is a small-order point, is refused before
  the payment is submitted. Ordinary wallet keys and signatures are unaffected; the program never
  accepted these.
- The Known to Atum v2 credential context brings no behavior change for x402 integrations.

## [0.6.0] - 2026-11-03

> **BREAKING: the client, the server and the facilitator must all run 0.6.0.** A payment's
> `request_id` now depends on the page it pays for, so a 0.5.0 client and a 0.6.0 facilitator, or
> the reverse, derive different ids and every payment is refused. A 0.6.0 client refuses a 402 from
> a 0.5.0 server, which publishes no page. Atum's hosted facilitator ships the same page-bound
> derivation at the same time.

### Security
- A payment is bound to the page it pays for. A payment for one route could be presented, with the
  same identifier, as payment for another route of the same price: the gateway de-duplicates on
  `request_id` and answered with the original receipt, so the second route was served without a
  second payment. Payment identity is now (page, identifier, account), and the facilitator refuses
  a payment whose `request_id` was derived for any other page.

### Changed
- **Breaking:** the server adds `extra.atumResource` to every atum-escrow accept: the request's
  upper-cased method, a space, the routed path as received, then the parsed query as JSON with keys
  sorted and array order kept (for example `GET /reports/42?{"format":"pdf"}`). Over HTTP it comes
  from the live request's `req.path` and `req.query`, never from the full URL, the Host header or
  the route's configured `resource`; otherwise from the 402's `resource.url`. It is at most 2048
  UTF-8 bytes. `extra.atum` is unchanged.
- **The page is mount-relative and only as precise as `req.query`.** Mount the payment middleware at
  the app root: under `app.use('/tenants/:id', …)` the pages `/tenants/1/report` and
  `/tenants/2/report` are one page. Handlers must read `req.query`, not the raw URL.
- **The binding is per route.** Resources chosen by body, headers, Host (virtual hosts on one app),
  session or MCP tool arguments share one page and need their own identifier each. Under Hono only
  the first value of a repeated query key is part of the page.
- **Breaking:** the server refuses to publish a 402 when the HTTP adapter has no `getQueryParams`,
  when the URL has a query the framework did not parse, or when the page is over 2048 UTF-8 bytes,
  and refuses a route that sets `extra.atumResource` itself (`INVALID_CONFIG`).
- **Breaking:** `request_id` is derived with the anchor `identifier:hex(keccak256(utf8(resource)))`
  and keeps the whole 256-bit digest: `req_x402_` plus 64 hex characters instead of 24.
  The same identifier on another page is a new payment, and a query value that changes between
  attempts, such as a cache buster or a merchant deploy that changes the page, makes a new
  payment. Pages that differ only by request body are
  one page, so each purchase still needs its own identifier.
- **Breaking:** the client refuses a requirement without a valid `extra.atumResource`, and the
  facilitator refuses one in `verify` and `settle`. The facilitator reads the page from the
  requirements the resource server passes, never from the payload's `accepted`.

### Added
- `test-vectors/request-id-resource.json`: cross-language vectors for the page string and the
  `request_id` derived from it.

## [0.5.0] - 2026-10-30

> **Upgrade payers and facilitators before configuring a resource server to publish
> `depositRequestHashVersions`.** The `extra` schema is closed to unknown properties, and both the
> client and the facilitator check it, so a client or facilitator that predates the field refuses
> every requirement carrying it, even `[1]`, and the payer cannot pay. A server publishes it only
> when a source is configured with it, so upgrading the server alone changes nothing. Publish
> exactly what the payment gateway's `GET /v1/defaults` lists in `deposit_request_hash_versions` for
> the source chain, which `depositRequestHashVersionsFromDefaults` derives. To roll a client or
> facilitator back, stop publishing the field first.

> **`settle` now succeeds as soon as the payout is on chain** (`extensions.atum.state` is
> `finalizing`), not only once it is final. Pass `settleAt: 'completed'` to keep the previous
> behaviour. Your submitter must now return the gateway's `transactions`.

### Added
- `depositRequestHashVersionsFromDefaults(network, defaults)`, exported from `/server`: a source's `depositRequestHashVersions` from its chain's `GET /v1/defaults` entry, exactly as the gateway lists them, or `undefined`, which publishes nothing, while it lists only version 1. It throws `AtumEscrowConfigError` (`INVALID_CONFIG`) for a chain whose list names no version this build signs, or is malformed.
- The facilitator's `PaymentSubmitter.submit` takes a second argument, `{ shadow }`: who built the request (`x402`) and its depositRequestHash v2, typed as the newly exported `DepositRequestHashShadow`. Forward it with `submitPaymentShadow(context?.shadow)` from the gateway client. It is used for compatibility diagnostics only and never changes how the payment is processed; a submitter that ignores it works as before.
- `settleAt` option on `AtumEscrowFacilitatorScheme`: `'finalizing'` (default) or `'completed'`.
- A `finalizing` success carries `statusUrl` in `extensions.atum` when one is configured.
- `extra.atum.depositRequestHashVersions`, the depositRequestHash versions a payer may sign for a source: 1 is `keccak256(request_id)`, 2 is the hash of the payment terms. Absent means `[1]`. The server publishes it when a source sets the new `depositRequestHashVersions`, and the client signs v2 when the list contains 2 and v1 otherwise.
- New `depositRequestHashV2Mode` option on `AtumEscrowFacilitatorScheme`, `'audit'` (the default), `'enforce'`, `'retire'` or `''` (off; `null` from untyped configuration is off too, as in the shared SDK). The facilitator now accepts a deposit committing v2 when the requirement lists 2 in `depositRequestHashVersions`, and, except in `retire`, v1. In `audit` a request the strict reader refuses is still admitted, by the v1 reading, and the refusal is reported in `strictDetail`; in `enforce` it is refused as `request_malformed`. `retire` is `enforce` that accepts only v2: a deposit committing v1 is refused as `request_hash_mismatch`, and a requirement that does not list 2 is refused before the payment is read, since no payment could satisfy it. Set it once every requirement you serve lists 2 and your payers sign v2. Off, it reads only v1, as before. Any other value throws at construction.
- `atumEscrowPrice(config)` on `/server`: the route price that restates the corridor's fulfillment.
- `AtumEscrowConfigError` and `AtumEscrowConfigErrorCode` on `/server`.
- `DEFAULT_PEG_GROUPS` on `/server`, the same groups the payer client exports, for a merchant extending the default.
- The server implements `getAssetDecimals`, so `@x402/core` converts a dollar-denominated settlement override with the token's declared decimals instead of assuming 6. It throws for a token the scheme does not know rather than guess.

### Changed
- The server config refuses a Stellar (`G…` or `C…`) address in `destination`, `fulfillmentProxy`, `reserver`, `releaser` and every source `asset` and `escrow`, with `INVALID_CONFIG`. The wire schemas this package inlines accept Stellar addresses, but the package has no Stellar chain adapter, so it cannot build or sign a Stellar payment; the refusal is deliberate and fails closed. Only the address is checked: a `stellar:*` network is not refused at construction. Stellar support is not part of this release.
- **Breaking for TypeScript callers: `PaymentSubmitResult.transactions` is a required key.** Return the gateway's `transactions` (or `undefined` when the response has none). The settle response's `transaction` and `network` are read from `transactions.fulfillment`; an adapter that dropped it would never answer before `completed`.
- `settle` decides from the gateway's `status`: a payment that is `failed` or `pending` is never a success, whatever transactions it lists, and success requires a payment id.
- Success requires both the payout's `transaction_hash` and its `chain_id`. A `finalizing` or `completed` payment whose submitter result carries no such payout is still `settlement_pending`, never a failure, and its `errorMessage` says so and points at the submitter's `transactions`. A response that reports a payment without naming it is `settlement_pending`, never `settlement_not_accepted`.
- The facilitator settles a payment the gateway reports as `refunded` as `settlement_failed`, like `failed`: it was not delivered and its key is spent. `refunding` and `refund_available` are reported as `settlement_pending`, since the deposit is still in escrow and a late delivery can still complete it. On `refund_available` the message points at `refund_signature`. `PaymentSettlementStatus` gains the three values.
- **Breaking: the server config declares each token's `symbol` and `decimals`.** The destination and every source now require `symbol` (non-empty) and `decimals` (an integer from 0 to 77). A 0.4.0 config does not compile and is refused at construction. Copy both from `GET /v1/defaults` for the token's chain (its `tokens` list) or from the supported-assets reference. Every construction failure is now an `AtumEscrowConfigError` (still an `Error`, message unchanged) with a `code`: `INVALID_CONFIG` for a malformed field.
- **Breaking: a source token that is not the same money as the destination is refused at construction** with `ASSETS_NOT_COMPARABLE`, naming the source network: the server applies the payer client's rule (same symbol, or one peg group). The new optional `pegGroups` replaces the default `DEFAULT_PEG_GROUPS`; set it to match the groups your payers use.
- **Breaking: a route's `price` must be `atumEscrowPrice(config)`.** Any other price, including the previously documented `"$0.10"` placeholder, is refused with `PRICE_CONFLICT`. x402 does not price routes at startup, so the refusal comes **on every request to that route** (an HTTP adapter answers it with an error status) rather than at boot; request each paid route once after deploying. A dollar price is refused rather than converted, because converting it would assume the destination token's value.
- A route on a network with no configured source is refused with `AtumEscrowConfigError` code `SOURCE_NOT_CONFIGURED`, naming the network, instead of a plain `Error`. The message is unchanged, and the error is still an `Error`.
- A payer-supplied `TrustResolver` whose tokens carry decimals outside 0–77, or decimals that are not a number, is refused with `AtumEscrowTrustError` code `UNTRUSTED_ASSET` before anything is signed. The default trust source already rejected such tokens.
- The facilitator refuses a payment request that repeats a member name, including names that differ only in letter case, only where it is read: any top-level name, or inside `source`, `destination`, `request_id` or `sender_auth`. A repeated name inside a credential or another member it does not read no longer refuses the payment.
- The client builds the whole payment request before the deposit authorization and signs over exactly that body, then adds `sender_auth` to it.
- The results passed to `onCommitmentResult` carry `depositRequestHashVersion` (`v1` or `v2`) and `expectedDepositRequestHashV2`, and in `audit` mode `strictDetail`; their log fields gain `deposit_request_hash_version`, `request_deposit_request_hash_v2` and `strict_detail`. A refusal for a deposit that commits neither hash names both candidates in its detail.
- `CommitmentOutcome` gains `quote_request_mismatch`, from the shared SDK's new quote binding. A `Record` or exhaustive `switch` over the outcomes needs a branch for it.
- The README's example sets `quoteDeadlineSeconds: 3`, and its documentation says how to size it. Bidding closes at the quote deadline, and settlement starts only once your route handler has responded, so start from about 3 seconds for a handler that answers in a few hundred milliseconds and add your handler's typical run time on top. The budget counts from when the payer builds the payment, so the payer's clock skew comes out of it, and only the resource server can widen it.

### Fixed
- The payer client reads a Solana source's cluster clock (a configured `solanaClockReader`) before it stamps the deadlines rather than after, so a slow read no longer shortens the quote window the payment carries.
- The server's source spend cap is computed in the source token's units: `fulfillmentAmount` plus markup, converted with both tokens' declared decimals and rounded down. It was the destination-token amount labelled as the source token, so a corridor whose tokens have different decimals asked the payer to authorize 10^(difference) times too much or too little. A corridor whose rounded cap would be worth less than the fulfillment is refused at construction with `CAP_BELOW_PRICE`. Caps between tokens with equal decimals, which covers every corridor live today, are unchanged.

### Removed
- **Breaking: `PaymentSubmitResult.fulfillment_confirmation` and the `FulfillmentConfirmation` type export.** The gateway no longer sends a fulfillment confirmation, so **a submitter that returns `fulfillment_confirmation` instead of `transactions`, as one written for 0.4.0 does, no longer settles anything: every payment stays `settlement_pending`.** In TypeScript this is a compile error; in JavaScript nothing fails until the first payment. Return the gateway's `status` and `transactions`:
  ```ts
  return { payment_id: res.payment_id, status: res.status, transactions: res.transactions };
  ```
  The settle response's `transaction` is the payout, read from `transactions.fulfillment`. The deposit transaction is in `transactions.deposit` of the gateway response your submitter received, or from `GET /v1/payments/{paymentId}/status`. A response without `status` is treated as still in flight.

## [0.4.0] - 2026-10-08

### Changed
- EVM and Tron payments are always built with the four-member deposit witness, and building a Solana payment fails for a signature domain version below 4. Every deployed escrow is at version 4 or later.
- **Breaking: `PaymentSettlementStatus` now reads `'pending' | 'finalizing' | 'completed' | 'failed'`.** `cancelled` is removed — the gateway could not produce it, and a payment that ends undelivered is reported as `failed`. `finalizing` is added: the transaction is on chain but has not yet reached the confirmations its chain requires, so it is **not** terminal and a payment in that state is still waited on rather than written off. Code doing an exhaustive `switch` on this type will not compile until a `finalizing` branch is added. A status this package does not recognise is treated as pending rather than terminal, which is the safe direction: the facilitator answers `SETTLEMENT_PENDING` ("keep the same idempotency key") instead of `SETTLEMENT_FAILED` ("that key is spent"), so a payment still in flight is never answered with an instruction to charge again.

### Security
- The facilitator refuses a credential whose payee or `request_id` differs from the one the payer signed, on EVM, Tron and Solana. The signed deposit carries both, and they must match the payment request's own `destination` and `request_id`. A deposit that commits no destination is refused.
- Each value a verifier reads has one accepted spelling: `message` is `0x`-prefixed hex on every chain, Tron included; a signature is `0x` followed by 65 bytes of hex (recovery id 0, 1, 27 or 28) on EVM and Tron and `0x` followed by 64 bytes on Solana; and `max_source_amount` is a decimal integer with no sign, prefix, padding or leading zero.
- Payers must be key accounts: the signer is recovered off chain, so a contract account (ERC-1271, such as a Safe), whose signature comes from an owner key, is refused.
- New `onCommitmentResult` option on `AtumEscrowFacilitatorScheme`: it receives the result of every payee check, admissions and refusals alike, with log fields named as in the Go and TypeScript SDKs (`sender_auth_result`, `signed_destination`, `request_destination`, ...). Count payments by `sender_auth_result` and log every refusal.
- The facilitator verifies a deposit for the requirement's network, not for the scheme the payload declares, and refuses a payload whose `message_scheme` is not the one it verifies there (`EVM_PERMIT2` on EVM and Tron, `SOLANA` on Solana). It also checks the whole payment request and refuses member names that differ only in letter case.
- The client refuses to sign a corridor the payer does not trust. Before anything is signed, `extra.atum.escrow`, `payTo`, `extra.atum.reserver` and `extra.atum.releaser` are compared with the source chain's trusted escrow, quote selector and fulfillment verifier account, and `extra.atum.fulfillmentProxy` with the destination chain's trusted proxy; a mismatch throws `AtumEscrowTrustError` (`UNTRUSTED_ESCROW`, `UNTRUSTED_PAY_TO`, `UNTRUSTED_RESERVER`, `UNTRUSTED_RELEASER`, `UNTRUSTED_FULFILLMENT_PROXY`). The trust source is the new optional `trust` option; without it the client asks `GET /v1/defaults` on Atum's production gateways (`ATUM_DEFAULT_TRUST_GATEWAYS`, via `atumGatewayTrust`), and a chain they do not serve, or an answer they cannot give, refuses (`CHAIN_NOT_TRUSTED`, `TRUST_SOURCE_UNAVAILABLE`). **Payers on a devnet, a staging deployment or another operator must now pass `trust`**, or every payment is refused.
- The client bounds the spend cap. The source and destination tokens must be listed by the trust source (`UNTRUSTED_ASSET`) and be the same money — the same symbol, or in one of `pegGroups` (default `DEFAULT_PEG_GROUPS`) — or the payment is refused (`ASSETS_NOT_COMPARABLE`); `amount` may exceed `fulfillmentAmount` by at most `maxMarkupBps` (default `DEFAULT_MAX_MARKUP_BPS`, 500) after both are put in one unit (`MARKUP_EXCEEDED`). A custom trust resolver must now return `tokens` (symbol, address, decimals) for each chain.
- The facilitator refuses a payment whose `extra.atum.escrow`, `payTo` or `extra.atum.reserver` is not trusted on the source chain, or whose `extra.atum.fulfillmentProxy` is not trusted on the destination chain, after its signature is verified; `settle` relays nothing it refuses. The releaser is deliberately not compared. It takes the same optional `trust` option and default as the client, so verification now makes a cached network call; **a facilitator relaying to a non-production deployment must pass `trust` for it**, or it refuses every payment. The trust API is also exported from `/facilitator`.
- The facilitator re-checks a payment's earliest deadline — the signed authorization's or the quote's — after its trust lookup, and refuses one that expired meanwhile with the new `PAYMENT_EXPIRED` (`'payment_expired'`), so `settle` relays nothing that expired while it was being verified.

## [0.3.1] - 2026-09-18

### Changed
- Published under Apache-2.0 with `publishConfig.access: public`. npm will not overwrite 0.3.0, so this version exists to ship the LICENSE, NOTICE, and public visibility that 0.3.0 cannot take.

## [0.3.0] - 2026-09-16

> **Breaking.** The Solana deposit's `issued_at` is no longer stamped by the merchant. It is gone
> from `extra.atum`, and the published `extra` schema now rejects it. A payer stamps it at signing
> time instead.
>
> **Upgrade resource servers first** when this ships. The `extra` schema is closed to unknown
> properties, so an upgraded payer or facilitator hard-fails against a merchant still stamping the
> field (`invalid extra.atum: must NOT have additional properties`). Rolling payers ahead of
> merchants takes Solana payments from occasional refusals to refusing all of them.
>
> The reason the change is worth the migration: `issued_at` was the only time-varying value in
> `extra.atum`, and x402 rebuilds the requirements on the paid request and requires the rebuild to
> agree with what the payer echoed. Two builds either side of a wall-clock second disagreed, so a
> correctly signed payment was answered `No matching payment requirements` — inside the resource
> server, before any `/verify`, with nothing in any service log. Measured at ~2% of exchanges, and
> higher the slower the round trip. Separately, the merchant read its own wall clock rather than the
> Solana cluster clock the escrow actually judges `issued_at` against; that clock lags real time, so
> a well-synchronised merchant sat systematically ahead of the judge and risked `FutureTransaction`.

### Removed

- **`extra.atum.issuedAt`.** Not emitted, and refused if present. Solana's signature-domain fields
  (`svmSignatureClusterId`, `svmSignatureDomainVersion`) are unchanged — they are properties of the
  deployed escrow, so a rebuild reproduces them.

### Fixed

- **`ensureSourceApproval` no longer sends a fresh approval before every payment after the first.**
  Permit2 decrements the payer's allowance on each transfer it makes, so an allowance granted as
  unlimited stops being exactly `MaxUint256` the moment the first payment settles. Sufficiency was
  measured against that exact value, so from the second payment onward the check never
  short-circuited again and every charge was preceded by another approval transaction. The payments
  were correct; the payer was buying an allowance they already held. Sufficiency is now measured
  against half of `MaxUint256`, which separates an unlimited approval that has been partly spent
  from one a payer bounded deliberately — crossing that floor would take more token units than any
  supply contains. Nothing changes for a caller passing `requiredAllowance`: that comparison was
  already right, and only the unlimited case was wrong.

### Added
- **`isUnconfirmed`**, for telling a broadcast-but-unseen approval apart from one that failed. The
  wait for a confirmation is bounded, and reaching that bound is not a failure: the transaction may
  confirm a moment later. The two need opposite responses — a failure needs another approval, an
  unconfirmed one needs the transaction checked and nothing else — and a caller that treats them
  alike pays for an allowance they are already getting. Previously the distinction existed only as
  an undocumented property on the error.

- **`needsSourceApproval`** (from `./client`), the read-only counterpart to `ensureSourceApproval`.
  It takes the same arguments and answers the same question, but only reads the allowance: no
  transaction, no gas. Use it to tell a payer that a one-off approval is due before asking them to
  sign, instead of letting them find out when one is broadcast.
- **`ensureSourceApproval` now works on Tron.** It previously documented Tron support it did not
  have — the implementation reached the chain through ethers, which cannot talk to Tron, so a Tron
  source failed either for want of a `spender` or somewhere inside ethers. Pass a TronWeb instance
  as `tronWeb` in place of the ethers `signer`, and the Permit2 address for the network is resolved
  for you rather than demanded as `spender`. `tronweb` is not a dependency of this package; the
  caller constructs the instance, exactly as they already construct the ethers signer.
- **`approvalAmount`**, for granting a bounded approval instead of an unlimited one, capping what
  the escrow can ever move. On its own the amount is its own requirement, so an allowance still
  holding the full bound is left alone rather than re-approved — the right answer for a one-off
  approval. Across repeated payments, pair it with `requiredAllowance`: a bound measured against
  itself stops covering itself the moment the first charge is decremented from it, and every later
  call would send another approval. The trade-off to weigh is
  that Permit2 decrements the allowance on every payment, so a bounded approval is consumed and
  eventually has to be granted again. Asking to approve less than an explicit `requiredAllowance`
  is refused outright, since that approval could never satisfy the charge it was granted for.
- **`AtumEscrowClientConfig.solanaClockReader`.** Reads the cluster's unix time, in epoch seconds,
  for the CAIP-2 source network. Optional: a payer cannot be required to hold an RPC endpoint. It
  must return a safe *lower bound* on cluster time — `resolveSolanaIssuedAt` in the Atum
  payment-gateway client already trims a guard for that — and its value is used verbatim, so a
  reader that trims is not charged twice.

### Changed
- Clarified that the approval helpers raise an allowance and never lower one: a wallet already
  holding more than `approvalAmount` is left as it is and reports `alreadySufficient`. The wording
  said `approvalAmount` caps what the escrow can ever move, which is only true when no larger
  allowance already exists. Reducing or revoking an allowance is a separate operation these do not
  perform.
- `ensureSourceApproval` refuses to send when the client that would sign is not the `owner` whose
  allowance it read. An approval only ever applies to the account that sends it, so a mismatched
  signer approved that account instead, returned a transaction hash that read as success, and left
  the owner exactly as unable to pay as before — a silent failure that surfaced only as a settlement
  revert. Read-only `needsSourceApproval` is unaffected: asking whether a payer is ready without
  holding their keys is a legitimate preflight, and a client that cannot report which account it
  signs as is not treated as a mismatch.


- Tron approvals wait for confirmation before returning, so the hash they report means mined
  rather than broadcast — a payer that deposited immediately afterwards would otherwise race
  their own approval. The EVM path already waited; what is new there is a bound on how long it
  will wait (`confirmation.timeoutMs`, one minute by default) instead of waiting forever, and an
  `onSubmitted` callback that hands you the hash the moment it is broadcast, so a stuck approval
  can still be looked up.
- On EVM, `ensureSourceApproval` resets an allowance to zero before setting a new one, but only
  where the token demands it. Some tokens — mainnet USDT most notably — refuse to move an allowance
  straight from one non-zero value to another, so a payer holding any leftover allowance could not
  be approved at all and saw a bare on-chain revert. The check is a simulated call that costs
  nothing and sends nothing, and a wallet with no allowance skips it entirely, so an ordinary
  approval still takes exactly one transaction. Tron does not do this: an ordinary TRC-20 accepts
  the change in place, and guessing otherwise would burn an extra transaction at Tron's fee limit
  — if a Tron token ever does refuse, the error names the manual remedy.
- The approval helpers are now one implementation shared by this scheme, the mppx method and the
  payment-gateway client, so the three cannot drift apart on what counts as a sufficient allowance.
  The exported names and their behaviour are unchanged.

- **Without a reader, `issued_at` is the local clock back-dated by 45 seconds**
  (`SOLANA_ISSUED_AT_FALLBACK_SKEW_SECS`, exported). Both directions of clock error are fatal at
  different thresholds — ahead of the cluster is refused outright, far enough behind puts the signed
  deadline in the past — so the buffer buys ~45s of headroom for a fast clock and cluster lag, and
  leaves ~75 of the escrow's 120 seconds for the auction and the settler's deposit.

### Deprecated

- **`AtumEscrowServerConfig.now`.** Nothing in a requirement derives from it any more, so supplying
  it has no effect. Retained so existing callers still compile.

## [0.2.0] - 2026-08-04

> **Breaking.** A payment now carries the purchase it is for, and a payment that cannot name its
> purchase is refused rather than taken. If you set `requestId` on the client, that field is gone and
> your payments will be refused until you supply an identifier — see *Removed* for the replacement.
>
> The reason the change is worth the migration: `requestId` was configured once per client, so every
> purchase made through one client shared a single idempotency key. The Atum network de-duplicates on
> that key, which meant a second, genuinely different purchase could resolve onto the first payment —
> paid once, delivered twice — while a re-attempt of a purchase from a fresh client could be charged
> twice. The identifier now travels per payment, in the standard x402 `payment-identifier` extension.

### Removed

- **`AtumEscrowClientConfig.requestId`.** The idempotency key is no longer client configuration. Name
  the purchase per call instead — `paymentIdentifier` in `wrapFetchWithAtumPayment`'s third argument,
  or `withPaymentIdentifier` when driving the scheme directly — or let the resource server declare it
  in its `402`.

### Changed

- **A payment with no purchase identifier is refused.** `createPaymentPayload` throws rather than
  inventing an identifier. A generated key has the shape of idempotency without the substance: it
  differs on every attempt, so every re-attempt becomes a second payment. Refusing is the only
  outcome that cannot double-charge.
- **The server scheme declares `payment-identifier` in its `402`**, with `required: true`, and
  publishes a JSON Schema for it so a payer can validate what it is being asked for. An `id` a
  resource server declares for itself is preserved; `required` is always corrected to `true`, because
  the client and the facilitator both refuse a payment without an identifier and a `402` advertising
  otherwise would not be honoured by the scheme that sent it.
- **A settlement still in flight is reported as pending, not as a failure.** The Atum gateway holds a
  submission for a bounded window and then answers with a payment id while settlement continues.
  That answer used to be read as a failed payment, which invites paying again for a payment that is
  very much alive. It now surfaces as `SETTLEMENT_PENDING`, and terminal failure as
  `SETTLEMENT_FAILED`, so the two can be told apart in code.

### Added

- **`./fetch` subpath — `wrapFetchWithAtumPayment`.** Wraps a `fetch` so each call can name the
  purchase it is paying for. One long-lived client can pay for many purchases, including
  concurrently, without them sharing an identity.
- **`withPaymentIdentifier`** (from `./client`) — names the purchase for callers that drive the
  scheme directly instead of through the wrapped `fetch`.
- **`ensureSourceApproval`** (from `./client`) — optional helper that arranges the source-chain token
  approval before a payment is signed. Worth doing because an unapproved deposit reverts, and a
  terminal failure burns the purchase identifier: the same identifier cannot be re-attempted, so the
  purchase needs a new one.
- **`statusUrlFor`** on the facilitator config — publishes a per-payment status URL on a pending
  settlement, so a payer can follow the payment it already has instead of starting another.

### Migration

Build the client once and name the purchase per call, using your own reference. Any non-empty string
is accepted — one that the extension would not permit is mapped onto one that would,
deterministically, so the same reference always yields the same payment identity:

```ts
const pay = wrapFetchWithAtumPayment(fetch, client);

await pay("/report", {}, { paymentIdentifier: order.id });      // one purchase
await pay("/report", {}, { paymentIdentifier: otherOrder.id }); // a different purchase
```

Keep the identifier on the call rather than on the client. A client-held identifier is what the
removed `requestId` was, and it makes every purchase through that client one payment.

Re-attempting the same purchase under the same identifier resolves to the same payment and costs
nothing. A purchase that failed terminally needs a **new** identifier — the old one now names a dead
payment, and re-using it would resolve to that failure rather than paying.

## [0.1.3] - 2026-07-30

### Changed
- `THIRD-PARTY-NOTICES.txt` header now states explicitly that its licenses apply only to the bundled third-party components and do not modify the package's proprietary license or make the package open source.

## [0.1.1] - 2026-07-17

### Fixed
- The bundled ESM now imports `ajv/dist/2020.js` with the file extension, so the `./client`, `./server`, and `./facilitator` subpaths resolve at runtime under Node ESM. Version 0.1.0 failed to import.

## [0.1.0] - 2026-07-17

### Added
- Initial release: the `atum-escrow` x402 scheme as installable mechanisms, exposed as the `./client`, `./server`, and `./facilitator` subpaths. Self-contained bundle, so it installs with no first-party dependencies to resolve.
