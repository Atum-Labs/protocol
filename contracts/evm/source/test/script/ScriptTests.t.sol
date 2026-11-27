// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test, stdStorage, StdStorage} from "forge-std/Test.sol";
import {Escrow} from "../../src/Escrow.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {MockToken6Decimals} from "../mock/MockToken.sol";
import {ITokenConfig} from "../../src/interfaces/ITokenConfig.sol";

// Import scripts - deploy
import {DeployCoreContracts} from "../../script/deploy/DeployCoreContracts.s.sol";
import {DeployAndConfigureAllRoles} from "../../script/deploy/DeployAndConfigureAllRoles.s.sol";
import {DeployFulfillmentProxy} from "../../script/deploy/DeployFulfillmentProxy.s.sol";
import {
    BeginFulfillmentProxyAdminTransfer,
    AcceptFulfillmentProxyAdminTransfer
} from "../../script/access-control/TransferFulfillmentProxyAdmin.s.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

// Import scripts - access-control/admin
import {BeginDefaultAdminRoleTransfer} from "../../script/access-control/admin/BeginDefaultAdminRoleTransfer.s.sol";
import {AcceptDefaultAdminTransfer} from "../../script/access-control/admin/AcceptDefaultAdminTransfer.s.sol";
import {CancelDefaultAdminTransfer} from "../../script/access-control/admin/CancelDefaultAdminTransfer.s.sol";
import {ChangeDefaultAdminDelay} from "../../script/access-control/admin/ChangeDefaultAdminDelay.s.sol";

// Import scripts - access-control/grant
import {GrantPauserRole} from "../../script/access-control/grant/GrantPauserRole.s.sol";
import {GrantTreasurerRole} from "../../script/access-control/grant/GrantTreasurerRole.s.sol";
import {GrantTokenConfigRole} from "../../script/access-control/grant/GrantTokenConfigRole.s.sol";

// Import scripts - access-control/revoke
import {RevokePauserRole} from "../../script/access-control/revoke/RevokePauserRole.s.sol";
import {RevokeTreasurerRole} from "../../script/access-control/revoke/RevokeTreasurerRole.s.sol";
import {RevokeTokenConfigRole} from "../../script/access-control/revoke/RevokeTokenConfigRole.s.sol";

// Import scripts - access-control/renounce
import {RenouncePauserRole} from "../../script/access-control/renounce/RenouncePauserRole.s.sol";
import {RenounceTreasurerRole} from "../../script/access-control/renounce/RenounceTreasurerRole.s.sol";
import {RenounceTokenConfigRole} from "../../script/access-control/renounce/RenounceTokenConfigRole.s.sol";

// Import scripts - pausable
import {Pause} from "../../script/pausable/Pause.s.sol";
import {Unpause} from "../../script/pausable/Unpause.s.sol";

// Import scripts - token-config
import {AllowToken} from "../../script/token-config/AllowToken.s.sol";
import {SetTokenFeeConfig} from "../../script/token-config/SetTokenFeeConfig.s.sol";
import {ClearTokenFeeConfig} from "../../script/token-config/ClearTokenFeeConfig.s.sol";
import {DisallowToken} from "../../script/token-config/DisallowToken.s.sol";
import {AllowTokenAndSetFeeConfig} from "../../script/token-config/AllowTokenAndSetFeeConfig.s.sol";

// Import scripts - treasury
import {WithdrawFeeRevenue} from "../../script/treasury/WithdrawFeeRevenue.s.sol";

// Import contracts
import {FulfillmentProxy} from "../../src/FulfillmentProxy.sol";
import {LocalPermit2} from "../helpers/LocalPermit2.sol";

// The default broadcast sender when no private key is provided
address constant BROADCAST_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

// ==================== Deployment Script Test ====================

contract DeployCoreContractsTest is Test, DeployCoreContracts {
    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. The deploy script reads
        // PERMIT2_ADDRESS itself and requires code there; the etch supplies it.
        LocalPermit2.etch();
    }

    function test_DeployCoreContracts_script_success() public {
        vm.setEnv("SALT", vm.toString(bytes32(uint256(1))));

        (Escrow escrow, FulfillmentProxy fulfillmentProxy) = run();

        // Verify Escrow deployed correctly
        assertTrue(address(escrow) != address(0));
        assertEq(escrow.defaultAdmin(), BROADCAST_SENDER);
        assertTrue(escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), BROADCAST_SENDER));

        // Verify FulfillmentProxy deployed correctly
        assertTrue(address(fulfillmentProxy) != address(0));
        assertEq(fulfillmentProxy.defaultAdmin(), BROADCAST_SENDER);
        assertTrue(fulfillmentProxy.hasRole(fulfillmentProxy.DEFAULT_ADMIN_ROLE(), BROADCAST_SENDER));
    }
}

