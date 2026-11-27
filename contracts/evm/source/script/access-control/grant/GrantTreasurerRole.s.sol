// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Escrow} from "../../../src/Escrow.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> TREASURER_ADDRESS=<TREASURER_ADDRESS> forge script script/access-control/grant/GrantTreasurerRole.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <DEFAULT_ADMIN_ADDRESS>

contract GrantTreasurerRole is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        Escrow targetContract = Escrow(contractAddress);

        address treasurer = vm.envAddress("TREASURER_ADDRESS");
        console.log("Granting TREASURER_ROLE to the treasurer:", treasurer);
        targetContract.grantRole(targetContract.TREASURER_ROLE(), treasurer);
        console.log("Role granted successfully");

        vm.stopBroadcast();
    }
}
