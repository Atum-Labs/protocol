# Atum Protocol - Complete Architecture Guide

> **Document Purpose**: This document provides a comprehensive understanding of the Atum Protocol's intent-based payment system, including both on-chain and off-chain components, design rationale, and operational flows.

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [System Architecture](#system-architecture)
3. [Actors and Roles](#actors-and-roles)
4. [Contract Deep Dive](#contract-deep-dive)
5. [Operational Flows](#operational-flows)
6. [Signature System](#signature-system)
7. [Fee Mechanism](#fee-mechanism)
8. [Security Model](#security-model)
9. [Design Decisions](#design-decisions)
10. [Future Considerations](#future-considerations)

---

## Executive Summary

Atum Protocol is an **intent-based payment system** that enables trustless, condition-based token transfers. The protocol solves the challenge of cross-chain payments by separating the intent (deposit) from the execution (fulfillment), with cryptographic guarantees ensuring atomic settlement.

### Core Value Proposition

- **Gasless for Users**: Depositors only sign messages; settlers execute all on-chain transactions
- **Competitive Settlement**: Off-chain auction determines the best settler for each payment
- **Trustless Execution**: Multi-party signatures ensure no single party can steal funds
- **Cross-Chain Ready**: Architecture supports settlement across any EVM-compatible chains

### Dual Contract Architecture

The protocol is deployed as two contracts on each chain:

| Contract | Description |
|----------|-------------|
| **Escrow** | Holds deposited funds, releases to settler or refunds to depositor |
| **FulfillmentProxy** | Records payment fulfillments with on-chain audit trail |

> **Note**: Both contracts are deployed on all chains. Escrow operates as the **source chain** for deposits/releases, while FulfillmentProxy operates as the **destination chain** for fulfillments, depending on the payment direction. Each contract has independent pause control.

---

## System Architecture

### Complete System Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              OFF-CHAIN LAYER                                    │
│                                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   Depositor  │    │   Reserver   │    │   Releaser   │    │   Settlers   │  │
│  │    (User)    │    │  (Protocol)  │    │  (Protocol)  │    │  (Bidders)   │  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘    └──────┬───────┘  │
│         │                   │                   │                   │          │
│         │ Signs Permit2     │ Signs Reserve     │ Signs Release     │ Bids &   │
│         │ + DepositWitness  │ Witness           │ or Refund         │ Executes │
│         │                   │                   │                   │          │
│         └───────────────────┴───────────────────┴───────────────────┘          │
│                                       │                                         │
│                                       ▼                                         │
│                        ┌─────────────────────────────┐                          │
│                        │     Protocol Backend        │                          │
│                        │  • Signature Coordination   │                          │
│                        │  • Settler Auction          │                          │
│                        │  • Cross-chain Indexing     │                          │
│                        │  • Fulfillment Verification │                          │
│                        └─────────────────────────────┘                          │
│                                       │                                         │
└───────────────────────────────────────┼─────────────────────────────────────────┘
                                        │
┌───────────────────────────────────────┼─────────────────────────────────────────┐
│                              ON-CHAIN LAYER                                     │
│                                       │                                         │
│      SOURCE CHAIN                     │              DESTINATION CHAIN          │
│                                       │                                         │
│   ┌──────────────────────┐            │         ┌────────────────────────┐      │
│   │       Escrow         │            │         │   FulfillmentProxy     │      │
│   │                      │            │         │                        │      │
│   │  deposit()           │◄───────────┼─────────│  fulfill()             │      │
│   │  release()           │  depositId │         │  strictFulfill()       │      │
│   │  refund()            │  links     │         │  fulfillMany()         │      │
│   │                      │  chains    │         │                        │      │
│   │  Hash-based storage  │            │         │  Emits audit events    │      │
│   │  Fee accumulation    │            │         │                        │      │
│   └──────────────────────┘            │         └────────────────────────┘      │
│                                       │                                         │
│   Both contracts deployed on all chains; usage depends on payment direction.    │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### State Machine

```
                    ┌─────────────────────────────────┐
                    │         NON-EXISTENT            │
                    │    (depositHash == bytes32(0))  │
                    └────────────────┬────────────────┘
                                     │
                                     │ deposit()
                                     │ • Validates signatures
                                     │ • Transfers tokens via Permit2
                                     │ • Stores keccak256(ActiveDeposit)
                                     ▼
                    ┌─────────────────────────────────┐
                    │            ACTIVE               │
                    │    (depositHash != bytes32(0))  │
                    │    Settler designated           │
                    │    Funds locked in escrow       │
                    └───────────┬───────────┬───────────┘
                               │           │
              release()        │           │  refund()
              • Releaser       │           │  • Releaser
                signs          │           │    signs
              • Funds →        │           │  • Funds →
                Settler        │           │    Depositor
              • Fee            │           │  • Full amount
                deducted       │           │
              • Storage        │           │
                cleared        │           │
                               ▼           ▼
                    ┌─────────────────────────────────┐
                    │          COMPLETED              │
                    │    (depositHash == bytes32(0))  │
                    │    Storage cleared              │
                    │    No further operations        │
                    └─────────────────────────────────┘
```

---

## Actors and Roles

### Role Definitions

| Actor | Responsibilities | Trust Level |
|-------|-----------------|-------------|
| **Depositor** | Owns tokens, initiates payment intent via Permit2 signature | Untrusted (protocol serves them) |
| **Reserver** | Designates which settler can claim funds | Trusted (protocol-controlled, future: decentralized) |
| **Releaser** | Verifies fulfillment, authorizes release or refund | Trusted (protocol-controlled, future: decentralized) |
| **Settler** | Provides liquidity, fulfills payments, claims escrow | Untrusted (economically incentivized) on `fulfill`; permissioned on `strictFulfill` once the allowlist is enforced — see `SETTLER_ROLE` |
| **Default Admin** | Grants/revokes roles, manages admin transfer | Trusted (protocol admin) |
| **PAUSER_ROLE** | Can pause/unpause contract operations | Trusted (protocol admin) |
| **TREASURER_ROLE** | Can withdraw accumulated protocol fees | Trusted (protocol admin) |
| **TOKEN_CONFIG_ROLE** | Manages token allowlist and fee configuration | Trusted (protocol admin) |
| **SETTLER_ROLE** (FulfillmentProxy) | Authorized to call `strictFulfill` when `s_settlerAllowlistEnforced` is true | Trusted (admin-granted); **ships dormant**, enabled at cutover |

> **`SETTLER_ROLE` narrows the Settler row above, and only on the strict path.** `strictFulfill`'s idempotency marker is keyed on the bare `quoteHash`, which the source chain publishes as an indexed topic in `Escrow.Deposited` before the destination fulfillment. While the allowlist is dormant, any caller can consume a known `quoteHash` for the price of gas and permanently block the real settler on that path — the marker is never cleared. Enabling the allowlist is what makes the strict path trustworthy, which is why it is a gated cutover step rather than optional hardening (CORE-2116).

### Role Relationships

```
Depositor ──────────────────────────────────────────────────────────────┐
    │                                                                   │
    │ "I want to pay X tokens to Recipient on Chain B"                  │
    │                                                                   │
    ▼                                                                   │
Reserver ─────────────────────────────────────────────────────────┐     │
    │                                                             │     │
    │ "Settler S has won the auction, I authorize them"           │     │
    │                                                             │     │
    ▼                                                             │     │
Settler ──────────────────────────────────────────────────────────┼─────┼─────┐
    │                                                             │     │     │
    │ 1. Submits deposit() with both signatures                   │     │     │
    │ 2. Fulfills payment on destination chain                    │     │     │
    │ 3. Submits release() to claim funds                         │     │     │
    │                                                             │     │     │
    ▼                                                             ▼     ▼     │
Releaser ◄────────────────────────────────────────────────────────┴─────┘     │
    │                                                                         │
    │ "Fulfillment verified on Chain B, I authorize release"                  │
    │  OR                                                                     │
    │ "Fulfillment failed/timeout, I authorize refund"                        │
    │                                                                         │
    ▼                                                                         │
Recipient ◄───────────────────────────────────────────────────────────────────┘
    │
    │ Receives payment on destination chain
    ▼
```

### Implicit Trust Agreements

When a settler bids on and wins a payment:
- They implicitly accept the designated reserver and releaser
- They trust that the releaser will sign release upon verified fulfillment
- They bear the risk of non-signing by the releaser (mitigated by releaser being trusted entity)

---

## Contract Deep Dive

### Contract Inheritance

The protocol uses two separate contracts with the following inheritance hierarchies:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Escrow Contract                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                    ┌───────────────────────────────┐                        │
│                    │           Escrow              │                        │
│                    └───────────────┬───────────────┘                        │
│                                    │                                        │
│         ┌──────────────────────────┼──────────────────────────┐             │
│         │                          │                          │             │
│ ┌───────▼────────┐     ┌───────────▼───────────┐    ┌─────────▼─────────┐   │
│ │     EIP712     │     │ AccessControlDefault  │    │     Pausable      │   │
│ │ (OpenZeppelin) │     │    AdminRules         │    │   (OpenZeppelin)  │   │
│ │                │     │   (OpenZeppelin)      │    │                   │   │
│ └────────────────┘     └───────────────────────┘    └───────────────────┘   │
│                                                                             │
│ Interfaces: IEscrow, ITokenConfig                                           │
│ Roles: PAUSER_ROLE, TREASURER_ROLE, TOKEN_CONFIG_ROLE                       │
│ EIP-712 domain: name "Escrow", version "3"                                  │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                          FulfillmentProxy Contract                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│                    ┌───────────────────────────────┐                        │
│                    │      FulfillmentProxy         │                        │
│                    └───────────────┬───────────────┘                        │
│                                    │                                        │
│                    ┌───────────────┼───────────────┐                        │
│                    │                               │                        │
│        ┌───────────▼───────────┐       ┌──────────▼──────────┐              │
│        │ AccessControlDefault  │       │      Pausable       │              │
│        │    AdminRules         │       │   (OpenZeppelin)    │              │
│        │   (OpenZeppelin)      │       │                     │              │
│        └───────────────────────┘       └─────────────────────┘              │
│                                                                             │
│ Interfaces: IFulfillmentProxy                                               │
│ Roles: PAUSER_ROLE                                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key Design Points**:
- `Escrow` handles deposits, releases, refunds, and token fee management
- `FulfillmentProxy` handles payment fulfillments with on-chain audit trail
- Both contracts use `AccessControlDefaultAdminRules` for role-based access control
- Each contract has independent pause control for operational flexibility
- Escrow EIP-712 domain: name `"Escrow"`, version `"3"`

### Escrow Functionality

#### Storage Model

The escrow functionality uses **hash-based storage** for gas optimization:

```solidity
// Instead of storing full structs:
// mapping(bytes32 => ActiveDeposit) private s_activeDeposits;

// We store only the hash:
mapping(bytes32 depositId => bytes32 activeDepositHash) private s_activeDepositHashes;
```

**Benefits**:
- ~70% gas reduction on storage operations
- Storage clearing provides gas refunds on completion
- Tamper-proof: any modification to deposit parameters fails hash validation

**How it works**:
1. On deposit: Store `keccak256(abi.encode(ActiveDeposit))`
2. On release/refund: 
   - Caller provides full witness data
   - Contract reconstructs `ActiveDeposit` from witness
   - Computes hash and compares to stored value
   - If match: proceed with operation
   - If mismatch: revert with `InvalidWitnessValues`

#### Deposit ID Generation

```solidity
depositId = keccak256(abi.encode(
    depositor,           // Who signed
    depositSignature,    // The signature itself
    permit.nonce         // Permit2 nonce
));
```

This ensures:
- **Uniqueness**: Even identical deposits get different IDs (different signatures/nonces)
- **Anti-griefing**: Attacker can't front-run with a victim's signature
- **Deterministic**: Off-chain systems can compute ID before submission

`directDeposit` (a deposit the owner account executes itself, pulled against its own approval in
the same batch, for accounts that cannot sign Permit2 messages) has no depositor signature, so its id binds
the same facts explicitly:

```solidity
depositId = keccak256(abi.encode(
    DIRECT_DEPOSIT_DOMAIN_TAG,  // keccak256("Escrow:directDeposit:v1"), never a left-padded address
    block.chainid,
    address(this),
    msg.sender,                 // the caller is the depositor
    token, nonce,               // the caller's own unordered nonce, spent on success
    depositWitnessHash,         // EIP-712 struct hash of the DepositWitness
    amount                      // the payer's maximum, fees included
));
```

The deposit is stored unreserved; the reserver signs this id later, at `reserve()`, which requires
its input to rebuild exactly the tuple stored under it, so every member above reaches the reserver
gate; see ONCHAIN_SPEC.md, "depositId Calculation".

#### Active Deposit Structure

```solidity
struct ActiveDeposit {
    address depositor;          // Original token owner
    bytes32 quoteHash;          // Offchain quote hash
    bytes32 depositRequestHash; // Depositor's commitment to the offchain deposit request
    bytes32 destinationHash;    // keccak256(bytes(destination)) the depositor committed to
    address token;              // ERC20 token address
    uint256 amount;             // Deposit amount (full, before fees)
    uint256 feeAmount;          // Calculated protocol fee
    address reserver;           // Authorized to set settler
    address releaser;           // Authorized to release/refund
    address settler;            // Designated fund recipient
}
```

### Fulfillment Functionality

#### Purpose

The fulfillment functionality is intentionally simple—it's a **passthrough layer** that:
1. Transfers tokens from settler to recipient
2. Emits events linking the transfer to an deposit ID
3. Provides an on-chain audit trail for cross-chain verification

#### Why Not Direct Transfers?

Direct ERC20 transfers would work, but the fulfillment functions provide:
- **Standardized events**: Consistent format for indexers across chains
- **Deposit ID reference**: Links fulfillment to source chain deposit
- **Batch operations**: Gas-efficient multi-fulfillment in single tx
- **Deadline protection**: `strictFulfill()` for time-sensitive payments

#### Fulfillment Structure

```solidity
struct Fulfillment {
    bytes32 depositId;  // depositId from source chain (or any unique reference)
    address to;               // Payment recipient
    address token;            // Token being transferred
    uint256 amount;           // Transfer amount
}
```

---

## Operational Flows

### Happy Path: Deposit → Fulfill → Release

```
Timeline ──────────────────────────────────────────────────────────────────────►

    PHASE 1: Off-chain Signature Collection
    ┌────────────────────────────────────────────────────────────────────────┐
    │                                                                        │
    │  Depositor                         Reserver                            │
    │      │                                 │                               │
    │      │ 1. Signs Permit2 +              │                               │
    │      │    DepositWitness               │                               │
    │      │    (specifies reserver,         │                               │
    │      │     releaser, token, amount)    │                               │
    │      │                                 │                               │
    │      └──────── signature ─────────────►│                               │
    │                                        │                               │
    │                                        │ 2. Computes depositId         │
    │                                        │    from deposit signature     │
    │                                        │                               │
    │                                        │ 3. Signs ReserveWitness       │
    │                                        │    (includes depositId,       │
    │                                        │     quoteHash, settler)       │
    │                                        │                               │
    │      Settler ◄──── both signatures ────┘                               │
    │                                                                        │
    └────────────────────────────────────────────────────────────────────────┘

    PHASE 2: On-chain Deposit (Source Chain)
    ┌────────────────────────────────────────────────────────────────────────┐
    │                                                                        │
    │  Settler                              Escrow Contract                  │
    │      │                                     │                           │
    │      │ 4. deposit(depositInput)            │                           │
    │      │    - permit                         │                           │
    │      │    - depositor                      │                           │
    │      │    - depositWitness                 │                           │
    │      │    - depositSignature               │                           │
    │      │    - reserveWitness                 │                           │
    │      │    - reserveSignature               │                           │
    │      │                                     │                           │
    │      └────────────────────────────────────►│                           │
    │                                            │                           │
    │                                            │ 5. Validates signatures   │
    │                                            │ 6. Calculates fee         │
    │                                            │ 7. Transfers tokens       │
    │                                            │    via Permit2            │
    │                                            │ 8. Stores deposit hash    │
    │                                            │ 9. Emits Deposited event  │
    │                                            │                           │
    │      ◄───────── depositId ─────────────────┘                           │
    │                                                                        │
    └────────────────────────────────────────────────────────────────────────┘

    PHASE 3: Fulfillment (Destination Chain)
    ┌────────────────────────────────────────────────────────────────────────┐
    │                                                                        │
    │  Settler                           FulfillmentProxy                    │
    │      │                                     │                           │
    │      │ 10. approve(fulfillmentProxy,       │                           │
    │      │            amount)                  │                           │
    │      │                                     │                           │
    │      │ 11. fulfill(Fulfillment)            │                           │
    │      │     - depositId: depositId    │                           │
    │      │     - to: recipient                 │                           │
    │      │     - token: destToken              │                           │
    │      │     - amount: paymentAmount         │                           │
    │      │                                     │                           │
    │      └────────────────────────────────────►│                           │
    │                                            │                           │
    │                                            │ 12. Transfers tokens      │
    │                                            │     settler → recipient   │
    │                                            │ 13. Emits Fulfilled event │
    │                                            │                           │
    └────────────────────────────────────────────────────────────────────────┘

    PHASE 4: Release (Source Chain)
    ┌────────────────────────────────────────────────────────────────────────┐
    │                                                                        │
    │  Releaser                     Settler                 Escrow           │
    │      │                           │                       │             │
    │      │ 14. Verifies fulfillment  │                       │             │
    │      │     via cross-chain       │                       │             │
    │      │     indexer               │                       │             │
    │      │                           │                       │             │
    │      │ 15. Signs ReleaseWitness  │                       │             │
    │      │                           │                       │             │
    │      └──── signature ───────────►│                       │             │
    │                                  │                       │             │
    │                                  │ 16. release(input)    │             │
    │                                  └──────────────────────►│             │
    │                                                          │             │
    │                                                          │ 17. Validates│
    │                                                          │     witness  │
    │                                                          │ 18. Clears   │
    │                                                          │     storage  │
    │                                                          │ 19. Transfers│
    │                                                          │     (amount  │
    │                                                          │      - fee)  │
    │                                                          │     → settler│
    │                                                          │ 20. Emits    │
    │                                  ◄───── funds ───────────┘     Released │
    │                                                                         │
    └─────────────────────────────────────────────────────────────────────────┘
```

### Alternative Path: Refund

Refunds occur when:
- Settler failed to fulfill within deadline
- Fulfillment was incorrect (wrong amount/recipient)
- Depositor requested cancellation before fulfillment
- Any other off-chain determined failure condition

```
    Releaser                        Settler/Anyone              Escrow
        │                                │                         │
        │ Determines failure             │                         │
        │ (via off-chain monitoring)     │                         │
        │                                │                         │
        │ Signs RefundWitness            │                         │
        │                                │                         │
        └──── signature ────────────────►│                         │
                                         │                         │
                                         │ refund(input)           │
                                         └────────────────────────►│
                                                                   │
                                                                   │ Validates
                                                                   │ Clears storage
                                                                   │ Transfers FULL
                                                                   │ amount → depositor
                                                                   │ (no fee deducted)
                                         ◄───── Refunded event ────┘
```

**Key Difference**: On refund, the **full deposit amount** returns to the depositor. The protocol absorbs the lost fee opportunity.

**Unreserved direct deposits** follow a different path: before `reserve()` the releaser cannot refund them (`refund()` rejects the zero `quoteHash`), and only the depositor can take the deposit back, by calling `refundUnreserved()` itself, with no signature. Once a `reserve()` has landed, the deposit follows the releaser path above. That is also how the reserver and the releaser together can return an unreserved deposit without the depositor: a `reserve()` at the full amount, which charges nothing back and emits `DepositReserved` with the quote and settler it names, then the releaser's `refund()`.

---

## Signature System

### Signature Types and Domains

| Signature | Signer | Domain | Purpose |
|-----------|--------|--------|---------|
| Deposit | Depositor | **Permit2** | Authorizes token transfer with witness |
| Direct deposit | none: the owner account approves the escrow and executes it, and the escrow pulls the funds with `transferFrom` | n/a | The deposit id binds what the deposit signature would have |
| Reserve (direct) | Reserver | **Escrow** | Designates settler on an unreserved direct deposit, `reserve()` |
| Reserve | Reserver | **Escrow** | Designates settler |
| Release | Releaser | **Escrow** | Authorizes release to settler |
| Refund | Releaser | **Escrow** | Authorizes refund to depositor (reserved deposits only) |
| Unreserved refund | none: the depositor executes it | n/a | Returns an unreserved direct deposit, `refundUnreserved()` |

**Critical Note**: The deposit signature uses **Permit2's domain separator**, not Escrow's. All other signatures use Escrow's domain separator (`EIP712("Escrow", "3")`).

### Signature Order Dependency

```
Step 1: Depositor signs
        ├── Input: token, amount, nonce, deadline, reserver, releaser
        └── Output: depositSignature

Step 2: Compute depositId
        └── depositId = keccak256(depositor, depositSignature, nonce)

Step 3: Reserver signs
        ├── Input: depositId, quoteHash, settler, sourceAmount
        └── Output: reserveSignature

Step 4: Submit deposit() with both signatures
```

### Type Hashes

```solidity
// Deposit witness (for Permit2)
DEPOSIT_WITNESS_TYPE_HASH = keccak256(
    "DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)"
);

// Reserve witness (for Escrow)
// Minimal struct - depositId cryptographically commits to all deposit details via depositor's signature
RESERVE_WITNESS_TYPE_HASH = keccak256(
    "ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)"
);

// Release witness (for Escrow)
RELEASE_WITNESS_TYPE_HASH = keccak256(
    "ReleaseWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)"
);

// Refund witness (for Escrow)
REFUND_WITNESS_TYPE_HASH = keccak256(
    "RefundWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)"
);
```

---

## Fee Mechanism

### Fee Configuration

Each allowlisted token has its own fee configuration:

```solidity
struct TokenConfig {
    uint88 feePercentage6Decimals;  // e.g., 20_000 = 0.02%
    uint80 maxFee6Decimals;          // e.g., 250_000_000 = $250 max
    uint80 minFee6Decimals;          // e.g., 1_000_000 = $1 min  
    uint8 tokenDecimals;             // e.g., 6 for USDC, 18 for DAI
}
```

Direct deposits snapshot this complete configuration when funded. The quote selector can read
`getDirectDepositFeeConfig(depositId)` while the deposit is unreserved. Reservation calculates the
final fee on the winning all-in `sourceAmount` using the snapshot; later token fee updates cannot
change it. The snapshot is cleared at reservation or unreserved refund, with rollback on failure.
Permit2 deposits already know the winning source amount and calculate their final fee at deposit.

### Fee Calculation Logic

```
1. Calculate percentage fee: amount × feePercentage / 100_000_000
2. Apply minimum: if fee < minFee → fee = minFee
3. Apply maximum: if fee > maxFee → fee = maxFee
4. Atomic fallback: if percentage > 0 but rounds to 0 → fee = 1 (atomic unit)
5. Validate: if fee > amount → REVERT
```

### Fee Flow

```
On Deposit:
    Contract receives: amount (full)
    Fee calculated and stored in ActiveDeposit.feeAmount

On Release:
    Settler receives: amount - feeAmount
    Protocol accumulates: feeAmount → s_tokenFeeRevenue[token]

On Refund:
    Depositor receives: amount (full, no fee deducted)
    Protocol absorbs: lost fee opportunity

On Withdraw (owner):
    Protocol treasury receives: s_tokenFeeRevenue[token]
    s_tokenFeeRevenue[token] = 0
```

---

## Security Model

### Multi-Party Authorization

No single party can unilaterally move funds, with one exception: the depositor alone can take back its own unreserved direct deposit (`refundUnreserved()`), which no settler has committed to yet:

| Action | Required Authorization |
|--------|----------------------|
| Deposit | Depositor + Reserver signatures |
| Direct deposit | Owner's own approval in the same batch (the escrow pulls from the caller only); Reserver signature over the derived id at `reserve()` |
| Release | Releaser signature |
| Refund | Releaser signature |
| Unreserved refund (direct deposit, before `reserve()`) | The depositor's own call; no signature, not permissionless |

### Immutability Guarantees

Once a deposit is created:
- **Settler is immutable**: Cannot be changed after deposit
- **Amount is immutable**: Stored in hash, validated on every operation. The one exception is a
  direct deposit's `reserve()`, which can only lower it, from the deposited maximum to the charged
  amount, refunding the difference to the depositor
- **Roles are immutable**: Reserver, releaser locked at deposit time

### Replay Protection

1. **Permit2 nonces**: Each `deposit` consumes a unique nonce from Permit2's bitmap
2. **Direct nonces**: Each `directDeposit` consumes a bit in the escrow's own per-owner bitmap, the same shape, never cleared
3. **Storage clearing**: After release/refund, `depositHash = bytes32(0)`
4. **Chain binding**: EIP-712 domain includes `chainId` and `verifyingContract`; a direct id also includes both
5. **Signature binding**: a Permit2 `depositId` includes the signature itself

### Access Control

| Function | Access |
|----------|--------|
| `deposit`, `release`, `refund` | Anyone (signature-gated) |
| `directDeposit` | The owner account (`msg.sender` is the depositor, funded by its own approval) |
| `reserve` | Anyone (reserver signature-gated) |
| `refundUnreserved` | The depositor of an unreserved direct deposit (`msg.sender`-bound, no signature) |
| `fulfill`, `fulfillMany`, `strictFulfill` | Anyone (transfers from msg.sender) |
| `allowToken`, `disallowToken` | TOKEN_CONFIG_ROLE only |
| `setTokenFeeConfig`, `clearTokenFeeConfig` | TOKEN_CONFIG_ROLE only |
| `allowTokenAndSetFeeConfig` | TOKEN_CONFIG_ROLE only |
| `pause`, `unpause` | PAUSER_ROLE only |
| `withdrawFeeRevenue` | TREASURER_ROLE only |
| `grantRole`, `revokeRole` | Role admin (DEFAULT_ADMIN_ROLE) |
| `beginDefaultAdminTransfer` | DEFAULT_ADMIN_ROLE only (2-step with delay) |

### Pausability

Each contract has its own independent pause state:

**Escrow Contract** - When paused:
- ❌ `deposit`, `depositMany`, `directDeposit`, `reserve`
- ❌ `release`, `releaseMany`
- ❌ `refund`, `refundMany`, `refundUnreserved`
- ✅ View functions
- ✅ `unpause` (PAUSER_ROLE)

**FulfillmentProxy Contract** - When paused:
- ❌ `fulfill`, `fulfillMany`, `strictFulfill`
- ✅ View functions
- ✅ `unpause` (PAUSER_ROLE)

> **Operational Note**: With the dual-contract architecture, you can independently pause escrow operations while allowing fulfillments (or vice versa). This provides operational flexibility during partial incidents.

---

## Design Decisions

### Why Dual Contract Architecture?

**Current Design**: Separate Escrow and FulfillmentProxy contracts.

**Benefits**:
- **Independent pause control**: Can pause escrow without affecting fulfillments (or vice versa)
- **Clear separation of concerns**: Escrow handles deposits/releases, FulfillmentProxy handles fulfillments
- **Smaller contract bytecode**: Each contract is more focused and manageable
- **Operational flexibility**: Different admin configurations possible for each contract

**Trade-offs**:
- Two deployments per chain instead of one
- Separate administration for each contract (though can use same admin addresses)

**Security Consideration**: The separation maintains strong security because:
- `fulfill()` transfers tokens FROM `msg.sender`, not from contract balance
- Escrowed funds remain protected by signature-based release/refund in the Escrow contract, and by the depositor's own call for an unreserved direct deposit
- No cross-contract vulnerabilities exist between escrow and fulfillment logic
- Each contract has its own access control and pause mechanism

### Why Hash-Based Storage?

**Problem**: Storing full `ActiveDeposit` structs is expensive (10 slots = ~200k gas for writes).

**Solution**: Store only `keccak256(abi.encode(ActiveDeposit))` (1 slot = ~20k gas).

**Trade-off**: Callers must provide full witness data for operations, increasing calldata size slightly. Net result: ~70% gas savings.

### Why Atomic Deposit + Reserve on the Permit2 Path, and Deposit-First on the Direct Path?

**Previous Design (v1)**: Separate `deposit()` and `reserve()` transactions, where the reserve
could be raced because nothing bound the reservation to the deposit's terms.

**Permit2 path (`deposit()`)**: a single call requires both signatures upfront. The settler is set
atomically, there is no unreserved state, and the settler pays one transaction instead of two.

**Direct path (`directDeposit()` then `reserve()`)**: the owner account executes the deposit itself
(an access key cannot sign Permit2 messages), so the reservation necessarily comes later. The
unreserved window is safe because the deposit id binds the token, the deposited maximum and the
witness; the reserver signs over that id; `reserve()` accepts only an input that rebuilds the tuple
stored under it, charges at most the deposited maximum and refunds the rest. Until `reserve()` only the depositor
can take the deposit back, with `refundUnreserved()`; after it, the releaser's `refund()` works as
for a Permit2 deposit.
`release()` refuses an unreserved deposit (`NotReserved`). There is no on-chain expiry: the
fulfillment deadline is veri-fill's, checked against the destination chain when it authorizes a
release or a refund.

### Why Trusted Releaser?

**Current State**: Releaser is a protocol-controlled entity.

**Risk**: If releaser goes offline or malicious, funds could be locked.

**Mitigation**:
- Releaser is a known, trusted entity
- Protocol has operational controls
- Future consideration: timeout-based refunds (see Future Considerations)

### Why Protocol Absorbs Refund Fees?

**Design Choice**: On refund, depositor gets full amount back (no fee).

**Rationale**:
- User-friendly: depositors aren't penalized for settler failures
- Incentivizes settlers to fulfill correctly
- Protocol bears the cost of system failures

---

## Future Considerations

### Planned Improvements

1. **Decentralized Releaser**
   - Multi-sig or threshold scheme for release authorization
   - Dispute resolution mechanism
   - Staking/slashing for releaser misbehavior

2. **Timeout-Based Refunds**
   - Automatic refund eligibility after deadline expiry
   - Time-gated refund function callable by anyone without releaser signature
   - Eliminates single point of failure on releaser availability

3. **Partial Fulfillment**
   - Allow partial releases for partially fulfilled payments
   - More complex fee handling

4. **Non-Atomic Batches**
   - `releaseMany` / `refundMany` with try/catch
   - Failed operations don't revert entire batch

### Potential Extensions

1. **Cross-Chain Verification**
   - On-chain proof of fulfillment (via bridges/oracles)
   - Trustless release without releaser signature

2. **Dynamic Fee Adjustment**
   - Fee based on network conditions
   - Settler-specific fee tiers

3. **ERC20 Permit Support**
   - Alternative to Permit2 for tokens with native permit
   - Broader token compatibility

---

## Appendix: Quick Reference

### Contract Addresses

| Contract | Network | Address |
|----------|---------|---------|
| Escrow | (deployment-specific) | See broadcast files |
| FulfillmentProxy | (deployment-specific) | See broadcast files |
| Permit2 | All EVM chains | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

### Key Invariants

1. A deposit can only be released OR refunded, never both
2. Settler address is immutable once set
3. `depositHash == bytes32(0)` means deposit doesn't exist or is completed
4. Fee can never exceed deposit amount
5. Only allowlisted tokens can be deposited
6. Refunds bypass fee (depositor gets full amount)
7. Fulfillment functions transfer FROM `msg.sender`, never from contract balance
8. Each contract (Escrow, FulfillmentProxy) has independent pause control

### Error Reference

| Error | Cause |
|-------|-------|
| `TokenNotAllowed` | Token not in allowlist |
| `DepositNotFound` | Deposit doesn't exist or already completed |
| `InvalidSignature` | Signature verification failed |
| `InvalidWitnessValues` | Witness data doesn't match stored hash |
| `DepositAlreadyExists` | Attempting to create duplicate deposit |
| `NotReserved` | Trying to release deposit without settler |
| `FeeExceedsDepositAmount` | Fee calculation exceeds deposit |

---

*Document Version: 3.0*  
*Last Updated: Based on dual-contract architecture (Escrow + FulfillmentProxy)*  
*Related Documents: [README.md](./README.md), [ONCHAIN_SPEC.md](./ONCHAIN_SPEC.md)*
