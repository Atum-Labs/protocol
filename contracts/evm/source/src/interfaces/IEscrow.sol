// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0; // @aderyn-ignore

import {ISignatureTransfer} from "permit2/src/interfaces/IPermit2.sol";

/**
 * @title IEscrow
 * @notice Escrow interface for the Escrow contract - manages token deposits with hash-based storage
 *
 * @dev QUICK START:
 * 1. Call deposit() with both deposit and reserve signatures → get unique depositId back with settler set.
 *    Or, from the owner account, approve the escrow for the amount and call directDeposit() in the
 *    same batch → the escrow pulls it and stores the deposit UNRESERVED (no settler, no quote, no
 *    fee), and reserve() sets them later with the reserver's signature, refunding what the quote
 *    does not charge; until then release() reverts NotReserved, the releaser's refund() reverts
 *    QuoteHashCannotBeEmpty, and only the depositor can take it back, with refundUnreserved()
 *    (without the depositor, a full-amount reserve() and then the releaser's refund() return it)
 * 2. Use depositId for release()/refund() operations
 *
 * Storage is cleared after completion for gas optimization
 *
 * @dev PAYMENT IDENTIFIER:
 * - depositId: Contract-generated unique key, use for operations. keccak256(depositor, signature, permit.nonce)
 *   on deposit(); the domain-tagged derivation documented on directDeposit() on that path
 *
 * @dev STORAGE OPTIMIZATION:
 * - Deposits are stored as keccak256 hashes instead of full structs
 * - All operations validate witness data against stored hashes
 * - Significantly reduces gas costs for storage operations
 * - Hash validation ensures data integrity
 *
 * @dev SECURITY:
 * - depositId uniqueness guaranteed by Permit2's nonce bitmap on deposit() and by the escrow's own
 *   per-owner nonce bitmap on directDeposit() (2^256-1 capacity each)
 * - Witness data validation prevents tampering with deposit details
 * - No replay attacks: state validation prevents double-execution
 * - EIP-712 signatures include full witness data for integrity
 * - Token allowlist prevents malicious token exploits
 *
 * @dev TOKEN REQUIREMENTS:
 * ✅ Must be explicitly allowlisted with correct decimals via allowToken()
 * ✅ Standard ERC20 tokens only
 * ✅ No transfer fees, rebasing, or deflationary mechanics
 * ✅ Examples: USDC, DAI, USDT (standard versions)
 * ❌ Fee-on-transfer, rebasing, or tokens with changing decimals()
 * ℹ️  Refunds work even if token is later disallowed
 * ℹ️  The "no transfer fees" line above is ENFORCED on the deposit path, not merely documented: the
 *    escrow measures its own balance across the pull, Permit2 on `deposit()` and the owner's approval on
 *    `directDeposit()`, and reverts with NonExactTransfer
 *    unless the delta equals the amount the deposit is credited for. This matters because a token
 *    can acquire a transfer fee after being allowlisted -- USDT's fee is owner-settable and
 *    currently zero -- and the allowlist is checked at configuration time, not at every transfer.
 *    Rebasing and changing-decimals tokens are still unguarded and must stay off the allowlist.
 */
interface IEscrow {
    /// @dev DepositInput contains all data required for a single deposit operation
    /// @param permit Permit2 permit structure containing token, amount, nonce, and deadline
    /// @param depositor Address that owns the tokens and signed the permit
    /// @param depositWitness Contains authorized reserver and releaser addresses
    /// @param depositSignature EIP-712 signature from depositor authorizing the transfer via Permit2
    /// @param reserveWitness Contains the deposit ID, offchain quote hash, and settler address to set
    /// @param reserveSignature EIP-712 signature from the authorized reserver address
    struct DepositInput {
        ISignatureTransfer.PermitTransferFrom permit;
        address depositor;
        DepositWitness depositWitness;
        bytes depositSignature;
        ReserveWitness reserveWitness;
        bytes reserveSignature;
    }

