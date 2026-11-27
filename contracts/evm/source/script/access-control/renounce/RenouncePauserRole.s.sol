// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> forge script script/access-control/renounce/RenouncePauserRole.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <PAUSER_ROLE_HOLDER>

contract RenouncePauserRole is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        bytes32 pauserRole = keccak256("PAUSER_ROLE");

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        IAccessControl targetContract = IAccessControl(contractAddress);

        console.log("Renouncing PAUSER_ROLE for caller:", msg.sender);
        targetContract.renounceRole(pauserRole, msg.sender);
        console.log("Role renounced successfully");

        vm.stopBroadcast();
    }
}
