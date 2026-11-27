const { TronWeb } = require('tronweb');

// The node the migrations deploy to (TRON_LOCAL_RPC_URL, else 127.0.0.1:9090), so the helpers
// never talk to a different one.
const NODE_URL = require('../tronbox-config').networks.development.fullHost;

// Polyfill for fetch in Node.js
if (typeof fetch === 'undefined') {
  global.fetch = async (url) => {
    const https = require('https');
    const http = require('http');
    const { URL } = require('url');

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const req = client.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({
            text: async () => data,
            json: async () => JSON.parse(data),
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode
          });
        });
      });

      req.on('error', reject);
    });
  };
}

// Fetch accounts from TRE container - this is the ONLY source of accounts
const fetchAccountsFromContainer = async () => {
  try {
    const response = await fetch(`${NODE_URL}/admin/accounts?format=all`);

    if (!response.ok) {
      throw new Error(`TRE container API returned status ${response.status}`);
    }

    const text = await response.text();

    // Parse the response to extract accounts
    const accounts = {};
    const lines = text.split('\n');

    // Extract base58 addresses and balances
    const addressMatches = [];
    const privateKeyMatches = [];

    // TWO LAYOUTS ARE ACCEPTED, because the two TRE images in use print differently and only one
    // of them was handled before:
    //
    //   single line (herryxcodes/blockchain-nodes-x86):
    //     (0) TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC (98999909498.81531 TRX)
    //
    //   two lines (tronbox/tre, the image tronbox-config.js documents, and the only one with a
    //   native arm64 build — the x86 image is unusable under emulation on Apple Silicon):
    //     (0) TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC
    //         417e5f4552091a69125d5dfcb7b8c2659029395bdf (98999999104.24276 TRX)
    //
    // The old regex anchored the balance to the same line as the base58 address, so against
    // tronbox/tre it matched nothing and every run died with "Expected 3 accounts but got
    // incomplete data". Parsing the index line and the balance separately handles both.
    let pendingIndex = null;
    for (const line of lines) {
      // "(N) <base58>" with the balance either on this line or the next.
      const indexed = line.match(/^\((\d+)\)\s+(T[A-Za-z0-9]{25,})\s*(?:\(([\d,.]+)\s+TRX\))?\s*$/);
      if (indexed) {
        const [, index, address, inlineBalance] = indexed;
        const i = parseInt(index);
        addressMatches[i] = {
          address,
          balance: inlineBalance ? parseFloat(inlineBalance.replace(/,/g, '')) : null
        };
        // Only await a continuation line when the balance was not already on this one.
        pendingIndex = inlineBalance ? null : i;
        continue;
      }

      // Continuation line of the two-line layout: "    <hex41...> (<balance> TRX)".
      if (pendingIndex !== null) {
        const continued = line.match(/^\s+(?:41[0-9a-fA-F]{40})?\s*\(([\d,.]+)\s+TRX\)\s*$/);
        if (continued) {
          addressMatches[pendingIndex].balance = parseFloat(continued[1].replace(/,/g, ''));
          pendingIndex = null;
          continue;
        }
      }

      // Parse private keys (format: "(0) 0000000000000000000000000000000000000000000000000000000000000001")
      const keyMatch = line.match(/^\((\d+)\)\s+([0-9a-fA-F]{64})\s*$/);
      if (keyMatch) {
        const [, index, privateKey] = keyMatch;
        privateKeyMatches[parseInt(index)] = privateKey;
        pendingIndex = null;
      }
    }

    // Build account objects for first 3 accounts
    const accountNames = ['owner', 'second', 'third'];
    for (let i = 0; i < 3; i++) {
      if (!addressMatches[i] || !privateKeyMatches[i]) {
        throw new Error(`Failed to parse account ${i} from TRE container response. Expected 3 accounts but got incomplete data.`);
      }

      accounts[accountNames[i]] = {
        privateKey: privateKeyMatches[i],
        address: addressMatches[i].address,
        balance: addressMatches[i].balance
      };
    }

    // Add zero address
    accounts.zeroAddress = '410000000000000000000000000000000000000000';

    console.log('Successfully fetched accounts from TRE container:');
    console.log(`Owner: ${accounts.owner.address} (${accounts.owner.balance} TRX)`);
    console.log(`Second: ${accounts.second.address} (${accounts.second.balance} TRX)`);
    console.log(`Third: ${accounts.third.address} (${accounts.third.balance} TRX)`);

    return accounts;
  } catch (error) {
    console.error('FATAL: Failed to fetch accounts from TRE container:', error.message);
    console.error(`Make sure the TRE container is running at ${NODE_URL}`);
    console.error('Tests cannot continue without dynamic accounts from the container.');
    throw new Error(`Cannot fetch dynamic accounts from TRE container: ${error.message}`);
  }
};

