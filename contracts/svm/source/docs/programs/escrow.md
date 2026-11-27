# Escrow Program

The Escrow program manages the escrow lifecycle, enabling multi-party authorization for fund release
or refund based on off-chain Ed25519 signatures.

**Program ID:** `F9mjwmRfYWVUJPwSm3ygG7c9Pq2JF2eqpHC6MpVffV85`

## Protocol Configuration

### initialize_protocol

Creates the global `ProtocolConfig` PDA. Only callable by program upgrade authority.

| Parameter                     | Type       | Description                               |
| ----------------------------- | ---------- | ----------------------------------------- |
| `default_admin`               | `Pubkey`   | Admin role key                            |
| `token_config_authority`      | `Pubkey`   | Mint config role key                      |
| `treasurer`                   | `Pubkey`   | Fee recipient                             |
| `pauser`                      | `Pubkey`   | Pause authority                           |
| `cluster_id`                  | `[u8; 32]` | 32-byte signing-domain cluster identifier |
| `default_admin_delay_seconds` | `u32`      | Admin transfer delay                      |

| Account           | Type    | Mut | Description                               |
| ----------------- | ------- | --- | ----------------------------------------- |
| `protocol_config` | PDA     | Yes | Created config account                    |
| `authority`       | Signer  | Yes | Program upgrade authority (pays for rent) |
| `program_data`    | Account |     | Program data account                      |
| `program`         | Program |     | Escrow program (executable validation)    |
| `system_program`  | Program |     | System program                            |

`cluster_id` is stored on `ProtocolConfig` and used as part of the escrow signature domain.
`signature_domain_version` is written by the program during initialization and is not admin supplied.

### pause / unpause

Pauses or resumes protocol operations. Only callable by pauser role.

| Account           | Type   | Mut | Description                         |
| ----------------- | ------ | --- | ----------------------------------- |
| `protocol_config` | PDA    | Yes | Protocol config                     |
| `pauser`          | Signer |     | Must match `protocol_config.pauser` |

### set_token_config_authority / set_treasurer / set_pauser

Updates role keys. Only callable by default_admin.

| Parameter | Type     | Description      |
| --------- | -------- | ---------------- |
| `new_key` | `Pubkey` | New role address |

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

## Mint Configuration

### allow_mint

Adds a mint to the allowlist with zero fees. Rejects Token-2022 mints whose TransferFeeConfig can charge a fee (nonzero basis points and nonzero maximum fee) in `newer_transfer_fee`, or in `older_transfer_fee` while it is still in force (the current epoch is before `newer_transfer_fee.epoch`), mints that carry the `PermanentDelegate` extension (`PermanentDelegateMintNotAllowed`), mints that carry any extension outside the accepted set in `architecture/security.md` (`MintExtensionNotAllowed`), and mints whose extension list the program cannot read. `set_mint_fee_config` and `deposit` run the same checks.

| Account                  | Type    | Mut | Description                                                 |
| ------------------------ | ------- | --- | ----------------------------------------------------------- |
| `protocol_config`        | PDA     |     | Protocol config                                             |
| `mint_fee_config`        | PDA     | Yes | Created fee config account                                  |
| `mint_account`           | Mint    |     | Token mint to allow                                         |
| `token_config_authority` | Signer  | Yes | Must match `protocol_config.token_config_authority` (payer) |
| `token_program`          | Program |     | SPL Token program                                           |
| `system_program`         | Program |     | System program                                              |

### disallow_mint

Removes a mint from allowlist. Existing deposits remain releasable/refundable.

| Account                  | Type   | Mut | Description                                                       |
| ------------------------ | ------ | --- | ----------------------------------------------------------------- |
| `protocol_config`        | PDA    |     | Protocol config                                                   |
| `mint_fee_config`        | PDA    | Yes | Fee config to close                                               |
| `token_config_authority` | Signer | Yes | Must match `protocol_config.token_config_authority` (rent refund) |

### set_mint_fee_config

