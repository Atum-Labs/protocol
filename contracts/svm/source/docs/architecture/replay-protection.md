# Replay Protection

Bitmap-based replay protection for escrow deposits and fulfillment proxy operations. Uses compact
nonce-derived coordinates to minimize storage while supporting high throughput.

## Shared Crate: `crates/replay/`

Both programs share the same audited replay algorithm via the `replay` workspace crate. The crate
is a pure Rust library (no Anchor dependency) exporting:

| Export                          | Description                                        |
| ------------------------------- | -------------------------------------------------- |
| `check_replay(bitmaps, ...)`    | Core atomic check-and-mark algorithm               |
| `is_used(bitmaps, ...)`         | Read-only slot check                               |
| `ReplayError`                   | Plain Rust error enum (not Anchor `#[error_code]`) |
| `derive_replay_bucket_selector` | Nonce bytes [4..8] extractor                       |
| `decode_replay_slot`            | Slot validator (`< 235`)                           |
| `REPLAY_HORIZON_SECS`           | 128                                                |
| `REPLAY_SLICE_SECS`             | 256                                                |
| `REPLAY_SLOTS`                  | 235                                                |

Each program wraps `check_replay` with a `map_err` to convert `ReplayError` → its own `ErrorCode`.
The fulfillment proxy maps `DuplicateTransaction` → `AlreadyFulfilled` for semantic clarity.

**File paths:**

- Algorithm: `crates/replay/src/check.rs`
- Error enum: `crates/replay/src/errors.rs`
- Escrow wrapper: `programs/escrow/src/utils/replay.rs`
- Fulfillment proxy wrapper: `programs/fulfillment_proxy/src/utils/replay.rs`

## Constants

| Constant              | Value | Description                |
| --------------------- | ----- | -------------------------- |
| `REPLAY_HORIZON_SECS` | 128   | Validity window in seconds |
| `REPLAY_SLICE_SECS`   | 256   | Length of one time slice, at least twice the validity window |
| `REPLAY_SLOTS`        | 235   | Usable slots per bitmap    |

## Nonce Structure (64-bit)

| Bits  | Purpose         | Description                                 |
| ----- | --------------- | ------------------------------------------- |
| 0-7   | Slot            | `slot = nonce & 0xFF`, must be `< 235`      |
| 32-63 | Bucket selector | Upper 4 bytes derive the `ReplayBucket` PDA |
| 8-31  | Free            | Available for client-side semantics         |

## Bucket Derivation

```
Escrow:            [b"replay", authority, nonce[4..8]]
Fulfillment Proxy: [b"replay", settler,   nonce[4..8]]
```

## Bitmap Structure

```rust
#[account]
pub struct ReplayBucket {
    pub bitmaps: [[u64; 4]; 2],  // 8 (discriminator) + 64 = 72 bytes
}
```

Each 256-bit bitmap layout:

| Location           | Purpose                     |
| ------------------ | --------------------------- |
| Bits 0-234         | Replay flags (usable slots) |
| Word 3, bits 43-62 | 20-bit epoch                |
| Word 3, bit 63     | Sentinel (init marker)      |

## Time Slicing

| Calculation | Formula                      | Purpose                       |
| ----------- | ---------------------------- | ----------------------------- |
| Parity      | `(issued_at >> 8) & 1`       | Selects bitmap (0 or 1)       |
| Epoch       | `(issued_at >> 8) & 0xFFFFF` | 20-bit epoch for age tracking |

## Algorithm: check_replay

1. **Deadline/temporal validation**: Reject if `now > deadline`, `deadline < issued_at`,
   `now < issued_at` (FutureTransaction), or `now > issued_at + 128` (ExpiredTransaction)
2. **Slot selection**: `slot = nonce & 0xFF`; reject if `slot >= 235` (InvalidSlot)
3. **Parity/epoch**: Compute from `issued_at`; select appropriate bitmap
4. **Adjacent-slice test**: Reject (DuplicateTransaction) if the slot is set in the other bitmap and
   that bitmap's epoch is the slice just before or just after this one (see below)
5. **Epoch handling**: Wipe bitmap if uninitialized or epoch diff >= 2
6. **Replay test**: Map slot to `(word_idx, bit_idx)`; reject if bit set (DuplicateTransaction); set
   bit

### Adjacent slices

An authorization is valid for up to 128 seconds after `issued_at`, so one issued in a slice can
still be live when another is issued in the next slice. Each slice has its own parity bitmap, so
the same nonce used in two adjacent slices would pass the own-bitmap test twice. Step 4 closes
that: a nonce set in the slice before or after is a duplicate, in either submission order. A
rejected call changes no state.

