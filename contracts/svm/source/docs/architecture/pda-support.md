# PDA Support

Both programs support PDAs as participants through CPI, enabling integration with other Solana
programs.

## Account Constraints Summary

### Escrow Program

| Instruction       | Account     | Type               | PDA Support |
| ----------------- | ----------- | ------------------ | ----------- |
| `create_delegate` | `authority` | `Signer`           | Yes (CPI)   |
| `create_delegate` | `payer`     | `Signer`           | No          |
| `revoke_delegate` | `authority` | `Signer`           | Yes (CPI)   |
| `deposit`         | `authority` | `UncheckedAccount` | Yes         |
| `deposit`         | `payer`     | `Signer`           | No          |
| `release`         | `recipient` | (stored in state)  | Yes         |
| `release`         | `depositor` | (stored in state)  | Yes         |
| `release`         | `payer`     | `Signer`           | No          |
| `refund`          | `depositor` | (stored in state)  | Yes         |

### Fulfillment Proxy

| Account           | Type                      | PDA Support |
| ----------------- | ------------------------- | ----------- |
| `protocol_config` | `Account<ProtocolConfig>` | Yes (PDA)   |
| `settler`         | `Signer`                  | Yes (CPI)   |
| `to`              | `UncheckedAccount`        | Yes         |
| `payer`           | `Signer`                  | No          |

## CPI Pattern

PDAs sign via `invoke_signed`:

```rust
invoke_signed(
    &instruction,
    &accounts,
    &[&[b"pda_seed", &[bump]]],
)?;
```

## Separate Payer Model

All operations support a distinct `payer` for transaction fees and ATA creation, enabling pay-master
flows.

## ATA Handling

- Recipient ATAs use `init_if_needed` with canonical address validation
- Release may also initialize the depositor ATA so donated surplus can be returned safely
- PDAs can own ATAs; the `to`/`recipient` account type is `UncheckedAccount`

## Tests

See `tests/09_pda_interactions.ts`:

| Test    | Description                                     |
| ------- | ----------------------------------------------- |
| 9.1     | PDA as depositor (demonstrates CPI requirement) |
| 9.2     | PDA as settler (demonstrates CPI requirement)   |
| 9.3     | Distinct payer flow                             |
| 9.4     | PDA recipients                                  |
| 9.6     | End-to-end PDA simulation                       |
| 9.7-9.9 | ATA initialization with distinct payers         |
