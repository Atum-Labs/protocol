// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> NEW_DEFAULT_ADMIN_ADDRESS=<NEW_DEFAULT_ADMIN_ADDRESS> forge script script/access-control/admin/BeginDefaultAdminRoleTransfer.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <DEFAULT_ADMIN_ADDRESS>

contract BeginDefaultAdminRoleTransfer is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        IAccessControlDefaultAdminRules targetContract = IAccessControlDefaultAdminRules(contractAddress);

        address newDefaultAdmin = vm.envAddress("NEW_DEFAULT_ADMIN_ADDRESS");
        console.log(
            "Beginning default admin role transfer from:", targetContract.defaultAdmin(), "to:", newDefaultAdmin
        );
        targetContract.beginDefaultAdminTransfer(newDefaultAdmin);
        console.log("Transfer begun successfully");
        console.log("The new default admin must accept the transfer by calling acceptDefaultAdminTransfer()");

        vm.stopBroadcast();
    }
}
