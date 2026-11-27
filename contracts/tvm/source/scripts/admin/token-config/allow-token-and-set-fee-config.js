#!/usr/bin/env node

/**
 * Allow Token and Set Fee Config Script
 * 
 * Adds a token to the Escrow allowlist and configures fees in one transaction.
 * Requires TOKEN_CONFIG_ROLE.
 * 
 * Usage: node scripts/admin/token-config/allow-token-and-set-fee-config.js <network> <token> <decimals> <fee%> <min-fee> <max-fee>
 * 
 * Arguments:
 *   network        - 'mainnet' or 'shasta'
 *   token          - Tron address of the token
 *   decimals       - Token decimals (1-30)
 *   fee-percentage - Fee percentage scaled by 10^6 (e.g., 20000 = 0.02%)
 *   min-fee        - Minimum fee scaled by 10^6 (e.g., 1000000 = $1), 0 to disable
 *   max-fee        - Maximum fee scaled by 10^6 (e.g., 250000000 = $250), 0 to disable
 * NOTE: the max-fee value MUST equal the fee cap the offchain signer uses for release and
 * refund witnesses. A mismatch reverts InvalidWitnessValues on BOTH paths for any deposit
 * above the cap threshold, so it is neither releasable nor refundable. Below the threshold
 * neither cap binds and the two agree, which is why a mismatch can go unnoticed.
 * 
 * Example:
 *   node allow-token-and-set-fee-config.js shasta TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs 6 20000 1000000 250000000
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
  
  if (args.length !== 6) {
    console.error('Usage: node allow-token-and-set-fee-config.js <network> <token> <decimals> <fee%> <min-fee> <max-fee>');
    console.error('\nArguments:');
    console.error('  network:  mainnet | shasta');
    console.error('  token:    Tron address (T...)');
    console.error('  decimals: Token decimals (1-30)');
    console.error('  fee%:     Fee percentage scaled by 10^6 (20000 = 0.02%)');
    console.error('  min-fee:  Min fee in $ scaled by 10^6 (1000000 = $1), 0 to disable');
    console.error('  max-fee:  Max fee in $ scaled by 10^6 (250000000 = $250), 0 to disable');
    process.exit(1);
  }
  
  const [network, tokenAddress, decimalsStr, feePercentageStr, minFeeStr, maxFeeStr] = args;
  
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
  
  // Parse fee values
  const feePercentage = BigInt(feePercentageStr);
  const minFee = BigInt(minFeeStr);
  const maxFee = BigInt(maxFeeStr);
  
  console.log('=== Allow Token and Set Fee Config ===\n');
  console.log(`Network: ${validNetwork.toUpperCase()}`);
  
  const tronWeb = config.initAdminTronWeb(validNetwork);
  const adminAddress = tronWeb.address.fromPrivateKey(process.env.ADMIN_PK);
  const addresses = config.getContractAddresses(validNetwork);
  
  console.log(`Caller Address: ${adminAddress}`);
  console.log(`Contract: Escrow (${addresses.ESCROW_ADDRESS})`);
  
  const { escrow } = await config.getContracts(tronWeb, validNetwork);
  
  console.log(`\nToken: ${tokenAddress}`);
  console.log(`Decimals: ${decimals}`);
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
  
  // Check if token is already allowed
  const isAllowedResult = await escrow.isTokenAllowed(tokenAddress).call();
  const isAllowed = isAllowedResult[0] ?? isAllowedResult;
  if (isAllowed) {
    console.error('\nError: Token is already allowlisted. Use set-token-fee-config.js to update fees.');
    process.exit(1);
  }
  
  console.log('\nAllowlisting token and setting fee config...');
  
  const tx = await escrow.allowTokenAndSetFeeConfig(
    tokenAddress,
    decimals,
    feePercentage.toString(),
    minFee.toString(),
    maxFee.toString()
  ).send(await config.writeOptions(tronWeb));
  
  console.log(`Transaction: ${config.getTxId(tx)}`);
  
  await config.waitForConfirmation();
  
  // Verify
  const isAllowedAfterResult = await escrow.isTokenAllowed(tokenAddress).call();
  const isAllowedAfter = isAllowedAfterResult[0] ?? isAllowedAfterResult;
  if (isAllowedAfter) {
    const newConfigResult = await escrow.getTokenConfig(tokenAddress).call();
    const newConfig = newConfigResult[0] ?? newConfigResult;
    console.log('\nToken allowlisted with config:');
    console.log(`  Decimals: ${newConfig.tokenDecimals}`);
    console.log(`  Fee Percentage: ${formatFeePercentage(newConfig.feePercentage6Decimals)}`);
    console.log(`  Min Fee: ${formatFeeAmount(newConfig.minFee6Decimals)}`);
    console.log(`  Max Fee: ${formatFeeAmount(newConfig.maxFee6Decimals)}`);
    console.log('\nToken allowlisted and configured successfully!');
  } else {
    console.error('\nWarning: Operation may have failed. Please verify.');
  }
}

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
