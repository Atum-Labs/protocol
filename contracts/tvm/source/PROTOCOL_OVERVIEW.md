# Code Overview & Security Trust Assumptions

## Metadata

- **Number:** #1
- **Severity:** Informational
- **Status:** New
- **Created by:** Jonatas Martins
- **Created at:** February 12, 2026 at 7:27 PM
- **Last updated:** February 19, 2026 at 6:11 AM

## Description

## Protocol and Code Overview

Atum is a cross chain stablecoin payments protocol built around an off chain RFQ flow. A Depositor signs a Permit2 authorization (and related witness data) off chain. A Reserver runs an off-chain auction, selects a Settler and signs a reservation attesting to the chosen Settler for a specific `depositId`. The Settler fulfills the payment on the destination chain, after which a Releaser authorizes the final outcome on the source chain by signing either a release (pay Settler, keep fee) or a refund (return funds to Depositor). The smart contracts primarily enforce correct custody and one time settlement on the source chain, while correctness of the cross chain fulfillment is enforced by off chain validation and the Releaser’s decision making.

On chain, the system is composed of two contracts:

* **Escrow (source chain custody and settlement)**
  Escrow receives funds via Permit2 `permitWitnessTransferFrom`, stores a compact commitment to the deposit (a keccak hash of the `ActiveDeposit` fields), and later allows a single terminal action: `release` or `refund`. Both terminal actions delete the stored deposit hash before transferring tokens, providing replay protection and reducing reentrancy risk. Release and refund require a valid EIP 712 signature from the Releaser over all relevant witness fields. Escrow also manages an allowlist of supported tokens and per token fee configuration, and accrues collected fees for withdrawal by a treasurer role.

* **FulfillmentProxy (destination chain payment helper)**
  FulfillmentProxy simply transfers tokens from the caller (typically the Settler) to the intended recipient and emits an event that off chain actors can observe. It also offers `strictFulfill`, which adds a deadline check and a per `(depositId, sender)` replay guard for higher risk flows. The escrow contract does not read FulfillmentProxy state; it is an off chain signal and convenience layer.

The Tron and EVM variants are largely identical at the application layer, with these relevant differences:

* Tron code uses a TIP 712 domain separator pattern (masked chain id) and includes a special case for Tron USDT behavior (transfer returns `false`) by calling `transfer` directly instead of `safeTransfer`. The EVM version uses OpenZeppelin EIP 712 (`_hashTypedDataV4`) and relies on `SafeERC20` for transfers.

## Threat Model

### What the contracts guarantee

If the Reserver and Releaser behave correctly and signatures are validated correctly, Escrow enforces:

* funds can only be pulled from a Depositor via a valid Permit2 witness transfer to the Escrow contract
* each deposit identified by `depositId` can be settled at most once (release or refund) because the active deposit hash is deleted before transfer
* release sends `amount - feeAmount` to the Settler, and refund sends `amount` back to the Depositor
* token fees are applied according to the current on chain token configuration at the time the deposit executes

FulfillmentProxy provides:

* an on chain token transfer and event emission that off chain systems can use as proof of an attempted fulfillment
* optional strict mode protections (deadline and duplication guard) for payments that require higher assurance

### What the contracts do not guarantee

* Escrow does not verify that a fulfillment happened on the destination chain, to the correct recipient, for the correct amount. This is intentionally off loaded to off chain validation and to the Releaser.
* Escrow does not enforce any off chain deadlines. FulfillmentProxy deadlines are local to the destination chain helper and are not enforced by Escrow.
* There is no on chain notion of partial fulfillment. Any notion of splitting or aggregating fills would be an off chain policy implemented by the Releaser and Settlers.

### Adversarial capabilities considered

* malicious Depositors attempting to grief or exploit off chain infrastructure
* malicious or careless Settlers attempting to get paid without correct fulfillment
* attackers attempting signature replay, ambiguity, or misuse of contract wallet signature verification
* token level behaviors that break assumptions: blacklist, fee on transfer, rebasing, non standard return values
* chain instability: reorgs, temporary forks, timestamp variability, and cross chain finality mismatch
* admin misuse or front running through token configuration changes

## Actors and Trust Model

### Releaser (trusted)

The Releaser is the primary safety assumption. It is the only entity that can authorize terminal settlement in Escrow.

Responsibilities and assumptions:

* Verifies that the destination chain fulfillment occurred correctly and completely. It must not rely solely on an emitted event; it should validate the actual token transfer semantics on the destination chain, including token contract behavior and recipient correctness.
* Signs **exactly one** terminal action per `depositId` (release or refund). It must never sign both for the same deposit.
* Handles chain instability. It must account for reorg and finality on both chains and only sign once the relevant condition is final enough for the risk tolerance of the system.
* For release: waits until the fulfillment transaction is finalized on the destination chain before signing, to avoid paying the Settler for a fulfillment that is later reorged out.
* For refund: waits until the protocol’s off chain deadline has passed and the order is truly not settled, including handling last second fulfillment races.
* If implemented as a smart contract account, it must implement EIP 1271 (`isValidSignature`) correctly and defensively, and must ensure the signature it validates binds all fields required by the protocol, including chain specific replay protections.

