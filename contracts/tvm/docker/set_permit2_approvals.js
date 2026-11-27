const tronweb = require('tronweb');
const TronWeb = tronweb.TronWeb || tronweb;
const fs = require('fs');
const accountsHelper = require('./accounts-helper');

// Configuration
const FULL_HOST = 'http://127.0.0.1:9090';
const MAX_ALLOWANCE = '115792089237316195423570985008687907853269984665640564039457584007913129639935'; // 2^256 - 1

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function setApprovals() {
    try {
        console.log('🔐 Setting up Permit2 approvals for all test accounts...\n');
        
        // Read contract addresses
        const mockERC20Address = fs.readFileSync('/var/www/deploymentAddresses/MockERC20', 'utf8').trim();
        const permit2Address = fs.readFileSync('/var/www/deploymentAddresses/Permit2', 'utf8').trim();
        
        console.log(`MockERC20 address: ${mockERC20Address}`);
        console.log(`Permit2 address: ${permit2Address}\n`);
        
        // Get test accounts from accounts-helper
        const testAccounts = accountsHelper.getTestAccounts();
        
        // Process each test account
        for (const account of testAccounts) {
            try {
                console.log(`\nProcessing ${account.name}...`);
                
                // Create TronWeb instance for this account
                const tronWeb = new TronWeb({
                    fullHost: FULL_HOST,
                    privateKey: account.privateKey
                });
                
                // Get account address
                const accountAddress = tronWeb.address.fromPrivateKey(account.privateKey);
                console.log(`  Address: ${accountAddress}`);
                
                // Get the MockERC20 contract instance
                const mockERC20 = await tronWeb.contract().at(mockERC20Address);
                
                // Wait for tokens to be minted (up to 30 seconds)
                let balance = 0;
                for (let i = 0; i < 30; i++) {
                    try {
                        balance = await mockERC20.balanceOf(accountAddress).call();
                        const balanceNum = parseInt(balance.toString());
                        
                        if (balanceNum > 0) {
                            console.log(`  Current balance: ${balance.toString()}`);
                            break;
                        }
                        
                        if (i === 0) {
                            console.log(`  ⏳ Waiting for tokens to be minted...`);
                        } else if (i % 5 === 0) {
                            console.log(`  ⏳ Still waiting... (${i}/30)`);
                        }
                        
                        await sleep(1000);
                    } catch (error) {
                        // Contract might not be ready yet
                        await sleep(1000);
                    }
                }
                
                if (balance.toString() === '0') {
                    console.log(`  ⚠️  Warning: Account has no tokens after waiting, skipping approval`);
                    continue;
                }
                
                // Check current allowance
                const currentAllowance = await mockERC20.allowance(accountAddress, permit2Address).call();
                console.log(`  Current allowance: ${currentAllowance.toString()}`);
                
                if (currentAllowance.toString() === MAX_ALLOWANCE) {
                    console.log(`  ✅ Already has max approval, skipping`);
                    continue;
                }
                
                // Set approval
                console.log(`  Setting approval for Permit2...`);
                const tx = await mockERC20.approve(permit2Address, MAX_ALLOWANCE).send({
                    feeLimit: 100000000,
                    callValue: 0,
                    shouldPollResponse: true
                });
                
                if (tx) {
                    console.log(`  ✅ Approval transaction successful!`);
                    
                    // Wait a bit for the transaction to be processed
                    await sleep(1000);
                    
                    // Verify the new allowance
                    const newAllowance = await mockERC20.allowance(accountAddress, permit2Address).call();
                    if (newAllowance.toString() === MAX_ALLOWANCE) {
                        console.log(`  ✅ Allowance verified: MAX (2^256-1)`);
                    } else {
                        console.log(`  ⚠️  Allowance set but unexpected value: ${newAllowance.toString()}`);
                    }
                } else {
                    console.log(`  ❌ Approval transaction failed`);
                }
                
            } catch (error) {
                console.error(`  ❌ Error processing ${account.name}:`, error.message);
            }
        }
        
        console.log('\n✅ Permit2 approval setup complete!\n');
        
        // Summary
        console.log('=== SUMMARY ===');
        for (const account of testAccounts) {
            try {
                const tronWeb = new TronWeb({
                    fullHost: FULL_HOST,
                    privateKey: account.privateKey
                });
                
                const accountAddress = tronWeb.address.fromPrivateKey(account.privateKey);
                const mockERC20 = await tronWeb.contract().at(mockERC20Address);
                const allowance = await mockERC20.allowance(accountAddress, permit2Address).call();
                
                if (allowance.toString() === MAX_ALLOWANCE) {
                    console.log(`✅ ${account.name}: MAX approval set`);
                } else if (allowance.toString() === '0') {
                    console.log(`❌ ${account.name}: No approval`);
                } else {
                    console.log(`⚠️  ${account.name}: Partial approval (${allowance.toString()})`);
                }
            } catch (error) {
                console.log(`❌ ${account.name}: Error checking approval`);
            }
        }
        
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Run the script
setApprovals().then(() => {
    console.log('\nScript completed successfully');
    process.exit(0);
}).catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
});