# Security Model

## Protocol Roles

| Program           | Role                   | Holder        | Capabilities                         |
| ----------------- | ---------------------- | ------------- | ------------------------------------ |
| Escrow            | default_admin          | Multisig      | Rotate role keys, admin transfer     |
| Escrow            | token_config_authority | Multisig      | Mint allowlist, fee config           |
| Escrow            | treasurer              | Utila account | Fee recipient (no signing needed)    |
| Escrow            | pauser                 | Hypernative   | Pause/unpause escrow operations      |
| Fulfillment Proxy | default_admin          | Multisig      | Rotate pauser key, admin transfer    |
| Fulfillment Proxy | pauser                 | Hypernative   | Pause/unpause fulfillment operations |

Role keys stored in each program's `ProtocolConfig` PDA. Equality checks for O(1) verification.

## Pause Mechanism

### Escrow — Blocked When Paused

- create_delegate, revoke_delegate, renounce_delegate
- deposit, reserve, release, refund

### Escrow — Allowed While Paused

- initialize_protocol
- allow_mint, disallow_mint, set_mint_fee_config, clear_mint_fee_config
- set_token_config_authority, set_treasurer, set_pauser
- begin/accept_default_admin_transfer, set_default_admin_delay_seconds

Pauser rotation allowed while paused for recovery.

### Fulfillment Proxy — Blocked When Paused

- fulfill, strict_fulfill

### Fulfillment Proxy — Allowed While Paused

- initialize_protocol, pause, unpause, set_pauser
- begin/accept_default_admin_transfer, set_default_admin_delay_seconds

## Admin Transfer

Two-step process with configurable delay:

1. Current admin calls `begin_default_admin_transfer(new_admin)`
2. After delay, new admin calls `accept_default_admin_transfer()`

## Token Security

| Check                      | Description                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mint allowlist             | Only mints with `MintFeeConfig` PDA can be delegated to and deposited                                                                              |
| Nonzero transfer fee check | Token-2022 mints with a transfer fee slot that can charge, in force or scheduled, are rejected on allow, fee config update and deposit             |
| Mint extension check       | Token-2022 mints are accepted only when every extension is in the accepted set (see "Issuer authorities"), on allow, fee config update and deposit |
| Exact transfer enforcement | Deposited amount must match specified amount exactly                                                                                               |

### Transfer fee mints

Token-2022 mints that carry `TransferFeeConfig` with fees that cannot charge (for example PYUSD and USDG at 0 bps and 0 maximum fee, or AUSD at 0 bps) can be allowlisted. The issuer's fee authority can still schedule a fee, which `set_transfer_fee` always places in `newer_transfer_fee` for the current epoch plus 2. From that moment `deposit` rejects the mint, while `release` and `refund` stay unchecked so open deposits can always settle. The fulfillment proxy rejects any transfer that credits the recipient less than `amount`, so a live fee turns a destination fulfill into a revert instead of a short payment.

A fee change is handled per mint, not with the global pause:

1. Trigger: the mint's monitor (see "Issuer authorities") reports a slot that can charge (nonzero basis points and nonzero maximum fee) before `newer_transfer_fee.epoch`. The program does not watch the mint. Watching for any write is not enough, since `SetTransferFee(0, 0)` also rewrites the config.
2. Before `newer_transfer_fee.epoch`: stop Solana destination fulfills for the mint, release reserved deposits and refund unreserved ones, so every open deposit settles at full value.
3. After the fee is live: a release or refund pays the recipient or depositor short of the event amounts. The choice is then a short payout or leaving the deposit open until the issuer removes the fee.
4. After any fee went live, escrow ATAs can hold withheld fees. `close_account` refuses them, so release and refund revert until someone runs the permissionless `HarvestWithheldTokensToMint` on the escrow ATA. The settler adds it to the release or refund transaction when the escrow ATA holds a withheld amount. Anyone can repeat a dust transfer while a fee is live, so the harvest belongs in the same transaction.

The global pause stays for compromise. Pausing on a fee change would also stop USDC and USDT settlement.

### Transfer hooks

Every escrow and proxy transfer goes through Token-2022's hook aware `transfer_checked`, which forwards the hook's validation account and extra accounts from `remaining_accounts`. AUSD, GBPA, OUSD, PYUSD and USDG carry a transfer hook authority with no hook program today. If the issuer sets one, clients must pass its accounts on every deposit, release, refund and fulfill for the mint, and a hook that refuses transfers stops settlement for that mint until the issuer changes it. On escrow transfers a signer among those accounts other than the transfer authority is refused, see "Issuer authorities". The program does not watch the hook program id.

### Depositor controlled accounts

The depositor owns `depositor_ata` and can change its state after the destination payout:

