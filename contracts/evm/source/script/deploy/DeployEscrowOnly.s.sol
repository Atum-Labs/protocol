// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {console} from "forge-std/Script.sol";
import {Escrow} from "../../src/Escrow.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";
import {EscrowLinkCheck} from "./EscrowLinkCheck.sol";

// The deployer keeps DEFAULT_ADMIN_ROLE and is granted nothing else. Hand the admin role to the multisig
// afterwards (README Step 10); this script does not do that.
//
// Deploys ONLY the Escrow and its three roles, for a chain whose FulfillmentProxy is already deployed.
// DeployAndConfigureAllRoles deploys both, and the proxy's CREATE2 address depends on SALT and the
// deployer alone, so on a chain that already has the proxy (every v4 chain) the second CREATE2 of
// the same initcode reverts. A new escrow generation reuses the existing proxy.
//
// Link EscrowReserveLib first (DeployEscrowReserveLib.s.sol); deploy.sh does both, with DEPLOY_PROXY=0.
//
// ESCROW_RESERVE_LIB_ADDRESS=<address> PERMIT2_ADDRESS=<addr> SALT=<bytes32> ESCROW_PAUSER_ADDRESS=<addr> ESCROW_TREASURER_ADDRESS=<addr> ESCROW_TOKEN_CONFIG_ADDRESS=<addr> \
//   forge script script/deploy/DeployEscrowOnly.s.sol --rpc-url <RPC_URL> --account <KEYSTORE> --sender <DEPLOYER> \
//   --libraries src/EscrowReserveLib.sol:EscrowReserveLib:<address>

contract DeployEscrowOnly is EscrowLinkCheck {
    function setUp() public virtual {}

    function run() public returns (Escrow escrow) {
        address permit2Address = vm.envAddress("PERMIT2_ADDRESS");
        bytes32 salt = vm.envBytes32("SALT");
        address escrowPauserAddress = vm.envAddress("ESCROW_PAUSER_ADDRESS");
        address escrowTreasurerAddress = vm.envAddress("ESCROW_TREASURER_ADDRESS");
        address escrowTokenConfigAddress = vm.envAddress("ESCROW_TOKEN_CONFIG_ADDRESS");

        vm.startBroadcast();

        console.log("Deploying Escrow contract (the existing FulfillmentProxy is reused)...");
        escrow = new Escrow{salt: salt}(IPermit2(permit2Address), msg.sender);
        _assertLinked(address(escrow));
        console.log("Escrow deployed at:", address(escrow));

        console.log("  Granting PAUSER_ROLE to:", escrowPauserAddress);
        escrow.grantRole(escrow.PAUSER_ROLE(), escrowPauserAddress);

        console.log("  Granting TREASURER_ROLE to:", escrowTreasurerAddress);
        escrow.grantRole(escrow.TREASURER_ROLE(), escrowTreasurerAddress);

        console.log("  Granting TOKEN_CONFIG_ROLE to:", escrowTokenConfigAddress);
        escrow.grantRole(escrow.TOKEN_CONFIG_ROLE(), escrowTokenConfigAddress);

        console.log("DEFAULT_ADMIN_ROLE:", msg.sender);
        console.log("REMINDER: the deployer still holds DEFAULT_ADMIN_ROLE. Move it to the multisig (README Step 10).");

        vm.stopBroadcast();
    }
}