### Reserver (trusted)

The Reserver is the gatekeeper for Settler selection and for binding the parties for a `depositId`.

Responsibilities and assumptions:

* Selects the intended Settler for the RFQ and signs the reservation witness, binding `depositId` and `settler`.
* Ensures the chosen Releaser is correct for the order and that off chain coordination uses the intended trusted Releaser set.
* Ensures the signature scheme is not replayable or ambiguous across chains or contracts. The EIP 712 domain separation must bind chain id and verifying contract correctly for the environment.
* If implemented as a smart contract account, it must implement EIP 1271 correctly and verify all fields it is expected to verify, matching the off chain EOA signature checks.

### Settler (untrusted)

The Settler provides liquidity and performs destination chain fulfillment but is not trusted for safety.

Assumptions and constraints:

* The Settler only receives funds if the Releaser signs a valid release that matches the stored deposit commitment.
* The Settler must treat on chain events as non authoritative signals. Before fulfilling, it should verify the deposit is valid and active by reconstructing expected `depositId` and checking Escrow state (e.g., `getDepositHash`) rather than relying only on a `Deposited` event.
* The Settler must ensure the Releaser configured for the order is one it trusts. Since the Depositor can effectively choose the Reserver and can influence which Releaser is referenced off chain, Settlers should refuse to fulfill orders that route to unknown or malicious Releasers.
* The Settler must call the correct fulfillment mode on the destination chain based on risk classification:

  * `fulfill` for normal payments
  * `strictFulfill` for higher risk payments where deadlines and duplicate protection are required

### Depositor (untrusted)

Depositors are not trusted for safety and should not be able to cause unauthorized release or refund if Reserver and Releaser behave correctly.

Assumptions and constraints:

* Depositors must correctly sign Permit2 messages and must manage Permit2 approvals and nonces safely.
* Depositors should ensure the Permit2 nonce they use for Atum is not concurrently used in other applications and remains available, to avoid unintended invalidation or confusion.
* Depositors should understand that off chain deadlines are enforced by off chain actors and FulfillmentProxy strict mode, not by Escrow itself.

## System Level Assumptions and Operational Requirements

1. **Releaser correctness is the primary safety assumption**
   If the Releaser mishandles reorgs, finality, signature validation, or fulfillment verification, deposits can be incorrectly released, incorrectly refunded, or stuck.

2. **Reserver authorization is the gatekeeper assumption**
   If the Reserver signs the wrong data, selects an incorrect Settler, or signatures are replayable or ambiguous across chains or contracts, unauthorized parties could be approved and the off chain flow could be subverted.

3. **Untrusted roles should only affect liveness, not safety**
   Settler and Depositor behavior should only determine whether a payment completes. They should not be able to cause loss, unauthorized release, or incorrect refunds if the Releaser and Reserver behave correctly.

## Trust Assumptions and Threat Considerations

### Permit2 approval and nonce management

* Depositors must have granted the Permit2 contract sufficient allowance for their intended payment amounts. If approval is insufficient, deposits will fail and funds will not move, affecting liveness.
* Depositors should ensure the Permit2 nonce used in the Atum permit is not already consumed by other applications and will not be consumed concurrently. `depositId` is derived from the permit nonce and the deposit signature, so nonce reuse or racing can cause deposits to fail or become unrecoverable operationally.

### Reserver and Releaser account type and signature validation

* The system assumes Reserver and Releaser are EOAs for the simplest and safest signature verification path.
* If either is a contract account, they must implement EIP 1271 correctly and must ensure their signature validation logic binds and checks all fields that an EOA signature would bind, including the full EIP 712 domain separation. In practice, this means ensuring the signed digest includes the correct chain id and verifying contract address, and that there is no cross chain replay surface.
* For Tron deployments, cross chain replay resistance must be carefully reviewed given the TIP 712 chain id masking behavior. Any off chain signer or contract wallet must match the same domain separator construction used on chain.

### Destination chain fulfillment amount

* Settlers must fulfill on the destination chain for **`amount - feeAmount`**, not the full deposit amount. The fee is retained in Escrow and accrued to `s_tokenFeeRevenue`. Fulfilling the full amount makes the Settler economically whole only if it separately recovers the fee, and can create reconciliation issues or economic loss.
* Releasers must verify that the fulfilled amount matches the expected net amount and not just that a fulfillment occurred.

### Deadlines and timing

