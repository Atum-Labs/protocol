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

| Check                      | Description                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Mint allowlist             | Only mints with `MintFeeConfig` PDA can be delegated to and deposited                                                                  |
| Nonzero transfer fee check | Token-2022 mints with a transfer fee slot that can charge, in force or scheduled, are rejected on allow, fee config update and deposit |
| Permanent delegate check   | Token-2022 mints that carry the `PermanentDelegate` extension are rejected on allow, fee config update and deposit |
| Exact transfer enforcement | Deposited amount must match specified amount exactly                                                                                   |

### Transfer fee mints

Token-2022 mints that carry `TransferFeeConfig` with fees that cannot charge (for example PYUSD and USDG at 0 bps and 0 maximum fee, or AUSD at 0 bps) can be allowlisted. The issuer's fee authority can still schedule a fee, which `set_transfer_fee` always places in `newer_transfer_fee` for the current epoch plus 2. From that moment `deposit` rejects the mint, while `release` and `refund` stay unchecked so open deposits can always settle. The fulfillment proxy rejects any transfer that credits the recipient less than `amount`, so a live fee turns a destination fulfill into a revert instead of a short payment.

A fee change is handled per mint, not with the global pause:

1. Trigger: a Hypernative monitor on the mint's `TransferFeeConfig` fires when a slot can charge (nonzero basis points and nonzero maximum fee), not on any write, since `SetTransferFee(0, 0)` also rewrites the config.
2. Before `newer_transfer_fee.epoch`: stop Solana destination fulfills for the mint, release reserved deposits and refund unreserved ones, so every open deposit settles at full value.
3. After the fee is live: a release or refund pays the recipient or depositor short of the event amounts. The choice is then a short payout or leaving the deposit open until the issuer removes the fee.
4. After any fee went live, escrow ATAs can hold withheld fees. `close_account` refuses them, so release and refund revert until someone runs the permissionless `HarvestWithheldTokensToMint` on the escrow ATA. The settler adds it to the release or refund transaction when the escrow ATA holds a withheld amount. Anyone can repeat a dust transfer while a fee is live, so the harvest belongs in the same transaction.

The global pause stays for compromise. Pausing on a fee change would also stop USDC and USDT settlement.

### Transfer hooks

Every escrow and proxy transfer goes through Token-2022's hook aware `transfer_checked`, which forwards the hook's validation account and extra accounts from `remaining_accounts`. PYUSD, USDG and AUSD carry a transfer hook authority with no hook program today. If the issuer sets one, clients must pass its accounts on every deposit, release, refund and fulfill for the mint, and a hook that refuses transfers stops settlement for that mint until the issuer changes it. The Hypernative monitor watches the hook program id as well as the fee config.

### Depositor controlled accounts

The depositor owns `depositor_ata` and can change its state after the destination payout:

| State                                                                        | Effect                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RequiredMemoTransfers`                                                      | Handled: the escrow sends a memo immediately before each credit to the depositor                                                                                    |
| Confidential transfers with non-confidential credits disabled, or frozen     | `release` sends the surplus to the treasury instead, so the payout still lands. `refund` reverts until the depositor re-enables credits, since the funds are theirs |
| Owner reassigned (classic SPL only, Token-2022 ATAs have an immutable owner) | Handled: `depositor_ata` is checked by address, not by token owner                                                                                                  |

An extension list the program cannot read counts as refusing plain credits, so an unknown account extension sends the surplus to the treasury rather than risking a reverted release.

### Issuer authorities

### Permanent delegate mints

A mint with the `PermanentDelegate` extension is refused. Its delegate can transfer or burn from any token account of the mint, the escrow's included, without the escrow's say-so, and `DepositInfo.amount` does not move with it: `release` then fails on an underfunded account and `refund` pays back only what is left. The check looks for the extension, not for who the delegate is, and it fails closed on a mint or extension list the program cannot read. As of 2026-10-19 the GBPA, OUSD, PYUSD and USDG mints on Solana mainnet all carry the extension, so none of them can be allowlisted until custody and recovery accounting are redesigned so that a unilateral transfer or burn cannot leave a credited deposit unrecoverable.

Allowlisting a mint also means trusting its issuer's other authorities, which the escrow does not check. Such mints can carry a freeze authority, a pause authority, a close authority and a transfer hook authority that can enable a hook program on every transfer. Using the pause or hook authority can make `release` and `refund` revert for every deposit in the mint, with the funds locked until the issuer relents. The escrow does not check for these extensions, so allowlisting such a mint is an explicit decision to accept that risk. Whether to refuse them on chain is a separate policy decision tracked in a follow-up ticket.

## Ed25519 Authorization

| Requirement       | Detail                                                                     |
| ----------------- | -------------------------------------------------------------------------- |
| Instruction order | Ed25519 verify must **directly precede** program instruction (`index - 1`) |
| Data embedding    | Signature, pubkey, message embedded in instruction (indices = `u16::MAX`)  |
| Cross-instruction | References rejected to prevent instruction-index confusion                 |

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
