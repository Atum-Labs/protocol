// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {ITIP712} from "./ITIP712.sol";

/// @notice TIP712 helpers for permit2
/// @dev Maintains cross-chain replay protection in the event of a fork
/// @dev Reference: https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/utils/cryptography/EIP712.sol
contract TIP712 is ITIP712 {
    // Cache the domain separator as an immutable value, but also store the chain id that it
    // corresponds to, in order to invalidate the cached domain separator if the chain id changes.
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 private immutable _HASHED_NAME;
    bytes32 private immutable _HASHED_VERSION;

    bytes32 private constant _TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @notice The deploying chain's id does not fit the 32 bits TIP-712 masks it to
    /// @dev See the constructor guard for why this is a deploy-time failure rather than a runtime one
    /// @param chainId The unmasked block.chainid observed at construction
    error ChainIdExceedsTip712Mask(uint256 chainId);

    constructor(string memory name, string memory version) {
        _HASHED_NAME = keccak256(bytes(name));
        _HASHED_VERSION = keccak256(bytes(version));

        // The 32-bit mask below is the ONLY thing separating one Tron network's domain from
        // another's: name, version and verifyingContract are identical across deployments of this
        // contract at the same CREATE2 address. So two chains whose ids differ only ABOVE bit 32
        // would produce a byte-identical domain separator, and a release or refund signature from
        // one would replay verbatim on the other — same escrow address, same witness, same digest.
        //
        // Safe today: every Tron network id fits in 32 bits (mainnet 0x2b6653dc, Nile 0xcd8690dc,
        // Shasta 0x94a9059e). Rejecting a wider id at construction keeps it that way, and does it
        // where the failure is visible. The mask is invisible in the resulting digest, so without
        // this a colliding deployment would look completely normal and the collision would only
        // surface as a signature that works on the wrong network.
        if (block.chainid > type(uint32).max) revert ChainIdExceedsTip712Mask(block.chainid);

        // TIP-712: Use masked chainId
        _CACHED_CHAIN_ID = block.chainid & 0xffffffff;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator(_TYPE_HASH, _HASHED_NAME, _HASHED_VERSION);
    }

    /// @notice Returns the domain separator for the current chain.
    /// @dev Uses cached version if chainid and address are unchanged from construction.
    function DOMAIN_SEPARATOR() public view override returns (bytes32) {
        // TIP-712: Compare masked chainIds
        return (block.chainid & 0xffffffff) == _CACHED_CHAIN_ID
            ? _CACHED_DOMAIN_SEPARATOR
            : _buildDomainSeparator(_TYPE_HASH, _HASHED_NAME, _HASHED_VERSION);
    }

    /// @notice Builds a domain separator using the current chainId and contract address.
    function _buildDomainSeparator(bytes32 typeHash, bytes32 nameHash, bytes32 versionHash)
        private
        view
        returns (bytes32)
    {
        // TIP-712: Use masked chainId
        uint256 chainId = block.chainid & 0xffffffff;
        return keccak256(abi.encode(typeHash, nameHash, versionHash, chainId, address(this)));
    }

    /// @notice Creates an EIP-712 typed data hash
    function _hashTypedData(bytes32 dataHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), dataHash));
    }
}
