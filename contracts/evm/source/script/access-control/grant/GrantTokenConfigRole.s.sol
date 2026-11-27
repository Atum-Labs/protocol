// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Escrow} from "../../../src/Escrow.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> TOKEN_CONFIG_ADDRESS=<TOKEN_CONFIG_ADDRESS> forge script script/access-control/grant/GrantTokenConfigRole.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <DEFAULT_ADMIN_ADDRESS>

contract GrantTokenConfigRole is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        Escrow targetContract = Escrow(contractAddress);

        address tokenConfig = vm.envAddress("TOKEN_CONFIG_ADDRESS");
        console.log("Granting TOKEN_CONFIG_ROLE to the token config:", tokenConfig);
        targetContract.grantRole(targetContract.TOKEN_CONFIG_ROLE(), tokenConfig);
        console.log("Role granted successfully");

        vm.stopBroadcast();
    }
}