    // ---- what this contract does NOT define about the two depositor commitments ----
    // (Plain comments, not natspec: solc parses an "@" inside a doc block as a tag, and the
    // ratified destination grammar contains one.)
    //
    // `destination` — GRAMMAR RATIFIED OFF-CHAIN, NOT ENFORCED HERE. On-chain the contract only
    // requires it to be non-empty and at most MAX_DESTINATION_BYTES; it never parses the string, so
    // the grammar below is a protocol-level agreement, not an on-chain check. The ratified grammar is
    // a CAIP-19 asset identifier, a literal "@", and then the destination account address in its
    // namespace's native form:
    //
    //     <caip2-chain-id>/<asset-namespace>:<asset-reference>@<account-address>
    //     eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979
    //
    // which is NEITHER CAIP-10 (that is chain_id:account_address — no asset part and no "@") NOR
    // plain CAIP-19 (an asset identifier with no account part), but a local composition of the two.
    // Producer and consumer MUST emit BYTE-IDENTICAL strings for the same destination: the stored
    // commitment is keccak256(bytes(destination)), so the contract compares hashes and cannot detect
    // a format disagreement at all. A one-byte disagreement between the depositor and the releaser
    // leaves the deposit neither releasable NOR refundable, and this escrow has no rescue function.
    //
    // CASING — RATIFIED, per segment, enforced OFF-CHAIN (never here): lowercase everything, EXCEPT
    // base58 values, which are case-significant and preserved byte-for-byte. Concretely: namespace
    // and asset-namespace identifiers (eip155, solana, erc20, token, slip44) lowercase; eip155 chain
    // references are decimal digits (no case); ALL hex values — eip155 asset references and account
    // addresses alike — lowercase, explicitly NOT EIP-55 (the example above is canonical). The base58
    // carve-out is per SEGMENT: on solana it covers THREE segments — the CAIP-2 genesis-hash
    // reference, the SPL mint in the asset reference, AND the account — so a blanket lowercase
    // corrupts all three. Canonical examples are pinned and conformance-tested in
    // test/Destination.canonicalExamples.t.sol.
    //
    // `depositRequestHash` — DERIVATION DEFINED OFF-CHAIN. Which deposit-request fields it covers, in
    // what encoding, under what domain, is defined by the offchain protocol layer that issues deposit
    // requests, and is deliberately opaque here. The contract requires only that it is non-zero on
    // the deposit path and that the settlement witness reproduces it exactly.
    //
    // See ONCHAIN_SPEC.md, "`destination` and `depositRequestHash`: what the contract defines, and
    // what it does not", for the ratified grammar and casing rule in full, the worked example of why
    // casing is load-bearing, and the canonical example set.
    /// @dev DepositWitness is the depositor's commitment on both deposit paths: signed through Permit2
    /// on `deposit()`, bound into the deposit id on `directDeposit()`
    /// @param depositRequestHash Depositor-signed commitment to the offchain deposit request details;
    /// what it is a hash OF is defined off-chain, not by this contract (see the note above)
    /// @param destination Plaintext string committing to where the funds are ultimately headed; its
    /// grammar is ratified off-chain and is not validated beyond length here (see the note above)
    /// @param reserver Address authorized to reserve deposits (sign ReserveWitness)
    /// @param releaser Address authorized to release/refund deposits (sign ReleaseWitness/RefundWitness)
    struct DepositWitness {
        bytes32 depositRequestHash;
        string destination;
        address reserver;
        address releaser;
    }

    /// @dev ReserveWitness is used during the deposit operation (or, for a direct deposit, at
    /// `reserve()`) to set the settler.
    /// The reserver signs this witness to designate which settler can claim the escrowed funds.
    /// The depositId cryptographically commits to all deposit details (via the depositor's signature
    /// on `deposit()`, via the id preimage on `directDeposit()`), so signing the depositId is
    /// equivalent to agreeing to those terms.
    /// @param depositId The unique deposit identifier: keccak256(depositor, signature, permit.nonce) on
    /// `deposit()`, the domain-tagged derivation documented on `directDeposit()` on that path
    /// @param quoteHash The offchain quote hash
    /// @param settler The address that will receive tokens upon release
    /// @param sourceAmount The winning quote's source amount — the actual charge, attested by the reserver
    /// (<= permit cap on `deposit()`; <= the deposited maximum on `reserve()`, which refunds the rest)
    struct ReserveWitness {
        bytes32 depositId;
        bytes32 quoteHash;
        address settler;
        uint256 sourceAmount;
    }

    /// @notice Input for `directDeposit`: a deposit the owner account funds itself, by approving the
    ///         escrow for `amount` before the call (Tempo access keys, CORE-3048).
    /// @dev The caller is the depositor, so there is no `depositor` member, and there is no
    ///      reserve member: the deposit is stored unreserved and `reserve()` sets settler and
    ///      quote later. `token`, `amount` and `nonce` are bound into the deposit id, see
    ///      `directDeposit`.
    /// @param token Source token, must be allowlisted
    /// @param amount The payer's maximum source amount, fees included; pulled in full, and
    ///        `reserve()` refunds what the winning quote does not charge
    /// @param nonce Per-owner unordered nonce, spent on success and never reusable
    /// @param depositWitness Same witness as the Permit2 path
    struct DirectDepositInput {
        address token;
        uint256 amount;
        uint256 nonce;
        DepositWitness depositWitness;
    }

