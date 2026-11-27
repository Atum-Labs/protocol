#!/usr/bin/env node

/**
 * Grant Role Script
 * 
 * Grants a role to an account on Escrow or FulfillmentProxy contract.
 * Requires DEFAULT_ADMIN_ROLE.
 * 
 * Usage: node scripts/admin/access-control/grant-role.js <network> <contract> <role> <account>
 * 
 * Arguments:
 *   network  - 'mainnet' or 'shasta'
 *   contract - 'escrow' or 'fulfillment-proxy'
 *   role     - 'PAUSER_ROLE', 'TREASURER_ROLE', 'TOKEN_CONFIG_ROLE', or bytes32 hash
 *   account  - Tron address to grant role to
 * 
 * Example:
 *   node scripts/admin/access-control/grant-role.js shasta escrow PAUSER_ROLE TAddress...
 */

const config = require('../../config');

// Role name to hash mapping (will be fetched from contract)
const ROLE_NAMES = ['PAUSER_ROLE', 'TREASURER_ROLE', 'TOKEN_CONFIG_ROLE'];

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length !== 4) {
    console.error('Usage: node grant-role.js <network> <contract> <role> <account>');
    console.error('  network: mainnet | shasta');
    console.error('  contract: escrow | fulfillment-proxy');
    console.error('  role: PAUSER_ROLE | TREASURER_ROLE | TOKEN_CONFIG_ROLE | bytes32');
    console.error('  account: Tron address (T...)');
    process.exit(1);
  }
  
  const [network, contractName, roleName, account] = args;
  
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
  
  // Validate account format
  if (!account.startsWith('T') || account.length < 34) {
    console.error('Invalid account address format');
    process.exit(1);
  }
  
  console.log('=== Grant Role ===\n');
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
  
  // Resolve role hash
  let roleHash;
  if (roleName.startsWith('0x') && roleName.length === 66) {
    roleHash = roleName;
  } else if (ROLE_NAMES.includes(roleName)) {
    roleHash = await contract[roleName]().call();
  } else {
    console.error(`Invalid role: ${roleName}`);
    console.error('Use one of: PAUSER_ROLE, TREASURER_ROLE, TOKEN_CONFIG_ROLE, or a bytes32 hash');
    process.exit(1);
  }
  
  console.log(`Role: ${roleName}`);
  console.log(`Role Hash: ${roleHash}`);
  console.log(`Account: ${account}`);
  
  // Check if account already has role
  const hasRoleResult = await contract.hasRole(roleHash, account).call();
  const hasRole = hasRoleResult[0] ?? hasRoleResult;
  if (hasRole) {
    console.log('\nAccount already has this role. No action needed.');
    return;
  }
  
  console.log('\nGranting role...');
  
  const tx = await contract.grantRole(roleHash, account).send(await config.writeOptions(tronWeb));
  
  console.log(`Transaction: ${config.getTxId(tx)}`);
  
  await config.waitForConfirmation();
  
  // Verify
  const hasRoleAfterResult = await contract.hasRole(roleHash, account).call();
  const hasRoleAfter = hasRoleAfterResult[0] ?? hasRoleAfterResult;
  if (hasRoleAfter) {
    console.log('\nRole granted successfully!');
  } else {
    console.error('\nWarning: Role grant may have failed. Please verify.');
  }
}

main().catch((error) => {
  console.error('\nError:', error.message);
  process.exit(1);
});
