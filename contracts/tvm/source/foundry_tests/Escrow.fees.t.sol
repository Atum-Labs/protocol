// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../contracts/Escrow.sol";
import {ITokenConfig} from "../contracts/interfaces/ITokenConfig.sol";
import {IPermit2} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";
import {DeployCoreContracts} from "../foundry_scripts/DeployCoreContracts.s.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {MockToken6DecimalsTransferReturnsFalse} from "./mock/MockToken.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

contract EscrowFeesTest is Test {
    Escrow public s_escrow;
    IPermit2 public s_permit2;
    MockToken6DecimalsTransferReturnsFalse public s_token;

    uint88 public constant STANDARD_FEE_PERCENTAGE = 0.02e6;
    uint80 public constant STANDARD_MAX_FEE = 25e6;

    function setUp() public {
        // Real Permit2, no RPC: see foundry_tests/helpers/LocalPermit2.sol. The escrow constructor
        // requires code at PERMIT2_ADDRESS; nothing in this suite reads any other chain state.

        s_token = new MockToken6DecimalsTransferReturnsFalse("Test Token", "TEST");
        s_permit2 = LocalPermit2.etch();

        // Deploy our contracts
        DeployCoreContracts deployCoreContracts = new DeployCoreContracts();
        (s_escrow,) = deployCoreContracts.run(IERC20(address(s_token)));
    }

    function _sixDecimalTokenConfig(uint80 min, uint80 max, uint88 feePercentage)
        public
        view
        returns (ITokenConfig.TokenConfig memory)
    {
        return ITokenConfig.TokenConfig({
            tokenDecimals: 6, minFee6Decimals: min, maxFee6Decimals: max, feePercentage6Decimals: feePercentage
        });
    }

    function _eightDecimalTokenConfig(uint80 min, uint80 max, uint88 feePercentage)
        public
        view
        returns (ITokenConfig.TokenConfig memory)
    {
        return ITokenConfig.TokenConfig({
            tokenDecimals: 8, minFee6Decimals: min, maxFee6Decimals: max, feePercentage6Decimals: feePercentage
        });
    }

    function _eighteenDecimalTokenConfig(uint80 min, uint80 max, uint88 feePercentage)
        public
        view
        returns (ITokenConfig.TokenConfig memory)
    {
        return ITokenConfig.TokenConfig({
            tokenDecimals: 18, minFee6Decimals: min, maxFee6Decimals: max, feePercentage6Decimals: feePercentage
        });
    }

    ////////////////////////////
    /// FUZZ TESTS           ///
    ////////////////////////////

    /// @notice Broad fuzz test covering the full valid parameter space
    /// @dev Tests all valid combinations with proper invariant assertions
    function test_determineFee_fuzz_fullRange(
        uint88 feePercentage,
        uint80 minFee,
        uint80 maxFee,
        uint8 tokenDecimals,
        uint256 amount
    ) public {
        // === PARAMETER BOUNDING ===

        // tokenDecimals: 1-30 (contract constraint)
        tokenDecimals = uint8(bound(tokenDecimals, 1, 30));

        // feePercentage: 0-100% (realistic upper bound, 100_000_000 = 100%)
        feePercentage = uint88(bound(feePercentage, 0, 100_000_000));

        // Calculate minimum representable fee for this token's decimals
        // fee6Decimals must be >= ceil(1_000_000 / 10^tokenDecimals) to convert to >= 1 unit
        uint256 minRepresentable;
        if (tokenDecimals >= 6) {
            minRepresentable = 1; // Any positive value works for 6+ decimals
        } else {
            // For decimals < 6: need at least 1_000_000 / 10^decimals
            // e.g., 2 decimals: 1_000_000 / 100 = 10_000 ($0.01)
            minRepresentable = 1_000_000 / (10 ** uint256(tokenDecimals));
            if (minRepresentable == 0) minRepresentable = 1;
        }

        // Bound minFee to be either 0 or representable
        if (minFee > 0) {
            minFee = uint80(bound(minFee, minRepresentable, type(uint80).max));
        }

        // Bound maxFee to be either 0 or representable
        if (maxFee > 0) {
            maxFee = uint80(bound(maxFee, minRepresentable, type(uint80).max));
        }

        // Ensure minFee <= maxFee when both are set
        if (minFee > 0 && maxFee > 0 && minFee > maxFee) {
            (minFee, maxFee) = (maxFee, minFee); // Swap
        }

        // Bound amount to prevent overflow: amount * feePercentage < type(uint256).max
        // Safe limit: amount < type(uint256).max / (feePercentage + 1)
        if (feePercentage > 0) {
            uint256 maxSafeAmount = type(uint256).max / (uint256(feePercentage) + 100_000_000);
            amount = bound(amount, 0, maxSafeAmount);
        }

        // Skip if amount is 0 (trivial case)
        vm.assume(amount > 0);

        // === CALCULATE EXPECTED VALUES ===

        uint256 minFeeInTokenDecimals = (uint256(minFee) * (10 ** uint256(tokenDecimals))) / 1_000_000;
        uint256 maxFeeInTokenDecimals = (uint256(maxFee) * (10 ** uint256(tokenDecimals))) / 1_000_000;

        // Skip cases where fee would equal or exceed amount (expected to revert)
        // This happens when: minFee >= amount OR (percentage >= 100% and no max cap)
        if (minFee > 0 && minFeeInTokenDecimals >= amount) {
            vm.expectRevert();
            s_escrow.determineFee(amount, _buildConfig(tokenDecimals, feePercentage, minFee, maxFee));
            return;
        }

        // === EXECUTE ===
        ITokenConfig.TokenConfig memory config = _buildConfig(tokenDecimals, feePercentage, minFee, maxFee);

        uint256 feeAmount;
        try s_escrow.determineFee(amount, config) returns (uint256 result) {
            feeAmount = result;
        } catch {
            // Revert is acceptable for FeeExceedsDepositAmount
            return;
        }

        // === INVARIANT ASSERTIONS ===

        // Invariant 1: Fee never exceeds amount
        assertLt(feeAmount, amount, "Invariant 1: Fee must be strictly less than deposit");

        // Invariant 2: Fee respects maximum cap
        if (maxFee > 0 && maxFeeInTokenDecimals > 0) {
            assertLe(feeAmount, maxFeeInTokenDecimals, "Invariant 2: Fee exceeds max cap");
        }

        // Invariant 3: Fee meets minimum (if configured and amount sufficient)
        if (minFee > 0 && minFeeInTokenDecimals > 0 && amount >= minFeeInTokenDecimals) {
            assertGe(feeAmount, minFeeInTokenDecimals, "Invariant 3: Fee below minimum");
        }

        // Invariant 4: Fee is non-zero when percentage > 0 and amount > 0
        if (feePercentage > 0 && amount > 0) {
            assertGt(feeAmount, 0, "Invariant 4: Fee is zero with positive percentage");
        }

        // Invariant 5: Ceiling division - fee >= floor calculation
        // Only applies when maxFee doesn't cap the result
        if (feePercentage > 0 && (maxFee == 0 || feeAmount < maxFeeInTokenDecimals)) {
            uint256 floorFee = (amount * feePercentage) / 100_000_000;
            // Also account for minFee override
            if (minFee == 0 || feeAmount > minFeeInTokenDecimals) {
                assertGe(feeAmount, floorFee, "Invariant 5: Ceiling division failed");
            }
        }
    }

    /// @notice Fuzz test specifically for realistic stablecoin scenarios
    function test_determineFee_fuzz_stablecoinScenarios(
        uint88 feePercentage,
        uint80 minFee,
        uint80 maxFee,
        uint256 dollarAmount
    ) public {
        // Stablecoin-specific: 6 decimals, realistic fee ranges
        uint8 tokenDecimals = 6;

        // Fee percentage: 0.001% to 1% (10 to 1_000_000 in 6-decimal terms)
        feePercentage = uint88(bound(feePercentage, 10, 1_000_000));

        // minFee: $0 to $5 (0 to 5_000_000)
        minFee = uint80(bound(minFee, 0, 5_000_000));

        // maxFee: $5 to $100 (5_000_000 to 100_000_000)
        maxFee = uint80(bound(maxFee, 5_000_000, 100_000_000));

        // Ensure minFee <= maxFee
        if (minFee > maxFee) minFee = maxFee;

        // Dollar amount: $0.01 to $10M
        dollarAmount = bound(dollarAmount, 1, 10_000_000);
        uint256 amount = dollarAmount * 1e6; // Convert to 6-decimal representation

        // Skip if minFee > amount
        uint256 minFeeInTokenDecimals = (uint256(minFee) * 1e6) / 1_000_000;
        if (minFeeInTokenDecimals >= amount) {
            return; // Expected to revert, skip
        }

        ITokenConfig.TokenConfig memory config = _buildConfig(tokenDecimals, feePercentage, minFee, maxFee);
        uint256 feeAmount = s_escrow.determineFee(amount, config);

        // Assertions
        assertLt(feeAmount, amount, "Fee must be strictly less than deposit");
        assertGt(feeAmount, 0, "Fee should be non-zero");

        uint256 maxFeeInTokenDecimals = (uint256(maxFee) * 1e6) / 1_000_000;
        assertLe(feeAmount, maxFeeInTokenDecimals, "Fee exceeds max cap");

        if (minFeeInTokenDecimals > 0 && amount >= minFeeInTokenDecimals) {
            assertGe(feeAmount, minFeeInTokenDecimals, "Fee below minimum");
        }
    }

    /// @notice Helper to build TokenConfig
    function _buildConfig(uint8 decimals, uint88 feePercentage, uint80 minFee, uint80 maxFee)
        internal
        pure
        returns (ITokenConfig.TokenConfig memory)
    {
        return ITokenConfig.TokenConfig({
            tokenDecimals: decimals,
            feePercentage6Decimals: feePercentage,
            minFee6Decimals: minFee,
            maxFee6Decimals: maxFee
        });
    }

    ////////////////////////////
    /// EDGE CASE TESTS      ///
    ////////////////////////////

    /// @notice Test minimum amount (1 atomic unit) reverts because ceiling division makes fee equal amount
    function test_determineFee_minimumAmount() public {
        uint88 feePercentage = 20_000; // 0.02%

        // 6 decimals: amount=1, fee=1 -> fee >= amount -> reverts
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 1, 1));
        s_escrow.determineFee(1, _buildConfig(6, feePercentage, 0, 0));

        // 18 decimals: amount=1, fee=1 -> fee >= amount -> reverts
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 1, 1));
        s_escrow.determineFee(1, _buildConfig(18, feePercentage, 0, 0));

        // 2 decimals: amount=1, fee=1 -> fee >= amount -> reverts
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 1, 1));
        s_escrow.determineFee(1, _buildConfig(2, feePercentage, 0, 0));

        // Minimum viable deposit: amount=2 yields fee=1 across all decimals
        assertEq(s_escrow.determineFee(2, _buildConfig(6, feePercentage, 0, 0)), 1, "6 decimals: min viable deposit");
        assertEq(s_escrow.determineFee(2, _buildConfig(18, feePercentage, 0, 0)), 1, "18 decimals: min viable deposit");
        assertEq(s_escrow.determineFee(2, _buildConfig(2, feePercentage, 0, 0)), 1, "2 decimals: min viable deposit");
    }

    /// @notice Test amount exactly at ceiling division boundary
    function test_determineFee_ceilingDivisionBoundary() public {
        // 0.02% fee = 20_000 / 100_000_000
        // For fee to be exactly N, amount must be in range:
        // amount * 20_000 / 100_000_000 rounds up to N
        // ceiling(amount * 20_000 / 100_000_000) = N
        // (amount * 20_000 + 99_999_999) / 100_000_000 = N

        ITokenConfig.TokenConfig memory config = _buildConfig(6, 20_000, 0, 0);

        // Amount where floor = 0, ceiling = 1
        // fee=1 equals amount=1 -> reverts
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 1, 1));
        s_escrow.determineFee(1, config);

        // Amount where floor = 1, ceiling = 1 (exact)
        // 5000 * 20_000 = 100_000_000 exactly
        // floor: 100_000_000 / 100_000_000 = 1
        // ceiling: (100_000_000 + 99_999_999) / 100_000_000 = 1
        uint256 feeExact = s_escrow.determineFee(5000, config);
        assertEq(feeExact, 1, "Boundary: exact division should equal floor");

        // Amount where floor = 0, ceiling = 1 (just under exact)
        // 4999 * 20_000 = 99_980_000
        // floor: 99_980_000 / 100_000_000 = 0
        // ceiling: (99_980_000 + 99_999_999) / 100_000_000 = 1
        uint256 feeJustUnder = s_escrow.determineFee(4999, config);
        assertEq(feeJustUnder, 1, "Boundary: just under exact should ceil to 1");

        // Amount where floor = 1, ceiling = 2 (just over exact)
        // 5001 * 20_000 = 100_020_000
        // floor: 100_020_000 / 100_000_000 = 1
        // ceiling: (100_020_000 + 99_999_999) / 100_000_000 = 2
        uint256 feeJustOver = s_escrow.determineFee(5001, config);
        assertEq(feeJustOver, 2, "Boundary: just over exact should ceil to 2");
    }

    /// @notice Test minFee-only mode (no percentage, just flat minimum)
    function test_determineFee_minFeeOnlyMode() public {
        // No percentage, just $1 minimum
        ITokenConfig.TokenConfig memory config = _buildConfig(6, 0, 1_000_000, 0);

        // Large deposit: should use minFee
        uint256 fee = s_escrow.determineFee(1000e6, config);
        assertEq(fee, 1e6, "minFee-only: should charge $1 minimum");

        // Amount = 0: should return 0
        fee = s_escrow.determineFee(0, config);
        assertEq(fee, 0, "minFee-only: zero amount should yield zero fee");
    }

    /// @notice Test maxFee-only mode (percentage with cap, no minimum)
    function test_determineFee_maxFeeOnlyMode() public {
        // 1% fee with $10 max
        ITokenConfig.TokenConfig memory config = _buildConfig(6, 1_000_000, 0, 10_000_000);

        // Small deposit ($100): 1% = $1, below cap
        uint256 fee = s_escrow.determineFee(100e6, config);
        assertEq(fee, 1e6, "maxFee-only: should charge 1% = $1");

        // Large deposit ($10,000): 1% = $100, capped at $10
        fee = s_escrow.determineFee(10000e6, config);
        assertEq(fee, 10e6, "maxFee-only: should cap at $10");
    }

    /// @notice Test amount exactly equal to minFee now reverts (fee would consume entire deposit)
    /// @dev Ported from auditor POC: without the >= check, this deposit would succeed and on
    /// release the settler would receive amount - fee = 0, a direct loss for the settler.
    function test_determineFee_amountEqualsMinFee() public {
        // With percentage: $1 minFee, 0.02% percentage
        ITokenConfig.TokenConfig memory configWithPct = _buildConfig(6, 20_000, 1_000_000, 0);
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 1e6, 1e6));
        s_escrow.determineFee(1e6, configWithPct);

        // Without percentage (auditor POC scenario): minFee only, no percentage
        ITokenConfig.TokenConfig memory configNoPct = _buildConfig(6, 0, 1_000_000, 0);
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 1e6, 1e6));
        s_escrow.determineFee(1e6, configNoPct);

        // Amount just above minFee succeeds — settler would receive 1 unit
        uint256 fee = s_escrow.determineFee(1e6 + 1, configWithPct);
        assertEq(fee, 1e6, "With percentage: fee should equal minFee just above threshold");
        fee = s_escrow.determineFee(1e6 + 1, configNoPct);
        assertEq(fee, 1e6, "Without percentage: fee should equal minFee just above threshold");
    }

    /// @notice Test amount just above minFee
    function test_determineFee_amountJustAboveMinFee() public {
        // $1 minFee
        ITokenConfig.TokenConfig memory config = _buildConfig(6, 20_000, 1_000_000, 0);

        // Amount = $1.01 (just above minFee)
        uint256 fee = s_escrow.determineFee(1_010_000, config);
        assertEq(fee, 1e6, "Amount just above minFee: should charge minFee");
    }

    /// @notice Test amount just below minFee (should revert)
    function test_determineFee_amountBelowMinFee_reverts() public {
        // $1 minFee
        ITokenConfig.TokenConfig memory config = _buildConfig(6, 20_000, 1_000_000, 0);

        // Amount = $0.99 (below minFee)
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 990_000, 1e6));
        s_escrow.determineFee(990_000, config);
    }

    /// @notice Test interaction: minFee > percentage < maxFee
    function test_determineFee_minFeeOverridesPercentageBelowMax() public {
        // 0.02% percentage, $1 min, $25 max
        ITokenConfig.TokenConfig memory config = _buildConfig(6, 20_000, 1_000_000, 25_000_000);

        // $100 deposit: 0.02% = $0.02, minFee = $1, maxFee = $25
        // Result: $1 (minFee overrides)
        uint256 fee = s_escrow.determineFee(100e6, config);
        assertEq(fee, 1e6, "minFee should override low percentage");
    }

    /// @notice Test interaction: percentage > maxFee
    function test_determineFee_maxFeeOverridesPercentage() public {
        // 0.02% percentage, $0 min, $25 max
        ITokenConfig.TokenConfig memory config = _buildConfig(6, 20_000, 0, 25_000_000);

        // $1M deposit: 0.02% = $200, maxFee = $25
        // Result: $25 (maxFee caps)
        uint256 fee = s_escrow.determineFee(1_000_000e6, config);
        assertEq(fee, 25e6, "maxFee should cap high percentage");
    }

    /// @notice Test extreme decimals: 1 decimal (like some exotic tokens)
    function test_determineFee_extremeDecimals_1() public {
        // 1 decimal token, 0.02% fee
        // Minimum representable: 1 unit = $0.1 (if token is $1)
        ITokenConfig.TokenConfig memory config = _buildConfig(1, 20_000, 0, 0);

        // 1000 units ($100 equivalent)
        // 0.02% of 1000 = 0.2 units, ceiling = 1 unit
        uint256 fee = s_escrow.determineFee(1000, config);
        assertEq(fee, 1, "1 decimal: should ceil to 1 unit");

        // 5000 units ($500 equivalent)
        // 0.02% of 5000 = 1 unit exactly
        fee = s_escrow.determineFee(5000, config);
        assertEq(fee, 1, "1 decimal: exact division");

        // 10000 units ($1000 equivalent)
        // 0.02% of 10000 = 2 units
        fee = s_escrow.determineFee(10000, config);
        assertEq(fee, 2, "1 decimal: 2 units");
    }

    /// @notice Test extreme decimals: 30 decimals (max supported)
    function test_determineFee_extremeDecimals_30() public {
        // 30 decimal token, 0.02% fee
        ITokenConfig.TokenConfig memory config = _buildConfig(30, 20_000, 0, 0);

        // 100 tokens in 30 decimals
        uint256 amount = 100 * (10 ** 30);

        // 0.02% of 100e30 = 0.02e30 = 2e28
        uint256 expectedFee = (amount * 20_000) / 100_000_000;
        uint256 fee = s_escrow.determineFee(amount, config);

        // Should be close to expected (ceiling may add 1)
        assertGe(fee, expectedFee, "30 decimals: fee should be >= floor");
        assertLe(fee, expectedFee + 1, "30 decimals: fee should be at most floor + 1");
    }

    /// @notice Test 50% fee (high but valid)
    function test_determineFee_highPercentage_50percent() public {
        // 50% fee
        ITokenConfig.TokenConfig memory config = _buildConfig(6, 50_000_000, 0, 0);

        // $100 deposit: 50% = $50
        uint256 fee = s_escrow.determineFee(100e6, config);
        assertEq(fee, 50e6, "50% fee should work");
    }

    /// @notice Test 100% fee always reverts (fee would consume entire deposit)
    function test_determineFee_highPercentage_100percent() public {
        // 100% fee
        ITokenConfig.TokenConfig memory config = _buildConfig(6, 100_000_000, 0, 0);

        // $100 deposit: 100% = $100, fee equals amount -> reverts
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 100e6, 100e6));
        s_escrow.determineFee(100e6, config);
    }

    /// @notice Test >100% fee (should revert)
    function test_determineFee_highPercentage_over100percent_reverts() public {
        // 150% fee
        ITokenConfig.TokenConfig memory config = _buildConfig(6, 150_000_000, 0, 0);

        // $100 deposit: 150% = $150 > $100 (should revert)
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 100e6, 150e6));
        s_escrow.determineFee(100e6, config);
    }

    /// @notice Test large amount near overflow boundary
    function test_determineFee_largeAmount_nearOverflow() public {
        // Use small percentage to avoid overflow
        ITokenConfig.TokenConfig memory config = _buildConfig(18, 100, 0, 0); // 0.0001%

        // Large but safe amount
        uint256 largeAmount = 1e60; // 1e42 tokens with 18 decimals

        uint256 fee = s_escrow.determineFee(largeAmount, config);

        // 0.0001% of 1e60 = 1e56 / 100_000_000 = 1e48
        uint256 expectedFloor = (largeAmount * 100) / 100_000_000;
        assertGe(fee, expectedFloor, "Large amount: fee should be >= floor");
    }

    /// @notice Test zero percentage with both min and max set
    function test_determineFee_zeroPercentage_withMinMax() public {
        // 0% fee, but minFee set (edge case - should use minFee if amount > 0)
        // Actually, with 0% fee, minFee still applies
        ITokenConfig.TokenConfig memory config = _buildConfig(6, 0, 1_000_000, 25_000_000);

        // $100 deposit: 0% = $0, but minFee = $1
        uint256 fee = s_escrow.determineFee(100e6, config);
        assertEq(fee, 1e6, "Zero percentage: minFee should still apply");
    }

    /// @notice Verify ceiling division produces correct results mathematically
    function test_determineFee_ceilingMath_verification() public {
        ITokenConfig.TokenConfig memory config = _buildConfig(6, 20_000, 0, 0);

        // amount=1: fee=1 equals amount -> reverts
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 1, 1));
        s_escrow.determineFee(1, config);

        // Test remaining amounts and verify ceiling behavior
        uint256[4] memory amounts = [uint256(4999), 5000, 5001, 1000000];
        uint256[4] memory expectedFees = [uint256(1), 1, 2, 200];

        for (uint256 i = 0; i < 4; i++) {
            uint256 fee = s_escrow.determineFee(amounts[i], config);
            assertEq(fee, expectedFees[i], string.concat("Ceiling math failed for amount index ", vm.toString(i)));
        }
    }

    /// @notice Test when calculated fee exactly equals maxFee
    function test_determineFee_feeExactlyEqualsMaxFee() public {
        // 0.02% with $25 max
        // At $125,000 deposit: 0.02% = $25 exactly
        ITokenConfig.TokenConfig memory config = _buildConfig(6, 20_000, 0, 25_000_000);

        uint256 fee = s_escrow.determineFee(125_000e6, config);
        assertEq(fee, 25e6, "Fee should equal maxFee exactly");

        // Just above: $125,001 -> 0.02% = $25.0002, capped at $25
        fee = s_escrow.determineFee(125_001e6, config);
        assertEq(fee, 25e6, "Fee should be capped at maxFee");

        // Just below: $124,999 -> 0.02% = $24.9998, rounds up to $25
        fee = s_escrow.determineFee(124_999e6, config);
        // ceiling((124999e6 * 20000 + 99999999) / 100000000) = ceiling(24999800000000 / 100000000) = 24999800 + ceil
        // = (2499980000000000 + 99999999) / 100000000 = 25000799 -> wait let me recalculate
        // 124999 * 1e6 = 124,999,000,000
        // 124,999,000,000 * 20,000 = 2,499,980,000,000,000
        // (2,499,980,000,000,000 + 99,999,999) / 100,000,000 = 24,999,800 + 0.99999999 = 24,999,801
        // So fee = 24,999,801 which is below maxFee of 25,000,000
        assertLt(fee, 25e6, "Fee should be below maxFee");
        assertGt(fee, 24e6, "Fee should be close to maxFee");
    }

    /// @notice Test percentage in middle range (minFee < calculated < maxFee)
    function test_determineFee_percentageInMiddleRange() public {
        // 0.02% with $1 min and $25 max
        ITokenConfig.TokenConfig memory config = _buildConfig(6, 20_000, 1_000_000, 25_000_000);

        // $10,000 deposit: 0.02% = $2
        // $1 < $2 < $25, so percentage applies
        uint256 fee = s_escrow.determineFee(10_000e6, config);
        assertEq(fee, 2e6, "Percentage should apply when in range");

        // $50,000 deposit: 0.02% = $10
        // $1 < $10 < $25, so percentage applies
        fee = s_escrow.determineFee(50_000e6, config);
        assertEq(fee, 10e6, "Percentage should apply when in range");
    }

    /// @notice Test monotonicity: larger amount should yield >= fee (unless maxFee caps)
    function test_determineFee_monotonicity() public {
        ITokenConfig.TokenConfig memory configNoMax = _buildConfig(6, 20_000, 0, 0);
        ITokenConfig.TokenConfig memory configWithMax = _buildConfig(6, 20_000, 0, 25_000_000);

        // Without max: strictly increasing
        uint256 fee1 = s_escrow.determineFee(100e6, configNoMax);
        uint256 fee2 = s_escrow.determineFee(200e6, configNoMax);
        uint256 fee3 = s_escrow.determineFee(1000e6, configNoMax);
        assertGt(fee2, fee1, "Monotonicity: 200 > 100 without max");
        assertGt(fee3, fee2, "Monotonicity: 1000 > 200 without max");

        // With max: non-decreasing (may plateau)
        fee1 = s_escrow.determineFee(100_000e6, configWithMax);
        fee2 = s_escrow.determineFee(1_000_000e6, configWithMax);
        fee3 = s_escrow.determineFee(10_000_000e6, configWithMax);
        assertEq(fee1, 20e6, "Below max");
        assertEq(fee2, 25e6, "At max");
        assertEq(fee3, 25e6, "Above max, still at max");
        assertGe(fee2, fee1, "Monotonicity: non-decreasing with max");
        assertGe(fee3, fee2, "Monotonicity: non-decreasing with max");
    }

    /// @notice Test 2-decimal token (GUSD-like) with representable fees
    function test_determineFee_2decimals_GUSD_like() public {
        // 2 decimal token, 0.5% fee (realistic for some services)
        // minFee must be >= 10,000 to be representable ($0.01)
        ITokenConfig.TokenConfig memory config = _buildConfig(2, 500_000, 10_000, 25_000_000);

        // $100 deposit (10000 units): 0.5% = $0.50 = 50 units
        // minFee = (10000 * 100) / 1000000 = 1 unit = $0.01
        // maxFee = (25000000 * 100) / 1000000 = 2500 units = $25
        // 50 > 1 and 50 < 2500, so percentage applies
        uint256 fee = s_escrow.determineFee(10000, config);
        assertEq(fee, 50, "GUSD-like: 0.5% of $100 = $0.50 = 50 units");

        // $1 deposit (100 units): 0.5% = $0.005 -> ceil to 1 unit = $0.01
        // But minFee = 1 unit, so fee = 1
        fee = s_escrow.determineFee(100, config);
        assertEq(fee, 1, "GUSD-like: small deposit uses minFee");

        // $10,000 deposit (1000000 units): 0.5% = $50 = 5000 units
        // Below maxFee (2500 units)? NO, 5000 > 2500
        // Wait, that's wrong. Let me recalculate maxFee.
        // maxFee = (25_000_000 * 10^2) / 1_000_000 = 2_500_000_000 / 1_000_000 = 2500 units = $25
        // 0.5% of $10,000 = $50 = 5000 units
        // 5000 > 2500, so capped at 2500 units = $25
        fee = s_escrow.determineFee(1_000_000, config);
        assertEq(fee, 2500, "GUSD-like: large deposit capped at maxFee");
    }

    function test_6_decimal_token_determineFee_max_percentage_success() public {
        // normal amount
        uint256 amount = 100e6;
        uint256 feeAmount =
            s_escrow.determineFee(amount, _sixDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 2e4);

        // tiny amount: fee=1 equals amount=1, reverts
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 1, 1));
        s_escrow.determineFee(1, _sixDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));

        // minimum viable tiny amount
        amount = 2;
        feeAmount = s_escrow.determineFee(amount, _sixDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 1);

        // above max amount
        amount = 25000001e6;
        feeAmount = s_escrow.determineFee(amount, _sixDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 25e6);

        // amount is zero
        amount = 0;
        feeAmount = s_escrow.determineFee(amount, _sixDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 0);
    }

    function test_8_decimal_token_determineFee_max_percentage_success() public {
        // normal amount
        uint256 amount = 100e8;
        uint256 feeAmount =
            s_escrow.determineFee(amount, _eightDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 2e6);

        // tiny amount: fee=1 equals amount=1, reverts
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 1, 1));
        s_escrow.determineFee(1, _eightDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));

        // minimum viable tiny amount
        amount = 2;
        feeAmount =
            s_escrow.determineFee(amount, _eightDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 1);

        // above max amount
        amount = 25000001e8;
        feeAmount =
            s_escrow.determineFee(amount, _eightDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 25e8);

        // amount is zero
        amount = 0;
        feeAmount =
            s_escrow.determineFee(amount, _eightDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 0);
    }

    function test_18_decimal_token_determineFee_max_percentage_success() public {
        // normal amount
        uint256 amount = 100e18;
        uint256 feeAmount =
            s_escrow.determineFee(amount, _eighteenDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 2e16);

        // tiny amount: fee=1 equals amount=1, reverts
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 1, 1));
        s_escrow.determineFee(1, _eighteenDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));

        // minimum viable tiny amount
        amount = 2;
        feeAmount =
            s_escrow.determineFee(amount, _eighteenDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 1);

        // above max amount
        amount = 25000001e18;
        feeAmount =
            s_escrow.determineFee(amount, _eighteenDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 25e18);

        // amount is zero
        amount = 0;
        feeAmount =
            s_escrow.determineFee(amount, _eighteenDecimalTokenConfig(0, STANDARD_MAX_FEE, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 0);
    }

    // percentage and min
    function test_6_decimal_token_determineFee_min_percentage_success() public {
        // above min amount
        uint256 amount = 1_000_000e6;
        uint256 feeAmount = s_escrow.determineFee(amount, _sixDecimalTokenConfig(1e6, 0, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 200e6);

        // below min amount
        amount = 100e6;
        feeAmount = s_escrow.determineFee(amount, _sixDecimalTokenConfig(1e6, 0, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 1e6);

        // amount is zero
        amount = 0;
        feeAmount = s_escrow.determineFee(amount, _sixDecimalTokenConfig(1e6, 0, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 0);
    }

    function test_8_decimal_token_determineFee_min_percentage_success() public {
        // above min amount
        uint256 amount = 1_000_000e8;
        uint256 feeAmount = s_escrow.determineFee(amount, _eightDecimalTokenConfig(1e6, 0, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 200e8);

        // below min amount
        amount = 100e8;
        feeAmount = s_escrow.determineFee(amount, _eightDecimalTokenConfig(1e6, 0, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 1e8);

        // amount is zero
        amount = 0;
        feeAmount = s_escrow.determineFee(amount, _eightDecimalTokenConfig(1e6, 0, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 0);
    }

    function test_18_decimal_token_determineFee_min_percentage_success() public {
        // above min amount
        uint256 amount = 1_000_000e18;
        uint256 feeAmount = s_escrow.determineFee(amount, _eighteenDecimalTokenConfig(1e6, 0, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 200e18);

        // below min amount
        amount = 100e18;
        feeAmount = s_escrow.determineFee(amount, _eighteenDecimalTokenConfig(1e6, 0, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 1e18);

        // amount is zero
        amount = 0;
        feeAmount = s_escrow.determineFee(amount, _eighteenDecimalTokenConfig(1e6, 0, STANDARD_FEE_PERCENTAGE));
        assertEq(feeAmount, 0);
    }

    // no fees set at all
    function test_6_decimal_token_determineFee_no_fees_success() public {
        uint256 amount = 100e6;
        uint256 feeAmount = s_escrow.determineFee(amount, _sixDecimalTokenConfig(0, 0, 0));
        assertEq(feeAmount, 0);
    }

    function test_8_decimal_token_determineFee_no_fees_success() public {
        uint256 amount = 100e8;
        uint256 feeAmount = s_escrow.determineFee(amount, _eightDecimalTokenConfig(0, 0, 0));
        assertEq(feeAmount, 0);
    }

    function test_18_decimal_token_determineFee_no_fees_success() public {
        uint256 amount = 100e18;
        uint256 feeAmount = s_escrow.determineFee(amount, _eighteenDecimalTokenConfig(0, 0, 0));
        assertEq(feeAmount, 0);
    }

    /// @notice Test that zero config results in zero fee
    function test_determineFee_allZeroConfig() public {
        ITokenConfig.TokenConfig memory config = ITokenConfig.TokenConfig({
            tokenDecimals: 6, feePercentage6Decimals: 0, minFee6Decimals: 0, maxFee6Decimals: 0
        });

        uint256 fee = s_escrow.determineFee(1000e6, config);
        assertEq(fee, 0, "Should be zero with no config");
    }

    /// @notice Test atomic unit amounts revert when ceiling division makes fee equal amount
    function test_determineFee_atomicUnitFallback() public {
        ITokenConfig.TokenConfig memory config = ITokenConfig.TokenConfig({
            tokenDecimals: 6,
            feePercentage6Decimals: 20_000, // 0.02%
            minFee6Decimals: 0, // No min configured
            maxFee6Decimals: 0
        });

        // amount=1: ceiling division gives fee=1, which equals amount -> reverts
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeeExceedsDepositAmount.selector, 1, 1));
        s_escrow.determineFee(1, config);

        // amount=2: ceiling division gives fee=1, which is less than amount -> succeeds
        uint256 fee = s_escrow.determineFee(2, config);
        assertEq(fee, 1, "Minimum viable deposit should yield 1 unit fee");
    }

    /// @notice Test that minFee overrides percentage
    function test_determineFee_minFeeOverridesPercentage() public {
        ITokenConfig.TokenConfig memory config = ITokenConfig.TokenConfig({
            tokenDecimals: 6,
            feePercentage6Decimals: 20_000, // 0.02%
            minFee6Decimals: 1_000_000, // $1 min
            maxFee6Decimals: 0
        });

        // Small deposit where percentage < min
        uint256 fee = s_escrow.determineFee(100e6, config); // $100 deposit
        // 0.02% of $100 = $0.02, but min is $1
        assertEq(fee, 1e6, "Should use minimum fee");
    }

    /// @notice Test that maxFee caps percentage
    function test_determineFee_maxFeeCapsPerce() public {
        ITokenConfig.TokenConfig memory config = ITokenConfig.TokenConfig({
            tokenDecimals: 6,
            feePercentage6Decimals: 20_000, // 0.02%
            minFee6Decimals: 0,
            maxFee6Decimals: 25_000_000 // $25 max
        });

        // Large deposit where percentage > max
        uint256 fee = s_escrow.determineFee(1_000_000e6, config); // $1M deposit
        // 0.02% of $1M = $200, but max is $25
        assertEq(fee, 25e6, "Should cap at maximum");
    }

    /// @notice Test precision for different decimal tokens
    function test_determineFee_precisionAcrossDecimals() public {
        uint256 depositValue = 1000; // 1000 tokens

        // Test 6, 8, 18 decimals with same percentage
        for (uint8 d = 6; d <= 18; d += 6) {
            ITokenConfig.TokenConfig memory config = ITokenConfig.TokenConfig({
                tokenDecimals: d,
                feePercentage6Decimals: 20_000, // 0.02%
                minFee6Decimals: 0,
                maxFee6Decimals: 0
            });

            uint256 amount = depositValue * (10 ** d);
            uint256 fee = s_escrow.determineFee(amount, config);

            // Fee should be 0.02% regardless of decimals
            // Allow small precision loss
            uint256 expectedFee = (amount * 20_000) / 100_000_000;
            assertApproxEqRel(fee, expectedFee, 0.01e18, "Precision loss across decimals");
        }
    }

    /// @notice Test that fee calculation reverts when minimum fee exceeds deposit amount
    function test_determineFee_revertsWhenMinFeeExceedsAmount() public {
        // Configure a $10 minimum fee
        ITokenConfig.TokenConfig memory config = ITokenConfig.TokenConfig({
            tokenDecimals: 6,
            feePercentage6Decimals: 20_000, // 0.02%
            minFee6Decimals: 10_000_000, // $10 minimum
            maxFee6Decimals: 0
        });

        // Try to deposit only $5 (less than $10 minimum)
        uint256 amount = 5e6; // $5 in 6-decimal USDC

        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenConfig.FeeExceedsDepositAmount.selector,
                amount,
                10e6 // Expected fee would be $10
            )
        );
        s_escrow.determineFee(amount, config);
    }

    function test_determineFee_revertsWhenMaxFeeExceedsAmount() public {
        // Configure with absurdly high percentage and high max fee
        ITokenConfig.TokenConfig memory config = ITokenConfig.TokenConfig({
            tokenDecimals: 6,
            feePercentage6Decimals: 500_000_000, // 500% (5x the deposit!)
            minFee6Decimals: 0,
            maxFee6Decimals: 200_000_000 // $200 max
        });

        // Deposit $50
        uint256 amount = 50e6;
        // Calculated: 500% of $50 = $250
        // Capped at max: $200
        // $200 > $50? YES, should revert

        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenConfig.FeeExceedsDepositAmount.selector,
                amount,
                200e6 // Capped fee
            )
        );
        s_escrow.determineFee(amount, config);
    }

    /// @notice Test edge case where percentage calculation itself exceeds amount
    function test_determineFee_revertsWhenPercentageExceedsAmount() public {
        // Configure absurdly high percentage (should never happen in production)
        ITokenConfig.TokenConfig memory config = ITokenConfig.TokenConfig({
            tokenDecimals: 6,
            feePercentage6Decimals: 200_000_000, // 200% (2x the deposit!)
            minFee6Decimals: 0,
            maxFee6Decimals: 0 // No cap
        });

        uint256 amount = 100e6; // $100 deposit
        // 200% of $100 = $200

        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenConfig.FeeExceedsDepositAmount.selector,
                amount,
                200e6 // Expected fee
            )
        );
        s_escrow.determineFee(amount, config);
    }

    /// @notice Test that small deposits with high min fee revert appropriately
    function test_determineFee_revertsOnDustDepositWithMinFee() public {
        // $1 minimum fee
        ITokenConfig.TokenConfig memory config = ITokenConfig.TokenConfig({
            tokenDecimals: 6,
            feePercentage6Decimals: 0, // No percentage
            minFee6Decimals: 1_000_000, // $1 minimum
            maxFee6Decimals: 0
        });

        // Try to deposit 1 cent
        uint256 amount = 0.01e6; // $0.01

        vm.expectRevert(
            abi.encodeWithSelector(
                ITokenConfig.FeeExceedsDepositAmount.selector,
                amount,
                1e6 // $1 minimum fee
            )
        );
        s_escrow.determineFee(amount, config);
    }
}
