# Fulfillment Proxy

Token transfers with deadline enforcement and replay protection.

**Program ID:** `679cgQsBfvGLbeJutpRmJvEZtx5pWsXxwN6cGJggMjSx`

## Protocol Configuration

### initialize_protocol

Creates the global `ProtocolConfig` PDA. Only callable by program upgrade authority.

| Parameter                     | Type     | Description          |
| ----------------------------- | -------- | -------------------- |
| `default_admin`               | `Pubkey` | Admin role key       |
| `pauser`                      | `Pubkey` | Pause authority      |
| `default_admin_delay_seconds` | `u32`    | Admin transfer delay |

| Account           | Type    | Mut | Description                                         |
| ----------------- | ------- | --- | --------------------------------------------------- |
| `protocol_config` | PDA     | Yes | Created config account                              |
| `authority`       | Signer  | Yes | Program upgrade authority (pays for rent)           |
| `program`         | Program |     | Fulfillment proxy program (executable validation)   |
| `program_data`    | Account |     | Program data account (upgrade authority validation) |
| `system_program`  | Program |     | System program                                      |

### pause / unpause

Pauses or resumes fulfillment operations. Only callable by pauser role.

| Account           | Type   | Mut | Description                         |
| ----------------- | ------ | --- | ----------------------------------- |
| `protocol_config` | PDA    | Yes | Protocol config                     |
| `pauser`          | Signer |     | Must match `protocol_config.pauser` |

### set_pauser

Updates the pauser role key. Only callable by default_admin.

| Parameter    | Type     | Description      |
| ------------ | -------- | ---------------- |
| `new_pauser` | `Pubkey` | New role address |

| Account           | Type   | Mut | Description                                |
| ----------------- | ------ | --- | ------------------------------------------ |
| `protocol_config` | PDA    | Yes | Protocol config                            |
| `default_admin`   | Signer |     | Must match `protocol_config.default_admin` |

### begin_default_admin_transfer

Initiates two-step admin transfer with configurable delay.

| Parameter   | Type     | Description           |
| ----------- | -------- | --------------------- |
| `new_admin` | `Pubkey` | Pending admin address |

| Account           | Type   | Mut | Description     |
| ----------------- | ------ | --- | --------------- |
| `protocol_config` | PDA    | Yes | Protocol config |
| `default_admin`   | Signer |     | Current admin   |

### accept_default_admin_transfer

Completes admin transfer after delay. Only callable by pending admin.

| Account           | Type   | Mut | Description                                        |
| ----------------- | ------ | --- | -------------------------------------------------- |
| `protocol_config` | PDA    | Yes | Protocol config                                    |
| `pending_admin`   | Signer |     | Must match `protocol_config.pending_default_admin` |

### set_default_admin_delay_seconds

Updates the delay for admin transfers. Only callable by default_admin.

| Parameter           | Type  | Description          |
| ------------------- | ----- | -------------------- |
| `new_delay_seconds` | `u32` | New delay in seconds |

| Account           | Type   | Mut | Description                                |
| ----------------- | ------ | --- | ------------------------------------------ |
| `protocol_config` | PDA    | Yes | Protocol config                            |
| `default_admin`   | Signer |     | Must match `protocol_config.default_admin` |

## ProtocolConfig

Global protocol configuration PDA.

**PDA Seeds:** `[b"protocol_config"]`

| Field                                 | Type            | Description             |
| ------------------------------------- | --------------- | ----------------------- |
| default_admin                         | Pubkey          | Full role management    |
| pauser                                | Pubkey          | Pause/unpause authority |
| paused                                | bool            | Protocol pause state    |
| default_admin_delay_seconds           | u32             | Admin transfer delay    |
| pending_default_admin                 | Option\<Pubkey> | Pending new admin       |
| pending_default_admin_accept_after_ts | Option\<i64>    | Accept timestamp        |

## fulfill

Transfers tokens from settler to recipient. No replay protection. The recipient must be credited
exactly `amount`, or the call fails with `NonExactTransfer` (a Token-2022 transfer fee would credit
less while the event reports `amount`). For a mint with a transfer hook program, the hook's
validation account, its extra accounts and the hook program go in `remaining_accounts`.

