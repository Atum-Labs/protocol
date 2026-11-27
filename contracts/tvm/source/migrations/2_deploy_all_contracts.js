const Escrow = artifacts.require('Escrow');
const FulfillmentProxy = artifacts.require('FulfillmentProxy');
const Permit2Extension = artifacts.require('Permit2Extension');
const MockERC20 = artifacts.require('MockERC20');
const TestToken = artifacts.require('TestToken');

module.exports = async function (deployer, network, accounts) {
  console.log('=====================================');
  console.log('Starting Escrow and FulfillmentProxy deployment');
  console.log('Network:', network);
  console.log('Deploying with account:', accounts);
  console.log('=====================================');

  try {
    // Deploy Escrow contract
    console.log('\n1. Deploying Escrow contract...');

    const shastaPermit2Address = 'TPUqJPASUn1zLvbLBgRZ5pBYrx7WSe5ahp';
    const shastaUsdtAddress = 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';
    const mainnetPermit2Address = 'TJhMXTHQHeQyMD7TcKQFqAePNgG4b31H9m';
    const mainnetUsdtAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

    let permit2Address;
    let usdtAddress

    if (network === 'shasta') {
      permit2Address = shastaPermit2Address;
      usdtAddress = shastaUsdtAddress;
    } else if (network === 'mainnet') {
      permit2Address = mainnetPermit2Address;
      usdtAddress = mainnetUsdtAddress;
    } else if (network === 'development') {
      // THE LOCAL TRE NODE HAS NO PERMIT2 AND NO USDT, so both are deployed here.
      //
      // This branch used to be `throw new Error('Invalid network')`, and that is why the entire
      // TronBox suite has never executed. `tronbox test` runs migrations first, this threw, tronbox
      // aborted before loading a single spec — AND STILL EXITED 0, so the CI step reported success
      // with zero tests run. test/*.js resolve their contracts through `artifact.address`, which is
      // populated by this migration, so without it they cannot run at all.
      //
      // Permit2Extension, TestToken and MockERC20 are the test doubles under contracts/test/;
      // Escrow.test.js resolves Escrow, Permit2Extension and MockERC20 through this migration.
      console.log('Local network: deploying Permit2Extension, TestToken and MockERC20 test doubles...');

      await deployer.deploy(Permit2Extension);
      const permit2 = await Permit2Extension.deployed();
      permit2Address = permit2.address;
      console.log('✓ Permit2Extension deployed at address:', permit2Address);

      // Stands in for USDT. Tron USDT returns false on success and reverts on failure, which the
      // Escrow handles specially; TestToken is a plain ERC20, so the tests that care about that
      // asymmetry assert it directly rather than relying on this deployment.
      //
      // 6 decimals like the real token: allowToken reads the token's own decimals() and rejects a
      // mismatch, and deploy:local allows it at 6, the decimals the settler's e2e assumes for Tron
      // USDT. The tronbox suites keep using the 18-decimal MockERC20 below, which they allow at 18.
      await deployer.deploy(TestToken, 'Tether USD', 'USDT', 6);
      const testUsdt = await TestToken.deployed();
      usdtAddress = testUsdt.address;
      console.log('TestToken (USDT) deployed at address:', usdtAddress);

      await deployer.deploy(MockERC20, 'MockToken', 'MOCK');
      const mockToken = await MockERC20.deployed();
      console.log('MockERC20 deployed at address:', mockToken.address);
    } else {
      throw new Error(`Invalid network: ${network}`);
    }

    console.log('Permit2 address:', permit2Address);
    console.log('USDT address:', usdtAddress);

    await deployer.deploy(
      Escrow,
      permit2Address,
      usdtAddress,
      accounts,
    );

    const escrow = await Escrow.deployed();
    console.log('✓ Escrow deployed at address:', escrow.address);

    // Deploy FulfillmentProxy contract
    console.log('\n2. Deploying FulfillmentProxy contract...');

    await deployer.deploy(
      FulfillmentProxy,
      accounts,
    );

    const fulfillmentProxy = await FulfillmentProxy.deployed();
    console.log('✓ FulfillmentProxy deployed at address:', fulfillmentProxy.address);

    console.log('\n=====================================');
    console.log('All contracts deployed successfully!');
    console.log('Escrow:', escrow.address);
    console.log('FulfillmentProxy:', fulfillmentProxy.address);
    console.log('=====================================\n');

    // Return true to indicate successful deployment
    return true;

  } catch (error) {
    console.error('\n❌ DEPLOYMENT FAILED');
    console.error('Error details:', error.message);
    console.error('Stack trace:', error.stack);

    // Explicitly throw the error to ensure migration fails
    throw error;
  }
};
