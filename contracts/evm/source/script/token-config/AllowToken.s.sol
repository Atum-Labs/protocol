// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Escrow} from "../../src/Escrow.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> TOKEN_ADDRESS=<TOKEN_ADDRESS> TOKEN_DECIMALS=<TOKEN_DECIMALS> forge script script/token-config/AllowToken.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <TOKEN_CONFIG_ROLE_ADDRESS>

contract AllowToken is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        Escrow escrow = Escrow(contractAddress);

        address tokenAddress = vm.envAddress("TOKEN_ADDRESS");
        uint8 tokenDecimals = uint8(vm.envUint("TOKEN_DECIMALS"));

        console.log("Allowing token:", tokenAddress);
        console.log("Token decimals:", tokenDecimals);

        escrow.allowToken(IERC20(tokenAddress), tokenDecimals);

        console.log("Token allowed successfully");

        vm.stopBroadcast();
    }
}
