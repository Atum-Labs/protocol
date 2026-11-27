# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The bundled payment-gateway client's quote-request response types gain an optional `error`. Payments made through this package never create a quote request, so they behave as before.
- The package moved within the protocol repository, from `schemas/apis/payment-gateway/v1/bindings/mppx-atum-escrow/` to `schemas/apis/payment-gateway/v1/bindings/typescript/mppx-atum-escrow/`, beside the other payment-gateway bindings split by language. Only the manifest `homepage` and `repository.directory` change; the published name, entry points and behavior do not.
- The bundled payment-gateway client knows the `MISSING_QUOTE_SELECTOR` code, and the `QUOTE_SELECTOR_NOT_ALLOWED` and `RESERVER_MISMATCH` messages no longer describe leaving `quote_selector` out. Payments made through this package never create a quote request, so they behave as before.
- A payment the gateway refuses for a dollar limit reaches `gatewayRefusalOf` with `code` `AMOUNT_LIMIT_EXCEEDED` (the per-payment amount limit) or `VOLUME_LIMIT_EXCEEDED` (the daily limit, which resets at 00:00 UTC), where it used to carry `AUTHORIZATION_DECLINED`. Both are a `PaymentRejectedError`, not a `PaymentRetryableError`, so a payment-enabled `fetch` does not re-attempt a purchase the limit will refuse again.
- The bundled payment gateway client's signing libraries can verify a payer's wallet-signed (EIP-712) payment request and payment request envelope where the verifier asks, and no longer accept the settler identity typed form on a payment request envelope. This package verifies neither, so its payments behave as before.
- The bundled payment gateway client's documentation describes how the gateway answers a direct deposit, one the payer funds before submitting, that is re-submitted with moved deadlines: a `200` with the payment that holds the `request_id`, or `409 CONFLICT` with a `payment_id`. Payments made through this package are not direct deposits, so they behave as before.
- The bundled payment gateway client resolves the Known to Atum v2 credential context, `https://schemas.atum.xyz/credentials/known-to-atum/v2`, beside v1. v2 adds the `quoteAwarder` and `merchant` roles.

## [0.7.1] - 2026-11-16

### Changed
- The server verifies a Solana deposit signature the way the Solana ed25519 program does, so a signature for a small-order public key, or one whose `R` is a small-order point, is refused before the payment is submitted. Ordinary wallet keys and signatures are unaffected; the program never accepted these.

### Fixed
- README: install `mppx`, `zod` and `viem` in the same command as the package, with `viem` below 2.57.16. `viem` 2.57.16 and later accept only `mppx` 0.17 or newer, so installing the package or its peers on their own fails with `ERESOLVE`.

### Security
- The `follow-redirects` copy bundled with axios is now 1.16.3, which patches the 1.16.0 advisories on keeping credential headers out of a request that is redirected to another origin.

## [0.7.0] - 2026-10-30

> **`verify()` now returns a receipt as soon as the payout is on chain** (`state: "finalizing"`),
> not only once it is final. Pass `settleAt: 'completed'` to keep the previous behaviour. Your
> submitter must now return the gateway's `transactions`.

