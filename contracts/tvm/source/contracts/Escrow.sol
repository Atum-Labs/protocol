// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IPermit2, ISignatureTransfer} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";
import {TIP712} from "./TIP712.sol";
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEscrow} from "./interfaces/IEscrow.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ITokenConfig} from "./interfaces/ITokenConfig.sol";

contract Escrow is IEscrow, ITokenConfig, TIP712, AccessControlDefaultAdminRules, Pausable {
    using SafeERC20 for IERC20;
    using SignatureChecker for address;

    // Roles
    // Pauser role can pause and unpause the contract
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    // Treasurer role can withdraw fees from the contract
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");
    // Token config role can configure token fees
    bytes32 public constant TOKEN_CONFIG_ROLE = keccak256("TOKEN_CONFIG_ROLE");

    // EIP-712 Witnesses
    // Full type string for Permit2 deposit witness
    string private constant FULL_DEPOSIT_WITNESS_TYPE_STRING =
        "DepositWitness witness)DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)TokenPermissions(address token,uint256 amount)";
    // Type string hash for EIP-712 deposit witness
    // keccak256("DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)");
    bytes32 private constant DEPOSIT_WITNESS_TYPE_HASH =
        0x49bfb2c307c3a42001389497e5f5b9dc592052768c1f3cdf09aac3c58ec582b9;
    // Type string for EIP-712 reserve witness
    // keccak256("ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)");
    bytes32 private constant RESERVE_WITNESS_TYPE_HASH =
        0x231586e09714868d376f25b00c3a8dc8e307d350b64e22fbeb6578bb7bc6fd87;
    // Type string for EIP-712 release witness
    // keccak256("ReleaseWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)");
    bytes32 private constant RELEASE_WITNESS_TYPE_HASH =
        0x7b53386f16fef70a2a3ea71bda140486e6167753168b12a94b218b94de37fe7b;
    // Type string for EIP-712 refund witness
    // keccak256("RefundWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)");
    bytes32 private constant REFUND_WITNESS_TYPE_HASH =
        0x3b5d88b2664086649c47fb1bddafbc2c1f05c6be52fb1c1f11c53db3c608772d;

    // Maximum byte length of the depositor-committed destination string.
    // Uniform 256 across EVM/TVM/SVM so one client signing-policy rule covers every chain.
    // Only the keccak256 of the destination is stored, so this bounds calldata and log size, not storage.
    uint256 private constant MAX_DESTINATION_BYTES = 256;

    // Maximum supported token decimals to prevent overflow in fee calculations
    // Tokens with >30 decimals and large supplies could overflow uint256 during fee calculation
    uint8 private constant MAX_TOKEN_DECIMALS = 30;

    // Permit2 contract
    IPermit2 public immutable i_permit2;

    // USDT on Tron, special-cased because it cannot be routed through SafeERC20: a SUCCESSFUL
    // transfer returns false, while failures revert. Not "always returns false" — the distinction is
    // the whole reason SafeERC20 would brick this contract. See `_usdtTransfer` for the evidence and
    // for how success is actually established.
    IERC20 public immutable i_usdt;

    // Allowlist for tokens that are allowed to be used for deposits
    mapping(IERC20 token => TokenConfig tokenConfig) private s_tokenConfigs;
    IERC20[] private s_allowlistedTokens;

    // Total fees collected for each token
    mapping(IERC20 token => uint256 feeRevenue) private s_tokenFeeRevenue;

    /// @dev Mapping of depositId to keccak256 hash of ActiveDeposit struct
    /// @dev This replaces direct storage of ActiveDeposit structs for gas optimization
    /// @dev Hash validation ensures data integrity while reducing storage costs
    mapping(bytes32 depositId => bytes32 activeDepositHash) private s_activeDepositHashes;

    /**
     * @notice Deploys the Escrow contract with Permit2 integration and role-based access control.
     * @param permit2 The Permit2 contract address (immutable after deployment)
     * @param defaultAdmin The initial default admin address (typically the deployer)
     * @dev The initial admin transfer delay is set to 1 second for deployment convenience.
     *      This delay only governs DEFAULT_ADMIN_ROLE transfers and delay changes — it does
     *      NOT affect grantRole/revokeRole calls, which are immediate for any admin.
     *      The low delay allows the deployer to quickly:
     *      1. Transfer DEFAULT_ADMIN_ROLE to a multisig (the only step gated by this delay)
     *
     *      Granting operational roles (PAUSER_ROLE, TREASURER_ROLE, TOKEN_CONFIG_ROLE) is
     *      immediate and can happen before or after the transfer.
     *
     *      After the multisig accepts admin, it SHOULD increase the delay by calling
     *      `changeDefaultAdminDelay(newDelay)` with an appropriate value (e.g., 2 days).
     *      The delay change is also scheduled, providing additional protection.
     */
    constructor(IPermit2 permit2, IERC20 usdt, address defaultAdmin)
        TIP712("Escrow", "3") // TIP-712 domain for Escrow contract
        AccessControlDefaultAdminRules(1, defaultAdmin)
    {
        if (address(permit2) == address(0)) revert Permit2CannotBeZeroAddress();
        if (address(usdt) == address(0)) revert USDTCannotBeZeroAddress();
        i_permit2 = permit2;
        i_usdt = usdt;
    }

    ////////////////////////
    /// ESCROW FUNCTIONS ///
    ////////////////////////

    /// @inheritdoc IEscrow
    function deposit(DepositInput calldata depositInput) external whenNotPaused returns (bytes32 depositId) {
        TokenConfig memory tokenConfig = s_tokenConfigs[IERC20(depositInput.permit.permitted.token)];
        // Check that the token is allowlisted
        if (tokenConfig.tokenDecimals == 0) revert TokenNotAllowed(IERC20(depositInput.permit.permitted.token));
        // Fee and escrowed amount are the winning source amount (the actual charge), not the permit cap.
        uint256 feeAmount = determineFee(depositInput.reserveWitness.sourceAmount, tokenConfig);
        depositId = _deposit(depositInput, feeAmount);
        emit Deposited(
            depositId,
            depositInput.reserveWitness.quoteHash,
            depositInput.depositor,
            depositInput.reserveWitness.settler,
            depositInput.permit.permitted.token,
            depositInput.reserveWitness.sourceAmount,
            feeAmount,
            depositInput.depositWitness.reserver,
            depositInput.depositWitness.releaser
        );
        // Emitted from deposit() ONLY. The flat Deposited event above is deliberately unchanged so its
        // topic0 stays stable for deployed indexers; this companion event carries the two commitments so
        // a log-only consumer can still rebuild a Release/RefundWitness on the single-deposit path.
        emit DepositCommitments(
            depositId,
            depositInput.depositWitness.depositRequestHash,
            keccak256(bytes(depositInput.depositWitness.destination))
        );
    }

    /// @inheritdoc IEscrow
    /// @dev To optimize for gas, the offchain caller should order the deposits by token.
    /// This makes the most effective use of the storage cache in the loop.
    function depositMany(DepositInput[] calldata depositInputs)
        external
        whenNotPaused
        returns (bytes32[] memory depositIds)
    {
        depositIds = new bytes32[](depositInputs.length);
        DepositWitness[] memory depositWitnesses = new DepositWitness[](depositInputs.length);
        ReserveWitness[] memory reserveWitnesses = new ReserveWitness[](depositInputs.length);
        uint256[] memory feeAmounts = new uint256[](depositInputs.length);

        // Optimization: cache the latest token and token config
        IERC20 currentToken;
        TokenConfig memory currentConfig;
        for (uint256 i; i < depositInputs.length; i++) {
            IERC20 token = IERC20(depositInputs[i].permit.permitted.token);

            // Only read from storage if the token has changed
            // i == 0 ensures first token always triggers allowlist check regardless of its address
            if (i == 0 || token != currentToken) {
                currentToken = token;
                currentConfig = s_tokenConfigs[token];
                if (currentConfig.tokenDecimals == 0) revert TokenNotAllowed(token);
            }

            uint256 feeAmount = determineFee(depositInputs[i].reserveWitness.sourceAmount, currentConfig);
            depositIds[i] = _deposit(depositInputs[i], feeAmount);
            feeAmounts[i] = feeAmount;
            depositWitnesses[i] = depositInputs[i].depositWitness;
            reserveWitnesses[i] = depositInputs[i].reserveWitness;
        }
        emit DepositedMany(depositIds, depositWitnesses, reserveWitnesses, feeAmounts);
    }

    function _deposit(DepositInput calldata depositInput, uint256 feeAmount) private returns (bytes32 depositId) {
        // We use code blocks to scope variables and avoid stack too deep errors
        // Basic requirements block
        {
            // Check that the depositor is not the zero address
            if (depositInput.depositor == address(0)) revert DepositCannotBeZeroAddress();
            // Check that the reserver is not the zero address
            if (depositInput.depositWitness.reserver == address(0)) revert ReserverCannotBeZeroAddress();
            // Check that the releaser is not the zero address
            if (depositInput.depositWitness.releaser == address(0)) revert ReleaserCannotBeZeroAddress();
            // Check that the settler is not the zero address
            if (depositInput.reserveWitness.settler == address(0)) revert SettlerCannotBeZeroAddress();
            // Check that the offchain quote hash is not empty
            if (depositInput.reserveWitness.quoteHash == bytes32(0)) revert QuoteHashCannotBeEmpty();
            // Check that the depositor-signed deposit-request commitment is not zero.
            // Deposit path only: once this is rejected here no stored deposit can carry a zero value,
            // and the settlement hash-equality check already binds the field.
            if (depositInput.depositWitness.depositRequestHash == bytes32(0)) {
                revert DepositRequestHashCannotBeEmpty();
            }
            // Check the committed destination is non-empty and within the size cap.
            // Enforced in-contract because ingress validation is bypassable by calling deposit() directly.
            uint256 destinationLength = bytes(depositInput.depositWitness.destination).length;
            if (destinationLength == 0) revert DestinationCannotBeEmpty();
            if (destinationLength > MAX_DESTINATION_BYTES) revert DestinationTooLong(destinationLength);
            // Check that the amount is not zero
            if (depositInput.permit.permitted.amount == 0) revert DepositAmountCannotBeZero();
            // The winning source amount is the charge; the permit amount is only an authorization ceiling
            if (
                depositInput.reserveWitness.sourceAmount == 0
                    || depositInput.reserveWitness.sourceAmount > depositInput.permit.permitted.amount
            ) revert InvalidSourceAmount();
            // Generate a deposit ID from the depositor, signature, and permit nonce
            // This prevents griefing attacks where a malicious actor could front-run with another user's signature
            depositId =
                keccak256(abi.encode(depositInput.depositor, depositInput.depositSignature, depositInput.permit.nonce));
            // Check that the deposit ID matches the reserve witness deposit ID
            if (depositId != depositInput.reserveWitness.depositId) {
                revert DepositNotFound(depositInput.reserveWitness.depositId);
            }
            // Check if the deposit already exists (either active or completed)
            if (s_activeDepositHashes[depositId] != bytes32(0)) revert DepositAlreadyExists(depositId);
        }

        // Validation and storage block
        {
            // Create active deposit for storage using deposit input fields
            // (reserveWitness supplies quoteHash, settler, and sourceAmount; the rest come from depositInput)
            ActiveDeposit memory activeDeposit = ActiveDeposit({
                depositor: depositInput.depositor,
                quoteHash: depositInput.reserveWitness.quoteHash,
                depositRequestHash: depositInput.depositWitness.depositRequestHash,
                destinationHash: keccak256(bytes(depositInput.depositWitness.destination)),
                token: depositInput.permit.permitted.token,
                amount: depositInput.reserveWitness.sourceAmount,
                feeAmount: feeAmount,
                reserver: depositInput.depositWitness.reserver,
                releaser: depositInput.depositWitness.releaser,
                settler: depositInput.reserveWitness.settler
            });
            bytes32 activeDepositHash = keccak256(abi.encode(activeDeposit));
            // Store the active deposit hash
            s_activeDepositHashes[depositId] = activeDepositHash;
        }

        // Reserve signature verification block
        // We verify the reserve signature before the deposit signature so that the external call to permit2 happens last
        {
            // Verify reserver signature using TIP-712 with minimal witness data
            // The depositId cryptographically commits to all deposit details via the depositor's signature
            bytes32 reserveWitnessHash = keccak256(
                abi.encode(
                    RESERVE_WITNESS_TYPE_HASH,
                    depositInput.reserveWitness.depositId,
                    depositInput.reserveWitness.quoteHash,
                    depositInput.reserveWitness.settler,
                    depositInput.reserveWitness.sourceAmount
                )
            );
            bytes32 reserveWitnessDigest = _hashTypedData(reserveWitnessHash);
            // Check that recovered address is the reserver from the original deposit witness
            if (!depositInput.depositWitness.reserver
                    .isValidSignatureNow(reserveWitnessDigest, depositInput.reserveSignature)) revert InvalidSignature();
        }

        // Deposit signature verification block (permit2 transfer)
        {
            // Execute permit2 transfer WITH witness validation
            // EIP-712 hashes a dynamic `string` member as keccak256(bytes(value)).
            // Passing the raw string emits offset+len+data and matches no signer.
            bytes32 depositWitnessHash = keccak256(
                abi.encode(
                    DEPOSIT_WITNESS_TYPE_HASH,
                    depositInput.depositWitness.depositRequestHash,
                    keccak256(bytes(depositInput.depositWitness.destination)),
                    depositInput.depositWitness.reserver,
                    depositInput.depositWitness.releaser
                )
            );
            // Measure what the escrow actually receives, rather than trusting the requested amount.
            // Every deposit shares one pooled balance and the stored ActiveDeposit is credited with
            // sourceAmount, so a token that delivers less than it is asked for would have the
            // shortfall silently covered by other depositors' funds until a later release or refund
            // hits an empty pool and reverts. Refund is the escape hatch and there is no rescue
            // function, so those funds would be stranded.
            //
            // Snapshotted PER CALL, inside _deposit, not once around the depositMany loop: two items
            // of the same token in one batch must each be checked against their own delta.
            IERC20 depositToken = IERC20(depositInput.permit.permitted.token);
            uint256 balanceBefore = depositToken.balanceOf(address(this));
            // Execute permit2 transfer WITH witness validation
            i_permit2.permitWitnessTransferFrom(
                depositInput.permit,
                ISignatureTransfer.SignatureTransferDetails({
                    to: address(this), requestedAmount: depositInput.reserveWitness.sourceAmount
                }),
                depositInput.depositor,
                depositWitnessHash,
                FULL_DEPOSIT_WITNESS_TYPE_STRING,
                depositInput.depositSignature
            );
            // Equality, not `>=`: `>=` would still accept a transfer hook that INFLATES the balance,
            // leaving dust in the pool that no witness can account for. A balance that DECREASES
            // across the transfer underflows here and reverts with a panic rather than this error --
            // still a revert, still no credit.
            uint256 received = depositToken.balanceOf(address(this)) - balanceBefore;
            if (received != depositInput.reserveWitness.sourceAmount) {
                revert NonExactTransfer(depositInput.reserveWitness.sourceAmount, received);
            }
        }
    }

    /// @inheritdoc IEscrow
    function release(ReleaseInput calldata releaseInput) external whenNotPaused {
        _release(releaseInput);
        emit Released(
            releaseInput.releaseWitness.depositId,
            releaseInput.releaseWitness.settler,
            releaseInput.releaseWitness.token,
            releaseInput.releaseWitness.amount,
            releaseInput.releaseWitness.feeAmount
        );
    }

    /// @inheritdoc IEscrow
    function releaseMany(ReleaseInput[] calldata releaseInputs) external whenNotPaused {
        ReleaseWitness[] memory releaseWitnesses = new ReleaseWitness[](releaseInputs.length);
        for (uint256 i; i < releaseInputs.length; i++) {
            _release(releaseInputs[i]);
            releaseWitnesses[i] = releaseInputs[i].releaseWitness;
        }
        emit ReleasedMany(releaseWitnesses);
    }

    /// 1. Validate settler is set (non-zero)
    /// 2. Reconstruct ActiveDeposit from witness data (including settler)
    /// 3. Compute hash and compare against stored hash
    /// 4. Clear storage (delete hash) before token transfer
    /// 5. Verify TIP-712 signature includes all witness fields
    /// Storage clearing provides replay protection - subsequent calls fail.
    function _release(ReleaseInput calldata releaseInput) private {
        // Check if settler is set (cannot release without settler)
        if (releaseInput.releaseWitness.settler == address(0)) {
            revert NotReserved(releaseInput.releaseWitness.depositId);
        }

        // Check that the offchain quote hash is not empty
        if (releaseInput.releaseWitness.quoteHash == bytes32(0)) revert QuoteHashCannotBeEmpty();

        // Check if deposit exists
        bytes32 activeDepositHash = s_activeDepositHashes[releaseInput.releaseWitness.depositId];
        if (activeDepositHash == bytes32(0)) revert DepositNotFound(releaseInput.releaseWitness.depositId);

        // Reconstruct ActiveDeposit from witness (must include settler)
        ActiveDeposit memory passedActiveDeposit = ActiveDeposit({
            depositor: releaseInput.releaseWitness.depositor,
            quoteHash: releaseInput.releaseWitness.quoteHash,
            depositRequestHash: releaseInput.releaseWitness.depositRequestHash,
            destinationHash: releaseInput.releaseWitness.destinationHash,
            token: releaseInput.releaseWitness.token,
            amount: releaseInput.releaseWitness.amount,
            feeAmount: releaseInput.releaseWitness.feeAmount,
            reserver: releaseInput.releaseWitness.reserver,
            releaser: releaseInput.releaseWitness.releaser,
            settler: releaseInput.releaseWitness.settler // Must match what was set during deposit
        });

        // Validate witness data matches stored deposit (including settler)
        bytes32 passedHash = keccak256(abi.encode(passedActiveDeposit));
        if (activeDepositHash != passedHash) {
            revert InvalidWitnessValues(releaseInput.releaseWitness.depositId, activeDepositHash, passedHash);
        }

        // Clear storage before transfer (prevents reentrancy)
        delete s_activeDepositHashes[releaseInput.releaseWitness.depositId];

        // Verify releaser signature using TIP-712 with full witness data
        bytes32 structHash = keccak256(
            abi.encode(
                RELEASE_WITNESS_TYPE_HASH,
                releaseInput.releaseWitness.depositId,
                releaseInput.releaseWitness.quoteHash,
                releaseInput.releaseWitness.depositRequestHash,
                releaseInput.releaseWitness.destinationHash,
                releaseInput.releaseWitness.depositor,
                releaseInput.releaseWitness.token,
                releaseInput.releaseWitness.amount,
                releaseInput.releaseWitness.feeAmount,
                releaseInput.releaseWitness.reserver,
                releaseInput.releaseWitness.releaser,
                releaseInput.releaseWitness.settler
            )
        );

        bytes32 digest = _hashTypedData(structHash);

        // Check that recovered address is the releaser
        if (!releaseInput.releaseWitness.releaser.isValidSignatureNow(digest, releaseInput.releaseSignature)) {
            revert InvalidSignature();
        }

        // Transfer remaining tokens to settler
        if (IERC20(releaseInput.releaseWitness.token) == i_usdt) {
            _usdtTransfer(
                releaseInput.releaseWitness.settler,
                releaseInput.releaseWitness.amount - releaseInput.releaseWitness.feeAmount
            );
        } else {
            IERC20(releaseInput.releaseWitness.token)
                .safeTransfer(
                    releaseInput.releaseWitness.settler,
                    releaseInput.releaseWitness.amount - releaseInput.releaseWitness.feeAmount
                );
        }

        // Add fees to total fees collected for token
        s_tokenFeeRevenue[IERC20(releaseInput.releaseWitness.token)] += releaseInput.releaseWitness.feeAmount;
    }

    /// @inheritdoc IEscrow
    function refund(RefundInput calldata refundInput) external whenNotPaused {
        _refund(refundInput);
        emit Refunded(
            refundInput.refundWitness.depositId,
            refundInput.refundWitness.depositor,
            refundInput.refundWitness.token,
            refundInput.refundWitness.amount
        );
    }

    /// @inheritdoc IEscrow
    function refundMany(RefundInput[] calldata refundInputs) external whenNotPaused {
        RefundWitness[] memory refundWitnesses = new RefundWitness[](refundInputs.length);
        for (uint256 i; i < refundInputs.length; i++) {
            _refund(refundInputs[i]);
            refundWitnesses[i] = refundInputs[i].refundWitness;
        }
        emit RefundedMany(refundWitnesses);
    }

    /// @dev Hash validation workflow:
    /// 1. Reconstruct ActiveDeposit from witness data
    /// 2. Compute hash and compare against stored hash
    /// 3. Clear storage (delete hash) before token transfer
    /// 4. Verify EIP-712 signature includes all witness fields
    /// 5. Transfer tokens back to original depositor
    /// Storage clearing provides replay protection - subsequent calls fail.
    function _refund(RefundInput calldata refundInput) private {
        // Check that the offchain quote hash is not empty
        if (refundInput.refundWitness.quoteHash == bytes32(0)) revert QuoteHashCannotBeEmpty();

        // Check if deposit exists
        bytes32 activeDepositHash = s_activeDepositHashes[refundInput.refundWitness.depositId];
        if (activeDepositHash == bytes32(0)) revert DepositNotFound(refundInput.refundWitness.depositId);

        // Reconstruct ActiveDeposit from witness
        ActiveDeposit memory passedActiveDeposit = ActiveDeposit({
            depositor: refundInput.refundWitness.depositor,
            quoteHash: refundInput.refundWitness.quoteHash,
            depositRequestHash: refundInput.refundWitness.depositRequestHash,
            destinationHash: refundInput.refundWitness.destinationHash,
            token: refundInput.refundWitness.token,
            amount: refundInput.refundWitness.amount,
            feeAmount: refundInput.refundWitness.feeAmount,
            reserver: refundInput.refundWitness.reserver,
            releaser: refundInput.refundWitness.releaser,
            settler: refundInput.refundWitness.settler // Must match what was set during deposit
        });

        // Validate witness data matches stored deposit
        bytes32 passedHash = keccak256(abi.encode(passedActiveDeposit));
        if (activeDepositHash != passedHash) {
            revert InvalidWitnessValues(refundInput.refundWitness.depositId, activeDepositHash, passedHash);
        }

        // Clear storage before transfer (prevents reentrancy)
        delete s_activeDepositHashes[refundInput.refundWitness.depositId];

        // Verify releaser signature using EIP-712 with full witness data
        bytes32 structHash = keccak256(
            abi.encode(
                REFUND_WITNESS_TYPE_HASH,
                refundInput.refundWitness.depositId,
                refundInput.refundWitness.quoteHash,
                refundInput.refundWitness.depositRequestHash,
                refundInput.refundWitness.destinationHash,
                refundInput.refundWitness.depositor,
                refundInput.refundWitness.token,
                refundInput.refundWitness.amount,
                refundInput.refundWitness.feeAmount,
                refundInput.refundWitness.reserver,
                refundInput.refundWitness.releaser,
                refundInput.refundWitness.settler
            )
        );

        bytes32 digest = _hashTypedData(structHash);

        // Check that recovered address is the releaser
        if (!refundInput.refundWitness.releaser.isValidSignatureNow(digest, refundInput.refundSignature)) {
            revert InvalidSignature();
        }

        // Transfer tokens back to depositor
        if (IERC20(refundInput.refundWitness.token) == i_usdt) {
            _usdtTransfer(refundInput.refundWitness.depositor, refundInput.refundWitness.amount);
        } else {
            IERC20(refundInput.refundWitness.token)
                .safeTransfer(refundInput.refundWitness.depositor, refundInput.refundWitness.amount);
        }
    }

    /// @inheritdoc ITokenConfig
    /// @notice Calculates the protocol fee for a deposit based on token configuration
    /// @dev Fee calculation uses ceiling division to round in protocol's favor while maintaining precision.
    ///
    /// ## Algorithm Steps:
    /// 1. **Percentage Calculation**: Compute `⌈(amount × feePercentage) / 100_000_000⌉`
    ///    - Uses ceiling division: `(a * b + c - 1) / c` to round up
    ///    - Ensures protocol never loses fees due to rounding
    ///    - Single formula works for all token decimals (no scaling needed)
    ///
    /// 2. **Minimum Fee**: If `minFee6Decimals > 0` and calculated fee is below minimum, use minimum
    ///
    /// 3. **Maximum Fee**: If `maxFee6Decimals > 0` and calculated fee exceeds maximum, cap at maximum
    ///
    /// 4. **Safety Check**: Reverts if fee exceeds deposit amount (can happen with misconfigured high minFee on small deposits)
    ///
    /// ## Example (0.02% fee, $250 max, $100 USDC deposit):
    /// ```
    /// tokenDecimals = 6, feePercentage6Decimals = 20_000, maxFee6Decimals = 250_000_000
    /// feeAmount = ⌈(100e6 × 20_000) / 100_000_000⌉ = ⌈20_000⌉ = 20_000 = $0.02 ✓
    /// ```
    ///
    /// ## Overflow Safety:
    /// The multiplication `amount * feePercentage6Decimals` is safe for tokens with:
    /// - Decimals ≤ 30
    /// - Total supply < 10^60
    ///
    /// These constraints are enforced during token allowlisting. For reference:
    /// - uint256 max ≈ 1.15 × 10^77
    /// - Worst realistic case: 10^60 amount × 10^8 fee = 10^68 (safe)
    ///
    /// Tokens with >30 decimals or extreme supplies (>10^60) are NOT supported and will cause overflow.
    ///
    /// @param amount The deposit amount in the token's native decimals
    /// @param tokenConfig Token configuration containing fee parameters and decimals
    /// @return feeAmount The calculated fee in the token's native decimals (rounded up in protocol's favor)
    function determineFee(uint256 amount, TokenConfig memory tokenConfig) public pure returns (uint256 feeAmount) {
        // If no amount, return 0
        if (amount == 0) {
            return 0;
        }

        // Calculate percentage fee using ceiling division (rounds up in protocol's favor)
        // Formula: ⌈(a × b) / c⌉ = (a × b + c - 1) / c
        if (tokenConfig.feePercentage6Decimals > 0) {
            feeAmount = (amount * tokenConfig.feePercentage6Decimals + 100_000_000 - 1) / 100_000_000;
        }

        // Minimum fee protection: scale minFee from 10^6 to token decimals
        if (tokenConfig.minFee6Decimals > 0) {
            uint256 minFee =
                (uint256(tokenConfig.minFee6Decimals) * (10 ** uint256(tokenConfig.tokenDecimals))) / 1_000_000;
            if (feeAmount < minFee) {
                feeAmount = minFee;
            }
        }

        // Cap the fee amount at the maximum fee amount (if configured)
        if (tokenConfig.maxFee6Decimals > 0) {
            uint256 maxFee =
                (uint256(tokenConfig.maxFee6Decimals) * (10 ** uint256(tokenConfig.tokenDecimals))) / 1_000_000;
            if (feeAmount > maxFee) {
                feeAmount = maxFee;
            }
        }

        // Ensure fee never equals or exceeds deposit amount
        if (feeAmount >= amount) revert ITokenConfig.FeeExceedsDepositAmount(amount, feeAmount);
    }

    /// @inheritdoc IEscrow
    function getDepositHash(bytes32 depositId) external view returns (bytes32) {
        return s_activeDepositHashes[depositId];
    }

    /// @inheritdoc ITokenConfig
    function isTokenAllowed(IERC20 token) external view returns (bool isAllowed) {
        return _isTokenAllowed(token);
    }

    function _isTokenAllowed(IERC20 token) private view returns (bool isAllowed) {
        return s_tokenConfigs[token].tokenDecimals != 0;
    }

    /// @dev The single USDT payout path. Every `i_usdt` transfer goes through here.
    ///
    /// WHY USDT DOES NOT USE SafeERC20, AND WHY SWITCHING IT WOULD BRICK THE CONTRACT.
    /// Tron USDT (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`, TetherToken) declares
    /// `transfer(address,uint256) returns (bool)` and returns **32 bytes of zero — `false` — from a
    /// SUCCESSFUL transfer**. Failures do not return false; they REVERT, via the SafeMath
    /// subtraction on the sender's balance. Verified against the live contract rather than inferred:
    /// a simulated transfer from a funded holder returns `0x00..00` with no revert, and an overdraw
    /// from an empty account returns `REVERT opcode executed` with empty returndata.
    ///
    /// `SafeERC20.safeTransfer` reverts on an explicit `false` return. Routing USDT through it would
    /// therefore revert on every SUCCESSFUL release, refund and fee withdrawal — freezing the escrow
    /// with no rescue function. The raw call is deliberate and load-bearing, not an oversight.
    ///
    /// WHY THE RETURN VALUE IS IGNORED BUT THE RESULT IS STILL CHECKED. Since `false` means success
    /// here, the returned bool carries no information and cannot be branched on. Success is
    /// established the only way that is meaningful for this token: by measuring that the escrow's
    /// balance actually fell by the amount sent. Failures already revert, so this guard is
    /// belt-and-braces against a future token upgrade that returns without moving funds — the one
    /// outcome that would otherwise mark a deposit settled while the tokens stayed put.
    ///
    /// The delta is measured on the ESCROW's balance, not the recipient's, which makes it correct
    /// even if USDT's owner-settable transfer fee is ever switched on: TetherToken debits the sender
    /// the full `_value` and credits the recipient `_value - fee`, so the sender-side delta stays
    /// exactly `amount` while a recipient-side check would spuriously fail.
    function _usdtTransfer(address to, uint256 amount) private {
        uint256 balanceBefore = i_usdt.balanceOf(address(this));
        // Return value deliberately unused: on this token `false` IS success. See above.
        i_usdt.transfer(to, amount);
        uint256 observed = balanceBefore - i_usdt.balanceOf(address(this));
        if (observed != amount) revert UsdtTransferDidNotMove(amount, observed);
    }

    /// @inheritdoc ITokenConfig
    function getTokenConfig(IERC20 token) external view returns (TokenConfig memory tokenConfig) {
        return s_tokenConfigs[token];
    }

    /// @inheritdoc ITokenConfig
    function getAllowedTokens() external view returns (IERC20[] memory allowedTokens) {
        allowedTokens = s_allowlistedTokens;
    }

    /// @inheritdoc ITokenConfig
    function getFeeRevenue(IERC20 token) external view returns (uint256 revenue) {
        return s_tokenFeeRevenue[token];
    }

    // ADMIN FUNCTIONS (role-gated)

    /// @inheritdoc ITokenConfig
    function allowToken(IERC20 token, uint8 decimals) external onlyRole(TOKEN_CONFIG_ROLE) {
        _allowToken(token, decimals);
    }

    function _allowToken(IERC20 token, uint8 decimals) private {
        if (address(token) == address(0)) revert TokenCannotBeZeroAddress();
        if (decimals == 0) revert TokenDecimalsCannotBeZero();
        if (decimals > MAX_TOKEN_DECIMALS) revert TokenDecimalsExceedMaximum(decimals, MAX_TOKEN_DECIMALS);
        if (_isTokenAllowed(token)) revert TokenAlreadyAllowed(token);

        // Verify decimals against on-chain value if the token exposes decimals()
        (bool success, bytes memory returnData) = address(token).staticcall(abi.encodeWithSignature("decimals()"));
        if (success && returnData.length >= 32) {
            uint8 actualDecimals = abi.decode(returnData, (uint8));
            if (decimals != actualDecimals) revert TokenDecimalsMismatch(decimals, actualDecimals);
        }

        // Initialize with zero fees (fees configured separately via setTokenFeeConfig)
        s_tokenConfigs[token] =
            TokenConfig({feePercentage6Decimals: 0, maxFee6Decimals: 0, minFee6Decimals: 0, tokenDecimals: decimals});
        s_allowlistedTokens.push(token);

        emit TokenAllowed(token, decimals);
    }

    /// @inheritdoc ITokenConfig
    function setTokenFeeConfig(IERC20 token, uint88 feePercentage, uint80 minFee, uint80 maxFee)
        external
        onlyRole(TOKEN_CONFIG_ROLE)
    {
        _setTokenFeeConfig(token, feePercentage, minFee, maxFee);
    }

    function _setTokenFeeConfig(IERC20 token, uint88 feePercentage, uint80 minFee, uint80 maxFee) private {
        if (!_isTokenAllowed(token)) revert TokenNotAllowed(token);

        TokenConfig storage config = s_tokenConfigs[token];
        uint8 tokenDecimals = config.tokenDecimals;

        // Validate fee percentage does not exceed 100%
        // 100% = 100_000_000 in 6-decimal precision (100 * 10^6)
        if (feePercentage > 100_000_000) {
            revert FeePercentageExceedsMaximum(feePercentage);
        }

        // Validate fee bounds
        if (minFee > 0 && maxFee > 0) {
            if (minFee > maxFee) revert MinFeeCannotBeGreaterThanMaxFee();
        }
        if (maxFee > 0 && feePercentage == 0) {
            revert FeePercentageCannotBeZeroWhenMaxFeeIsSet();
        }

        // Validate that minFee is representable in the token's decimals
        // This prevents silent rounding to zero for low-decimal tokens
        if (minFee > 0) {
            uint256 minFeeInTokenDecimals = (uint256(minFee) * (10 ** uint256(tokenDecimals))) / 1_000_000;
            if (minFeeInTokenDecimals == 0) {
                revert MinFeeNotRepresentable(minFee, tokenDecimals);
            }
        }

        // Validate that maxFee is representable in the token's decimals
        if (maxFee > 0) {
            uint256 maxFeeInTokenDecimals = (uint256(maxFee) * (10 ** uint256(tokenDecimals))) / 1_000_000;
            if (maxFeeInTokenDecimals == 0) {
                revert MaxFeeNotRepresentable(maxFee, tokenDecimals);
            }
        }

        // Update fee parameters (preserve decimals)
        config.feePercentage6Decimals = feePercentage;
        config.minFee6Decimals = minFee;
        config.maxFee6Decimals = maxFee;

        emit TokenFeesUpdated(token, feePercentage, minFee, maxFee);
    }

    /// @inheritdoc ITokenConfig
    function allowTokenAndSetFeeConfig(IERC20 token, uint8 decimals, uint88 feePercentage, uint80 minFee, uint80 maxFee)
        external
        onlyRole(TOKEN_CONFIG_ROLE)
    {
        _allowToken(token, decimals);
        _setTokenFeeConfig(token, feePercentage, minFee, maxFee);
    }

    /// @inheritdoc ITokenConfig
    function clearTokenFeeConfig(IERC20 token) external onlyRole(TOKEN_CONFIG_ROLE) {
        if (!_isTokenAllowed(token)) revert TokenNotAllowed(token);

        // Clear all fee parameters (preserve decimals)
        TokenConfig storage config = s_tokenConfigs[token];
        config.feePercentage6Decimals = 0;
        config.minFee6Decimals = 0;
        config.maxFee6Decimals = 0;

        emit TokenFeesCleared(token);
    }

    /// @inheritdoc ITokenConfig
    function disallowToken(IERC20 token) external onlyRole(TOKEN_CONFIG_ROLE) {
        if (!_isTokenAllowed(token)) revert CouldNotDisallowToken(token);

        delete s_tokenConfigs[token];

        // Find the index of the token in the allowlisted tokens array
        uint256 index = 0;
        uint256 arrayLength = s_allowlistedTokens.length;
        for (uint256 i; i < arrayLength; i++) {
            if (s_allowlistedTokens[i] == token) {
                index = i;
                break;
            }
        }

        // Swap the token with the last element and pop the last element
        s_allowlistedTokens[index] = s_allowlistedTokens[arrayLength - 1];
        s_allowlistedTokens.pop();
        emit TokenDisallowed(token);
    }

    /// @inheritdoc ITokenConfig
    function withdrawFeeRevenue(IERC20 token, address recipient) external onlyRole(TREASURER_ROLE) {
        if (recipient == address(0)) revert RecipientCannotBeZeroAddress();
        if (recipient == address(this)) revert RecipientCannotBeSelf();

        uint256 feeRevenue = s_tokenFeeRevenue[token];
        if (feeRevenue == 0) revert NoFeesToWithdraw(token);

        s_tokenFeeRevenue[token] = 0;
        if (token == i_usdt) {
            _usdtTransfer(recipient, feeRevenue);
        } else {
            token.safeTransfer(recipient, feeRevenue);
        }
        emit FeeRevenueWithdrawn(token, recipient, feeRevenue);
    }

    ////////////////////////
    /// PAUSE FUNCTIONS ///
    ////////////////////////

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }
}