// Network configuration
const NETWORK_CONFIG = {
  fullHost: NODE_URL,
  userFeePercentage: 0,
  feeLimit: 1000 * 1e6,
  network_id: '9'
};

// Initialize accounts as null - they MUST be fetched dynamically
let testAccounts = null;

// TronWeb instances - will be created during setupAccounts()
let tronWebInstances = {
  owner: null,
  second: null,
  third: null
};

// Helper to convert hex address to base58
const toBase58 = (hexAddress) => {
  if (!hexAddress) {return null;}
  // Check if already in base58 format (starts with T)
  if (typeof hexAddress === 'string' && hexAddress.startsWith('T')) {
    return hexAddress;
  }

  if (!tronWebInstances.owner) {
    throw new Error('TronWeb instances not initialized. Call setupAccounts() first.');
  }

  return tronWebInstances.owner.address.fromHex(hexAddress.startsWith('0x') ? hexAddress.slice(2) : hexAddress);
};

// Fund account if balance is below minimum threshold
const fundAccountIfNeeded = async (targetAddress, minBalance = 50000000, fundAmount = 200000000) => {
  if (!tronWebInstances.owner) {
    throw new Error('TronWeb instances not initialized. Call setupAccounts() first.');
  }

  try {
    const balance = await tronWebInstances.owner.trx.getBalance(targetAddress);

    if (balance < minBalance) {
      console.log(`Funding account ${targetAddress} with ${fundAmount / 1e6} TRX`);
      await tronWebInstances.owner.trx.sendTransaction(targetAddress, fundAmount);

      // Verify the transfer
      const newBalance = await tronWebInstances.owner.trx.getBalance(targetAddress);
      console.log(`Account ${targetAddress} new balance: ${newBalance / 1e6} TRX`);
      return true;
    }

    console.log(`Account ${targetAddress} already funded: ${balance / 1e6} TRX`);
    return false;
  } catch (error) {
    console.error(`Failed to fund account ${targetAddress}:`, error.message);
    throw error;
  }
};

// Setup all accounts (fetch dynamic accounts and fund them if needed)
const setupAccounts = async () => {
  console.log('Setting up test accounts...');

  // Fetch dynamic accounts from TRE container - this will throw if it fails
  testAccounts = await fetchAccountsFromContainer();

  // Create TronWeb instances with dynamic accounts
  tronWebInstances.owner = new TronWeb({
    ...NETWORK_CONFIG,
    privateKey: testAccounts.owner.privateKey
  });

  tronWebInstances.second = new TronWeb({
    ...NETWORK_CONFIG,
    privateKey: testAccounts.second.privateKey
  });

  tronWebInstances.third = new TronWeb({
    ...NETWORK_CONFIG,
    privateKey: testAccounts.third.privateKey
  });

  // Check owner balance first
  const ownerBalance = await tronWebInstances.owner.trx.getBalance(testAccounts.owner.address);
  console.log(`Owner balance: ${ownerBalance / 1e6} TRX`);

  if (ownerBalance === 0) {
    throw new Error('Owner account has no TRX! Make sure the Tron node is running and owner account is funded.');
  }

  // Fund other accounts if needed
  await fundAccountIfNeeded(testAccounts.second.address);
  await fundAccountIfNeeded(testAccounts.third.address);

  console.log('Account setup complete!');
};

