# Testing Guide

## Framework

| Component | Value                         |
| --------- | ----------------------------- |
| Framework | ts-mocha (Mocha + TypeScript) |
| Timeout   | 1,000,000ms                   |
| Runner    | `anchor test`                 |

## Test Files

| Suite                              | Description                        | Tests |
| ---------------------------------- | ---------------------------------- | ----- |
| `01_protocol_setup.ts`             | Protocol initialization            | 3     |
| `02_delegate_lifecycle.ts`         | Delegate create/revoke/renounce    | 14    |
| `03_deposit_lifecycle.ts`          | Deposit → reserve → release/refund | 11    |
| `04_post_deposit_flows.ts`         | Post-deposit state transitions     | 15    |
| `05_fulfillment_proxy_protocol.ts` | Fulfillment proxy protocol RBAC    | 8     |
| `06_fulfillment_proxy.ts`          | Fulfillment proxy integration      | 22    |
| `07_edge_cases.ts`                 | Edge case handling                 | 21    |
| `08_replay_protection.ts`          | Replay protection algorithm        | 11    |
| `09_pda_interactions.ts`           | PDA account interactions           | 9     |
| `10_protocol_fees.ts`              | Fee calculation + settlement       | 14    |
| `11_protocol_pause_rbac.ts`        | Pause + RBAC flows                 | 15    |
| `12_token2022_integration.ts`      | Token-2022 support                 | 6     |
| `13_signature_domain.ts`           | Signature-domain hardening         | 7     |
| `15_real_token_compat.ts`          | Real mainnet/devnet mints          | 23    |

## Running Tests

```bash
# Full suite
anchor test

# Skip build (faster)
anchor test --skip-build

# Specific file: edit Anchor.toml
[scripts]
test = "pnpm ts-mocha -p ./tsconfig.json -t 1000000 tests/**/06*.ts"
# Then: anchor test --skip-build
# Revert Anchor.toml when done

# Direct execution (without anchor test)
export ANCHOR_PROVIDER_URL=http://localhost:8899
export ANCHOR_WALLET=~/.config/solana/id.json
npx ts-mocha -p tsconfig.json -t 1000000 tests/08_replay_protection.ts
```

## Test Utilities (`tests/helpers.ts`)

| Function                              | Signature                                                                                                       | Description                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `createValidNonce`                    | `(): anchor.BN`                                                                                                 | Generates replay-safe nonce (slot < 235, bucket >= 0x10)             |
| `createStrictFulfillReplayArgs`       | `(options?: { nonce?: anchor.BN; issuedAt?: anchor.BN; ttlSecs?: number }): StrictFulfillReplayArgs`            | Builds strict replay/timing args (`nonce`, `issuedAt`, `deadline`)   |
| `createStrictFulfillArgs`             | `(paymentId: Uint8Array \| Buffer, amount: anchor.BN, replayArgs?: StrictFulfillReplayArgs): StrictFulfillArgs` | Builds strict method args in ABI order                               |
| `deriveReplayBucketSelectorFromNonce` | `(nonce: anchor.BN \| Uint8Array \| Buffer): Buffer`                                                            | Extracts selector bytes `nonce[4..8]`                                |
| `createMessage`                       | `(action: string, params: (Buffer \| Uint8Array)[], options?: EscrowMessageOptions): Promise<Buffer>`           | Creates escrow message hash using `ProtocolConfig` domain by default |
| `createEd25519Instruction`            | `(signer: Keypair, message: Buffer): TransactionInstruction`                                                    | Creates Ed25519 verification instruction                             |
| `createPaymentId`                     | `(): Buffer`                                                                                                    | Generates random 32-byte payment ID                                  |
| `deriveFulfillmentReplayBucket`       | `(nonce: anchor.BN \| Uint8Array \| Buffer, settler: PublicKey): [PublicKey, number]`                           | Derives replay bucket PDA for strict fulfillment                     |
| `ensureProtocolInitialized`           | `(program: Program<Escrow>, provider: AnchorProvider): Promise<PublicKey>`                                      | Initializes escrow protocol config (idempotent)                      |
| `ensureFulfillmentProxyInitialized`   | `(program: Program<FulfillmentProxy>, provider: AnchorProvider): Promise<PublicKey>`                            | Initializes fulfillment proxy protocol config (idempotent)           |
| `fetchEscrowProtocolConfig`           | `(protocolConfigAddress?: PublicKey)`                                                                           | Fetches escrow `ProtocolConfig` for client-side domain discovery     |
| `getProtocolConfigAddress`            | `(programId: PublicKey): PublicKey`                                                                             | Derives protocol config PDA                                          |
| `getMintFeeConfigAddress`             | `(mint: PublicKey): PublicKey`                                                                                  | Derives mint fee config PDA                                          |
| `buildTransferHookRemainingAccounts`  | `(extraAccountMetaList: PublicKey): AccountMeta[]`                                                              | Builds forwarded TransferHook remaining accounts                     |
| `findProgramEvent`                    | `(program, signature, eventName)`                                                                               | Decodes a named Anchor event from a transaction                      |
| `computeExpectedFeeAtoms`             | `(amount: BN, config: MintFeeConfig): BN`                                                                       | Calculates expected fees for assertions                              |
| `setupToken2022MintAndFund`           | `(authority: Keypair, amount: BN): Promise<PublicKey>`                                                          | Creates Token-2022 mints for testing                                 |

