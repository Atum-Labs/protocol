#!/usr/bin/env node

/**
 * Disallow Token Script
 * 
 * Removes a token from the Escrow allowlist.
 * Existing deposits can still be refunded after disallowing.
 * Requires TOKEN_CONFIG_ROLE.
 * 
 * Usage: node scripts/admin/token-config/disallow-token.js <network> <token-address>
 * 
 * Arguments:
 *   network       - 'mainnet' or 'shasta'
 *   token-address - Tron address of the token
 * 
 * Example:
 *   node scripts/admin/token-config/disallow-token.js shasta TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs
 */

const config = require('../../config');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    console.error('Usage: node disallow-token.js <network> <token-address>');
    console.error('  network: mainnet | shasta');
    console.error('  token-address: Tron address (T...)');
    process.exit(1);
  }
  
  const [network, tokenAddress] = args;
  
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
  
  console.log('=== Disallow Token ===\n');
  console.log(`Network: ${validNetwork.toUpperCase()}`);
  
  const tronWeb = config.initAdminTronWeb(validNetwork);
  const adminAddress = tronWeb.address.fromPrivateKey(process.env.ADMIN_PK);
  const addresses = config.getContractAddresses(validNetwork);
  
  console.log(`Caller Address: ${adminAddress}`);
  console.log(`Contract: Escrow (${addresses.ESCROW_ADDRESS})`);
  
  const { escrow } = await config.getContracts(tronWeb, validNetwork);
  
  console.log(`Token: ${tokenAddress}`);
  
  // Check if caller has TOKEN_CONFIG_ROLE
  const tokenConfigRole = await escrow.TOKEN_CONFIG_ROLE().call();
  const hasRoleResult = await escrow.hasRole(tokenConfigRole, adminAddress).call();
  const hasRole = hasRoleResult[0] ?? hasRoleResult;
  
  if (!hasRole) {
    console.error('\nError: Caller does not have TOKEN_CONFIG_ROLE');
    process.exit(1);
  }
  
  // Check if token is allowed
  const isAllowedResult = await escrow.isTokenAllowed(tokenAddress).call();
  const isAllowed = isAllowedResult[0] ?? isAllowedResult;
  if (!isAllowed) {
    console.log('\nToken is not allowlisted. No action needed.');
    return;
  }
  
  console.log('\nRemoving token from allowlist...');
  console.log('Note: Existing deposits can still be refunded.');
  
  const tx = await escrow.disallowToken(tokenAddress).send(await config.writeOptions(tronWeb));
  
  console.log(`Transaction: ${config.getTxId(tx)}`);
  
  await config.waitForConfirmation();
  
  // Verify
  const isAllowedAfterResult = await escrow.isTokenAllowed(tokenAddress).call();
  const isAllowedAfter = isAllowedAfterResult[0] ?? isAllowedAfterResult;
  if (!isAllowedAfter) {
    console.log('\nToken removed from allowlist successfully!');
  } else {
    console.error('\nWarning: Token disallow may have failed. Please verify.');
  }
}

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
