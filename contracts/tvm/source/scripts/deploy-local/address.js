/**
 * Tron address forms. The artifact carries base58, which is what the settler's preflight asks the
 * node about (`wallet/getcontract` with `visible: true`); the domain separator check needs the
 * 20-byte form the TVM uses for `address(this)`.
 */

const { TronWeb } = require('tronweb');

/**
 * @param {string} address - base58, or 41-prefixed hex as tronbox records it
 * @returns {string} base58
 */
function toBase58(address) {
  if (typeof address !== 'string' || !TronWeb.isAddress(address)) {
    throw new Error(`not a Tron address: ${JSON.stringify(address)}`);
  }
  return TronWeb.address.fromHex(address);
}

/**
 * @param {string} address - base58, or 41-prefixed hex
 * @returns {string} the 0x-prefixed 20-byte address, without the 41 network prefix
 */
function toEvmAddress(address) {
  return '0x' + TronWeb.address.toHex(toBase58(address)).slice(2).toLowerCase();
}

/**
 * @param {string} a - base58, or 41-prefixed hex
 * @param {string} b - base58, or 41-prefixed hex
 * @returns {boolean} whether both name the same address
 */
function sameAddress(a, b) {
  return toBase58(a) === toBase58(b);
}

module.exports = { toBase58, toEvmAddress, sameAddress };
