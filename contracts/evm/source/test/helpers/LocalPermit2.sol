// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Vm} from "forge-std/Vm.sol";
import {DeployPermit2} from "permit2/test/utils/DeployPermit2.sol";
import {IPermit2} from "permit2/src/interfaces/IPermit2.sol";

/// @title LocalPermit2
/// @notice Puts REAL Permit2 at its canonical address without an RPC, for the suites whose only
///         reason to fork mainnet was to borrow Permit2's bytecode.
///
/// @dev WHY THIS EXISTS
///
/// Every Escrow suite except the digest test used to open a mainnet fork in `setUp` purely so that
/// `0x000000000022D473030F116dDEE9F6B43aC78BA3` had code. None of them read any other mainnet
/// state: each deploys its own MockToken and its own Escrow. That made the whole CI step depend on
/// a live endpoint for a value that has been immutable since 2022.
///
/// Worse, every `vm.createSelectFork` call site passed NO block number, so each run forked at the
/// chain tip. Foundry's on-disk RPC cache is keyed by block, so it could never hit: identical test
/// code re-fetched state from the network on every run, and a green CI run could go red on the next
/// push with no change to the repository. That is the definition of a flaky gate, and the failure
/// mode is the worst kind — an RPC hiccup surfaces as a contract test failure.
///
/// `permit2/test/utils/DeployPermit2.sol` (vendored in lib/permit2) carries Uniswap's PRECOMPILED
/// Permit2 runtime bytecode and etches it at the canonical address. This is not a mock and not a
/// recompile: it is the same runtime code mainnet serves, which is what makes it a safe substitute
/// for the fork rather than a weakening of the test. `Escrow.canonicalDigest.t.sol` already proved
/// the technique in this tree — it runs a full Permit2 deposit with zero network access and
/// additionally ASSERTS the etched instance's `DOMAIN_SEPARATOR()` against the out-of-band mainnet
/// value rather than assuming it.
///
/// WHAT STILL FORKS, deliberately: exactly one thing — `Escrow.depositFlow.t.sol` FORK_CONFIG mode
/// (`test/Escrow.depositFlow.t.sol:183`), which attaches to a real DEPLOYED escrow and reads its
/// live roles and token config. That is not a Permit2 borrow, so the etch cannot replace it. It is
/// opt-in via env and is not reached by the default configuration; pin a block there if it is ever
/// added to CI, because an unpinned fork cannot hit foundry's block-keyed cache.
///
/// `test/script/ScriptTests.t.sol` used to belong on that list — it forked in 23 individual test
/// bodies — and was converted to this helper in the same change. Every suite in the tree now runs
/// with no endpoint: verified at 335 tests / 35 suites, 0 failures, with ETH_MAINNET_RPC pointed at
/// an unroutable address AND `--no-storage-caching`, so a warm RPC cache cannot be what passes it.
library LocalPermit2 {
    /// @dev forge-std's cheatcode address. Spelled out because a library cannot inherit Test.
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Permit2's canonical address, identical on every chain. Permit2 was deployed with a
    /// vanity CREATE2 salt, so this is a property of the deployment, not of any one network.
    address internal constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice Etches real Permit2 at its canonical address and returns it.
    /// @dev Asserts rather than trusts, on all three things that could make this silently useless:
    ///      the etch landed at the canonical address, the address actually has code afterwards, and
    ///      the PERMIT2_ADDRESS env var the suites pass to `DeployCoreContracts` agrees with it. If
    ///      the env var pointed elsewhere the Escrow would be constructed against an address with
    ///      no code and every deposit would revert for an unrelated-looking reason.
    function etch() internal returns (IPermit2) {
        address deployed = new DeployPermit2().deployPermit2();
        require(deployed == CANONICAL_PERMIT2, "LocalPermit2: etched at an unexpected address");
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
