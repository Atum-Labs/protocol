const { TronWeb } = require('tronweb');
const testHelpers = require('./test-helpers');
const permitHelpers = require('@alexroan/permit2-tron/helpers/permit-helpers');
const hashHelpers = require('@alexroan/permit2-tron/helpers/hash-helpers');

// Contract artifacts
const Escrow = artifacts.require('Escrow');
const Permit2 = artifacts.require('Permit2Extension');
const MockERC20 = artifacts.require('MockERC20');

contract('Escrow', () => {
  // Test accounts
  let owner, second, third;
  let ownerPrivateKey, secondPrivateKey, thirdPrivateKey;
  
  // Contract instances
  let escrow, permit2, mockToken;
  
  // TronWeb instances
  let ownerWeb, secondWeb, thirdWeb;
  
  // Test constants
  const DEPOSIT_AMOUNT = '1000000000000000000'; // 1 token (18 decimals)
  // Chain ID for TIP-712
  let chainId;
  
  before(async () => {
    // Setup test accounts
    await testHelpers.setupAccounts();
    
    // Get account addresses from testHelpers
    owner = testHelpers.owner;
    second = testHelpers.secondAccount;
    third = testHelpers.accounts.third.address;
    
    // Get private keys (with 0x prefix for ethersUtils)
    ownerPrivateKey = '0x' + testHelpers.accounts.owner.privateKey;
    secondPrivateKey = '0x' + testHelpers.secondPrivateKey;
    thirdPrivateKey = '0x' + testHelpers.accounts.third.privateKey;
    
    // Get TronWeb instances
    ownerWeb = testHelpers.ownerWeb;
    secondWeb = testHelpers.secondWeb;
    thirdWeb = testHelpers.thirdWeb;
    
    // Get chain ID (masked for TIP-712)
    // For local TRE, the chain ID is typically a specific value
    // We'll use a hardcoded value for local development
    chainId = (0xcd8690dc & 0xffffffff) >>> 0; // Local TRE chain ID masked
    
    console.log('Test setup:');
    console.log('- Owner:', owner);
    console.log('- Second (reserver):', second);
    console.log('- Third (releaser):', third);
    console.log('- Chain ID (masked):', chainId);
  });
  
  beforeEach(async () => {
    // Get deployed contract instances
    escrow = await Escrow.deployed();
    permit2 = await Permit2.deployed();
    mockToken = await MockERC20.deployed();
    
    // Mint tokens to owner
    await mockToken.mint(owner, DEPOSIT_AMOUNT);
    
    // Approve Permit2 to spend tokens
    await mockToken.approve(permit2.address, DEPOSIT_AMOUNT);
    
    console.log('\nContract addresses:');
    console.log('- Escrow:', escrow.address);
    console.log('- Permit2:', permit2.address);
    console.log('- MockToken:', mockToken.address);
    
    // ALLOWLIST THE TOKEN. deposit() reverts TokenNotAllowed when tokenConfig.tokenDecimals == 0,
    // so an unconfigured token can never deposit. The test logged the allowlist state but never set
    // it, which went unnoticed because the suite never ran. Fee parameters are all zero so the
    // balance assertions below stay exact (gross in, gross escrowed).
    // TronBox returns a Result OBJECT for a single return value, e.g. `[ false, isTokenAllowed: false ]`.
    // An array-like is ALWAYS truthy, so `if (!(await ...))` silently never fires — which is exactly
    // how the first attempt at this setup skipped itself and left the token unconfigured.
    const asBool = (r) => (r && typeof r === 'object' && 0 in r ? Boolean(r[0]) : Boolean(r));

    const tokenConfigRole = await escrow.TOKEN_CONFIG_ROLE();
    if (!asBool(await escrow.hasRole(tokenConfigRole, owner))) {
      await escrow.grantRole(tokenConfigRole, owner);
    }
    if (!asBool(await escrow.isTokenAllowed(mockToken.address))) {
      await escrow.allowTokenAndSetFeeConfig(mockToken.address, 18, 0, 0, 0);
    }

    const isAllowed = asBool(await escrow.isTokenAllowed(mockToken.address));
    console.log('- Token allowlisted:', isAllowed);
    assert.equal(isAllowed, true, 'Token must be allowlisted before a deposit can succeed');
    
    // Check token allowance to Permit2
    const allowance = await mockToken.allowance(owner, permit2.address);
    console.log('- Token allowance to Permit2:', allowance.toString());
  });
  
  it('should successfully deposit tokens into escrow', async () => {
    // Setup roles
    const depositor = owner;
    const reserver = second;  // Who can reserve the deposit
    const releaser = third;   // Who can release/refund the deposit
    const solver = second;    // Who will call the deposit function
    
    // Check initial balances
    const depositorBalanceBefore = await mockToken.balanceOf(depositor);
    const escrowBalanceBefore = await mockToken.balanceOf(escrow.address);
    
    console.log('\nInitial balances:');
    console.log('- Depositor:', depositorBalanceBefore.toString());
    console.log('- Escrow:', escrowBalanceBefore.toString());
    
    // Create permit data
    const nonce = Date.now(); // Use timestamp as nonce for uniqueness
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
    
    const permit = permitHelpers.createPermit(
      mockToken.address,
      DEPOSIT_AMOUNT,
      escrow.address, // spender
      nonce,
      deadline
    );
    
    // Create witness data for Escrow deposit.
    //
    // DepositWitness WIDENED under CORE-2022/CORE-2120: it carries the depositor's commitment to
    // the offchain request (depositRequestHash) and the plaintext destination as well as the two
    // roles. This test still built the old two-address witness, which is why it failed to even
    // ABI-encode ("types/value length mismatch") once the suite started running again — the
    // ReserveWitness half below had already been updated for sourceAmount, this half had not.
    const depositWitness = {
      depositRequestHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
      destination: 'tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t@TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs',
      reserver: reserver,
      releaser: releaser
    };

    const DEPOSIT_WITNESS_TYPE_HASH = ownerWeb.utils.ethersUtils.id(
      "DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)"
    );
    console.log('DEPOSIT_WITNESS_TYPE_HASH:', DEPOSIT_WITNESS_TYPE_HASH);

    // Create witness hash for DepositWitness — must match Escrow.sol's own abi.encode exactly.
    // EIP-712 hashes a dynamic `string` member as keccak256(bytes(value)); passing the raw string
    // would emit offset+len+data and recover a different signer. ethersUtils.id() is keccak256 over
    // the UTF-8 bytes, which is the same thing.
    const witnessHash = ownerWeb.utils.ethersUtils.keccak256(
      ownerWeb.utils.abi.encodeParams(
        ['bytes32', 'bytes32', 'bytes32', 'address', 'address'],
        [
          DEPOSIT_WITNESS_TYPE_HASH,
          depositWitness.depositRequestHash,
          ownerWeb.utils.ethersUtils.id(depositWitness.destination),
          depositWitness.reserver,
          depositWitness.releaser
        ]
      )
    );

    // Define witness type string - this must match what Escrow passes to Permit2
    const witnessTypeString = 'DepositWitness witness)DepositWitness(bytes32 depositRequestHash,string destination,address reserver,address releaser)TokenPermissions(address token,uint256 amount)';
    
    // Get Permit2 domain separator
    const permit2Instance = await testHelpers.getTronWebInstance(Permit2, 'owner');
    const permit2DomainSeparator = await permit2Instance.DOMAIN_SEPARATOR().call();
    
    console.log('\nPermit2 domain separator:', permit2DomainSeparator);
    
    // Generate the permit witness hash
    // The spender (msg.sender) for Permit2 will be the Escrow contract itself
    const { finalHash } = permitHelpers.getPermitWitnessTransferFromHash(
      ownerWeb,
      permit,
      witnessHash,
      witnessTypeString,
      escrow.address, // Escrow contract is the spender that will call Permit2
      permit2DomainSeparator
    );
    
    // Sign the hash
    const ethersUtils = ownerWeb.utils.ethersUtils;
    const signingKey = new ethersUtils.SigningKey(ownerPrivateKey);
    const signature = signingKey.sign(finalHash);
    const sig = '0x' + signature.r.substring(2) + signature.s.substring(2) + signature.v.toString(16);
    
    console.log('\nPermit details:');
    console.log('- Nonce:', nonce);
    console.log('- Deadline:', deadline);
    console.log('- Witness hash:', witnessHash);
    console.log('- Final hash:', finalHash);
    console.log('- Signature:', sig);
    
    // Format data for contract call
    const permitForCall = permitHelpers.formatPermitForCall(permit);
    
    // Expected deposit ID
    const expectedDepositId = ownerWeb.utils.ethersUtils.keccak256(ownerWeb.utils.abi.encodeParams(['address', 'bytes', 'uint256'], [depositor, sig.startsWith('0x') ? sig : '0x' + sig, nonce]));
    
    console.log('\nExpected deposit ID:', expectedDepositId);

    // Non-zero offchain quote hash attested by the reserver (must be non-empty; mirrors the
    // on-chain QuoteHashCannotBeEmpty guard). The reserver also binds the winning source amount.
    const quoteHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
    const reserveWitness = {
      depositId: expectedDepositId,
      quoteHash: quoteHash,
      settler: solver,
      sourceAmount: DEPOSIT_AMOUNT,
    }
    
    console.log('reserveWitness:', reserveWitness);
    const escrowDomainSeparator = await escrow.DOMAIN_SEPARATOR();
    console.log('Escrow domain separator:', escrowDomainSeparator);

    const RESERVE_WITNESS_TYPE_HASH = ownerWeb.utils.ethersUtils.id(
      "ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)"
    );
    const structHash = ownerWeb.utils.ethersUtils.keccak256(
      ownerWeb.utils.abi.encodeParams(
        ['bytes32', 'bytes32', 'bytes32', 'address', 'uint256'],
        [RESERVE_WITNESS_TYPE_HASH, reserveWitness.depositId, reserveWitness.quoteHash, reserveWitness.settler, reserveWitness.sourceAmount]
      )
    );
    console.log('Reserve witness type hash:', RESERVE_WITNESS_TYPE_HASH);
    console.log('Struct hash:', structHash);

    const finalReserveHash = ownerWeb.utils.ethersUtils.keccak256(
      '0x1901' + escrowDomainSeparator.slice(2) + structHash.slice(2)
    );
    console.log('Final Reserve hash:', finalReserveHash);
    
    const reserveSigningKey = new ethersUtils.SigningKey(secondPrivateKey);
    const reserveSignature = reserveSigningKey.sign(finalReserveHash);
    const reserveSig = '0x' + reserveSignature.r.substring(2) + reserveSignature.s.substring(2) + reserveSignature.v.toString(16);
    console.log('Reserve signature:', reserveSig);
    
    // Execute deposit from solver account
    const escrowInstance = await testHelpers.getTronWebInstance(Escrow, 'second');

    const depositInput = [
      permitForCall,
      depositor,
      [
        depositWitness.depositRequestHash,
        depositWitness.destination,
        depositWitness.reserver,
        depositWitness.releaser
      ],
      sig,
      [reserveWitness.depositId, reserveWitness.quoteHash, reserveWitness.settler, reserveWitness.sourceAmount],
      reserveSig
    ];
    
    // Call deposit function
    try {
      const tx = await escrowInstance.deposit(
        depositInput
      ).send({
        shouldPollResponse: true,
        from: solver
      });
      console.log('\nTransaction hash:', tx);
    } catch (error) {
      console.error('\nDeposit failed with error:', error);
      console.error('Error message:', error.message);
      throw error;
    }
    
    // Check final balances
    const depositorBalanceAfter = await mockToken.balanceOf(depositor);
    const escrowBalanceAfter = await mockToken.balanceOf(escrow.address);
    
    console.log('\nFinal balances:');
    console.log('- Depositor:', depositorBalanceAfter.toString());
    console.log('- Escrow:', escrowBalanceAfter.toString());
    
    // Verify balances changed correctly
    assert.equal(
      depositorBalanceAfter.toString(),
      (BigInt(depositorBalanceBefore.toString()) - BigInt(DEPOSIT_AMOUNT)).toString(),
      'Depositor balance should decrease by deposit amount'
    );
    
    assert.equal(
      escrowBalanceAfter.toString(),
      (BigInt(escrowBalanceBefore.toString()) + BigInt(DEPOSIT_AMOUNT)).toString(),
      'Escrow balance should increase by deposit amount'
    );
    
    console.log('\n✅ Deposit successful!');
  });
});
