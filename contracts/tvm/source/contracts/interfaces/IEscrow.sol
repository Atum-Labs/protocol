// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0; // @aderyn-ignore

import {ISignatureTransfer} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";

/**
 * @title IEscrow
 * @notice Escrow interface for the Escrow contract - manages token deposits with hash-based storage
 *
 * @dev QUICK START:
 * 1. Call deposit() with both deposit and reserve signatures → get unique depositId back with settler set
 * 2. Use depositId for release()/refund() operations
 *
 * Storage is cleared after completion for gas optimization
 *
 * @dev DEPOSIT IDENTIFIER:
 * - depositId: Contract-generated unique key (keccak256(depositor, signature, permit.nonce), use for operations)
 *
 * @dev STORAGE OPTIMIZATION:
 * - Deposits are stored as keccak256 hashes instead of full structs
 * - All operations validate witness data against stored hashes
 * - Significantly reduces gas costs for storage operations
 * - Hash validation ensures data integrity
 *
 * @dev SECURITY:
 * - depositId uniqueness guaranteed by Permit2's nonce bitmap (2^256-1 capacity)
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
 */
interface IEscrow {
    /// @dev DepositInput contains all data required for a single deposit operation
    /// @param permit Permit2 permit structure containing token, amount, nonce, and deadline
    /// @param depositor Address that owns the tokens and signed the permit
    /// @param depositWitness Contains authorized reserver and releaser addresses
    /// @param depositSignature EIP-712 signature from depositor authorizing the transfer via Permit2
    /// @param reserveWitness Contains full deposit information and the settler address to set
    /// @param reserveSignature EIP-712 signature from the authorized reserver address
    struct DepositInput {
        ISignatureTransfer.PermitTransferFrom permit;
        address depositor;
        DepositWitness depositWitness;
        bytes depositSignature;
        ReserveWitness reserveWitness;
        bytes reserveSignature;
    }

    /// @dev DepositWitness is used for the initial deposit operation with Permit2
    /// @param depositRequestHash Depositor-signed commitment to the offchain deposit request details.
    /// Its derivation is defined by the offchain protocol layer, not by this contract.
    /// @param destination Plaintext destination the payer commits to, as `<CAIP-19 asset>@<account>`.
    /// Lowercase throughout EXCEPT base58 segments (Solana genesis reference, SPL mint, account), which
    /// are case-significant and preserved. The contract validates length only (1..256 bytes) and is
    /// otherwise format-agnostic: producer and consumer must emit byte-identical strings, because the
    /// commitment is keccak256(bytes(destination)).
    /// @param reserver Address authorized to reserve deposits (sign ReserveWitness)
    /// @param releaser Address authorized to release/refund deposits (sign ReleaseWitness/RefundWitness)
    struct DepositWitness {
        bytes32 depositRequestHash;
        string destination;
        address reserver;
        address releaser;
    }

    /// @dev ReserveWitness is used during the deposit operation to set the settler.
    /// The reserver signs this witness to designate which settler can claim the escrowed funds.
    /// The depositId cryptographically commits to all deposit details (via the depositor's signature),
    /// so signing the depositId is equivalent to agreeing to those terms.
    /// @param depositId The unique deposit identifier (generated as keccak256(depositor, signature, permit.nonce))
    /// @param quoteHash The offchain quote hash
    /// @param settler The address that will receive tokens upon release
    /// @param sourceAmount The winning quote's source amount — the actual charge, attested by the reserver (<= permit cap)
    struct ReserveWitness {
        bytes32 depositId;
        bytes32 quoteHash;
        address settler;
        uint256 sourceAmount;
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
    /// @param depositId The unique deposit identifier (generated as keccak256(depositor, signature, permit.nonce))
    /// @param quoteHash The offchain quote hash (must match what was set at deposit)
    /// @param depositRequestHash The depositor-signed deposit-request commitment (must match stored deposit)
    /// @param destinationHash keccak256(bytes(destination)) of the committed destination (must match stored deposit)
    /// @param depositor The original depositor address (must match stored deposit)
    /// @param token The token address (must match stored deposit)
    /// @param amount The token amount (must match stored deposit)
    /// @param feeAmount The amount of tokens deducted as protocol fee (in token's native decimals)
    /// @param reserver The authorized reserver address (must match stored deposit)
    /// @param releaser The authorized releaser address (must match stored deposit)
    /// @param settler The settler address (must match what was set during deposit)
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
    /// @param depositId The unique deposit identifier (generated as keccak256(depositor, signature, permit.nonce))
    /// @param quoteHash The offchain quote hash (must match what was set at deposit)
    /// @param depositRequestHash The depositor-signed deposit-request commitment (must match stored deposit)
    /// @param destinationHash keccak256(bytes(destination)) of the committed destination (must match stored deposit)
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

