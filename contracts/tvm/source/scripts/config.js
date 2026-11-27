const { TronWeb } = require('tronweb');

// Per-network configuration
const NETWORKS = {
  shasta: {
    api: 'https://api.shasta.trongrid.io',
    contracts: {
      ESCROW_ADDRESS: 'TNW6knfy7gD5W8meUAj9cdqpjFZVHN4vUw',
      FULFILLMENT_PROXY_ADDRESS: 'TH88i2DKyLwjtH8hMzXTqSzGLr7U6eprbZ',
      PERMIT2_ADDRESS: 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp',
      USDT_ADDRESS: 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs'
    }
  },
  mainnet: {
    api: process.env.TRON_RPC_URL || 'https://api.trongrid.io',
    contracts: {
      ESCROW_ADDRESS: 'TYj48kPL31aMpJfm2LKi96e9hEfVKGmv5Y',
      FULFILLMENT_PROXY_ADDRESS: 'TB32KsTZ9WKozgfgKtDVaJLu7f49qS88yo',
      PERMIT2_ADDRESS: 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m',
      USDT_ADDRESS: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
    }
  }
};

// Common settings
const SETTINGS = {
  FEE_LIMIT: 100_000_000, // 100 TRX
  SHOULD_POLL_RESPONSE: false // Return txID immediately (scripts verify state after)
};

// Default values
const DEFAULTS = {
  DEPOSIT_ID: '',
  DEPOSITOR_ADDRESS: 'TR6y9bCmyGBvb3ALZSwVJkw8YThbwmFX8N',
  DEPOSIT_AMOUNT: '100000000', // 100 USDT (6 decimals)
  USDT_DECIMALS: 6,
  DEADLINE_DURATION: 3600, // 1 hour in seconds
  DUMMY_PRIVATE_KEY: '0000000000000000000000000000000000000000000000000000000000000001',
  ZERO_ADDRESS_HEX: '410000000000000000000000000000000000000000',
  UINT256_MAX: '115792089237316195423570985008687907853269984665640564039457584007913129639935',
  UINT128_MAX: '340282366920938463463374607431768211455'
};

// Contract ABIs
const ABIS = {
  Escrow: require('../generated/abi/Escrow.json'),
  FulfillmentProxy: require('../generated/abi/FulfillmentProxy.json'),
  IERC20: require('../generated/abi/IERC20.json'),
  Permit2: require('@alexroan/permit2-tron/build/contracts/Permit2.json').abi
};

// Validate network name and return normalized name
function validateNetwork(network) {
  const normalized = network.toLowerCase();
  if (!NETWORKS[normalized]) {
    const validNetworks = Object.keys(NETWORKS).join(', ');
    throw new Error(`Invalid network: ${network}. Valid networks: ${validNetworks}`);
  }
  return normalized;
}

// Get network configuration
function getNetworkConfig(network) {
  const normalized = validateNetwork(network);
  return NETWORKS[normalized];
}

// TronGrid throttles anonymous requests to a few per second, and every admin
// operation here makes several reads. tronbox-config.js has always sent the key as
// a TRON-PRO-API-KEY header; this module never did, so scripts/admin/** and
// inspect-escrow.js ran unauthenticated and surfaced the throttle as an axios
// "Request failed with status code 429" stack trace with no hint that a key exists.
function apiHeaders() {
  return process.env.TRON_API_KEY
    ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY }
    : undefined;
}

// Helper to initialize TronWeb with depositor private key from env
function initTronWeb(network) {
  // Load environment variables
  try {
    require('dotenv').config();
  } catch (e) {
    // dotenv not installed, read from process.env directly
  }

  if (!process.env.DEPOSITOR_PK) {
    throw new Error('DEPOSITOR_PK not found in .env file');
  }

  const networkConfig = getNetworkConfig(network);

  return new TronWeb({
    fullHost: networkConfig.api,
    privateKey: process.env.DEPOSITOR_PK,
    headers: apiHeaders()
  });
}

// ---------------------------------------------------------------------------
// Multisig-owned admin accounts: signing against an ACTIVE permission
// ---------------------------------------------------------------------------
// When the admin account's OWNER permission has threshold > 1, a single
// signature against it is rejected -- but Tron lets an account delegate
// operations to an "active permission" with its own threshold and its own
// operations allowlist. Signing against one requires stamping Permission_id on
// the transaction; TronWeb accepts `permissionId` in the options object of a
// contract call and threads it through to raw_data.contract[0].Permission_id.
//
// Set TRON_PERMISSION_ID to switch every admin script onto that path. When it
// is UNSET nothing below runs -- no network calls, no option added, and
// TronWeb's own `if (options.permissionId)` never fires -- so the transaction
// produced is byte-identical to the one produced before this existed.
const PERMISSION_ENV = 'TRON_PERMISSION_ID';

// Tron numbers each contract type; the permission's `operations` field is a
// 32-byte hex bitmap where type N occupies bit N%8 of byte N/8. Writing a
// contract call is TriggerSmartContract = 31, which is a DIFFERENT bit from
// CreateSmartContract = 30: a permission that can deploy cannot necessarily
// call, and vice versa. Checking the wrong one passes and then fails on chain.
const OP_TRIGGER_SMART_CONTRACT = 31;

