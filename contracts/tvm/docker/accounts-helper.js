/**
 * Helper module to read and provide test accounts from accounts.json
 * This provides a single source of truth for all test accounts used in migrations and scripts
 */

const fs = require('fs');
const path = require('path');

// Load accounts from accounts.json
function loadAccounts() {
    const accountsPath = path.join(__dirname, 'accounts.json');
    const accountsData = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
    return accountsData;
}

// Get test accounts (excluding deployer at index 0)
function getTestAccounts(tronWeb = null) {
    const accountsData = loadAccounts();
    const testAccounts = [];
    
    // Skip index 0 (deployer account)
    for (let i = 1; i < accountsData.privateKeys.length; i++) {
        const privateKey = accountsData.privateKeys[i];
        let address;
        
        if (tronWeb) {
            // Generate address from private key using provided TronWeb instance
            address = tronWeb.address.fromPrivateKey(privateKey);
        } else {
            // Use pre-calculated addresses (these are deterministic based on the private keys)
            // These addresses match what TronWeb.address.fromPrivateKey() generates
            const preCalculatedAddresses = [
                'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC', // Deployer (index 0)
                'TCLBgkbfVkJroVBJVqBEsxtPNQEQMTQCLQ', // Test Account 1
                'TBvJUBXorwBPzqvV38vjDgegj5Eh6g2Tsq', // Test Account 2
                'TJRabPrwbZy45sbavfcjinPJC18kjpRTv8', // Test Account 3
                'TLfuw4tRywtxCusvTudbjf7PbcXjfe7qrw', // Test Account 4
                'TWa5cxQFesyCQUm17usvHrVkKce6rMCV4H', // Test Account 5
                'TVwvLcXD1WTK2gegh7tZ5Fxocfo8GttHgL', // Test Account 6
                'TRsbuxREXKJKonexpejWhacE4sYHt1BSHV', // Test Account 7
                'TJzXt1sZautjqXnpjQT4xSCBHNSYgBkDr3', // Test Account 8
                'TBCtDueBN3LeyrJA8bKWetb5s3JfePK19X'  // Test Account 9
            ];
            address = preCalculatedAddresses[i];
        }
        
        testAccounts.push({
            privateKey: privateKey,
            address: address,
            name: `Test Account ${i}`,
            description: `Test Account ${i}`
        });
    }
    
    return testAccounts;
}

// Get deployer account (index 0)
function getDeployerAccount(tronWeb = null) {
    const accountsData = loadAccounts();
    const privateKey = accountsData.privateKeys[0];
    let address;
    
    if (tronWeb) {
        address = tronWeb.address.fromPrivateKey(privateKey);
    } else {
        address = 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC';
    }
    
    return {
        privateKey: privateKey,
        address: address,
        name: 'Deployer Account',
        description: 'Main deployer account'
    };
}

// Get all accounts including deployer
function getAllAccounts(tronWeb = null) {
    const deployer = getDeployerAccount(tronWeb);
    const testAccounts = getTestAccounts(tronWeb);
    return [deployer, ...testAccounts];
}

module.exports = {
    loadAccounts,
    getTestAccounts,
    getDeployerAccount,
    getAllAccounts
};