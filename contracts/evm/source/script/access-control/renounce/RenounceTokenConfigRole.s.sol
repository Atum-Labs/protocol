// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Escrow} from "../../../src/Escrow.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> forge script script/access-control/renounce/RenounceTokenConfigRole.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <TOKEN_CONFIG_ROLE_HOLDER>

contract RenounceTokenConfigRole is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        Escrow targetContract = Escrow(contractAddress);

        console.log("Renouncing TOKEN_CONFIG_ROLE for caller:", msg.sender);
        targetContract.renounceRole(targetContract.TOKEN_CONFIG_ROLE(), msg.sender);
        console.log("Role renounced successfully");

        vm.stopBroadcast();
    }
}