    /// @notice Input for `reserve`: sets settler and quote on an unreserved direct deposit.
    /// @dev The stored hash is opaque, so the input carries what the contract needs to rebuild the
    ///      unreserved ActiveDeposit tuple (`depositor`, `token`, `amount`, the deposit witness; the
    ///      fee is zero until reserved). Every member is in the deposit's `Deposited` and
    ///      `DepositCommitments` logs, except the destination plaintext, which the request carries.
    /// @param depositor The owner account that made the deposit
    /// @param token The deposit's token
    /// @param amount The deposit's amount, the deposited maximum
    /// @param depositWitness The deposit's witness
    /// @param reserveWitness Same witness as the Permit2 path; `depositId` is the deposit to reserve
    ///        and `sourceAmount`, the charge, must be non-zero and at most `amount`
    /// @param reserveSignature Reserver's EIP-712 signature over `reserveWitness`
    struct ReserveInput {
        address depositor;
        address token;
        uint256 amount;
        DepositWitness depositWitness;
        ReserveWitness reserveWitness;
        bytes reserveSignature;
    }

    /// @dev ReleaseInput is used to release the deposit to the settler
    /// @param releaseWitness Contains full deposit information for validation
    /// @param releaseSignature EIP-712 signature from the authorized releaser address
    struct ReleaseInput {
        ReleaseWitness releaseWitness;
        bytes releaseSignature;
    }

    /// @dev ReleaseWitness contains full deposit information for validation.
    /// The contract validates that the provided witness data matches the stored deposit hash.
    /// This prevents any tampering with deposit details while maintaining gas efficiency.
    /// Replay protection is provided by state validation - once a deposit is released,
    /// storage is cleared and subsequent calls will fail with "DepositNotFound".
    /// @param depositId The unique deposit identifier (see `deposit()` and `directDeposit()` for the two derivations)
    /// @param quoteHash The offchain quote hash (must match stored deposit)
    /// @param depositRequestHash The depositor-signed commitment to the offchain deposit request (must match stored deposit)
    /// @param destinationHash keccak256(bytes(destination)) of the depositor-committed destination (must match stored deposit)
    /// @param depositor The original depositor address (must match stored deposit)
    /// @param token The token address (must match stored deposit)
    /// @param amount The token amount (must match stored deposit)
    /// @param feeAmount The amount of tokens deducted as protocol fee (in token's native decimals)
    /// @param reserver The authorized reserver address (must match stored deposit)
    /// @param releaser The authorized releaser address (must match stored deposit)
    /// @param settler The settler address (must match the stored deposit: set by deposit() or reserve())
    struct ReleaseWitness {
        bytes32 depositId;
        bytes32 quoteHash;
        bytes32 depositRequestHash;
        bytes32 destinationHash;
        address depositor;
        address token;
        uint256 amount;
        uint256 feeAmount;
        address reserver;
        address releaser;
        address settler;
    }

    /// @dev RefundInput is used to refund the deposit to the original depositor
    /// @param refundWitness Contains full deposit information for validation
    /// @param refundSignature EIP-712 signature from the authorized releaser address
    struct RefundInput {
        RefundWitness refundWitness;
        bytes refundSignature;
    }

    /// @dev RefundWitness contains full deposit information for validation.
    /// The contract validates that the provided witness data matches the stored deposit hash.
    /// This prevents any tampering with deposit details while maintaining gas efficiency.
    /// Replay protection is provided by state validation - once a deposit is refunded,
    /// storage is cleared and subsequent calls will fail with "DepositNotFound".
    /// @param depositId The unique deposit identifier (see `deposit()` and `directDeposit()` for the two derivations)
    /// @param quoteHash The offchain quote hash (must match stored deposit)
    /// @param depositRequestHash The depositor-signed commitment to the offchain deposit request (must match stored deposit)
    /// @param destinationHash keccak256(bytes(destination)) of the depositor-committed destination (must match stored deposit)
    /// @param depositor The original depositor address (must match stored deposit)
    /// @param token The token address (must match stored deposit)
    /// @param amount The token amount (must match stored deposit)
    /// @param feeAmount The amount of tokens deducted as protocol fee (in token's native decimals)
    /// @param reserver The authorized reserver address (must match stored deposit)
    /// @param releaser The authorized releaser address (must match stored deposit)
    /// @param settler The settler address (must match what was set during deposit if applicable)
    struct RefundWitness {
        bytes32 depositId;
        bytes32 quoteHash;
        bytes32 depositRequestHash;
        bytes32 destinationHash;
        address depositor;
        address token;
        uint256 amount;
        uint256 feeAmount;
        address reserver;
        address releaser;
        address settler;
    }

