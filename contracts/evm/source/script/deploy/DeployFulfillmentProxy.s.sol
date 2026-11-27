// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {FulfillmentProxy} from "../../src/FulfillmentProxy.sol";

// Run it through contracts/evm/deploy/deploy-fulfillment-proxy.sh, which adds the config, chain-id
// and post-broadcast checks. The bare form, for reference:
//
// SALT=<bytes32> FP_PAUSER_ADDRESS=<addr> [EXPECT_FPROXY=<addr>] [ESCROW=<addr>] \
//   forge script script/deploy/DeployFulfillmentProxy.s.sol --rpc-url <RPC_URL> --account atum-deployer-<network> --sender <DEPLOYER_ADDRESS>
//
// Call the Arachnid CREATE2 factory. new {salt:}() is not used: on Base and
// Optimism Sepolia, Forge simulates that as CREATE2 from the deployer and
// then broadcasts a plain CREATE at the deployer's nonce.
//
// The constructor grants only DEFAULT_ADMIN_ROLE (to msg.sender), so the same broadcast grants
// PAUSER_ROLE to FP_PAUSER_ADDRESS. Without it the proxy cannot be paused.

contract DeployFulfillmentProxy is Script {
    // forge-std Base already declares CREATE2_FACTORY at 0x4e59b44847b379578588920cA78FbF26c0B4956C.

    function setUp() public virtual {}

    function run() public returns (FulfillmentProxy) {
        return deploy(
            vm.envBytes32("SALT"),
            vm.envAddress("FP_PAUSER_ADDRESS"),
            vm.envOr("EXPECT_FPROXY", address(0)),
            vm.envOr("ESCROW", address(0))
        );
    }

    /// @param expected Independent pin for the CREATE2 address; address(0) skips it.
    /// @param escrow This network's live Escrow, required to have code; address(0) skips it.
    function deploy(bytes32 salt, address pauser, address expected, address escrow)
        public
        returns (FulfillmentProxy fulfillmentProxy)
    {
        require(pauser != address(0), "FP_PAUSER_ADDRESS is zero");

        bytes memory initCode = abi.encodePacked(type(FulfillmentProxy).creationCode, abi.encode(msg.sender));
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_FACTORY);
        console.log("FulfillmentProxy predicted address:", predicted);

        // The prediction is derived from SALT, the sender and this tree's bytecode, so it agrees with
        // the deploy by construction. EXPECT_FPROXY is the independent pin, as in deploy.sh.
        require(expected == address(0) || expected == predicted, "predicted address differs from EXPECT_FPROXY");
        // The proxy-only path assumes the network's Escrow is already live.
        require(escrow == address(0) || escrow.code.length > 0, "no code at ESCROW on this chain");

        vm.startBroadcast();

        bytes memory payload = abi.encodePacked(salt, initCode);
        (bool ok, bytes memory ret) = CREATE2_FACTORY.call(payload);
        require(ok, "CREATE2 factory call failed");
        require(ret.length == 20, "CREATE2 factory return");
        address deployed = address(bytes20(ret));
        require(deployed == predicted, "CREATE2 address mismatch");
        fulfillmentProxy = FulfillmentProxy(deployed);

        console.log("FulfillmentProxy contract deployed at:", address(fulfillmentProxy));

        fulfillmentProxy.grantRole(keccak256("PAUSER_ROLE"), pauser);
        console.log("PAUSER_ROLE granted to:", pauser);

        vm.stopBroadcast();
    }
}