Configures fee parameters for an allowlisted mint.

| Parameter          | Type  | Description                          |
| ------------------ | ----- | ------------------------------------ |
| `fee_percentage_6` | `u64` | Fee % × 1e6 (max 100_000_000 = 100%) |
| `min_fee_6`        | `u64` | Min fee in 6-decimal units           |
| `max_fee_6`        | `u64` | Max fee in 6-decimal units           |

| Account                  | Type    | Mut | Description                                         |
| ------------------------ | ------- | --- | --------------------------------------------------- |
| `protocol_config`        | PDA     |     | Protocol config                                     |
| `mint_fee_config`        | PDA     | Yes | Fee config to update                                |
| `mint_account`           | Mint    |     | Token mint (for Token-2022 validation)              |
| `token_config_authority` | Signer  |     | Must match `protocol_config.token_config_authority` |
| `token_program`          | Program |     | SPL Token program                                   |

### clear_mint_fee_config

Resets fee parameters to zero. Mint stays allowlisted.

| Account                  | Type   | Mut | Description                                         |
| ------------------------ | ------ | --- | --------------------------------------------------- |
| `protocol_config`        | PDA    |     | Protocol config                                     |
| `mint_fee_config`        | PDA    | Yes | Fee config to clear                                 |
| `token_config_authority` | Signer |     | Must match `protocol_config.token_config_authority` |

## Delegate Instructions

### create_delegate

Creates an `EscrowDelegate` account and approves SPL token delegation to the delegate PDA.

| Parameter            | Type     | Description                                      |
| -------------------- | -------- | ------------------------------------------------ |
| `delegate_signer`    | `Pubkey` | Off-chain keypair that will sign deposits        |
| `remaining_capacity` | `u64`    | Maximum total tokens that can be deposited       |
| `max_transfer_size`  | `u64`    | Maximum tokens per single deposit                |
| `expiration`         | `u64`    | Unix timestamp after which deposits are rejected |

| Account                    | Type    | Mut | Description                            |
| -------------------------- | ------- | --- | -------------------------------------- |
| `protocol_config`          | PDA     |     | Protocol config (pause check)          |
| `authority`                | Signer  |     | Owner of the funds                     |
| `escrow_delegate`          | PDA     | Yes | Created delegate account               |
| `mint_fee_config`          | PDA     |     | Must exist; proves mint is allowlisted |
| `authority_ata`            | ATA     | Yes | Authority's token account              |
| `mint`                     | Mint    |     | Token mint for deposits                |
| `payer`                    | Signer  | Yes | Pays for account creation              |
| `token_program`            | Program |     | SPL Token program                      |
| `associated_token_program` | Program |     | Associated Token program               |
| `system_program`           | Program |     | System program                         |

### renounce_delegate

Allows the delegate signer to immediately disable the lane by setting `remaining_capacity = 0` and
`expiration = now`. Does not close the account or revoke SPL token approval.

| Account           | Type   | Mut | Description                   |
| ----------------- | ------ | --- | ----------------------------- |
| `protocol_config` | PDA    |     | Protocol config (pause check) |
| `escrow_delegate` | PDA    | Yes | The delegate account          |
| `delegate_signer` | Signer |     | Must match delegate's signer  |

### revoke_delegate

Allows the authority to revoke delegation, close the account, and refund rent.

| Account           | Type    | Mut | Description                   |
| ----------------- | ------- | --- | ----------------------------- |
| `protocol_config` | PDA     |     | Protocol config (pause check) |
| `escrow_delegate` | PDA     | Yes | The delegate account to close |
| `authority`       | Signer  |     | Must match delegate authority |
| `authority_ata`   | ATA     | Yes | Authority's token account     |
| `payer`           | Signer  | Yes | Receives rent refund          |
| `token_program`   | Program |     | SPL Token program             |

## Escrow Instructions

### Signature Domain

All escrow messages use the same domain-separated hash format:

