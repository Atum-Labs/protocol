#!/usr/bin/env node
/**
 * deploy:local -- deploy to a local tronbox/tre node and write deployment-addresses.json.
 *
 * What it deploys and checks, and in what order, is scripts/deploy-local/run.js (documented in
 * README.md, "Local deployment"). This file only supplies the real node and filesystem: the node
 * is tronbox-config.js's development network, the one the migration deploys to.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { TronWeb } = require('tronweb');

const tronboxConfig = require('../tronbox-config');
const { postJson, requireField } = require('./deploy-local/http');
const { withRevertData } = require('./deploy-local/revert-data');
const { runDeployLocal, MIGRATED } = require('./deploy-local/run');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACT_PATH = path.join(ROOT, 'deployment-addresses.json');
const NETWORK_NAME = 'development';
const network = tronboxConfig.networks[NETWORK_NAME];

// CHAINID; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0; RETURN -- run as a constant call, it returns the
// opcode's 32-byte result without deploying anything.
const CHAINID_BYTECODE = '4660005260206000f3';

// tronweb's contract().new() returns as soon as the creation is broadcast.
const CODE_POLL_ATTEMPTS = 20;
const CODE_POLL_INTERVAL_MS = 1000;

function readBuildArtifact(contractName) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'build', 'contracts', `${contractName}.json`), 'utf8'));
}

function migratedAddresses() {
  const addresses = {};
  for (const name of MIGRATED) {
    try {
      addresses[name] = readBuildArtifact(name).networks[network.network_id].address;
    } catch {
      addresses[name] = undefined;
    }
  }
  return addresses;
}

function runMigration() {
  const result = spawnSync(
    path.join(ROOT, 'node_modules', '.bin', 'tronbox'),
    ['migrate', '--reset', '--network', NETWORK_NAME],
    { cwd: ROOT, stdio: 'inherit' }
  );
  if (result.error) {
    throw result.error;
  }
  // Not trusted alone: runDeployLocal also requires fresh addresses (see deploy-local/migration.js).
  if (result.status !== 0) {
    throw new Error(`tronbox migrate exited ${result.status}`);
  }
}

async function waitForCode(address) {
  for (let attempt = 0; attempt < CODE_POLL_ATTEMPTS; attempt++) {
    const contract = await postJson(`${network.fullHost}/wallet/getcontract`, { value: address, visible: true });
    if (contract && contract.bytecode) {
      return;
    }
    await sleep(CODE_POLL_INTERVAL_MS);
  }
  throw new Error(`no contract code at ${address} after ${CODE_POLL_ATTEMPTS} polls`);
}

function writeArtifact(artifact) {
  const tmp = `${ARTIFACT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(artifact, null, 2) + '\n');
  fs.renameSync(tmp, ARTIFACT_PATH);
}

function nodeIo() {
  const tronWeb = new TronWeb({ fullHost: network.fullHost, privateKey: network.privateKey });
  const contractAt = (name, address) => tronWeb.contract(readBuildArtifact(name).abi, address);
  const send = async (method) => {
    try {
      return await method.send({ feeLimit: network.feeLimit, shouldPollResponse: true });
    } catch (error) {
      throw withRevertData(error);
    }
  };

  return {
    removeArtifact: () => fs.rmSync(ARTIFACT_PATH, { force: true }),
    genesisBlockId: async () => {
      const url = `${network.fullHost}/wallet/getblockbynum`;
      return requireField(url, await postJson(url, { num: 0 }), 'blockID');
    },
    ethChainId: async () => {
      const url = `${network.fullHost}/jsonrpc`;
      return requireField(url, await postJson(url, { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), 'result');
    },
    chainIdOpcodeWord: async () => {
      const url = `${network.fullHost}/wallet/triggerconstantcontract`;
      const response = await postJson(url, {
        owner_address: tronWeb.defaultAddress.base58,
        data: CHAINID_BYTECODE,
        visible: true
      });
      return requireField(url, response, 'constant_result[0]', (response.constant_result || [])[0]);
    },
    migratedAddresses,
    runMigration,
    escrowWiring: async (escrow) => {
      const contract = contractAt('Escrow', escrow);
      const [permit2, usdt] = await Promise.all([contract.i_permit2().call(), contract.i_usdt().call()]);
      return { permit2, usdt };
    },
    domainSeparator: (name, address) => contractAt(name, address).DOMAIN_SEPARATOR().call(),
    deployUsdc: async () => {
      const testToken = readBuildArtifact('TestToken');
      const usdc = await tronWeb.contract().new({
        abi: testToken.abi,
        bytecode: testToken.bytecode,
        feeLimit: network.feeLimit,
        // As tronbox deployed the USDT double, so the two doubles share one energy split.
        userFeePercentage: network.userFeePercentage,
        parameters: ['USD Coin', 'USDC', 6]
      });
      await waitForCode(TronWeb.address.fromHex(usdc.address));
      return usdc.address;
    },
    tokenDecimals: async (token) => Number(await contractAt('TestToken', token).decimals().call()),
    grantTokenConfigRole: async (escrow) => {
      const contract = contractAt('Escrow', escrow);
      await send(contract.grantRole(await contract.TOKEN_CONFIG_ROLE().call(), tronWeb.defaultAddress.base58));
    },
    allowToken: (escrow, token, ...config) => send(contractAt('Escrow', escrow).allowTokenAndSetFeeConfig(token, ...config)),
    writeArtifact,
    log: (message) => console.log(message)
  };
}

runDeployLocal(nodeIo())
  .then((artifact) => {
    console.log(`Wrote ${path.relative(process.cwd(), ARTIFACT_PATH)}:`);
    console.log(JSON.stringify(artifact, null, 2));
  })
  .catch((error) => {
    console.error('\ndeploy:local FAILED:', error.message);
    process.exitCode = 1;
  });