### Added
- `PaymentSubmitter.submit` takes a second argument, `{ shadow }`: who built the request (`mppx`) and its depositRequestHash v2. Forward it with `submitPaymentShadow(context?.shadow)` from the gateway client, as the README's submitter now does. It is used for compatibility diagnostics only and never changes how the payment is processed; a submitter that ignores it works as before.
- `corridorFromDefaults` lists what the gateway's `GET /v1/defaults` lists in the new `deposit_request_hash_versions`, so a source lists `[2]` once the gateway no longer accepts v1, and refuses a chain whose list names no version this build signs, or is malformed (`INVALID_CONFIG`). From a gateway that predates the member it lists `[1, 2]` for `deposit_request_hash_version: 2`, as before.
- `'retire'` for `registerServer`'s `depositRequestHashV2Mode`: `enforce` that accepts only depositRequestHash v2, so a deposit committing v1 is refused as `request_hash_mismatch` before it is submitted. Set it once every payer you serve signs v2.
- `settleAt` option on `registerServer`: `'finalizing'` (default) or `'completed'`.
- `detail` on the `SettlementPendingError` constructor options: a more specific reason, appended to the message.
- `paymentId`, `state` and `destinationChainId` on `AtumEscrowReceipt`.
- `PaymentRetryableError` and `isPaymentRetryable`, exported from `/server` and the package root: the gateway could not take the payment this time, nothing was charged, and the same purchase re-attempted shortly can go through unchanged. Throw it from your submitter when the gateway's error is classified `RETRY_AFTER_DELAY` with `request_id_reusable: true`, such as `503 AUTHORIZATION_UNAVAILABLE`, at any status but `429`. The payer receives a `402` `payment-action-required` with a fresh challenge and the gateway's `code` as its own field, so a payment-enabled `fetch` re-attempts the purchase.
- `gatewayRefusalOf(err)`, exported from `/server` and the package root: the refusal a submitter throws for an error the gateway answered with. It returns `PaymentRetryableError` for the classification above, and `PaymentRejectedError` for any other `4xx`. That includes a `429`, which a payment-enabled `fetch` would otherwise re-attempt at once against the same rate limit, and a `4xx` whose body is not the gateway's error, such as an HTML 403 or 429 page from a proxy in front of the gateway, with a code built from its status (`HTTP_403`). It returns `undefined` for anything else, which you rethrow unchanged as an unknown outcome: an error that names a `payment_id` or is classified `RECONCILE_THEN_DECIDE` (such as `409 CONFLICT`), since a payment may exist, a `5xx` without the retryable classification, a timeout, or a transport failure. It reads `status` and `body` from the error `@atumlabs/payment-gateway-client` throws, or from `{ status, body }`. The quick start's submitter now ends with `throw gatewayRefusalOf(err) ?? err`.

### Changed
- **Breaking for TypeScript callers: `PaymentSubmitResult.transactions` is a required key.** Return the gateway's `transactions` (or `undefined` when the response has none). The receipt's `reference` is read from `transactions.fulfillment`; an adapter that dropped it would never get a receipt before `completed`.
- `verify()` decides from the gateway's `status`: a payment that is `failed` or `pending` never gets a receipt, whatever transactions it lists, and a receipt requires a payment id.
- A receipt requires both the payout's `transaction_hash` and its `chain_id`. A `finalizing` or `completed` payment whose submitter result carries no such payout is still reported pending, never failed, and the `SettlementPendingError` message says so and points at the submitter's `transactions`.
- `PaymentRejectedError` is for a refusal whose request must change. A refusal the gateway classifies as retryable is a `PaymentRetryableError` instead: thrown as `PaymentRejectedError`, it reached the payer as a `400` telling them to fix a request that needed no change, and a payment-enabled `fetch` stopped there rather than re-attempting.

### Removed
- **Breaking: `AtumEscrowReceipt.fulfillmentConfirmation`, `PaymentSubmitResult.fulfillment_confirmation` and the `FulfillmentConfirmation` type export.** The gateway no longer sends a fulfillment confirmation, so **a submitter that returns `fulfillment_confirmation` instead of `transactions`, as the 0.6.0 README's did, no longer produces receipts: every payment stays pending.** In TypeScript this is a compile error; in JavaScript nothing fails until the first payment. Return the gateway's `status` and `transactions`:
  ```ts
  return { payment_id: res.payment_id, status: res.status, transactions: res.transactions };
  ```
  On the receipt, read `reference` (the payout transaction), `paymentId` and `destinationChainId`; `timestamp` is the time the receipt was issued. The deposit transaction is no longer on the receipt: read it from `transactions.deposit` in the gateway response your submitter received, or from `GET /v1/payments/{paymentId}/status`. A response without `status` is treated as still in flight.

## [0.6.0] - 2026-10-15