`keccak(b"escrow", [signature_domain_version], cluster_id, program_id, action, payload...)`

Clients should fetch `ProtocolConfig` and compose messages using:

- `cluster_id`
- `signature_domain_version`
- the escrow program ID

This binds signatures to a specific deployment and schema version.

#### Signed text

Signers do not sign the 32-byte hash directly. Each instruction requires the Ed25519 instruction
immediately before it to carry a valid signature over the escrow text for its own label:

`<label> <base64url-nopad(hash)>`

| Instruction | Label             | Signer            |
| ----------- | ----------------- | ----------------- |
| `deposit`   | `atum deposit v1` | `delegate_signer` |
| `reserve`   | `atum reserve v1` | `reserver`        |
| `release`   | `atum release v1` | `releaser`        |
| `refund`    | `atum refund v1`  | `releaser`        |

The text is printable ASCII: the label, one space, then 43 base64url characters with no padding
and no trailing newline. The program accepts the signed message in exactly one of three forms and
compares it byte for byte:

| Form   | Bytes                                                                                     |
| ------ | ----------------------------------------------------------------------------------------- |
| bare   | the text                                                                                  |
| `v1`   | `ff "solana offchain"` ‖ `01` (version) ‖ `01` (signer count) ‖ signer pubkey ‖ text        |
| `v0`   | `ff "solana offchain"` ‖ `00` (version) ‖ 32 zero bytes (application domain) ‖ `00` (format) ‖ `01` (signer count) ‖ signer pubkey ‖ `u16le(len(text))` ‖ text |

`bare` is what a wallet's `signMessage` signs. `v1` and `v0` are the off-chain message envelopes
produced by `signOffchainMessage` and by hardware wallets (Ledger Solana app 1.16 or later, since
1.15 writes an extra `u16` length in `v1`, which the program refuses). The signer
pubkey inside an envelope must be the expected signer. The Ed25519 instruction's pubkey offset is
not constrained, so an envelope instruction may point it at the pubkey inside the message. Any
other message, including the bare 32-byte hash, fails with `InvalidMessage`.

`contracts/svm/bindings/{go,typescript}/escrow-encoding` build the text and the three forms
(`EscrowText` / `EscrowMessage`, and in TypeScript `escrowEd25519Instruction` for the instruction
data); `contracts/svm/conformance/signed-text.json` holds the shared vectors, pinned in
`signatures.rs` module `signed_text_tests`.

#### This document is not the source of truth

Off-chain signers (notably `atum-core:contracts/svm/bindings/{go,typescript}`) must not be
validated against this page alone. A doc and an implementation can drift, and when they do every
off-chain side agrees on a hash the program rejects.

The normative oracle is `programs/escrow/src/utils/signatures.rs`, module `hash_anchor_tests`:
pinned digests for all four legs (deposit / reserve / release / refund), each hand-derived out of
band from the byte layout with an independent Keccak-256 and asserted against the real
`compute_*_hash`. atum-core pins the same hex strings, so both repositories are tied to values
neither one generated. They run in CI (the `SVM contracts (anchor)` job in `.github/workflows/ci.yml`, step "Rust unit tests").

If an anchor test goes red, the correct response is to re-derive out of band — never to paste in
the newly computed value.

Exact preimage sizes, for cross-checking an encoder: reserve 182 bytes, release 142, refund 141
(note `b"refund"` is 6 bytes where `b"reserve"`/`b"release"` are 7), deposit 302. `quote_hash` is
the last field on release and refund, comes before `source_amount` (the last field) on reserve, and
is **absent** from the deposit preimage. The preimage lengths are pinned by
`preimage_lengths_are_pinned` in `signatures.rs`.

### deposit

Creates a new escrow deposit, authorized by the delegate signer via Ed25519 signature. Requires
`protocol_config` (blocked when paused) and `mint_fee_config`. Stores computed `fee_amount` in the
deposit.