function hasOperation(operationsHex, opIndex) {
  if (typeof operationsHex !== 'string' || !/^[0-9a-fA-F]*$/.test(operationsHex)) {
    throw new Error(`permission operations field is not hex: ${JSON.stringify(operationsHex)}`);
  }
  const bytes = Buffer.from(operationsHex, 'hex');
  const byteIndex = Math.floor(opIndex / 8);
  if (byteIndex >= bytes.length) return false;
  return ((bytes[byteIndex] >> (opIndex % 8)) & 1) === 1;
}

// wallet/getaccount returns permission keys as 41-prefixed HEX, while everything
// an operator types and everything tronWeb.address.fromPrivateKey returns is
// base58. Comparing the two directly is always false, which reads as "this key
// is not on the permission" for an account where it plainly is -- so normalise
// before comparing rather than trusting either side's encoding.
function normaliseTronAddress(tronWeb, value) {
  if (typeof value !== 'string' || value === '') return '';
  if (/^41[0-9a-fA-F]{40}$/.test(value)) return tronWeb.address.fromHex(value);
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return tronWeb.address.fromHex('41' + value.slice(2));
  return value;
}

function sameTronAddress(tronWeb, a, b) {
  const na = normaliseTronAddress(tronWeb, a);
  const nb = normaliseTronAddress(tronWeb, b);
  return na !== '' && na === nb;
}

function resolvePermissionId() {
  const raw = process.env[PERMISSION_ENV];
  if (raw === undefined || raw === '') return undefined;
  const trimmed = String(raw).trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `${PERMISSION_ENV}="${raw}" is not a non-negative integer. Active permission ids start at 2; ` +
      `read them with: curl -s -X POST <api>/wallet/getaccount -d '{"address":"T...","visible":true}'`
    );
  }
  const id = parseInt(trimmed, 10);
  // 0 is the OWNER permission, which is already what an unset variable selects.
  // Accepting it would let an operator believe they had switched to an active
  // permission when they had not -- the exact failure this plumbing exists to
  // prevent -- so refuse it and say what to do instead.
  if (id === 0) {
    throw new Error(
      `${PERMISSION_ENV}=0 is the OWNER permission, which is already the default. ` +
      `Unset ${PERMISSION_ENV} to sign against the owner permission, or set it to an ` +
      `active permission id (these start at 2).`
    );
  }
  if (id === 1) {
    throw new Error(
      `${PERMISSION_ENV}=1 is the witness permission, which cannot call contracts. ` +
      `Active permission ids start at 2.`
    );
  }
  return id;
}

// Re-reading the account for every transaction in a loop is wasteful, so the
// result is remembered -- but per TronWeb INSTANCE, not per (address, id) in a
// module-level set. A process-wide cache keyed on the address would let one
// verified signer suppress the check for a differently-configured TronWeb that
// happens to share it, and it makes the failure branches unreachable in a test
// once any success has been recorded.
const permissionChecked = new WeakMap();

// Fails loudly and specifically when the named permission cannot actually
// authorise a contract call, instead of letting the node reject the broadcast
// with an opaque SIGERROR after the operator has already committed.
async function assertPermissionCanWrite(tronWeb, permissionId, signerAddress) {
  const address = signerAddress || tronWeb.defaultAddress.base58;
  if (!address) throw new Error('cannot determine the signing address to check its permissions');

  const account = await tronWeb.trx.getAccount(address);
  if (!account || !account.address) {
    throw new Error(
      `account ${address} does not exist on chain, so it has no permissions to sign with. ` +
      `An account is only created once it has received funds.`
    );
  }

  const active = account.active_permission || [];
  const perm = active.find((p) => Number(p.id) === Number(permissionId));
  if (!perm) {
    const ids = active.map((p) => p.id).join(', ') || '(none)';
    throw new Error(
      `${address} has no active permission with id ${permissionId}. Active ids present: ${ids}.`
    );
  }

  if (!hasOperation(perm.operations, OP_TRIGGER_SMART_CONTRACT)) {
    throw new Error(
      `active permission ${permissionId} on ${address} does not include ` +
      `TriggerSmartContract (operation ${OP_TRIGGER_SMART_CONTRACT}), so it cannot call a ` +
      `contract however many signatures it collects. Note that being able to DEPLOY ` +
      `(CreateSmartContract, operation 30) is a separate bit and does not imply this one.`
    );
  }

  // The signer must be a listed key, and its own weight must reach the
  // threshold -- otherwise one signature is not enough and this path needs a
  // co-signing ceremony rather than a single key.
  const keys = perm.keys || [];
  const mine = keys.find((k) => sameTronAddress(tronWeb, k.address, address));
  if (!mine) {
    const shown = keys
      .map((k) => normaliseTronAddress(tronWeb, k.address) || k.address)
      .join(', ') || 'none';
    throw new Error(
      `${address} is not among the keys of its own active permission ${permissionId} ` +
      `(keys: ${shown}), so it cannot sign against it.`
    );
  }
  const threshold = Number(perm.threshold);
  const weight = Number(mine.weight);
  if (!(weight >= threshold)) {
    throw new Error(
      `active permission ${permissionId} on ${address} has threshold ${threshold} but this key's ` +
      `weight is only ${weight}, so a single signature cannot satisfy it. ` +
      `${keys.length} key(s) are listed; this needs additional signers.`
    );
  }

  return { permissionId: Number(permissionId), threshold, weight, keys: keys.length };
}

