#!/usr/bin/env node

/**
 * Begin Admin Transfer Script
 * 
 * Initiates transfer of DEFAULT_ADMIN_ROLE to a new admin.
 * The new admin must call accept-admin-transfer to complete.
 * Requires DEFAULT_ADMIN_ROLE.
 * 
 * Usage: node scripts/admin/access-control/begin-admin-transfer.js <network> <contract> <new-admin>
 * 
 * Arguments:
 *   network   - 'mainnet' or 'shasta'
 *   contract  - 'escrow' or 'fulfillment-proxy'
 *   new-admin - Tron address of the new admin
 * 
 * Example:
 *   node scripts/admin/access-control/begin-admin-transfer.js shasta escrow TNewAdmin...
 */

const config = require('../../config');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 3) {
    console.error('Usage: node begin-admin-transfer.js <network> <contract> <new-admin>');
    console.error('  network: mainnet | shasta');
    console.error('  contract: escrow | fulfillment-proxy');
    console.error('  new-admin: Tron address (T...)');
    process.exit(1);
  }
  
  const [network, contractName, newAdmin] = args;
  
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
  
  // Validate address format
  if (!newAdmin.startsWith('T') || newAdmin.length < 34) {
    console.error('Invalid new admin address format');
    process.exit(1);
  }
  
  console.log('=== Begin Admin Transfer ===\n');
  console.log(`Network: ${validNetwork.toUpperCase()}`);
  
  const tronWeb = config.initAdminTronWeb(validNetwork);
  const adminAddress = tronWeb.address.fromPrivateKey(process.env.ADMIN_PK);
  console.log(`Current Admin: ${adminAddress}`);
  
  const { escrow, fulfillmentProxy } = await config.getContracts(tronWeb, validNetwork);
  const contract = contractName === 'escrow' ? escrow : fulfillmentProxy;
  const addresses = config.getContractAddresses(validNetwork);
  const contractAddr = contractName === 'escrow' 
    ? addresses.ESCROW_ADDRESS 
    : addresses.FULFILLMENT_PROXY_ADDRESS;
  
  console.log(`Contract: ${contractName} (${contractAddr})`);
  console.log(`New Admin: ${newAdmin}`);
  
  // Check current default admin
  const currentAdmin = await contract.defaultAdmin().call();
  const currentAdminBase58 = tronWeb.address.fromHex(currentAdmin);
  console.log(`Current Default Admin: ${currentAdminBase58}`);
  
  if (currentAdminBase58 !== adminAddress) {
    console.error('\nError: You are not the current default admin');
    process.exit(1);
  }
  
  console.log('\nBeginning admin transfer...');
  
  const tx = await contract.beginDefaultAdminTransfer(newAdmin).send(await config.writeOptions(tronWeb));
  
  console.log(`Transaction: ${config.getTxId(tx)}`);
  
  await config.waitForConfirmation();
  
  // Get pending admin info
  const pendingAdmin = await contract.pendingDefaultAdmin().call();
  console.log('\nAdmin transfer initiated!');
  console.log(`Pending Admin: ${tronWeb.address.fromHex(pendingAdmin[0])}`);
  console.log(`Transfer Schedule: ${new Date(Number(pendingAdmin[1]) * 1000).toISOString()}`);
  console.log('\nThe new admin must call accept-admin-transfer.js to complete the transfer.');
}

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
