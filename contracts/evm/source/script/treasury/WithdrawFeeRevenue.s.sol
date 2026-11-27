// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Escrow} from "../../src/Escrow.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> TOKEN_ADDRESS=<TOKEN_ADDRESS> RECIPIENT_ADDRESS=<RECIPIENT_ADDRESS> forge script script/treasury/WithdrawFeeRevenue.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <TREASURER_ROLE_ADDRESS>

contract WithdrawFeeRevenue is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        Escrow escrow = Escrow(contractAddress);

        address tokenAddress = vm.envAddress("TOKEN_ADDRESS");
        address recipient = vm.envAddress("RECIPIENT_ADDRESS");

        uint256 feeRevenue = escrow.getFeeRevenue(IERC20(tokenAddress));
        console.log("Withdrawing fee revenue for token:", tokenAddress);
        console.log("Fee revenue amount:", feeRevenue);
        console.log("Recipient:", recipient);

        escrow.withdrawFeeRevenue(IERC20(tokenAddress), recipient);

        console.log("Fee revenue withdrawn successfully");

        vm.stopBroadcast();
    }
}