contract DeployFulfillmentProxyTest is Test, DeployFulfillmentProxy {
    bytes32 internal constant SALT_ = bytes32(uint256(0xF9));

    // run() wiring. FP_PAUSER_ADDRESS is the same value DeployAndConfigureAllRolesTest sets, so the
    // two tests cannot race on it. SALT does race with the other deploy tests; nothing here
    // depends on its value.
    function test_DeployFulfillmentProxy_run_grants_pauser() public {
        address fpPauser = makeAddr("fpPauser");
        vm.setEnv("SALT", vm.toString(SALT_));
        vm.setEnv("FP_PAUSER_ADDRESS", vm.toString(fpPauser));

        FulfillmentProxy fp = run();

        assertEq(fp.defaultAdmin(), BROADCAST_SENDER);
        assertTrue(fp.hasRole(fp.PAUSER_ROLE(), fpPauser));
    }

    function test_DeployFulfillmentProxy_fresh_proxy_can_be_paused_by_pauser() public {
        address pauser = makeAddr("pauser");
        FulfillmentProxy fp = deploy(SALT_, pauser, address(0), address(0));

        assertEq(fp.defaultAdmin(), BROADCAST_SENDER);
        assertTrue(fp.hasRole(fp.PAUSER_ROLE(), pauser));
        assertFalse(fp.hasRole(fp.PAUSER_ROLE(), BROADCAST_SENDER));
        assertFalse(fp.paused());

        vm.prank(pauser);
        fp.pause();
        assertTrue(fp.paused());

        vm.expectRevert(Pausable.EnforcedPause.selector);
        fp.authorizeFulfillment(bytes32(uint256(1)), bytes32(uint256(2)));

        vm.prank(pauser);
        fp.unpause();
        assertFalse(fp.paused());
    }

    function test_DeployFulfillmentProxy_lands_at_the_pinned_address() public {
        bytes memory initCode = abi.encodePacked(type(FulfillmentProxy).creationCode, abi.encode(BROADCAST_SENDER));
        address predicted = vm.computeCreate2Address(SALT_, keccak256(initCode), CREATE2_FACTORY);

        FulfillmentProxy fp = deploy(SALT_, makeAddr("pauser"), predicted, address(0));

        assertEq(address(fp), predicted);
    }

    function test_DeployFulfillmentProxy_refuses_a_mismatched_pin() public {
        vm.expectRevert(bytes("predicted address differs from EXPECT_FPROXY"));
        this.deploy(SALT_, makeAddr("pauser"), address(0xBEEF), address(0));
    }

    function test_DeployFulfillmentProxy_refuses_a_missing_escrow() public {
        vm.expectRevert(bytes("no code at ESCROW on this chain"));
        this.deploy(SALT_, makeAddr("pauser"), address(0), address(0xE5C));
    }

    function test_DeployFulfillmentProxy_refuses_a_zero_pauser() public {
        vm.expectRevert(bytes("FP_PAUSER_ADDRESS is zero"));
        this.deploy(SALT_, address(0), address(0), address(0));
    }
}

