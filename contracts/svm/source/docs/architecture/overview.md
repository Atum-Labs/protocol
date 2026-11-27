# Architecture Overview

## Programs

| Program               | Purpose                                                                      |
| --------------------- | ---------------------------------------------------------------------------- |
| **Escrow**            | Manages `deposit -> reserve -> release/refund` flow with delegated authority |
| **Fulfillment Proxy** | Direct token transfers with slot-based replay protection                     |

## Key Roles

| Role                | Description                                                                           |
| ------------------- | ------------------------------------------------------------------------------------- |
| **Authority**       | Owner of funds. Delegates spending capacity via `create_delegate`. Can be EOA or PDA. |
| **Delegate Signer** | Off-chain keypair that signs `deposit` messages on behalf of authority.               |
| **Reserver**        | Signs `reserve` messages to set recipient for a deposit.                              |
| **Releaser**        | Signs `release` or `refund` messages to finalize deposits.                            |
| **Recipient**       | Receives funds on `release`. Set by reserver. Can be EOA or PDA.                      |
| **Settler**         | In fulfillment proxy, authorizes token transfers. Can be EOA or PDA via CPI.          |
| **Payer**           | Pays transaction fees and account initialization. Always EOA with SOL.                |

## Escrow Flow

```
Authority -> create_delegate(delegate_signer, remaining_capacity, max_transfer_size, expiration)  # mint is an account
Delegate Signer -> deposit(deposit_request_hash, destination_hash, amount, reserver, releaser, nonce, issued_at, deadline, deposit_hash)  # last arg is checked (DepositHashMismatch)
Reserver -> reserve(recipient, quote_hash, source_amount)
Releaser -> release() OR refund()
```

`release()` settles exactly `deposit.amount`: recipient and treasury are paid from the intended
deposit amount, while any surplus tokens sitting in the escrow ATA are returned to the depositor, or
to the treasury when the depositor's token account cannot take a plain credit.
`refund()` remains donation-tolerant and returns the full live escrow balance to the depositor.

## Escrow Instructions

| Category    | Instructions                                                                  |
| ----------- | ----------------------------------------------------------------------------- |
| Delegate    | `create_delegate`, `revoke_delegate`, `renounce_delegate`                     |
| Escrow      | `deposit`, `reserve`, `release`, `refund`                                     |
| Protocol    | `initialize_protocol`, `pause`, `unpause`, role setters (`set_*`)             |
| Mint Config | `allow_mint`, `disallow_mint`, `set_mint_fee_config`, `clear_mint_fee_config`, `pin_mint_permanent_delegate` |

## State Transitions

```
[*] --> Deposited: deposit()
Deposited --> Reserved: reserve()
Reserved --> Released: release()
Deposited --> Refunded: refund()
Reserved --> Refunded: refund()
```

## PDA Seeds

### Escrow Program

| Account          | Seeds                                   |
| ---------------- | --------------------------------------- |
| `ProtocolConfig` | `[b"protocol_config"]`                  |
| `MintFeeConfig`  | `[b"mint_fee_config", mint]`            |
| `EscrowDelegate` | `[b"escrow_delegate", authority, mint]` |
| `DepositInfo`    | `[b"deposit", deposit_hash]`            |
| `ReplayBucket`   | `[b"replay", authority, nonce[4..8]]`   |

### Fulfillment Proxy

| Account          | Seeds                               |
| ---------------- | ----------------------------------- |
| `ProtocolConfig` | `[b"protocol_config"]`              |
| `ReplayBucket`   | `[b"replay", settler, nonce[4..8]]` |

## Account Structures

### ProtocolConfig

Global protocol configuration PDA.

| Field                                 | Type            | Description                          |
| ------------------------------------- | --------------- | ------------------------------------ |
| default_admin                         | Pubkey          | Full role management                 |
| token_config_authority                | Pubkey          | Mint allowlist + fee config          |
| treasurer                             | Pubkey          | Fee recipient                        |
| pauser                                | Pubkey          | Pause/unpause authority              |
| paused                                | bool            | Protocol pause state                 |
| cluster_id                            | [u8; 32]        | Deployment-specific signature domain |
| signature_domain_version              | u8              | Signing schema version               |
| default_admin_delay_seconds           | u32             | Admin transfer delay                 |
| pending_default_admin                 | Option\<Pubkey> | Pending new admin                    |
| pending_default_admin_accept_after_ts | Option\<i64>    | Accept timestamp                     |