### Added
- The charge challenge carries `extra.depositRequestHashVersions`, the depositRequestHash versions a payer may sign: 1 is `keccak256(request_id)`, 2 is the hash of the payment terms. Absent means `[1]`. A source sets it with the new `depositRequestHashVersions`, and `corridorFromDefaults` sets `[1, 2]` for a source chain whose `GET /v1/defaults` entry says version 2. The client signs v2 when the challenge lists 2 and v1 otherwise. A client that predates the field ignores it and signs v1.
- New `depositRequestHashV2Mode` option on `registerServer`, `'audit'` (the default) or `'enforce'`. The server now accepts a deposit committing v1 or v2. In `audit` a request the strict reader refuses is still admitted, by the v1 reading, and the refusal is reported in `strictDetail`; in `enforce` it is refused as `request_malformed`. Any other value throws.
- New `pegGroups` on `AtumEscrowCorridor` (and `corridorFromDefaults`): the groups of token symbols the server treats as the same money. It replaces the default, which is the payer client's `DEFAULT_PEG_GROUPS`; match the groups your payers use.
- `AtumEscrowConfigError`, exported from `/server` and the package root, with a `code` and, for `ASSETS_NOT_COMPARABLE`, `CAP_BELOW_PRICE` and `AMOUNT_EXCEEDS_CHAIN_LIMIT`, the `network` at fault. `validateCorridor` throws it for every corridor it refuses, and the builders for every corridor or charge they refuse.
- `buildChargeRequest` (and `buildChargeChallenge`) refuses a charge whose `fulfillmentAmount` exceeds what the destination chain's amount type holds, or whose cap exceeds the source chain's — uint256 on EVM and Tron, u64 on Solana — with `AMOUNT_EXCEEDS_CHAIN_LIMIT` naming that chain. An amount exactly at the limit is accepted. Such a charge used to be built and then fail at signing or later, in settlement.

### Changed
- `settle` throws `SettlementFailedError` for a payment the gateway reports as `refunded`, like `failed`: it was not delivered and its identifier is spent. `refunding` and `refund_available` throw `SettlementPendingError`, since the deposit is still in escrow and a late delivery can still complete it. On `refund_available` its reason points at `refund_signature`. `PaymentSettlementStatus` gains the three values.
- **Breaking:** every token in a corridor declares its `symbol` and `decimals`. `destination` gains both, and each source's `assets` is a list of `{ address, symbol, decimals }` instead of address strings; `corridorFromDefaults` takes the same shape and copies it onto the corridor unchanged. Take the values from the `tokens` the gateway's `GET /v1/defaults` lists for each chain. Only the address reaches the challenge, so the wire is unchanged.
- `validateCorridor` refuses a token whose `symbol` is not a non-empty string or whose `decimals` is not an integer from 0 to 77 (`INVALID_CONFIG`, naming the field, e.g. `sources[0].assets[1].decimals`), and a source token that is not the same money as the destination token (`ASSETS_NOT_COMPARABLE`), which payers would refuse to price. It also refuses, as `INVALID_CONFIG`, a `destination` that is not an object, a `pegGroups` that is not an array of arrays of non-empty symbols, and an `assets` entry that is not a `{ address, symbol, decimals }` object — which is what a corridor still listing address strings gets, naming the entry (e.g. `sources[0].assets[0]`). Its existing refusals are now `AtumEscrowConfigError` with code `INVALID_CONFIG`; their messages are unchanged, and the refusal of a Tron network with no known Permit2 address carries the underlying error as `cause`.
- The results passed to `onCommitmentResult` carry `depositRequestHashVersion` (`v1` or `v2`) and `expectedDepositRequestHashV2`, and in `audit` mode `strictDetail`; their log fields gain `deposit_request_hash_version`, `request_deposit_request_hash_v2` and `strict_detail`. A refusal for a deposit that commits neither hash names both candidates in its detail.
- `CommitmentOutcome` gains `quote_request_mismatch`, from the shared SDK's new quote binding. A `Record` or exhaustive `switch` over the outcomes needs a branch for it.
- The README's example corridor sets `quoteDeadlineSeconds: 3`. Bidding closes at the quote deadline and always runs until then, so the budget is time every payment spends at the quote step. Both budgets count from when the payer builds the payment, so the payer's clock skew comes out of them, and only the merchant can widen them.
- `validateCorridor` refuses a `markupBps` that is not a whole number of basis points (`INVALID_CONFIG`). A fractional markup used to pass validation and then fail every charge.

