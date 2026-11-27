const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { assertFreshDeployment } = require('./migration');

const NAMES = ['Escrow', 'TestToken'];
const BEFORE = { Escrow: '41aa', TestToken: '41bb' };

describe('assertFreshDeployment', () => {
  it('returns the new addresses when every contract was redeployed', () => {
    assert.deepEqual(
      assertFreshDeployment(NAMES, BEFORE, { Escrow: '41cc', TestToken: '41dd', MockERC20: '41ee' }),
      { Escrow: '41cc', TestToken: '41dd' }
    );
  });

  it('accepts a first run, when build/ had no address yet', () => {
    assert.deepEqual(
      assertFreshDeployment(NAMES, {}, { Escrow: '41cc', TestToken: '41dd' }),
      { Escrow: '41cc', TestToken: '41dd' }
    );
  });

  it('names a contract whose address did not change, as a skipped or aborted migration leaves it', () => {
    assert.throws(
      () => assertFreshDeployment(NAMES, BEFORE, { Escrow: '41aa', TestToken: '41dd' }),
      /did not deploy a fresh Escrow .*41aa/
    );
  });

  it('names a contract with no address at all', () => {
    assert.throws(
      () => assertFreshDeployment(NAMES, BEFORE, { Escrow: '41cc' }),
      /did not deploy a fresh TestToken .*none/
    );
  });
});