contract BeginFulfillmentProxyAdminTransferTest is Test, BeginFulfillmentProxyAdminTransfer {
    bytes32 internal constant PAUSER = keccak256("PAUSER_ROLE");

    function setUp() public override {
        LocalPermit2.etch();
    }

    // Refusals go through this.begin, an external call, so msg.sender inside is this contract.
    function test_refuses_an_escrow_address() public {
        vm.setEnv("SALT", vm.toString(bytes32(uint256(77))));
        (Escrow escrow,) = new DeployCoreContracts().run();

        vm.expectRevert(bytes("FP_ADDRESS is not a FulfillmentProxy (no SETTLER_ROLE)"));
        this.begin(address(escrow), makeAddr("newAdmin"), makeAddr("pauser"));
    }

    function test_refuses_a_zero_new_admin() public {
        FulfillmentProxy fp = new FulfillmentProxy(address(this));
        vm.expectRevert(bytes("NEW_ADMIN_ADDRESS is zero"));
        this.begin(address(fp), address(0), makeAddr("pauser"));
    }

    function test_refuses_the_current_admin_as_new_admin() public {
        FulfillmentProxy fp = new FulfillmentProxy(address(this));
        vm.expectRevert(bytes("NEW_ADMIN_ADDRESS is the current admin"));
        this.begin(address(fp), address(this), makeAddr("pauser"));
    }

    function test_refuses_a_zero_pauser() public {
        FulfillmentProxy fp = new FulfillmentProxy(address(this));
        vm.expectRevert(bytes("NEW_PAUSER_ADDRESS is zero"));
        this.begin(address(fp), makeAddr("newAdmin"), address(0));
    }

    // An internal call keeps msg.sender as the test's sender, which is also the broadcaster, as it
    // is when the script runs for real.
    function test_moves_the_pauser_to_its_own_key_and_begins_the_transfer() public {
        FulfillmentProxy fp = new FulfillmentProxy(BROADCAST_SENDER);
        vm.prank(BROADCAST_SENDER);
        fp.grantRole(PAUSER, BROADCAST_SENDER);
        address newAdmin = makeAddr("safe");
        address pauser = makeAddr("pauser");

        begin(address(fp), newAdmin, pauser);

        assertTrue(fp.hasRole(PAUSER, pauser));
        assertFalse(fp.hasRole(PAUSER, BROADCAST_SENDER));
        assertFalse(fp.hasRole(PAUSER, newAdmin));
        (address pending,) = fp.pendingDefaultAdmin();
        assertEq(pending, newAdmin);
        assertEq(fp.defaultAdmin(), BROADCAST_SENDER);
    }
}

contract AcceptFulfillmentProxyAdminTransferTest is Test, AcceptFulfillmentProxyAdminTransfer {
    function test_refuses_a_sender_that_is_not_the_pending_admin() public {
        FulfillmentProxy fp = new FulfillmentProxy(BROADCAST_SENDER);
        vm.expectRevert(bytes("sender is not the pending admin"));
        this.accept(address(fp));
    }
}

contract DeployAndConfigureAllRolesTest is Test, DeployAndConfigureAllRoles {
    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. The deploy script reads
        // PERMIT2_ADDRESS itself and requires code there; the etch supplies it.
        LocalPermit2.etch();
    }

    function test_DeployAndConfigureAllRoles_script_success() public {
        // Create addresses for each role
        address escrowPauser = makeAddr("escrowPauser");
        address escrowTreasurer = makeAddr("escrowTreasurer");
        address escrowTokenConfig = makeAddr("escrowTokenConfig");
        address fpPauser = makeAddr("fpPauser");

        // Set environment variables for the script
        vm.setEnv("SALT", vm.toString(bytes32(uint256(12345))));
        vm.setEnv("ESCROW_PAUSER_ADDRESS", vm.toString(escrowPauser));
        vm.setEnv("ESCROW_TREASURER_ADDRESS", vm.toString(escrowTreasurer));
        vm.setEnv("ESCROW_TOKEN_CONFIG_ADDRESS", vm.toString(escrowTokenConfig));
        vm.setEnv("FP_PAUSER_ADDRESS", vm.toString(fpPauser));

        (Escrow escrow, FulfillmentProxy fulfillmentProxy) = run();

        // Verify contracts deployed correctly
        assertTrue(address(escrow) != address(0), "Escrow should be deployed");
        assertTrue(address(fulfillmentProxy) != address(0), "FulfillmentProxy should be deployed");

        // Verify DEFAULT_ADMIN_ROLE remains with deployer on both contracts
        assertEq(escrow.defaultAdmin(), BROADCAST_SENDER, "Escrow admin should be deployer");
        assertTrue(
            escrow.hasRole(escrow.DEFAULT_ADMIN_ROLE(), BROADCAST_SENDER), "Deployer should have admin role on Escrow"
        );
        assertEq(fulfillmentProxy.defaultAdmin(), BROADCAST_SENDER, "FP admin should be deployer");
        assertTrue(
            fulfillmentProxy.hasRole(fulfillmentProxy.DEFAULT_ADMIN_ROLE(), BROADCAST_SENDER),
            "Deployer should have admin role on FP"
        );

        // Verify Escrow roles granted correctly
        assertTrue(escrow.hasRole(escrow.PAUSER_ROLE(), escrowPauser), "Escrow PAUSER_ROLE not granted");
        assertTrue(escrow.hasRole(escrow.TREASURER_ROLE(), escrowTreasurer), "Escrow TREASURER_ROLE not granted");
        assertTrue(
            escrow.hasRole(escrow.TOKEN_CONFIG_ROLE(), escrowTokenConfig), "Escrow TOKEN_CONFIG_ROLE not granted"
        );

        // Verify FulfillmentProxy roles granted correctly
        assertTrue(fulfillmentProxy.hasRole(fulfillmentProxy.PAUSER_ROLE(), fpPauser), "FP PAUSER_ROLE not granted");
    }

    function test_DeployAndConfigureAllRoles_sameAddressForAllRoles() public {
        // Test that the same address can be used for all roles (common for alpha testing)
        address singleOperator = makeAddr("singleOperator");

        vm.setEnv("SALT", vm.toString(bytes32(uint256(99999))));
        vm.setEnv("ESCROW_PAUSER_ADDRESS", vm.toString(singleOperator));
        vm.setEnv("ESCROW_TREASURER_ADDRESS", vm.toString(singleOperator));
        vm.setEnv("ESCROW_TOKEN_CONFIG_ADDRESS", vm.toString(singleOperator));
        vm.setEnv("FP_PAUSER_ADDRESS", vm.toString(singleOperator));

        (Escrow escrow, FulfillmentProxy fulfillmentProxy) = run();

        // All roles should be granted to the single operator
        assertTrue(escrow.hasRole(escrow.PAUSER_ROLE(), singleOperator));
        assertTrue(escrow.hasRole(escrow.TREASURER_ROLE(), singleOperator));
        assertTrue(escrow.hasRole(escrow.TOKEN_CONFIG_ROLE(), singleOperator));
        assertTrue(fulfillmentProxy.hasRole(fulfillmentProxy.PAUSER_ROLE(), singleOperator));
    }
}

