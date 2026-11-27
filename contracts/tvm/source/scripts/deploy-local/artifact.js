/**
 * deployment-addresses.json, the file the settler's e2e preflight and Tron harness read.
 */

const { toBase58 } = require('./address');

const ADDRESS_KEYS = ['escrow', 'fulfillmentProxy', 'permit2', 'usdc', 'usdt'];

/**
 * @param {{escrow: string, fulfillmentProxy: string, permit2: string, usdc: string, usdt: string,
 *   tronChainId: string}} deployed - addresses in any Tron form, and the 4-byte chain id
 * @returns {object} the artifact, every address in base58
 */
function buildDeploymentArtifact(deployed) {
  const artifact = {};
  for (const key of ADDRESS_KEYS) {
    try {
      artifact[key] = toBase58(deployed[key]);
    } catch (error) {
      throw new Error(`${key}: ${error.message}`);
    }
  }
  // The settler's tronChainId config takes this exact form (plugins/tron/config.yaml).
  if (typeof deployed.tronChainId !== 'string' || !/^0x[0-9a-f]{8}$/.test(deployed.tronChainId)) {
    throw new Error(`tronChainId is not 0x and 8 lowercase hex digits: ${JSON.stringify(deployed.tronChainId)}`);
  }
  artifact.tronChainId = deployed.tronChainId;
  return artifact;
}

module.exports = { buildDeploymentArtifact };
