#!/usr/bin/env node

/**
 * Accept Admin Transfer Script
 * 
 * Accepts a pending admin transfer to become the new DEFAULT_ADMIN.
 * Must be called by the pending new admin after begin-admin-transfer.
 * 
 * Usage: node scripts/admin/access-control/accept-admin-transfer.js <network> <contract>
 * 
 * Arguments:
 *   network  - 'mainnet' or 'shasta'
 *   contract - 'escrow' or 'fulfillment-proxy'
 * 
 * Example:
 *   node scripts/admin/access-control/accept-admin-transfer.js shasta escrow
 */

const config = require('../../config');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    console.error('Usage: node accept-admin-transfer.js <network> <contract>');
    console.error('  network: mainnet | shasta');
    console.error('  contract: escrow | fulfillment-proxy');
    process.exit(1);
  }
  
  const [network, contractName] = args;
  
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
  
  console.log('=== Accept Admin Transfer ===\n');
  console.log(`Network: ${validNetwork.toUpperCase()}`);
  
  const tronWeb = config.initAdminTronWeb(validNetwork);
  const callerAddress = tronWeb.address.fromPrivateKey(process.env.ADMIN_PK);
  console.log(`Caller Address: ${callerAddress}`);
  
  const { escrow, fulfillmentProxy } = await config.getContracts(tronWeb, validNetwork);
  const contract = contractName === 'escrow' ? escrow : fulfillmentProxy;
  const addresses = config.getContractAddresses(validNetwork);
  const contractAddr = contractName === 'escrow' 
    ? addresses.ESCROW_ADDRESS 
    : addresses.FULFILLMENT_PROXY_ADDRESS;
  
  console.log(`Contract: ${contractName} (${contractAddr})`);
  
  // Check pending admin
  const pendingAdmin = await contract.pendingDefaultAdmin().call();
  const pendingAdminAddress = tronWeb.address.fromHex(pendingAdmin[0]);
  const scheduleTimestamp = Number(pendingAdmin[1]);
  
  console.log(`Pending Admin: ${pendingAdminAddress}`);
  console.log(`Schedule: ${new Date(scheduleTimestamp * 1000).toISOString()}`);
  
  if (pendingAdminAddress === 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb') { // Zero address check
    console.error('\nNo pending admin transfer found');
    process.exit(1);
  }
  
  if (pendingAdminAddress !== callerAddress) {
    console.error(`\nError: You (${callerAddress}) are not the pending admin (${pendingAdminAddress})`);
    process.exit(1);
  }
  
  const now = Math.floor(Date.now() / 1000);
  if (now < scheduleTimestamp) {
    console.error(`\nError: Transfer not yet ready. Wait until ${new Date(scheduleTimestamp * 1000).toISOString()}`);
    process.exit(1);
  }
  
  console.log('\nAccepting admin transfer...');
  
  const tx = await contract.acceptDefaultAdminTransfer().send(await config.writeOptions(tronWeb));
  
  console.log(`Transaction: ${config.getTxId(tx)}`);
  
  await config.waitForConfirmation();
  
  // Verify
  const newAdmin = await contract.defaultAdmin().call();
  const newAdminBase58 = tronWeb.address.fromHex(newAdmin);
  
  if (newAdminBase58 === callerAddress) {
    console.log('\nAdmin transfer completed successfully!');
    console.log(`New Default Admin: ${newAdminBase58}`);
  } else {
    console.error('\nWarning: Admin transfer may have failed. Please verify.');
  }
}

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