### Role Keypairs

| Keypair            | Description                      |
| ------------------ | -------------------------------- |
| `pauserKeypair`    | Keypair for pause/unpause tests  |
| `treasurerKeypair` | Keypair for fee settlement tests |

## Test Coverage

### 1. Protocol Setup (3 tests)

| Test | Description                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------- |
| 1.1  | Reject initialize_protocol by non-upgrade authority                                             |
| 1.2  | Initialize ProtocolConfig with correct field values, `cluster_id`, and signature-domain version |
| 1.3  | Reject duplicate initialization (idempotency)                                                   |

### 2. Delegate Lifecycle (13 tests)

| Test    | Description                                                                                 |
| ------- | ------------------------------------------------------------------------------------------- |
| 2.1     | Create delegate with capacity, transfer size, expiration                                    |
| 2.2     | Authority revokes delegate (token::revoke + close)                                          |
| 2.3     | Delegate signer renounces (disable without close)                                           |
| 2.4     | Revoke clears SPL delegation                                                                |
| 2.4.b   | Reject revocation with non-canonical ATA                                                    |
| 2.5     | Reject duplicate delegate creation                                                          |
| 2.6     | Reject invalid delegate parameters (zero capacity, zero transfer size, transfer > capacity) |
| 2.7     | Reject non-authority revocation                                                             |
| 2.8     | Reject non-signer renouncement                                                              |
| 2.9     | Reject deposits to revoked delegate                                                         |
| 2.10    | Reject deposits to renounced (expired) delegate                                             |
| 2.11-12 | Pay-master flows for creation/revocation                                                    |
| 2.13    | Same signer across multiple mints                                                           |

### 3. Deposit Lifecycle (11 tests)

| Test | Description                                            |
| ---- | ------------------------------------------------------ |
| 3.1  | Create deposit with signature verification             |
| 3.2  | Distinct payer for deposit                             |
| 3.3  | Atomic Deposit + Reserve + Release (ALT-compressed TX) |
| 3.4  | Reject deposit with expired delegate                   |
| 3.5  | Reject deposit with insufficient capacity              |
| 3.6  | Reject deposit exceeding max transfer size             |
| 3.7  | Reject deposit with invalid delegate signer            |
| 3.8  | Reject duplicate deposit (payment ID collision)        |
| 3.9  | Reject deposit with mismatched mint                    |
| 3.10 | Reject deposit with expired deadline                   |
| 3.11 | Reject deposit with deadline too far in future         |

### 4. Post-Deposit Flows (15 tests)

| Test | Description                                  |
| ---- | -------------------------------------------- |
| 4.1  | Reserve deposit                              |
| 4.2  | Reject already-reserved deposit              |
| 4.3  | Reject reserve with invalid reserver         |
| 4.4  | Reject reserve on released deposit           |
| 4.5  | Release reserved deposit and close accounts  |
| 4.6  | Reject release of unreserved deposit         |
| 4.7  | Refund deposit and close accounts            |
| 4.8  | Reject refund with invalid releaser          |
| 4.9  | Reject release with invalid releaser         |
| 4.10 | Reject actions on settled (refunded) deposit |
| 4.11 | Reject reserve on refunded deposit           |
| 4.12 | Release after delegate revoked               |
| 4.13 | Refund after delegate renounced              |
| 4.14 | Release after delegate renounced             |
| 4.15 | Refund after delegate revoked                |