// Get account info
const getAccountInfo = async (accountName) => {
  if (!testAccounts) {
    throw new Error('Accounts not initialized. Call setupAccounts() first.');
  }

  const account = testAccounts[accountName];
  if (!account) {
    throw new Error(`Account '${accountName}' not found`);
  }

  if (!tronWebInstances.owner) {
    throw new Error('TronWeb instances not initialized. Call setupAccounts() first.');
  }

  const balance = await tronWebInstances.owner.trx.getBalance(account.address);
  return {
    name: accountName,
    address: account.address,
    privateKey: account.privateKey,
    balance: balance,
    balanceTRX: balance / 1e6
  };
};

// Get all account info
const getAllAccountInfo = async () => {
  const accounts = ['owner', 'second', 'third'];
  const info = {};

  for (const accountName of accounts) {
    info[accountName] = await getAccountInfo(accountName);
  }

  return info;
};

// Helper to create TronWeb contract instance from deployed artifact
/**
 * Get a per-signer handle on a deployed contract.
 *
 * `addressOverride` lets a test bind to an instance it deployed itself rather than the one the
 * migration deployed. Tests that mutate contract-wide state (an admin transfer, say) otherwise
 * have to undo their own changes afterwards, because every spec in the file shares the single
 * migration-deployed instance — and a restore step that misses a case leaks into unrelated tests.
 */
const getTronWebInstance = async (artifact, signer = 'owner', addressOverride = null) => {
  if (!testAccounts || !tronWebInstances[signer]) {
    throw new Error('Accounts not initialized. Call setupAccounts() first.');
  }

  const deployedAddress = addressOverride || artifact.address;
  if (!deployedAddress) {
    throw new Error(`Contract ${artifact.contractName} not deployed`);
  }

  const tronWebInstance = tronWebInstances[signer];
  return tronWebInstance.contract(artifact.abi, deployedAddress);
};

// Helper for expecting reverts with shouldPollResponse
const expectRevert = async (asyncFn, expectedError = null) => {
  try {
    await asyncFn();
    assert.fail(`Expected transaction to revert${expectedError ? ` with "${expectedError}"` : ''}`);
  } catch (error) {
    if (error.message.includes('Expected transaction to revert')) {
      throw error; // Re-throw our own assertion
    }

    if (expectedError) {
      const errorMessage = error.message || error.error || '';
      assert(
        errorMessage.includes(expectedError),
        `Expected error containing "${expectedError}" but got: ${errorMessage}`
      );
    }
    // If no expected error specified, any revert is success
  }
};

module.exports = {
  // TronWeb instances
  tronWebInstances,

  // Account data (will be null until setupAccounts() is called)
  get accounts() {
    if (!testAccounts) {
      throw new Error('Accounts not initialized. Call setupAccounts() first.');
    }
    return testAccounts;
  },

  // Helper functions
  toBase58,
  setupAccounts,
  fundAccountIfNeeded,
  getAccountInfo,
  getAllAccountInfo,
  getTronWebInstance,
  expectRevert,

  // Convenience exports
  get ownerWeb() {
    if (!tronWebInstances.owner) {
      throw new Error('TronWeb instances not initialized. Call setupAccounts() first.');
    }
    return tronWebInstances.owner;
  },
  get secondWeb() {
    if (!tronWebInstances.second) {
      throw new Error('TronWeb instances not initialized. Call setupAccounts() first.');
    }
    return tronWebInstances.second;
  },
  get thirdWeb() {
    if (!tronWebInstances.third) {
      throw new Error('TronWeb instances not initialized. Call setupAccounts() first.');
    }
    return tronWebInstances.third;
  },

  // Legacy exports for backward compatibility (these will throw if accounts not initialized)
  get owner() {
    if (!testAccounts) {
      throw new Error('Accounts not initialized. Call setupAccounts() first.');
    }
    return testAccounts.owner.address;
  },
  get secondPrivateKey() {
    if (!testAccounts) {
      throw new Error('Accounts not initialized. Call setupAccounts() first.');
    }
    return testAccounts.second.privateKey;
  },
  get secondAccount() {
    if (!testAccounts) {
      throw new Error('Accounts not initialized. Call setupAccounts() first.');
    }
    return testAccounts.second.address;
  },
  get zeroAddress() {
    if (!testAccounts) {
      throw new Error('Accounts not initialized. Call setupAccounts() first.');
    }
    return testAccounts.zeroAddress;
  }
};
