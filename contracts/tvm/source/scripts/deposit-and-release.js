#!/usr/bin/env node

/**
 * Deposit and Release Script
 *
 * Performs a full deposit + release cycle against the Escrow contract,
 * exercising the complete hot path with correct TIP-712 encoding,
 * Permit2 witness signatures, and reserve signatures.
 *
 * Uses DEPOSITOR_PK for all roles (depositor, reserver, releaser, settler)
 * for testing purposes.
 *
 * Usage: node scripts/deposit-and-release.js <network> [amount]
 *
 * Arguments:
 *   network - 'mainnet' or 'shasta'
 *   amount  - deposit amount in token native decimals (default: 100000000 = 100 USDT)
 *
 * Example:
 *   node scripts/deposit-and-release.js shasta
 *   node scripts/deposit-and-release.js shasta 50000000
 */

const config = require('./config');
const permitHelpers = require('@alexroan/permit2-tron/helpers/permit-helpers');

// ============================================================
// Fee Calculation (mirrors Escrow.determineFee on-chain logic)
// ============================================================

/**
 * Replicates the on-chain determineFee logic with ceiling division.
 * @param {BigInt} amount - deposit amount in token native decimals
 * @param {object} tokenConfig - { feePercentage6Decimals, minFee6Decimals, maxFee6Decimals, tokenDecimals }
 * @returns {BigInt} feeAmount in token native decimals
 */
function determineFee(amount, tokenConfig) {
  if (amount === 0n) return 0n;

  const feePercentage = BigInt(tokenConfig.feePercentage6Decimals);
  const minFee6 = BigInt(tokenConfig.minFee6Decimals);
  const maxFee6 = BigInt(tokenConfig.maxFee6Decimals);
  const decimals = BigInt(tokenConfig.tokenDecimals);

  let feeAmount = 0n;

  // Ceiling division: ceil(amount * feePercentage / 100_000_000)
  if (feePercentage > 0n) {
    feeAmount = (amount * feePercentage + 100_000_000n - 1n) / 100_000_000n;
  }

  // Minimum fee floor
  if (minFee6 > 0n) {
    const minFee = (minFee6 * (10n ** decimals)) / 1_000_000n;
    if (feeAmount < minFee) {
      feeAmount = minFee;
    }
  }

  // Maximum fee cap
  if (maxFee6 > 0n) {
    const maxFee = (maxFee6 * (10n ** decimals)) / 1_000_000n;
    if (feeAmount > maxFee) {
      feeAmount = maxFee;
    }
  }

  if (feeAmount > amount) {
    throw new Error(`Fee (${feeAmount}) exceeds deposit amount (${amount})`);
  }

  return feeAmount;
}

// ============================================================
// TIP-712 Signature Helpers
// ============================================================

/**
 * Construct a TIP-712 digest from a domain separator and struct hash.
 * @param {object} tronWeb - TronWeb instance
 * @param {string} domainSeparator - DOMAIN_SEPARATOR (bytes32 hex)
 * @param {string} structHash - keccak256 of the ABI-encoded struct (bytes32 hex)
 * @returns {string} digest (0x-prefixed bytes32 hex)
 */
function typedDataDigest(tronWeb, domainSeparator, structHash) {
  const ethersUtils = tronWeb.utils.ethersUtils;
  return ethersUtils.keccak256(
    '0x1901' + domainSeparator.slice(2) + structHash.slice(2)
  );
}

/**
 * Construct a TIP-712 signature over a struct hash using a given domain.
 * @param {object} tronWeb - TronWeb instance
 * @param {string} domainSeparator - DOMAIN_SEPARATOR (bytes32 hex)
 * @param {string} structHash - keccak256 of the ABI-encoded struct (bytes32 hex)
 * @param {string} privateKey - signer private key (without 0x prefix)
 * @returns {{ digest: string, signature: string }} digest and signature (0x-prefixed)
 */
