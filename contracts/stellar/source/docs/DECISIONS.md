# Stellar contracts: design decisions

Where a choice has a credible alternative, the alternative is recorded so the call can be reversed cheaply.

## Escrow

Source of truth for behaviour is EVM `Escrow.sol`; the Solana port is the model for structure and byte
framing. Where they disagree EVM wins unless the Solana layout is needed for framing.

### Upgradeability

No `upgrade` entrypoint; a new version ships as a new contract id. Solana differs here: its v4
programs are upgradeable (`../../../svm/deployments-v4.json`). The
default admin cannot replace the code, so a compromised admin cannot swap logic under live deposits. Cost: a fix means a drain, redeploy, re-grant of roles and re-allowlisting, and a
new `contract_id` in every signing domain. Alternative: an admin-gated `upgrade(wasm_hash)`
(`env.deployer().update_current_contract_wasm`), ideally behind the same delay as the admin transfer.

### Releaser witness is eleven members

`release` and `refund` sign depositId, quoteHash, depositRequestHash, destinationHash, depositor,
token, amount, feeAmount, reserver, releaser, settler, as on EVM and TVM, inside Solana-style framing
(`witness-layouts.md`). Effect: the stored-hash check and the signature bind the same tuple, and a
releaser who signs a settlement signs the payee, amount and fee. Cost: a log-only releaser needs the
commitments, which `DepositCommitments` carries. Alternative: Solana's two-field witness (deposit hash and
quote hash only), which is shorter but lets the signature cover less than what is paid out.

### Fee revenue accrues in the escrow, withdrawn by the treasurer (EVM-style)

As EVM: `release` adds `fee_amount` to a per-token revenue counter and pays the settler
`amount - fee_amount`; `withdraw_fee_revenue(caller, token, recipient)` (TREASURER) sends the counter out.
Refund returns the full amount and takes no fee. Alternative: Solana's fee-to-treasurer at release (no
counter, no withdrawal function, one more transfer and one more required account in every release).

### Implementation decisions

- **Depositor authorisation: delegate model (see below).** `deposit` has no depositor
  `require_auth`.
- **Deposit id = deposit digest** (Solana), not EVM's `keccak(depositor, signature, nonce)`. The
  delegate's signature is deterministic over the id, so hashing it in would add nothing. The reserver signs over the id, so a reserve signature cannot be moved to
  another deposit.
- **One quote, one deposit per reserver.** `deposit` records `DataKey::QuoteUsed(reserver, quote_hash)`
  and rejects a second deposit under the same pair with `QuoteAlreadyUsed` (78), live or completed. The
  deposit id carries no quote, so without the marker two deposits with different nonces could carry one
  quote hash and one destination fulfilment could justify two releases. The marker is never cleared, like
  the nonce bitmap, so a refunded quote cannot be reserved again: a retry needs a fresh quote hash. It is
  keyed on the reserver so a depositor who names someone else's reserver key cannot use up an honest quote
  (the reserve signature would fail). A releaser that matches releases by quote hash must also match the
  reserver, because the same hash can be reserved by another reserver key.
  The marker is a persistent entry extended to the network maximum when written.
- **Nonces** are an unordered bitmap per depositor and token (one `u128` word per 128 nonces), never cleared, the
  shape of Permit2's `nonceBitmap`. The token is in the storage key, not in any signed bytes (the deposit and
  renounce digests already commit to it), so a delegate signer can only spend nonces in the token space of
  its own record. A nonce word is persistent storage, the one entry the TTL policy below does not extend; an
  archived word cannot be recreated, so archival never reopens a used nonce.