    /// @dev ActiveDeposit represents the complete state of an active deposit
    /// @notice This struct is not stored directly; its keccak256 hash is stored for gas optimization.
    /// When a deposit is completed (released or refunded), the hash is cleared to bytes32(0).
    /// @param depositor The address that created the deposit and owns the tokens
    /// @param quoteHash The offchain quote hash
    /// @param depositRequestHash The depositor-signed commitment to the offchain deposit request
    /// @param destinationHash keccak256(bytes(destination)) of the depositor-committed destination.
    /// Only the hash is kept so ActiveDeposit stays a fixed-width tuple; the plaintext destination
    /// never enters storage. On deposit() it is recoverable from the transaction calldata and from the
    /// DepositCommitments event; on depositMany() the DepositedMany event carries the plaintext in its
    /// DepositWitness[] array.
    /// @param token The ERC20 token address being escrowed
    /// @param amount The amount of tokens deposited (in token's native decimals)
    /// @param feeAmount The amount of tokens to be deducted as protocol fee on release (in token's native decimals)
    /// @param reserver The address that signed the reserve witness during deposit
    /// @param releaser The address authorized to sign release or refund witnesses
    /// @param settler The address that will receive tokens on release (set during deposit)
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

    /// @notice Emitted alongside Deposited so a log-only consumer can rebuild a Release/RefundWitness.
    /// @dev Emitted from deposit() ONLY. depositMany() deliberately does not emit it: DepositedMany
    /// already carries the full DepositWitness[] (9 of the 11 settlement-witness members; depositor and
    /// token come from the item's ERC-20 Transfer log), so emitting per item would pay gas x N to
    /// duplicate data already in the log.
    /// @param depositId The unique deposit identifier (indexed for filtering)
    /// @param depositRequestHash The depositor-signed deposit-request commitment
    /// @param destinationHash keccak256(bytes(destination)) of the committed destination
    event DepositCommitments(bytes32 indexed depositId, bytes32 depositRequestHash, bytes32 destinationHash);

    /// @notice Emitted when a new deposit is created
    /// @param depositId Contract-generated unique identifier (indexed for filtering)
    /// @param quoteHash The offchain quote hash (indexed for filtering)
    /// @param depositor The address that created the deposit (indexed for filtering)
    /// @param settler The address that will receive tokens on release (non-indexed, readable)
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

    /// @notice Emitted when many new deposits are created
    /// @dev Arrays are non-indexed to preserve data (indexed arrays are hashed and unreadable)
    /// @param depositIds The deposit ids
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

    /// @notice USDT cannot be zero
    error USDTCannotBeZeroAddress();

    /// @notice Depositor address cannot be zero
    error DepositCannotBeZeroAddress();

    /// @notice Reserver address cannot be zero
    error ReserverCannotBeZeroAddress();

    /// @notice Releaser address cannot be zero
    error ReleaserCannotBeZeroAddress();

    /// @notice Deposit amount cannot be zero
    error DepositAmountCannotBeZero();

    /// @notice Source amount must be non-zero and within the permit's authorized ceiling
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