| State                                                                        | Effect                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RequiredMemoTransfers`                                                      | Handled: the escrow sends a memo immediately before each credit to the depositor                                                                                    |
| Confidential transfers with non-confidential credits disabled, or frozen     | `release` sends the surplus to the treasury instead, so the payout still lands. `refund` reverts until the depositor re-enables credits, since the funds are theirs |
| Owner reassigned (classic SPL only, Token-2022 ATAs have an immutable owner) | Handled: `depositor_ata` is checked by address, not by token owner                                                                                                  |

An extension list the program cannot read counts as refusing plain credits, so an unknown account extension sends the surplus to the treasury rather than risking a reverted release.

### Issuer authorities

`allow_mint`, `set_mint_fee_config` and `deposit` accept a Token-2022 mint only when every extension on it is in the table below. Any other extension is refused with `MintExtensionNotAllowed`, and an unknown extension type or an extension list the program cannot read fails closed. `release` and `refund` do not run the check, so an issuer change never locks an open deposit through it. Allowlisting a mint accepts these issuer powers:

| Extension                                                   | Accepted risk                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TransferFeeConfig`                                         | Only while no slot can charge, see "Transfer fee mints"                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `TransferHook`                                              | A hook set later needs its accounts on every transfer, and a hook that refuses transfers stops settlement for the mint until the issuer changes it. The escrow refuses a signer in `remaining_accounts` other than the transfer authority (`HookAccountSignerNotAllowed`). The fulfillment proxy doesn't check it yet: the check ships with the next proxy deployment. A transaction always marks its fee payer a signer, so without this a hook naming the payer would get its signature. The check reads whether the account signed the transaction, not the flag the hook asks for, so a hook whose list names any such signer, even read only, also stops settlement for the mint                                                                                                                                                                                     |
| `Pausable`                                                  | While the mint is paused, every deposit, release, refund and fulfill in it reverts, so funds stay locked until the issuer unpauses                                                                                                                                                                                                                                                                                                                                                              |
| `MintCloseAuthority`                                        | Closing needs zero supply, so the mint cannot be closed while the escrow holds any of it                                                                                                                                                                                                                                                                                                                                                                                                        |
| `DefaultAccountState`                                       | New token accounts can start frozen. While the default is Frozen every deposit reverts, since each one opens a new escrow account, and a release reverts when it credits a new frozen recipient or treasury account. A new frozen depositor account sends the release surplus to the treasury but makes refund revert until the depositor account exists and is thawed, or the default is no longer Frozen. While the default is Frozen, a fulfill to a recipient with no token account reverts |
| `ConfidentialTransferMint`, `ConfidentialTransferFeeConfig` | Opt in per token account. The escrow never configures its accounts for it, and depositor accounts are covered above. A recipient whose existing account refuses non-confidential credits makes the release to it revert                                                                                                                                                                                                                                                                         |
| `MetadataPointer`, `TokenMetadata`                          | Descriptive data, no power over balances                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

The base mint freeze authority is not an extension and every mint can carry it, USDC included. It can freeze the escrow's token account and stop `release` and `refund` for that deposit.

The programs do not watch the extension powers above. A Token-2022 mint must not be allowlisted until a monitor watches its transfer fee config, hook program id, pause state and default account state, and alerts on any change the table above lists as a risk. On mainnet that monitor is Atum's Token-2022 watch. It reads the escrow's Token-2022 mints and open deposits, and alerts on a fee slot that can charge, a hook program other than the one pinned for the mint, a paused mint and a Frozen default account state, among others. It also alerts when an open deposit's escrow token account holds less than its amount or is frozen, which covers the freeze authority above.

Refused: `PermanentDelegate` (below) and every other extension, for example `NonTransferable`, `InterestBearingConfig`, `ScaledUiAmount`, `ConfidentialMintBurn` and the token group extensions.

### Permanent delegate mints

A mint with the `PermanentDelegate` extension is refused with `PermanentDelegateMintNotAllowed`, or with `MintExtensionNotAllowed` when it also carries another refused extension. Its delegate can transfer or burn from any token account of the mint, the escrow's included, without the escrow's say-so, and `DepositInfo.amount` does not move with it: `release` then fails on an underfunded account and `refund` pays back only what is left. The check looks for the extension, not for who the delegate is. The AUSD, GBPA, OUSD, PYUSD and USDG mainnet mints in `programs/escrow/src/utils/fixtures/` all carry the extension, and every other extension on them is accepted, so the permanent delegate is the only reason they are refused.

## Ed25519 Authorization

| Requirement       | Detail                                                                     |
| ----------------- | -------------------------------------------------------------------------- |
| Instruction order | Ed25519 verify must **directly precede** program instruction (`index - 1`) |
| Data embedding    | Signature, pubkey, message embedded in instruction (indices = `u16::MAX`)  |
| Cross-instruction | References rejected to prevent instruction-index confusion                 |
| Signed message    | Exactly the escrow text for the instruction's label, bare or in a v1/v0 envelope naming the expected signer |