| Parameter              | Type       | Description                                                 |
| ---------------------- | ---------- | ----------------------------------------------------------- |
| `deposit_request_hash` | `[u8; 32]` | Depositor-signed commitment to the offchain deposit request (non-zero) |
| `destination_hash`     | `[u8; 32]` | `keccak256(destination)`, must be non-zero                  |
| `amount`               | `u64`      | Token amount to deposit                                     |
| `reserver`             | `Pubkey`   | Entity authorized to reserve                                |
| `releaser`             | `Pubkey`   | Entity authorized to release                                |
| `nonce`                | `u64`      | Replay protection nonce                                     |
| `issued_at`            | `u64`      | Signature timestamp                                         |
| `deadline`             | `u64`      | Transaction deadline                                        |
| `deposit_hash`         | `[u8; 32]` | Keccak hash of deposit message                              |

The destination string never reaches the program. Clients hash it off chain and enforce its rules
first: non-empty and at most 256 bytes (`ValidateAndHashDestination` / `validateAndHashDestination` in
the escrow-encoding bindings). `DestinationTooLong` (`6036`) is kept in the error table but is not
raised.

| Account                    | Type             | Mut | Description                   |
| -------------------------- | ---------------- | --- | ----------------------------- |
| `protocol_config`          | PDA              |     | Protocol config (pause check) |
| `mint_fee_config`          | PDA              |     | Fee config for mint           |
| `escrow_delegate`          | PDA              | Yes | Delegate authorizing deposit  |
| `authority`                | UncheckedAccount |     | The depositor                 |
| `replay_bucket`            | PDA              | Yes | Replay protection bucket      |
| `authority_ata`            | ATA              | Yes | Source of tokens              |
| `deposit`                  | PDA              | Yes | Created deposit account       |
| `escrow_ata`               | ATA              | Yes | Escrow token account          |
| `mint`                     | Mint             |     | Token mint                    |
| `payer`                    | Signer           | Yes | Pays for account creation     |
| `token_program`            | Program          |     | SPL Token program             |
| `associated_token_program` | Program          |     | Associated Token program      |
| `system_program`           | Program          |     | System program                |
| `instructions`             | Sysvar           |     | For Ed25519 verification      |

**Payload:** `deposit_request_hash, destination_hash, depositor, mint, amount, reserver, releaser, nonce, issued_at, deadline`

### reserve

Sets the recipient for an existing deposit via Ed25519 signature from reserver. Requires
`protocol_config` (blocked when paused).

| Parameter    | Type       | Description                                                                        |
| ------------ | ---------- | ---------------------------------------------------------------------------------- |
| `recipient`  | `Pubkey`   | Recipient address                                                                  |
| `quote_hash` | `[u8; 32]` | Offchain quote hash (non-zero); stored on the deposit and attested by the reserver |
| `source_amount` | `u64` | Amount charged for the winning quote; must be non-zero and at most the deposit amount. It becomes the deposit's amount, and the stored fee is rescaled to it |

| Account           | Type   | Mut | Description                   |
| ----------------- | ------ | --- | ----------------------------- |
| `protocol_config` | PDA    |     | Protocol config (pause check) |
| `deposit`         | PDA    | Yes | The deposit being reserved    |
| `instructions`    | Sysvar |     | For Ed25519 verification      |

**Payload:** `recipient, deposit_hash, quote_hash, source_amount`

### release

Releases funds to the recipient and closes the deposit. Requires Ed25519 signature from releaser.
Requires `protocol_config` (blocked when paused). Settlement is exact to `deposit.amount`:

- recipient receives `deposit.amount - fee_amount`
- treasury receives `fee_amount`
- any live escrow surplus above `deposit.amount` is returned to the original depositor, after a
  memo so a depositor ATA that requires incoming memos still accepts it
- if the depositor ATA cannot take a plain credit (frozen, or confidential transfers with
  non-confidential credits disabled), the surplus goes to the treasury instead and the program logs
  it, so the payout never depends on the depositor's account