    /// @dev RefundUnreservedInput is the depositor's refund of an unreserved direct deposit. It
    /// carries the stored tuple members that are not zero before `reserve()`, all recoverable from
    /// the deposit's `Deposited` and `DepositCommitments` logs; the depositor is `msg.sender`, and
    /// quoteHash, settler and feeAmount are zero by construction, so a reserved deposit never matches.
    /// @param depositId The direct deposit's id
    /// @param depositRequestHash The deposit request hash committed at `directDeposit`
    /// @param destinationHash keccak256(bytes(destination)) of the destination committed at `directDeposit`
    /// @param token The deposited token
    /// @param amount The deposited maximum
    /// @param reserver The reserver committed at `directDeposit`
    /// @param releaser The releaser committed at `directDeposit`
    struct RefundUnreservedInput {
        bytes32 depositId;
        bytes32 depositRequestHash;
        bytes32 destinationHash;
        address token;
        uint256 amount;
        address reserver;
        address releaser;
    }

    /// @dev ActiveDeposit represents the complete state of an active deposit
    /// @notice This struct is not stored directly; its keccak256 hash is stored for gas optimization.
    /// When a deposit is completed (released or refunded), the hash is cleared to bytes32(0).
    /// @param depositor The address that created the deposit and owns the tokens
    /// @param quoteHash The offchain quote hash
    /// @param depositRequestHash The depositor-signed commitment to the offchain deposit request details
    /// @param destinationHash keccak256(bytes(destination)) of the depositor-committed destination.
    /// Only the hash is kept so ActiveDeposit stays a fixed-width tuple; the plaintext destination
    /// never enters storage.
    ///
    /// What an offchain observer can recover, and from where, differs between the two COMMITMENT
    /// HASHES (`destinationHash` and `depositRequestHash` — together, the only ActiveDeposit
    /// members that no flat single-item event carries) and the destination PLAINTEXT (which no
    /// witness carries at all). It also differs BY DEPOSIT PATH, and the two paths need DIFFERENT
    /// LOGS — neither one is served by a single escrow event. (`directDeposit()` emits the same two
    /// logs as `deposit()` and reads like it below; once reserved, a direct deposit also needs
    /// `DepositReserved` for its settler, quote, charged amount and fee.)
    ///
    /// - The two commitment HASHES are available from LOGS ALONE on BOTH deposit paths:
    ///   * `deposit()`: from `DepositCommitments`, emitted in the same transaction as `Deposited`
    ///     and joined to it on the indexed `depositId`;
    ///   * `depositMany()`: from `DepositedMany`, whose `DepositWitness[]` carries
    ///     `depositRequestHash` verbatim and the plaintext `destination` to hash.
    ///   The flat `Deposited` event itself carries neither value — deliberately, to keep its topic0
    ///   stable — which is precisely why `DepositCommitments` is a separate log rather than two
    ///   extra `Deposited` fields.
    ///
    /// - A COMPLETE `ReleaseWitness`/`RefundWitness` (all eleven members) is assemblable from logs
    ///   on both paths, but from different ones:
    ///   * `deposit()`: `Deposited` + `DepositCommitments` cover all eleven. No `Transfer` log is
    ///     needed — `Deposited` carries `depositor` (indexed) and `token`;
    ///   * `depositMany()`: `DepositedMany` covers only NINE of the eleven. `depositor` and `token`
    ///     appear in NONE of its four parameters (`DepositWitness` is
    ///     {depositRequestHash, destination, reserver, releaser}; `ReserveWitness` is
    ///     {depositId, quoteHash, settler, sourceAmount}). Both come from the ERC-20 `Transfer` log
    ///     the same transaction emits for that item: `token` is that log's EMITTER address and
    ///     `depositor` is its `topics[1]` (the `from`). One inbound `Transfer` is emitted per item,
    ///     in item order, so the i-th belongs to `depositIds[i]`. Emitting `DepositCommitments` from
    ///     `depositMany()` would NOT change this: it carries neither `depositor` nor `token`.
    ///
    /// - The destination PLAINTEXT is:
    ///   * `deposit()`: recoverable from the TRANSACTION CALLDATA only, by ABI-decoding
    ///     `DepositInput.depositWitness.destination`. `DepositCommitments` deliberately emits the
    ///     hash, not the preimage, so it is NOT log-recoverable on this path;
    ///   * `depositMany()`: recoverable from the calldata as above, and additionally from EVENT
    ///     DATA — `DepositedMany`'s `DepositWitness[]` carries it verbatim per deposit.
    ///
    /// On neither path is the plaintext re-derivable from a release/refund transaction alone: the
    /// settlement witnesses carry `destinationHash`, never the preimage.
    ///
    /// Both recovery procedures are executed end to end by test/Escrow.commitmentEvents.t.sol,
    /// which rebuilds a witness from decoded log data and requires the settlement to succeed.
    /// @param token The ERC20 token address being escrowed
    /// @param amount The amount of tokens held (in token's native decimals). `deposit()` stores the Permit2
    ///        charge; `directDeposit()` stores the deposited maximum, which `reserve()` replaces with the
    ///        charged `sourceAmount`
    /// @param feeAmount The amount of tokens to be deducted as protocol fee on release (in token's native decimals);
    ///        zero until `reserve()` on a direct deposit
    /// @param reserver The address whose signature designates the settler: over the reserve witness at `deposit()`,
    ///        or at `reserve()` for a direct deposit
    /// @param releaser The address authorized to sign release or refund witnesses
    /// @param settler The address that will receive tokens on release (set by `deposit()`, or by `reserve()` for a
    ///        direct deposit; zero until then)
    struct ActiveDeposit {
        address depositor;
        bytes32 quoteHash;
        bytes32 depositRequestHash;
        bytes32 destinationHash;
        address token;
        uint256 amount;
        uint256 feeAmount;
        address reserver;
        address releaser;
        address settler;
    }