- **Deposit time window.** `issued_at <= now`, `now <= deadline`, `deadline - issued_at <= 24 h`.
  The 24 h bound is a deliberate choice (Solana's is 128 s because its replay buckets are finite; ours are not). It only
  limits how long a signed-but-unused deposit stays acceptable.
- **Reserver and releaser are raw ed25519 public keys** (`BytesN<32>`, see below), not `Address`es. The contract
  verifies the signature itself with `ed25519_verify`; a contract account or a multisig cannot sign a
  digest, and `Address::to_payload` documents that the master key behind a `G...` address is not
  necessarily a signer of the account. Consequence: the reserver and releaser are single keys. Rotating
  one affects new deposits only; a live deposit keeps the releaser stored in its hash.
- **Failed signature verification traps.** `ed25519_verify` has no boolean form, so a bad signature is a
  host error, not a contract error code. Tests assert it is an error and that nothing moved.
- **Domain separation** is `sha256(passphrase)` and the contract id from the ledger, with a version byte;
  no configurable cluster id. Addresses enter digests as 33 bytes (type byte + 32). Amounts are 16-byte
  little-endian. The layout is in `witness-layouts.md`.
- **Stored deposit = hash of the ten-member `ActiveDeposit`**, under `DataKey::ActiveDeposit(id)`, as EVM
  stores `keccak(abi.encode(ActiveDeposit))`. Release and refund rebuild the tuple from their witness,
  compare, delete the entry first, then verify the signature and transfer.
- **Pause blocks deposit, release and refund**, as EVM. This means a paused escrow cannot refund; same
  trade-off as EVM, unpause is the escape.
- **The escrow cannot be a deposit's settler.** `deposit` rejects `reserve_witness.settler` equal to the
  escrow with `SettlerCannotBeSelf` (81). A release would transfer from the escrow to itself, which a
  Stellar Asset Contract accepts as a no-op, leaving `amount - fee_amount` in the escrow with no deposit or
  counter recording it; `withdraw_fee_revenue` pays booked revenue only. It mirrors that function's refusal
  of the escrow as recipient.
- **Exact-transfer check** on deposit (balance before and after equals `source_amount`), as EVM, so a
  fee-on-transfer token cannot make the pool short.
- **Token decimals** must equal the token's own `decimals()`; a token that does not answer is refused with
  `TokenDecimalsMismatch` (24). SEP-41 makes `decimals` mandatory and a Stellar Asset Contract always answers 7,
  so a token that does not answer is not deployed yet or is not a token. A Stellar Asset Contract's address
  is known before it is deployed, so it must be deployed first (anyone can deploy it) and allowed afterwards;
  the stated value would otherwise be trusted unchecked and scale every fee floor and cap of that token.
  `MAX_TOKEN_DECIMALS` is 18, not EVM's 30: fee arithmetic is `u128`, not `uint256`. Amounts above about 3.4e30 atoms fail closed
  with `FeeArithmeticFailed`. Fee percentage is `u32`, min and max bounds `u64` (6-decimal scaled).
- **Roles.** Role-gated calls take `caller: Address` and `require_auth` it, because there is no
  `msg.sender`. PAUSER, TREASURER and TOKEN_CONFIG can each have several holders (AccessControl);
  the default admin grants, revokes, and a holder can renounce. The default admin is not a grantable role:
  it moves only through `begin_default_admin_transfer` / `accept_default_admin_transfer` (new admin
  authorises, strictly after the delay), `cancel_default_admin_transfer`, and the delay changes only via
  `change_default_admin_delay` with OpenZeppelin's wait (min(new, 5 days) for an increase, the difference
  for a decrease) and `rollback_default_admin_delay`. A begin or a change that replaces a still-pending schedule emits the matching `...Canceled` event before
  the new `...Scheduled` one. Not ported: `renounceRole` for the default admin.
- **Constructor** takes `(default_admin, admin_delay_secs)`. EVM hard-codes 1 second so the deployer can
  hand over at once; pass 1 for that flow and raise it from the multisig afterwards. The deploy script refuses a mainnet run
  with an admin delay under 86400 seconds (one day) on either contract, so on mainnet the delay is raised at
  deploy time, not after. It publishes
  `Initialized {default_admin, admin_delay_secs}` (topic: `default_admin`), the genesis entry of the event
  stream, so a log-driven monitor starts with the initial authority.
- **Out of scope here, present on EVM:** `directDeposit`, `reserve`, `refundUnreserved` (the unreserved
  deposit flow) and the batch functions. The contracts cover deposit, release and refund only.
- **`hazmat-address` feature** of `soroban-sdk` is enabled solely for `Address::to_payload`, to put an
  address into a fixed-width digest. It is never used for authentication.

### TTL policy