* The Escrow contract does not enforce the RFQ or fulfillment deadline. Deadlines are an off chain control plane measure and, optionally, a destination chain enforcement through `strictFulfill`.
* Fillers and off chain matching must compare the intended deadline against the relevant chain timestamps. Because FulfillmentProxy uses `block.timestamp`, Settlers must ensure they are fulfilling within the deadline according to the destination chain timestamp, and must account for timestamp differences between chains.
* The Releaser must handle last second fulfillment races: it should avoid signing a refund immediately at the deadline boundary without confirming that no valid fulfillment transaction has landed and finalized shortly before or at the deadline.

### Finality and reorg resistance

* Release signing should occur only after the destination chain fulfillment is finalized to an acceptable depth, otherwise the system can pay out escrowed funds for a fulfillment that is later reorged out.
* Refund signing should occur only after the Releaser is confident the payment will not settle, which includes waiting beyond the deadline and checking for late inclusion and finality.
* The Releaser must not sign both release and refund for the same `depositId` and must avoid signing a terminal action until finality is guaranteed at the chosen security level.

### Token behavior assumptions and allowlisting policy

* Supported tokens must be carefully allowlisted. Fee on transfer and rebasing tokens are generally incompatible with the escrow invariants because Escrow records a fixed `amount` and later transfers based on that amount. Fee on transfer tokens can cause actual received amounts to be less than recorded, breaking settlement. Rebasing tokens can change balances over time, breaking the accounting assumptions.
* If a fee on transfer token is ever allowed, protocol fees should be configured to zero and the system must account for the token’s transfer tax separately. Even then, correctness remains fragile.
* Centralized stablecoins may implement blacklist or pause features. Token issuers can blacklist Escrow or participant addresses (Depositor, Settler, Reserver, Releaser), freezing funds and breaking liveness. This is an external dependency outside the protocol’s control.

### Token fee configuration and admin trust

* Token fee configuration is governed by `TOKEN_CONFIG_ROLE` and is trusted not to front run users. Fee determination happens at deposit execution time, so transactions in flight can land after a fee update and pay the new fee. This can create user facing surprise and economic unfairness if the role is abused.
* Operationally, fee updates should be announced and possibly rate limited or time delayed off chain to reduce this risk, since there is no on chain timelock for fee updates in the code shown.

### Off chain infrastructure and DoS resilience

* The RFQ and matching system must be resilient to spam and invalid orders. A centralized Reserver or matching service should assume adversarial Depositors can submit many invalid signatures, invalid permits, or malformed orders to waste resources.
* A practical mitigation is a priority or reputation based queue that separates known valid users and returning users from untrusted new senders, and that performs cheap pre checks before expensive signature and chain simulation work.

### Event reliance and independent verification

* Releasers must not rely solely on FulfillmentProxy events to determine that a fulfillment occurred. They must verify the underlying token transfers and relevant call data semantics.
* Settlers must not rely solely on `Deposited` events. Before fulfilling, they should verify the deposit is active and matches expectations by reconstructing `depositId`, checking Escrow state, and verifying that the configured trusted Releaser is acceptable.

### Partial fulfillment policy

* The on chain protocol is designed for a single settlement per `depositId` and does not implement partial fills. Any attempt to support partial fulfillment would be an off chain convention where the Releaser aggregates multiple destination chain fills and only signs release once the net requirement is satisfied.
* If such a policy is adopted, it becomes an additional trust and correctness burden on the Releaser and off chain accounting, and should be treated as out of scope for on chain enforcement.

### Tron specific operational assumptions

* A compatible Permit2 deployment on Tron must exist and be correct, since Escrow relies on `permitWitnessTransferFrom`.
* The Tron implementation includes a USDT special case because USDT on Tron is known to return `false` for `transfer`. This implies USDT should be explicitly and intentionally allowlisted by admins, and the system should treat it as a special compatibility case rather than assuming all tokens behave like standard ERC 20.
* Even with the special case, Tron USDT transfers that return `false` do not provide a revert based failure signal, so operational monitoring should detect failures through balance deltas rather than relying on return values.

### Admin role and governance assumptions

* `AccessControlDefaultAdminRules` introduces an admin transfer delay mechanism. The initial delay configured at deployment should be chosen intentionally as part of the security posture, not left at an overly permissive value for production.
* If the default admin delay is increased after deployment, the change is itself delayed by the current delay rules, meaning the system must wait the full configured period for the increase to take effect. Deployment planning must account for this.
* Ownership and admin roles should not be renounced in a way that prevents emergency response. In particular, `PAUSER_ROLE`, `TOKEN_CONFIG_ROLE`, and `TREASURER_ROLE` should remain held by operationally controlled entities, ideally with appropriate multisig and key management.

## Comments

---

**Alex Roan** - February 19, 2026 at 10:56 AM

This looks great guys, thank you!