### Why a slice is twice the validity window

A nonce has to stay recorded until every authorization signed while the first was still valid has
expired. If A is issued at `t` and B, with the same nonce, at any time up to `t + 128`, B can be
submitted until `t + 256`. So A's record has to last for two validity windows.

Two bitmaps hold two slices. With slices as short as the validity window, 128 seconds, that span
covers three slices, and an unrelated deposit in the third slice wipes the bitmap that holds A
while B is still valid. B would then be accepted. With 256-second slices, the span from A's issue
to B's last valid second always ends before the third slice starts, so the bitmap holding A is
never wiped while B could be submitted. `REPLAY_SLICE_SECS >= 2 * REPLAY_HORIZON_SECS` is checked
at compile time, and a randomized test in the crate asserts that no two overlapping authorizations
are both accepted for one slot.

Carrying the old bitmap's bits forward into the other bitmap before a wipe was considered and
rejected: in a bucket with traffic in every slice the carried bits are carried again at every
rotation, so they never clear and the bucket fills with slots that can never be reused.

### Reuse and capacity

A nonce can be used again once its earlier use is two or more slices away, which is 256 to 512
seconds. The bitmap records the slice of an earlier use, not its exact `issued_at` or deadline, so
a repeat in the next slice is refused even if the earlier authorization has already expired; a
client that rebuilds an authorization with the same nonce must wait until its `issued_at` is two
or more slices later.

This means a slot is reusable 256 to 512 seconds after its last use, not 128 to 256. An issuer
that hands out slots sequentially and wraps around gets 235 slots per 256 to 512 seconds per
bucket, and has to open more buckets to sustain more than about 0.9 authorizations a second.
For hash-derived nonces, two distinct requests from one depositor collide if they land on the same
bucket and slot within that window.

This does not make one logical request unique across rebuilt authorizations: a client that signs
a fresh authorization with the same nonce every two or more slices is accepted each time. That
needs a marker that outlives bitmap rotation, tracked separately.

### Upgrading from 128-second slices

Epochs stored in existing buckets are in 128-second units. After the upgrade the first write to
each bucket reads its stored epoch as stale and wipes it. An authorization that landed within its
128 seconds before the upgrade is then no longer remembered, so pause deposits and strict
fulfillments, wait at least 256 seconds for everything signed before the pause to expire, and then
upgrade.

## Error Conditions

| ReplayError              | Condition                    |
| ------------------------ | ---------------------------- |
| `DeadlineExpired`        | `now > deadline`             |
| `InconsistentTimestamps` | `deadline < issued_at`, or `issued_at + 128` overflows |
| `FutureTransaction`      | `now < issued_at`            |
| `ExpiredTransaction`     | `now > issued_at + 128`      |
| `DeadlineTooFarInFuture` | `deadline > issued_at + 128` |
| `InvalidSlot`            | `(nonce & 0xFF) >= 235`      |
| `DuplicateTransaction`   | Bit already set in bitmap    |

## Post-Deposit Protection

Escrow signatures are domain-separated using the on-chain values in `ProtocolConfig`:

`keccak(b"escrow", [signature_domain_version], cluster_id, program_id, action, payload...)`

Post-deposit signatures include the `deposit_hash` payload to bind them to a specific deposit
instance:

| Action  | Payload                   |
| ------- | ------------------------- |
| Reserve | `recipient, deposit_hash` |
| Release | `deposit_hash`            |
| Refund  | `deposit_hash`            |

Upon settlement (`release` or `refund`), the `DepositInfo` and `escrow_ata` accounts are closed.

## Client Integration

### Nonce Generation (TypeScript)

```typescript
export function createValidNonce(): anchor.BN {
  const nonceBuffer = randomBytes(8);
  nonceBuffer[0] = nonceBuffer[0] % 235; // Ensure valid slot
  if (nonceBuffer[7] < 0x10) {
    nonceBuffer[7] = 0x10 + (nonceBuffer[7] % 0xf0);
  }
  return new anchor.BN(nonceBuffer, "le");
}
```

### Replay Bucket PDA (Escrow)

```typescript
const [replayBucket] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("replay"),
    authority.toBuffer(),
    nonce.toBuffer("le", 8).slice(4),
  ],
  escrowProgramId
);
```

### Replay Bucket PDA (Fulfillment Proxy)

```typescript
function deriveReplayBucket(
  nonce: anchor.BN,
  settler: PublicKey
): [PublicKey, number] {
  const bucketSelector = nonce.toBuffer("le", 8).slice(4, 8);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("replay"), settler.toBuffer(), bucketSelector],
    fulfillmentProxyProgramId
  );
}
```

