// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

/// @notice Step 1: Grant roles to new admin, revoke from current admin, begin admin transfer on both contracts.
/// Run by the CURRENT admin (v3-deployer).
///
/// ESCROW_ADDRESS=<addr> FP_ADDRESS=<addr> NEW_ADMIN_ADDRESS=<addr> \
///   forge script script/access-control/TransferAllRoles.s.sol:GrantRevokeAndBeginTransfer \
///   --rpc-url <RPC_URL> --account v3-deployer --sender <V3_DEPLOYER_ADDRESS> --broadcast
contract GrantRevokeAndBeginTransfer is Script {
    function setUp() public virtual {}

    function run() public {
        address escrowAddress = vm.envAddress("ESCROW_ADDRESS");
        address fpAddress = vm.envAddress("FP_ADDRESS");
        address newAdmin = vm.envAddress("NEW_ADMIN_ADDRESS");

        IAccessControl escrow = IAccessControl(escrowAddress);
        IAccessControl fp = IAccessControl(fpAddress);
        IAccessControlDefaultAdminRules escrowAdmin = IAccessControlDefaultAdminRules(escrowAddress);
        IAccessControlDefaultAdminRules fpAdmin = IAccessControlDefaultAdminRules(fpAddress);

        bytes32 pauserRole = keccak256("PAUSER_ROLE");
        bytes32 treasurerRole = keccak256("TREASURER_ROLE");
        bytes32 tokenConfigRole = keccak256("TOKEN_CONFIG_ROLE");

        vm.startBroadcast();

        console.log("========================================");
        console.log("  TRANSFER ALL ROLES - STEP 1");
        console.log("========================================");
        console.log("Escrow:", escrowAddress);
        console.log("FulfillmentProxy:", fpAddress);
        console.log("Current admin:", escrowAdmin.defaultAdmin());
        console.log("New admin:", newAdmin);
        console.log("");

        // --- Grant all roles to new admin on Escrow ---
        console.log("--- Granting roles on Escrow ---");

        console.log("  Granting PAUSER_ROLE to:", newAdmin);
        escrow.grantRole(pauserRole, newAdmin);

        console.log("  Granting TREASURER_ROLE to:", newAdmin);
        escrow.grantRole(treasurerRole, newAdmin);

        console.log("  Granting TOKEN_CONFIG_ROLE to:", newAdmin);
        escrow.grantRole(tokenConfigRole, newAdmin);
        console.log("");

        // --- Grant PAUSER_ROLE to new admin on FulfillmentProxy ---
        console.log("--- Granting roles on FulfillmentProxy ---");

        console.log("  Granting PAUSER_ROLE to:", newAdmin);
        fp.grantRole(pauserRole, newAdmin);
        console.log("");

        // --- Revoke all roles from current admin on Escrow ---
        console.log("--- Revoking roles from current admin on Escrow ---");

        console.log("  Revoking PAUSER_ROLE from:", msg.sender);
        escrow.revokeRole(pauserRole, msg.sender);

        console.log("  Revoking TREASURER_ROLE from:", msg.sender);
        escrow.revokeRole(treasurerRole, msg.sender);

        console.log("  Revoking TOKEN_CONFIG_ROLE from:", msg.sender);
        escrow.revokeRole(tokenConfigRole, msg.sender);
        console.log("");

        // --- Revoke PAUSER_ROLE from current admin on FulfillmentProxy ---
        console.log("--- Revoking roles from current admin on FulfillmentProxy ---");

        console.log("  Revoking PAUSER_ROLE from:", msg.sender);
        fp.revokeRole(pauserRole, msg.sender);
        console.log("");

        // --- Begin admin transfer on both contracts ---
        console.log("--- Beginning default admin transfer ---");

        console.log("  Beginning admin transfer on Escrow to:", newAdmin);
        escrowAdmin.beginDefaultAdminTransfer(newAdmin);

        console.log("  Beginning admin transfer on FulfillmentProxy to:", newAdmin);
        fpAdmin.beginDefaultAdminTransfer(newAdmin);

        console.log("");
        console.log("========================================");
        console.log("  STEP 1 COMPLETE");
        console.log("========================================");
        console.log("New admin must now run AcceptAllAdminTransfers");
        console.log("to accept DEFAULT_ADMIN_ROLE on both contracts.");
        console.log("========================================");

        vm.stopBroadcast();
    }
}

/// @notice Step 2: Accept admin transfer on both contracts.
/// Run by the NEW admin (clean-admin). Can run immediately (1-second delay from constructor).
///
/// ESCROW_ADDRESS=<addr> FP_ADDRESS=<addr> \
///   forge script script/access-control/TransferAllRoles.s.sol:AcceptAllAdminTransfers \
///   --rpc-url <RPC_URL> --account clean-admin --sender <NEW_ADMIN_ADDRESS> --broadcast
contract AcceptAllAdminTransfers is Script {
    function setUp() public virtual {}

    function run() public {
        address escrowAddress = vm.envAddress("ESCROW_ADDRESS");
        address fpAddress = vm.envAddress("FP_ADDRESS");

        IAccessControlDefaultAdminRules escrowAdmin = IAccessControlDefaultAdminRules(escrowAddress);
        IAccessControlDefaultAdminRules fpAdmin = IAccessControlDefaultAdminRules(fpAddress);

        vm.startBroadcast();

        console.log("========================================");
        console.log("  ACCEPT ADMIN TRANSFERS - STEP 2");
        console.log("========================================");

        // --- Accept on Escrow ---
        (address escrowPending, uint48 escrowSchedule) = escrowAdmin.pendingDefaultAdmin();
        console.log("Escrow pending admin:", escrowPending);
        console.log("Escrow schedule:", escrowSchedule);
        escrowAdmin.acceptDefaultAdminTransfer();
        console.log("Escrow admin transfer accepted. New admin:", escrowAdmin.defaultAdmin());
        console.log("");

        // --- Accept on FulfillmentProxy ---
        (address fpPending, uint48 fpSchedule) = fpAdmin.pendingDefaultAdmin();
        console.log("FulfillmentProxy pending admin:", fpPending);
        console.log("FulfillmentProxy schedule:", fpSchedule);
        fpAdmin.acceptDefaultAdminTransfer();
        console.log("FulfillmentProxy admin transfer accepted. New admin:", fpAdmin.defaultAdmin());

        console.log("");
        console.log("========================================");
        console.log("  ALL TRANSFERS COMPLETE");
        console.log("========================================");

        vm.stopBroadcast();
    }
}