`depositor_ata` is checked by address against the depositor's canonical ATA for the mint and token
program, not by its token owner, and is created when missing. A classic SPL account's owner can be
reassigned by the depositor, which would otherwise make the release fail validation.

For a mint with a transfer hook program, the hook's validation account, its extra accounts and the
hook program go in `remaining_accounts`; every transfer forwards them. A signer among them other than
the transfer authority fails with `HookAccountSignerNotAllowed`, since the hook would receive it able
to sign.

| Account                    | Type             | Mut | Description                      |
| -------------------------- | ---------------- | --- | -------------------------------- |
| `protocol_config`          | PDA              |     | Protocol config (pause check)    |
| `deposit`                  | PDA              | Yes | The deposit being released       |
| `escrow_ata`               | ATA              | Yes | Source of funds                  |
| `recipient`                | UncheckedAccount |     | Recipient address                |
| `recipient_ata`            | ATA              | Yes | Recipient's canonical ATA        |
| `depositor`                | UncheckedAccount |     | Original depositor               |
| `depositor_ata`            | UncheckedAccount | Yes | Depositor ATA, checked by address |
| `treasurer`                | UncheckedAccount |     | Treasury address                 |
| `treasury_ata`             | ATA              | Yes | Treasury token account for fee   |
| `mint`                     | Mint             |     | Token mint                       |
| `payer`                    | Signer           | Yes | Receives rent refund             |
| `token_program`            | Program          |     | SPL Token program                |
| `associated_token_program` | Program          |     | Associated Token program         |
| `system_program`           | Program          |     | System program                   |
| `instructions`             | Sysvar           |     | For Ed25519 verification         |
| `memo_program`             | Program          |     | SPL Memo before depositor credit |

**Payload:** `deposit_hash, quote_hash`

### refund

Returns funds to the depositor and closes the deposit. Requires Ed25519 signature from releaser.
Requires `protocol_config` (blocked when paused). Refunds the full live escrow balance (no fee
deducted), so extra donated tokens are drained back to the depositor instead of getting stuck.
A memo precedes the transfer, and `depositor_ata` is checked by address as in `release`. A depositor
ATA that refuses plain credits makes the refund revert until the depositor re-enables them, since
the funds are the depositor's.

| Account                    | Type             | Mut | Description                   |
| -------------------------- | ---------------- | --- | ----------------------------- |
| `protocol_config`          | PDA              |     | Protocol config (pause check) |
| `deposit`                  | PDA              | Yes | The deposit being refunded    |
| `escrow_ata`               | ATA              | Yes | Source of funds               |
| `depositor`                | UncheckedAccount |     | Depositor address             |
| `depositor_ata`            | UncheckedAccount | Yes | Checked by address            |
| `mint`                     | Mint             |     | Token mint                    |
| `payer`                    | Signer           | Yes | Receives rent refund          |
| `token_program`            | Program          |     | SPL Token program             |
| `associated_token_program` | Program          |     | Associated Token program      |
| `system_program`           | Program          |     | System program                |
| `instructions`             | Sysvar           |     | For Ed25519 verification      |
| `memo_program`             | Program          |     | SPL Memo before the credit    |

**Payload:** `deposit_hash, quote_hash`

A refund of a deposit that was never reserved signs over a zero `quote_hash` (the deposit's
`quote_hash` stays zero until `reserve`). Offchain consumers should treat a zero `quote_hash` on
refund as "never reserved."

## Account Structures

### ProtocolConfig

Global singleton holding protocol settings and role keys.

| Field                                   | Type             | Description                          |
| --------------------------------------- | ---------------- | ------------------------------------ |
| `default_admin`                         | `Pubkey`         | Admin role key                       |
| `token_config_authority`                | `Pubkey`         | Mint config role key                 |
| `treasurer`                             | `Pubkey`         | Fee recipient                        |
| `pauser`                                | `Pubkey`         | Pause authority                      |
| `paused`                                | `bool`           | Protocol pause state                 |
| `cluster_id`                            | `[u8; 32]`       | Deployment-specific signing domain   |
| `signature_domain_version`              | `u8`             | Message schema version for signing   |
| `pending_default_admin`                 | `Option<Pubkey>` | Pending admin for transfer           |
| `pending_default_admin_accept_after_ts` | `Option<i64>`    | Unix timestamp when transfer allowed |
| `default_admin_delay_seconds`           | `u32`            | Delay for admin transfers            |

