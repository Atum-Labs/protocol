// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Test} from "forge-std/Test.sol";
import {
    MockToken2Decimals,
    MockToken6Decimals,
    MockTokenCustomDecimals,
    TokenWithoutDecimalsNoFallback
} from "./mock/MockToken.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {Escrow} from "../contracts/Escrow.sol";
import {IPermit2} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";
import {TestHelpers} from "./helpers/TestHelpers.sol";
import {LocalPermit2} from "./helpers/LocalPermit2.sol";
import {
    IAccessControl,
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {DeployCoreContracts} from "../foundry_scripts/DeployCoreContracts.s.sol";
import {IEscrow} from "../contracts/interfaces/IEscrow.sol";
import {ITokenConfig} from "../contracts/interfaces/ITokenConfig.sol";
import {MockToken6DecimalsTransferReturnsFalse} from "./mock/MockToken.sol";

contract EscrowAccessControlTest is Test, TestHelpers {
    // CONTRACTS
    Escrow public s_escrow;
    MockToken6DecimalsTransferReturnsFalse public s_token;
    IPermit2 public s_permit2;

    address public s_pauser;
    address public s_treasurer;
    address public s_tokenConfig;

    // Test constants
    uint256 public constant DEPOSIT_AMOUNT = 1000e6;
    bytes32 public constant REQUEST_ID = keccak256("depositId");

    function setUp() public {
        DeployCoreContracts deployCoreContracts = new DeployCoreContracts();
        // Real Permit2, no RPC: see foundry_tests/helpers/LocalPermit2.sol. The escrow constructor
        // requires code at PERMIT2_ADDRESS; nothing in this suite reads any other chain state.
        s_permit2 = LocalPermit2.etch();

        // Deploy our contracts
        s_token = new MockToken6DecimalsTransferReturnsFalse("Test Token", "TEST");
        (s_escrow,) = deployCoreContracts.run(IERC20(address(s_token)));

        s_pauser = makeAddr("pauser");
        s_treasurer = makeAddr("treasurer");
        s_tokenConfig = makeAddr("tokenConfig");

        s_escrow.grantRole(s_escrow.PAUSER_ROLE(), s_pauser);
        s_escrow.grantRole(s_escrow.TREASURER_ROLE(), s_treasurer);
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), s_tokenConfig);

        vm.startPrank(s_tokenConfig);
        s_escrow.allowToken(s_token, 6);
        vm.stopPrank();
    }

    function test_constructor_sets_default_admin_role_correctly() public view {
        // Test that the owner is set correctly during construction
        assertTrue(s_escrow.hasRole(s_escrow.DEFAULT_ADMIN_ROLE(), address(this)));
    }

    function test_constructor_permit2_cannot_be_zero_address() public {
        vm.expectRevert(abi.encodeWithSelector(IEscrow.Permit2CannotBeZeroAddress.selector));
        new Escrow(IPermit2(address(0)), IERC20(address(0)), address(this));
    }

    function test_constructor_with_different_default_admin_role() public {
        address newDefaultAdmin = makeAddr("newDefaultAdmin");
        Escrow newEscrow = new Escrow(s_permit2, IERC20(address(s_token)), newDefaultAdmin);

        // The constructor should use the owner parameter passed to it
        assertTrue(newEscrow.hasRole(newEscrow.DEFAULT_ADMIN_ROLE(), newDefaultAdmin));
    }

    function test_constructor_with_zero_address_default_admin_role() public {
        // Test construction with zero address - should revert with OwnableInvalidOwner
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlInvalidDefaultAdmin.selector, address(0)
            )
        );
        new Escrow(s_permit2, IERC20(address(s_token)), address(0));
    }

    function test_default_admin_role_is_not_zero_after_construction() public view {
        assertTrue(s_escrow.hasRole(s_escrow.DEFAULT_ADMIN_ROLE(), address(this)));
    }

    // DEFAULT ADMIN TRANSFER TESTS

    function test_default_admin_transfer_success() public {
        address newDefaultAdmin = makeAddr("newDefaultAdmin");
        s_escrow.beginDefaultAdminTransfer(newDefaultAdmin);
        vm.warp(block.timestamp + 2);
        vm.prank(newDefaultAdmin);
        s_escrow.acceptDefaultAdminTransfer();
        assertTrue(s_escrow.hasRole(s_escrow.DEFAULT_ADMIN_ROLE(), newDefaultAdmin));
        assertFalse(s_escrow.hasRole(s_escrow.DEFAULT_ADMIN_ROLE(), address(this)));
    }

    // PAUSE/UNPAUSE TESTS
    modifier asPauser() {
        vm.startPrank(s_pauser);
        _;
        vm.stopPrank();
    }

    function test_pause_only_pauser_role() public asPauser {
        // Should succeed when called by owner
        s_escrow.pause();
        assertTrue(s_escrow.paused());
    }

    function test_pause_non_pauser_role_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), s_escrow.PAUSER_ROLE()
            )
        );
        s_escrow.pause();
    }

    function test_unpause_only_pauser_role() public asPauser {
        // First pause the contract
        s_escrow.pause();
        assertTrue(s_escrow.paused());

        // Should succeed when called by pauser
        s_escrow.unpause();
        assertFalse(s_escrow.paused());
    }

    function test_unpause_non_pauser_role_reverts() public {
        // First pause the contract
        vm.startPrank(s_pauser);
        s_escrow.pause();
        vm.stopPrank();
        assertTrue(s_escrow.paused());

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), s_escrow.PAUSER_ROLE()
            )
        );
        s_escrow.unpause();
    }

    function test_pause_when_already_paused_reverts() public asPauser {
        // First pause the contract
        s_escrow.pause();
        assertTrue(s_escrow.paused());

        // Try to pause again - should revert
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        s_escrow.pause();
    }

    function test_unpause_when_not_paused_reverts() public asPauser {
        // Contract is not paused by default
        assertFalse(s_escrow.paused());

        // Try to unpause when not paused - should revert
        vm.expectRevert(abi.encodeWithSignature("ExpectedPause()"));
        s_escrow.unpause();
    }

    function test_contract_not_paused_by_default() public view {
        assertFalse(s_escrow.paused());
    }

    function test_pause_unpause_cycle() public asPauser {
        // Initially not paused
        assertFalse(s_escrow.paused());

        // Pause
        s_escrow.pause();
        assertTrue(s_escrow.paused());

        // Unpause
        s_escrow.unpause();
        assertFalse(s_escrow.paused());

        // Can pause again
        s_escrow.pause();
        assertTrue(s_escrow.paused());
    }

    // allowToken

    modifier asTokenConfig() {
        vm.startPrank(s_tokenConfig);
        _;
        vm.stopPrank();
    }

    function test_allowToken_success() public asTokenConfig returns (IERC20 token) {
        // Deploy a new token
        MockToken6Decimals token6 = new MockToken6Decimals("6Decimal Token", "6DT");

        token = IERC20(address(token6));

        // Expect event to be emitted
        vm.expectEmit(true, true, true, true);
        emit ITokenConfig.TokenAllowed(token, 6);

        // Call allowToken
        s_escrow.allowToken(token, 6);

        // Check that the token is allowlisted
        assertTrue(s_escrow.isTokenAllowed(token6));
        assertEq(s_escrow.getTokenConfig(token6).tokenDecimals, 6);
        // get allowed tokens array
        bool tokenFound = false;
        IERC20[] memory allowedTokens = s_escrow.getAllowedTokens();
        for (uint256 i = 0; i < allowedTokens.length; i++) {
            if (allowedTokens[i] == token) {
                tokenFound = true;
                break;
            }
        }
        assertTrue(tokenFound);
    }

    function test_allowToken_non_tokenConfig_role_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), s_escrow.TOKEN_CONFIG_ROLE()
            )
        );
        s_escrow.allowToken(IERC20(address(s_token)), 18);
    }

    function test_allowToken_zero_address_reverts() public asTokenConfig {
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenCannotBeZeroAddress.selector));
        s_escrow.allowToken(IERC20(address(0)), 18);
    }

    function test_allowToken_zero_decimals_reverts() public asTokenConfig {
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenDecimalsCannotBeZero.selector));
        s_escrow.allowToken(IERC20(address(s_token)), 0);
    }

    function test_allowToken_decimals_exceed_maximum_reverts() public asTokenConfig {
        // Deploy a new token with 31 decimals
        MockTokenCustomDecimals newToken = new MockTokenCustomDecimals("31 Decimal Token", "31DT", 31);

        // Try to allow with 31 decimals (exceeds MAX_TOKEN_DECIMALS of 30)
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenDecimalsExceedMaximum.selector, 31, 30));
        s_escrow.allowToken(IERC20(address(newToken)), 31);
    }

    function test_allowToken_decimals_at_maximum_succeeds() public asTokenConfig {
        // Deploy a new token with 30 decimals
        MockTokenCustomDecimals newToken = new MockTokenCustomDecimals("30 Decimal Token", "30DT", 30);

        // 30 decimals should succeed (edge case - exactly at maximum)
        vm.expectEmit(true, true, true, true);
        emit ITokenConfig.TokenAllowed(IERC20(address(newToken)), 30);
        s_escrow.allowToken(IERC20(address(newToken)), 30);
    }

    function test_allowToken_already_allowed_with_same_decimals_reverts() public {
        IERC20 token = test_allowToken_success();
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenAlreadyAllowed.selector, token));
        vm.startPrank(s_tokenConfig);
        s_escrow.allowToken(token, 6);
        vm.stopPrank();
    }

    function test_allowToken_already_allowed_with_different_decimals_reverts() public {
        IERC20 token = test_allowToken_success();
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenAlreadyAllowed.selector, token));
        vm.startPrank(s_tokenConfig);
        s_escrow.allowToken(token, 8);
        vm.stopPrank();
    }

    function test_allowToken_decimals_match_onchain_succeeds() public asTokenConfig {
        MockToken6Decimals token6 = new MockToken6Decimals("6Decimal Token", "6DT");
        s_escrow.allowToken(IERC20(address(token6)), 6);
        assertTrue(s_escrow.isTokenAllowed(IERC20(address(token6))));
    }

    function test_allowToken_decimals_mismatch_onchain_reverts() public asTokenConfig {
        MockToken6Decimals token6 = new MockToken6Decimals("6Decimal Token", "6DT");
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenDecimalsMismatch.selector, 18, 6));
        s_escrow.allowToken(IERC20(address(token6)), 18);
    }

    function test_allowToken_no_decimals_function_succeeds() public asTokenConfig {
        TokenWithoutDecimalsNoFallback noDecToken = new TokenWithoutDecimalsNoFallback("No Decimals", "ND");
        s_escrow.allowToken(IERC20(address(noDecToken)), 8);
        assertTrue(s_escrow.isTokenAllowed(IERC20(address(noDecToken))));

        ITokenConfig.TokenConfig memory config = s_escrow.getTokenConfig(IERC20(address(noDecToken)));
        assertEq(config.tokenDecimals, 8);
    }

    // disallowToken

    function test_disallowToken_success() public {
        IERC20 token = test_allowToken_success();
        vm.startPrank(s_tokenConfig);
        s_escrow.disallowToken(token);
        vm.stopPrank();
        assertFalse(s_escrow.isTokenAllowed(token));
        // get allowed tokens array
        IERC20[] memory allowedTokens = s_escrow.getAllowedTokens();
        for (uint256 i = 0; i < allowedTokens.length; i++) {
            if (allowedTokens[i] == token) {
                revert("Token still in allowed tokens array");
            }
        }
    }

    function test_disallowToken_non_owner_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), s_escrow.TOKEN_CONFIG_ROLE()
            )
        );
        s_escrow.disallowToken(IERC20(address(s_token)));
    }

    function test_disallowToken_non_existent_token_reverts() public asTokenConfig {
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.CouldNotDisallowToken.selector, IERC20(address(0))));
        s_escrow.disallowToken(IERC20(address(0)));
    }

    // setTokenFeeConfig

    function test_setTokenFeeConfig_success() public returns (IERC20 token) {
        token = test_allowToken_success();
        vm.expectEmit(true, true, true, true);
        emit ITokenConfig.TokenFeesUpdated(token, 10000, 1000000, 25000000);
        vm.startPrank(s_tokenConfig);
        s_escrow.setTokenFeeConfig(token, 10000, 1000000, 25000000);
        vm.stopPrank();
        assertEq(s_escrow.getTokenConfig(token).feePercentage6Decimals, 10000);
        assertEq(s_escrow.getTokenConfig(token).minFee6Decimals, 1000000);
        assertEq(s_escrow.getTokenConfig(token).maxFee6Decimals, 25000000);
    }

    function test_setTokenFeeConfig_non_tokenConfig_role_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), s_escrow.TOKEN_CONFIG_ROLE()
            )
        );
        s_escrow.setTokenFeeConfig(s_token, 10000, 1000000, 25000000);
    }

    function test_setTokenFeeConfig_token_not_allowed_reverts() public asTokenConfig {
        IERC20 token = new MockToken6Decimals("6Decimal Token", "6DT");
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenNotAllowed.selector, token));
        s_escrow.setTokenFeeConfig(token, 10000, 1000000, 25000000);
    }

    function test_setTokenFeeConfig_min_fee_greater_than_max_fee_reverts() public {
        IERC20 token = test_allowToken_success();
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.MinFeeCannotBeGreaterThanMaxFee.selector));
        vm.startPrank(s_tokenConfig);
        s_escrow.setTokenFeeConfig(token, 10000, 25000000, 1000000);
        vm.stopPrank();
    }

    function test_setTokenFeeConfig_fee_percentage_zero_when_max_fee_set_reverts() public {
        IERC20 token = test_allowToken_success();
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeePercentageCannotBeZeroWhenMaxFeeIsSet.selector));
        vm.startPrank(s_tokenConfig);
        s_escrow.setTokenFeeConfig(token, 0, 1000000, 25000000);
        vm.stopPrank();
    }

    function test_setTokenFeeConfig_minFee_not_representable_reverts() public asTokenConfig {
        // Deploy a 2-decimal token (like GUSD)
        MockToken2Decimals token2 = new MockToken2Decimals("2Decimal Token", "2DT");
        IERC20 token = IERC20(address(token2));

        // Allow the token
        s_escrow.allowToken(token, 2);

        // Try to set a minFee that's too small to represent in 2 decimals
        // For 2-decimal token: minFee must be >= 10_000 (which converts to 1 unit = $0.01)
        // Setting minFee to 5_000 ($0.005) should fail as it rounds to 0
        uint80 tooSmallMinFee = 5_000; // $0.005 - not representable in 2 decimals

        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.MinFeeNotRepresentable.selector, tooSmallMinFee, 2));
        s_escrow.setTokenFeeConfig(token, 20_000, tooSmallMinFee, 25_000_000);
    }

    function test_setTokenFeeConfig_maxFee_not_representable_reverts() public asTokenConfig {
        // Deploy a 2-decimal token (like GUSD)
        MockToken2Decimals token2 = new MockToken2Decimals("2Decimal Token", "2DT");
        IERC20 token = IERC20(address(token2));

        // Allow the token
        s_escrow.allowToken(token, 2);

        // Try to set a maxFee that's too small to represent in 2 decimals
        // For 2-decimal token: maxFee must be >= 10_000 (which converts to 1 unit = $0.01)
        // Setting maxFee to 5_000 ($0.005) should fail as it rounds to 0
        uint80 tooSmallMaxFee = 5_000; // $0.005 - not representable in 2 decimals

        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.MaxFeeNotRepresentable.selector, tooSmallMaxFee, 2));
        s_escrow.setTokenFeeConfig(token, 20_000, 0, tooSmallMaxFee);
    }

    function test_setTokenFeeConfig_feePercentage_exceeds_100_percent_reverts() public asTokenConfig {
        // 100% = 100_000_000 in 6-decimal precision
        // Try to set 101% (100_000_001)
        uint88 over100Percent = 100_000_001;

        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.FeePercentageExceedsMaximum.selector, over100Percent));
        s_escrow.setTokenFeeConfig(s_token, over100Percent, 0, 0);
    }

    function test_setTokenFeeConfig_feePercentage_exactly_100_percent_success() public asTokenConfig {
        // 100% = 100_000_000 in 6-decimal precision (edge case - should succeed)
        uint88 exactly100Percent = 100_000_000;

        vm.expectEmit(true, true, true, true);
        emit ITokenConfig.TokenFeesUpdated(s_token, exactly100Percent, 0, 0);
        s_escrow.setTokenFeeConfig(s_token, exactly100Percent, 0, 0);

        // Verify
        ITokenConfig.TokenConfig memory config = s_escrow.getTokenConfig(s_token);
        assertEq(config.feePercentage6Decimals, exactly100Percent);
    }

    function test_setTokenFeeConfig_representable_fees_for_2_decimal_token_success() public asTokenConfig {
        // Deploy a 2-decimal token (like GUSD)
        MockToken2Decimals token2 = new MockToken2Decimals("2Decimal Token", "2DT");
        IERC20 token = IERC20(address(token2));

        // Allow the token
        s_escrow.allowToken(token, 2);

        // Set fees that ARE representable in 2 decimals
        // minFee = 10_000 ($0.01) -> converts to 1 unit in 2 decimals
        // maxFee = 25_000_000 ($25) -> converts to 2500 units in 2 decimals
        uint80 representableMinFee = 10_000; // $0.01
        uint80 representableMaxFee = 25_000_000; // $25

        vm.expectEmit(true, true, true, true);
        emit ITokenConfig.TokenFeesUpdated(token, 20_000, representableMinFee, representableMaxFee);

        s_escrow.setTokenFeeConfig(token, 20_000, representableMinFee, representableMaxFee);

        // Verify
        ITokenConfig.TokenConfig memory config = s_escrow.getTokenConfig(token);
        assertEq(config.minFee6Decimals, representableMinFee);
        assertEq(config.maxFee6Decimals, representableMaxFee);
    }

    // clearTokenFeeConfig

    function test_clearTokenFeeConfig_success() public {
        IERC20 token = test_setTokenFeeConfig_success();
        vm.expectEmit(true, true, true, true);
        emit ITokenConfig.TokenFeesCleared(token);
        vm.startPrank(s_tokenConfig);
        s_escrow.clearTokenFeeConfig(token);
        vm.stopPrank();
        assertEq(s_escrow.getTokenConfig(token).feePercentage6Decimals, 0);
        assertEq(s_escrow.getTokenConfig(token).minFee6Decimals, 0);
        assertEq(s_escrow.getTokenConfig(token).maxFee6Decimals, 0);
    }

    function test_clearTokenFeeConfig_non_tokenConfig_role_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), s_escrow.TOKEN_CONFIG_ROLE()
            )
        );
        s_escrow.clearTokenFeeConfig(s_token);
    }

    function test_clearTokenFeeConfig_token_not_allowed_reverts() public asTokenConfig {
        IERC20 token = new MockToken6Decimals("6Decimal Token", "6DT");
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenNotAllowed.selector, token));
        s_escrow.clearTokenFeeConfig(token);
    }

    // allowTokenAndSetFeeConfig

    function test_allowTokenAndSetFeeConfig_success() public asTokenConfig {
        // Deploy a new token
        MockToken6Decimals token6 = new MockToken6Decimals("6Decimal Token", "6DT");
        IERC20 token = IERC20(address(token6));

        // Expect events
        vm.expectEmit(true, true, true, true);
        emit ITokenConfig.TokenAllowed(token, 6);
        vm.expectEmit(true, true, true, true);
        emit ITokenConfig.TokenFeesUpdated(token, 10000, 1000000, 25000000);

        s_escrow.allowTokenAndSetFeeConfig(token, 6, 10000, 1000000, 25000000);

        // Verify state
        assertTrue(s_escrow.isTokenAllowed(token));
        ITokenConfig.TokenConfig memory config = s_escrow.getTokenConfig(token);
        assertEq(config.tokenDecimals, 6);
        assertEq(config.feePercentage6Decimals, 10000);
        assertEq(config.minFee6Decimals, 1000000);
        assertEq(config.maxFee6Decimals, 25000000);
    }

    function test_allowTokenAndSetFeeConfig_non_tokenConfig_role_reverts() public {
        IERC20 token = new MockToken6Decimals("6Decimal Token", "6DT");
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), s_escrow.TOKEN_CONFIG_ROLE()
            )
        );
        s_escrow.allowTokenAndSetFeeConfig(token, 6, 10000, 1000000, 25000000);
    }

    function test_allowTokenAndSetFeeConfig_invalid_token_params_reverts() public asTokenConfig {
        // Should revert if address(0)
        vm.expectRevert(ITokenConfig.TokenCannotBeZeroAddress.selector);
        s_escrow.allowTokenAndSetFeeConfig(IERC20(address(0)), 6, 10000, 0, 0);

        // Should revert if decimals 0
        IERC20 token = new MockToken6Decimals("6Decimal Token", "6DT");
        vm.expectRevert(ITokenConfig.TokenDecimalsCannotBeZero.selector);
        s_escrow.allowTokenAndSetFeeConfig(token, 0, 10000, 0, 0);

        // Should revert if decimals exceed maximum (30)
        IERC20 token2 = new MockTokenCustomDecimals("31 Decimal Token", "31DT", 31);
        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenDecimalsExceedMaximum.selector, 31, 30));
        s_escrow.allowTokenAndSetFeeConfig(token2, 31, 10000, 0, 0);
    }

    function test_allowTokenAndSetFeeConfig_invalid_fee_params_reverts() public asTokenConfig {
        IERC20 token = new MockToken6Decimals("6Decimal Token", "6DT");

        // Min > Max
        vm.expectRevert(ITokenConfig.MinFeeCannotBeGreaterThanMaxFee.selector);
        s_escrow.allowTokenAndSetFeeConfig(token, 6, 10000, 25000000, 1000000); // min > max

        // Max set but percentage 0
        vm.expectRevert(ITokenConfig.FeePercentageCannotBeZeroWhenMaxFeeIsSet.selector);
        s_escrow.allowTokenAndSetFeeConfig(token, 6, 0, 0, 25000000);
    }

    function test_allowTokenAndSetFeeConfig_already_allowed_reverts() public {
        IERC20 token = test_allowToken_success(); // First allow it

        vm.expectRevert(abi.encodeWithSelector(ITokenConfig.TokenAlreadyAllowed.selector, token));
        vm.startPrank(s_tokenConfig);
        s_escrow.allowTokenAndSetFeeConfig(token, 6, 10000, 0, 0);
        vm.stopPrank();
    }
}