    // Events

    /// @notice Emitted when a new deposit is created
    /// @param depositId Contract-generated unique identifier (indexed for filtering)
    /// @param quoteHash Offchain quote hash (indexed for filtering)
    /// @param depositor The address that created the deposit (indexed for filtering)
    /// @param settler The address that will receive tokens on release
    /// @param token The token address (non-indexed, readable)
    /// @param amount The deposit amount (non-indexed, readable)
    /// @param feeAmount The calculated fee amount (non-indexed, readable)
    /// @param reserver The reserver address (non-indexed, readable)
    /// @param releaser The releaser address (non-indexed, readable)
    event Deposited(
        bytes32 indexed depositId,
        bytes32 indexed quoteHash,
        address indexed depositor,
        address settler,
        address token,
        uint256 amount,
        uint256 feeAmount,
        address reserver,
        address releaser
    );

    /// @notice Emitted by `reserve()` when an unreserved direct deposit gets its settler, quote and
    ///         charged amount.
    /// @dev `Deposited` carried zeros for quoteHash, settler and feeAmount and the deposited maximum
    ///      as amount on a direct deposit; a log-only consumer overlays these four on the tuple it
    ///      rebuilt from `Deposited` + `DepositCommitments`.
    /// @param depositId The reserved deposit (indexed for filtering)
    /// @param quoteHash The offchain quote hash now stored
    /// @param settler The address that will receive tokens on release
    /// @param amount The charged amount now stored; the rest of the deposit went back to the depositor
    /// @param feeAmount The fee on `amount`, from the token config locked at direct deposit
    event DepositReserved(
        bytes32 indexed depositId, bytes32 quoteHash, address settler, uint256 amount, uint256 feeAmount
    );

    /// @notice Emitted alongside `Deposited` so log-only consumers can rebuild a
    /// Release/RefundWitness.
    /// @dev WHY THIS EXISTS: `Deposited` is a flat event that carries NEITHER commitment, which left
    /// `depositRequestHash` and `destinationHash` — two of the eleven members of both settlement
    /// witnesses — reachable only from the deposit transaction's calldata on the single-deposit path.
    /// A releaser that indexes logs could therefore no longer assemble a `RefundWitness`, and refund
    /// is the escape hatch: this escrow has no rescue function. This event closes that gap.
    ///
    /// @dev WHY A SEPARATE EVENT rather than two more members on `Deposited`. Two reasons, and
    /// NEITHER is topic0 stability:
    ///   1. `Deposited`'s DATA layout stays fixed. Appending members would shift no topic but would
    ///      change the `abi.decode` tuple every consumer applies to `data`; a separate event leaves
    ///      that decode alone and lets a consumer adopt the commitments when it is ready.
    ///   2. The batch path pays nothing (see the asymmetry note below).
    ///
    /// This event does NOT preserve `Deposited`'s topic0 for already-deployed indexers, and an earlier
    /// revision of this comment claimed that it did. That was true only against evm-contracts `main`,
    /// which was never deployed: relative to the ABI production runs, `Deposited`'s topic0 moves at
    /// this cutover anyway (`indexed quoteHash` added, `settler` de-indexed), and the CREATE2 addresses
    /// move too. Folding the two members into `Deposited` would recover this event's 1,125-gas LOG2
    /// base and is a legitimate design; it is an event-shape change needing an upstream + TVM-twin
    /// round trip and a new block-scanner decode path, so it is not in this release. See
    /// ONCHAIN_SPEC.md "INTEGRATION-BREAKING: `Deposited` DOES move relative to the deployed baseline".
    ///
    /// @dev DELIBERATE SINGLE-vs-BATCH ASYMMETRY — this is not an omission. The event is emitted
    /// from the single-item entry points (`deposit()`, `directDeposit()`) and NOT from the shared `_deposit` internal, so
    /// `depositMany()` does not emit it. The gap this event closes does not exist on the batch path:
    /// `DepositedMany` carries the whole `DepositWitness[]`, i.e. `depositRequestHash` and the
    /// plaintext `destination` for every item, so BOTH COMMITMENTS are already in that one log.
    /// Emitting per item from `_deposit` would pay LOG gas N times over to duplicate them.
    ///
    /// Note precisely what that does and does not mean. `DepositedMany` is NOT log-complete for a
    /// settlement witness: it yields nine of the eleven members, and `depositor` and `token` are in
    /// none of its four parameters — a batch consumer takes those from the item's ERC-20 `Transfer`
    /// log (emitter = `token`, `topics[1]` = `depositor`); see the `ActiveDeposit.destinationHash`
    /// documentation for the full per-path procedure. Emitting this event from `depositMany()` would
    /// not help with that: it carries neither `depositor` nor `token`. The commitment gap is
    /// single-path only, and so is the fix.
    ///
    /// @dev HASHES, NOT PLAINTEXT: `destinationHash` is emitted rather than the plaintext
    /// `destination` because what a consumer has to rebuild is the WITNESS, and both settlement
    /// witnesses carry `destinationHash`. The plaintext is bounded at 256 bytes, so a `string`
    /// variant would cost up to 8x the log data for a value no witness needs; it stays available
    /// from the deposit transaction's calldata on both paths, and from `DepositedMany` on the
    /// batch path.
    /// @param depositId Contract-generated unique identifier (indexed, so a consumer can fetch
    /// this log for one deposit; equals the `depositId` of the `Deposited` log emitted in the same
    /// transaction)
    /// @param depositRequestHash The depositor-signed commitment to the offchain deposit request
    /// details (non-indexed, readable)
    /// @param destinationHash keccak256(bytes(destination)) of the depositor-committed destination
    /// — the exact value stored in `ActiveDeposit` and required by both settlement witnesses
    /// (non-indexed, readable)
    event DepositCommitments(bytes32 indexed depositId, bytes32 depositRequestHash, bytes32 destinationHash);

