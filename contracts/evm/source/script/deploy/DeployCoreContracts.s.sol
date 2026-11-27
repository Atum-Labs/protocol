// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console} from "forge-std/Script.sol";
import {EscrowLinkCheck} from "./EscrowLinkCheck.sol";
import {Escrow} from "../../src/Escrow.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {FulfillmentProxy} from "../../src/FulfillmentProxy.sol";

// forge script script/deploy/DeployCoreContracts.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <DEPLOYER_ADDRESS>
//
// A tree with src/EscrowReserveLib.sol (the library generation) links the escrow to a library, and an
// escrow deployed WITHOUT --libraries is linked to a library forge deploys itself (through the CREATE2
// factory, salt 0), landing at an address no derivation produces, with no revert. So deploy the library
// first and link it, as deploy.sh does:
//   SALT=<bytes32> forge script script/deploy/DeployEscrowReserveLib.s.sol --rpc-url <RPC_URL> --account <KEYSTORE> --sender <DEPLOYER> --broadcast
// then add ESCROW_RESERVE_LIB_ADDRESS=<that address> and `--libraries src/EscrowReserveLib.sol:EscrowReserveLib:<that address>`
// to the command above (this script deploys the proxy too; on a chain that already has it use DeployEscrowOnly.s.sol). README: "The escrow library".

contract DeployCoreContracts is EscrowLinkCheck {
    function setUp() public virtual {}

    function run() public returns (Escrow escrow, FulfillmentProxy fulfillmentProxy) {
        address permit2Address = vm.envAddress("PERMIT2_ADDRESS");
        bytes32 salt = vm.envBytes32("SALT");
        vm.startBroadcast();

        console.log("Deploying Escrow contract...");

        escrow = new Escrow{salt: salt}(IPermit2(permit2Address), msg.sender);
        _assertLinked(address(escrow));

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