### 5. Fulfillment Proxy Protocol (8 tests)

| Test | Description                                         |
| ---- | --------------------------------------------------- |
| 5.1  | Reject initialize_protocol by non-upgrade authority |
| 5.2  | Initialize fulfillment proxy ProtocolConfig         |
| 5.3  | Reject duplicate initialization                     |
| 5.4  | Reject pause/unpause by non-pauser                  |
| 5.5  | Rotate pauser while paused (recovery)               |
| 5.6  | Reject set_pauser by non-admin                      |
| 5.7  | Reject set_default_admin_delay_seconds by non-admin |
| 5.8  | Reject begin_default_admin_transfer by non-admin    |

### 6. Fulfillment Proxy (28 tests)

| Group           | Coverage focus                                                                   |
| --------------- | -------------------------------------------------------------------------------- |
| `6.1`-`6.4`     | Core fulfill/strict flows, deadline checks, account validation, payer behavior   |
| `6.5.*`         | Strict replay suite (nonce-based coordinates, temporal guards, event assertions) |
| `6.6.1`-`6.6.4` | Non-strict compatibility + pause/admin controls                                  |
| `6.7.*`         | Token-2022 TransferHook forwarding for `fulfill` and `strict_fulfill`            |
| `6.8.*`         | Token-2022 TransferFee: short credit rejected, zero fee credits exactly          |

#### 6.5 Strict Replay Coverage (Required)

| Requirement                      | Expected assertion                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Strict success path              | `strict_fulfill(payment_id, nonce, issued_at, amount, deadline)` succeeds with valid replay args                  |
| Duplicate same nonce coordinates | Second submission in active window fails with `AlreadyFulfilled`                                                  |
| Invalid slot rejection           | `nonce & 0xFF >= 235` fails with `InvalidSlot`                                                                    |
| Future transaction rejection     | `now < issued_at` fails with `FutureTransaction`                                                                  |
| Expired transaction rejection    | `now > issued_at + 128` fails with `ExpiredTransaction`, `now > deadline` fails with `DeadlineExpired`            |
| Deadline window rejection        | `deadline < issued_at` fails with `InconsistentTimestamps`, `deadline > issued_at + 128` fails with `DeadlineTooFarInFuture` |
| Per-settler isolation            | Same nonce coordinates are isolated by `settler` seed                                                             |
| Per-bucket isolation             | Different `nonce[4..8]` values map to distinct replay PDAs                                                        |
| Strict event assertion           | `strict_fulfill` emits `StrictFulfilled` with nonce/timing fields                                                 |
| Non-strict event compatibility   | `fulfill` emits `Fulfilled` and does not emit `StrictFulfilled`                                                   |
| Long-window behavior             | Long wait/epoch-boundary variants may remain skipped when localnet timing control is impractical                  |

### 7. Edge Cases (21 tests)

| Test | Description                                        |
| ---- | -------------------------------------------------- |
| 7.1  | Reject zero-amount deposit                         |
| 7.2  | Reject negative issued_at timestamp                |
| 7.3  | Reject release of refunded deposit                 |
| 7.4  | Reject refund of released deposit                  |
| 7.5  | Reject incorrect PDA seeds                         |
| 7.6  | Reject invalid signature verification              |
| 7.7  | Enforce recipient ATA owner                        |
| 7.8  | Reject mismatched mint in release                  |
| 7.9  | Reject double release                              |
| 7.10 | Reject double refund                               |
| 7.11 | Release full amount (no protocol fee)              |
| 7.12 | Reject release with mismatched recipient ATA owner |
| 7.13 | Reject refund with mismatched depositor ATA owner  |
| 7.14 | Reject release with incorrect escrow ATA           |
| 7.15 | Reject Ed25519 cross-instruction message index     |
| 7.16 | Release and close with extra tokens in escrow      |
| 7.17 | Refund and close with extra tokens in escrow       |
| 7.18 | Reject release with non-canonical recipient ATA    |
| 7.19 | Reject refund with non-canonical depositor ATA     |
| 7.20 | Reject release with non-canonical escrow ATA       |
| 7.21 | Reject refund with non-canonical escrow ATA        |