- Every persistent entry the escrow relies on (deposit hash, token config, allowlist, roles, fee
  revenue) is extended to the network maximum TTL when written, and when read by a
  state-changing call, whenever less than `max - 7 days` remains. Instance storage (admin, delay, pause
  flag) is extended by every state-changing entrypoint.
- The exception is the nonce word: it is created with the network minimum persistent TTL and never
  extended, so a deposit does not prepay rent for it. A deposit signature is refused after its deadline
  (at most 24 hours after `issued_at`), so nothing needs the word to outlive that; if it is archived anyway,
  restoring it brings its bits back and it cannot be recreated empty.
- **Never-cleared markers keep the maximum; the nonce word does not.** Three more entries are written once and
  never cleared: the escrow's `QuoteUsed(reserver, quote_hash)`, the proxy's `StrictFulfilled` marker and the
  proxy's `SettlerNonce` word. The escrow writes `QuoteUsed` with `set_persistent`, which extends it to the
  maximum whenever less than `max - 7 days` remains, so a new marker is prepaid to the maximum on each deposit; the
  proxy extends both of its entries to the 180 day horizon (threshold equal to the target) on each strict fulfil
  or fulfil. Archival does the same thing to all of them: an archived entry cannot be recreated, its key stays
  occupied until it is restored, and a restore brings the marker back, so archival can delay a duplicate but not
  defeat the check. The rule for the marker is that nothing bounds the guarantee in time: "one quote, one
  deposit per reserver" and "one payment, one strict fulfilment" hold for good, whereas the nonce word guards
  only against replay of a signature that is refused after its deadline (24 hours at most), so the word's
  life past the deadline buys nothing. For a marker the maximum buys one thing: within the horizon the
  contract itself refuses the duplicate (`QuoteAlreadyUsed`, `AlreadyFulfilled`), and no restore is needed
  to learn that. It is not needed for correctness, and no honest flow reads a marker again, so a restore is
  only ever paid for by a caller who is repeating a call. That is a choice, not a necessity: creating a
  marker like the nonce word (the plain `set`) would be sound, and cheaper per deposit by the extension from the
  minimum persistent TTL to the maximum, 1,036,800 ledgers on mainnet settings. Its size in stroops is not
  measured. The proxy's `SettlerNonce` word is the one entry of the three where the nonce word's reasoning
  applies in full (the settler signs a deadline, a restore brings the bits back), and it is still extended to the
  horizon; this audit round left it unchanged.
- Deposits have no on-chain expiry, so per-touch extension is not enough: `extend_deposit_ttl(id)` is a
  permissionless keep-alive that the settler's operator, a monitor, or the depositor must call before
  `max TTL - 7 days` of a deposit's life has passed. The maximum TTL is a network parameter (read it from
  the ledger, do not hard-code it).
- An archived entry is not lost: its state is preserved and `RestoreFootprint` brings it back. The
  failure mode is "release and refund blocked until restored".