// ==================== Role Granting Script Tests ====================

contract GrantPauserRoleTest is Test, GrantPauserRole {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), BROADCAST_SENDER);
    }

    function test_GrantPauserRole_script_success() public {
        address newPauser = makeAddr("newPauser");
        assertFalse(s_escrow.hasRole(s_escrow.PAUSER_ROLE(), newPauser));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("PAUSER_ADDRESS", vm.toString(newPauser));

        run();

        assertTrue(s_escrow.hasRole(s_escrow.PAUSER_ROLE(), newPauser));
    }
}

contract GrantTreasurerRoleTest is Test, GrantTreasurerRole {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), BROADCAST_SENDER);
    }

    function test_GrantTreasurerRole_script_success() public {
        address newTreasurer = makeAddr("newTreasurer");
        assertFalse(s_escrow.hasRole(s_escrow.TREASURER_ROLE(), newTreasurer));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("TREASURER_ADDRESS", vm.toString(newTreasurer));

        run();

        assertTrue(s_escrow.hasRole(s_escrow.TREASURER_ROLE(), newTreasurer));
    }
}

contract GrantTokenConfigRoleTest is Test, GrantTokenConfigRole {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), BROADCAST_SENDER);
    }

    function test_GrantTokenConfigRole_script_success() public {
        address newTokenConfig = makeAddr("newTokenConfig");
        assertFalse(s_escrow.hasRole(s_escrow.TOKEN_CONFIG_ROLE(), newTokenConfig));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("TOKEN_CONFIG_ADDRESS", vm.toString(newTokenConfig));

        run();

        assertTrue(s_escrow.hasRole(s_escrow.TOKEN_CONFIG_ROLE(), newTokenConfig));
    }
}

contract BeginDefaultAdminRoleTransferTest is Test, BeginDefaultAdminRoleTransfer {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), BROADCAST_SENDER);
    }

    function test_BeginDefaultAdminRoleTransfer_script_success() public {
        address newAdmin = makeAddr("newAdmin");

        // Verify no pending transfer initially
        (address pendingAdminBefore,) = s_escrow.pendingDefaultAdmin();
        assertEq(pendingAdminBefore, address(0));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("NEW_DEFAULT_ADMIN_ADDRESS", vm.toString(newAdmin));

        run();

        (address pendingAdmin, uint48 schedule) = s_escrow.pendingDefaultAdmin();
        assertEq(pendingAdmin, newAdmin);
        assertTrue(schedule > 0); // Schedule should be set
    }
}