### 8. Replay Protection (11 tests)

| Test | Description                                            |
| ---- | ------------------------------------------------------ |
| 8.1  | Reject duplicate transaction                           |
| 8.2  | Different buckets for different high bits              |
| 8.3  | Same slot collision for different low bits             |
| 8.4  | Reject expired transaction                             |
| 8.5  | Reject future transaction                              |
| 8.6  | Reject invalid slot (>= 235)                           |
| 8.7  | Accept late arrivals (previous slice)                  |
| 8.8  | Clear bitmap after 2 slices                            |
| 8.9  | Reject the same nonce in the adjacent slice            |
| 8.10 | Authority-scoped bucket isolation                      |
| 8.11 | Reject replayed post-deposit signatures on new deposit |

### 9. PDA Interactions (9 tests)

| Test | Description                                               |
| ---- | --------------------------------------------------------- |
| 9.1  | PDA as depositor via CPI (constraint verification)        |
| 9.2  | PDA as settler via CPI (constraint verification)          |
| 9.3  | Distinct payer for fulfillment (pay-master)               |
| 9.4  | PDA recipients                                            |
| 9.5  | PDA authority flow (conceptual)                           |
| 9.6  | End-to-end PDA simulation                                 |
| 9.7  | Init recipient ATA with distinct payer (EOA)              |
| 9.8  | Init PDA recipient ATA with distinct payer                |
| 9.9  | Init authority ATA in create_delegate with distinct payer |

### 10. Protocol Fees (14 tests)

| Test  | Description                                      |
| ----- | ------------------------------------------------ |
| 10.1  | Percentage-only fee on release                   |
| 10.2  | Min-only (flat) fee on release                   |
| 10.3  | Percentage + min clamp                           |
| 10.4  | Percentage + max clamp                           |
| 10.5  | Percentage + min + max within bounds             |
| 10.6  | Fee snapshot is stable across config changes     |
| 10.7  | Extra tokens are returned to the depositor       |
| 10.8  | Refund charges no fee                            |
| 10.9  | Reject FeeExceedsAmount at deposit               |
| 10.10 | Atomic fallback for tiny amounts                 |
| 10.11 | Reject fee_percentage_6 > 100%                   |
| 10.12 | Reject min_fee_6 > max_fee_6                     |
| 10.13 | Reject max_fee_6 > 0 without percentage          |
| 10.14 | Reject create_delegate when mint not allowlisted |

### 11. Protocol Pause + RBAC (15 tests)

| Test   | Description                                 |
| ------ | ------------------------------------------- |
| 11.1   | Reject pause by non-pauser                  |
| 11.2   | Reject unpause by non-pauser                |
| 11.3   | Paused blocks create_delegate               |
| 11.4   | Paused blocks revoke_delegate               |
| 11.5   | Paused blocks renounce_delegate             |
| 11.6   | Paused blocks deposit                       |
| 11.7   | Paused blocks reserve                       |
| 11.8   | Paused blocks release                       |
| 11.9   | Paused blocks refund                        |
| 11.10  | Mint config allowed while paused            |
| 11.11  | Pauser rotation while paused                |
| 11.12  | Pauser rotation while unpaused              |
| 11.13  | Admin transfer while paused (delay=0)       |
| 11.13b | Reject premature admin transfer (delay > 0) |
| 11.14  | Unauthorized role/config changes rejected   |

### 12. Token-2022 Integration (11 tests)

| Test | Description                                                  |
| ---- | ------------------------------------------------------------ |
| 12.1 | Token-2022 happy path (deposit → reserve → release)          |
| 12.2 | TransferHook fails without remaining_accounts                |
| 12.3 | TransferHook succeeds with remaining_accounts                |
| 12.4 | Chargeable TransferFee mint rejected on allowMint            |
| 12.5 | Zero TransferFee mint allowed, deposit and release are exact |
| 12.6 | Scheduled TransferFee blocks deposit and setMintFeeConfig    |
| 12.7 | Deposits open before a fee is scheduled settle exactly       |
| 12.8 | Depositor ATA requiring memos gets the surplus and refund    |
| 12.9 | Frozen depositor ATA: payout lands, surplus to the treasury  |
| 12.10 | Reassigned classic depositor ATA does not block settlement  |
| 12.11 | Hooked mint releases and refunds with the hook accounts     |