- The instance bump (`bump_instance`, the SDK's `Instance::extend_ttl`) extends the contract code entry as well
  as the instance, under the same threshold and to the same TTL; there is no way to extend only the instance.
  Operations still need a keeper (`stellar contract extend`, or the `extend-ttl` script) that runs at least once
  per bump window (7 days on the escrow): when it has not, the first caller to cross the threshold pays the rent of
  the code entry, which is much larger than anything a normal call writes, on top of its own fee. Who bears the code
  rent therefore depends on the keeper's schedule, not on the design.
- **The escrow's balance entry inside each token is not kept alive by the escrow.** Deposited tokens sit in one
  persistent entry per token, `Balance(escrow)` in the token contract's own data (Stellar Asset Contract layout).
  It starts at the network minimum persistent TTL, and the token extends it only to 30 days, only when fewer than 29
  remain, and only when the escrow's own balance is read or written: other holders' transfers never touch it, and
  neither does `extend_deposit_ttl`. After 30 days without escrow activity in a token the entry archives, however
  actively the token trades elsewhere, and `deposit`, `release`, `refund` and `withdraw_fee_revenue` for that token
  fail until it is restored. So a keeper that follows the keep-alive above is not enough: the `extend-ttl` keeper
  also extends the escrow's `Balance` entry of every token the escrow lists, read at run time with `get_allowed_tokens`
  (a simulated read; if it fails the run fails, it never falls back to the deployments file), plus any token the file
  still records that the escrow no longer lists, since `disallow_token` leaves its deposits settleable. It skips and
  reports a token for which the RPC returns no such entry, and warns when the escrow lists no token. A token allowed
  after the last `deploy` run is therefore covered without refreshing the file. Keepers must run it at least once per 30 days; a token that is
  not a Stellar Asset Contract has its own storage layout and is not covered by that key.
- Verified: tests pin the TTL accounting (stored at max, extended on touch, not re-extended inside the
  window, keep-alive moves the expiry past the original, release works after it). NOT verified: archival
  enforcement. The host-native test environment silently restores an expired persistent entry
  (`handle_maybe_expired_entry` in soroban-env-host), so "release fails when archived" cannot be tested
  there; that needs a testnet run with ledgers advanced past the TTL.

### Depositor pre-authorisation uses the delegate model

PaymentRequest carries `max_source_amount` and the depositor authorises the deposit once, before the
auction. The design uses Solana's delegate model: the depositor enrols a delegate signer once
(`create_delegate`, which does `require_auth`), and each `deposit` is authorised by that delegate's
ed25519 signature over the deposit digest, not by a `require_auth` of the depositor on the call. This
deviates from a plain `require_auth` of the depositor on each deposit.

Why:
- The off-chain gateway can verify a plain ed25519 signature offline, over the digest the shared encoders
  produce, with no Soroban authorisation entry to build or check.
- `sender_auth` stays Solana-shaped: a delegate signer, a one-time enrolment and a cap, so the
  off-chain flow is the same on both chains.

Alternatives rejected:
- (a) The depositor signs after the auction with a plain `require_auth` on `deposit`. This puts the
  depositor's signature after the auction, which the pre-authorisation flow avoids.
- (b) `require_auth_for_args`, with the depositor authorising only the deposit-witness fields before the
  auction. This is possible: the soroban-sdk 30.0.0-rc.1 docs for `Address::require_auth_for_args` say the
  arguments need not match the invocation's. Rejected because the gateway would then have to handle
  a Soroban authorisation entry rather than a plain signature, and it would not give
  `sender_auth` the delegate shape (signer, enrolment, cap).
- (c) A depositor-key ed25519 signature over a ceiling. It needs the depositor to be a plain key (no
  contract or multisig accounts) and a second signing scheme.

How it works (`witness-layouts.md` has the bytes):
- `create_delegate(depositor, token, delegate_signer, capacity, max_transfer_size, expiration)`,
  depositor `require_auth`, allowlisted token, `0 < max <= capacity`, non-zero signer, future expiry,
  one record per (depositor, token), blocked while paused.
- Setup also needs the depositor's `token.approve(depositor, escrow, amount, expiration_ledger)`,
  off-contract. The contract does not make it.
- `deposit` checks the record (exists, `now < expiration`, charged amount within max and remaining
  capacity), verifies the delegate signature over the deposit digest, then pulls with
  `transfer_from(escrow, depositor, escrow, source_amount)`. A missing or short allowance reverts in the
  token. Capacity is consumed by the charged amount.
- `create_delegate` returns the epoch it assigned, and `DelegateCreated`, `DelegateRevoked` and
  `DelegateRenounced` each end with that record's `epoch`, so a signer that follows the call result or the
  event log learns the epoch the deposit and renounce digests commit to without counting events.
- `revoke_delegate` (depositor) deletes the record. `renounce_delegate` is the signer giving up authority.

Deviations from Solana:
- Revoke deletes the record but cannot also zero the allowance (that is the depositor's own `approve`
  call; the contract has no standing authority to make it). A deleted record already blocks every
  deposit, so a stale allowance is inert.
- Renounce is by signature, not a transaction signer: the delegate is a raw key that cannot
  `require_auth`. The digest carries the record's `epoch` (a per-(depositor, token) counter kept across
  revokes, +1 per `create_delegate`) so a signature cannot kill a later record of the same pair, and a
  nonce from the bitmap of the depositor and token so it is single-use. Capacity and expiry are zeroed and the record stays until revoked, as
  on Solana.
