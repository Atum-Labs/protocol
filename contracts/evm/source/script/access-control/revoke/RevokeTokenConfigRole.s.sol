// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Escrow} from "../../../src/Escrow.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> TOKEN_CONFIG_ADDRESS=<TOKEN_CONFIG_ADDRESS> forge script script/access-control/revoke/RevokeTokenConfigRole.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <DEFAULT_ADMIN_ADDRESS>

contract RevokeTokenConfigRole is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        Escrow targetContract = Escrow(contractAddress);

        address tokenConfig = vm.envAddress("TOKEN_CONFIG_ADDRESS");
        console.log("Revoking TOKEN_CONFIG_ROLE from:", tokenConfig);
        targetContract.revokeRole(targetContract.TOKEN_CONFIG_ROLE(), tokenConfig);
        console.log("Role revoked successfully");

        vm.stopBroadcast();
    }
}