// ==================== Token Config Script Tests ====================

contract AllowTokenTest is Test, AllowToken {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        // BROADCAST_SENDER needs TOKEN_CONFIG_ROLE
        s_escrow = new Escrow(IPermit2(permit2Address), address(this));
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), BROADCAST_SENDER);
    }

    function test_AllowToken_script_success() public {
        MockToken6Decimals newToken = new MockToken6Decimals("Test Token", "TEST");
        assertFalse(s_escrow.isTokenAllowed(IERC20(address(newToken))));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("TOKEN_ADDRESS", vm.toString(address(newToken)));
        vm.setEnv("TOKEN_DECIMALS", "6");

        run();

        assertTrue(s_escrow.isTokenAllowed(IERC20(address(newToken))));
        assertEq(s_escrow.getTokenConfig(IERC20(address(newToken))).tokenDecimals, 6);
    }
}

contract SetTokenFeeConfigTest is Test, SetTokenFeeConfig {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), address(this));
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), BROADCAST_SENDER);
    }

    function test_SetTokenFeeConfig_script_success() public {
        MockToken6Decimals newToken = new MockToken6Decimals("Test Token", "TEST");
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), address(this));
        s_escrow.allowToken(IERC20(address(newToken)), 6);

        ITokenConfig.TokenConfig memory configBefore = s_escrow.getTokenConfig(IERC20(address(newToken)));
        assertEq(configBefore.feePercentage6Decimals, 0);
        assertEq(configBefore.minFee6Decimals, 0);
        assertEq(configBefore.maxFee6Decimals, 0);
        assertEq(configBefore.tokenDecimals, 6);

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("TOKEN_ADDRESS", vm.toString(address(newToken)));
        vm.setEnv("FEE_PERCENTAGE", "20000");
        vm.setEnv("MIN_FEE", "1000000");
        vm.setEnv("MAX_FEE", "25000000");

        run();

        ITokenConfig.TokenConfig memory configAfter = s_escrow.getTokenConfig(IERC20(address(newToken)));
        assertEq(configAfter.feePercentage6Decimals, 20000);
        assertEq(configAfter.minFee6Decimals, 1000000);
        assertEq(configAfter.maxFee6Decimals, 25000000);
        assertEq(configAfter.tokenDecimals, 6); // Decimals should be preserved
    }
}

contract ClearTokenFeeConfigTest is Test, ClearTokenFeeConfig {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), address(this));
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), BROADCAST_SENDER);
    }

    function test_ClearTokenFeeConfig_script_success() public {
        MockToken6Decimals newToken = new MockToken6Decimals("Test Token", "TEST");
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), address(this));
        s_escrow.allowToken(IERC20(address(newToken)), 6);
        s_escrow.setTokenFeeConfig(IERC20(address(newToken)), 20000, 1000000, 25000000);

        ITokenConfig.TokenConfig memory configBefore = s_escrow.getTokenConfig(IERC20(address(newToken)));
        assertEq(configBefore.feePercentage6Decimals, 20000);

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("TOKEN_ADDRESS", vm.toString(address(newToken)));

        run();

        ITokenConfig.TokenConfig memory configAfter = s_escrow.getTokenConfig(IERC20(address(newToken)));
        assertEq(configAfter.feePercentage6Decimals, 0);
        assertEq(configAfter.minFee6Decimals, 0);
        assertEq(configAfter.maxFee6Decimals, 0);
        assertEq(configAfter.tokenDecimals, 6); // Still allowed
    }
}

contract DisallowTokenTest is Test, DisallowToken {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), address(this));
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), BROADCAST_SENDER);
    }

    function test_DisallowToken_script_success() public {
        MockToken6Decimals newToken = new MockToken6Decimals("Test Token", "TEST");
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), address(this));
        s_escrow.allowToken(IERC20(address(newToken)), 6);
        s_escrow.setTokenFeeConfig(IERC20(address(newToken)), 10000, 500000, 10000000);
        assertTrue(s_escrow.isTokenAllowed(IERC20(address(newToken))));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("TOKEN_ADDRESS", vm.toString(address(newToken)));

        run();

        assertFalse(s_escrow.isTokenAllowed(IERC20(address(newToken))));
        // Verify entire config is cleared
        ITokenConfig.TokenConfig memory configAfter = s_escrow.getTokenConfig(IERC20(address(newToken)));
        assertEq(configAfter.tokenDecimals, 0);
        assertEq(configAfter.feePercentage6Decimals, 0);
        assertEq(configAfter.minFee6Decimals, 0);
        assertEq(configAfter.maxFee6Decimals, 0);
    }
}

