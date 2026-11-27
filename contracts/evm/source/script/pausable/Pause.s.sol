// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IPausable {
    function pause() external;
    function paused() external view returns (bool);
}

// CONTRACT_ADDRESS=<CONTRACT_ADDRESS> forge script script/pausable/Pause.s.sol --rpc-url <RPC_URL> --account <FOUNDRY_KEYSTORE_NAME> --sender <PAUSER_ROLE_ADDRESS>

contract Pause is Script {
    function setUp() public virtual {}

    function run() public {
        vm.startBroadcast();

        address contractAddress = vm.envAddress("CONTRACT_ADDRESS");
        IPausable target = IPausable(contractAddress);

        console.log("Pausing contract:", contractAddress);
        target.pause();
        console.log("Contract paused successfully");

        vm.stopBroadcast();
    }
}
