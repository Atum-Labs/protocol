const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { chainIdFromGenesisBlockId, crossCheckChainId, assertChainIdOpcode } = require('./chain-id');

// Block 0 of the tronbox/tre image pinned in docker-compose.yml.
const TRE_GENESIS_BLOCK_ID = '0000000000000000c93baa76a4a508f798a96f59156d9eb17ecede8ec845df2f';

describe('chainIdFromGenesisBlockId', () => {
  it('takes the last 4 bytes of the genesis block id', () => {
    assert.equal(chainIdFromGenesisBlockId(TRE_GENESIS_BLOCK_ID), '0xc845df2f');
  });

  it('rejects anything that is not a 32-byte hex block id', () => {
    for (const bad of [undefined, '', 'c845df2f', TRE_GENESIS_BLOCK_ID + '00', 'zz' + TRE_GENESIS_BLOCK_ID.slice(2)]) {
      assert.throws(() => chainIdFromGenesisBlockId(bad), /not a genesis block id/);
    }
  });
});

describe('crossCheckChainId', () => {
  it('returns the genesis chain id when eth_chainId agrees', () => {
    assert.equal(crossCheckChainId('0xc845df2f', '0xc845df2f'), '0xc845df2f');
  });

  it('compares numerically, since eth_chainId is a quantity and drops leading zeros', () => {
    assert.equal(crossCheckChainId('0x0000abcd', '0xabcd'), '0x0000abcd');
  });

  it('throws when the two reads disagree', () => {
    assert.throws(() => crossCheckChainId('0xc845df2f', '0xcd8690dc'), /eth_chainId 0xcd8690dc .* 0xc845df2f/);
  });

  it('throws when eth_chainId is not a hex quantity', () => {
    for (const bad of [undefined, '', '0x', 'c845df2f', '0xzz']) {
      assert.throws(() => crossCheckChainId('0xc845df2f', bad), /not a hex quantity/);
    }
  });
});

describe('assertChainIdOpcode', () => {
  // What `wallet/triggerconstantcontract` returns for CHAINID; MSTORE; RETURN on the pinned tre.
  const TRE_CHAINID_WORD = '00000000000000000000000000000000000000000000000000000000c845df2f';

  it('passes when the CHAINID opcode returns the genesis chain id', () => {
    assert.doesNotThrow(() => assertChainIdOpcode(TRE_CHAINID_WORD, '0xc845df2f'));
  });

  it('rejects a CHAINID wider than 4 bytes, which the Escrow constructor would revert on', () => {
    // A TVM without the optimized CHAINID returns the whole genesis block id.
    assert.throws(() => assertChainIdOpcode(TRE_GENESIS_BLOCK_ID, '0xc845df2f'), /ChainIdExceedsTip712Mask/);
  });

  it('rejects a 4-byte CHAINID that is not the genesis chain id', () => {
    const nile = '00000000000000000000000000000000000000000000000000000000cd8690dc';
    assert.throws(() => assertChainIdOpcode(nile, '0xc845df2f'), /CHAINID 0xcd8690dc .* 0xc845df2f/);
  });

  it('rejects anything that is not a 32-byte word', () => {
    for (const bad of [undefined, '', '0x' + TRE_CHAINID_WORD, TRE_CHAINID_WORD.slice(2)]) {
      assert.throws(() => assertChainIdOpcode(bad, '0xc845df2f'), /not a 32-byte word/);
    }
  });
});
