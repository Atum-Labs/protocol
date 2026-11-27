/**
 * The TIP-712 chain id of a Tron network, read off its genesis block.
 *
 * A Tron chain id is the last 4 bytes of block 0's id; it is what `eth_chainId` returns and what
 * TIP712 masks `block.chainid` down to (`block.chainid & 0xffffffff`).
 *
 * @param {string} blockId - block 0's `blockID` as `wallet/getblockbynum {num: 0}` returns it
 * @returns {string} the chain id as 0x-prefixed lowercase hex, 8 digits
 */
function chainIdFromGenesisBlockId(blockId) {
  if (typeof blockId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(blockId)) {
    throw new Error(`not a genesis block id: ${JSON.stringify(blockId)}`);
  }
  return '0x' + blockId.slice(-8).toLowerCase();
}

/**
 * Checks the genesis-derived chain id against the node's own `eth_chainId`.
 *
 * Two independent reads of the same id: if they disagree, the node is not serving the chain its
 * genesis names, and nothing signed against either value can be trusted.
 *
 * @param {string} genesisChainId - from `chainIdFromGenesisBlockId`
 * @param {string} ethChainId - the `result` of a JSON-RPC `eth_chainId` call
 * @returns {string} genesisChainId, once both agree
 */
function crossCheckChainId(genesisChainId, ethChainId) {
  if (typeof ethChainId !== 'string' || !/^0x[0-9a-fA-F]+$/.test(ethChainId)) {
    throw new Error(`eth_chainId is not a hex quantity: ${JSON.stringify(ethChainId)}`);
  }
  if (BigInt(ethChainId) !== BigInt(genesisChainId)) {
    throw new Error(
      `eth_chainId ${ethChainId} disagrees with the genesis block's chain id ${genesisChainId}`
    );
  }
  return genesisChainId;
}

/**
 * Checks what the TVM's CHAINID opcode returns against the genesis-derived chain id.
 *
 * TIP712 caches `block.chainid & 0xffffffff`, and the Escrow constructor reverts with
 * ChainIdExceedsTip712Mask on anything wider. tronbox reports that revert only as "has not been
 * deployed", so it is checked here, on the node, before anything is deployed.
 *
 * @param {string} word - the opcode's 32-byte result as `wallet/triggerconstantcontract` returns
 *   it in `constant_result[0]`: 64 hex digits, no 0x
 * @param {string} genesisChainId - from `crossCheckChainId`
 */
function assertChainIdOpcode(word, genesisChainId) {
  if (typeof word !== 'string' || !/^[0-9a-fA-F]{64}$/.test(word)) {
    throw new Error(`CHAINID result is not a 32-byte word: ${JSON.stringify(word)}`);
  }
  const chainId = BigInt('0x' + word);
  if (chainId > 0xffffffffn) {
    throw new Error(
      `CHAINID 0x${word} is wider than the 4 bytes TIP-712 masks to, so the Escrow constructor would ` +
      'revert with ChainIdExceedsTip712Mask. Use the tronbox/tre digest pinned in docker-compose.yml.'
    );
  }
  if (chainId !== BigInt(genesisChainId)) {
    throw new Error(
      `CHAINID 0x${chainId.toString(16).padStart(8, '0')} disagrees with the genesis block's chain id ${genesisChainId}`
    );
  }
}

module.exports = { chainIdFromGenesisBlockId, crossCheckChainId, assertChainIdOpcode };
