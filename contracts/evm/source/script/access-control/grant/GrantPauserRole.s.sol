// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> PAUSER_ADDRESS=<PAUSER_ADDRESS> forge script script/access-control/grant/GrantPauserRole.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <DEFAULT_ADMIN_ADDRESS>

contract GrantPauserRole is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        bytes32 pauserRole = keccak256("PAUSER_ROLE");

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        IAccessControl targetContract = IAccessControl(contractAddress);

        address pauser = vm.envAddress("PAUSER_ADDRESS");
        console.log("Granting PAUSER_ROLE to the pauser:", pauser);
        targetContract.grantRole(pauserRole, pauser);
        console.log("Role granted successfully");

        vm.stopBroadcast();
    }
}