### Fixed
- The payer client reads its clock after the trust lookup and after a configured `solanaClockReader` answers, rather than before them, so a slow lookup or clock read no longer shortens the quote window the payment carries.
- The merchant's source cap is in the source token's units. `buildChargeRequest` (and `buildChargeChallenge`) applied `markupBps` to `fulfillmentAmount`, which is in the destination token's atomic units, and labelled the result with the source token without converting: a corridor whose two tokens have different decimals got a cap off by 10^(difference) — far above the price, which payers refuse, or far below it, which no settler can fill. The cap is now `floor(fulfillmentAmount × (10000 + markupBps) × 10^sourceDecimals / (10000 × 10^destinationDecimals))`, the same arithmetic the payer client bounds it with, so a corridor whose `markupBps` is at most the payer's `maxMarkupBps`, and whose declared decimals match the payer's trust source, always passes that bound. A corridor whose tokens share their decimals gets the same cap as before, except for a `markupBps` above 2^53 − 10000, where the old arithmetic rounded and the new one is exact.
- `buildChargeRequest` refuses a `fulfillmentAmount` that is not a plain base-10 integer (`INVALID_AMOUNT`) (hex, whitespace-padded, signed or fractional text, an empty string, or a non-string) instead of reading it as a number — leading zeros are still accepted, as on the client — and a charge whose cap, rounded down to a whole source unit, is worth less than the fulfillment (`CAP_BELOW_PRICE`, naming the source `network`) — possible only when the source token has fewer decimals than the destination token.

## [0.5.0] - 2026-10-09

### Changed
- The challenge's `source.amount` is validated before it is signed as the Permit2 spend cap: it must be a positive base-10 integer in the source token's smallest units. `0` or a leading zero, which used to be signed, is now refused on the client, and a decimal is refused with a clear error rather than failing inside the signing step. Canonical amounts are unaffected.
- EVM and Tron payments are always built with the four-member deposit witness, and building a Solana payment fails for a signature domain version below 4. Every deployed escrow is at version 4 or later.