    /// @notice The depositor-signed deposit-request commitment cannot be zero
    error DepositRequestHashCannotBeEmpty();

    /// @notice The committed destination cannot be empty
    error DestinationCannotBeEmpty();

    /// @notice The committed destination exceeds MAX_DESTINATION_BYTES
    error DestinationTooLong(uint256 length);

    /// @notice The escrow's balance did not move by exactly the amount the deposit is credited for
    /// @dev Measured across the Permit2 pull as balanceAfter - balanceBefore. Deliberately an
    /// EQUALITY check, not `>=`: a short delivery (fee-on-transfer) would credit a deposit with
    /// tokens that never arrived and pay the shortfall out of the shared pool, while an inflated
    /// delivery would leave unattributed dust that no release or refund can move. Both are rejected.
    ///
    /// This mirrors the EVM escrow. It matters at least as much here: USDT is the dominant Tron
    /// stablecoin and TetherToken carries an owner-settable transfer fee, currently zero. The
    /// allowlist is checked at configuration time, not per transfer, so an allowlisted token can
    /// acquire a fee afterwards and start short-delivering into a pooled balance.
    /// @param expected The amount the deposit is credited for (the source amount)
    /// @param received The escrow balance delta actually observed across the transfer
    error NonExactTransfer(uint256 expected, uint256 received);

    /// @notice A USDT payout did not move the escrow's balance by the amount it was asked to send
    /// @dev USDT cannot be routed through SafeERC20 on Tron (see `_usdtTransfer` in Escrow.sol), so
    /// its success is established by measuring the balance instead of by trusting a return value.
    /// This error means the raw call returned without reverting AND without moving the tokens, which
    /// no known USDT behaviour produces — it exists so that outcome can never be mistaken for a
    /// completed settlement.
    /// @param expected The amount the payout was supposed to send
    /// @param observed The decrease in the escrow's USDT balance actually measured
    error UsdtTransferDidNotMove(uint256 expected, uint256 observed);

    // Core Functions

    /// @notice Deposit and reserve the deposit for a specific settler address, using Permit2 signature
    /// @dev The returned depositId is generated as keccak256(depositor, signature, permit.nonce) and must be used for all subsequent operations.
    /// This function requires both deposit and reserve signatures to set the settler immediately upon deposit.
    /// @param depositInput Contains the permit, depositor, deposit witness, deposit signature, reserve witness, and reserve signature
    /// @return depositId Unique deposit identifier (keccak256(depositor, signature, permit.nonce)) - use for release/refund
    function deposit(DepositInput calldata depositInput) external returns (bytes32 depositId);

    /// @notice Deposit many tokens into the escrow, each with their own permit, depositor, deposit witness, deposit signature, reserve witness, and reserve signature
    /// @dev Processes multiple deposits in a single transaction. Each deposit requires both deposit and reserve signatures
    /// to set the settler immediately. Each deposit generates a unique depositId as keccak256(depositor, signature, permit.nonce).
    /// @param depositInputs Contains the permit, depositor, deposit witness, deposit signature, reserve witness, and reserve signature for each deposit
    /// @return depositIds Contains the deposit id for each deposit
    function depositMany(DepositInput[] calldata depositInputs) external returns (bytes32[] memory depositIds);

    /// @notice Release the deposit to the settler (requires settler to be set during deposit())
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
    /// @dev This function validates that all witness data matches the stored deposit hash,
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

    // View Functions

    /// @notice Get the deposit hash for an active deposit
    /// @dev Returns keccak256 hash of the ActiveDeposit struct for active deposits,
    /// or bytes32(0) for completed or non-existent deposits.
    /// To verify deposit details, compute keccak256(abi.encode(activeDeposit)) and compare.
    /// @param depositId The unique deposit identifier (from deposit function)
    /// @return Hash of the deposit information, or zero bytes if not found
    function getDepositHash(bytes32 depositId) external view returns (bytes32);
}