### 13. Signature Domain (7 tests)

| Test | Description                                      |
| ---- | ------------------------------------------------ |
| 13.1 | Discover signing domain from `ProtocolConfig`    |
| 13.2 | Reject deposit signature with wrong `cluster_id` |
| 13.3 | Reject deposit signature with wrong `program_id` |
| 13.4 | Reject deposit signature with wrong version byte |
| 13.5 | Reject reserve signature with wrong `cluster_id` |
| 13.6 | Reject release signature with wrong version byte |
| 13.7 | Reject refund signature with wrong `program_id`  |

### 15. Real Token Compatibility (23 tests)

Runs the escrow and fulfillment proxy against the real mint accounts Atum supports, one `describe`
per row of `tests/fixtures/real-mints/manifest.json`: mainnet USDC and USDT, devnet USDC, and
mainnet PYUSD and USDG (Token-2022).

| Test | Description                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 15.a | Loaded mint matches the manifest: owner, decimals, exact extension set, no transfer hook, zero fees                                   |
| 15.b | `allowMint` succeeds, or fails with the manifest's `expectAllowMint` error                                                            |
| 15.c | Allowed: nonzero fee + partial reserve + release (net, fee and surplus paths). Rejected: `createDelegate` fails with `MintNotAllowed` |
| 15.d | Allowed only: deposit → refund                                                                                                        |
| 15.e | Fulfillment proxy `fulfill` + `strictFulfill` (no escrow allowlist, so every row runs)                                                |

**How the fixtures work.** Each `<name>.json` is the live mint account in `solana account --output json`
shape, loaded at genesis by a `[[test.validator.account]]` block in `Anchor.toml`. The only bytes that
differ from the chain are `mint_authority` (bytes 0..36), rewritten to a key derived from
`sha256("atum-real-mint-fixture-authority")` so the suite can mint. Supply, freeze authority and every
extension are untouched. `rentEpoch` is written as 0 because JSON cannot carry mainnet's `u64::MAX`.
The suite needs no network, so it runs in CI with the rest of `anchor test`.

The local validator runs its bundled Token-2022 program (v7.0.0 in Solana 2.3.0), not the mainnet
deployment (v11.0.0). The suite proves the program works with the real mint state, not against the
mainnet Token-2022 binary.

**Refreshing.** `pnpm fixtures:real-mints [--mainnet-rpc <url>] [--devnet-rpc <url>]` rewrites every
fixture. It fails, writing nothing for that row, when a mint is missing or no longer matches its
manifest row: owner, decimals, extension set, a transfer hook program being set, or a nonzero older or
newer transfer fee. A failure means the issuer changed the mint, so review that change before
updating the manifest.

**Adding a token.** Add a manifest row, run the refresh, add the `[[test.validator.account]]` block to
`Anchor.toml`, and allowlist the mint in `.gitleaks.toml` (with its row in the pre-publication audit).

**Expecting a rejection.** A row whose `expectAllowMint` names an error code (PYUSD and USDG expect
`PermanentDelegateMintNotAllowed`) asserts that `allowMint` fails with it and that `createDelegate` then
fails with `MintNotAllowed`, and skips the release and refund flows.

Keep only JSON under `tests/fixtures/`: the unquoted `tests/**/*.ts` glob in `Anchor.toml` is
expanded by `sh`, so a `.ts` file there would replace the whole suite with that one file.

## Writing New Tests

### File Naming

Follow pattern: `NN_description.ts` (NN = numeric order)

### Template

```typescript
import {
  anchor,
  escrowProgram,
  provider,
  expect,
  Keypair,
  PublicKey,
} from "./helpers";
import {
  createValidNonce,
  createMessage,
  createEd25519Instruction,
  createPaymentId,
} from "./helpers";

describe("Feature Name", () => {
  const program = escrowProgram;

  before(async () => {
    // Setup
  });

  it("should do something", async () => {
    // Test implementation
  });

  it("should reject invalid input", async () => {
    try {
      // Invalid operation
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err.error.errorCode.code).to.equal("ExpectedError");
    }
  });
});
```

## Related Documentation

- [Development Setup](setup.md)
- [Contributing Guidelines](contributing.md)
- [Replay Protection](../architecture/replay-protection.md)