contract AllowTokenAndSetFeeConfigTest is Test, AllowTokenAndSetFeeConfig {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), address(this));
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), BROADCAST_SENDER);
    }

    function test_AllowTokenAndSetFeeConfig_script_success() public {
        MockToken6Decimals newToken = new MockToken6Decimals("Test Token", "TEST");
        assertFalse(s_escrow.isTokenAllowed(IERC20(address(newToken))));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("TOKEN_ADDRESS", vm.toString(address(newToken)));
        vm.setEnv("TOKEN_DECIMALS", "6");
        vm.setEnv("FEE_PERCENTAGE", "20000");
        vm.setEnv("MIN_FEE", "1000000");
        vm.setEnv("MAX_FEE", "25000000");

        run();

        // Verify token is allowed
        assertTrue(s_escrow.isTokenAllowed(IERC20(address(newToken))));

        // Verify all config values are set correctly
        ITokenConfig.TokenConfig memory config = s_escrow.getTokenConfig(IERC20(address(newToken)));
        assertEq(config.tokenDecimals, 6);
        assertEq(config.feePercentage6Decimals, 20000);
        assertEq(config.minFee6Decimals, 1000000);
        assertEq(config.maxFee6Decimals, 25000000);
    }
}

// ==================== Pause Script Tests ====================

contract PauseTest is Test, Pause {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), address(this));
        s_escrow.grantRole(s_escrow.PAUSER_ROLE(), BROADCAST_SENDER);
    }

    function test_Pause_script_success() public {
        assertFalse(s_escrow.paused());

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));

        run();

        assertTrue(s_escrow.paused());
    }
}

contract UnpauseTest is Test, Unpause {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), address(this));
        s_escrow.grantRole(s_escrow.PAUSER_ROLE(), BROADCAST_SENDER);
        // Pause first so we can unpause
        s_escrow.grantRole(s_escrow.PAUSER_ROLE(), address(this));
        s_escrow.pause();
    }

    function test_Unpause_script_success() public {
        assertTrue(s_escrow.paused());

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));

        run();

        assertFalse(s_escrow.paused());
    }
}

// ==================== Treasurer Script Tests ====================

contract WithdrawFeeRevenueTest is Test, WithdrawFeeRevenue {
    using stdStorage for StdStorage;

    Escrow public s_escrow;
    MockToken6Decimals public s_token;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), address(this));
        s_escrow.grantRole(s_escrow.TREASURER_ROLE(), BROADCAST_SENDER);

        // Setup: allow token and mint tokens to escrow
        s_token = new MockToken6Decimals("Test Token", "TEST");
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), address(this));
        s_escrow.allowToken(IERC20(address(s_token)), 6);

        // Mint tokens to escrow (simulating collected fees)
        uint256 feeAmount = 1000000; // 1 token with 6 decimals
        s_token.mint(address(s_escrow), feeAmount);

        // Set fee revenue using stdstore
        stdstore.target(address(s_escrow)).sig("getFeeRevenue(address)").with_key(address(s_token))
            .checked_write(feeAmount);
    }

    function test_WithdrawFeeRevenue_script_success() public {
        address recipient = makeAddr("recipient");
        uint256 feeAmount = 1000000;

        assertEq(s_escrow.getFeeRevenue(IERC20(address(s_token))), feeAmount);
        assertEq(s_token.balanceOf(recipient), 0);
        uint256 escrowBalanceBefore = s_token.balanceOf(address(s_escrow));
        assertEq(escrowBalanceBefore, feeAmount);

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("TOKEN_ADDRESS", vm.toString(address(s_token)));
        vm.setEnv("RECIPIENT_ADDRESS", vm.toString(recipient));

        run();

        assertEq(s_escrow.getFeeRevenue(IERC20(address(s_token))), 0);
        assertEq(s_token.balanceOf(recipient), feeAmount);
        assertEq(s_token.balanceOf(address(s_escrow)), 0); // Escrow balance decreased
    }
}

