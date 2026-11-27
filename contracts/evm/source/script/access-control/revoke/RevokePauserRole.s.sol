// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> PAUSER_ADDRESS=<PAUSER_ADDRESS> forge script script/access-control/revoke/RevokePauserRole.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <DEFAULT_ADMIN_ADDRESS>

contract RevokePauserRole is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        bytes32 pauserRole = keccak256("PAUSER_ROLE");

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        IAccessControl targetContract = IAccessControl(contractAddress);

        address pauser = vm.envAddress("PAUSER_ADDRESS");
        console.log("Revoking PAUSER_ROLE from:", pauser);
        targetContract.revokeRole(pauserRole, pauser);
        console.log("Role revoked successfully");

        vm.stopBroadcast();
    }
}
