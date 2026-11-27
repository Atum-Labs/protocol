#!/usr/bin/env node

/**
 * Query Escrow Contract
 * 
 * This script queries an Escrow contract on any Tron network to retrieve
 * the Permit2 and USDT contract addresses stored in the Escrow contract.
 * 
 * Usage: node scripts/query-escrow.js <network> <escrow-address>
 * Example: node scripts/query-escrow.js shasta TV4JEPE71PUCknwz2UGgJKy4xJhkjFPLi8
 */

const { TronWeb } = require('tronweb');
const path = require('path');

// Network configuration
// Kept local rather than imported from ./config so this stays usable without the
// Permit2 ABI that module require()s, but mainnet honours TRON_RPC_URL the same way
// config.js does -- otherwise this script silently ignores the endpoint every other
// tool in the tree respects.
const NETWORKS = {
  mainnet: process.env.TRON_RPC_URL || 'https://api.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io'
};

// Dummy private key for read-only operations
const DUMMY_PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000001';

/**
 * Validate command-line arguments
 */
function validateInputs() {
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    console.error('❌ Error: Invalid number of arguments');
    console.error('\nUsage: node scripts/query-escrow.js <network> <escrow-address>');
    console.error('\nArguments:');
    console.error('  network       - Network name: mainnet, shasta, or nile');
    console.error('  escrow-address - Escrow contract address (Tron base58 format)');
    console.error('\nExample:');
    console.error('  node scripts/query-escrow.js shasta TV4JEPE71PUCknwz2UGgJKy4xJhkjFPLi8');
    process.exit(1);
  }
  
  const [network, escrowAddress] = args;
  
  // Validate network
  if (!NETWORKS[network]) {
    console.error(`❌ Error: Invalid network "${network}"`);
    console.error(`   Valid networks: ${Object.keys(NETWORKS).join(', ')}`);
    process.exit(1);
  }
  
  // Validate Escrow address format
  if (!escrowAddress.startsWith('T') || escrowAddress.length < 34) {
    console.error(`❌ Error: Invalid Escrow address format "${escrowAddress}"`);
    console.error('   Address must be a valid Tron base58 address starting with "T"');
    process.exit(1);
  }
  
  return { network, escrowAddress };
}

/**
 * Load Escrow ABI from generated artifacts
 */
function loadEscrowABI() {
  try {
    const abiPath = path.join(__dirname, '..', 'generated', 'abi', 'Escrow.json');
    return require(abiPath);
  } catch (error) {
    console.error('❌ Error: Could not load Escrow ABI');
    console.error(`   Make sure ABIs are generated in the generated/abi folder`);
    console.error(`   Error: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Query Escrow contract for Permit2 and USDT addresses
 */
async function queryEscrow(network, escrowAddress) {
  try {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║              Escrow Contract Query                        ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    
    // Initialize TronWeb
    console.log(`🌐 Connecting to ${network.toUpperCase()} network...`);
    const tronWeb = new TronWeb({
      fullHost: NETWORKS[network],
      privateKey: DUMMY_PRIVATE_KEY,
      headers: process.env.TRON_API_KEY
        ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY }
        : undefined
    });
    
    // Load Escrow ABI
    console.log('📖 Loading Escrow ABI...');
    const escrowABI = loadEscrowABI();
    
    // Create contract instance
    console.log(`📝 Creating contract instance for: ${escrowAddress}`);
    const escrow = await tronWeb.contract(escrowABI, escrowAddress);
    
    // Query i_permit2()
    console.log('\n🔍 Querying i_permit2()...');
    const permit2AddressHex = await escrow.i_permit2().call();
    const permit2Address = tronWeb.address.fromHex(permit2AddressHex);
    
    // Query i_usdt()
    console.log('🔍 Querying i_usdt()...');
    const usdtAddressHex = await escrow.i_usdt().call();
    const usdtAddress = tronWeb.address.fromHex(usdtAddressHex);
    
    // Display results
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ Query Results');
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log(`Network:        ${network.toUpperCase()}`);
    console.log(`Escrow Address: ${escrowAddress}`);
    console.log(`Permit2:        ${permit2Address}`);
    console.log(`USDT:           ${usdtAddress}`);
    console.log('\n═══════════════════════════════════════════════════════════\n');
    
  } catch (error) {
    console.error('\n❌ Error querying Escrow contract:');
    
    // Provide helpful error messages
    if (error.message.includes('contract not found') || error.message.includes('does not exist')) {
      console.error(`   The contract at address ${escrowAddress} does not exist on ${network}`);
      console.error('   Please verify the address is correct for this network.');
    } else if (error.message.includes('Invalid address')) {
      console.error(`   Invalid address format: ${escrowAddress}`);
      console.error('   Address must be a valid Tron base58 address.');
    } else if (error.message.includes('network') || error.message.includes('connection')) {
      console.error(`   Network connection error for ${network}`);
      console.error('   Please check your internet connection and try again.');
    } else {
      console.error(`   ${error.message}`);
    }
    
    process.exit(1);
  }
}

/**
 * Main execution
 */
async function main() {
  const { network, escrowAddress } = validateInputs();
  await queryEscrow(network, escrowAddress);
}

// Run the script
main().catch((error) => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});