### Security
- The server refuses a credential whose payee or `request_id` differs from the one the payer signed, on EVM, Tron and Solana. The signed deposit carries both, and they must match the payment request's own `destination` and `request_id`. A deposit that commits no destination is refused.
- Each value a verifier reads has one accepted spelling: `message` is `0x`-prefixed hex on every chain, Tron included; a signature is `0x` followed by 65 bytes of hex (recovery id 0, 1, 27 or 28) on EVM and Tron and `0x` followed by 64 bytes on Solana; and `max_source_amount` is a decimal integer with no sign, prefix, padding or leading zero.
- Payers must be key accounts: the signer is recovered off chain, so a contract account (ERC-1271, such as a Safe), whose signature comes from an owner key, is refused.
- New `onCommitmentResult` option on `registerServer`: it receives the result of every payee check, admissions and refusals alike, with log fields named as in the Go and TypeScript SDKs (`sender_auth_result`, `signed_destination`, `request_destination`, ...). Count payments by `sender_auth_result` and log every refusal.
- The server checks the payment request, not only the deposit: it refuses a repeated member name, including names that differ only in letter case, where the request is read (any top-level name, or inside `source`, `destination`, `request_id` or `sender_auth`), and a `message_scheme` other than the one it verifies for the source chain (`EVM_PERMIT2` on EVM and Tron, `SOLANA` on Solana).
- **Breaking:** the client refuses to sign a corridor the payer does not trust. It used to sign whatever escrow, reserver and releaser a merchant's challenge named, so a merchant could name its own contract as the escrow, or itself as reserver and releaser, and take up to the cap. Before anything is signed, `extra.escrow`, `extra.reserver` and `extra.releaser` are now compared with the source chain's trusted escrow, quote selector and fulfillment verifier account, and `extra.fulfillmentProxy` with the destination chain's trusted proxy; a mismatch throws `AtumEscrowTrustError` (`UNTRUSTED_ESCROW`, `UNTRUSTED_RESERVER`, `UNTRUSTED_RELEASER`, `UNTRUSTED_FULFILLMENT_PROXY`). The trust source is the new optional `trust` option on `registerClient`; without it the client asks `GET /v1/defaults` on Atum's production gateways (`ATUM_DEFAULT_TRUST_GATEWAYS`, via `atumGatewayTrust`), and a chain they do not serve, or an answer they cannot give, refuses (`CHAIN_NOT_TRUSTED`, `TRUST_SOURCE_UNAVAILABLE`). Building the signed request itself still makes no network call. **Payers on a devnet, a staging deployment or another operator must now pass `trust`**, or every payment is refused. A trust source's own refusal keeps its code, including an `AtumEscrowTrustError` thrown by another Atum package's resolver (matched by `name` and `code`, since each package bundles its own class), and an answer that is not well-formed roles — a role that is not a non-empty string, or a missing or malformed `tokens` list — is refused as `TRUST_SOURCE_UNAVAILABLE`. Payers on 0.4.x must upgrade to this release to get the check: it is not in a 0.4.x patch.
- **Breaking:** the client bounds the spend cap. The source and destination tokens must be listed by the trust source (`UNTRUSTED_ASSET`) and be the same money — the same symbol, or in one of `pegGroups` (default `DEFAULT_PEG_GROUPS`) — or the payment is refused (`ASSETS_NOT_COMPARABLE`); `source.amount` may exceed `fulfillmentAmount` by at most `maxMarkupBps` (default `DEFAULT_MAX_MARKUP_BPS`, 500) after both are put in one unit (`MARKUP_EXCEEDED`). The same names, codes and defaults as `@atumlabs/x402-atum-escrow`'s client. **Merchants whose corridor `markupBps` is above 500 will be refused by payers on the default bound.**
- The client refuses a challenge whose `fulfillmentAmount` is not a base-10 integer before anything is signed. It is not signed, and the cap bound is computed from it, so a hex, binary or padded value, which JavaScript's `BigInt` would also read, could otherwise inflate the bound, and an empty one would be read as 0.

## [0.4.1] - 2026-09-18

### Changed
- Published under Apache-2.0 with `publishConfig.access: public`. npm will not overwrite 0.4.0, so this version exists to ship the LICENSE, NOTICE, and public visibility that 0.4.0 cannot take.
- **Breaking: `PaymentSettlementStatus` now reads `'pending' | 'finalizing' | 'completed' | 'failed'`.** `cancelled` is removed — the gateway could not produce it, and a payment that ends undelivered is reported as `failed`. `finalizing` is added: the transaction is on chain but has not yet reached the confirmations its chain requires, so it is **not** terminal and a payment in that state is still waited on rather than written off. Code doing an exhaustive `switch` on this type will not compile until a `finalizing` branch is added. A status this package does not recognise is treated as pending rather than terminal, which is the safe direction: it raises `SettlementPendingError` (retry this purchase) instead of `SettlementFailedError` (start a new one), so a payment still in flight is never answered with an instruction to charge again.

### Security
- The axios copy bundled from the payment-gateway client is now 1.20.0, which patches the 1.13.x advisories. The notices file lists the new MIT transitives (`https-proxy-agent`, `agent-base`) that ride along.

## [0.4.0] - 2026-09-16