// ==================== Admin Transfer Script Tests ====================

contract AcceptDefaultAdminTransferTest is Test, AcceptDefaultAdminTransfer {
    Escrow public s_escrow;
    address public s_newAdmin;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        // Deploy with address(this) as admin so we can begin transfer
        s_escrow = new Escrow(IPermit2(permit2Address), address(this));

        // Begin transfer to BROADCAST_SENDER
        s_newAdmin = BROADCAST_SENDER;
        s_escrow.beginDefaultAdminTransfer(s_newAdmin);

        // Warp time to pass the delay (1 second + buffer)
        vm.warp(block.timestamp + 2);
    }

    function test_AcceptDefaultAdminTransfer_script_success() public {
        (address pendingAdmin,) = s_escrow.pendingDefaultAdmin();
        assertEq(pendingAdmin, s_newAdmin);
        assertEq(s_escrow.defaultAdmin(), address(this));
        assertTrue(s_escrow.hasRole(s_escrow.DEFAULT_ADMIN_ROLE(), address(this)));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));

        run();

        assertEq(s_escrow.defaultAdmin(), s_newAdmin);
        assertTrue(s_escrow.hasRole(s_escrow.DEFAULT_ADMIN_ROLE(), s_newAdmin));
        assertFalse(s_escrow.hasRole(s_escrow.DEFAULT_ADMIN_ROLE(), address(this))); // Old admin loses role
        (address newPendingAdmin,) = s_escrow.pendingDefaultAdmin();
        assertEq(newPendingAdmin, address(0));
    }
}

contract CancelDefaultAdminTransferTest is Test, CancelDefaultAdminTransfer {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        // Deploy with BROADCAST_SENDER as admin
        s_escrow = new Escrow(IPermit2(permit2Address), BROADCAST_SENDER);

        // Begin transfer to some address (as BROADCAST_SENDER)
        vm.prank(BROADCAST_SENDER);
        s_escrow.beginDefaultAdminTransfer(makeAddr("newAdmin"));
    }

    function test_CancelDefaultAdminTransfer_script_success() public {
        (address pendingAdmin,) = s_escrow.pendingDefaultAdmin();
        assertTrue(pendingAdmin != address(0));
        assertEq(s_escrow.defaultAdmin(), BROADCAST_SENDER);

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));

        run();

        (address newPendingAdmin,) = s_escrow.pendingDefaultAdmin();
        assertEq(newPendingAdmin, address(0));
        // Current admin should remain unchanged
        assertEq(s_escrow.defaultAdmin(), BROADCAST_SENDER);
        assertTrue(s_escrow.hasRole(s_escrow.DEFAULT_ADMIN_ROLE(), BROADCAST_SENDER));
    }
}

contract ChangeDefaultAdminDelayTest is Test, ChangeDefaultAdminDelay {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), BROADCAST_SENDER);
    }

    function test_ChangeDefaultAdminDelay_script_success() public {
        uint48 initialDelay = s_escrow.defaultAdminDelay();
        uint48 newDelay = 2 days;
        assertTrue(newDelay != initialDelay); // Ensure we're actually changing it

        // Verify no pending delay change initially
        (uint48 pendingDelayBefore,) = s_escrow.pendingDefaultAdminDelay();
        assertEq(pendingDelayBefore, 0);

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("NEW_DELAY", vm.toString(uint256(newDelay)));

        run();

        // The change is scheduled, so we need to check pendingDefaultAdminDelay
        (uint48 pendingDelay, uint48 schedule) = s_escrow.pendingDefaultAdminDelay();
        assertEq(pendingDelay, newDelay);
        assertTrue(schedule > 0); // Schedule should be set
        // Current delay should still be the old value until schedule passes
        assertEq(s_escrow.defaultAdminDelay(), initialDelay);
    }
}

// ==================== Revoke Role Script Tests ====================