### Fulfillment Proxy ProtocolConfig

Global protocol configuration PDA for the fulfillment proxy program.

| Field                                 | Type            | Description             |
| ------------------------------------- | --------------- | ----------------------- |
| default_admin                         | Pubkey          | Full role management    |
| pauser                                | Pubkey          | Pause/unpause authority |
| paused                                | bool            | Protocol pause state    |
| default_admin_delay_seconds           | u32             | Admin transfer delay    |
| pending_default_admin                 | Option\<Pubkey> | Pending new admin       |
| pending_default_admin_accept_after_ts | Option\<i64>    | Accept timestamp        |

### MintFeeConfig

Per-mint fee configuration and allowlist entry. Existence = mint is allowlisted.

| Field            | Type   | Description                  |
| ---------------- | ------ | ---------------------------- |
| mint             | Pubkey | The configured mint          |
| fee_percentage_6 | u64    | Fee % × 1e6 (1_000_000 = 1%) |
| min_fee_6        | u64    | Min fee × 1e6                |
| max_fee_6        | u64    | Max fee × 1e6                |
| permanent_delegate | Pubkey | Pinned permanent delegate, default when none |

### DepositInfo

Stores deposit parameters. State is implicit: `recipient = None` means Deposited, `recipient = Some`
means Reserved. Account closure indicates Released/Refunded.

| Field        | Type            | Description                                    |
| ------------ | --------------- | ---------------------------------------------- |
| depositor    | Pubkey          | Deposit owner                                  |
| mint         | Pubkey          | Token mint                                     |
| amount       | u64             | Deposit amount                                 |
| fee_amount   | u64             | Protocol fee amount                            |
| reserver     | Pubkey          | Reserve signer                                 |
| releaser     | Pubkey          | Release/refund signer                          |
| deposit_hash | [u8; 32]        | Keccak-256 hash binding post-deposit sigs      |
| recipient    | Option\<Pubkey> | Set on reserve (None=Deposited, Some=Reserved) |

## Message Formats

All escrow messages are Keccak-256 hashes bound to the on-chain signing domain stored in
`ProtocolConfig`, and signed as the text `<label> <base64url-nopad(hash)>` verified via an Ed25519
pre-instruction (labels and the accepted `v1`/`v0` envelopes are in `programs/escrow.md`, "Signed
text"):

`keccak(b"escrow", [signature_domain_version], cluster_id, program_id, action, payload...)`

Clients should fetch `cluster_id` and `signature_domain_version` from `ProtocolConfig` before
composing messages.

| Action  | Payload                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------- |
| Deposit | `deposit_request_hash, destination_hash, depositor, mint, amount_le, reserver, releaser, nonce_le, issued_at_le, deadline_le` |
| Reserve | `recipient, deposit_hash, quote_hash, source_amount_le`                                           |
| Release | `deposit_hash, quote_hash`                                                                        |
| Refund  | `deposit_hash, quote_hash`                                                                        |

Note: `_le` suffix indicates little-endian byte encoding for u64 values.

## Replay Protection

### Escrow Program

- Uses `nonce` lower 8 bits as slot index (max 235 slots)
- Uses `issued_at` to derive epoch and parity
- Horizon: 128 seconds (validity), 256-second slices
- Dual bitmap design (2x 256 bits) with parity-based epoch tracking

### Fulfillment Proxy

- Uses same shared `replay` crate algorithm as escrow
- Uses `nonce` lower 8 bits as slot index (max 235 slots)
- Uses `issued_at` to derive epoch and parity
- Horizon: 128 seconds (validity), 256-second slices
- Dual bitmap design (2x 256 bits) with parity-based epoch tracking

## Related Documentation

- [Security Model](security.md)
- [Replay Protection](replay-protection.md)
- [PDA Support](pda-support.md)
- [Escrow Program Reference](../programs/escrow.md)
