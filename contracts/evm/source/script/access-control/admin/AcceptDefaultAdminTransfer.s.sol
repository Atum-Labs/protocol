// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> forge script script/access-control/admin/AcceptDefaultAdminTransfer.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <PENDING_ADMIN_ADDRESS>

contract AcceptDefaultAdminTransfer is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        IAccessControlDefaultAdminRules targetContract = IAccessControlDefaultAdminRules(contractAddress);

        (address pendingAdmin, uint48 schedule) = targetContract.pendingDefaultAdmin();
        console.log("Accepting default admin role transfer");
        console.log("Pending admin:", pendingAdmin);
        console.log("Schedule:", schedule);

        targetContract.acceptDefaultAdminTransfer();

        console.log("Default admin transfer accepted successfully");
        console.log("New admin:", targetContract.defaultAdmin());

        vm.stopBroadcast();
    }
}
