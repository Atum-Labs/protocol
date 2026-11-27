#!/usr/bin/env node

/**
 * Pause FulfillmentProxy Script
 * 
 * Pauses the FulfillmentProxy contract, preventing fulfillments.
 * Requires PAUSER_ROLE.
 * 
 * Usage: node scripts/admin/pause/pause-fulfillment-proxy.js <network>
 * 
 * Arguments:
 *   network - 'mainnet' or 'shasta'
 * 
 * Example:
 *   node scripts/admin/pause/pause-fulfillment-proxy.js shasta
 */

const config = require('../../config');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 1) {
    console.error('Usage: node pause-fulfillment-proxy.js <network>');
    console.error('  network: mainnet | shasta');
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
  
  console.log('=== Pause FulfillmentProxy ===\n');
  console.log(`Network: ${validNetwork.toUpperCase()}`);
  
  const tronWeb = config.initAdminTronWeb(validNetwork);
  const adminAddress = tronWeb.address.fromPrivateKey(process.env.ADMIN_PK);
  const addresses = config.getContractAddresses(validNetwork);
  
  console.log(`Caller Address: ${adminAddress}`);
  console.log(`Contract: FulfillmentProxy (${addresses.FULFILLMENT_PROXY_ADDRESS})`);
  
  const { fulfillmentProxy } = await config.getContracts(tronWeb, validNetwork);
  
  // Check current pause state
  const isPausedResult = await fulfillmentProxy.paused().call();
  const isPaused = isPausedResult[0] ?? isPausedResult;
  console.log(`Current State: ${isPaused ? 'PAUSED' : 'ACTIVE'}`);
  
  if (isPaused) {
    console.log('\nContract is already paused. No action needed.');
    return;
  }
  
  // Check if caller has PAUSER_ROLE
  const pauserRole = await fulfillmentProxy.PAUSER_ROLE().call();
  const hasRoleResult = await fulfillmentProxy.hasRole(pauserRole, adminAddress).call();
  const hasRole = hasRoleResult[0] ?? hasRoleResult;
  
  if (!hasRole) {
    console.error('\nError: Caller does not have PAUSER_ROLE');
    process.exit(1);
  }
  
  console.log('\nPausing contract...');
  
  const tx = await fulfillmentProxy.pause().send(await config.writeOptions(tronWeb));
  
  console.log(`Transaction: ${config.getTxId(tx)}`);
  
  await config.waitForConfirmation();
  
  // Verify
  const isPausedAfterResult = await fulfillmentProxy.paused().call();
  const isPausedAfter = isPausedAfterResult[0] ?? isPausedAfterResult;
  if (isPausedAfter) {
    console.log('\nFulfillmentProxy contract paused successfully!');
  } else {
    console.error('\nWarning: Pause may have failed. Please verify.');
  }
}

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
