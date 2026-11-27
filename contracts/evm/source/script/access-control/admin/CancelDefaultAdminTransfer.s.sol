// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> forge script script/access-control/admin/CancelDefaultAdminTransfer.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <CURRENT_ADMIN_ADDRESS>

contract CancelDefaultAdminTransfer is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        IAccessControlDefaultAdminRules targetContract = IAccessControlDefaultAdminRules(contractAddress);

        (address pendingAdmin,) = targetContract.pendingDefaultAdmin();
        console.log("Cancelling default admin role transfer");
        console.log("Pending admin that will be cancelled:", pendingAdmin);

        targetContract.cancelDefaultAdminTransfer();

        console.log("Default admin transfer cancelled successfully");

        vm.stopBroadcast();
    }
}