    /// @notice Emitted when many new deposits are created
    /// @dev Arrays are non-indexed to preserve data (indexed arrays are hashed and unreadable)
    /// @param depositIds The deposit IDs
    /// @param depositWitnesses The deposit witnesses
    /// @param reserveWitnesses The reserve witnesses
    /// @param feeAmounts The fee amounts for each deposit
    event DepositedMany(
        bytes32[] depositIds, DepositWitness[] depositWitnesses, ReserveWitness[] reserveWitnesses, uint256[] feeAmounts
    );

    /// @notice Emitted when tokens are released to the settler
    /// @param depositId The deposit identifier (indexed for filtering)
    /// @param settler The address receiving the tokens (indexed for filtering)
    /// @param token The token address (non-indexed, readable)
    /// @param amount The original deposit amount (non-indexed, readable)
    /// @param feeAmount The fee deducted (non-indexed, readable)
    event Released(
        bytes32 indexed depositId, address indexed settler, address token, uint256 amount, uint256 feeAmount
    );

    /// @notice Emitted when multiple deposits are released
    /// @dev Array is non-indexed to preserve data (indexed arrays are hashed and unreadable)
    /// @param releaseWitnesses The release witnesses containing full release details
    event ReleasedMany(ReleaseWitness[] releaseWitnesses);

    /// @notice Emitted when tokens are refunded to the depositor
    /// @param depositId The deposit identifier (indexed for filtering)
    /// @param depositor The address receiving the refund (indexed for filtering)
    /// @param token The token address (non-indexed, readable)
    /// @param amount The refunded amount (non-indexed, readable)
    event Refunded(bytes32 indexed depositId, address indexed depositor, address token, uint256 amount);

    /// @notice Emitted when multiple deposits are refunded
    /// @dev Array is non-indexed to preserve data (indexed arrays are hashed and unreadable)
    /// @param refundWitnesses The refund witnesses containing full refund details
    event RefundedMany(RefundWitness[] refundWitnesses);

    // Errors

    /// @notice Witness data does not match stored deposit hash
    /// @dev This error occurs when the provided witness fields don't match the original deposit
    /// @param depositId The deposit identifier being operated on
    /// @param expectedHash The hash of the deposit info stored in the contract
    /// @param passedHash The hash computed from the provided witness data
    error InvalidWitnessValues(bytes32 depositId, bytes32 expectedHash, bytes32 passedHash);

    /// @notice Permit2 cannot be zero
    error Permit2CannotBeZeroAddress();

    /// @notice Depositor address cannot be zero
    error DepositCannotBeZeroAddress();

    /// @notice Reserver address cannot be zero
    error ReserverCannotBeZeroAddress();

    /// @notice Releaser address cannot be zero
    error ReleaserCannotBeZeroAddress();

    /// @dev Thrown when the committed destination is empty
    error DestinationCannotBeEmpty();

    /// @dev Thrown when the committed destination exceeds MAX_DESTINATION_BYTES
    error DestinationTooLong(uint256 length);

    /// @notice Deposit amount cannot be zero
    error DepositAmountCannotBeZero();