// The options object for any admin transaction that WRITES. Await it at the
// send site: `.send(await config.writeOptions(tronWeb))`. In the default
// (owner-permission) mode this resolves immediately and touches no network.
async function writeOptions(tronWeb, extra = {}) {
  const opts = {
    feeLimit: SETTINGS.FEE_LIMIT,
    shouldPollResponse: SETTINGS.SHOULD_POLL_RESPONSE,
    ...extra
  };

  const permissionId = resolvePermissionId();
  if (permissionId === undefined) return opts;

  if (!tronWeb) {
    throw new Error(
      `${PERMISSION_ENV} is set, so writeOptions needs the TronWeb instance to verify the ` +
      `permission before signing. Call it as: config.writeOptions(tronWeb)`
    );
  }

  const address = tronWeb.defaultAddress && tronWeb.defaultAddress.base58;
  const cacheKey = `${address}:${permissionId}`;
  let seen = permissionChecked.get(tronWeb);
  if (!seen) { seen = new Set(); permissionChecked.set(tronWeb, seen); }
  if (!seen.has(cacheKey)) {
    const info = await assertPermissionCanWrite(tronWeb, permissionId, address);
    // Say it out loud. Signing against a different permission than the operator
    // believes is the failure mode here, and it is invisible in the output
    // otherwise -- the transaction looks completely normal.
    console.log(
      `Signing against ACTIVE PERMISSION ${info.permissionId} of ${address} ` +
      `(threshold ${info.threshold}, this key's weight ${info.weight}, ${info.keys} key(s) listed)`
    );
    seen.add(cacheKey);
  }

  opts.permissionId = permissionId;
  return opts;
}

// Helper to initialize TronWeb with admin private key from env
function initAdminTronWeb(network) {
  // Load environment variables
  try {
    require('dotenv').config();
  } catch (e) {
    // dotenv not installed, read from process.env directly
  }

  if (!process.env.ADMIN_PK) {
    throw new Error('ADMIN_PK not found in .env file');
  }

  const networkConfig = getNetworkConfig(network);

  return new TronWeb({
    fullHost: networkConfig.api,
    privateKey: process.env.ADMIN_PK,
    headers: apiHeaders()
  });
}

// Helper to get contract instances for a network
async function getContracts(tronWeb, network) {
  const networkConfig = getNetworkConfig(network);
  const contracts = networkConfig.contracts;

  return {
    escrow: await tronWeb.contract(ABIS.Escrow, contracts.ESCROW_ADDRESS),
    fulfillmentProxy: await tronWeb.contract(ABIS.FulfillmentProxy, contracts.FULFILLMENT_PROXY_ADDRESS),
    usdt: await tronWeb.contract(ABIS.IERC20, contracts.USDT_ADDRESS),
    permit2: await tronWeb.contract(ABIS.Permit2, contracts.PERMIT2_ADDRESS)
  };
}

// Helper to get contract addresses for a network
function getContractAddresses(network) {
  const networkConfig = getNetworkConfig(network);
  return networkConfig.contracts;
}

// Helper to format USDT amount for display
function formatUSDT(amount) {
  return `${amount.toString()} (${Number(amount) / Math.pow(10, DEFAULTS.USDT_DECIMALS)} USDT)`;
}

// Helper to extract transaction ID from send() result
// TronWeb returns different formats depending on settings
function getTxId(txResult) {
  if (!txResult) return '(no transaction result)';
  if (typeof txResult === 'string') return txResult;
  if (txResult.txid) return txResult.txid;
  if (txResult.transaction && txResult.transaction.txID) return txResult.transaction.txID;
  if (txResult.txID) return txResult.txID;
  // Fallback: return stringified object
  return JSON.stringify(txResult);
}

// Helper to wait for transaction confirmation
// Tron has ~3 second block times, so 5 seconds is usually enough
async function waitForConfirmation(ms = 5000) {
  console.log(`Waiting ${ms/1000}s for confirmation...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  NETWORKS,
  SETTINGS,
  DEFAULTS,
  ABIS,
  validateNetwork,
  getNetworkConfig,
  initTronWeb,
  initAdminTronWeb,
  getContracts,
  getContractAddresses,
  formatUSDT,
  getTxId,
  waitForConfirmation,
  // multisig / active-permission signing
  PERMISSION_ENV,
  OP_TRIGGER_SMART_CONTRACT,
  hasOperation,
  apiHeaders,
  normaliseTronAddress,
  sameTronAddress,
  resolvePermissionId,
  assertPermissionCanWrite,
  writeOptions
};
