#!/usr/bin/env node

/**
 * Clear Token Fee Config Script
 * 
 * Clears fee configuration for an allowlisted token (sets all fees to zero).
 * Token remains allowlisted.
 * Requires TOKEN_CONFIG_ROLE.
 * 
 * Usage: node scripts/admin/token-config/clear-token-fee-config.js <network> <token-address>
 * 
 * Arguments:
 *   network       - 'mainnet' or 'shasta'
 *   token-address - Tron address of the token
 * 
 * Example:
 *   node scripts/admin/token-config/clear-token-fee-config.js shasta TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs
 */

const config = require('../../config');

function formatFeePercentage(value) {
  const percentage = Number(value) / 1_000_000;
  return `${percentage}% (raw: ${value})`;
}

function formatFeeAmount(value) {
  const dollars = Number(value) / 1_000_000;
  return value === '0' || value === 0 ? 'disabled' : `$${dollars.toFixed(6)} (raw: ${value})`;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    console.error('Usage: node clear-token-fee-config.js <network> <token-address>');
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
  
  console.log('=== Clear Token Fee Config ===\n');
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
    console.error('\nError: Token is not allowlisted.');
    process.exit(1);
  }
  
  // Get current config
  const currentConfigResult = await escrow.getTokenConfig(tokenAddress).call();
  const currentConfig = currentConfigResult[0] ?? currentConfigResult;
  console.log('\nCurrent Config:');
  console.log(`  Fee Percentage: ${formatFeePercentage(currentConfig.feePercentage6Decimals)}`);
  console.log(`  Min Fee: ${formatFeeAmount(currentConfig.minFee6Decimals)}`);
  console.log(`  Max Fee: ${formatFeeAmount(currentConfig.maxFee6Decimals)}`);
  
  // Check if already cleared
  if (
    currentConfig.feePercentage6Decimals.toString() === '0' &&
    currentConfig.minFee6Decimals.toString() === '0' &&
    currentConfig.maxFee6Decimals.toString() === '0'
  ) {
    console.log('\nFee config is already cleared. No action needed.');
    return;
  }
  
  console.log('\nClearing fee configuration...');
  
  const tx = await escrow.clearTokenFeeConfig(tokenAddress).send(await config.writeOptions(tronWeb));
  
  console.log(`Transaction: ${config.getTxId(tx)}`);
  
  await config.waitForConfirmation();
  
  // Verify
  const newConfigResult = await escrow.getTokenConfig(tokenAddress).call();
  const newConfig = newConfigResult[0] ?? newConfigResult;
  if (
    newConfig.feePercentage6Decimals.toString() === '0' &&
    newConfig.minFee6Decimals.toString() === '0' &&
    newConfig.maxFee6Decimals.toString() === '0'
  ) {
    console.log('\nFee configuration cleared successfully!');
    console.log('Note: Token is still allowlisted but has no fees.');
  } else {
    console.error('\nWarning: Fee clearing may have failed. Please verify.');
  }
}

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
