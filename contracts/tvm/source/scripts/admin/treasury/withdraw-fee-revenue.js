#!/usr/bin/env node

/**
 * Withdraw Fee Revenue Script
 * 
 * Withdraws accumulated fee revenue for a specific token.
 * Requires TREASURER_ROLE.
 * 
 * Usage: node scripts/admin/treasury/withdraw-fee-revenue.js <network> <token-address> <recipient>
 * 
 * Arguments:
 *   network       - 'mainnet' or 'shasta'
 *   token-address - Tron address of the token to withdraw
 *   recipient     - Tron address to receive the withdrawn fees
 * 
 * Example:
 *   node scripts/admin/treasury/withdraw-fee-revenue.js shasta TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs TTreasury...
 */

const config = require('../../config');

function formatTokenAmount(amount, decimals) {
  const value = Number(amount) / Math.pow(10, decimals);
  return `${value.toLocaleString(undefined, { maximumFractionDigits: decimals })} (raw: ${amount})`;
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 3) {
    console.error('Usage: node withdraw-fee-revenue.js <network> <token-address> <recipient>');
    console.error('  network: mainnet | shasta');
    console.error('  token-address: Tron address of the token (T...)');
    console.error('  recipient: Tron address to receive fees (T...)');
    process.exit(1);
  }
  
  const [network, tokenAddress, recipient] = args;
  
  // Validate network
  let validNetwork;
  try {
    validNetwork = config.validateNetwork(network);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  
  // Validate addresses
  if (!tokenAddress.startsWith('T') || tokenAddress.length < 34) {
    console.error('Invalid token address format');
    process.exit(1);
  }
  
  if (!recipient.startsWith('T') || recipient.length < 34) {
    console.error('Invalid recipient address format');
    process.exit(1);
  }
  
  console.log('=== Withdraw Fee Revenue ===\n');
  console.log(`Network: ${validNetwork.toUpperCase()}`);
  
  const tronWeb = config.initAdminTronWeb(validNetwork);
  const adminAddress = tronWeb.address.fromPrivateKey(process.env.ADMIN_PK);
  const addresses = config.getContractAddresses(validNetwork);
  
  console.log(`Caller Address: ${adminAddress}`);
  console.log(`Contract: Escrow (${addresses.ESCROW_ADDRESS})`);
  
  const { escrow } = await config.getContracts(tronWeb, validNetwork);
  
  console.log(`Token: ${tokenAddress}`);
  console.log(`Recipient: ${recipient}`);
  
  // Check if caller has TREASURER_ROLE
  const treasurerRole = await escrow.TREASURER_ROLE().call();
  const hasRoleResult = await escrow.hasRole(treasurerRole, adminAddress).call();
  const hasRole = hasRoleResult[0] ?? hasRoleResult;
  
  if (!hasRole) {
    console.error('\nError: Caller does not have TREASURER_ROLE');
    process.exit(1);
  }
  
  // Get token config to know decimals
  const tokenConfigResult = await escrow.getTokenConfig(tokenAddress).call();
  const tokenConfig = tokenConfigResult[0] ?? tokenConfigResult;
  const decimals = Number(tokenConfig.tokenDecimals);
  
  // Get current fee revenue
  const feeRevenue = await escrow.getFeeRevenue(tokenAddress).call();
  console.log(`\nAccumulated Fee Revenue: ${formatTokenAmount(feeRevenue, decimals)}`);
  
  if (feeRevenue.toString() === '0') {
    console.log('\nNo fee revenue to withdraw.');
    return;
  }
  
  // Get token instance for balance checks
  const tokenAbi = config.ABIS.IERC20;
  const token = await tronWeb.contract(tokenAbi, tokenAddress);
  
  // Get recipient balance before
  const balanceBefore = await token.balanceOf(recipient).call();
  console.log(`Recipient Balance (before): ${formatTokenAmount(balanceBefore, decimals)}`);
  
  console.log('\nWithdrawing fee revenue...');
  
  const tx = await escrow.withdrawFeeRevenue(tokenAddress, recipient).send(await config.writeOptions(tronWeb));
  
  console.log(`Transaction: ${config.getTxId(tx)}`);
  
  await config.waitForConfirmation();
  
  // Verify
  const feeRevenueAfter = await escrow.getFeeRevenue(tokenAddress).call();
  const balanceAfter = await token.balanceOf(recipient).call();
  
  console.log(`\nFee Revenue (after): ${formatTokenAmount(feeRevenueAfter, decimals)}`);
  console.log(`Recipient Balance (after): ${formatTokenAmount(balanceAfter, decimals)}`);
  
  const withdrawn = BigInt(balanceAfter) - BigInt(balanceBefore);
  console.log(`\nWithdrawn: ${formatTokenAmount(withdrawn, decimals)}`);
  
  if (feeRevenueAfter.toString() === '0') {
    console.log('\nFee revenue withdrawn successfully!');
  } else {
    console.error('\nWarning: Some fee revenue may remain. Please verify.');
  }
}

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
