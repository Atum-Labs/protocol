// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";

// Deploys EscrowReserveLib at its CREATE2 address, so the Escrow linked to it has an address that
// depends on SALT and the deployer and nothing else. Run it BEFORE the Escrow deploy, and pass the
// printed address to that deploy's `--libraries` and ESCROW_RESERVE_LIB_ADDRESS. deploy.sh does all of it.
//
// SALT=<bytes32> forge script script/deploy/DeployEscrowReserveLib.s.sol --rpc-url <RPC_URL> --account <KEYSTORE> --sender <DEPLOYER>

contract DeployEscrowReserveLib is Script {
    function setUp() public virtual {}

    function run() public returns (address lib) {
        bytes32 salt = vm.envBytes32("SALT");
        address factory = vm.envOr("FACTORY", address(0x4e59b44847b379578588920cA78FbF26c0B4956C));

        // A library has no constructor arguments, so the initcode is the artifact's creation code as is.
        bytes memory initcode = vm.getCode("EscrowReserveLib.sol:EscrowReserveLib");
        lib = vm.computeCreate2Address(salt, keccak256(initcode), factory);

        if (lib.code.length != 0) {
            console.log("EscrowReserveLib already deployed at:", lib);
            return lib;
        }

        vm.startBroadcast();
        // The factory takes salt ++ initcode and returns the 20-byte address.
        (bool ok, bytes memory ret) = factory.call(bytes.concat(salt, initcode));
        vm.stopBroadcast();

        require(ok && ret.length == 20, "CREATE2 factory call failed");
        require(address(bytes20(ret)) == lib, "factory returned an unexpected address");
        require(lib.code.length != 0, "EscrowReserveLib has no code after deploy");
        console.log("EscrowReserveLib deployed at:", lib);
    }
}