### Changed
- Clarified that the approval helpers raise an allowance and never lower one: a wallet already holding more than `approvalAmount` is left as it is and reports `alreadySufficient`. The wording said `approvalAmount` caps what the escrow can ever move, which is only true when no larger allowance already exists. Reducing or revoking an allowance is a separate operation these do not perform.
- `ensureSourceApproval` refuses to send when the client that would sign is not the `owner` whose allowance it read. An approval only ever applies to the account that sends it, so a mismatched signer approved that account instead, returned a transaction hash that read as success, and left the owner exactly as unable to pay as before — a silent failure that surfaced only as a settlement revert. Read-only `needsSourceApproval` is unaffected: asking whether a payer is ready without holding their keys is a legitimate preflight, and a client that cannot report which account it signs as is not treated as a mismatch.
- Tron approvals wait for confirmation before returning, so the hash they report means mined rather than broadcast — a payer that deposited immediately afterwards would otherwise race their own approval. The EVM path already waited; what is new there is a bound on how long it will wait (`confirmation.timeoutMs`, one minute by default) instead of waiting forever, and an `onSubmitted` callback that hands you the hash the moment it is broadcast so a stuck approval can still be looked up.
- On EVM, `ensureSourceApproval` resets an allowance to zero before setting a new one, but only where the token demands it. Some tokens — mainnet USDT most notably — refuse to move an allowance straight from one non-zero value to another, so a payer holding any leftover allowance could not be approved at all and saw a bare on-chain revert. The check is a simulated call that costs nothing and sends nothing, and a wallet with no allowance skips it entirely, so an ordinary approval still takes exactly one transaction. Tron does not do this: an ordinary TRC-20 accepts the change in place, and guessing otherwise would burn an extra transaction at Tron's fee limit — if a Tron token ever does refuse, the error names the manual remedy.
- The approval helpers are now one implementation shared by this package, the x402 scheme and the payment-gateway client, so the three cannot drift apart on what counts as a sufficient allowance. The exported names and their behaviour are unchanged.
- `ChargeRequest` declares the Solana `issuedAt` on its `extra` itself, instead of inheriting it
  from the shared x402 request type. That type dropped the field — an x402 resource server rebuilds
  its payment requirements on the paid request and compares them against what the payer echoed, and
  a clock reading cannot survive that comparison. MPP has no such rebuild, so a merchant-stamped
  issue time stays valid here and `buildChargeRequest` still emits it exactly as before. Type-only:
  the emitted JavaScript is byte-identical, so nothing changes at runtime and no code needs editing
  on upgrade.
- A destination identifier whose CAIP namespaces are not lowercase, such as `SOLANA:` or `SPL:`, is now accepted on Solana. Previously that chain compared the whole identifier byte for byte and refused it. CAIP pins both namespaces lowercase, so this only forgives a spelling the schema already treats as equivalent.

### Added
- **`isUnconfirmed`**, for telling a broadcast-but-unseen approval apart from one that failed. The wait for a confirmation is bounded, and reaching that bound is not a failure: the transaction may confirm a moment later. The two need opposite responses — a failure needs another approval, an unconfirmed one needs the transaction checked and nothing else — and a caller that treats them alike pays for an allowance they are already getting. Previously the distinction existed only as an undocumented property on the error.
- **`needsSourceApproval`**, the read-only counterpart to `ensureSourceApproval`. It takes the same arguments and answers the same question, but only reads the allowance: no transaction, no gas. Use it to tell a payer that a one-off approval is due before asking them to sign, instead of letting them find out when one is broadcast.
- **`ensureSourceApproval` now works on Tron.** It previously documented Tron support it did not have — the implementation reached the chain through ethers, which cannot talk to Tron, so a Tron source failed either for want of a `spender` or somewhere inside ethers. Pass a TronWeb instance as `tronWeb` in place of the ethers `signer`, and the Permit2 address for the network is resolved for you rather than demanded as `spender`. `tronweb` is not a dependency of this package; the caller constructs the instance, exactly as they already construct the ethers signer.
- **`approvalAmount`**, for granting a bounded approval instead of an unlimited one, capping what the escrow can ever move. On its own the amount is its own requirement, so an allowance still holding the full bound is left alone rather than re-approved — the right answer for a one-off approval. Across repeated payments, pair it with `requiredAllowance`: a bound measured against itself stops covering itself the moment the first charge is decremented from it, and every later call would send another approval. The trade-off to weigh is that Permit2 decrements the allowance on every payment, so a bounded approval is consumed and eventually has to be granted again. Asking to approve less than an explicit `requiredAllowance` is refused outright, since that approval could never satisfy the charge it was granted for.
- `AtumEscrowServer`, the type `registerServer` returns, for naming the method where it is built in one place and registered in another. Its `verify()` now resolves with an `AtumEscrowReceipt`, so `fulfillmentConfirmation` is available directly on the result: any cast you added to reach it can be removed. Casts already in place continue to compile, so this needs no change on upgrade.

