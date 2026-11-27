// The fakes stand in for async I/O, so they are async without awaiting anything.
/* eslint-disable require-await */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { utils } = require('tronweb');

const { runDeployLocal } = require('./run');
const { escrowDomainSeparator, permit2DomainSeparator } = require('./domain-separator');
const { toBase58, toEvmAddress } = require('./address');

const { keccak256, id, AbiCoder } = utils.ethersUtils;
const abi = AbiCoder.defaultAbiCoder();

const CHAIN_ID = '0xc845df2f';
const address = (byte) => '41' + byte.repeat(20);
const MIGRATED = {
  Escrow: address('11'),
  FulfillmentProxy: address('22'),
  Permit2Extension: address('33'),
  TestToken: address('44')
};
const USDC = address('55');

// An io that deploys and checks out cleanly; each test breaks one thing. `calls` records every
// call in order, so a test can assert what did and did not happen.
function fakeIo(overrides = {}) {
  const calls = [];
  let migrated = false;
  const io = {
    removeArtifact: () => calls.push('removeArtifact'),
    genesisBlockId: async () => '0000000000000000c93baa76a4a508f798a96f59156d9eb17ecede8e' + CHAIN_ID.slice(2),
    ethChainId: async () => CHAIN_ID,
    chainIdOpcodeWord: async () => CHAIN_ID.slice(2).padStart(64, '0'),
    migratedAddresses: () => (migrated ? MIGRATED : {}),
    runMigration: () => {
      calls.push('runMigration');
      migrated = true;
    },
    escrowWiring: async () => ({ permit2: MIGRATED.Permit2Extension, usdt: MIGRATED.TestToken }),
    domainSeparator: async (name, at) => (name === 'Escrow'
      ? escrowDomainSeparator(CHAIN_ID, toEvmAddress(at))
      : permit2DomainSeparator(CHAIN_ID, toEvmAddress(at))),
    deployUsdc: async () => USDC,
    tokenDecimals: async () => 6,
    grantTokenConfigRole: async (escrow) => calls.push(['grantTokenConfigRole', toBase58(escrow)]),
    allowToken: async (escrow, token, ...config) => calls.push(['allowToken', toBase58(escrow), toBase58(token), ...config]),
    writeArtifact: (artifact) => calls.push(['writeArtifact', artifact]),
    log: () => {},
    ...overrides
  };
  return { io, calls };
}

describe('runDeployLocal', () => {
  it('removes the old artifact first and writes the new one last', async () => {
    const { io, calls } = fakeIo();
    await runDeployLocal(io);

    assert.equal(calls[0], 'removeArtifact');
    assert.deepEqual(calls.at(-1), ['writeArtifact', {
      escrow: toBase58(MIGRATED.Escrow),
      fulfillmentProxy: toBase58(MIGRATED.FulfillmentProxy),
      permit2: toBase58(MIGRATED.Permit2Extension),
      usdc: toBase58(USDC),
      usdt: toBase58(MIGRATED.TestToken),
      tronChainId: CHAIN_ID
    }]);
  });

  it('allows both tokens with the EVM deploy:local config, after granting the role', async () => {
    const { io, calls } = fakeIo();
    await runDeployLocal(io);

    const escrow = toBase58(MIGRATED.Escrow);
    const tokenCalls = calls.filter((call) => call[0] === 'grantTokenConfigRole' || call[0] === 'allowToken');
    assert.deepEqual(tokenCalls, [
      ['grantTokenConfigRole', escrow],
      ['allowToken', escrow, toBase58(USDC), 6, 20000, 1, 0],
      ['allowToken', escrow, toBase58(MIGRATED.TestToken), 6, 20000, 1, 0]
    ]);
  });
});

// Every failure must leave no artifact: the old one removed, no new one written.
async function assertFailsWithoutArtifact(overrides, message) {
  const { io, calls } = fakeIo(overrides);
  await assert.rejects(runDeployLocal(io), message);
  assert.equal(calls[0], 'removeArtifact');
  assert.equal(calls.some((call) => call[0] === 'writeArtifact'), false);
  return calls;
}

