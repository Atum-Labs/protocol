#!/usr/bin/env node

/**
 * Contract Verification Script
 * 
 * This script verifies that compiled contract bytecode matches the bytecode
 * deployed on Tron networks. It:
 * 1. Cleans existing build artifacts
 * 2. Compiles the contract using tronbox
 * 3. Fetches the on-chain bytecode from the specified network
 * 4. Compares the compiled bytecode with the on-chain bytecode
 * 
 * Note: On Tron, the bytecode stored on-chain is the deployment bytecode
 * (which includes constructor code), not just the runtime bytecode.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { TronWeb } = require('tronweb');

// Parse command-line arguments
const args = process.argv.slice(2);
const [contractName, network, contractAddress] = args;

// Network configuration
// mainnet honours TRON_RPC_URL, as config.js and tronbox-config.js do. This script
// is what verify-all.sh --deployed calls, so an anonymous throttle here turns a
// verification stage red for a reason that has nothing to do with the bytecode.
const NETWORK_URLS = {
  mainnet: process.env.TRON_RPC_URL || 'https://api.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io'
};

// Valid contract names
const VALID_CONTRACTS = ['Escrow', 'FulfillmentProxy'];

// Paths (dynamic based on contract name)
const BUILD_DIR = path.join(__dirname, '..', 'build');
const getContractJsonPath = () => path.join(BUILD_DIR, 'contracts', `${contractName}.json`);

// Compilation settings used (must match tronbox-config.js)
const COMPILATION_SETTINGS = {
  compiler: 'solc',
  version: '0.8.23',
  optimizer: {
    enabled: true,
    runs: 1000000
  },
  viaIR: true,
  metadata: {
    bytecodeHash: 'none'
  }
};

/**
 * Validate command-line arguments
 */
function validateInputs() {
  if (args.length !== 3) {
    console.error('❌ Error: Invalid number of arguments');
    console.error('\nUsage: node scripts/verify-contract.js <contract> <network> <address>');
    console.error('\nArguments:');
    console.error('  contract - Contract name: Escrow or FulfillmentProxy');
    console.error('  network  - Network name: mainnet, shasta, or nile');
    console.error('  address  - Contract address (Tron base58 format)');
    console.error('\nExamples:');
    console.error('  node scripts/verify-contract.js Escrow shasta TKsAH8SinuuwcexaZyTrmSqBjaa2rUNPuA');
    console.error('  node scripts/verify-contract.js FulfillmentProxy shasta TJZKt3a7hNvvw8zPdPfzPipQWLaoBtebVV');
    process.exit(1);
  }
  
  // Validate contract name
  if (!VALID_CONTRACTS.includes(contractName)) {
    console.error(`❌ Error: Invalid contract name "${contractName}"`);
    console.error(`   Valid contracts: ${VALID_CONTRACTS.join(', ')}`);
    process.exit(1);
  }
  
  // Validate network
  if (!NETWORK_URLS[network]) {
    console.error(`❌ Error: Invalid network "${network}"`);
    console.error(`   Valid networks: ${Object.keys(NETWORK_URLS).join(', ')}`);
    process.exit(1);
  }
  
  // Validate address format
  if (!contractAddress || !contractAddress.startsWith('T') || contractAddress.length < 34) {
    console.error(`❌ Error: Invalid address format "${contractAddress}"`);
    console.error('   Address must be a valid Tron base58 address starting with "T"');
    process.exit(1);
  }
}

/**
 * Clean build directory
 */
function cleanBuild() {
  try {
    if (fs.existsSync(BUILD_DIR)) {
      fs.rmSync(BUILD_DIR, { recursive: true, force: true });
    }
  } catch (error) {
    console.error('❌ Error cleaning build directory:', error.message);
    process.exit(1);
  }
}

/**
 * Compile contracts using tronbox
 */
