// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IEscrow, ITokenConfig, Pausable} from "../../src/Escrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

// ESCROW_ADDRESS=<ESCROW_ADDRESS> forge script script/inspection/GetEscrowState.s.sol --rpc-url <RPC_URL>

contract GetEscrowState is Script {
    function setUp() public {}

    function run() public {
        address escrowAddress = vm.envAddress("ESCROW_ADDRESS");
        vm.startBroadcast();
        // Paused State
        console.log("Paused state:", Pausable(escrowAddress).paused());
        console.log("--------------------------------");

        // Token Config
        // get all allowed tokens
        IERC20[] memory allowedTokens = ITokenConfig(escrowAddress).getAllowedTokens();

        console.log("Allowed tokens:", allowedTokens.length);
        console.log("--------------------------------");
        // for each token
        for (uint256 i = 0; i < allowedTokens.length; i++) {
            // The address is logged first so the block that follows is unambiguously attributable to a
            // token; the orphaned duplicate of this script at script/GetEscrowState.s.sol logged it and
            // this copy did not, which is the only output difference the two had.
            console.log("Token address:", address(allowedTokens[i]));
            // get and print the name and symbol from the token itself
            console.log("Token name:", IERC20Metadata(address(allowedTokens[i])).name());
            console.log("Token symbol:", IERC20Metadata(address(allowedTokens[i])).symbol());
            // get the token config
            ITokenConfig.TokenConfig memory tokenConfig = ITokenConfig(escrowAddress).getTokenConfig(allowedTokens[i]);
            console.log("Token Decimals:", tokenConfig.tokenDecimals);
            // parse the token config based on the scaling details in IEscrow
            // print out a readable version of this config
            console.log("Fee Percentage (in 6 decimals):", tokenConfig.feePercentage6Decimals);
            console.log("Max Fee (in 6 decimals):", tokenConfig.maxFee6Decimals);
            console.log("Min Fee (in 6 decimals):", tokenConfig.minFee6Decimals);
        }
        vm.stopBroadcast();
    }
}