describe('runDeployLocal gates', () => {
  // CHAINID has matched by then, so what a real node can still disagree on is the domain: here the
  // Escrow after a version bump to TIP712("Escrow", "4") that domain-separator.js did not follow.
  it('fails on an Escrow DOMAIN_SEPARATOR whose domain drifted, and blames the domain', async () => {
    const driftedEscrowSeparator = (at) => keccak256(abi.encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [id('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), id('Escrow'), id('4'), CHAIN_ID, at]
    ));
    await assertFailsWithoutArtifact({
      domainSeparator: async (name, at) => (name === 'Escrow'
        ? driftedEscrowSeparator(toEvmAddress(at))
        : permit2DomainSeparator(CHAIN_ID, toEvmAddress(at)))
    }, /Escrow DOMAIN_SEPARATOR .* for chain id 0xc845df2f, which CHAINID already matched; check it against TIP712\("Escrow", "3"\)/);
  });

  it('fails before migrating when CHAINID is wider than TIP-712\'s 4 bytes', async () => {
    const calls = await assertFailsWithoutArtifact({
      chainIdOpcodeWord: async () => '0000000000000000c93baa76a4a508f798a96f59156d9eb17ecede8ec845df2f'
    }, /ChainIdExceedsTip712Mask/);
    assert.equal(calls.includes('runMigration'), false);
  });

  it('fails before migrating when eth_chainId disagrees with genesis', async () => {
    const calls = await assertFailsWithoutArtifact({ ethChainId: async () => '0xcd8690dc' }, /eth_chainId 0xcd8690dc disagrees/);
    assert.equal(calls.includes('runMigration'), false);
  });

  it('fails before migrating on a 4-byte CHAINID that is not the genesis chain id', async () => {
    const calls = await assertFailsWithoutArtifact({
      chainIdOpcodeWord: async () => 'cd8690dc'.padStart(64, '0')
    }, /CHAINID 0xcd8690dc disagrees/);
    assert.equal(calls.includes('runMigration'), false);
  });

  it('fails on a Permit2 DOMAIN_SEPARATOR mismatch alone', async () => {
    await assertFailsWithoutArtifact({
      domainSeparator: async (name, at) => (name === 'Escrow'
        ? escrowDomainSeparator(CHAIN_ID, toEvmAddress(at))
        : permit2DomainSeparator(CHAIN_ID, toEvmAddress(MIGRATED.Escrow)))
    }, (err) => /Permit2 DOMAIN_SEPARATOR/.test(err.message) && !/Escrow DOMAIN_SEPARATOR/.test(err.message));
  });

  it('fails when the Escrow was constructed with another USDT than the migrated double', async () => {
    await assertFailsWithoutArtifact({
      escrowWiring: async () => ({ permit2: MIGRATED.Permit2Extension, usdt: address('66') })
    }, /constructed with permit2 .* and usdt/);
  });

  it('fails when the Escrow was constructed with another Permit2 than the migrated double', async () => {
    await assertFailsWithoutArtifact({
      escrowWiring: async () => ({ permit2: address('66'), usdt: MIGRATED.TestToken })
    }, /constructed with permit2 .* and usdt/);
  });

  it('fails when the migration left build/ as it was, as an aborted or skipped one does', async () => {
    await assertFailsWithoutArtifact({ migratedAddresses: () => MIGRATED }, /did not deploy a fresh Escrow/);
  });

  it('fails before allowing a USDC double that does not report 6 decimals, as a dead address would not', async () => {
    const calls = await assertFailsWithoutArtifact({ tokenDecimals: async () => 0 }, /USDC .* reports 0 decimals/);
    assert.equal(calls.some((call) => call[0] === 'allowToken'), false);
  });

  // The failure line is all the settler preflight forwards, so it has to say which send reverted.
  it('names the send that failed, keeping its reason', async () => {
    const revert = new Error('REVERT opcode executed');
    await assertFailsWithoutArtifact({
      allowToken: async (_escrow, token) => {
        if (token === MIGRATED.TestToken) {
          throw revert;
        }
      }
    }, (err) => err.message === `allowTokenAndSetFeeConfig USDT ${toBase58(MIGRATED.TestToken)}: REVERT opcode executed` &&
      err.cause === revert);
  });

  it('names a failed TOKEN_CONFIG_ROLE grant', async () => {
    await assertFailsWithoutArtifact({
      grantTokenConfigRole: async () => {
        throw new Error('REVERT opcode executed');
      }
    }, new RegExp(`grantRole TOKEN_CONFIG_ROLE on Escrow ${toBase58(MIGRATED.Escrow)}: REVERT opcode executed$`));
  });
});