## Client Guidance

| Topic               | Requirement                                                             |
| ------------------- | ----------------------------------------------------------------------- |
| Slot constraint     | Ensure `slot < 235` (avoid `0xEB`..`0xFF` in lowest byte)               |
| Bucket distribution | Use upper nonce bytes (`nonce[4..8]`) to spread replay bucket usage     |
| Timing              | Set `issued_at` to signing time; land within `issued_at + 128`          |
| Deadline            | Must satisfy: `issued_at <= deadline <= issued_at + 128`                |
| Domain discovery    | Fetch `cluster_id` and `signature_domain_version` from `ProtocolConfig` |
| Ed25519 ordering    | Verification instruction must immediately precede program instruction   |

## Nonce Management Strategy

Nonces for both `deposit` (escrow) and `strict_fulfill` (fulfillment proxy) are tracked externally
by an **issuing server**. The on-chain programs do not assign or track nonce sequences — they only
validate uniqueness within the replay bitmap.

### Issuing Server Responsibilities

| Concern          | Strategy                                                                          |
| ---------------- | --------------------------------------------------------------------------------- |
| Nonce assignment | Increment slot sequentially per bucket per actor, skipping invalid slots (>= 235) |
| Bucket selection | Encode bucket selector in `nonce[4..8]`; start with minimal buckets               |
| Capacity scaling | Dynamically open new buckets when throughput demands exceed 235 slots per 256-512s |
| Cost management  | Fewer buckets = fewer on-chain `ReplayBucket` accounts = lower rent costs         |
| Actor scoping    | Maintain separate nonce counters per authority (escrow) or settler (proxy)        |

### Bucket Allocation

Each unique `nonce[4..8]` value maps to a distinct `ReplayBucket` PDA (72 bytes, ~rent-exempt cost).
The issuing server controls cost by constraining which bucket selectors it issues:

- **Low traffic**: Use a single bucket (e.g., `nonce[4..8] = [0,0,0,0]`) — 235 slots per 256-512s
- **Medium traffic**: Open 2-4 buckets — up to 940 slots per 256-512s
- **High traffic**: Dynamically assign new bucket selectors as needed

When a bucket's slots are exhausted within a window, the server issues nonces for the next bucket.
Old buckets are automatically reclaimed by the epoch-wipe mechanism after 2 slices (512s).

### Cross-Chain Nonce Linking (Fulfillment Proxy)

When the fulfillment proxy settles cross-chain payments, the source chain may use a different nonce
format (e.g., `uint256` nonce from Permit2 on EVM). The issuing server bridges these:

| Responsibility             | Implementation                                                             |
| -------------------------- | -------------------------------------------------------------------------- |
| Nonce translation          | Map source-chain nonce → Solana u64 nonce (issuing server maintains map)   |
| Uniqueness guarantee       | Solana nonce must be unique per settler per bucket — server enforces this  |
| Payment linkage            | `payment_id` (32 bytes) ties the deposit nonce to the fulfillment nonce    |
| Cross-chain nonce registry | Server maintains `{payment_id → {deposit_nonce, fulfill_nonce, chain_id}}` |

The `payment_id` serves as the canonical cross-chain identifier. Both the deposit (on source chain)
and the fulfillment (on Solana) reference the same `payment_id`, regardless of the nonce format used
on each chain.

## Security Summary

### Escrow Deposits

| Threat                 | Mitigation               |
| ---------------------- | ------------------------ |
| Replay within window   | Bitmap bit check         |
| Replay after window    | Temporal expiry check    |
| Cross-authority replay | Authority-scoped buckets |

### Fulfillment Proxy

| Threat                     | Mitigation                           |
| -------------------------- | ------------------------------------ |
| Same settler, same slot    | Bitmap bit check                     |
| Future/stale/off-window tx | Temporal guards + horizon checks     |
| Different settlers         | Intentionally allowed (redundancy)   |
| Old parity state reuse     | Epoch diff >= 2 triggers bitmap wipe |

## Storage Costs

| Program           | Size     | Notes                              |
| ----------------- | -------- | ---------------------------------- |
| Escrow            | 72 bytes | One PDA per authority/bucket combo |
| Fulfillment Proxy | 72 bytes | One PDA per settler/bucket combo   |

## Test Coverage

See `tests/08_replay_protection.ts` for escrow replay coverage, and
`tests/06_fulfillment_proxy.ts` (`6.5.*`) for strict fulfillment replay, temporal guards,
per-settler isolation, and strict/non-strict event assertions.
