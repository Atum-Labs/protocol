# Solana Escrow Encoding

Go library for generating message hashes for the Solana escrow program.

## Overview

The Solana escrow contract requires Ed25519 signatures over Keccak-256 hashes of structured messages. This library computes those message hashes for each operation type.

### Two-Stage Identifier Model

The Solana escrow uses a **deposit_hash** as the unique identifier (analogous to EVM's `depositId`):

```
Stage 1: deposit_request_hash (any 32-byte value: keccak256(request_id) for v1, the hash of the payment terms for v2)
  └── Included in deposit message, signed by depositor

Stage 2: deposit_hash (unique identifier, PDA seed)
  └── deposit_hash = keccak256("deposit", deposit_request_hash, destination_hash, depositor, mint, amount, ...)
  └── Includes nonce, guarantees uniqueness even with same deposit_request_hash
  └── Used for: reserve, release, refund operations
```

> **Terminology Note**: The Solana contract uses different naming than the off-chain protocol layer:
>
> | Contract Term          | Off-Chain Term | Description                                        |
> | ---------------------- | -------------- | -------------------------------------------------- |
> | `deposit_request_hash` | `request_id`   | Input parameter: `keccak256(request_id)` (v1) or the payment terms' hash (v2) |
> | `deposit_hash`         | `payment_id`   | Unique identifier used to track the payment        |
>
> This library uses contract terminology (`deposit_request_hash`, `deposit_hash`) to match the Rust source
> code. When integrating with the off-chain layer, map `deposit_hash` to `payment_id` for the
> business-logic identifier.
>
> `deposit_request_hash` was formerly named `payment_id`. The rename is hash-neutral — it aligns the name
> with EVM and TVM, which call the same value `depositRequestHash` — but it renamed the Go field, the
> `message_prehash` JSON key, and the `ErrZeroPaymentID` sentinel (now `ErrZeroDepositRequestHash`).

### Hash Formulas

| Operation   | Purpose                   | Hash Formula                                                                                                                                    |
| ----------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deposit** | Authorize funds escrow    | `keccak256("deposit" \|\| deposit_request_hash \|\| depositor \|\| mint \|\| amount \|\| reserver \|\| releaser \|\| nonce \|\| issued_at \|\| deadline)` |
| **Reserve** | Allocate funds to settler | `keccak256("reserve" \|\| recipient \|\| deposit_hash)`                                                                                         |
| **Release** | Authorize fund release    | `keccak256("release" \|\| deposit_hash)`                                                                                                        |
| **Refund**  | Authorize fund refund     | `keccak256("refund" \|\| deposit_hash)`                                                                                                         |

Every formula above is prefixed with the domain `"escrow" || version[1] || cluster_id[32] || program_id[32]`.

#### Witness revisions

The layouts above are FROZEN — they are what `signature_domain_version` 1 and 2 committed to, and
historical deposits are still verified against them. Later revisions are additive, exposed as `…V2`
functions beside the originals rather than by editing them:

| Operation   | v1 / v2 layout      | v3+ layout (`…V2` function)                                              |
| ----------- | ------------------- | ------------------------------------------------------------------------ |
| **Deposit** | as above            | v4 adds `destination_hash` right after `deposit_request_hash` (CORE-2120) |
| **Reserve** | as above            | v3 appends `quote_hash` (CORE-2022)                                      |
| **Release** | as above            | v3 appends `quote_hash` (CORE-2022)                                      |
| **Refund**  | as above            | v3 appends `quote_hash` (CORE-2022)                                      |

The suffix counts revisions of its OWN witness, so the numbers deliberately do not line up with the
domain version:

| Domain version | Deposit                 | Reserve / Release / Refund |
| -------------- | ----------------------- | -------------------------- |
| 1, 2           | `ComputeDepositHash`    | `Compute*Hash`             |
| 3              | `ComputeDepositHash`    | `Compute*HashV2`           |
| 4              | `ComputeDepositHashV2`  | `Compute*HashV2`           |

Deposit changed one revision later than the other three because CORE-2022's `quote_hash` never entered
the deposit preimage.

#### Destination commitment (CORE-2120, domain version 4)

`ComputeDepositHashV2` binds a plaintext destination the payer signs, as `<CAIP-19 asset>@<account>`:

```
eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979
```

Three rules matter for interoperability:

1. **`keccak256(destination)` enters the preimage, never the raw string.** `Keccak256` concatenates
   without length prefixes, so injectivity depends on every hashed field being fixed-width. Use
   `ComputeDestinationHash`; `TestComputeDepositHashV2_RejectsRawDestinationFeed` pins the distinction
   against the exact hash an unsound implementation would produce.
2. **Casing is per-segment and is NOT normalised by this library.** Namespaces and asset-namespaces are
   lowercase, `eip155` chain references are decimal, all hex values are lowercase (explicitly NOT
   EIP-55), and all base58 values are preserved byte-for-byte. On Solana the base58 carve-out covers
   three segments — the CAIP-2 genesis reference, the SPL mint, and the account — so a blanket
   lowercase corrupts all three into different addresses. The commitment is over the exact bytes the
   payer signed, so callers must validate casing separately, never by mutating the value.
3. **`MaxDestinationLen` is 256 bytes**, uniform across EVM, TVM and SVM so one client signing-policy
   rule covers every chain. Note the tighter Solana ceiling beneath it: a LEGACY transaction admits only
   about 152 bytes of destination at the current deposit account shape, so anything larger needs a v0
   transaction with an address lookup table. Real destinations are ~103 bytes (eip155) and ~135 bytes
   (solana), so normal traffic approaches neither limit.

> **Note**: Reserve hash has `recipient` BEFORE `deposit_hash` - this matches the Rust contract.

### Key Differences from EVM

| Aspect            | EVM                                        | Solana                                                     |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------- |
| Message format    | EIP-712 structured data                    | Tag + concatenation + Keccak-256                           |
| Integer encoding  | Big-endian, 32-byte padded                 | Little-endian, native size                                 |
| Address size      | 20 bytes                                   | 32 bytes (pubkeys)                                         |
| Unique ID         | `depositId = keccak(depositor, signature)` | `deposit_hash` from deposit encoding                       |
| When ID generated | AFTER signing                              | BEFORE signing (deposit_request_hash), AFTER encoding (deposit_hash) |

## Installation

```go
import svm "github.com/atum-labs/protocol/contracts/svm/bindings/go/escrow-encoding/encoding"
```

## Usage

For working examples, see the `Test..._Usage` functions in the test files. These are **living documentation** - guaranteed to compile and work because they run in CI.

| Use Case                        | Test Function                      | File                            |
| ------------------------------- | ---------------------------------- | ------------------------------- |
| Compute deposit_hash from request | `TestDeterminePaymentID_Usage`   | `payment_id_determiner_test.go` |
| Compute deposit_hash directly   | `TestComputeDepositHash_Usage`     | `deposit_encoder_test.go`       |
| Compute reserve hash            | `TestComputeReserveHash_Usage`     | `reserve_encoder_test.go`       |
| Compute release hash            | `TestComputeReleaseHash_Usage`     | `release_encoder_test.go`       |
| Compute refund hash             | `TestComputeRefundHash_Usage`      | `refund_encoder_test.go`        |
| Parse Solana pubkeys            | `TestPubkey_Usage`                 | `pubkey_test.go`                |

### Quick Reference

**DeterminePaymentID** - Extract deposit params from PaymentRequest's `message_prehash` JSON:
```go
depositHash, err := svm.DeterminePaymentID(paymentRequest)
```

**ComputeDepositHash** - Compute hash from raw params:
```go
depositHash, err := svm.ComputeDepositHash(params)
```

**ComputeReserveHash**, **ComputeReleaseHash**, **ComputeRefundHash** - Compute operation hashes:
```go
reserveHash, err := svm.ComputeReserveHash(EscrowReserveParams{DepositHash: depositHash, Recipient: recipient})
releaseHash, err := svm.ComputeReleaseHash(EscrowReleaseParams{DepositHash: depositHash})
refundHash, err := svm.ComputeRefundHash(EscrowRefundParams{DepositHash: depositHash})
```

**Pubkey parsing** - Convert Base58/hex/bytes to Pubkey:
```go
pk, err := svm.PubkeyFromBase58("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
```

### message_prehash JSON Format

The `DeterminePaymentID` function extracts deposit params from this JSON structure:

```json
{
  "deposit_request_hash": "0x...",
  "depositor": "Base58...",
  "mint": "Base58...",
  "amount": "1000000",
  "reserver": "Base58...",
  "releaser": "Base58...",
  "nonce": "12345",
  "issued_at": "1700000000",
  "deadline": "1700000128"
}
```

For `signature_domain_version` 4 requests use `DeterminePaymentIDV2`, whose prehash is the shape above
plus the committed destination:

```json
{
  "deposit_request_hash": "0x...",
  "destination": "eip155:8453/erc20:0x8335...2913@0xc0ff...4979",
  "...": "remaining fields unchanged"
}
```

The plaintext destination must ride the prehash: the deposit hash commits to `keccak256(destination)`, so
without the string a verifier cannot reconstruct the hash at all. Neither determiner normalises it — see
the destination-commitment rules above.

## Testing

```bash
make test
```

### Cross-Validation

The hash spec is validated on two independent axes.

**1. The frozen legacy corpus** — `contracts/svm/conformance/parity-golden.json` was originally
produced by the on-chain program's own `compute_*_hash` functions and is asserted by both
`parity_golden_test.go` and `parity-golden.test.ts`.

It is now **FROZEN and must never be regenerated.** Its cases pin domain versions 1 and 2, which the
current program can no longer produce: reserve/release/refund always bind `quote_hash` since v3, and
deposit always binds `destination_hash` since v4. That is exactly what makes it useful — it is the
regression gate proving the frozen legacy functions still reproduce what historical deposits signed. A
mismatch here means an encoder edited a frozen layout, which is the bug; do not "fix" it by updating the
committed values.

**2. Out-of-band anchors for current layouts** — new revisions are pinned to values derived independently
of any implementation in this repo (foundry `cast keccak` over the documented preimage), in
`v4_destination_test.go`, `v2_quotehash_test.go` and `v4-destination.test.ts`.

The same literal is pinned by the Rust program, the Go encoder and the TS encoder for identical inputs,
so all three are bound to one spec rather than to each other. A corpus generated by one implementation
and checked by the others only proves they agree with the generator; this arrangement means that if any
single side drifts, exactly that side fails.
- The Go encoder (`parity_golden_test.go`) and the TS encoder
  (`parity-golden.test.ts`) both assert they reproduce the same hashes, so Rust,
  Go, and TS are all validated against one source of truth.

**To regenerate the golden (only on an intentional hash-spec change):**

```bash
cd contracts/svm/source
REGEN_GOLDEN=1 cargo test -p escrow parity_golden
```

**Message-prehash pipeline vector (`testdata/test_vectors.json`):**
This file now scopes ONLY the `DeterminePaymentID` pipeline (Go JSON parse +
Base58 pubkey decode + string-amount parsing -> deposit_hash). It is generated
by `../../../typescript/escrow-encoding/scripts/generate-test-vectors.mjs`:

```bash
npm run build --workspace=@atum-labs/solana-escrow-encoding
node contracts/svm/bindings/typescript/escrow-encoding/scripts/generate-test-vectors.mjs
```

## Error Handling

Validation errors are exported as sentinel values in `errors.go`. Use `errors.Is()` to check for specific failures.

### Encoder Validation Errors

| Error                | Description                                        |
| -------------------- | -------------------------------------------------- |
| `ErrZeroDepositRequestHash` | Deposit request hash is all zeros (deposit)   |
| `ErrZeroQuoteHash`   | Quote hash is all zeros (reserve V2 only; release and refund permit zero, because a deposit can be refunded having never been reserved) |
| `ErrEmptyDestination` | Committed destination is empty (deposit V2)       |
| `ErrDestinationTooLong` | Committed destination exceeds `MaxDestinationLen` (deposit V2) |
| `ErrZeroDepositHash` | Deposit hash is all zeros (reserve/release/refund) |
| `ErrZeroDepositor`   | Depositor pubkey is all zeros                      |
| `ErrZeroMint`        | Mint pubkey is all zeros                           |
| `ErrZeroAmount`      | Deposit amount is zero                             |
| `ErrZeroReserver`    | Reserver pubkey is all zeros                       |
| `ErrZeroReleaser`    | Releaser pubkey is all zeros                       |
| `ErrZeroRecipient`   | Recipient pubkey is all zeros                      |

### DeterminePaymentID Errors

| Error                      | Description                                        |
| -------------------------- | -------------------------------------------------- |
| `ErrNotSolanaRequest`      | PaymentRequest message_scheme is not SOLANA        |
| `ErrMissingSignedMessages` | PaymentRequest signed_messages array is empty      |
| `ErrMissingMessagePrehash` | First signed message missing message_prehash field |

### Pubkey Parsing Errors

| Error                    | Description                |
| ------------------------ | -------------------------- |
| `ErrInvalidPubkeyLength` | Byte slice is not 32 bytes |
| `ErrInvalidBase58`       | Invalid Base58 encoding    |
| `ErrInvalidHex`          | Invalid hex encoding       |

## Dependencies

| Library                     | Purpose                                                         |
| --------------------------- | --------------------------------------------------------------- |
| `golang.org/x/crypto/sha3`  | Keccak-256 hashing (same as go-ethereum uses internally)        |
| `github.com/mr-tron/base58` | Solana pubkey Base58 encoding (standard in Solana Go ecosystem) |
| `github.com/atum-labs/protocol/schemas`         | PaymentRequest schema bindings (for DeterminePaymentID)         |

## Reference

| File                                                                  | Purpose                                       |
| --------------------------------------------------------------------- | --------------------------------------------- |
| Solana escrow contract: `programs/escrow/src/utils/signatures.rs`     | Rust source of truth for hash functions       |
| `../../../../conformance/parity-golden.json`                          | FROZEN pre-v3 parity corpus (never regenerate) |
| `v4_destination_test.go`                                              | Out-of-band v4 destination anchors            |
| `../../../typescript/escrow-encoding/scripts/generate-test-vectors.mjs` | Script to regenerate the pipeline vector JSON |
| `testdata/test_vectors.json`                                          | DeterminePaymentID pipeline vector (commit)   |

## Hash Details

### Encoding Conventions

- **Integers**: Little-endian (matches Rust `to_le_bytes()`)
- **Pubkeys**: 32 bytes, raw bytes
- **Payment ID**: 32 bytes, raw bytes
- **Deposit Hash**: 32 bytes, raw bytes
- **Hash function**: Keccak-256 (NOT SHA3-256)

### Message Sizes

| Operation | Input Size                 |
| --------- | -------------------------- |
| Release   | 39 bytes (7 + 32)          |
| Refund    | 38 bytes (6 + 32)          |
| Reserve   | 71 bytes (7 + 32 + 32)     |
| Deposit   | 199 bytes (7 + 32×5 + 8×4) |

## Replay Protection

The Solana escrow contract uses a time-based replay protection mechanism:

- **Validity Window**: 128 seconds from `issued_at`
- **Constraint**: `issued_at <= deadline <= issued_at + 128`
- **Nonce**: Used for bitmap slot selection (lower 8 bits must be 0-252)

> **Note**: These constraints are enforced by the Solana contract, not this library. This library only computes hashes - it does not validate time windows or nonce ranges.

