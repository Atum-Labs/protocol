// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> NEW_DELAY=<NEW_DELAY_SECONDS> forge script script/access-control/admin/ChangeDefaultAdminDelay.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <CURRENT_ADMIN_ADDRESS>

contract ChangeDefaultAdminDelay is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        IAccessControlDefaultAdminRules targetContract = IAccessControlDefaultAdminRules(contractAddress);

        uint48 newDelay = uint48(vm.envUint("NEW_DELAY"));

        console.log("Changing default admin delay");
        console.log("Current delay:", targetContract.defaultAdminDelay());
        console.log("New delay:", newDelay);

        targetContract.changeDefaultAdminDelay(newDelay);

        console.log("Default admin delay change scheduled successfully");
        console.log("Note: The new delay will take effect after the current delay period");

        vm.stopBroadcast();
    }
}
