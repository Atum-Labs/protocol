// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";

/// @notice Post-deploy check that an Escrow was linked to the library the driver derived.
/// @dev `Escrow.reserve()` delegatecalls `EscrowReserveLib`, whose address is baked into the escrow's
///      runtime code and therefore into its initcode hash, and so into its CREATE2 address. Without
///      `--libraries`, `forge script` deploys the library itself, and with `always_use_create_2_factory`
///      (set in foundry.toml) it does so through the CREATE2 factory with salt 0. The escrow still
///      deploys, linked to that salt-0 library, at an address that is not the one derived from SALT
///      and the deployer, and nothing reverts. The shell drivers pass `ESCROW_RESERVE_LIB_ADDRESS`
///      (the CREATE2 address they derived) and `--libraries` together; this reverts when the two disagree.
///      The env examples export it from ESCROW_LIB, so a manual run of these scripts is checked too once
///      that is pinned. Left unset (anvil and the docker stack), it only prints a note.
abstract contract EscrowLinkCheck is Script {
    function _assertLinked(address escrow) internal view {
        address lib = vm.envOr("ESCROW_RESERVE_LIB_ADDRESS", address(0));
        if (lib == address(0)) {
            console.log("NOTE: ESCROW_RESERVE_LIB_ADDRESS not set; the library address was not checked");
            return;
        }
        require(
            _contains(escrow.code, abi.encodePacked(lib)),
            "Escrow runtime does not embed ESCROW_RESERVE_LIB_ADDRESS: pass --libraries src/EscrowReserveLib.sol:EscrowReserveLib:<address>"
        );
        console.log("Escrow is linked to EscrowReserveLib at:", lib);
    }

    function _contains(bytes memory haystack, bytes memory needle) private pure returns (bool) {
        if (needle.length == 0 || haystack.length < needle.length) return false;
        for (uint256 i = 0; i <= haystack.length - needle.length; i++) {
            bool hit = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    hit = false;
                    break;
                }
            }
            if (hit) return true;
        }
        return false;
    }
}