- The renounce digest also carries a `deadline` the signer picks, and `renounce_delegate` refuses the call
  with `DeadlineExpired` once the ledger time is past it. Without it a signature that leaked (a relayer, a
  failed transaction published on the ledger) stayed executable for as long as the epoch and nonce did
  not change, and zeroed the record, and with it every deposit in flight, whenever its holder chose. Solana's
  renounce expires with the signer's own transaction; the deposit already carries a deadline.
  `SIGNATURE_DOMAIN_VERSION` was not bumped for this, by the rule in `witness-layouts.md`: the preimage
  grows from 161 to 169 bytes and has its own tag, so no signature over the old layout can verify against
  the new one, and a bump would re-derive the deposit, reserve, release and refund digests, which did not
  change and whose signatures should stay valid.
- Pause blocks `create_delegate` only; Solana also blocks revoke and renounce, which would stop users
  withdrawing authority.
- Cap and max apply to the charged `source_amount` (what moves), as Solana's apply to its pulled
  amount. The signed ceiling `amount` is not capped separately.
- `deposit` is callable by anyone (relayer or settler); the delegate signature is the authority.

Operational notes:
- SEP-41 allowance expiration is a ledger number bounded by the network max TTL (3,110,400 ledgers, about 180 days,
  on testnet and mainnet as read on 2026-11-17; read it from the ledger, validators can change it). A longer-lived delegate needs periodic
  re-approval; deposits fail with a token error once the allowance lapses even if the record is valid.
  Set the record's expiry no later than the allowance's.
- The minimum persistent TTL, the lifetime a new persistent entry starts with, is 2,073,600 ledgers (about 120 days) on
  mainnet and 120,960 (about 7 days) on testnet, read on 2026-11-17 with `stellar network settings`. Neither contract
  reads it. The escrow and the proxy both extend entries to the maximum, so the starting lifetime does not matter
  (see "Storage and TTL" under the proxy).
- A compromised `delegate_signer` can drain the depositor up to the remaining capacity, and no more than
  the allowance. Choose capacity and per-transfer max for the exposure you accept, keep the signer key
  in the same custody as a spending key, and revoke (plus `approve` 0) on suspicion.
- **Pre-signed deposits die with their record.** The deposit digest carries the delegate record's
  `epoch`, a per-(depositor, token) counter that rises on every `create_delegate` and survives a revoke.
  A deposit the delegate signed under one record therefore cannot be submitted under a later record of
  the same pair, even when the depositor re-enrols the SAME signer key within the 24 h validity window:
  the id the contract derives differs, so both the delegate and the reserve signature are void. A signer
  must read the current epoch (`get_delegate`) before signing, and a deposit signed just before a
  revoke and re-enrolment has to be signed again.
- **Allowance outlives revoke.** The SEP-41 allowance persists after `revoke_delegate` and must be
  zeroed by the depositor (`approve` 0). A later record, even with a different signer, can spend a
  leftover allowance up to its own capacity.
- **Capacity is never restored.** Release and refund do not give capacity back. Verified against Solana:
  `remaining_capacity` is written only at create, renounce, and the deposit decrement
  (`instructions/escrow.rs`); refund and release never touch it. So capacity is a lifetime spend limit
  of the record, not a limit on outstanding deposits; re-create the record to top up.
- **Archival is fail-safe.** If a delegate record or nonce word is archived, deposits (and renounce)
  fail until it is restored; authority is never extended by archival. An expired or renounced record
  lingers until revoked, and `create_delegate` returns `DelegateAlreadyExists` until then.
- The delegate signs a deposit before the auction; the reserver independently signs the charge, so the
  signer alone cannot choose the settler or the amount.

### Build note

(Superseded by "soroban-sdk 30" below; kept as history.) `soroban-sdk` 29 refuses to build for wasm unless the build system declares spec-shaking support, i.e.
it must be built with `stellar contract build` (stellar-cli 25.2.0 or newer). Without
stellar-cli, a wasm can be built with that guard forced; it is a size and compile check only; its
embedded spec is not shaken. Build release artefacts with the CLI.

