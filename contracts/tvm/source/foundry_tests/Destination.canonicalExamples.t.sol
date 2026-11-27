// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

/// @title Canonical destination examples + casing-rule conformance, pinned on TVM (CORE-2120)
/// @notice THE canonical example set for the ratified destination format, re-pinned on the Tron side
/// so that both trees commit to the same bytes. The grammar and the per-segment casing rule are
/// ratified in contracts/evm/source/ONCHAIN_SPEC.md ("`destination` and `depositRequestHash`: what
/// the contract defines, and what it does not"); integrators copy from the constants below, not from
/// other fixtures in this tree, which are arbitrary byte strings and are labelled as such in place
/// (helpers/Signatures.sol's DEFAULT_DESTINATION uses `0xaaaa`/`0xbbbb` placeholders, and
/// Escrow.canonicalDepositDigest.t.sol's is a signing-digest fixture).
///
/// WHY THIS FILE EXISTS ON TRON, given the EVM tree pins the same set. The commitment is inherently
/// cross-chain: the depositor signs the destination here, and the consumer that rebuilds a
/// Release/RefundWitness reads it back somewhere else entirely. Both sides must produce identical
/// bytes, because Escrow stores and compares only keccak256(bytes(destination)) and parses nothing —
/// contracts/Escrow.sol checks the 1..256-byte length and no more. So an example that has drifted by
/// one byte on the Tron side (a re-cased base58 segment is the realistic way that happens) hands an
/// integrator a commitment the counterparty cannot reproduce, and the resulting deposit is neither
/// releasable nor refundable: this escrow has NO rescue function.
///
/// Every hash below was derived OUT OF BAND with `cast keccak`, and each is the literal the EVM suite
/// and ONCHAIN_SPEC.md already print. Do not regenerate them from Solidity, and do not repoint one to
/// make a failing test pass — repointing is precisely how a corrupted canonical example ships.
///
/// @dev The casing rule, restated: lowercase everything, EXCEPT base58 values, which are
/// case-significant and preserved byte-for-byte. Enforcement is OFF-CHAIN, in producers and
/// consumers; the contract is format-agnostic, which is why these checks live in a test and not in
/// Escrow.sol. Nothing here forks, deploys, etches Permit2 or reads an env var: it is keccak over
/// string literals, chain-agnostic in exactly the way the commitment it pins is.
contract DestinationCanonicalExamplesTest is Test {
    /// @dev Mirror of Escrow.sol's private MAX_DESTINATION_BYTES. The contract-side pin is the
    /// DestinationTooLong guard in `_deposit`, not this copy, which only bounds the canonical
    /// examples below; this file never calls the contract.
    uint256 private constant MAX_DESTINATION_BYTES = 256;

    // ---- the canonical example set ----
    // (Plain comments, not natspec: solc parses an "@" inside a doc block as a tag, and every
    // destination contains one.)

    // Base USDC to an EOA. Canonical eip155/erc20 form: namespace, asset namespace, and BOTH hex
    // segments (asset reference and account) all-lowercase — explicitly NOT EIP-55.
    string private constant CANONICAL_EIP155_ERC20 =
        "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979";
    /// @dev cast keccak of CANONICAL_EIP155_ERC20 (103 bytes).
    bytes32 private constant CANONICAL_EIP155_ERC20_HASH =
        0x7e096a6d1abcfc4daab28cec3f3d3a458c3facbfa0f3493284bb891bdc9807ef;

    // Native ETH (slip44:60) on Ethereum mainnet to the same EOA. The asset reference is decimal,
    // so the account is the only cased segment — lowercase hex.
    string private constant CANONICAL_EIP155_SLIP44 = "eip155:1/slip44:60@0xc0ffee254729296a45a3885639ac7e10f9d54979";
    /// @dev cast keccak of CANONICAL_EIP155_SLIP44 (61 bytes).
    bytes32 private constant CANONICAL_EIP155_SLIP44_HASH =
        0x7f145a7e736ea3b627f216bc20d0fee3dccd897fd88bed8a703527b025d18a75;

    // Solana-mainnet USDC to a base58 account. THREE base58 segments — the CAIP-2 genesis-hash
    // reference (5eykt4Us…), the SPL mint asset reference (EPjFWdd5…), AND the account — all keep
    // their exact mixed case: base58 is case-significant, so a blanket lowercase corrupts all
    // three at once. Only the `solana`/`token` identifiers are (already) lowercase. Tron accounts
    // are base58 too, so this carve-out is the one an integrator on this chain is most likely to
    // reach for, and the one a "normalize the string" helper is most likely to break.
    string private constant CANONICAL_SOLANA_TOKEN =
        "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp/token:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v@9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    /// @dev cast keccak of CANONICAL_SOLANA_TOKEN (135 bytes). This pin is what makes the case
    /// preservation load-bearing: any later "helpful" re-casing of the literal above changes the
    /// hash and fails test_solanaCanonicalExample_isPreservedByteForByte.
    bytes32 private constant CANONICAL_SOLANA_TOKEN_HASH =
        0x6e6a064bee8339ac86f3894ef404261671f23c0df96b83495db4e46f53ffca11;
    /// @dev cast keccak of the ASCII-lowercased CANONICAL_SOLANA_TOKEN: the corrupted commitment a
    /// blanket-lowercasing producer would sign. Pinned so the divergence proof below is exact.
    bytes32 private constant LOWERCASED_SOLANA_TOKEN_HASH =
        0xf5c5c7c6f9ec77f1d16171c50c82be44ecc01848ff82dd62c88b45d4064d673d;

    // ---- conformance: the casing rule, checked mechanically ----

    /// @notice Canonical eip155 destinations are lowercase THROUGHOUT: every segment of an eip155
    /// destination (namespace, decimal chain reference, asset namespace, hex asset reference, hex
    /// account) is caseless or lowercase, so a single uppercase ASCII byte anywhere is a violation
    /// (an EIP-55 rendering is the usual way one sneaks in).
    function test_eip155CanonicalExamples_containNoUppercase() public pure {
        _assertNoUppercase(CANONICAL_EIP155_ERC20, "erc20 example");
        _assertNoUppercase(CANONICAL_EIP155_SLIP44, "slip44 example");
    }

    /// @notice The Solana example must survive byte-for-byte: its hash is pinned out of band, so
    /// re-casing (or otherwise editing) the literal fails here rather than silently publishing a
    /// corrupted canonical example.
    function test_solanaCanonicalExample_isPreservedByteForByte() public pure {
        assertEq(
            keccak256(bytes(CANONICAL_SOLANA_TOKEN)),
            CANONICAL_SOLANA_TOKEN_HASH,
            "the Solana canonical example no longer matches its pinned out-of-band hash; its base58 segments are case-significant and must be preserved byte-for-byte"
        );
    }

    /// @notice Case-significance is load-bearing, not stylistic: lowercasing the Solana example
    /// actually changes the string and its keccak256 commitment, to the exact pinned corrupted
    /// hash — proof that a blanket-lowercase producer signs an unsettleable commitment.
    function test_solanaCanonicalExample_lowercasingChangesItsHash() public pure {
        string memory lowered = _asciiLowercase(CANONICAL_SOLANA_TOKEN);
        assertTrue(
            keccak256(bytes(lowered)) != keccak256(bytes(CANONICAL_SOLANA_TOKEN)),
            "lowercasing did not change the Solana example; the case-preservation carve-out would be untestable"
        );
        assertEq(
            keccak256(bytes(lowered)),
            LOWERCASED_SOLANA_TOKEN_HASH,
            "the lowercased Solana example does not match its pinned hash; the divergence proof is no longer exact"
        );
    }

    /// @notice Every canonical example is a valid on-chain commitment preimage: within the 1..256
    /// byte bound the contract enforces, and round-tripping through keccak256(bytes(...)) to its
    /// pinned out-of-band hash.
    function test_canonicalExamples_areWithinBounds_andMatchPinnedHashes() public pure {
        _assertCanonical(CANONICAL_EIP155_ERC20, CANONICAL_EIP155_ERC20_HASH, "erc20 example");
        _assertCanonical(CANONICAL_EIP155_SLIP44, CANONICAL_EIP155_SLIP44_HASH, "slip44 example");
        _assertCanonical(CANONICAL_SOLANA_TOKEN, CANONICAL_SOLANA_TOKEN_HASH, "solana example");
    }

    /// @notice Pins the width of the widest canonical example. Escrow.sol here justifies its cap as
    /// "uniform 256 across EVM/TVM/SVM so one client signing-policy rule covers every chain" rather
    /// than by naming a width, so on this side the 135 is what makes the headroom claim checkable —
    /// and it is the width ONCHAIN_SPEC.md prints beside the example, which the EVM contract comment
    /// cites verbatim. If the literal grows, the two trees and the spec have to be re-reconciled.
    function test_solanaCanonicalExample_isExactly135Bytes() public pure {
        assertEq(
            bytes(CANONICAL_SOLANA_TOKEN).length,
            135,
            "the widest canonical example is no longer 135 bytes; re-check ONCHAIN_SPEC.md and Escrow.sol's MAX_DESTINATION_BYTES comment on BOTH chains"
        );
    }

    /// @notice The commitment is keccak256 over the destination bytes and NOTHING else — in
    /// particular not block.chainid. Stated in the EVM tree only by the fact that the same literals
    /// are pinned there; pinned mechanically here because Tron is where the assumption is easiest to
    /// doubt. TIP712.sol masks block.chainid to 32 bits when it builds the domain separator, so this
    /// tree already contains one deliberately chain-scoped hash, and a reader could reasonably
    /// assume the destination hash is scoped the same way. It is not, and must not be: the depositor
    /// commits on Tron while the party that rebuilds the Release/RefundWitness settles elsewhere, so
    /// a chain-scoped preimage could never be reproduced at settlement. The chain ids below are the
    /// three TIP712.sol enumerates plus the two the eip155 examples name.
    function test_canonicalExampleHashes_areIndependentOfChainId() public {
        uint256[5] memory chainIds = [
            uint256(0x2b6653dc), // Tron mainnet
            0xcd8690dc, // Tron Nile
            0x94a9059e, // Tron Shasta
            1, // Ethereum mainnet, the chain the slip44 example names
            8453 // Base, the chain the erc20 example names
        ];
        for (uint256 i = 0; i < chainIds.length; i++) {
            vm.chainId(chainIds[i]);
            _assertCanonical(CANONICAL_EIP155_ERC20, CANONICAL_EIP155_ERC20_HASH, "erc20 example");
            _assertCanonical(CANONICAL_EIP155_SLIP44, CANONICAL_EIP155_SLIP44_HASH, "slip44 example");
            _assertCanonical(CANONICAL_SOLANA_TOKEN, CANONICAL_SOLANA_TOKEN_HASH, "solana example");
        }
    }

    // ---- helpers ----

    function _assertNoUppercase(string memory destination, string memory label) private pure {
        bytes memory raw = bytes(destination);
        for (uint256 i = 0; i < raw.length; i++) {
            assertFalse(
                raw[i] >= 0x41 && raw[i] <= 0x5A,
                string.concat(
                    label, ": uppercase byte in a canonical eip155 destination (EIP-55 is explicitly NOT canonical)"
                )
            );
        }
    }

    function _assertCanonical(string memory destination, bytes32 pinnedHash, string memory label) private pure {
        uint256 length = bytes(destination).length;
        assertTrue(length >= 1, string.concat(label, ": destination must be non-empty"));
        assertTrue(length <= MAX_DESTINATION_BYTES, string.concat(label, ": destination exceeds the contract's cap"));
        assertEq(keccak256(bytes(destination)), pinnedHash, string.concat(label, ": pinned out-of-band hash mismatch"));
    }

    /// @dev ASCII-only lowercase, which is exactly the corruption a naive normalizer applies.
    function _asciiLowercase(string memory value) private pure returns (string memory) {
        bytes memory raw = bytes(value);
        for (uint256 i = 0; i < raw.length; i++) {
            if (raw[i] >= 0x41 && raw[i] <= 0x5A) {
                raw[i] = bytes1(uint8(raw[i]) + 32);
            }
        }
        return string(raw);
    }
}