**PDA Seeds:** `[b"protocol_config"]`

### MintFeeConfig

Fee configuration for an allowlisted mint.

| Field              | Type     | Description                   |
| ------------------ | -------- | ----------------------------- |
| `mint`             | `Pubkey` | Token mint                    |
| `fee_percentage_6` | `u64`    | Fee % × 1e6 (max 100_000_000) |
| `min_fee_6`        | `u64`    | Min fee in 6-decimal units    |
| `max_fee_6`        | `u64`    | Max fee in 6-decimal units    |

**PDA Seeds:** `[b"mint_fee_config", mint]`

### EscrowDelegate

| Field                | Type     | Description                |
| -------------------- | -------- | -------------------------- |
| `authority`          | `Pubkey` | Owner of funds             |
| `delegate_signer`    | `Pubkey` | Authorized signer          |
| `max_transfer_size`  | `u64`    | Max per-deposit amount     |
| `remaining_capacity` | `u64`    | Remaining deposit capacity |
| `expiration`         | `u64`    | Expiration timestamp       |
| `allowed_mint`       | `Pubkey` | Token mint                 |

**PDA Seeds:** `[b"escrow_delegate", authority, mint]`

### DepositInfo

| Field          | Type             | Description                                                                    |
| -------------- | ---------------- | ------------------------------------------------------------------------------ |
| `depositor`    | `Pubkey`         | Original depositor                                                             |
| `mint`         | `Pubkey`         | Token mint                                                                     |
| `amount`       | `u64`            | Deposited amount                                                               |
| `fee_amount`   | `u64`            | Fee computed at deposit time                                                   |
| `reserver`     | `Pubkey`         | Reserved recipient setter                                                      |
| `releaser`     | `Pubkey`         | Release/refund authorizer                                                      |
| `recipient`    | `Option<Pubkey>` | Set when reserved                                                              |
| `deposit_hash` | `[u8; 32]`       | Deposit message hash                                                           |
| `quote_hash`   | `[u8; 32]`       | Offchain quote hash; set by the reserver at reserve time (zero until reserved) |

**PDA Seeds:** `[b"deposit", deposit_hash]`

### ReplayBucket

| Field     | Type            | Description         |
| --------- | --------------- | ------------------- |
| `bitmaps` | `[[u64; 4]; 2]` | Two 256-bit bitmaps |

**PDA Seeds:** `[b"replay", authority, nonce[4..8]]`

## Error Codes

Written from the committed IDL by `pnpm run gen:error-tables` in
`contracts/svm/bindings/typescript/escrow-encoding`, and checked in CI. Anchor assigns codes by declaration
order and variants are only ever appended, so a code here is stable for the life of the program.

It tracks the committed IDL rather than whatever is deployed. A revert from a build older than this
one can carry a code whose message has since changed, which is why the reserved codes below stay
declared.

<!-- BEGIN GENERATED ERROR TABLE -->