### soroban-sdk 30 (Protocol 30, "Bell")

The contracts use `soroban-sdk` 30, the SDK for Protocol 30, to match the network they run on. The network does not
require it: Stellar's Bell upgrade guide (updated 2026-10-23) says existing contracts keep working unchanged and does not
say new contracts must be built on SDK 30. The SDK upgrade it makes mandatory is for client and off-chain code that
decodes ledgers. The workspace pins `=30.0.0-rc.1`, a release candidate (30.0.0 stable is not released); the audit
freezes on it. If stable is published before the fix re-review, the change from rc.1 to stable is reviewed then. The
comment above the pin in `source/Cargo.toml` still says the pin "MUST move to stable 30.0.0 before an audited build";
that comment is superseded by this paragraph, and the manifest is left unchanged so it stays as it was at the audit pin.
Because the wasm records the SDK and CLI versions in its metadata, moving either changes the wasm hash even when the
code is unchanged. Testnet is on Protocol 30, and mainnet upgrades after its vote. The migration needed no source change; vectors and digests are unchanged. SDK 30 requires
`stellar contract build` from stellar-cli v30.0.0 or newer. The pinned toolchain and the CLI commit are in the
"Reproducible build" section of `../../deploy/README.md`; the wasm hashes are published by the `stellar-wasm` CI lane. Address handling is unchanged: CAP-84 muxed contract (W...)
addresses are a `MuxedAddress` concern, no contract entrypoint takes one, and `address33` still rejects any
address without a G/C payload with `UnsupportedAddress`.

## FulfillmentProxy

Source of truth is EVM `FulfillmentProxy.sol`; Solana `fulfillment_proxy` is the structural model.
Batch `fulfillMany` is out of scope.

### Upgradeability

No `upgrade` entrypoint; a new version ships as a new contract ID (unlike Solana: see the escrow's
Upgradeability above). Alternative considered: an admin-gated `upgrade(wasm_hash)`.

### Implementation decisions

- **Caller identity.** Soroban has no `msg.sender`, so every settler-facing entrypoint takes
  `settler: Address` and calls `settler.require_auth()`. `Fulfilled.settler` and the allowlist check use it.
- **No approve step.** `fulfill` calls `token.transfer(settler, to, amount)` from inside the proxy, authorized by
  the settler's auth entry (it covers the nested call), instead of EVM's approve + `transferFrom`. Amount is `i128`
  (SEP-41); `amount <= 0` is `ZeroAmount`.
