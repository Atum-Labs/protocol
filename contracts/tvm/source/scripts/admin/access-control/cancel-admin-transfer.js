#!/usr/bin/env node

/**
 * Cancel Admin Transfer Script
 * 
 * Cancels a pending admin transfer.
 * Requires DEFAULT_ADMIN_ROLE (current admin).
 * 
 * Usage: node scripts/admin/access-control/cancel-admin-transfer.js <network> <contract>
 * 
 * Arguments:
 *   network  - 'mainnet' or 'shasta'
 *   contract - 'escrow' or 'fulfillment-proxy'
 * 
 * Example:
 *   node scripts/admin/access-control/cancel-admin-transfer.js shasta escrow
 */

const config = require('../../config');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 2) {
    console.error('Usage: node cancel-admin-transfer.js <network> <contract>');
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
  
  console.log('=== Cancel Admin Transfer ===\n');
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
  
  // Check pending admin
  const pendingAdmin = await contract.pendingDefaultAdmin().call();
  const pendingAdminAddress = tronWeb.address.fromHex(pendingAdmin[0]);
  
  console.log(`Pending Admin: ${pendingAdminAddress}`);
  
  if (pendingAdminAddress === 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb') { // Zero address
    console.log('\nNo pending admin transfer to cancel.');
    return;
  }
  
  console.log('\nCancelling admin transfer...');
  
  const tx = await contract.cancelDefaultAdminTransfer().send(await config.writeOptions(tronWeb));
  
  console.log(`Transaction: ${config.getTxId(tx)}`);
  
  await config.waitForConfirmation();
  
  // Verify
  const newPendingAdmin = await contract.pendingDefaultAdmin().call();
  const newPendingAdminAddress = tronWeb.address.fromHex(newPendingAdmin[0]);
  
  if (newPendingAdminAddress === 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb') { // Zero address
    console.log('\nAdmin transfer cancelled successfully!');
  } else {
    console.error('\nWarning: Cancellation may have failed. Please verify.');
  }
}

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