| Code | Name | Message |
| --- | --- | --- |
| `6000` | `Unauthorized` | Not authorized: the signer, a supplied account, or the program's authority state is not what this instruction requires |
| `6001` | `RecipientAlreadySet` | Recipient has already been set |
| `6002` | `QuoteHashCannotBeEmpty` | Offchain quote hash cannot be empty |
| `6003` | `RecipientNotSet` | Recipient has not been set |
| `6004` | `MissingSignatureVerification` | Missing Ed25519 signature verification instruction |
| `6005` | `InvalidVerificationInstruction` | The preceding instruction is not a single-signature Ed25519 verification with in-instruction data |
| `6006` | `InvalidPublicKey` | The public key is unset or does not match the signer this check expects |
| `6007` | `InvalidMessage` | The signed message does not match the message this check expects |
| `6008` | `InvalidData` | Reserved, not raised |
| `6009` | `InvalidAuthority` | Reserved, not raised |
| `6010` | `InvalidCaller` | Reserved, not raised |
| `6011` | `Expired` | The delegate expiration is in the past |
| `6012` | `CapacityExceeded` | The requested amount exceeds the delegate's remaining capacity |
| `6013` | `InvalidMint` | Invalid mint address |
| `6014` | `DeadlineExpired` | The authorization deadline has passed |
| `6015` | `TransferSizeExceeded` | The requested amount exceeds the delegate's per-transfer maximum |
| `6016` | `InvalidRevoker` | Reserved, not raised |
| `6017` | `AmountMustBeGreaterThanZero` | The deposit amount must be greater than zero |
| `6018` | `DeadlineTooFarInFuture` | The authorization deadline is beyond the replay window |
| `6019` | `FutureTransaction` | The authorization is stamped in the future |
| `6020` | `ExpiredTransaction` | The authorization is older than the replay window, so nonce reuse can no longer be detected |
| `6021` | `InvalidSlot` | The nonce maps to a slot outside the replay bitmap |
| `6022` | `DuplicateTransaction` | This nonce has already been used inside the replay window |
| `6023` | `AlreadyInitialized` | Protocol already initialized |
| `6024` | `ProtocolPaused` | Protocol is paused |
| `6025` | `AdminTransferNotReady` | Admin transfer not ready - delay not elapsed |
| `6026` | `MintNotAllowed` | Mint not in allowlist |
| `6027` | `TransferFeeMintNotAllowed` | Transfer-fee mints are not allowed |
| `6028` | `FeePercentageTooHigh` | Fee percentage exceeds 100% |
| `6029` | `MinFeeGreaterThanMaxFee` | Minimum fee cannot exceed maximum fee |
| `6030` | `MaxFeeSetButPercentageZero` | Maximum fee requires non-zero percentage |
| `6031` | `FeeExceedsAmount` | Computed fee exceeds deposit amount |
| `6032` | `NonExactTransfer` | Transfer amount mismatch - exact transfer required |
| `6033` | `InsufficientEscrowBalance` | Escrow balance insufficient for intended release amount |
| `6034` | `DepositRequestHashCannotBeEmpty` | The depositor-signed deposit-request commitment cannot be zero |
| `6035` | `DestinationEmpty` | The committed destination hash cannot be zero |
| `6036` | `DestinationTooLong` | Not raised by this program: the 256-byte destination limit is enforced off chain |
| `6037` | `AmountCannotBeZero` | The reserved source amount cannot be zero |
| `6038` | `SourceAmountExceedsDeposit` | The reserved source amount exceeds the amount the depositor authorized |
| `6039` | `MinFeeNotRepresentable` | Minimum fee is not representable in this mint's decimals |
| `6040` | `MaxFeeNotRepresentable` | Maximum fee is not representable in this mint's decimals |
| `6041` | `MalformedSignatureData` | The signature verification instruction's offsets or lengths fall outside its data |
| `6042` | `FeeArithmeticFailed` | The fee could not be rescaled: the deposit amount was zero, or the arithmetic overflowed |
| `6043` | `RoleAccountNotSet` | A required role account was left unset |
| `6044` | `DepositHashMismatch` | The recomputed deposit hash does not match the one this deposit was created with |
| `6045` | `DelegateLimitsInvalid` | The delegate's capacity and per-transfer limits are zero or inconsistent |
| `6046` | `InconsistentTimestamps` | The authorization's deadline is before its issued_at, or its replay horizon overflows |
| `6047` | `TimestampOverflow` | A timestamp calculation overflowed |
| `6048` | `SignatureMessageSizeInvalid` | The signed message is not 32 bytes |
| `6049` | `InvalidDepositorAta` | Depositor token account is not the depositor's associated token account |
| `6050` | `PermanentDelegateMintNotAllowed` | Mints with a permanent delegate are not allowed |
| `6051` | `MintExtensionNotAllowed` | The mint carries a Token-2022 extension the escrow does not accept |
| `6052` | `HookAccountSignerNotAllowed` | A transfer hook account other than the transfer authority is a signer |

