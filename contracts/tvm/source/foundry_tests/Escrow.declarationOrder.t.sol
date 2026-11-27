// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

/// @notice Pins the DECLARATION ORDER of TVM's EIP-712 witness structs to their canonical type strings.
///
/// WHY THIS IS SEPARATE FROM Escrow.canonicalDigest.t.sol. That file pins the *encode* order — the
/// argument order of `abi.encode` inside `Escrow.sol`. This file pins the *declaration* order — the
/// member order of the `struct` bodies in `IEscrow.sol`. They are genuinely different vectors:
///
///   - Transposing two same-type members in an `abi.encode` call changes the struct hash, so the
///     canonical-digest guard catches it.
///   - Transposing them in the `struct` DECLARATION leaves the ABI type sequence identical, so no
///     function selector and no event topic0 moves, and `Escrow.sol` reads every member by NAME so the
///     contract keeps working. What silently changes is the ABI that other repositories generate their
///     clients from: a caller that encodes the tuple positionally against a stale ABI populates the two
///     commitments swapped, the settlement reconstruction disagrees with storage, and release and
///     refund revert `InvalidWitnessValues` forever. This escrow has no rescue function.
///
/// `make check-abi` cannot catch it either: it runs `generate-abi` and fails only if the output is
/// dirty, which is a "did you regenerate" check, not a correctness check.
///
/// HOW IT WORKS. Each test reads `IEscrow.sol` at test time, strips comments, locates the
/// `struct <Name> {` declaration, rebuilds the canonical EIP-712 type string from the member list IN
/// DECLARATION ORDER, and requires it to hash to the typehash pinned in this file. The pinned typehashes
/// are the values `Escrow.sol` actually uses and are byte-identical to EVM's, because the canonical type
/// strings are identical across the two chains — so a TVM-only divergence is a bug, not a Tron quirk.
///
/// Comment text can never satisfy a match: the source goes through `_codeOnly` first, so a
/// commented-out old declaration cannot win. The struct-name match is anchored on identifier characters
/// at both ends and must be followed by `{`, so `ReleaseWitnessV2` cannot satisfy a search for
/// `ReleaseWitness`.
///
/// DO NOT repoint a pinned literal to make a failing test pass. A changed declaration is a BREAKING
/// change for every generated client; re-derive out of band and treat it as such.
contract EscrowDeclarationOrderTest is Test {
    string private constant IESCROW_SOURCE_PATH = "contracts/interfaces/IEscrow.sol";

    // The four canonical typehashes, byte-identical to EVM's. Quoted type strings are the canonical
    // ones these were derived from.
    // keccak256("DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)")
    bytes32 private constant DEPOSIT_WITNESS_TYPE_HASH =
        0x49bfb2c307c3a42001389497e5f5b9dc592052768c1f3cdf09aac3c58ec582b9;
    // keccak256("ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)")
    bytes32 private constant RESERVE_WITNESS_TYPE_HASH =
        0x231586e09714868d376f25b00c3a8dc8e307d350b64e22fbeb6578bb7bc6fd87;
    // keccak256("ReleaseWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)")
    bytes32 private constant RELEASE_WITNESS_TYPE_HASH =
        0x7b53386f16fef70a2a3ea71bda140486e6167753168b12a94b218b94de37fe7b;
    // keccak256("RefundWitness(bytes32 depositId,bytes32 quoteHash,bytes32 depositRequestHash,bytes32 destinationHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)")
    bytes32 private constant REFUND_WITNESS_TYPE_HASH =
        0x3b5d88b2664086649c47fb1bddafbc2c1f05c6be52fb1c1f11c53db3c608772d;

    function test_depositWitnessDeclarationOrderIsPinned() public view {
        _assertDeclarationOrderMatchesTypeString("DepositWitness", DEPOSIT_WITNESS_TYPE_HASH);
    }

    function test_reserveWitnessDeclarationOrderIsPinned() public view {
        _assertDeclarationOrderMatchesTypeString("ReserveWitness", RESERVE_WITNESS_TYPE_HASH);
    }

    function test_releaseWitnessDeclarationOrderIsPinned() public view {
        _assertDeclarationOrderMatchesTypeString("ReleaseWitness", RELEASE_WITNESS_TYPE_HASH);
    }

    function test_refundWitnessDeclarationOrderIsPinned() public view {
        _assertDeclarationOrderMatchesTypeString("RefundWitness", REFUND_WITNESS_TYPE_HASH);
    }

    /// @dev A missing declaration must FAIL rather than silently skip: a guard that quietly passes when
    ///      it cannot find its target is worse than no guard.
    function _assertDeclarationOrderMatchesTypeString(string memory structName, bytes32 expectedTypeHash) private view {
        (bool found, string memory declared) =
            _typeStringFromDeclaration(_codeOnly(vm.readFile(IESCROW_SOURCE_PATH)), structName);

        assertTrue(
            found,
            string.concat(
                "no `struct ",
                structName,
                " {` declaration found in ",
                IESCROW_SOURCE_PATH,
                " - it was renamed or removed. This guard cannot verify anything, which is a failure, not a skip."
            )
        );
        assertEq(
            keccak256(bytes(declared)),
            expectedTypeHash,
            string.concat(
                "THE `",
                structName,
                "` STRUCT DECLARATION ORDER IN contracts/interfaces/IEscrow.sol HAS DRIFTED FROM THE CANONICAL EIP-712 TYPE STRING. Rebuilt member by member from that declaration it reads `",
                declared,
                "`, which does not hash to the pinned typehash. No selector or topic0 moves when two same-type members are exchanged, and Escrow.sol reads members by name, so the contract keeps working while the ABI other repositories generate clients from silently changes. Do NOT repoint the pinned literal: re-derive it out of band and treat a changed declaration as a breaking change for every generated client."
            )
        );
    }

    /// @dev `source` with every comment replaced by a single space, so a scan over the result can
    ///      only match real code. Used by every source-scanning guard in this file, because a scan
    ///      that reads comments as if they were code is the exact hole that let a whole-file
    ///      substring search be satisfied by a leftover "previously was 0x…" note (80bfac9): the
    ///      declaration-anchored scan that replaced it still read comment text, so a comment ABOVE a
    ///      constant, or a commented-out old declaration, could still win.
    ///
    ///      A comment becomes ONE SPACE rather than being deleted, so it can never fuse the tokens
    ///      on either side of it into a single identifier, and a line comment's terminating newline
    ///      is preserved so line structure survives. String literals are respected: a `//` or `/*`
    ///      inside a string never starts a comment, and a `\`-escaped quote never ends the string.
    function _codeOnly(string memory source) private pure returns (string memory) {
        bytes memory src = bytes(source);
        uint256 srcLen = src.length;
        // Never longer than the input: a comment of >= 2 consumed characters emits at most 2.
        bytes memory out = new bytes(srcLen);
        uint256 outLen;

        for (uint256 i = 0; i < srcLen; i++) {
            bytes1 c = src[i];

            if (c == '"' || c == "'") {
                bytes1 quote = c;
                out[outLen++] = c;
                i++;
                while (i < srcLen) {
                    out[outLen++] = src[i];
                    if (src[i] == "\\" && i + 1 < srcLen) {
                        i++;
                        out[outLen++] = src[i]; // escaped character: never a terminator
                    } else if (src[i] == quote) {
                        break;
                    }
                    i++;
                }
                continue;
            }

            if (c == "/" && i + 1 < srcLen && src[i + 1] == "/") {
                while (i < srcLen && src[i] != "\n") i++;
                out[outLen++] = " ";
                if (i < srcLen) out[outLen++] = "\n"; // the loop's own i++ steps past it
                continue;
            }
            if (c == "/" && i + 1 < srcLen && src[i + 1] == "*") {
                i += 2;
                while (i + 1 < srcLen && !(src[i] == "*" && src[i + 1] == "/")) i++;
                i++; // land on the closing '/', which the loop's own i++ then steps past
                out[outLen++] = " ";
                continue;
            }

            out[outLen++] = c;
        }

        bytes memory trimmed = new bytes(outLen);
        for (uint256 n; n < outLen; n++) {
            trimmed[n] = out[n];
        }
        return string(trimmed);
    }

    function _isIdentifierChar(bytes1 c) private pure returns (bool) {
        return (c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c == "_";
    }

    function _isWhitespace(bytes1 c) private pure returns (bool) {
        return c == " " || c == "\t" || c == "\n" || c == "\r";
    }

    /// @dev Rebuilds `StructName(type1 name1,type2 name2,...)` - the canonical EIP-712 type string
    ///      for a struct of elementary members - from the `struct StructName { ... }` declaration in
    ///      `source`, members in DECLARATION ORDER. Line and block comments inside the body are
    ///      stripped and each member's internal whitespace is collapsed to a single space, so the
    ///      result is independent of formatting. The struct name match is anchored against
    ///      identifier characters on both sides and must be followed by `{`, so a longer identifier
    ///      (`ReleaseWitnessV2`) cannot satisfy it; `source` is expected to have been through
    ///      `_codeOnly`, so a comment that quotes `struct ReleaseWitness {` cannot either.
    ///      Returns found=false when no such declaration exists anywhere in the file.
    function _typeStringFromDeclaration(string memory source, string memory structName)
        private
        pure
        returns (bool found, string memory typeString)
    {
        bytes memory src = bytes(source);
        bytes memory needle = bytes(string.concat("struct ", structName));
        uint256 srcLen = src.length;
        uint256 needleLen = needle.length;

        for (uint256 i = 0; i + needleLen <= srcLen; i++) {
            if (i > 0 && _isIdentifierChar(src[i - 1])) continue;

            uint256 j = 0;
            while (j < needleLen && src[i + j] == needle[j]) j++;
            if (j != needleLen) continue;

            uint256 k = i + needleLen;
            // Reject a longer identifier that merely starts with the name.
            if (k < srcLen && _isIdentifierChar(src[k])) continue;
            while (k < srcLen && _isWhitespace(src[k])) k++;
            if (k >= srcLen || src[k] != "{") continue;

            return (true, string.concat(structName, "(", _declaredMemberList(src, k + 1), ")"));
        }
        return (false, "");
    }

    /// @dev The comma-separated `type name` list of a struct body starting at `start` (just past the
    ///      opening brace) and ending at the first `}`.
    function _declaredMemberList(bytes memory src, uint256 start) private pure returns (string memory) {
        uint256 srcLen = src.length;
        // Never longer than the body it is built from: every emitted comma replaces a consumed `;`.
        bytes memory out = new bytes(srcLen - start);
        uint256 outLen;
        uint256 members;
        bool atMemberStart = true;
        bool pendingSpace;

        for (uint256 i = start; i < srcLen; i++) {
            bytes1 c = src[i];
            if (c == "}") break;

            if (c == "/" && i + 1 < srcLen && src[i + 1] == "/") {
                while (i < srcLen && src[i] != "\n") i++;
                continue;
            }
            if (c == "/" && i + 1 < srcLen && src[i + 1] == "*") {
                i += 2;
                while (i + 1 < srcLen && !(src[i] == "*" && src[i + 1] == "/")) i++;
                i++; // land on the closing '/', which the loop's own i++ then steps past
                continue;
            }

            if (c == ";") {
                if (!atMemberStart) members++;
                atMemberStart = true;
                pendingSpace = false;
                continue;
            }
            if (_isWhitespace(c)) {
                if (!atMemberStart) pendingSpace = true; // collapsed; dropped if the member ends here
                continue;
            }

            if (atMemberStart) {
                if (members > 0) {
                    out[outLen++] = ",";
                }
                atMemberStart = false;
            } else if (pendingSpace) {
                out[outLen++] = " ";
            }
            pendingSpace = false;
            out[outLen++] = c;
        }

        bytes memory trimmed = new bytes(outLen);
        for (uint256 m; m < outLen; m++) {
            trimmed[m] = out[m];
        }
        return string(trimmed);
    }
}