- **Settler nonce and `fulfill` deadline.** `fulfill` and `strict_fulfill` take a settler-chosen `nonce: u64`,
  spent once per settler in one unordered bitmap that both share (one `u128` word per 128 nonces, never cleared,
  persistent, the escrow's nonce shape); a second use reverts `NonceAlreadyUsed` (16). `fulfill` also takes a
  settler-signed `deadline` (unix seconds, inclusive, `DeadlineExpired` after it), as `strict_fulfill` does. This
  is not an EVM or Solana feature: there a failed transaction consumes the sender nonce or stays recorded under its
  id, but on Soroban a failed transaction rolls back the host's own authorization nonce, so a signed entry of a
  failed `fulfill` stays valid and public until its expiry ledger. With the settler nonce a retry reuses the nonce
  (the failed attempt's spend is rolled back too), so whichever signed entry lands first consumes it and the other
  reverts, and an entry that is never retried stops paying at its deadline. The settler passes a `deadline` no
  later than the quote's fill deadline. A settler that submits as the transaction source is not exposed, since
  its authorization is the transaction itself.
- **Guard order in `strict_fulfill`** is EVM's: pause, allowlist, deadline, empty hash, zero amount, already
  fulfilled, then the settler nonce.
- **The strict marker is keyed on the payment, not the quote hash.** `DataKey::StrictFulfilled(quote_hash, to,
  token, amount)`, global across settlers (no settler in the key), persistent, never cleared, extended to the
  horizon on write. It is a tuple variant like `SettlerNonce(settler, word)`, so a key is readable in storage and
  needs no hashing or encoding step in the contract; the cost is a larger key (the two addresses and the
  amount, a few times the size of a bare hash), which is small next to the fixed overhead of a ledger entry. `is_strictly_fulfilled` takes the same four
  fields. Why: `to`, `token` and `amount` are free arguments, so with a marker on the bare quote hash a listed
  settler could strict-fulfil the quote with a worthless token and amount 1, burn the marker, and make the awarded
  settler's call revert `AlreadyFulfilled` for good. Now a call with a different payment consumes only its own
  key, and an identical second call (all four fields equal) still reverts `AlreadyFulfilled`. No new error code.
  Residual: two different payments for one quote hash can both succeed onchain, and a rival that strict-fulfils
  the exact real payment first (from its own funds) makes the awarded settler's identical call revert although the
  delivery happened. Nothing onchain ties a payment to a quote beyond the hash. The offchain verifier matches the
  quote hash, recipient, token and exact amount of a `Fulfilled` event, and the refund scanner matches the same
  four fields; neither matches the settler or the reserver, so one delivery is found whoever made it, and a
  consumer must tolerate more than one `Fulfilled` event per quote hash.
- **Allowlist** is a persistent entry per settler (no cap, unlike Solana's 16-entry vec), admin-gated
  `add_authorized_settler` / `remove_authorized_settler` / `set_settler_allowlist_enforced`. Ships dormant.
  Dormant means any caller can strict-fulfil, so grant settlers and enforce in one admin batch before routing
  payments: while dormant, anyone can pay a quote's exact payment from their own funds and make the awarded
  settler's identical call revert. With the payment-keyed marker a caller can no longer block the awarded
  settler with a different payment. Add/remove emit only on a real state change.
- **`authorize_fulfillment`** emits only (no state, no deadline check, pause-gated), like EVM. Topics:
  `fulfillment_authorized, authorization_hash, quote_hash, settler`. It ignores the allowlist, as on EVM.
- **Events** (`#[contractevent]`): `fulfilled` topics `[quote_hash, settler]`, data `{to, token, amount, timestamp}`.
  `quote_hash` leads because it is the correlation key the Solana plugin and the off-chain verifier join on. Strict and
  non-strict emit the same event (EVM), unlike Solana's separate `StrictFulfilled`.
- **Roles.** Constructor `(default_admin, pauser, delay_seconds)`, so there is no initialize front-run window.
  It publishes `ProxyInitialized {default_admin (topic), pauser, delay_seconds, enforce_settler_allowlist}`,
  the genesis entry of the event stream; the allowlist flag is `false` (dormant).
  Admin transfer is two-step with delay (`begin`, `accept` by the pending admin after the delay, `cancel`);
  beginning again replaces the pending transfer, restarts the clock and emits `DefaultAdminTransferCanceled`
  before the new `DefaultAdminTransferScheduled`, so an event-driven monitor drops the superseded schedule. The delay itself changes only through
  `change_default_admin_delay`, delayed as OpenZeppelin's `AccessControlDefaultAdminRules` and the escrow do
  (below), with `rollback_default_admin_delay`. No `renounce`.
- **Storage and TTL.** Config and pending admin in instance storage, extended on every entrypoint to the network's
  max entry TTL (180 days, read from the ledger; one day of slack below it before a re-extension).
  The target is not lower than the minimum persistent TTL: on mainnet a new entry starts at 2,073,600 ledgers
  (about 120 days) and `extend_ttl` acts only below its threshold, so a 30 day target would never run for a fresh
  entry there while it does on testnet (minimum 120,960 ledgers), and would leave the proxy on a 30 day horizon
  once past its initial TTL, six times shorter than the escrow's.
  Settlers, strict markers and nonce words are persistent, extended on write (settlers also on read). The network max entry TTL
  (3,110,400 ledgers, about 180 days, on testnet and mainnet as read on 2026-11-17) is a hard cap and the host rejects a
  longer extension, so markers are not extended "forever". An archived
  marker cannot be recreated while archived, so archival can delay but not defeat idempotency. The `deadline`
  argument of `strict_fulfill` is supplied by the caller and is not bound to any quote onchain, so a settler
  can pass `u64::MAX`; the contract enforces only "not after the deadline the caller passed". Nothing onchain
  bounds a real quote expiry, and where it is enforced offchain is not yet decided: the veri-fill verifier reports
  the ledger close time but nothing reads it, and a release is deliberately not tied to the fulfillment deadline,
  so a late delivery cannot strand a deposit. A keeper that re-extends the instance is still needed.

### The admin-delay change is itself delayed (OZ)

The contract follows OpenZeppelin's `AccessControlDefaultAdminRules` behaviour, exactly as the escrow does it.
`change_default_admin_delay(new_delay_seconds)` schedules the change: an increase takes effect after
min(new delay, 5 days), a decrease after the difference between the current and new delay; a pending change
is replaced. `rollback_default_admin_delay` cancels it (reverts `NoPendingDelayChange` if none).
A change that has taken effect is applied lazily (strictly after its time), so no transaction is needed;
`begin_default_admin_transfer` reads the delay in force. Views: `default_admin_delay`,
`pending_default_admin_delay`. Events: `AdminDelayChangeScheduled {new_delay, effective_at}`,
`AdminDelayChangeCanceled {admin}`, which is also emitted, before the new Scheduled event, when a change that is
still pending is replaced. Rejected: Solana's immediate change, under which a compromised admin sets
the delay to 0 and begins and accepts a transfer in one ledger. `set_default_admin_delay_seconds` is removed.

### Token policy

Only standard Stellar Asset Contract tokens (for example USDC) are to be allowlisted. The escrow keeps its
exact-transfer check on deposit. The proxy has no balance-delta check (it breaks when `to == settler`), so a
fee-on-transfer SEP-41 token would make the `fulfilled` event overstate the payment. The mitigation is the
allowlist policy, documented here, not code: do not allowlist such a token.

`allow_token` opens deposits for the token at once, under a zero fee schedule. Every deposit accepted before
`set_token_fee_config` runs keeps a zero fee, because the fee is fixed in the stored deposit and a later fee
change does not reach it. `disallow_token` deletes the whole token config, so a token that is disallowed and
then allowed again with `allow_token` comes back with zero fees, not its previous schedule; the
`TokenAllowed` event carries no fee fields to show it. `allow_token_and_set_fee_config` allows the token and
sets its fees in one call and is the way to allowlist a token. `allow_token` alone is for a token that is
meant to charge no fee. Test: `allow_token_opens_deposits_at_zero_fee_and_re_allowing_discards_the_schedule`.

**Clawback is a known risk, and an operating rule covers it.** A Stellar Asset Contract whose issuer has
`AUTH_CLAWBACK_ENABLED` could be allowlisted. The issuer (the asset admin) can then claw back tokens from the
escrow's balance, which the Stellar Asset Contract marks clawbackable when that balance is created under such an
issuer. Each deposit's amount is fixed in its stored hash and `release` and `refund` pay it out of the pooled
balance, so once a clawback leaves the balance below a payout, that call reverts and the deposit stays
unsettleable until the balance is topped up. The shortfall falls on whichever deposits settle last. Principal is
lost to the issuer's clawback, not to the escrow.

Operating rule: TokenConfig holders must not allowlist a token whose issuer has `AUTH_CLAWBACK_ENABLED`. Before
allowing a token, check the issuer account's flags off chain and refuse the token if that flag is set. The
contract cannot enforce this: the flags live on the issuer's account, soroban-sdk 30 exposes no way to read them,
and the issuer can change them after the token is allowlisted, so an on-chain check would only be a point-in-time
one. The rule is therefore a process control on the role holder, in the same way as the rule against
fee-on-transfer tokens above.

### Reserver and releaser stay raw ed25519 keys

The escrow's reserver and releaser roles remain raw ed25519 public keys. No contract accounts or multisigs
for those two roles.

### Open questions

- **FulfillmentAuthorization schema has `scheme: "EIP-3009"` only.** A Stellar originator-fulfill needs a new
  scheme (a signed SEP-41 transfer or a Soroban auth entry) before `authorize_fulfillment` is usable end to end;
  the contract treats `authorization_hash` as an opaque 32 bytes.
- **No exact-credit check.** Resolved by token policy, see "Token policy" above.
- **`fulfilled.timestamp`** is ledger close time in seconds (EVM `block.timestamp` equivalent).
