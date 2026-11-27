#!/usr/bin/env tsx
/**
 * Deploy script for EVM localnet (Anvil)
 *
 * Deploys:
 * - TestToken (USDC, USDT) mock ERC20 tokens
 * - Permit2
 * - EscrowReserveLib (the external library Escrow delegatecalls for reserve())
 * - Escrow (with Permit2 address + defaultAdmin), linked to EscrowReserveLib
 * - FulfillmentProxy (with defaultAdmin)
 *
 * Post-deploy configuration:
 * - Grants TOKEN_CONFIG_ROLE to deployer
 * - Allows USDC and USDT tokens with fee config
 *
 * Outputs:
 * - deployment-addresses.json
 *
 * Env vars:
 * - RPC_URL (default: http://127.0.0.1:8545)
 * - PRIVATE_KEY (default: Anvil account 0)
 */

import { execSync } from 'node:child_process';
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_FILENAME = path.join(REPO_ROOT, 'deployment-addresses.json');

// Default Anvil account 0 private key
const DEFAULT_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Token decimals
const USDC_DECIMALS = 6;
const USDT_DECIMALS = 6;

// Fee config: 0.02% fee, min 1 (6-decimal), no max
const FEE_PERCENTAGE = 20000; // 0.02% in 6-decimal precision
const MIN_FEE = 1;
const MAX_FEE = 0; // uncapped

// Role hashes
const TOKEN_CONFIG_ROLE = ethers.keccak256(ethers.toUtf8Bytes('TOKEN_CONFIG_ROLE'));

type LinkReferences = Record<string, Record<string, { start: number; length: number }[]>>;
type Artifact = { abi: unknown[]; bytecode: { object: string; linkReferences?: LinkReferences } };

function loadArtifact(name: string, subdir: string): Artifact {
  const candidatePaths = [
    path.join(REPO_ROOT, 'out', `${subdir}`, `${name}.json`),
    path.join(REPO_ROOT, 'lib', 'permit2', 'out', `${subdir}`, `${name}.json`),
  ];

  const artifactPath = candidatePaths.find((candidate) => fs.existsSync(candidate));
  if (!artifactPath) {
    throw new Error(
      `Artifact not found for ${name}. Checked: ${candidatePaths.join(', ')}. Run 'forge build' first.`,
    );
  }
  return JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
}

/**
 * Ensure the contracts are compiled. Idempotent: skips when the artifacts
 * already exist. Installs @openzeppelin (--ignore-workspace so it lands where
 * the forge remapping expects) and forge-builds the source + permit2.
 */
function ensureBuilt(): void {
  const needed = [
    path.join(REPO_ROOT, 'out', 'TestToken.sol', 'TestToken.json'),
    path.join(REPO_ROOT, 'out', 'Escrow.sol', 'Escrow.json'),
    path.join(REPO_ROOT, 'out', 'EscrowReserveLib.sol', 'EscrowReserveLib.json'),
    path.join(REPO_ROOT, 'out', 'FulfillmentProxy.sol', 'FulfillmentProxy.json'),
    path.join(REPO_ROOT, 'lib', 'permit2', 'out', 'Permit2.sol', 'Permit2.json'),
  ];
  if (needed.every((p) => fs.existsSync(p))) return;
  console.log('Building contracts (first run)...');
  execSync('pnpm install --ignore-workspace', { cwd: REPO_ROOT, stdio: 'inherit' });
  execSync('forge build', { cwd: REPO_ROOT, stdio: 'inherit' });
  execSync('forge build', { cwd: path.join(REPO_ROOT, 'lib', 'permit2'), stdio: 'inherit' });
}

