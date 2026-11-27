#!/usr/bin/env node

/**
 * Change Admin Delay Script
 * 
 * Changes the delay required for admin transfers.
 * Requires DEFAULT_ADMIN_ROLE.
 * 
 * Usage: node scripts/admin/access-control/change-admin-delay.js <network> <contract> <delay-seconds>
 * 
 * Arguments:
 *   network       - 'mainnet' or 'shasta'
 *   contract      - 'escrow' or 'fulfillment-proxy'
 *   delay-seconds - New delay in seconds (e.g., 172800 for 2 days)
 * 
 * Example:
 *   node scripts/admin/access-control/change-admin-delay.js shasta escrow 172800
 */

const config = require('../../config');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 3) {
    console.error('Usage: node change-admin-delay.js <network> <contract> <delay-seconds>');
    console.error('  network: mainnet | shasta');
    console.error('  contract: escrow | fulfillment-proxy');
    console.error('  delay-seconds: New delay in seconds');
    console.error('\nCommon values:');
    console.error('  1 hour:  3600');
    console.error('  1 day:   86400');
    console.error('  2 days:  172800');
    console.error('  7 days:  604800');
    process.exit(1);
  }
  
  const [network, contractName, delayStr] = args;
  
  // Validate network
  let validNetwork;
  try {
    validNetwork = config.validateNetwork(network);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  
  // Validate contract
  if (!['escrow', 'fulfillment-proxy'].includes(contractName)) {
    console.error('Invalid contract. Use "escrow" or "fulfillment-proxy"');
    process.exit(1);
  }
  
  // Validate delay
  const delay = parseInt(delayStr, 10);
  if (isNaN(delay) || delay < 0) {
    console.error('Invalid delay. Must be a non-negative integer.');
    process.exit(1);
  }
  
  console.log('=== Change Admin Delay ===\n');
  console.log(`Network: ${validNetwork.toUpperCase()}`);
  
  const tronWeb = config.initAdminTronWeb(validNetwork);
  const adminAddress = tronWeb.address.fromPrivateKey(process.env.ADMIN_PK);
  console.log(`Admin Address: ${adminAddress}`);
  
  const { escrow, fulfillmentProxy } = await config.getContracts(tronWeb, validNetwork);
  const contract = contractName === 'escrow' ? escrow : fulfillmentProxy;
  const addresses = config.getContractAddresses(validNetwork);
  const contractAddr = contractName === 'escrow' 
    ? addresses.ESCROW_ADDRESS 
    : addresses.FULFILLMENT_PROXY_ADDRESS;
  
  console.log(`Contract: ${contractName} (${contractAddr})`);
  
  // Get current delay
  const currentDelay = await contract.defaultAdminDelay().call();
  console.log(`Current Delay: ${currentDelay} seconds (${Number(currentDelay) / 86400} days)`);
  console.log(`New Delay: ${delay} seconds (${delay / 86400} days)`);
  
  console.log('\nChanging admin delay...');
  console.log('Note: The delay change is itself subject to the current delay.');
  
  const tx = await contract.changeDefaultAdminDelay(delay).send(await config.writeOptions(tronWeb));
  
  console.log(`Transaction: ${config.getTxId(tx)}`);
  
  await config.waitForConfirmation();
  
  // Check pending delay change
  const pendingDelay = await contract.pendingDefaultAdminDelay().call();
  console.log(`\nPending Delay: ${pendingDelay[0]} seconds`);
  console.log(`Effective After: ${new Date(Number(pendingDelay[1]) * 1000).toISOString()}`);
  console.log('\nDelay change scheduled successfully!');
}

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
