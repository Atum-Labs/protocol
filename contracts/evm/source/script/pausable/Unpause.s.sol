// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IPausable {
    function unpause() external;
    function paused() external view returns (bool);
}

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> forge script script/pausable/Unpause.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <PAUSER_ROLE_ADDRESS>

contract Unpause is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        IPausable target = IPausable(contractAddress);

        console.log("Unpausing contract:", contractAddress);
        target.unpause();
        console.log("Contract unpaused successfully");

        vm.stopBroadcast();
    }
}
