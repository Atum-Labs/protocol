/**
 * The deploy:local sequence, with every read and write of the node and the filesystem passed in as
 * `io` (scripts/deploy-local.js supplies the real ones), so each gate can be tested without a node.
 */

const { chainIdFromGenesisBlockId, crossCheckChainId, assertChainIdOpcode } = require('./chain-id');
const { assertFreshDeployment } = require('./migration');
const { assertDomainSeparators } = require('./domain-separator');
const { toBase58, toEvmAddress, sameAddress } = require('./address');
const { buildDeploymentArtifact } = require('./artifact');

// Same token and fee config as contracts/evm/source/scripts/deploy-local.ts: 6 decimals, 0.02%
// fee, min 1, uncapped.
const TOKEN_DECIMALS = 6;
const FEE_PERCENTAGE = 20000;
const MIN_FEE = 1;
const MAX_FEE = 0;

// The migrated contracts the artifact names, and so what a successful run must leave with a fresh
// address.
const MIGRATED = ['Escrow', 'FulfillmentProxy', 'Permit2Extension', 'TestToken'];

/**
 * Runs one of the sends, naming it in the error: a revert's own message does not say which send
 * it came from, and the failure line is all the settler preflight forwards.
 */
async function labelled(label, send) {
  try {
    return await send();
  } catch (error) {
    throw new Error(`${label}: ${error.message}`, { cause: error });
  }
}

/**
 * @param {object} io - see scripts/deploy-local.js for what each member does
 * @returns {Promise<object>} the artifact it wrote
 */
async function runDeployLocal(io) {
  // A failed run must not leave the previous run's addresses for the preflight to find.
  io.removeArtifact();

  const tronChainId = crossCheckChainId(chainIdFromGenesisBlockId(await io.genesisBlockId()), await io.ethChainId());
  assertChainIdOpcode(await io.chainIdOpcodeWord(), tronChainId);
  io.log(`Chain id ${tronChainId} (genesis block id, eth_chainId and CHAINID agree)`);

  const before = io.migratedAddresses();
  io.runMigration();
  const migrated = assertFreshDeployment(MIGRATED, before, io.migratedAddresses());

  // The migration constructed the Escrow with these; reading them back checks it was wired to
  // the doubles this artifact will name.
  const wiring = await io.escrowWiring(migrated.Escrow);
  if (!sameAddress(wiring.permit2, migrated.Permit2Extension) || !sameAddress(wiring.usdt, migrated.TestToken)) {
    throw new Error(
      `Escrow ${toBase58(migrated.Escrow)} was constructed with permit2 ${toBase58(wiring.permit2)} and usdt ` +
      `${toBase58(wiring.usdt)}, not the migrated ${toBase58(migrated.Permit2Extension)} and ${toBase58(migrated.TestToken)}`
    );
  }

  assertDomainSeparators(tronChainId, {
    escrow: {
      address: toEvmAddress(migrated.Escrow),
      actual: await io.domainSeparator('Escrow', migrated.Escrow)
    },
    permit2: {
      address: toEvmAddress(migrated.Permit2Extension),
      actual: await io.domainSeparator('Permit2Extension', migrated.Permit2Extension)
    }
  });
  io.log(`Escrow and Permit2 DOMAIN_SEPARATOR match the separators rebuilt for ${tronChainId}`);

  // Escrow's allowToken skips its decimals() check for an address with no code, so it would allow
  // a USDC creation that never landed; the double's own answer is what proves it is there.
  const usdc = await io.deployUsdc();
  const usdcDecimals = await io.tokenDecimals(usdc);
  if (usdcDecimals !== TOKEN_DECIMALS) {
    throw new Error(`USDC double ${toBase58(usdc)} reports ${usdcDecimals} decimals, not ${TOKEN_DECIMALS}`);
  }

  await labelled(`grantRole TOKEN_CONFIG_ROLE on Escrow ${toBase58(migrated.Escrow)}`, () =>
    io.grantTokenConfigRole(migrated.Escrow));
  for (const [symbol, token] of [['USDC', usdc], ['USDT', migrated.TestToken]]) {
    await labelled(`allowTokenAndSetFeeConfig ${symbol} ${toBase58(token)}`, () =>
      io.allowToken(migrated.Escrow, token, TOKEN_DECIMALS, FEE_PERCENTAGE, MIN_FEE, MAX_FEE));
  }

  const artifact = buildDeploymentArtifact({
    escrow: migrated.Escrow,
    fulfillmentProxy: migrated.FulfillmentProxy,
    permit2: migrated.Permit2Extension,
    usdc,
    usdt: migrated.TestToken,
    tronChainId
  });
  io.writeArtifact(artifact);
  return artifact;
}

module.exports = { runDeployLocal, MIGRATED };