// ethers' NonceManager applies its managed nonce only after populateTransaction, which reads
// getTransactionCount('pending') and runs estimateGas with it. The provider answers identical
// requests from a 250 ms cache, so when the previous tx mined on the first receipt poll that
// read returns the pre-send count and the node rejects the estimate as "nonce too low".
// Setting the managed nonce first makes populateTransaction skip the read. This holds for
// sequential sends, which is all this script does.
class PinnedNonceManager extends ethers.NonceManager {
  override async sendTransaction(tx: ethers.TransactionRequest): Promise<ethers.TransactionResponse> {
    return super.sendTransaction({ ...tx, nonce: await this.getNonce('pending') });
  }
}

async function main(): Promise<void> {
  ensureBuilt();
  const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
  const rawKey = process.env.PRIVATE_KEY ?? DEFAULT_PRIVATE_KEY;
  const privateKey = rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`;

  console.log('=====================================');
  console.log('EVM Localnet Contract Deployment');
  console.log('=====================================');
  console.log('RPC_URL:', rpcUrl);

  // No request cache: no read, including one added later, can return a count from before a send.
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
  const rawWallet = new ethers.Wallet(privateKey, provider);
  const wallet = new PinnedNonceManager(rawWallet);
  const deployerAddress = await rawWallet.getAddress();
  console.log('Deployer address:', deployerAddress);

  // Load artifacts
  console.log('\n1. Loading contract artifacts...');
  const TestTokenArtifact = loadArtifact('TestToken', 'TestToken.sol');
  const Permit2Artifact = loadArtifact('Permit2', 'Permit2.sol');
  const EscrowArtifact = loadArtifact('Escrow', 'Escrow.sol');
  const EscrowReserveLibArtifact = loadArtifact('EscrowReserveLib', 'EscrowReserveLib.sol');
  const FulfillmentProxyArtifact = loadArtifact('FulfillmentProxy', 'FulfillmentProxy.sol');
  console.log('   Artifacts loaded successfully');

  // Deploy mock USDC
  console.log('\n2. Deploying mock USDC...');
  const usdcAddress = await deployContract(wallet, TestTokenArtifact, 'USD Coin', 'USDC', USDC_DECIMALS);
  console.log('   USDC deployed at:', usdcAddress);

  // Deploy mock USDT
  console.log('\n3. Deploying mock USDT...');
  const usdtAddress = await deployContract(wallet, TestTokenArtifact, 'Tether USD', 'USDT', USDT_DECIMALS);
  console.log('   USDT deployed at:', usdtAddress);

  // Seed deployer with ample token balances for local test funding
  console.log('\n3b. Minting initial localnet token liquidity...');
  const usdc = new ethers.Contract(usdcAddress, TestTokenArtifact.abi, wallet);
  const usdt = new ethers.Contract(usdtAddress, TestTokenArtifact.abi, wallet);
  const initialUsdcLiquidity = ethers.parseUnits('1000000', USDC_DECIMALS); // 1M USDC
  const initialUsdtLiquidity = ethers.parseUnits('1000000', USDT_DECIMALS); // 1M USDT
  const mintUsdcTx = await usdc.mint(deployerAddress, initialUsdcLiquidity);
  await mintUsdcTx.wait();
  const mintUsdtTx = await usdt.mint(deployerAddress, initialUsdtLiquidity);
  await mintUsdtTx.wait();
  console.log('   Minted initial USDC/USDT balances to deployer');

  // Deploy Permit2
  console.log('\n4. Deploying Permit2...');
  const permit2Address = await deployContract(wallet, Permit2Artifact);
  console.log('   Permit2 deployed at:', permit2Address);

  // Deploy EscrowReserveLib, then Escrow linked to it (constructor takes permit2 + defaultAdmin only)
  console.log('\n5. Deploying EscrowReserveLib and Escrow...');
  const reserveLibAddress = await deployContract(wallet, EscrowReserveLibArtifact);
  console.log('   EscrowReserveLib deployed at:', reserveLibAddress);
  const linkedEscrowArtifact = linkLibraries(EscrowArtifact, {
    'src/EscrowReserveLib.sol': { EscrowReserveLib: reserveLibAddress },
  });
  const escrowAddress = await deployContract(wallet, linkedEscrowArtifact, permit2Address, deployerAddress);
  console.log('   Escrow deployed at:', escrowAddress);

  // Configure Escrow: grant TOKEN_CONFIG_ROLE and allow tokens
  console.log('\n6. Configuring Escrow tokens...');
  const escrow = new ethers.Contract(escrowAddress, EscrowArtifact.abi, wallet);
  const grantTx = await escrow.grantRole(TOKEN_CONFIG_ROLE, deployerAddress);
  await grantTx.wait();
  console.log('   TOKEN_CONFIG_ROLE granted to deployer');

  const allowUsdcTx = await escrow.allowTokenAndSetFeeConfig(usdcAddress, USDC_DECIMALS, FEE_PERCENTAGE, MIN_FEE, MAX_FEE);
  await allowUsdcTx.wait();
  console.log('   USDC allowed with fee config');

  const allowUsdtTx = await escrow.allowTokenAndSetFeeConfig(usdtAddress, USDT_DECIMALS, FEE_PERCENTAGE, MIN_FEE, MAX_FEE);
  await allowUsdtTx.wait();
  console.log('   USDT allowed with fee config');

  // Deploy FulfillmentProxy
  console.log('\n7. Deploying FulfillmentProxy...');
  const fulfillmentProxyAddress = await deployContract(wallet, FulfillmentProxyArtifact, deployerAddress);
  console.log('   FulfillmentProxy deployed at:', fulfillmentProxyAddress);

  // Write deployment addresses
  console.log('\n8. Writing deployment addresses...');
  const deploymentAddresses = {
    escrow: escrowAddress,
    escrowReserveLib: reserveLibAddress,
    fulfillmentProxy: fulfillmentProxyAddress,
    permit2: permit2Address,
    usdc: usdcAddress,
    usdt: usdtAddress,
  };

  fs.writeFileSync(ARTIFACT_FILENAME, JSON.stringify(deploymentAddresses, null, 2));
  console.log('   Addresses written to:', ARTIFACT_FILENAME);

  console.log('\n=====================================');
  console.log('Deployment Summary');
  console.log('=====================================');
  console.log('Escrow:', escrowAddress);
  console.log('EscrowReserveLib:', reserveLibAddress);
  console.log('FulfillmentProxy:', fulfillmentProxyAddress);
  console.log('Permit2:', permit2Address);
  console.log('USDC:', usdcAddress);
  console.log('USDT:', usdtAddress);
  console.log('\n=====================================');
  console.log('Deployment completed successfully!');
  console.log('=====================================');
}

/**
 * Returns the artifact with every library placeholder in its creation bytecode replaced by the
 * deployed address, at the offsets forge records in `linkReferences`. Fails on a placeholder with
 * no address given, so a library added later cannot ship unlinked.
 */
function linkLibraries(artifact: Artifact, addresses: Record<string, Record<string, string>>): Artifact {
  let code = artifact.bytecode.object.replace(/^0x/, '');
  for (const [file, libraries] of Object.entries(artifact.bytecode.linkReferences ?? {})) {
    for (const [library, references] of Object.entries(libraries)) {
      const address = addresses[file]?.[library];
      if (!address) throw new Error(`No address given for library ${file}:${library}`);
      const hex = address.toLowerCase().replace(/^0x/, '');
      for (const { start, length } of references) {
        code = code.slice(0, start * 2) + hex + code.slice((start + length) * 2);
      }
    }
  }
  return { ...artifact, bytecode: { ...artifact.bytecode, object: `0x${code}` } };
}

async function deployContract(wallet: ethers.Signer, artifact: Artifact, ...args: unknown[]): Promise<string> {
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, wallet);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return await contract.getAddress();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\nDeployment failed:', error);
    process.exit(1);
  });
