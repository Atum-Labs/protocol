// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console} from "forge-std/Script.sol";
import {EscrowLinkCheck} from "./EscrowLinkCheck.sol";
import {Escrow} from "../../src/Escrow.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {FulfillmentProxy} from "../../src/FulfillmentProxy.sol";

// WARNING: This script is for ALPHA/TESTNET deployments only.
// Before production, roles must be transferred to multisigs and the deployer must renounce admin.
//
// PERMIT2_ADDRESS=<addr> SALT=<bytes32> ESCROW_PAUSER_ADDRESS=<addr> ESCROW_TREASURER_ADDRESS=<addr> ESCROW_TOKEN_CONFIG_ADDRESS=<addr> FP_PAUSER_ADDRESS=<addr> \
//   forge script script/deploy/DeployAndConfigureAllRoles.s.sol --rpc-url <RPC_URL> --account <KEYSTORE> --sender <DEPLOYER>
//
// A tree with src/EscrowReserveLib.sol (the library generation) links the escrow to a library, and an
// escrow deployed WITHOUT --libraries is linked to a library forge deploys itself (through the CREATE2
// factory, salt 0), landing at an address no derivation produces, with no revert. So deploy the library
// first and link it, as deploy.sh does:
//   SALT=<bytes32> forge script script/deploy/DeployEscrowReserveLib.s.sol --rpc-url <RPC_URL> --account <KEYSTORE> --sender <DEPLOYER> --broadcast
// then add ESCROW_RESERVE_LIB_ADDRESS=<that address> and `--libraries src/EscrowReserveLib.sol:EscrowReserveLib:<that address>`
// to the command above. README: "The escrow library".

contract DeployAndConfigureAllRoles is EscrowLinkCheck {
    function setUp() public virtual {}

    function run() public returns (Escrow escrow, FulfillmentProxy fulfillmentProxy) {
        // Read environment variables
        address permit2Address = vm.envAddress("PERMIT2_ADDRESS");
        bytes32 salt = vm.envBytes32("SALT");
        address escrowPauserAddress = vm.envAddress("ESCROW_PAUSER_ADDRESS");
        address escrowTreasurerAddress = vm.envAddress("ESCROW_TREASURER_ADDRESS");
        address escrowTokenConfigAddress = vm.envAddress("ESCROW_TOKEN_CONFIG_ADDRESS");
        address fpPauserAddress = vm.envAddress("FP_PAUSER_ADDRESS");

        vm.startBroadcast();

        // ========================================
        //   WARNING: ALPHA TESTING SCRIPT
        // ========================================
        console.log("========================================");
        console.log("  WARNING: ALPHA TESTING SCRIPT");
        console.log("========================================");
        console.log("This script is for alpha/testnet deployments only.");
        console.log("Before production:");
        console.log("  - Transfer DEFAULT_ADMIN_ROLE to multisig");
        console.log("  - Review all role holders for security");
        console.log("  - Deployer must renounce admin role");
        console.log("========================================");
        console.log("");

        // Step 1: Deploy Escrow
        console.log("Step 1: Deploying Escrow contract...");
        escrow = new Escrow{salt: salt}(IPermit2(permit2Address), msg.sender);
        _assertLinked(address(escrow));
        console.log("Escrow deployed at:", address(escrow));
        console.log("");

        // Step 2: Deploy FulfillmentProxy
        console.log("Step 2: Deploying FulfillmentProxy contract...");
        fulfillmentProxy = new FulfillmentProxy{salt: salt}(msg.sender);
        console.log("FulfillmentProxy deployed at:", address(fulfillmentProxy));
        console.log("");

        // Step 3: Grant roles on Escrow
        console.log("Step 3: Granting roles on Escrow...");

        console.log("  Granting PAUSER_ROLE to:", escrowPauserAddress);
        escrow.grantRole(escrow.PAUSER_ROLE(), escrowPauserAddress);

        console.log("  Granting TREASURER_ROLE to:", escrowTreasurerAddress);
        escrow.grantRole(escrow.TREASURER_ROLE(), escrowTreasurerAddress);

        console.log("  Granting TOKEN_CONFIG_ROLE to:", escrowTokenConfigAddress);
        escrow.grantRole(escrow.TOKEN_CONFIG_ROLE(), escrowTokenConfigAddress);
        console.log("");

        // Step 4: Grant roles on FulfillmentProxy
        console.log("Step 4: Granting roles on FulfillmentProxy...");

        console.log("  Granting PAUSER_ROLE to:", fpPauserAddress);
        fulfillmentProxy.grantRole(fulfillmentProxy.PAUSER_ROLE(), fpPauserAddress);
        console.log("");

        // Final summary
        console.log("========================================");
        console.log("  DEPLOYMENT COMPLETE");
        console.log("========================================");
        console.log("Escrow:", address(escrow));
        console.log("FulfillmentProxy:", address(fulfillmentProxy));
        console.log("");
        console.log("Escrow Roles:");
        console.log("  DEFAULT_ADMIN_ROLE:", msg.sender);
        console.log("  PAUSER_ROLE:", escrowPauserAddress);
        console.log("  TREASURER_ROLE:", escrowTreasurerAddress);
        console.log("  TOKEN_CONFIG_ROLE:", escrowTokenConfigAddress);
        console.log("");
        console.log("FulfillmentProxy Roles:");
        console.log("  DEFAULT_ADMIN_ROLE:", msg.sender);
        console.log("  PAUSER_ROLE:", fpPauserAddress);
        console.log("");
        console.log("========================================");
        console.log("  REMINDER: ALPHA TESTING ONLY");
        console.log("========================================");
        console.log("Before production, transfer DEFAULT_ADMIN_ROLE");
        console.log("to a multisig and renounce deployer admin.");
        console.log("========================================");

        vm.stopBroadcast();
    }
}