### Fixed
- **`ensureSourceApproval` no longer sends a fresh approval before every payment after the first.** Permit2 decrements the payer's allowance on each transfer it makes, so an allowance granted as unlimited stops being exactly `MaxUint256` the moment the first payment settles. Sufficiency was measured against that exact value, so from the second payment onward the check never short-circuited again and every charge was preceded by another approval transaction. The payments were correct; the payer was buying an allowance they already held. Sufficiency is now measured against half of `MaxUint256`, which separates an unlimited approval that has been partly spent from one a payer bounded deliberately — crossing that floor would take more token units than any supply contains. Nothing changes for a caller passing `requiredAllowance`: that comparison was already right, and only the unlimited case was wrong.
- A payer whose `signer` option carries a blank `pinnedAddress` falls back to the payer's own account. Blank covers an empty string, which is how an unset variable arrives, and a whitespace only value, which is how one read from a file or a padded shell variable arrives. It previously passed the value straight through, which the payment-gateway client now refuses instead of reading as "no pin", and the two blank forms took different paths.
- `verify()` compares the payer's destination asset identifier against the merchant's advertised one part by part, instead of lowercasing the whole string for every chain except Solana. A Tron `trc20:` reference is base58, where capitalisation is part of the value, so the old fold treated two distinct tokens as the same one on a field the deposit signature does not cover. The token reference and a Solana chain reference are now compared the way the neighbouring address comparison already documented, and only the two CAIP namespaces fold.

## [0.3.0] - 2026-07-30

### Added
- `buildChargeChallenge(corridor, select, fulfillmentAmount, { intentId })` — the merchant-side entry point for building a charge challenge. It pairs the payment terms with a per-purchase identifier (your order or invoice id), which is what makes a retry of that purchase resolve to the original payment instead of becoming a second charge. It travels in challenge metadata under `INTENT_ID_META_KEY`.
- `SettlementPendingError`, `SettlementFailedError`, and `PaymentRejectedError`, with `isSettlementPending` / `isSettlementFailed` / `isPaymentRejected` guards. A payment that has not settled is no longer reported as a single undifferentiated failure: pending means retrying the same purchase is safe and is how the result is collected, while a terminal failure means that purchase can never settle and recovery requires a new one. Both settlement errors carry the gateway's `paymentId` — as its own field on `toProblemDetails()` (and `SettlementFailedError` also carries `state`), not only interpolated into the message text, so a payer reading the wire response can reconcile the attempt without parsing a sentence.
- `PaymentSubmitResult.status`, so a submitter can pass the gateway's lifecycle state through. An absent status is read as pending.

### Fixed
- The payer's `signer` option now accepts Turnkey provider config (`{ provider: "turnkey", ... }`) as documented by its type, instead of throwing and directing you to construct a `TurnkeySenderSigner` yourself and pass it as a ready-made signer. Both paths now behave the same way; the ready-made-signer path still works unchanged.
- A credential presented after its quote window has closed now fails with a typed `PaymentActionRequiredError` (the same type `SettlementPendingError` carries) instead of a plain `Error`. mppx's request-routing layer replaces any thrown value that is not a recognized payment error with a generic "Payment verification failed." before it reaches the wire, which was silently erasing the "re-attempt with a fresh challenge" guidance for every real HTTP payer — only a merchant calling `verify()` directly in-process ever saw it. The message is unchanged; only its wire-visible type is fixed, so a payer's retry loop can now correctly recognize this as the same "fetch a fresh challenge and continue" outcome as a pending settlement.

