const path = require('path');
const testHelpers = require('./test-helpers');
const { chainIdFromGenesisBlockId } = require('../scripts/deploy-local/chain-id');

const Escrow = artifacts.require('Escrow');
const Permit2 = artifacts.require('Permit2Extension');
const MockERC20 = artifacts.require('MockERC20');

// The TypeScript SDK as an integrator runs it, from its build output. Required, never skipped.
const SENDER_AUTH = path.resolve(
  __dirname,
  '../../../../schemas/declarations/PaymentRequest/v1/bindings/typescript/sender-auth'
);
const requireBuilt = (request) => {
  try {
    return require(require.resolve(request, { paths: [SENDER_AUTH] }));
  } catch (error) {
    throw new Error(
      `${request} is not built. At the repository root run \`pnpm install\` and ` +
        `\`pnpm --filter "@atum-labs/payment-request-sender-auth..." build\`. (${error.message})`
    );
  }
};
const { buildReserveMessage, localKeySigner } = requireBuilt(SENDER_AUTH);
const {
  computePaymentId,
  createTvmPermitWitnessTransferFromPrehashWithDestination,
  hashTvmPermitWitnessTransferFrom
} = requireBuilt('@atum-labs/tvm-escrow-encoding');

// The local node is no network the SDK knows, so its chain id is supplied under this cluster.
const NETWORK = 'tron:localnet';
const AMOUNT = '1000000000000000000';

