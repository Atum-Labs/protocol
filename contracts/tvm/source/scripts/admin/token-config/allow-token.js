#!/usr/bin/env node

/**
 * Allow Token Script
 * 
 * Adds a token to the Escrow allowlist (without fees).
 * Use set-token-fee-config.js to configure fees separately.
 * Requires TOKEN_CONFIG_ROLE.
 * 
 * Usage: node scripts/admin/token-config/allow-token.js <network> <token-address> <decimals>
 * 
 * Arguments:
 *   network       - 'mainnet' or 'shasta'
 *   token-address - Tron address of the token contract
 *   decimals      - Token decimals (1-30)
 * 
 * Example:
 *   node scripts/admin/token-config/allow-token.js shasta TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs 6
 */

const config = require('../../config');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 3) {
    console.error('Usage: node allow-token.js <network> <token-address> <decimals>');
    console.error('  network: mainnet | shasta');
    console.error('  token-address: Tron address (T...)');
    console.error('  decimals: Token decimals (1-30)');
    process.exit(1);
  }
  
  const [network, tokenAddress, decimalsStr] = args;
  
  // Validate network
  let validNetwork;
  try {
    validNetwork = config.validateNetwork(network);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  
  // Validate token address format
  if (!tokenAddress.startsWith('T') || tokenAddress.length < 34) {
    console.error('Invalid token address format');
    process.exit(1);
  }
  
  // Validate decimals
  const decimals = parseInt(decimalsStr, 10);
  if (isNaN(decimals) || decimals < 1 || decimals > 30) {
    console.error('Invalid decimals. Must be between 1 and 30.');
    process.exit(1);
  }
  
  console.log('=== Allow Token ===\n');
  console.log(`Network: ${validNetwork.toUpperCase()}`);
  
  const tronWeb = config.initAdminTronWeb(validNetwork);
  const adminAddress = tronWeb.address.fromPrivateKey(process.env.ADMIN_PK);
  const addresses = config.getContractAddresses(validNetwork);
  
  console.log(`Caller Address: ${adminAddress}`);
  console.log(`Contract: Escrow (${addresses.ESCROW_ADDRESS})`);
  
  const { escrow } = await config.getContracts(tronWeb, validNetwork);
  
  console.log(`Token: ${tokenAddress}`);
  console.log(`Decimals: ${decimals}`);
  
  // Check if caller has TOKEN_CONFIG_ROLE
  const tokenConfigRole = await escrow.TOKEN_CONFIG_ROLE().call();
  const hasRoleResult = await escrow.hasRole(tokenConfigRole, adminAddress).call();
  const hasRole = hasRoleResult[0] ?? hasRoleResult;
  
  if (!hasRole) {
    console.error('\nError: Caller does not have TOKEN_CONFIG_ROLE');
    process.exit(1);
  }
  
  // Check if token is already allowed
  const isAllowedResult = await escrow.isTokenAllowed(tokenAddress).call();
  const isAllowed = isAllowedResult[0] ?? isAllowedResult;
  if (isAllowed) {
    console.log('\nToken is already allowlisted. No action needed.');
    return;
  }
  
  console.log('\nAdding token to allowlist...');
  
  const tx = await escrow.allowToken(tokenAddress, decimals).send(await config.writeOptions(tronWeb));
  
  console.log(`Transaction: ${config.getTxId(tx)}`);
  
  await config.waitForConfirmation();
  
  // Verify
  const isAllowedAfterResult = await escrow.isTokenAllowed(tokenAddress).call();
  const isAllowedAfter = isAllowedAfterResult[0] ?? isAllowedAfterResult;
  if (isAllowedAfter) {
    console.log('\nToken allowlisted successfully!');
    console.log('Note: No fees configured. Use set-token-fee-config.js to set fees.');
  } else {
    console.error('\nWarning: Token allowlisting may have failed. Please verify.');
  }
}

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
