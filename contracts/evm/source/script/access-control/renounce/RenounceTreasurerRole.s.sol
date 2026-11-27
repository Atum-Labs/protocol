// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Escrow} from "../../../src/Escrow.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> forge script script/access-control/renounce/RenounceTreasurerRole.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <TREASURER_ROLE_HOLDER>

contract RenounceTreasurerRole is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        Escrow targetContract = Escrow(contractAddress);

        console.log("Renouncing TREASURER_ROLE for caller:", msg.sender);
        targetContract.renounceRole(targetContract.TREASURER_ROLE(), msg.sender);
        console.log("Role renounced successfully");

        vm.stopBroadcast();
    }
}