// The deposit is built with the tvm-escrow-encoding builder the SDK uses (the SDK's own Tron deposit
// cannot target this node, and the sender_auth vector suites cover it), the reserve with the SDK, and
// both keys sign through the SDK's signer. The escrow on the local TRON node must accept them: the
// deposit id is the computed payment id, and the reserve's TIP-712 domain (chain id, verifying
// contract) is the escrow's.
contract('Escrow: SDK-built reserve', () => {
  let web, escrow, escrowAbi, depositAbi, depositSighash, permit2, mockToken;
  let chainId, depositor, depositorKey, settler, otherSettler, releaser, reserver, reserverKey;
  let nonce = BigInt(Date.now()) * 1000n;

  before(async () => {
    await testHelpers.setupAccounts();
    web = testHelpers.ownerWeb;
    const { owner, second, third } = testHelpers.accounts;
    depositor = owner.address;
    depositorKey = owner.privateKey;
    settler = second.address;
    otherSettler = third.address;
    releaser = third.address;
    // The depositor's selector: a key of its own that signs offchain only.
    reserverKey = web.utils.ethersUtils.id('tron-sdk-award-reserver').slice(2);
    reserver = web.address.fromPrivateKey(reserverKey);

    // From the node's genesis block, never from the contract under test.
    const genesis = await web.trx.getBlockByNumber(0);
    chainId = Number(chainIdFromGenesisBlockId(genesis.blockID));

    escrow = await Escrow.deployed();
    permit2 = await Permit2.deployed();
    mockToken = await MockERC20.deployed();
    escrowAbi = new web.utils.ethersUtils.Interface(Escrow.abi);
    depositAbi = Escrow.abi.find((e) => e.type === 'function' && e.name === 'deposit');
    depositSighash = escrowAbi.getFunction('deposit').format('sighash');

    // Allowed with zero fees, so the escrow holds exactly the source amount.
    const asBool = (r) => (r && typeof r === 'object' && 0 in r ? Boolean(r[0]) : Boolean(r));
    const tokenConfigRole = await escrow.TOKEN_CONFIG_ROLE();
    if (!asBool(await escrow.hasRole(tokenConfigRole, depositor))) {
      await escrow.grantRole(tokenConfigRole, depositor);
    }
    if (!asBool(await escrow.isTokenAllowed(mockToken.address))) {
      await escrow.allowTokenAndSetFeeConfig(mockToken.address, 18, 0, 0, 0);
    }
  });

  // The depositor's Permit2 deposit, its payment id, and the SDK reserve the reserver signs for the
  // chosen quote, with the settler in base58 as a quote carries it.
  const buildAward = async () => {
    nonce += 1n;
    const deadline = String(Math.floor(Date.now() / 1000) + 3600);
    const witness = {
      depositRequestHash: web.utils.ethersUtils.id(`tron-sdk-award-request-${nonce}`),
      destination: 'tron:mainnet/trc20:TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t@TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs'
    };
    const prehash = createTvmPermitWitnessTransferFromPrehashWithDestination({
      chainId,
      permit2Address: permit2.address,
      tokenAddress: mockToken.address,
      amount: AMOUNT,
      spenderAddress: escrow.address,
      nonce: nonce.toString(),
      deadline,
      depositRequestHash: witness.depositRequestHash,
      destination: witness.destination,
      reserverAddress: reserver,
      releaserAddress: releaser
    });
    const { signature: depositSignature } = await localKeySigner(NETWORK, depositorKey).sign({
      message: hashTvmPermitWitnessTransferFrom(prehash),
      message_prehash: JSON.stringify(prehash),
      signature: ''
    });
    const paymentId = computePaymentId(depositor, depositSignature, nonce.toString());

    const reserveWitness = {
      depositId: paymentId,
      quoteHash: web.utils.ethersUtils.id(`tron-sdk-award-quote-${nonce}`),
      settler,
      sourceAmount: AMOUNT
    };
    const reserve = buildReserveMessage({
      network: NETWORK,
      escrowContract: escrow.address,
      ...reserveWitness,
      tronChainIds: { localnet: chainId }
    });
    const { signature: reserveSignature } = await localKeySigner(NETWORK, reserverKey).sign({
      ...reserve,
      signature: ''
    });

    return {
      paymentId,
      nonce: nonce.toString(),
      deadline,
      witness,
      depositSignature,
      reserveWitness,
      reserveSignature
    };
  };

  // DepositInput in the order IEscrow declares it.
  const depositInput = (award, reserveWitness = award.reserveWitness) => [
    [[mockToken.address, AMOUNT], award.nonce, award.deadline],
    depositor,
    [award.witness.depositRequestHash, award.witness.destination, reserver, releaser],
    award.depositSignature,
    [reserveWitness.depositId, reserveWitness.quoteHash, reserveWitness.settler, reserveWitness.sourceAmount],
    award.reserveSignature
  ];

  const fundDepositor = async () => {
    await mockToken.mint(depositor, AMOUNT);
    await mockToken.approve(permit2.address, AMOUNT);
  };

  // Runs deposit() on the node without broadcasting it: the deposit id it returns, or the custom
  // error it reverts with. Straight to the node, because TronWeb's constant call drops revert data.
  const dryRunDeposit = async (input) => {
    const result = await web.fullNode.request(
      'wallet/triggerconstantcontract',
      {
        owner_address: web.address.toHex(settler),
        contract_address: web.address.toHex(escrow.address),
        function_selector: depositSighash,
        parameter: web.utils.abi.encodeParamsV2ByABI(depositAbi, [input]).replace(/^0x/, '')
      },
      'post'
    );
    const data = '0x' + (result.constant_result?.[0] ?? '');
    if (result.result?.result === true && result.result.message === undefined) {
      return { depositId: escrowAbi.decodeFunctionResult('deposit', data)[0] };
    }
    return { error: escrowAbi.parseError(data)?.name ?? `undecoded revert ${JSON.stringify(result.result)} ${data}` };
  };

  it('SDK reserve clears the deposit', async () => {
    const award = await buildAward();
    await fundDepositor();
    const escrowBefore = BigInt((await mockToken.balanceOf(escrow.address)).toString());

    assert.deepEqual(await dryRunDeposit(depositInput(award)), { depositId: award.paymentId });

    const escrowAsSettler = await testHelpers.getTronWebInstance(Escrow, 'second');
    await escrowAsSettler.deposit(depositInput(award)).send({ shouldPollResponse: true, from: settler });

    const stored = await escrow.getDepositHash(award.paymentId);
    assert.notEqual(stored.toString(), '0x' + '0'.repeat(64), 'the escrow stores the deposit under the computed payment id');
    const escrowAfter = BigInt((await mockToken.balanceOf(escrow.address)).toString());
    assert.equal(escrowAfter - escrowBefore, BigInt(AMOUNT), 'the escrow holds the source amount');
  });

  it('a changed settler reverts', async () => {
    const award = await buildAward();
    await fundDepositor();
    assert.deepEqual(await dryRunDeposit(depositInput(award)), { depositId: award.paymentId });

    const tampered = { ...award.reserveWitness, settler: otherSettler };
    assert.deepEqual(await dryRunDeposit(depositInput(award, tampered)), { error: 'InvalidSignature' });
  });

  it('a changed sourceAmount reverts', async () => {
    const award = await buildAward();
    await fundDepositor();
    assert.deepEqual(await dryRunDeposit(depositInput(award)), { depositId: award.paymentId });

    const tampered = { ...award.reserveWitness, sourceAmount: (BigInt(AMOUNT) - 1n).toString() };
    assert.deepEqual(await dryRunDeposit(depositInput(award, tampered)), { error: 'InvalidSignature' });
  });
});
