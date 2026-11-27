/**
 * TIP-712 domain separators rebuilt off-chain, to check what a deployed contract computed.
 *
 * Each mirrors the contract's own `_buildDomainSeparator`; the chain id is the 4-byte one TIP712
 * masks `block.chainid` to, and the address is the 20-byte form `address(this)` takes in the TVM
 * (the base58 / `41`-prefixed form without its `41`).
 */

const { utils } = require('tronweb');

const { keccak256, id, AbiCoder } = utils.ethersUtils;
const abi = AbiCoder.defaultAbiCoder();

/** contracts/TIP712.sol, as Escrow constructs it: `TIP712("Escrow", "3")`. */
const ESCROW_DOMAIN_TYPEHASH = id('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');

/**
 * @param {string} chainId - 0x-prefixed 4-byte chain id
 * @param {string} address - 0x-prefixed 20-byte contract address
 * @returns {string} 0x-prefixed bytes32
 */
function escrowDomainSeparator(chainId, address) {
  return keccak256(abi.encode(
    ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [ESCROW_DOMAIN_TYPEHASH, id('Escrow'), id('3'), chainId, address]
  ));
}

/**
 * @alexroan/permit2-tron's contracts/TIP712.sol: name "Permit2" and, unlike Escrow's, no version.
 */
const PERMIT2_DOMAIN_TYPEHASH = id('EIP712Domain(string name,uint256 chainId,address verifyingContract)');

/**
 * @param {string} chainId - 0x-prefixed 4-byte chain id
 * @param {string} address - 0x-prefixed 20-byte contract address
 * @returns {string} 0x-prefixed bytes32
 */
function permit2DomainSeparator(chainId, address) {
  return keccak256(abi.encode(
    ['bytes32', 'bytes32', 'uint256', 'address'],
    [PERMIT2_DOMAIN_TYPEHASH, id('Permit2'), chainId, address]
  ));
}

/**
 * Fails unless each deployed contract's `DOMAIN_SEPARATOR()` equals the one rebuilt for `chainId`.
 *
 * Run once CHAINID has been checked against the genesis chain id (see run.js). Both TIP712s build
 * their separator from the current masked chain id, so a mismatch then means the domain rebuilt
 * here (name, version or type string) has drifted from the contract's, and every signature the
 * settler builds from it would be rejected on-chain. All mismatches are reported together so one
 * run shows the whole picture.
 *
 * @param {string} chainId - 0x-prefixed 4-byte chain id, as read from the node
 * @param {{escrow: {address: string, actual: string}, permit2: {address: string, actual: string}}} deployed
 *   each contract's 0x-prefixed 20-byte address and the separator it returned
 */
function assertDomainSeparators(chainId, deployed) {
  const checks = [
    ['Escrow', escrowDomainSeparator, deployed.escrow, 'TIP712("Escrow", "3") in Escrow.sol'],
    ['Permit2', permit2DomainSeparator, deployed.permit2, '@alexroan/permit2-tron\'s TIP712 ("Permit2", no version)']
  ];
  const mismatches = checks.flatMap(([name, rebuild, { address, actual }, source]) => {
    const expected = rebuild(chainId, address);
    return String(actual).toLowerCase() === expected
      ? []
      : [
        `${name} DOMAIN_SEPARATOR at ${address} is ${actual}, but the domain rebuilt in domain-separator.js gives ` +
        `${expected} for chain id ${chainId}, which CHAINID already matched; check it against ${source}`
      ];
  });
  if (mismatches.length > 0) {
    throw new Error(mismatches.join('\n'));
  }
}

module.exports = { escrowDomainSeparator, permit2DomainSeparator, assertDomainSeparators };
