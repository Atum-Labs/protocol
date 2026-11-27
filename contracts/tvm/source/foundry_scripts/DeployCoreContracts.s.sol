// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Escrow} from "../contracts/Escrow.sol";
import {IPermit2} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";
import {FulfillmentProxy} from "../contracts/FulfillmentProxy.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

// forge script script/DeployCoreContracts.s.sol --rpc-url https://eth-sepolia.g.alchemy.com/v2/<RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender 0x238bFaCdbCDfAce9a53aB23D67dc66220FCA1E64

contract DeployCoreContracts is Script {
    function setUp() public {}

    function run(IERC20 usdt) public returns (Escrow escrow, FulfillmentProxy fulfillmentProxy) {
        address permit2Address = vm.envAddress("PERMIT2_ADDRESS");
        bytes32 salt = vm.envBytes32("SALT");
        vm.startBroadcast();

        console.log("Deploying Escrow contract...");

        escrow = new Escrow{salt: salt}(IPermit2(permit2Address), usdt, msg.sender);

        console.log("Escrow contract deployed at:", address(escrow));
        console.log("--------------------------------");
        console.log("The DEFAULT_ADMIN_ROLE is assigned to the deployer:", msg.sender);
        console.log(
            "Roles need to be assigned by the DEFAULT_ADMIN_ROLE before use: PAUSER_ROLE, TREASURER_ROLE, TOKEN_CONFIG_ROLE"
        );
        console.log("Then the DEFAULT_ADMIN_ROLE must be granted to the multisig, and the deployer must renounce it.");
        console.log("--------------------------------");

        console.log("Deploying FulfillmentProxy contract...");

        fulfillmentProxy = new FulfillmentProxy{salt: salt}(msg.sender);

        console.log("FulfillmentProxy contract deployed at:", address(fulfillmentProxy));
        console.log("--------------------------------");
        console.log("The DEFAULT_ADMIN_ROLE is assigned to the deployer:", msg.sender);
        console.log("Roles need to be assigned by the DEFAULT_ADMIN_ROLE before use: PAUSER_ROLE");
        console.log("Then the DEFAULT_ADMIN_ROLE must be granted to the multisig, and the deployer must renounce it.");
        console.log("--------------------------------");

        vm.stopBroadcast();
    }
}
