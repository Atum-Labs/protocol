/**
 * Script to save deployed contract addresses
 * Used by TronBox exec command
 */

const FulfillmentProxy = artifacts.require('FulfillmentProxy');
const MockERC20 = artifacts.require('MockERC20');
const fs = require('fs');
const path = require('path');

module.exports = async function(callback) {
    try {
        console.log('Retrieving deployed contract addresses...');
        
        // Get deployed contracts
        const fulfillmentProxy = await FulfillmentProxy.deployed();
        const mockToken = await MockERC20.deployed();
        
        // Prepare addresses object
        const addresses = {
            FulfillmentProxy: fulfillmentProxy.address,
            MockERC20: mockToken.address,
            // Add base58 versions for Tron compatibility
            FulfillmentProxy_base58: tronWeb.address.fromHex(fulfillmentProxy.address),
            MockERC20_base58: tronWeb.address.fromHex(mockToken.address)
        };
        
        // Output directory
        const outputDir = '/var/www/deploymentAddresses';
        
        // Ensure directory exists
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
        
        // Save as JSON
        const jsonPath = path.join(outputDir, 'addresses.json');
        fs.writeFileSync(jsonPath, JSON.stringify(addresses, null, 2));
        console.log(`Addresses saved to ${jsonPath}`);
        
        // Also save individual files for compatibility
        Object.entries(addresses).forEach(([name, address]) => {
            const filePath = path.join(outputDir, name);
            fs.writeFileSync(filePath, address);
            console.log(`Saved ${name}: ${address}`);
        });
        
        // Output to console as well
        console.log('\nDeployed Contract Addresses:');
        console.log('============================');
        console.log(`FulfillmentProxy: ${addresses.FulfillmentProxy}`);
        console.log(`FulfillmentProxy (base58): ${addresses.FulfillmentProxy_base58}`);
        console.log(`MockERC20: ${addresses.MockERC20}`);
        console.log(`MockERC20 (base58): ${addresses.MockERC20_base58}`);
        
        callback();
    } catch (error) {
        console.error('Error saving addresses:', error);
        callback(error);
    }
};