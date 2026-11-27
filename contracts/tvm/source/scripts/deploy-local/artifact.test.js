const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildDeploymentArtifact } = require('./artifact');

const USDT_BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';

const deployed = {
  escrow: USDT_HEX,
  fulfillmentProxy: USDT_HEX,
  permit2: USDT_HEX,
  usdc: USDT_HEX,
  usdt: USDT_BASE58,
  tronChainId: '0xc845df2f'
};

describe('buildDeploymentArtifact', () => {
  it('writes every address as base58, alongside the chain id', () => {
    assert.deepEqual(buildDeploymentArtifact(deployed), {
      escrow: USDT_BASE58,
      fulfillmentProxy: USDT_BASE58,
      permit2: USDT_BASE58,
      usdc: USDT_BASE58,
      usdt: USDT_BASE58,
      tronChainId: '0xc845df2f'
    });
  });

  it('names a missing or malformed address instead of writing a partial artifact', () => {
    for (const key of ['escrow', 'fulfillmentProxy', 'permit2', 'usdc', 'usdt']) {
      assert.throws(() => buildDeploymentArtifact({ ...deployed, [key]: undefined }), new RegExp(`^Error: ${key}: `));
    }
  });

  it('requires the chain id as 0x and exactly 8 lowercase hex digits, the form the settler config uses', () => {
    for (const bad of [undefined, 3360022319, '0xC845DF2F', 'c845df2f', '0xabcd', '0x00c845df2f']) {
      assert.throws(() => buildDeploymentArtifact({ ...deployed, tronChainId: bad }), /tronChainId/);
    }
  });
});