<!-- END GENERATED ERROR TABLE -->

### One code, several conditions

`InvalidData` used to cover twenty-two raise sites. Each now has its own code:
`MalformedSignatureData` (Ed25519 offsets outside the instruction data), `FeeArithmeticFailed`, `RoleAccountNotSet`,
`DepositHashMismatch`, `DelegateLimitsInvalid` and `InconsistentTimestamps`.

`CapacityExceeded` used to carry the fee and timestamp arithmetic too. Those moved to
`FeeArithmeticFailed` and `TimestampOverflow`, so it now means only what its message says.

Five codes are reserved and raised by nothing: `InvalidData`, `InvalidAuthority`, `InvalidCaller`,
`InvalidRevoker` and `SignatureMessageSizeInvalid`. `Unauthorized` covers the three authority conditions,
and `InvalidMessage` covers every signed message that is not the expected escrow text. They stay declared so the
codes after them do not move, and so a client decoding an older transaction still resolves the name.

## Events

### Protocol Administration

| Event                         | Fields                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ProtocolInitialized`         | `default_admin`, `token_config_authority`, `treasurer`, `pauser`, `cluster_id`, `signature_domain_version`, `default_admin_delay_seconds` |
| `DefaultAdminTransferBegun`   | `current_admin`, `pending_admin`, `accept_after_ts`                                                                                       |
| `DefaultAdminTransferred`     | `old_admin`, `new_admin`                                                                                                                  |
| `Paused`                      | `by`                                                                                                                                      |
| `Unpaused`                    | `by`                                                                                                                                      |
| `TokenConfigAuthorityUpdated` | `old_authority`, `new_authority`                                                                                                          |
| `TreasurerUpdated`            | `old_treasurer`, `new_treasurer`                                                                                                          |
| `PauserUpdated`               | `old_pauser`, `new_pauser`                                                                                                                |
| `DefaultAdminDelayUpdated`    | `old_delay_seconds`, `new_delay_seconds`                                                                                                  |

### Token Configuration

| Event             | Fields                                               |
| ----------------- | ---------------------------------------------------- |
| `MintAllowed`     | `mint`                                               |
| `MintDisallowed`  | `mint`                                               |
| `MintFeesUpdated` | `mint`, `fee_percentage_6`, `min_fee_6`, `max_fee_6` |
| `MintFeesCleared` | `mint`                                               |

### Delegation

| Event               | Fields                                     |
| ------------------- | ------------------------------------------ |
| `DelegateRevoked`   | `authority`, `delegate`, `delegate_signer` |
| `DelegateRenounced` | `authority`, `delegate`, `delegate_signer` |

### Escrow Lifecycle

| Event       | Fields                                                                                                                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Deposited` | `deposit_hash`, `depositor`, `reserver`, `releaser`, `amount`, `fee_amount`, `nonce`, `issued_at`, `deadline`              |
| `Reserved`  | `deposit_hash`, `recipient`, `quote_hash`                                                                                  |
| `Released`  | `deposit_hash`, `quote_hash`, `recipient`, `gross_amount`, `intended_amount`, `surplus_amount`, `fee_amount`, `net_amount` |
| `Refunded`  | `deposit_hash`, `quote_hash`, `depositor`, `amount`                                                                        |

## Related Documentation

- [Architecture Overview](../architecture/overview.md)
- [Security Model](../architecture/security.md)
- [Replay Protection](../architecture/replay-protection.md)
- [PDA Support](../architecture/pda-support.md)