contract RevokePauserRoleTest is Test, RevokePauserRole {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), BROADCAST_SENDER);
    }

    function test_RevokePauserRole_script_success() public {
        address pauser = makeAddr("pauser");

        // Grant role first
        vm.startPrank(BROADCAST_SENDER);
        s_escrow.grantRole(s_escrow.PAUSER_ROLE(), pauser);
        vm.stopPrank();
        assertTrue(s_escrow.hasRole(s_escrow.PAUSER_ROLE(), pauser));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("PAUSER_ADDRESS", vm.toString(pauser));

        run();

        assertFalse(s_escrow.hasRole(s_escrow.PAUSER_ROLE(), pauser));
    }
}

contract RevokeTreasurerRoleTest is Test, RevokeTreasurerRole {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), BROADCAST_SENDER);
    }

    function test_RevokeTreasurerRole_script_success() public {
        address treasurer = makeAddr("treasurer");

        // Grant role first
        vm.startPrank(BROADCAST_SENDER);
        s_escrow.grantRole(s_escrow.TREASURER_ROLE(), treasurer);
        vm.stopPrank();
        assertTrue(s_escrow.hasRole(s_escrow.TREASURER_ROLE(), treasurer));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("TREASURER_ADDRESS", vm.toString(treasurer));

        run();

        assertFalse(s_escrow.hasRole(s_escrow.TREASURER_ROLE(), treasurer));
    }
}

contract RevokeTokenConfigRoleTest is Test, RevokeTokenConfigRole {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), BROADCAST_SENDER);
    }

    function test_RevokeTokenConfigRole_script_success() public {
        address tokenConfig = makeAddr("tokenConfig");

        // Grant role first
        vm.startPrank(BROADCAST_SENDER);
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), tokenConfig);
        vm.stopPrank();
        assertTrue(s_escrow.hasRole(s_escrow.TOKEN_CONFIG_ROLE(), tokenConfig));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));
        vm.setEnv("TOKEN_CONFIG_ADDRESS", vm.toString(tokenConfig));

        run();

        assertFalse(s_escrow.hasRole(s_escrow.TOKEN_CONFIG_ROLE(), tokenConfig));
    }
}

// ==================== Renounce Role Script Tests ====================

contract RenouncePauserRoleTest is Test, RenouncePauserRole {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), address(this));
        // Grant PAUSER_ROLE to BROADCAST_SENDER so it can renounce
        s_escrow.grantRole(s_escrow.PAUSER_ROLE(), BROADCAST_SENDER);
    }

    function test_RenouncePauserRole_script_success() public {
        assertTrue(s_escrow.hasRole(s_escrow.PAUSER_ROLE(), BROADCAST_SENDER));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));

        run();

        assertFalse(s_escrow.hasRole(s_escrow.PAUSER_ROLE(), BROADCAST_SENDER));
    }
}

contract RenounceTreasurerRoleTest is Test, RenounceTreasurerRole {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), address(this));
        // Grant TREASURER_ROLE to BROADCAST_SENDER so it can renounce
        s_escrow.grantRole(s_escrow.TREASURER_ROLE(), BROADCAST_SENDER);
    }

    function test_RenounceTreasurerRole_script_success() public {
        assertTrue(s_escrow.hasRole(s_escrow.TREASURER_ROLE(), BROADCAST_SENDER));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));

        run();

        assertFalse(s_escrow.hasRole(s_escrow.TREASURER_ROLE(), BROADCAST_SENDER));
    }
}

contract RenounceTokenConfigRoleTest is Test, RenounceTokenConfigRole {
    Escrow public s_escrow;

    function setUp() public override {
        // Real Permit2, no RPC: see test/helpers/LocalPermit2.sol. These script tests forked
        // mainnet solely so DeployCoreContracts/new Escrow found code at PERMIT2_ADDRESS.
        address permit2Address = address(LocalPermit2.etch());
        s_escrow = new Escrow(IPermit2(permit2Address), address(this));
        // Grant TOKEN_CONFIG_ROLE to BROADCAST_SENDER so it can renounce
        s_escrow.grantRole(s_escrow.TOKEN_CONFIG_ROLE(), BROADCAST_SENDER);
    }

    function test_RenounceTokenConfigRole_script_success() public {
        assertTrue(s_escrow.hasRole(s_escrow.TOKEN_CONFIG_ROLE(), BROADCAST_SENDER));

        vm.setEnv("CONTRACT_ADDRESS", vm.toString(address(s_escrow)));

        run();

        assertFalse(s_escrow.hasRole(s_escrow.TOKEN_CONFIG_ROLE(), BROADCAST_SENDER));
    }
}