**Parameters:**

| Parameter    | Type       | Description                                 |
| ------------ | ---------- | ------------------------------------------- |
| `quote_hash` | `[u8; 32]` | Offchain quote hash identifying the payment |
| `amount`     | `u64`      | Token amount (must be > 0)                  |

**Accounts:**

| Account                    | Type                      | Description                                     |
| -------------------------- | ------------------------- | ----------------------------------------------- |
| `protocol_config`          | `Account<ProtocolConfig>` | Pause gating (must be unpaused)                 |
| `settler`                  | `Signer`                  | Transfer authority (can be PDA)                 |
| `payer`                    | `Signer`, mut             | Pays for fees and account init                  |
| `from_ata`                 | `InterfaceAccount<Token>` | Settler's token account, mut                    |
| `to_ata`                   | `InterfaceAccount<Token>` | Recipient's token account, mut (init_if_needed) |
| `to`                       | `UncheckedAccount`        | Recipient address                               |
| `mint`                     | `InterfaceAccount<Mint>`  | Token mint                                      |
| `token_program`            | `Interface<Token>`        | SPL Token or Token-2022                         |
| `associated_token_program` | `Program`                 | Associated Token program                        |
| `system_program`           | `Program`                 | System program                                  |

## strict_fulfill

Same transfer as `fulfill`, with replay protection and a per-(quote, settler) idempotency marker. The
exact-credit check and the transfer hook `remaining_accounts` apply the same way, and a failed check
also rolls back the marker.

**Parameters:**

| Parameter    | Type       | Description                                             |
| ------------ | ---------- | ------------------------------------------------------- |
| `quote_hash` | `[u8; 32]` | Offchain quote hash identifying the payment             |
| `nonce`      | `u64`      | Replay nonce (`slot = nonce & 0xFF`)                    |
| `issued_at`  | `u64`      | Replay timestamp anchor                                 |
| `amount`     | `u64`      | Token amount (must be > 0)                              |
| `deadline`   | `u64`      | Must satisfy `issued_at <= deadline <= issued_at + 128` |

**Accounts:**

| Account                    | Type                      | Description                                     |
| -------------------------- | ------------------------- | ----------------------------------------------- |
| `protocol_config`          | `Account<ProtocolConfig>` | Pause gating (must be unpaused)                 |
| `settler`                  | `Signer`                  | Transfer authority (can be PDA)                 |
| `payer`                    | `Signer`, mut             | Pays for fees and account init                  |
| `replay_bucket`            | `Account<ReplayBucket>`   | Replay protection PDA (init_if_needed)          |
| `strict_fulfillment`       | `Account<StrictFulfillment>` | Per-(quote, settler) idempotency marker, seeds `["strict_fulfilled", quote_hash, settler]` (init_if_needed) |
| `from_ata`                 | `InterfaceAccount<Token>` | Settler's token account, mut                    |
| `to_ata`                   | `InterfaceAccount<Token>` | Recipient's token account, mut (init_if_needed) |
| `to`                       | `UncheckedAccount`        | Recipient address                               |
| `mint`                     | `InterfaceAccount<Mint>`  | Token mint                                      |
| `token_program`            | `Interface<Token>`        | SPL Token or Token-2022                         |
| `associated_token_program` | `Program`                 | Associated Token program                        |
| `system_program`           | `Program`                 | System program                                  |
| `legacy_strict_fulfillment` | `UncheckedAccount`       | Read-only. The marker address from before the settler joined the seeds, `["strict_fulfilled", quote_hash]`; must be empty |

## Idempotency & Replay Protection

`strict_fulfill` enforces **one fulfillment per quote and settler**: a `StrictFulfillment` marker
PDA seeded by `quote_hash` and the `settler` is set on that settler's first strict fulfillment of
the quote, so a later strict fulfillment of the same quote by the same settler, with any nonce,
reverts with `AlreadyFulfilled`.

