const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { utils } = require('tronweb');

const {
  escrowDomainSeparator,
  permit2DomainSeparator,
  assertDomainSeparators
} = require('./domain-separator');

const { keccak256, id, AbiCoder } = utils.ethersUtils;
const abi = AbiCoder.defaultAbiCoder();

// Expected values are computed with foundry, not with the code under test:
//   cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,uint256,address)" \
//     $(cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)") \
//     $(cast keccak Escrow) $(cast keccak 3) 0xc845df2f $ADDRESS)
// and for Permit2, whose domain has no version:
//   cast keccak $(cast abi-encode "f(bytes32,bytes32,uint256,address)" \
//     $(cast keccak "EIP712Domain(string name,uint256 chainId,address verifyingContract)") \
//     $(cast keccak Permit2) 0xc845df2f $ADDRESS)
const CHAIN_ID = '0xc845df2f';
const ADDRESS = '0x7a1f6e1d5b0b8c4b3e2d1c0f9e8d7c6b5a493827';
const ESCROW_SEPARATOR = '0x1e1bb546be0194a3b136979e3b14656b17319b3124976e4554211ef9d9bdf483';
const PERMIT2_SEPARATOR = '0x9648190f308571cc5c0c21e679d296bea83a9d7eaee85d28710af5eacc4aff64';
// What a contract whose domain drifted from the one rebuilt here would return, on the same chain
// id: the Escrow after a version bump to TIP712("Escrow", "4"), and a permit2-tron that gained a
// version.
const DRIFTED_ESCROW_SEPARATOR = keccak256(abi.encode(
  ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
  [id('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), id('Escrow'), id('4'), CHAIN_ID, ADDRESS]
));
const DRIFTED_PERMIT2_SEPARATOR = keccak256(abi.encode(
  ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
  [id('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), id('Permit2'), id('1'), CHAIN_ID, ADDRESS]
));

describe('escrowDomainSeparator', () => {
  it('rebuilds the TIP712("Escrow", "3") domain', () => {
    assert.equal(
      escrowDomainSeparator(CHAIN_ID, ADDRESS),
      ESCROW_SEPARATOR
    );
  });
});

describe('permit2DomainSeparator', () => {
  it('rebuilds the permit2-tron domain, which has no version field', () => {
    assert.equal(
      permit2DomainSeparator(CHAIN_ID, ADDRESS),
      PERMIT2_SEPARATOR
    );
  });
});

describe('assertDomainSeparators', () => {
  const deployed = (escrowActual, permit2Actual) => ({
    escrow: { address: ADDRESS, actual: escrowActual },
    permit2: { address: ADDRESS, actual: permit2Actual }
  });

  it('passes when both on-chain separators match the rebuilt ones', () => {
    assert.doesNotThrow(() => assertDomainSeparators(CHAIN_ID, deployed(ESCROW_SEPARATOR, PERMIT2_SEPARATOR)));
  });

  it('ignores hex case, since nodes and TronWeb differ on it', () => {
    assert.doesNotThrow(() => assertDomainSeparators(
      CHAIN_ID,
      deployed(ESCROW_SEPARATOR.toUpperCase().replace('0X', '0x'), PERMIT2_SEPARATOR)
    ));
  });

  // By the time this runs, CHAINID has matched the genesis chain id, so a mismatch points at the
  // domain rebuilt here and the contract it should mirror, not at the chain id.
  it('names the Escrow, and the domain to check, when only its separator disagrees', () => {
    assert.throws(
      () => assertDomainSeparators(CHAIN_ID, deployed(DRIFTED_ESCROW_SEPARATOR, PERMIT2_SEPARATOR)),
      (err) => /^Escrow DOMAIN_SEPARATOR .* the domain rebuilt in domain-separator\.js .* check it against TIP712\("Escrow", "3"\) in Escrow\.sol$/.test(err.message) &&
        !/Permit2/.test(err.message)
    );
  });

  it('names the Permit2 double, and the domain to check, when only its separator disagrees', () => {
    assert.throws(
      () => assertDomainSeparators(CHAIN_ID, deployed(ESCROW_SEPARATOR, DRIFTED_PERMIT2_SEPARATOR)),
      (err) => /^Permit2 DOMAIN_SEPARATOR .* the domain rebuilt in domain-separator\.js .* check it against @alexroan\/permit2-tron's TIP712/.test(err.message) &&
        !/Escrow/.test(err.message)
    );
  });

  it('reports both when both disagree', () => {
    assert.throws(
      () => assertDomainSeparators(CHAIN_ID, deployed(DRIFTED_ESCROW_SEPARATOR, DRIFTED_PERMIT2_SEPARATOR)),
      /Escrow DOMAIN_SEPARATOR[\s\S]*Permit2 DOMAIN_SEPARATOR/
    );
  });
});
