// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Escrow} from "../../../src/Escrow.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> TREASURER_ADDRESS=<TREASURER_ADDRESS> forge script script/access-control/revoke/RevokeTreasurerRole.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <DEFAULT_ADMIN_ADDRESS>

contract RevokeTreasurerRole is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        Escrow targetContract = Escrow(contractAddress);

        address treasurer = vm.envAddress("TREASURER_ADDRESS");
        console.log("Revoking TREASURER_ROLE from:", treasurer);
        targetContract.revokeRole(targetContract.TREASURER_ROLE(), treasurer);
        console.log("Role revoked successfully");

        vm.stopBroadcast();
    }
}
