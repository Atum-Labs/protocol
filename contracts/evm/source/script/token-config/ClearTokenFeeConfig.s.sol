// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Escrow} from "../../src/Escrow.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> TOKEN_ADDRESS=<TOKEN_ADDRESS> forge script script/token-config/ClearTokenFeeConfig.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <TOKEN_CONFIG_ROLE_ADDRESS>

contract ClearTokenFeeConfig is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        Escrow escrow = Escrow(contractAddress);

        address tokenAddress = vm.envAddress("TOKEN_ADDRESS");

        console.log("Clearing fee config for token:", tokenAddress);

        escrow.clearTokenFeeConfig(IERC20(tokenAddress));

        console.log("Token fee config cleared successfully");

        vm.stopBroadcast();
    }
}