    /// @notice Source amount must be non-zero and within its ceiling: the permit's authorized amount on
    ///         `deposit()`, the deposited maximum on `reserve()`
    error InvalidSourceAmount();

    /// @notice Deposit with this ID already exists (signature reuse)
    error DepositAlreadyExists(bytes32 depositId);

    /// @notice Deposit not found - either never existed or already completed (storage cleared)
    /// @dev This error is returned for completed deposits due to storage optimization
    error DepositNotFound(bytes32 depositId);

    /// @notice EIP-712 signature verification failed
    error InvalidSignature();

    /// @notice Cannot release a deposit without a settler being set
    error NotReserved(bytes32 depositId);

    /// @notice Settler cannot be the zero address
    error SettlerCannotBeZeroAddress();

    /// @notice Offchain quote hash cannot be empty
    error QuoteHashCannotBeEmpty();

    /// @notice Depositor commitment to the offchain deposit request cannot be empty
    /// @dev Checked on the deposit path only. Once a stored deposit cannot carry a zero
    /// depositRequestHash, the release/refund hash-equality check binds the field, so a
    /// repeat guard there would cost gas on every settlement with no added protection.
    error DepositRequestHashCannotBeEmpty();

    /// @notice The escrow's balance did not move by exactly the amount the deposit is credited for
    /// @dev Measured across the pull, Permit2 on `deposit()` and the owner's approval on
    /// `directDeposit()`, as balanceAfter - balanceBefore. Deliberately an
    /// EQUALITY check, not `>=`: a short delivery (fee-on-transfer) would credit a deposit with
    /// tokens that never arrived and pay the shortfall out of the shared pool, while an inflated
    /// delivery (a transfer hook that over-credits the escrow) would leave unattributed dust that
    /// no release or refund can move. Both are rejected.
    /// @param expected The amount the deposit is credited for (sourceAmount on `deposit()`, amount on
    ///        `directDeposit()`)
    /// @param received The escrow balance delta actually observed across the transfer
    error NonExactTransfer(uint256 expected, uint256 received);

    /// @notice The caller already spent this nonce in an earlier direct deposit
    /// @param nonce The nonce that was passed
    error NonceAlreadyUsed(uint256 nonce);

    // Core Functions

    /// @notice Deposit and reserve the deposit for a specific settler address, using Permit2 signature
    /// @dev The returned depositId is generated as keccak256(depositor, signature, permit.nonce) and must be used for all subsequent operations.
    /// This function requires both deposit and reserve signatures to set the settler immediately upon deposit.
    /// @param depositInput Contains the permit, depositor, deposit witness, deposit signature, reserve witness, and reserve signature
    /// @return depositId Unique identifier for this payment (keccak256(depositor, signature, permit.nonce)) - use for release/refund
    function deposit(DepositInput calldata depositInput) external returns (bytes32 depositId);

    /// @notice Deposit many tokens into the escrow, each with their own permit, depositor, deposit witness, deposit signature, reserve witness, and reserve signature
    /// @dev Processes multiple deposits in a single transaction. Each deposit requires both deposit and reserve signatures
    /// to set the settler immediately. Each deposit generates a unique depositId as keccak256(depositor, signature, permit.nonce).
    /// @param depositInputs Contains the permit, depositor, deposit witness, deposit signature, reserve witness, and reserve signature for each deposit
    /// @return depositIds Contains the deposit ID for each deposit
    function depositMany(DepositInput[] calldata depositInputs) external returns (bytes32[] memory depositIds);

    /// @notice Deposit `amount` from the owner account (`msg.sender`), pulled against the approval
    ///         it gave the escrow in the same batch, for accounts that cannot sign a Permit2
    ///         message (Tempo access keys). The deposit is stored unreserved, with no fee;
    ///         `reserve()` sets settler and quote and charges the winning quote.
    ///         Tempo meters an access key's spending limit on the key's own `approve`, not on this
    ///         pull: the root account must never leave an allowance to the escrow, or a key scoped
    ///         to this function could spend it past its limit.
    /// @dev depositId = keccak256(abi.encode(DIRECT_DEPOSIT_DOMAIN_TAG, block.chainid,
    ///      address(this), msg.sender, token, nonce, depositWitnessHash, amount)), with
    ///      DIRECT_DEPOSIT_DOMAIN_TAG = keccak256("Escrow:directDeposit:v1"), so it is
    ///      domain-separated from the Permit2 derivation. Emits `Deposited` (settler, quoteHash and
    ///      feeAmount zero) and `DepositCommitments` as `deposit()` does, with `msg.sender` as the
    ///      depositor. Reverts `NonExactTransfer` unless the escrow receives exactly `amount`.
    ///      Fee configuration is snapshotted before the pull; getDirectDepositFeeConfig exposes
    ///      it until reservation or unreserved refund. Later admin updates cannot change its terms.
    ///      The nonce bitmap word (`nonce >> 8`) is never cleared: sequential nonces per owner share
    ///      one slot across 256 deposits, random ones write a new slot each time.
    /// @param input The direct deposit input
    /// @return depositId The derived deposit id
    function directDeposit(DirectDepositInput calldata input) external returns (bytes32 depositId);