The marker is per settler on purpose. The `quote_hash` is public before the destination fulfill,
so a marker seeded by `quote_hash` alone could be set first by any account, which would permanently
block the assigned settler. With the settler in the seeds, another account only marks its own slot.
The consequence is that a strict fulfillment is **not unique per quote**: two settlers that both
fulfill the same quote each pay from their own funds, and the escrow still releases a deposit once.
Do not rely on the marker as global evidence that a quote was fulfilled; match the fulfillment
event on the quote's terms. EVM and TVM still key their marker on `quote_hash` alone until their
own change lands.

The escrow releases only to the recipient the reserver named when it reserved the deposit
(`deposit.recipient`), so a second settler that also pays the quote is not released to. What the
global marker also did was stop one operator paying a quote twice from two keys, for example
across a key rotation mid-settlement; that guard is gone on Solana. CORE-2515 records the decision,
agreed with Gene, to move all three chains to per-settler markers, and its confirmation that
Veri-Fill does not depend on global uniqueness is still open.

### Quotes paid under the previous build

Before this change the marker was seeded by `quote_hash` alone, and every quote paid since has a
set marker at `["strict_fulfilled", quote_hash]`. The new build never reads or writes that address
for its own marker, so without a check a settler that lost track of a payment made before the
upgrade could re-plan it at a fresh nonce and pay it twice. `strict_fulfill` therefore takes that
address as a read-only account and refuses the quote with `AlreadyFulfilled` unless the account is
empty. Nothing creates an account there any more, so it is empty for every new quote, and
prefunding it does not change that: only a program-owned account has data. The legacy check can
be dropped in a later upgrade. The old markers' rent (about 0.46 SOL on mainnet) stays locked, as
the program has no instruction to close them.

On top of that it keeps the shared `replay` crate (`crates/replay/`) for nonce-based timing
protection, scoped by `settler` and replay bucket selector. The handler calls
`replay::check_replay()` via a local wrapper in `utils/replay.rs` that maps `ReplayError` → `ErrorCode`.

| Coordinate / Constant | Value                       | Notes                      |
| --------------------- | --------------------------- | -------------------------- |
| `slot`                | `nonce & 0xFF`              | Must be `< 235`            |
| `bucket_selector`     | `nonce.to_le_bytes()[4..8]` | PDA shard selector         |
| `REPLAY_HORIZON_SECS` | `128`                       | Strict replay horizon      |
| `REPLAY_SLICE_SECS`   | `256`                       | Length of one time slice   |
| `replay_slice`        | `issued_at >> 8`            | Drives parity + epoch      |
| parity                | `replay_slice & 1`          | Selects one of two bitmaps |
| epoch                 | `replay_slice & 0xFFFFF`    | 20-bit wrapped epoch       |

**PDA Seeds:** `["replay", settler, nonce[4..8]]`

## ReplayBucket

| Field     | Type            | Size | Description                        |
| --------- | --------------- | ---- | ---------------------------------- |
| `bitmaps` | `[[u64; 4]; 2]` | 64   | Two parity bitmaps (256 bits each) |

**Total:** 72 bytes (includes 8-byte discriminator)

Control metadata is packed in `bitmaps[parity][3]`:

| Location   | Purpose                 |
| ---------- | ----------------------- |
| bit 63     | Initialization sentinel |
| bits 43-62 | 20-bit epoch            |

## strict_fulfill Guard Order

| Step | Check                                               | Error on failure                   |
| ---- | --------------------------------------------------- | ---------------------------------- |
| 1    | `amount > 0`                                        | `AmountCannotBeZero`               |
| 2    | `now <= deadline`                                   | `DeadlineExpired`                  |
| 3    | `deadline >= issued_at`                             | `InconsistentTimestamps`           |
| 4    | `now >= issued_at`                                  | `FutureTransaction`                |
| 5    | `now <= issued_at + 128`                            | `ExpiredTransaction`               |
| 6    | `deadline <= issued_at + 128`                       | `DeadlineTooFarInFuture`           |
| 7    | `(nonce & 0xFF) < 235`                              | `InvalidSlot`                      |
| 8    | Slot bit not already marked in the slice's own or the adjacent slice's bitmap | `AlreadyFulfilled` |
| 9    | Mark replay bit, then transfer tokens               | Emits `StrictFulfilled` on success |

## Error Codes