### Changed
- **Breaking:** the payment's identity is now derived from the challenge's per-purchase identifier rather than from the challenge id. The challenge id is an HMAC over the challenge's own contents, so it moved whenever the expiry or the quote moved: under a rolling `expires` every retry derived a fresh identity and was charged as a new payment, and with no `expires` or metadata at all two distinct purchases with identical terms collapsed onto one payment, leaving the second unpaid. Merchants now stamp `intentId` (via `buildChargeChallenge`); a challenge without one is refused by the payer's client rather than paid unsafely.
  - **If your integration sets `challenge.opaque` yourself** (the pre-0.3.0 way to carry your own correlation data), note that it silently overrides the `meta` this relies on for `intentId` — the mppx framework only serializes `meta` into `opaque` when nothing has already set `opaque`. Move your own data onto extra keys of the same `meta` object `buildChargeChallenge` returns instead. See the README's "Quick start — merchant" section.
- A `PaymentSubmitter` should submit and return the gateway's response rather than polling for completion — the payer's retry is what collects a pending result. Polling holds the merchant's request open for the whole settlement window and hides the pending state that makes the retry safe.
- **Re-attempting a purchase is now spelled out**, in `SettlementPendingError`'s own message and in the README: request a fresh challenge and sign it again, keeping the same `intentId`. "Retry the same purchase" was ambiguous, and the reading it invited does not work — `quote_deadline` and `fulfillment_deadline` are absolute timestamps fixed when the challenge is built, so a credential that has already been signed cannot be presented a second time once its quote window has closed. On Solana the deposit authorization additionally carries its own on-chain replay window, which expires with them.
- An authorization whose quote window has closed is now reported separately from deadlines that are in the wrong order. They were one message, and they need opposite responses: the first is fixed by re-running the purchase, the second is a malformed request that no passage of time will make valid. The stale case now names the remedy, including which field must not change.

## [0.2.2] - 2026-07-31

### Changed
- README: the proprietary-license notice now references the bundled `LICENSE` file by name instead of linking to it, so it no longer points at a repository that is not publicly shared.

## [0.2.1] - 2026-07-27

### Changed
- Building and signing the payer's deposit authorization now runs entirely through the shared `@atum-labs/payment-request-sender-auth` library (via the updated `@atum-labs/payment-gateway-client`): the deposit nonce is derived deterministically from the charge identity (retry-safe) and the EVM/Tron permit deadline tracks the settlement horizon. No public API changes; the idempotency anchor is byte-identical.
- Deposit-freshness verification (permit deadline) now uses the merchant's configured clock, consistent with the existing deadline-ordering and budget checks, instead of the wall clock.

## [0.2.0] - 2026-07-24

### Changed
- Verifying the payer's deposit authorization (`sender_auth`) now delegates to the shared `@atum-labs/payment-request-sender-auth` library instead of an embedded copy of the recover-and-verify logic, keeping the escrow method byte-compatible with the rest of the Atum payment stack.

## [0.1.1] - 2026-07-22

### Changed
- Packaging for standalone publication: externalized `@solana/web3.js` so the LGPL-licensed `rpc-websockets` (pulled in transitively) is no longer bundled into the published package. Added `THIRD-PARTY-NOTICES.txt` and license materials. No API changes.

## [0.1.0] - 2026-07-21

### Added
- Initial release: `mppx-atum-escrow`, Atum's cross-chain escrow payment method for the MPP (x402-style) payment flow — build, sign, and verify a source-chain deposit authorization across EVM, Tron, and Solana.