function compileContracts() {
  console.log('Compiling contracts...\n');
  
  try {
    execSync('npx tronbox compile', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
  } catch (error) {
    console.error('❌ Compilation failed:', error.message);
    process.exit(1);
  }
}

/**
 * Read compiled bytecode from build artifacts
 * Returns both deployment bytecode and runtime bytecode for comparison
 */
function getCompiledBytecode() {
  const contractJsonPath = getContractJsonPath();
  
  if (!fs.existsSync(contractJsonPath)) {
    console.error(`❌ Contract JSON not found at: ${contractJsonPath}`);
    process.exit(1);
  }
  
  try {
    const contractJson = JSON.parse(fs.readFileSync(contractJsonPath, 'utf8'));
    const deploymentBytecode = contractJson.bytecode;
    const runtimeBytecode = contractJson.deployedBytecode;
    
    if (!deploymentBytecode && !runtimeBytecode) {
      console.error('❌ No bytecode fields found in contract JSON');
      process.exit(1);
    }
    
    // Remove '0x' prefix if present
    const deployment = deploymentBytecode 
      ? (deploymentBytecode.startsWith('0x') ? deploymentBytecode.slice(2) : deploymentBytecode)
      : '';
    const runtime = runtimeBytecode 
      ? (runtimeBytecode.startsWith('0x') ? runtimeBytecode.slice(2) : runtimeBytecode)
      : '';
    
    return { deployment, runtime };
  } catch (error) {
    console.error('❌ Error reading compiled bytecode:', error.message);
    process.exit(1);
  }
}

/**
 * Fetch on-chain bytecode from Tron network
 */
async function getOnChainBytecode() {
  console.log(`Fetching on-chain bytecode (${network})...\n`);
  
  try {
    const tronWeb = new TronWeb({
      fullHost: NETWORK_URLS[network],
      headers: process.env.TRON_API_KEY
        ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY }
        : undefined
    });
    
    const contract = await tronWeb.trx.getContract(contractAddress);
    
    if (!contract || !contract.bytecode) {
      console.error('❌ Contract not found or bytecode not available');
      process.exit(1);
    }
    
    // Remove '0x' prefix if present
    const bytecode = contract.bytecode.startsWith('0x')
      ? contract.bytecode.slice(2)
      : contract.bytecode;
    
    return bytecode;
  } catch (error) {
    console.error('❌ Error fetching on-chain bytecode:', error.message);
    process.exit(1);
  }
}

/**
 * Compare bytecodes and report results
 */
function compareBytecodes(compiledBytecodes, onChainBytecode) {
  // Try both deployment and runtime bytecode
  // Also check if deployment bytecode is a prefix (on-chain includes constructor args)
  let matchedType = null;
  let compiledBytecode = null;
  let isPrefixMatch = false;
  
  if (compiledBytecodes.deployment === onChainBytecode) {
    matchedType = 'deployment';
    compiledBytecode = compiledBytecodes.deployment;
  } else if (compiledBytecodes.runtime === onChainBytecode) {
    matchedType = 'runtime';
    compiledBytecode = compiledBytecodes.runtime;
  } else if (onChainBytecode.startsWith(compiledBytecodes.deployment)) {
    matchedType = 'deployment';
    compiledBytecode = compiledBytecodes.deployment;
    isPrefixMatch = true;
  } else if (onChainBytecode.startsWith(compiledBytecodes.runtime)) {
    matchedType = 'runtime';
    compiledBytecode = compiledBytecodes.runtime;
    isPrefixMatch = true;
  }
  
  if (matchedType) {
    console.log('✅ VERIFICATION SUCCESSFUL\n');
    console.log(`Contract: ${contractName}`);
    console.log(`Address:  ${contractAddress}`);
    console.log(`Network:  ${network.toUpperCase()}`);
    
    if (isPrefixMatch) {
      const constructorArgs = onChainBytecode.slice(compiledBytecode.length);
      console.log(`\nOn-chain bytecode includes constructor arguments (${constructorArgs.length / 2} bytes)`);
    }
    
    return true;
  } else {
    console.log('❌ VERIFICATION FAILED\n');
    console.log('Bytecode does not match on-chain deployment.');
    console.log(`\nCompiled deployment: ${compiledBytecodes.deployment.length} hex chars`);
    console.log(`Compiled runtime:    ${compiledBytecodes.runtime.length} hex chars`);
    console.log(`On-chain:            ${onChainBytecode.length} hex chars`);
    
    // Find first difference if lengths match
    const closestMatch = compiledBytecodes.deployment.length === onChainBytecode.length 
      ? 'deployment' 
      : (compiledBytecodes.runtime.length === onChainBytecode.length ? 'runtime' : null);
    
    if (closestMatch) {
      const compareWith = closestMatch === 'deployment' 
        ? compiledBytecodes.deployment 
        : compiledBytecodes.runtime;
      
      const minLength = Math.min(compareWith.length, onChainBytecode.length);
      for (let i = 0; i < minLength; i += 2) {
        if (compareWith.slice(i, i + 2) !== onChainBytecode.slice(i, i + 2)) {
          console.log(`\nFirst difference at position ${i} (${closestMatch} bytecode)`);
          break;
        }
      }
    }
    
    return false;
  }
}

/**
 * Main verification function
 */
async function main() {
  validateInputs();
  
  console.log(`\nVerifying ${contractName} on ${network.toUpperCase()}...\n`);
  
  cleanBuild();
  compileContracts();
  
  const compiledBytecode = getCompiledBytecode();
  const onChainBytecode = await getOnChainBytecode();
  
  const matches = compareBytecodes(compiledBytecode, onChainBytecode);
  
  process.exit(matches ? 0 : 1);
}

// Run verification
main().catch((error) => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});

