// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {Vm} from "forge-std/Vm.sol";
import {IPermit2} from "@alexroan/permit2-tron/contracts/interfaces/IPermit2.sol";

/// @title LocalPermit2
/// @notice Puts the Tron Permit2 at its canonical address without an RPC, for the suites whose only
///         reason to fork mainnet was to borrow Permit2's bytecode.
///
/// @dev WHY THIS EXISTS
///
/// Every Escrow suite here opened a mainnet fork in `setUp` purely so that
/// `0x000000000022D473030F116dDEE9F6B43aC78BA3` had code. None of them read any other chain state:
/// each deploys its own mock token and its own Escrow. That made the whole CI step depend on a live
/// endpoint for a value that has not changed since 2022.
///
/// Worse, every `vm.createSelectFork` call site passed NO block number, so each run forked at the
/// chain tip. Foundry's on-disk RPC cache is keyed by block, so it could never hit: identical test
/// code re-fetched state on every run, and a green CI run could go red on the next push with no
/// change to the repository. That is a flaky gate whose failure mode is the worst kind — an RPC
/// hiccup surfacing as a contract test failure.
///
/// PINNING A BLOCK IS NOT ENOUGH, and finding that out is why this helper exists rather than a
/// `createSelectFork(url, block)` one-liner. A pinned historical block makes the cache work, but it
/// turns every run into an ARCHIVE request, and the public endpoint this job defaults to answers
/// those with `HTTP 403: Archive requests require a personal token`. So pinning alone trades
/// flakiness for a hard dependency on an archive subscription.
///
/// This etches the Permit2 runtime bytecode that ships inside the vendored permit2-tron package's build
/// output — the same artifact the deployment migrations use, so it is the code Tron actually runs,
/// not a mock or a re-compile. No network, no archive node, no block to keep fresh.
library LocalPermit2 {
    /// @dev forge-std's cheatcode address. Spelled out because a library cannot inherit Test.
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Permit2's canonical address, identical on every chain: it was deployed with a vanity
    /// CREATE2 salt, so this is a property of the deployment rather than of any one network.
    address internal constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @dev The vendored build output carrying the runtime bytecode.
    string internal constant ARTIFACT = "node_modules/@alexroan/permit2-tron/out/Permit2.sol/Permit2.json";

    /// @notice Etches Permit2 at its canonical address and returns it.
    /// @dev Asserts rather than trusts, on all three things that could make this silently useless:
    ///      that the artifact actually yielded code, that the canonical address has code afterwards,
    ///      and that the PERMIT2_ADDRESS env var the suites pass to `DeployCoreContracts` agrees with
    ///      it. If the env var pointed elsewhere the Escrow would be constructed against an address
    ///      with no code and every deposit would revert for an unrelated-looking reason.
    function etch() internal returns (IPermit2) {
        bytes memory runtime = VM.parseJsonBytes(VM.readFile(ARTIFACT), ".deployedBytecode.object");
        require(runtime.length != 0, "LocalPermit2: empty runtime bytecode in the permit2-tron artifact");

        VM.etch(CANONICAL_PERMIT2, runtime);
        require(CANONICAL_PERMIT2.code.length != 0, "LocalPermit2: no code at the canonical address after etch");

        address configured = VM.envAddress("PERMIT2_ADDRESS");
        require(
            configured == CANONICAL_PERMIT2,
            "LocalPermit2: PERMIT2_ADDRESS does not match Permit2's canonical address, so the escrow "
            "would be deployed against an address with no code"
        );
        return IPermit2(CANONICAL_PERMIT2);
    }
}