    /// @notice Set settler and quote on an unreserved direct deposit, with the reserver's signature,
    ///         and charge the winning quote's source amount.
    /// @dev Rebuilds the unreserved ActiveDeposit tuple from the input and requires it to hash to
    ///      the value stored under `reserveWitness.depositId` (an already-reserved deposit fails
    ///      this as `InvalidWitnessValues`); only `directDeposit` stores an unreserved tuple, so the
    ///      match binds the id without re-deriving it. No deadline: a valid signature can be
    ///      submitted until the deposit is reserved or its depositor refunds it with
    ///      `refundUnreserved`. Checks settler and quoteHash non-zero and
    ///      `0 < sourceAmount <= amount`, verifies the reserver signature as `deposit()` does,
    ///      then rewrites the stored hash with
    ///      settler, quote, `amount = sourceAmount` and the fee on it (token config locked at
    ///      deposit time), emits `DepositReserved` and, last, sends `amount - sourceAmount` back to the
    ///      depositor. No caller restriction: the signature is the gate. Release then works
    ///      unchanged on the charged amount.
    /// @param input The reserve input
    function reserve(ReserveInput calldata input) external;

    /// @notice Release the deposit to the settler (requires the settler to be set, by deposit() or reserve())
    /// @dev This function validates that all witness data matches the stored deposit hash,
    /// then clears storage after completion. Subsequent calls will fail with DepositNotFound.
    /// The full witness data is hashed and included in the EIP-712 signature.
    /// @param releaseInput Contains full deposit information including the settler
    function release(ReleaseInput calldata releaseInput) external;

    /// @notice Release many deposits, each with their own release signature, in the same transaction.
    /// @dev This function validates that all witness data matches the stored deposit hash,
    /// then clears storage after completion. Subsequent calls will fail with DepositNotFound.
    /// The full witness data is hashed and included in the EIP-712 signature.
    /// @param releaseInputs Contains full deposit information for each deposit
    function releaseMany(ReleaseInput[] calldata releaseInputs) external;

    /// @notice Refund the deposit back to the original depositor
    /// @dev Reserved deposits only: a zero quoteHash reverts `QuoteHashCannotBeEmpty`, so an
    /// unreserved direct deposit is refunded by its depositor with `refundUnreserved` instead.
    /// This function validates that all witness data matches the stored deposit hash,
    /// then clears storage after completion. Subsequent calls will fail with DepositNotFound.
    /// The full witness data is hashed and included in the EIP-712 signature.
    /// @param refundInput Contains full deposit information
    function refund(RefundInput calldata refundInput) external;

    /// @notice Refund many deposits, each with their own refund signature, in the same transaction.
    /// @dev This function validates that all witness data matches the stored deposit hash,
    /// then clears storage after completion. Subsequent calls will fail with DepositNotFound.
    /// The full witness data is hashed and included in the EIP-712 signature.
    /// @param refundInputs Contains full deposit information for each deposit
    function refundMany(RefundInput[] calldata refundInputs) external;

    /// @notice Refund an unreserved direct deposit to its depositor, called by the depositor alone.
    /// @dev No signature: the caller must be the account that called `directDeposit` (the Tempo root
    ///      account when an access key signed the batch). Rebuilds the unreserved tuple with
    ///      `depositor = msg.sender` and zero quoteHash, settler and feeAmount, and requires it to
    ///      hash to the stored value, so another caller or a reserved deposit fails as
    ///      `InvalidWitnessValues`. The race with `reserve()` is settled by source-chain ordering:
    ///      whichever lands first clears or rewrites the slot, and the other reverts. A settler
    ///      must therefore authorize fulfillment only after its own `reserve()` is final. Clears the
    ///      slot, then transfers the full deposited amount and emits `Refunded`. `whenNotPaused`,
    ///      like every transition.
    /// @param input The unreserved tuple members
    function refundUnreserved(RefundUnreservedInput calldata input) external;

    // View Functions

    /// @notice Get the deposit hash for an active deposit
    /// @dev Returns keccak256 hash of the ActiveDeposit struct for active deposits,
    /// or bytes32(0) for completed or non-existent deposits.
    /// To verify deposit details, compute keccak256(abi.encode(activeDeposit)) and compare.
    /// @param depositId The unique deposit identifier (from deposit function)
    /// @return Hash of the deposit information, or zero bytes if not found
    function getDepositHash(bytes32 depositId) external view returns (bytes32);
}
