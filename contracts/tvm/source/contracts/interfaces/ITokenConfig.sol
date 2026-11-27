// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0; // @aderyn-ignore

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ITokenConfig {
    // Events

    /// @notice Emitted when a new token is allowlisted
    event TokenAllowed(IERC20 indexed token, uint8 decimals);

    /// @notice Emitted when a token is disallowed
    event TokenDisallowed(IERC20 indexed token);

    /// @notice Emitted when the fees for a token are updated
    event TokenFeesUpdated(IERC20 indexed token, uint88 feePercentage, uint80 minFee, uint80 maxFee);

    /// @notice Emitted when the fees for a token are cleared
    event TokenFeesCleared(IERC20 indexed token);

    /// @notice Emitted when fees are withdrawn for a token
    event FeeRevenueWithdrawn(IERC20 indexed token, address indexed recipient, uint256 amount);

    // Errors

    /// @notice Recipient cannot be the zero address
    error RecipientCannotBeZeroAddress();

    /// @notice Recipient cannot be the self address
    error RecipientCannotBeSelf();

    /// @notice Token already allowlisted
    error TokenAlreadyAllowed(IERC20 token);

    /// @notice Could not disallow token
    error CouldNotDisallowToken(IERC20 token);

    /// @notice Token cannot be the zero address
    error TokenCannotBeZeroAddress();

    /// @notice Token decimals cannot be zero
    error TokenDecimalsCannotBeZero();

    /// @notice Token decimals exceed maximum supported (30)
    /// @dev Tokens with >30 decimals may cause overflow in fee calculations
    error TokenDecimalsExceedMaximum(uint8 decimals, uint8 maximum);

    /// @notice Provided decimals do not match the token's on-chain decimals() return value
    error TokenDecimalsMismatch(uint8 provided, uint8 actual);

    /// @notice Min fee cannot be greater than max fee
    error MinFeeCannotBeGreaterThanMaxFee();

    /// @notice Fee percentage cannot be zero when max fee is set
    error FeePercentageCannotBeZeroWhenMaxFeeIsSet();

    /// @notice Fee percentage cannot exceed 100%
    /// @param feePercentage6Decimals The configured fee percentage (scaled by 10^6)
    error FeePercentageExceedsMaximum(uint88 feePercentage6Decimals);

    /// @notice Token is not allowlisted
    error TokenNotAllowed(IERC20 token);

    /// @notice No fees to withdraw for token
    error NoFeesToWithdraw(IERC20 token);

    /// @notice Fee cannot exceed deposit amount
    error FeeExceedsDepositAmount(uint256 amount, uint256 feeAmount);

    /// @notice Configured minFee is too small to be represented in the token's decimals
    /// @dev This occurs when minFee6Decimals converts to 0 in the token's native decimals
    /// @param minFee6Decimals The configured minimum fee (scaled by 10^6)
    /// @param tokenDecimals The token's decimal places
    error MinFeeNotRepresentable(uint80 minFee6Decimals, uint8 tokenDecimals);

    /// @notice Configured maxFee is too small to be represented in the token's decimals
    /// @dev This occurs when maxFee6Decimals converts to 0 in the token's native decimals
    /// @param maxFee6Decimals The configured maximum fee (scaled by 10^6)
    /// @param tokenDecimals The token's decimal places
    error MaxFeeNotRepresentable(uint80 maxFee6Decimals, uint8 tokenDecimals);

    /// @dev Token configuration with fee parameters packed into single storage slot (256 bits)
    /// @notice All fee values are scaled by 10^6 (6 decimals) for precision.
    ///
    /// **Zero Value Semantics:**
    /// - `feePercentage6Decimals = 0`: No percentage fee is charged
    /// - `minFee6Decimals = 0`: No minimum fee floor (fee can be as low as percentage calculates)
    /// - `maxFee6Decimals = 0`: No maximum fee cap (fee is uncapped)
    ///
    /// This allows flexible configurations such as:
    /// - Percentage only: `feePercentage=X, minFee=0, maxFee=0` → pure percentage, no bounds
    /// - With floor only: `feePercentage=X, minFee=Y, maxFee=0` → percentage with minimum, no cap
    /// - With cap only: `feePercentage=X, minFee=0, maxFee=Z` → percentage with maximum, no floor
    /// - Fully bounded: `feePercentage=X, minFee=Y, maxFee=Z` → percentage clamped to [Y, Z]
    ///
    /// @param feePercentage6Decimals The fee percentage (scaled by 1,000,000). Set to 0 to disable percentage fees.
    ///        Min: 0.000001% (value: 1)
    ///        Max: 100% (value: 100,000,000) — values above 100% are rejected
    ///        Examples:
    ///          0.005% = 5,000
    ///          0.02% = 20,000
    ///          0.1% = 100,000
    ///          1% = 1,000,000
    ///          5% = 5,000,000
    /// @param maxFee6Decimals The maximum fee cap (scaled by 1,000,000). Set to 0 to disable the cap (uncapped).
    ///        Min: $0.000001 (value: 1)
    ///        Max: $281,474,976.710655 (value: 281,474,976,710,655)
    ///        Examples:
    ///          $1 = 1,000,000 (1e6)
    ///          $250 = 250,000,000 (250e6)
    ///          $100 = 100,000,000 (100e6)
    ///          $1,000 = 1,000,000,000 (1000e6)
    ///          $10,000 = 10,000,000,000 (10000e6)
    /// @param minFee6Decimals The minimum fee floor (scaled by 1,000,000). Set to 0 to disable the floor.
    ///        Min: $0.000001 (value: 1)
    ///        Max: $281,474,976.710655 (value: 281,474,976,710,655)
    ///        Same examples as maxFee6Decimals
    /// @param tokenDecimals The number of decimals the token has (1-30)
    struct TokenConfig {
        uint88 feePercentage6Decimals; // 88 bits - scaled to 6 decimals - 0 = disabled, max 100%
        uint80 maxFee6Decimals; // 80 bits - scaled to 6 decimals - 0 = uncapped (no maximum)
        uint80 minFee6Decimals; // 80 bits - scaled to 6 decimals - 0 = no floor (no minimum)
        uint8 tokenDecimals; // 8 bits - Token decimals (1-30)
    }

    /// @notice Get the full token configuration including decimals and fee parameters
    /// @param token The token to get the configuration for
    /// @return tokenConfig The token configuration (returns zero values if token not allowlisted)
    function getTokenConfig(IERC20 token) external view returns (TokenConfig memory tokenConfig);

    /// @notice Get the allowlisted tokens
    /// @return allowedTokens The allowlisted tokens
    function getAllowedTokens() external view returns (IERC20[] memory allowedTokens);

    /// @notice Check if a token is allowlisted
    /// @param token The token to check
    /// @return isAllowed Whether the token is allowlisted
    function isTokenAllowed(IERC20 token) external view returns (bool isAllowed);

    /// @notice Determine the fee for a given amount and token configuration
    /// @param amount The amount to determine the fee for
    /// @param tokenConfig The token configuration
    /// @return feeAmount The fee amount
    function determineFee(uint256 amount, TokenConfig memory tokenConfig) external view returns (uint256 feeAmount);

    // Admin Functions

    /// @notice Allow a token to be used for deposits (without fees initially)
    /// @dev Token decimals must be correctly specified and cannot be changed after allowlisting
    /// @param token The token address
    /// @param decimals The token decimals (immutable once set)
    function allowToken(IERC20 token, uint8 decimals) external;

    /// @notice Disallow a token from being used for new deposits
    /// @dev Existing deposits can still be refunded even after disallowing
    /// @param token The token to disallow
    function disallowToken(IERC20 token) external;

    /// @notice Allow a token to be used for deposits and set fees
    /// @dev Token decimals must be correctly specified and cannot be changed after allowlisting.
    /// See `setTokenFeeConfig` for important notes on minFee/maxFee precision and rounding behavior.
    /// @param token The token address
    /// @param decimals The token decimals (immutable once set, max 30)
    /// @param feePercentage Fee percentage scaled by 10^6 (e.g., 20,000 = 0.02%)
    /// @param minFee Minimum fee scaled by 10^6 (e.g., 1,000,000 = $1). Rounds down when converted to token decimals.
    /// @param maxFee Maximum fee scaled by 10^6 (e.g., 250,000,000 = $250). Rounds down when converted to token decimals.
    function allowTokenAndSetFeeConfig(IERC20 token, uint8 decimals, uint88 feePercentage, uint80 minFee, uint80 maxFee)
        external;

    /// @notice Set or update fee configuration for an allowed token
    /// @dev Token must already be allowlisted. Decimals cannot be changed.
    ///
    /// **Zero Value Semantics:**
    /// - `minFee = 0`: No minimum fee floor — fee can be as low as the percentage calculates
    /// - `maxFee = 0`: No maximum fee cap — fee is uncapped (grows with deposit size)
    ///
    /// **Valid Configurations:**
    /// - `(percentage=20_000, minFee=0, maxFee=0)` → 0.02% fee, no bounds
    /// - `(percentage=20_000, minFee=1_000_000, maxFee=0)` → 0.02% fee, $1 minimum, no cap
    /// - `(percentage=20_000, minFee=0, maxFee=250_000_000)` → 0.02% fee, no minimum, $250 cap
    /// - `(percentage=20_000, minFee=1_000_000, maxFee=250_000_000)` → 0.02% fee, clamped to [$1, $250]
    ///
    /// **Important: minFee/maxFee Precision**
    ///
    /// The `minFee` and `maxFee` values are stored in 6-decimal precision but converted to the token's
    /// native decimals at runtime using **floor division**. For tokens with fewer than 6 decimals,
    /// fractional values that don't align with the token's precision will be rounded DOWN.
    ///
    /// Example (2-decimal token like GUSD):
    /// - `minFee = 1_500_000` ($1.50) → converts to 150 cents ($1.50) ✓ exact
    /// - `minFee = 1_005_000` ($1.005) → converts to 100 cents ($1.00) ✗ rounds down
    ///
    /// To avoid unintended rounding, configure `minFee` and `maxFee` values that align with the
    /// token's decimal precision. For a 2-decimal token, use multiples of 10,000 (e.g., $0.01 = 10,000).
    ///
    /// @param token The token address
    /// @param feePercentage Fee percentage scaled by 10^6 (e.g., 20,000 = 0.02%). Max 100_000_000 (100%).
    /// @param minFee Minimum fee floor scaled by 10^6 (e.g., 1_000_000 = $1). Set to 0 to disable. Rounds down when converted.
    /// @param maxFee Maximum fee cap scaled by 10^6 (e.g., 250_000_000 = $250). Set to 0 to disable
    /// (uncapped). Rounds down when converted. Offchain signers hardcode this cap, so a value here
    /// that disagrees with them reverts release AND refund above the threshold where the cap binds.
    function setTokenFeeConfig(IERC20 token, uint88 feePercentage, uint80 minFee, uint80 maxFee) external;

    /// @notice Clear all fee configuration for a token (set to zero)
    /// @dev Token remains allowlisted, only fees are cleared
    /// @param token The token address
    function clearTokenFeeConfig(IERC20 token) external;

    /// @notice Get the fee revenue for a token
    /// @param token The token to get the fee revenue for
    /// @return revenue The fee revenue currently accumulated for the token in this contract
    function getFeeRevenue(IERC20 token) external view returns (uint256 revenue);

    /// @notice Withdraw fees for a token
    /// @dev Only the treasurer role can withdraw fees
    /// @param token The token to withdraw fees for
    /// @param recipient The recipient of the fees
    function withdrawFeeRevenue(IERC20 token, address recipient) external;
}