function signTypedData(tronWeb, domainSeparator, structHash, privateKey) {
  const ethersUtils = tronWeb.utils.ethersUtils;

  const digest = typedDataDigest(tronWeb, domainSeparator, structHash);

  const signingKey = new ethersUtils.SigningKey('0x' + privateKey);
  const sig = signingKey.sign(digest);
  const signature = '0x' + sig.r.substring(2) + sig.s.substring(2) + sig.v.toString(16);

  return { digest, signature };
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error('Usage: node deposit-and-release.js <network> [amount]');
    console.error('  network: mainnet | shasta');
    console.error('  amount:  deposit amount in native decimals (default: 100000000)');
    process.exit(1);
  }

  const [networkArg, amountArg] = args;

  let network;
  try {
    network = config.validateNetwork(networkArg);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const depositAmount = amountArg || config.DEFAULTS.DEPOSIT_AMOUNT;

  console.log('=== Deposit and Release ===\n');
  console.log(`Network: ${network.toUpperCase()}`);

  // Initialize TronWeb with DEPOSITOR_PK
  const tronWeb = config.initTronWeb(network);
  const ethersUtils = tronWeb.utils.ethersUtils;
  const callerAddress = tronWeb.address.fromPrivateKey(process.env.DEPOSITOR_PK);
  const addresses = config.getContractAddresses(network);

  console.log(`Caller: ${callerAddress}`);
  console.log(`Escrow: ${addresses.ESCROW_ADDRESS}`);
  console.log(`USDT:   ${addresses.USDT_ADDRESS}`);
  console.log(`Amount: ${depositAmount}`);

  // For testing, use same address for all roles
  const depositor = callerAddress;
  const reserver = callerAddress;
  const releaser = callerAddress;
  const settler = callerAddress;

  console.log(`\nRoles (all same address for testing):`);
  console.log(`  Depositor: ${depositor}`);
  console.log(`  Reserver:  ${reserver}`);
  console.log(`  Releaser:  ${releaser}`);
  console.log(`  Settler:   ${settler}`);

  // Get contract instances
  const { escrow, permit2, usdt } = await config.getContracts(tronWeb, network);

  // ============================
  // Step 1: Check balances
  // ============================
  console.log('\n--- Step 1: Check balances ---');
  const depositorBalanceBefore = await usdt.balanceOf(depositor).call();
  const escrowBalanceBefore = await usdt.balanceOf(addresses.ESCROW_ADDRESS).call();
  console.log(`Depositor USDT: ${config.formatUSDT(depositorBalanceBefore)}`);
  console.log(`Escrow USDT:    ${config.formatUSDT(escrowBalanceBefore)}`);

  if (BigInt(depositorBalanceBefore) < BigInt(depositAmount)) {
    throw new Error(`Insufficient USDT balance. Have: ${depositorBalanceBefore}, Need: ${depositAmount}`);
  }

  // ============================
  // Step 2: Ensure USDT allowance to Permit2
  // ============================
  console.log('\n--- Step 2: USDT allowance to Permit2 ---');
  const currentAllowance = await usdt.allowance(depositor, addresses.PERMIT2_ADDRESS).call();
  console.log(`Current allowance: ${currentAllowance.toString()}`);

  if (BigInt(currentAllowance) < BigInt(depositAmount)) {
    console.log('Setting allowance...');
    const approveTx = await usdt.approve(addresses.PERMIT2_ADDRESS, config.DEFAULTS.UINT256_MAX).send(await config.writeOptions(tronWeb));
    console.log(`Approval tx: ${config.getTxId(approveTx)}`);
    await config.waitForConfirmation();
    const newAllowance = await usdt.allowance(depositor, addresses.PERMIT2_ADDRESS).call();
    console.log(`New allowance: ${newAllowance.toString()}`);
  } else {
    console.log('Sufficient allowance already set');
  }

  // ============================
  // Step 3: Fee calculation
  // ============================
  console.log('\n--- Step 3: Fee calculation ---');
  const tokenConfigResult = await escrow.getTokenConfig(addresses.USDT_ADDRESS).call();
  const tokenConfig = tokenConfigResult[0] ?? tokenConfigResult;
  console.log(`Token config: decimals=${tokenConfig.tokenDecimals}, fee%=${tokenConfig.feePercentage6Decimals}, min=${tokenConfig.minFee6Decimals}, max=${tokenConfig.maxFee6Decimals}`);

  const feeAmount = determineFee(BigInt(depositAmount), {
    feePercentage6Decimals: tokenConfig.feePercentage6Decimals,
    minFee6Decimals: tokenConfig.minFee6Decimals,
    maxFee6Decimals: tokenConfig.maxFee6Decimals,
    tokenDecimals: tokenConfig.tokenDecimals
  });
  console.log(`Fee amount: ${feeAmount.toString()}`);

  // ============================
  // Step 4: Deposit signature (Permit2 witness transfer)
  // ============================
  console.log('\n--- Step 4: Deposit signature (Permit2) ---');

  const nonce = Date.now();
  const deadline = Math.floor(Date.now() / 1000) + config.DEFAULTS.DEADLINE_DURATION;

  const permit = permitHelpers.createPermit(
    addresses.USDT_ADDRESS,
    depositAmount,
    addresses.ESCROW_ADDRESS, // spender
    nonce,
    deadline
  );
  console.log(`Permit: token=${permit.permitted.token}, amount=${permit.permitted.amount}, nonce=${nonce}, deadline=${deadline}`);

  // DepositWitness hash: keccak256(abi.encode(typeHash, reserver, releaser))
  const DEPOSIT_WITNESS_TYPE_HASH = ethersUtils.id(
    'DepositWitness(address reserver,address releaser)'
  );
  const witnessHash = ethersUtils.keccak256(
    tronWeb.utils.abi.encodeParams(
      ['bytes32', 'address', 'address'],
      [DEPOSIT_WITNESS_TYPE_HASH, reserver, releaser]
    )
  );
  console.log(`Witness hash: ${witnessHash}`);

  // Get Permit2 domain separator
  const permit2DomainSeparator = await permit2.DOMAIN_SEPARATOR().call();
  console.log(`Permit2 domain separator: ${permit2DomainSeparator}`);

  // Witness type string (must match FULL_DEPOSIT_WITNESS_TYPE_STRING in Escrow.sol)
  const witnessTypeString = 'DepositWitness witness)DepositWitness(address reserver,address releaser)TokenPermissions(address token,uint256 amount)';

  const { finalHash } = permitHelpers.getPermitWitnessTransferFromHash(
    tronWeb,
    permit,
    witnessHash,
    witnessTypeString,
    addresses.ESCROW_ADDRESS,
    permit2DomainSeparator
  );

  // Sign with depositor's key
  const depositSigningKey = new ethersUtils.SigningKey('0x' + process.env.DEPOSITOR_PK);
  const depositSigObj = depositSigningKey.sign(finalHash);
  const depositSignature = '0x' + depositSigObj.r.substring(2) + depositSigObj.s.substring(2) + depositSigObj.v.toString(16);
  console.log(`Deposit signature: ${depositSignature.substring(0, 20)}...`);

  // ============================
  // Step 5: Deposit ID
  // ============================
  console.log('\n--- Step 5: Deposit ID ---');

  // depositId = keccak256(abi.encode(depositor, depositSignature, nonce))
  const depositId = ethersUtils.keccak256(
    tronWeb.utils.abi.encodeParams(
      ['address', 'bytes', 'uint256'],
      [depositor, depositSignature, nonce]
    )
  );
  console.log(`Deposit ID: ${depositId}`);

  // ============================
  // Step 6: Reserve signature (TIP-712 on Escrow domain)
  // ============================
  console.log('\n--- Step 6: Reserve signature (Escrow TIP-712) ---');

  const escrowDomainSeparator = await escrow.DOMAIN_SEPARATOR().call();
  console.log(`Escrow domain separator: ${escrowDomainSeparator}`);

  // Non-zero offchain quote hash attested by the reserver (must be non-empty; the escrow rejects
  // an all-zero quoteHash). Also bind the winning source amount into the reserve witness.
  const quoteHash = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const sourceAmount = depositAmount;
  const RESERVE_WITNESS_TYPE_HASH = ethersUtils.id(
    'ReserveWitness(bytes32 depositId,bytes32 quoteHash,address settler,uint256 sourceAmount)'
  );
  const reserveStructHash = ethersUtils.keccak256(
    tronWeb.utils.abi.encodeParams(
      ['bytes32', 'bytes32', 'bytes32', 'address', 'uint256'],
      [RESERVE_WITNESS_TYPE_HASH, depositId, quoteHash, settler, sourceAmount]
    )
  );

  const { digest: reserveDigest, signature: reserveSignature } = signTypedData(
    tronWeb,
    escrowDomainSeparator,
    reserveStructHash,
    process.env.DEPOSITOR_PK // reserver key (same as depositor for testing)
  );
  console.log(`Reserve digest:    ${reserveDigest}`);
  console.log(`Reserve signature: ${reserveSignature.substring(0, 20)}...`);

  // ============================
  // Step 7: Execute deposit
  // ============================
  console.log('\n--- Step 7: Execute deposit ---');

  const permitForCall = permitHelpers.formatPermitForCall(permit);

  // DepositInput struct as positional array for TronWeb:
  // [permit, depositor, depositWitness, depositSignature, reserveWitness, reserveSignature]
  const depositInput = [
    permitForCall,                    // PermitTransferFrom: [[token, amount], nonce, deadline]
    depositor,                        // address depositor
    [reserver, releaser],             // DepositWitness: [reserver, releaser]
    depositSignature,                 // bytes depositSignature
    [depositId, quoteHash, settler, sourceAmount], // ReserveWitness: [depositId, quoteHash, settler, sourceAmount]
    reserveSignature                  // bytes reserveSignature
  ];

  const depositTx = await escrow.deposit(depositInput).send(await config.writeOptions(tronWeb));
  console.log(`Deposit tx: ${config.getTxId(depositTx)}`);
  await config.waitForConfirmation();

  // ============================
  // Step 8: Verify deposit
  // ============================
  console.log('\n--- Step 8: Verify deposit ---');

  const depositHash = await escrow.getDepositHash(depositId).call();
  console.log(`Deposit hash: ${depositHash}`);
  if (depositHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
    throw new Error('Deposit hash is zero - deposit may have failed!');
  }
  console.log('Deposit hash is non-zero - deposit exists!');

  const depositorBalanceAfterDeposit = await usdt.balanceOf(depositor).call();
  const escrowBalanceAfterDeposit = await usdt.balanceOf(addresses.ESCROW_ADDRESS).call();
  console.log(`Depositor USDT: ${config.formatUSDT(depositorBalanceAfterDeposit)}`);
  console.log(`Escrow USDT:    ${config.formatUSDT(escrowBalanceAfterDeposit)}`);

  const depositorDiff = BigInt(depositorBalanceBefore) - BigInt(depositorBalanceAfterDeposit);
  console.log(`Depositor change: -${depositorDiff.toString()}`);

  // ============================
  // Step 9: Release signature (TIP-712 on Escrow domain)
  // ============================
  console.log('\n--- Step 9: Release signature (Escrow TIP-712) ---');

  const RELEASE_WITNESS_TYPE_HASH = ethersUtils.id(
    'ReleaseWitness(bytes32 depositId,bytes32 quoteHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)'
  );

  const releaseStructHash = ethersUtils.keccak256(
    tronWeb.utils.abi.encodeParams(
      ['bytes32', 'bytes32', 'bytes32', 'address', 'address', 'uint256', 'uint256', 'address', 'address', 'address'],
      [RELEASE_WITNESS_TYPE_HASH, depositId, quoteHash, depositor, addresses.USDT_ADDRESS, depositAmount, feeAmount.toString(), reserver, releaser, settler]
    )
  );

  const { digest: releaseDigest, signature: releaseSignature } = signTypedData(
    tronWeb,
    escrowDomainSeparator,
    releaseStructHash,
    process.env.DEPOSITOR_PK // releaser key (same as depositor for testing)
  );
  console.log(`Release digest:    ${releaseDigest}`);
  console.log(`Release signature: ${releaseSignature.substring(0, 20)}...`);

  // ============================
  // Step 10: Execute release
  // ============================
  console.log('\n--- Step 10: Execute release ---');

  // ReleaseInput struct: [releaseWitness, releaseSignature]
  // ReleaseWitness: [depositId, quoteHash, depositor, token, amount, feeAmount, reserver, releaser, settler]
  const releaseInput = [
    [depositId, quoteHash, depositor, addresses.USDT_ADDRESS, depositAmount, feeAmount.toString(), reserver, releaser, settler],
    releaseSignature
  ];

  const releaseTx = await escrow.release(releaseInput).send(await config.writeOptions(tronWeb));
  console.log(`Release tx: ${config.getTxId(releaseTx)}`);
  await config.waitForConfirmation();

  // ============================
  // Step 11: Verify release
  // ============================
  console.log('\n--- Step 11: Verify release ---');

  const depositHashAfter = await escrow.getDepositHash(depositId).call();
  console.log(`Deposit hash after release: ${depositHashAfter}`);
  if (depositHashAfter !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
    console.error('Warning: Deposit hash should be zero after release!');
  } else {
    console.log('Deposit hash cleared - release confirmed!');
  }

  const depositorBalanceAfterRelease = await usdt.balanceOf(depositor).call();
  const escrowBalanceAfterRelease = await usdt.balanceOf(addresses.ESCROW_ADDRESS).call();
  console.log(`\nFinal balances:`);
  console.log(`Depositor USDT: ${config.formatUSDT(depositorBalanceAfterRelease)}`);
  console.log(`Escrow USDT:    ${config.formatUSDT(escrowBalanceAfterRelease)}`);

  // Since settler == depositor in this test, depositor gets back (amount - feeAmount)
  // Net loss = feeAmount
  const netChange = BigInt(depositorBalanceBefore) - BigInt(depositorBalanceAfterRelease);
  console.log(`\nNet depositor change: -${netChange.toString()} (expected fee: ${feeAmount.toString()})`);

  if (netChange === feeAmount) {
    console.log('Fee amount matches net change!');
  }

  // Check fee revenue
  const feeRevResult = await escrow.getFeeRevenue(addresses.USDT_ADDRESS).call();
  const feeRevenue = feeRevResult[0] ?? feeRevResult;
  console.log(`Fee revenue in Escrow: ${feeRevenue.toString()}`);

  // ============================
  // Step 12: Compute refund digest (off-chain only, no execution)
  // ============================
  console.log('\n--- Step 12: Refund digest (off-chain only) ---');

  const REFUND_WITNESS_TYPE_HASH = ethersUtils.id(
    'RefundWitness(bytes32 depositId,bytes32 quoteHash,address depositor,address token,uint256 amount,uint256 feeAmount,address reserver,address releaser,address settler)'
  );

  const refundStructHash = ethersUtils.keccak256(
    tronWeb.utils.abi.encodeParams(
      ['bytes32', 'bytes32', 'bytes32', 'address', 'address', 'uint256', 'uint256', 'address', 'address', 'address'],
      [REFUND_WITNESS_TYPE_HASH, depositId, quoteHash, depositor, addresses.USDT_ADDRESS, depositAmount, feeAmount.toString(), reserver, releaser, settler]
    )
  );

  const refundDigest = typedDataDigest(tronWeb, escrowDomainSeparator, refundStructHash);
  console.log(`Refund digest: ${refundDigest}`);

  // ============================
  // Step 13: Get chain ID (Tron masks to 32 bits in TIP-712)
  // ============================
  let chainId;
  try {
    // TronWeb v6+ may expose getChainId
    if (tronWeb.trx.getChainId) {
      chainId = await tronWeb.trx.getChainId();
    }
  } catch (e) {
    // Not available on all nodes
  }
  if (!chainId) {
    // Fetch from chain parameters
    try {
      const chainParams = await tronWeb.trx.getChainParameters();
      const cidParam = chainParams.find(p => p.key === 'getMaintenanceTimeInterval');
      // Chain ID is not directly in parameters; use block header
      const block = await tronWeb.trx.getCurrentBlock();
      // Tron full nodes don't always expose chain ID directly
      // Log the Escrow DOMAIN_SEPARATOR which embeds it
      chainId = null;
    } catch (e) {
      chainId = null;
    }
  }
  const chainIdDisplay = chainId ? String(chainId) : 'see escrowDomainSeparator';
  console.log(`Chain ID: ${chainIdDisplay}`);
  console.log(`Escrow DOMAIN_SEPARATOR: ${escrowDomainSeparator}`);
  console.log(`Permit2 DOMAIN_SEPARATOR: ${permit2DomainSeparator}`);

  // ============================
  // Summary and Encoding Examples JSON
  // ============================
  console.log('\n=== Deposit and Release completed successfully! ===');
  console.log(`Deposit ID: ${depositId}`);
  console.log(`Amount: ${depositAmount}`);
  console.log(`Fee: ${feeAmount.toString()}`);
  console.log(`Settler received: ${(BigInt(depositAmount) - feeAmount).toString()}`);

  // Build encoding examples JSON
  const encodingExamples = {
    domainSeparators: {
      permit2: permit2DomainSeparator,
      escrow: escrowDomainSeparator
    },
    depositId: [
      {
        depositor: depositor,
        signature: depositSignature,
        nonce: nonce,
        expectedDepositId: depositId
      }
    ],
    deposit: [
      {
        chainID: chainIdDisplay,
        permit2: addresses.PERMIT2_ADDRESS,
        token: addresses.USDT_ADDRESS,
        amount: depositAmount.toString(),
        nonce: nonce,
        deadline: deadline,
        spender: addresses.ESCROW_ADDRESS,
        reserver: reserver,
        releaser: releaser,
        expectedDigest: finalHash
      }
    ],
    reserve: [
      {
        chainID: chainIdDisplay,
        escrow: addresses.ESCROW_ADDRESS,
        depositId: depositId,
        settler: settler,
        expectedDigest: reserveDigest
      }
    ],
    release: [
      {
        chainID: chainIdDisplay,
        escrow: addresses.ESCROW_ADDRESS,
        depositId: depositId,
        depositor: depositor,
        token: addresses.USDT_ADDRESS,
        amount: depositAmount.toString(),
        feeAmount: feeAmount.toString(),
        reserver: reserver,
        releaser: releaser,
        settler: settler,
        expectedDigest: releaseDigest
      }
    ],
    refund: [
      {
        chainID: chainIdDisplay,
        escrow: addresses.ESCROW_ADDRESS,
        depositId: depositId,
        depositor: depositor,
        token: addresses.USDT_ADDRESS,
        amount: depositAmount.toString(),
        feeAmount: feeAmount.toString(),
        reserver: reserver,
        releaser: releaser,
        settler: settler,
        expectedDigest: refundDigest
      }
    ]
  };

  console.log('\n=== ENCODING EXAMPLES JSON ===');
  console.log(JSON.stringify(encodingExamples, null, 4));
  console.log('=== END ENCODING EXAMPLES JSON ===');
}

main().catch((error) => {
  console.error('\nError:', error.message);
  if (error.stack) {
    console.error('\nStack:', error.stack);
  }
  process.exit(1);
});
