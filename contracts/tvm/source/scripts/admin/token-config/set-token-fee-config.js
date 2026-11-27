#!/usr/bin/env node

/**
 * Set Token Fee Config Script
 * 
 * Sets or updates fee configuration for an allowlisted token.
 * Requires TOKEN_CONFIG_ROLE.
 * 
 * Usage: node scripts/admin/token-config/set-token-fee-config.js <network> <token> <fee-percentage> <min-fee> <max-fee>
 * 
 * Arguments:
 *   network        - 'mainnet' or 'shasta'
 *   token          - Tron address of the token
 *   fee-percentage - Fee percentage scaled by 10^6 (e.g., 20000 = 0.02%)
 *   min-fee        - Minimum fee scaled by 10^6 (e.g., 1000000 = $1), 0 to disable
 *   max-fee        - Maximum fee scaled by 10^6 (e.g., 250000000 = $250), 0 to disable
 * NOTE: the max-fee value MUST equal the fee cap the offchain signer uses for release and
 * refund witnesses. A mismatch reverts InvalidWitnessValues on BOTH paths for any deposit
 * above the cap threshold, so it is neither releasable nor refundable. Below the threshold
 * neither cap binds and the two agree, which is why a mismatch can go unnoticed.
 * 
 * Examples:
 *   # 0.02% fee, no min/max
 *   node set-token-fee-config.js shasta TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs 20000 0 0
 *   
 *   # 0.02% fee, $1 min, $250 max
 *   node set-token-fee-config.js shasta TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs 20000 1000000 250000000
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
  
  if (args.length !== 5) {
    console.error('Usage: node set-token-fee-config.js <network> <token> <fee-percentage> <min-fee> <max-fee>');
    console.error('\nArguments (all fee values scaled by 10^6):');
    console.error('  network:        mainnet | shasta');
    console.error('  token:          Tron address (T...)');
    console.error('  fee-percentage: Fee % (e.g., 20000 = 0.02%, 1000000 = 1%)');
    console.error('  min-fee:        Min fee in $ (e.g., 1000000 = $1), 0 to disable');
    console.error('  max-fee:        Max fee in $ (e.g., 250000000 = $250), 0 to disable');
    console.error('\nExamples:');
    console.error('  0.02% fee, no bounds:     node set-token-fee-config.js shasta TOKEN 20000 0 0');
    console.error('  0.02% fee, $1-$250 bounds: node set-token-fee-config.js shasta TOKEN 20000 1000000 250000000');
    process.exit(1);
  }
  
  const [network, tokenAddress, feePercentageStr, minFeeStr, maxFeeStr] = args;
  
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
  
  // Parse fee values
  const feePercentage = BigInt(feePercentageStr);
  const minFee = BigInt(minFeeStr);
  const maxFee = BigInt(maxFeeStr);
  
  console.log('=== Set Token Fee Config ===\n');
  console.log(`Network: ${validNetwork.toUpperCase()}`);
  
  const tronWeb = config.initAdminTronWeb(validNetwork);
  const adminAddress = tronWeb.address.fromPrivateKey(process.env.ADMIN_PK);
  const addresses = config.getContractAddresses(validNetwork);
  
  console.log(`Caller Address: ${adminAddress}`);
  console.log(`Contract: Escrow (${addresses.ESCROW_ADDRESS})`);
  
  const { escrow } = await config.getContracts(tronWeb, validNetwork);
  
  console.log(`\nToken: ${tokenAddress}`);
  console.log(`Fee Percentage: ${formatFeePercentage(feePercentage)}`);
  console.log(`Min Fee: ${formatFeeAmount(minFee)}`);
  console.log(`Max Fee: ${formatFeeAmount(maxFee)}`);
  
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
    console.error('\nError: Token is not allowlisted. Use allow-token.js first.');
    process.exit(1);
  }
  
  // Get current config for reference
  const currentConfigResult = await escrow.getTokenConfig(tokenAddress).call();
  const currentConfig = currentConfigResult[0] ?? currentConfigResult;
  console.log('\nCurrent Config:');
  console.log(`  Fee Percentage: ${formatFeePercentage(currentConfig.feePercentage6Decimals)}`);
  console.log(`  Min Fee: ${formatFeeAmount(currentConfig.minFee6Decimals)}`);
  console.log(`  Max Fee: ${formatFeeAmount(currentConfig.maxFee6Decimals)}`);
  
  console.log('\nUpdating fee configuration...');
  
  const tx = await escrow.setTokenFeeConfig(
    tokenAddress,
    feePercentage.toString(),
    minFee.toString(),
    maxFee.toString()
  ).send(await config.writeOptions(tronWeb));
  
  console.log(`Transaction: ${config.getTxId(tx)}`);
  
  await config.waitForConfirmation();
  
  // Verify
  const newConfigResult = await escrow.getTokenConfig(tokenAddress).call();
  const newConfig = newConfigResult[0] ?? newConfigResult;
  console.log('\nNew Config:');
  console.log(`  Fee Percentage: ${formatFeePercentage(newConfig.feePercentage6Decimals)}`);
  console.log(`  Min Fee: ${formatFeeAmount(newConfig.minFee6Decimals)}`);
  console.log(`  Max Fee: ${formatFeeAmount(newConfig.maxFee6Decimals)}`);
  
  console.log('\nFee configuration updated successfully!');
}

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
