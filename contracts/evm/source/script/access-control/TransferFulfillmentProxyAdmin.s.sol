// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {FulfillmentProxy} from "../../src/FulfillmentProxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

/// @notice Move PAUSER_ROLE to NEW_PAUSER_ADDRESS and begin the default-admin transfer to
/// NEW_ADMIN_ADDRESS, on the FulfillmentProxy only. Run by the current admin.
///
/// The pauser is named separately on purpose. If the new admin is a Safe, a pauser that moved with
/// it would need a multisig transaction to pause in an incident; keep a fast pauser key instead,
/// and set FP_PAUSER_ADDRESS in the env file to it afterwards so the deploy drivers check the
/// right holder.
///
/// FP_ADDRESS=<addr> NEW_ADMIN_ADDRESS=<addr> NEW_PAUSER_ADDRESS=<addr> \
///   forge script script/access-control/TransferFulfillmentProxyAdmin.s.sol:BeginFulfillmentProxyAdminTransfer \
///   --rpc-url <RPC_URL> --account <CURRENT_ADMIN_KEYSTORE> --sender <CURRENT_ADMIN_ADDRESS> --broadcast
contract BeginFulfillmentProxyAdminTransfer is Script {
    function setUp() public virtual {}

    function run() public {
        begin(vm.envAddress("FP_ADDRESS"), vm.envAddress("NEW_ADMIN_ADDRESS"), vm.envAddress("NEW_PAUSER_ADDRESS"));
    }

    function begin(address fpAddress, address newAdmin, address newPauser) public {
        requireFulfillmentProxy(fpAddress);
        require(newAdmin != address(0), "NEW_ADMIN_ADDRESS is zero");
        require(newAdmin != msg.sender, "NEW_ADMIN_ADDRESS is the current admin");
        require(newPauser != address(0), "NEW_PAUSER_ADDRESS is zero");

        IAccessControl fp = IAccessControl(fpAddress);
        IAccessControlDefaultAdminRules fpAdmin = IAccessControlDefaultAdminRules(fpAddress);
        bytes32 pauserRole = keccak256("PAUSER_ROLE");

        vm.startBroadcast();

        console.log("FulfillmentProxy:", fpAddress);
        if (!fp.hasRole(pauserRole, newPauser)) {
            console.log("Granting PAUSER_ROLE to:", newPauser);
            fp.grantRole(pauserRole, newPauser);
        }
        if (newPauser != msg.sender && fp.hasRole(pauserRole, msg.sender)) {
            console.log("Revoking PAUSER_ROLE from:", msg.sender);
            fp.revokeRole(pauserRole, msg.sender);
        }

        console.log("Beginning admin transfer on FulfillmentProxy to:", newAdmin);
        fpAdmin.beginDefaultAdminTransfer(newAdmin);

        vm.stopBroadcast();
    }
}

/// @notice Accept the default-admin transfer on the FulfillmentProxy only. Run by the new admin.
/// A Safe cannot run this: as the new admin it accepts with a Safe transaction calling
/// acceptDefaultAdminTransfer() on the proxy.
///
/// FP_ADDRESS=<addr> \
///   forge script script/access-control/TransferFulfillmentProxyAdmin.s.sol:AcceptFulfillmentProxyAdminTransfer \
///   --rpc-url <RPC_URL> --account <NEW_ADMIN_KEYSTORE> --sender <NEW_ADMIN_ADDRESS> --broadcast
contract AcceptFulfillmentProxyAdminTransfer is Script {
    function setUp() public virtual {}

    function run() public {
        accept(vm.envAddress("FP_ADDRESS"));
    }

    function accept(address fpAddress) public {
        requireFulfillmentProxy(fpAddress);
        IAccessControlDefaultAdminRules fpAdmin = IAccessControlDefaultAdminRules(fpAddress);

        (address pending, uint48 schedule) = fpAdmin.pendingDefaultAdmin();
        console.log("FulfillmentProxy:", fpAddress);
        console.log("Pending admin:", pending);
        console.log("Acceptable from (unix time):", uint256(schedule));
        require(pending == msg.sender, "sender is not the pending admin");

        vm.startBroadcast();

        fpAdmin.acceptDefaultAdminTransfer();
        console.log("FulfillmentProxy admin transfer accepted. New admin:", fpAdmin.defaultAdmin());

        vm.stopBroadcast();
    }
}

/// The Escrow shares AccessControlDefaultAdminRules and PAUSER_ROLE, so an Escrow address would run
/// cleanly here and move the wrong contract's admin. SETTLER_ROLE exists only on the proxy.
function requireFulfillmentProxy(address fpAddress) view {
    require(fpAddress.code.length > 0, "FP_ADDRESS has no code");
    try FulfillmentProxy(fpAddress).SETTLER_ROLE() returns (bytes32 role) {
        require(role == keccak256("SETTLER_ROLE"), "FP_ADDRESS is not a FulfillmentProxy");
    } catch {
        revert("FP_ADDRESS is not a FulfillmentProxy (no SETTLER_ROLE)");
    }
}
