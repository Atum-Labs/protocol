#!/usr/bin/env node

/**
 * Escrow Contract Inspection Script
 * 
 * This script queries comprehensive state from an Escrow contract including:
 * - Paused state
 * - Immutable configuration (Permit2, USDT addresses)
 * - Allowed tokens and their fee configuration
 * - Role holders (by analyzing RoleGranted/RoleRevoked events)
 * 
 * Usage: node scripts/inspect-escrow.js <network>
 * Example: node scripts/inspect-escrow.js shasta
 */

const { TronWeb } = require('tronweb');
const config = require('./config');

// Dummy private key for read-only operations
const DUMMY_PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000001';

// Default admin role is always bytes32(0)
const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Validate command-line arguments
 */
function validateInputs() {
  const args = process.argv.slice(2);
  
  if (args.length !== 1) {
    console.error('Error: Invalid number of arguments');
    console.error('\nUsage: node scripts/inspect-escrow.js <network>');
    console.error('\nArguments:');
    console.error('  network - Network name: mainnet or shasta');
    console.error('\nExample:');
    console.error('  node scripts/inspect-escrow.js shasta');
    process.exit(1);
  }
  
  const [network] = args;
  
  // Validate network
  let validNetwork;
  try {
    validNetwork = config.validateNetwork(network);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  
  return { network: validNetwork };
}

/**
 * Format fee percentage for display
 * @param {BigInt|number} feePercentage6Decimals - Fee percentage scaled by 10^6
 * @returns {string} Formatted percentage string
 */
function formatFeePercentage(feePercentage6Decimals) {
  const value = Number(feePercentage6Decimals);
  if (value === 0) return '0% (disabled)';
  // Convert from 6-decimal scaled to percentage (divide by 1,000,000 to get %)
  const percentage = value / 1_000_000;
  return `${percentage}% (${value})`;
}

/**
 * Format fee amount for display
 * @param {BigInt|number} fee6Decimals - Fee amount scaled by 10^6 (represents dollars)
 * @returns {string} Formatted fee string
 */
function formatFeeAmount(fee6Decimals) {
  const value = Number(fee6Decimals);
  if (value === 0) return '$0.00 (disabled)';
  const dollars = value / 1_000_000;
  return `$${dollars.toFixed(6)} (${value})`;
}

/**
 * Format token amount for display
 * @param {BigInt|number} amount - Token amount in native decimals
 * @param {number} decimals - Token decimals
 * @returns {string} Formatted amount string
 */
function formatTokenAmount(amount, decimals) {
  const value = Number(amount);
  const formatted = value / Math.pow(10, decimals);
  return `${value} (${formatted.toFixed(decimals)} tokens)`;
}

/**
 * Fetch all events of a given type with pagination
 * @param {TronWeb} tronWeb - TronWeb instance
 * @param {string} contractAddress - Contract address
 * @param {string} eventName - Event name to fetch
 * @returns {Promise<Array>} Array of events
 */
async function fetchAllEvents(tronWeb, contractAddress, eventName) {
  const allEvents = [];
  let fingerprint = null;
  const pageSize = 200; // Max allowed by TronGrid
  
  try {
    do {
      const options = {
        eventName,
        size: pageSize,
        onlyConfirmed: true
      };
      
      if (fingerprint) {
        options.fingerprint = fingerprint;
      }
      
      const result = await tronWeb.getEventResult(contractAddress, options);
      
      // Handle different response formats
      let events = [];
      if (Array.isArray(result)) {
        events = result;
      } else if (result && result.data && Array.isArray(result.data)) {
        events = result.data;
      } else if (result && typeof result === 'object') {
        // Try to extract events from object
        events = Object.values(result).filter(v => typeof v === 'object' && v !== null);
      }
      
      if (events.length === 0) {
        break;
      }
      
      allEvents.push(...events);
      
      // Check if there are more pages
      if (events.length < pageSize) {
        break;
      }
      
      // Get fingerprint from response or last event for next page
      fingerprint = result?.meta?.fingerprint || 
                    (events.length > 0 ? events[events.length - 1].fingerprint : null);
      
    } while (fingerprint);
    
  } catch (error) {
    console.error(`   Warning: Could not fetch ${eventName} events: ${error.message}`);
  }
  
  return allEvents;
}

/**
 * Normalize a role hash for comparison (remove 0x prefix, lowercase)
 * @param {string} hash - Role hash
 * @returns {string} Normalized hash
 */
function normalizeRoleHash(hash) {
  if (!hash) return '';
  let normalized = hash.toLowerCase();
  if (normalized.startsWith('0x')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/**
 * Process role events to determine current holders
 * @param {Array} grantedEvents - RoleGranted events
 * @param {Array} revokedEvents - RoleRevoked events
 * @param {string} roleHash - The role hash to filter by
 * @param {TronWeb} tronWeb - TronWeb instance for address conversion
 * @returns {Set<string>} Set of current role holder addresses (base58)
 */
function processRoleEvents(grantedEvents, revokedEvents, roleHash, tronWeb) {
  // Combine and sort events by block timestamp
  const allEvents = [];
  
  // Normalize role hash for comparison (lowercase, without 0x prefix)
  const normalizedRoleHash = normalizeRoleHash(roleHash);
  
  for (const event of grantedEvents) {
    const eventRole = event.result?.role || event.result?.[0];
    const normalizedEventRole = normalizeRoleHash(eventRole);
    
    if (normalizedEventRole === normalizedRoleHash) {
      allEvents.push({
        type: 'grant',
        account: event.result?.account || event.result?.[1],
        timestamp: event.block_timestamp || event.timestamp || 0,
        block: event.block_number || event.block || 0
      });
    }
  }
  
  for (const event of revokedEvents) {
    const eventRole = event.result?.role || event.result?.[0];
    const normalizedEventRole = normalizeRoleHash(eventRole);
    
    if (normalizedEventRole === normalizedRoleHash) {
      allEvents.push({
        type: 'revoke',
        account: event.result?.account || event.result?.[1],
        timestamp: event.block_timestamp || event.timestamp || 0,
        block: event.block_number || event.block || 0
      });
    }
  }
  
  // Sort by timestamp/block
  allEvents.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.block - b.block;
  });
  
  // Process events to build current holder set
  const holders = new Set();
  
  for (const event of allEvents) {
    let address = event.account;
    
    // Convert to base58 if it's a hex address
    if (address && address.startsWith('0x')) {
      // Remove 0x and add 41 prefix for Tron hex format
      address = '41' + address.slice(2);
    }
    if (address && (address.startsWith('41') || address.startsWith('0x'))) {
      try {
        address = tronWeb.address.fromHex(address);
      } catch (e) {
        // Keep as-is if conversion fails
      }
    }
    
    if (event.type === 'grant') {
      holders.add(address);
    } else {
      holders.delete(address);
    }
  }
  
  return holders;
}

/**
 * Main inspection function
 */
async function inspectEscrow(network) {
  const networkConfig = config.getNetworkConfig(network);
  const addresses = networkConfig.contracts;
  const escrowAddress = addresses.ESCROW_ADDRESS;
  
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║              Escrow Contract Inspection                   ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  
  console.log(`Network:        ${network.toUpperCase()}`);
  console.log(`Escrow Address: ${escrowAddress}`);
  
  // Initialize TronWeb
  const tronWeb = new TronWeb({
    fullHost: networkConfig.api,
    privateKey: DUMMY_PRIVATE_KEY,
    // This script constructs its own client rather than using
    // config.initAdminTronWeb, so the header added there did not reach it: every
    // read here went out anonymously and getAllowedTokens() failed with a raw
    // axios 429 partway through the report.
    headers: config.apiHeaders()
  });
  
  // Load Escrow ABI and create contract instance
  const escrowABI = config.ABIS.Escrow;
  const escrow = await tronWeb.contract(escrowABI, escrowAddress);
  
  // ═══════════════════════════════════════════════════════════
  // CONTRACT STATE
  // ═══════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('CONTRACT STATE');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  // Query paused state
  const paused = await escrow.paused().call();
  console.log(`Paused:   ${paused}`);
  
  // Query immutable config
  const permit2Hex = await escrow.i_permit2().call();
  const permit2 = tronWeb.address.fromHex(permit2Hex);
  console.log(`Permit2:  ${permit2}`);
  
  const usdtHex = await escrow.i_usdt().call();
  const usdt = tronWeb.address.fromHex(usdtHex);
  console.log(`USDT:     ${usdt}`);
  
  // ═══════════════════════════════════════════════════════════
  // ALLOWED TOKENS
  // ═══════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('ALLOWED TOKENS');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  const allowedTokensResult = await escrow.getAllowedTokens().call();
  
  // Handle different return formats from TronWeb
  let allowedTokens = allowedTokensResult;
  if (allowedTokensResult && allowedTokensResult.allowedTokens) {
    allowedTokens = allowedTokensResult.allowedTokens;
  } else if (allowedTokensResult && allowedTokensResult[0] !== undefined && Array.isArray(allowedTokensResult[0])) {
    allowedTokens = allowedTokensResult[0];
  }
  
  // Filter out empty values
  const validTokens = Array.isArray(allowedTokens) 
    ? allowedTokens.filter(t => t && t !== '' && t !== '0x0000000000000000000000000000000000000000000000')
    : [];
  
  if (validTokens.length === 0) {
    console.log('(no tokens allowlisted)');
  } else {
    for (const tokenHex of validTokens) {
      let tokenAddress;
      try {
        // Handle both hex formats (with or without 41 prefix)
        if (typeof tokenHex === 'string' && tokenHex.startsWith('0x')) {
          tokenAddress = tronWeb.address.fromHex('41' + tokenHex.slice(2));
        } else if (typeof tokenHex === 'string' && tokenHex.startsWith('41')) {
          tokenAddress = tronWeb.address.fromHex(tokenHex);
        } else if (typeof tokenHex === 'string' && tokenHex.startsWith('T')) {
          tokenAddress = tokenHex; // Already base58
        } else {
          tokenAddress = tronWeb.address.fromHex(tokenHex);
        }
      } catch (e) {
        console.log(`Token: ${tokenHex} (could not convert address: ${e.message})`);
        continue;
      }
      
      console.log(`Token: ${tokenAddress}`);
      
      // Get token config - pass the original hex format
      const configResult = await escrow.getTokenConfig(tokenHex).call();
      const tokenConfig = configResult[0] ?? configResult;
      console.log(`  Decimals:        ${tokenConfig.tokenDecimals}`);
      console.log(`  Fee Percentage:  ${formatFeePercentage(tokenConfig.feePercentage6Decimals)}`);
      console.log(`  Min Fee:         ${formatFeeAmount(tokenConfig.minFee6Decimals)}`);
      console.log(`  Max Fee:         ${formatFeeAmount(tokenConfig.maxFee6Decimals)}`);
      
      // Get fee revenue
      const revenueResult = await escrow.getFeeRevenue(tokenHex).call();
      const revenue = revenueResult[0] ?? revenueResult;
      console.log(`  Fee Revenue:     ${formatTokenAmount(revenue, Number(tokenConfig.tokenDecimals))}`);
      console.log('');
    }
  }
  
  // ═══════════════════════════════════════════════════════════
  // ROLE STATE
  // ═══════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════');
  console.log('ROLE STATE');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  // Fetch role hashes from contract
  console.log('Fetching role hashes from contract...');
  const pauserRole = await escrow.PAUSER_ROLE().call();
  const treasurerRole = await escrow.TREASURER_ROLE().call();
  const tokenConfigRole = await escrow.TOKEN_CONFIG_ROLE().call();
  
  const roles = [
    { name: 'DEFAULT_ADMIN_ROLE', hash: DEFAULT_ADMIN_ROLE },
    { name: 'PAUSER_ROLE', hash: pauserRole },
    { name: 'TREASURER_ROLE', hash: treasurerRole },
    { name: 'TOKEN_CONFIG_ROLE', hash: tokenConfigRole }
  ];
  
  // Try to fetch role events first
  console.log('Fetching role events...');
  const grantedEvents = await fetchAllEvents(tronWeb, escrowAddress, 'RoleGranted');
  const revokedEvents = await fetchAllEvents(tronWeb, escrowAddress, 'RoleRevoked');
  
  const eventsAvailable = grantedEvents.length > 0 || revokedEvents.length > 0;
  
  if (eventsAvailable) {
    console.log(`  Found ${grantedEvents.length} RoleGranted, ${revokedEvents.length} RoleRevoked events`);
    console.log('');
    
    // Process each role using events
    for (const role of roles) {
      const holders = processRoleEvents(grantedEvents, revokedEvents, role.hash, tronWeb);
      
      console.log(`${role.name}:`);
      if (holders.size === 0) {
        console.log('  (none)');
      } else {
        for (const holder of holders) {
          console.log(`  -> ${holder}`);
        }
      }
      console.log('');
    }
  } else {
    // Fallback: Use direct hasRole queries
    console.log('  Events not available, using direct role queries...');
    console.log('');
    
    // Get the default admin address from the contract
    const defaultAdminHex = await escrow.defaultAdmin().call();
    const defaultAdmin = tronWeb.address.fromHex(defaultAdminHex);
    
    console.log(`DEFAULT_ADMIN_ROLE:`);
    console.log(`  -> ${defaultAdmin}`);
    console.log('');
    
    // Check if the default admin has other roles
    for (const role of roles.slice(1)) { // Skip DEFAULT_ADMIN_ROLE already shown
      console.log(`${role.name}:`);
      
      // Check if default admin has this role
      const hasRoleResult = await escrow.hasRole(role.hash, defaultAdmin).call();
      const hasRole = hasRoleResult[0] ?? hasRoleResult;
      
      if (hasRole) {
        console.log(`  -> ${defaultAdmin}`);
      } else {
        console.log('  (default admin does not have this role)');
      }
      console.log('');
    }
    
    console.log('Note: Only checked default admin address. Other addresses may also hold roles.');
  }
  
  console.log('═══════════════════════════════════════════════════════════\n');
}

/**
 * Main execution
 */
async function main() {
  try {
    const { network } = validateInputs();
    await inspectEscrow(network);
  } catch (error) {
    console.error('\nError:', error.message);
    if (error.stack) {
      console.error('\nStack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Run the script
main();
