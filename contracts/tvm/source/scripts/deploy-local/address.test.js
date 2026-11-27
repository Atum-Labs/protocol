const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { toBase58, toEvmAddress, sameAddress } = require('./address');

// Mainnet USDT, whose two forms are published on Tronscan.
const USDT_BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';

describe('toBase58', () => {
  it('converts the 41-prefixed hex form tronbox records', () => {
    assert.equal(toBase58(USDT_HEX), USDT_BASE58);
  });

  it('rejects what is not a Tron address, instead of encoding it anyway', () => {
    for (const bad of [undefined, '', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6x', '41a614', '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c']) {
      assert.throws(() => toBase58(bad), /not a Tron address/);
    }
  });
});

describe('toEvmAddress', () => {
  it('drops the 41 prefix, leaving the 20 bytes address(this) holds in the TVM', () => {
    assert.equal(toEvmAddress(USDT_BASE58), '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c');
  });

  it('rejects what is not a Tron address', () => {
    assert.throws(() => toEvmAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6x'), /not a Tron address/);
  });
});

describe('sameAddress', () => {
  it('matches one address across its base58 and 41-hex forms', () => {
    assert.equal(sameAddress(USDT_HEX, USDT_BASE58), true);
  });

  it('tells two different addresses apart', () => {
    assert.equal(sameAddress(USDT_BASE58, 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC'), false);
  });

  it('rejects what is not a Tron address, rather than calling it different', () => {
    assert.throws(() => sameAddress(USDT_BASE58, ''), /not a Tron address/);
  });
});