Written from the committed IDL by `pnpm run gen:error-tables` in
`contracts/svm/bindings/typescript/escrow-encoding`, and checked in CI.

<!-- BEGIN GENERATED ERROR TABLE -->

| Code | Name | Message |
| --- | --- | --- |
| `6000` | `Unauthorized` | Caller is not authorized for this operation |
| `6001` | `AlreadyInitialized` | Protocol already initialized |
| `6002` | `ProtocolPaused` | Protocol is paused |
| `6003` | `AdminTransferNotReady` | Admin transfer not ready - delay not elapsed |
| `6004` | `DeadlineExpired` | The authorization deadline has passed |
| `6005` | `DeadlineTooFarInFuture` | The authorization deadline is beyond the replay window |
| `6006` | `FutureTransaction` | The authorization is stamped in the future |
| `6007` | `ExpiredTransaction` | The authorization is older than the replay window, so nonce reuse can no longer be detected |
| `6008` | `InvalidSlot` | The nonce maps to a slot outside the replay bitmap |
| `6009` | `InvalidData` | Reserved, not raised |
| `6010` | `AlreadyFulfilled` | This quote has already been strictly fulfilled |
| `6011` | `CapacityExceeded` | Reserved, not raised |
| `6012` | `UnauthorizedSettler` | Settler is not authorized to strictly fulfill |
| `6013` | `QuoteHashCannotBeEmpty` | Quote hash must not be empty |
| `6014` | `AmountCannotBeZero` | The fulfillment amount must be greater than zero |
| `6015` | `InconsistentTimestamps` | The authorization's deadline is before its issued_at, or its replay horizon overflows |
| `6016` | `AuthorizedSettlerListFull` | The authorized settler list is full |
| `6017` | `TimestampOverflow` | A timestamp calculation overflowed |
| `6018` | `NonExactTransfer` | Recipient did not receive the exact fulfillment amount |

<!-- END GENERATED ERROR TABLE -->

### One code, several conditions

`AlreadyFulfilled` is raised three ways and they are **not** interchangeable: this settler's
strict-fulfillment marker is set, the legacy marker for the quote is set (it was paid under the
previous build), or a nonce is already inside the replay window. The marker is keyed on
`quote_hash` and `settler`, the replay bucket on `settler` and the nonce bucket, so they share only
the settler. A nonce already burned by a different quote from the same settler raises this for a
quote that was never fulfilled.

Read this settler's marker account for the quote and the legacy marker account to tell them apart.
Either set means the quote is paid. Both absent means a replay-slot collision, and the quote
should be re-planned at a fresh nonce.

This program maps `replay::ReplayError::DuplicateTransaction` onto `AlreadyFulfilled` rather than
onto a `DuplicateTransaction` of its own, which is where it deliberately differs from escrow: escrow
has no fulfilment marker to disambiguate against.

`InvalidData` and `CapacityExceeded` are reserved and raised by nothing. Their conditions moved to
`AmountCannotBeZero`, `InconsistentTimestamps`, `AuthorizedSettlerListFull` and `TimestampOverflow`.
They stay declared so the codes after them do not move.

## Events

### Fulfilled (`fulfill` only)

| Field        | Type       |
| ------------ | ---------- |
| `quote_hash` | `[u8; 32]` |
| `to`         | `Pubkey`   |
| `token`      | `Pubkey`   |
| `amount`     | `u64`      |

### StrictFulfilled (`strict_fulfill` only)

| Field        | Type       |
| ------------ | ---------- |
| `quote_hash` | `[u8; 32]` |
| `to`         | `Pubkey`   |
| `token`      | `Pubkey`   |
| `amount`     | `u64`      |
| `nonce`      | `u64`      |
| `issued_at`  | `u64`      |
| `deadline`   | `u64`      |

## TypeScript: Derive Replay Bucket

```typescript
function deriveReplayBucket(
  nonce: anchor.BN,
  settler: PublicKey
): [PublicKey, number] {
  const bucketSelector = nonce.toBuffer("le", 8).slice(4, 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("replay"), settler.toBuffer(), bucketSelector],
    PROGRAM_ID
  );
}
```

For replay algorithm details, see [Replay Protection](../architecture/replay-protection.md).