The signer signs `<label> <base64url-nopad(hash)>` with a per-instruction label (`atum deposit v1`,
`atum reserve v1`, `atum release v1`, `atum refund v1`), never the raw hash. The label stops a
signature for one instruction from satisfying another, and printable text cannot be parsed as a
Solana transaction message, so a signer key that only signs this text cannot be made to sign a
transaction. The program compares the signed message byte for byte against the bare text and its
`v1` and `v0` off-chain message envelopes (see `programs/escrow.md`, "Signed text"); anything else,
including the bare 32-byte hash, is `InvalidMessage`.

### Message Binding

All escrow signatures are domain-separated using:

`keccak(b"escrow", [signature_domain_version], cluster_id, program_id, action, payload...)`

The `cluster_id` and `signature_domain_version` fields are read from `ProtocolConfig`, which lets
clients discover the active message schema directly from chain state.

| Action    | Payload                                                                               |
| --------- | ------------------------------------------------------------------------------------- |
| `deposit` | `deposit_request_hash, destination_hash, depositor, mint, amount, reserver, releaser, nonce, issued_at, deadline` |
| `reserve` | `recipient, deposit_hash, quote_hash, source_amount`                                  |
| `release` | `deposit_hash, quote_hash`                                                            |
| `refund`  | `deposit_hash, quote_hash`                                                            |

Post-deposit actions bind to `deposit_hash`, preventing cross-cycle signature replay. They also
bind the offchain `quote_hash` (attested by the reserver at `reserve`, zero for a deposit that was
never reserved), tying each action to the specific offchain quote. A refund of a never-reserved deposit is signed over a zero `quote_hash`, which offchain consumers (veri-fill) should read as "never reserved."

## Replay Protection

### Deposit Replay

| Parameter        | Value            | Description                                               |
| ---------------- | ---------------- | --------------------------------------------------------- |
| Horizon          | 128 seconds      | `REPLAY_HORIZON_SECS` - time window for replay checks     |
| Slot extraction  | `nonce & 0xFF`   | Low 8 bits determine bitmap slot                          |
| Valid slots      | 0-234            | `REPLAY_SLOTS = 235`                                      |
| Epoch derivation | `issued_at >> 8` | 256-second slices, 20-bit epoch with parity               |
| Scope            | Per authority    | `ReplayBucket` PDA: `[b"replay", authority, nonce[4..8]]` |

Bitmap uses dual-parity design with 20-bit epoch and sentinel bit for initialization tracking.

A nonce already set in the slice just before or after is rejected as a duplicate, so authorizations issued in adjacent slices cannot reuse it (see `replay-protection.md`).

### Post-Deposit Protection

`reserve`, `release`, and `refund` still bind to `deposit_hash`, enabling settlement even after
delegate expiry, but now they do so inside the deployment-specific signature domain above.

See [Replay Protection](replay-protection.md) for implementation details.

## Delegated Authority Model

| Constraint           | Description                                 |
| -------------------- | ------------------------------------------- |
| `remaining_capacity` | Maximum total tokens that can be deposited  |
| `max_transfer_size`  | Maximum tokens per single deposit           |
| `expiration`         | Timestamp after which deposits are rejected |
| `allowed_mint`       | Only this token mint can be deposited       |

**Gating scope**: Only `deposit` checks delegate state. Settlement (`reserve`, `release`, `refund`)
is independent, ensuring funds are never locked.

## State Management

| Behavior         | Detail                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Account closure  | `DepositInfo` and `escrow_ata` closed on `release`/`refund`; rent reclaimed                                                               |
| Exact settlement | `release` pays recipient and treasury from `deposit.amount` only                                                                          |
| Surplus handling | `release` returns surplus to the depositor, or to the treasury when the depositor ATA refuses plain credits; `refund` drains full balance |

## Account Validation

| Check          | Description                                                         |
| -------------- | ------------------------------------------------------------------- |
| Canonical ATA  | ATAs must be canonical for `(authority, mint, token_program)` tuple |
| Owner/Mint     | Token account ownership and mint verified at runtime                |
| PDA derivation | Critical accounts are PDAs; only escrow program can sign            |

## Threat Mitigations

| Threat                  | Mitigation                                      |
| ----------------------- | ----------------------------------------------- |
| Replay attacks          | Bitmap-based protection with time bounds        |
| Signature reuse         | `deposit_hash` binding for post-deposit actions |
| Unauthorized deposits   | Delegate signature verification                 |
| Unauthorized settlement | Reserver/releaser signature verification        |
| Double release/refund   | Account closure after settlement                |
| Fund lockup             | Settlement allowed after delegate expiry        |
| Instruction confusion   | Cross-instruction Ed25519 references rejected   |
| Protocol compromise     | Pause mechanism blocks operations               |
| Admin key compromise    | Two-step transfer with delay                    |
| Unsupported tokens      | Mint allowlist + nonzero transfer fee rejection |
| Role abuse              | Separated roles with minimal capabilities       |

## Related Documentation

- [Replay Protection](replay-protection.md)
- [Architecture Overview](overview.md)
- [PDA Support](pda-support.md)
