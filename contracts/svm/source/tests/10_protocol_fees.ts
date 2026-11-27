import {
  anchor,
  escrowProgram,
  provider,
  DEPOSIT_SEED,
  expect,
  Keypair,
  PublicKey,
  SystemProgram,
  createDelegate,
  depositSigIx,
  refundSigIx,
  releaseSigIx,
  reserveSigIx,
  createPaymentId,
  createValidNonce,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  generateFundedKeypair,
  setupMintAndFund,
  createMessage,
  getOrCreateAssociatedTokenAccount,
  DELEGATE_CAPACITY,
  MAX_TRANSFER_SIZE,
  REPLAY_SEED,
  ensureProtocolInitialized,
  getMintFeeConfigAddress,
  treasurerKeypair,
  getBalance,
  assertBalanceDelta,
  computeExpectedFeeAtoms,
  findProgramEvent,
  DEFAULT_QUOTE_HASH,
  ZERO_QUOTE_HASH,
  destinationHash,
  depositComputeBudgetIx,
} from "./helpers";
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  mintTo as splMintTo,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

describe("10. Protocol Fees", () => {
  let protocolConfig: PublicKey;

  // Helper to create a full deposit with reserve and release flow
  async function createDeposit(
    depositor: Keypair,
    delegateSigner: Keypair,
    delegate: PublicKey,
    mint: PublicKey,
    mintFeeConfig: PublicKey,
    authorityAta: PublicKey,
    reserver: Keypair,
    releaser: Keypair,
    payer: Keypair,
    amount: BN
  ): Promise<{
    deposit: PublicKey;
    escrowAta: PublicKey;
    depositHash: Buffer;
  }> {
    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new BN(Math.floor(Date.now() / 1000) - 5);
    const deadline = new BN(issuedAt.toNumber() + 60);

    const message = await createMessage("deposit", [
      paymentId,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      amount.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAt.toBuffer("le", 8),
      deadline.toBuffer("le", 8),
    ]);
    const depositHash = message;

    const ed25519Instruction = depositSigIx(
      delegateSigner,
      message
    );

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, depositHash],
      escrowProgram.programId
    );
    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

    await escrowProgram.methods
      .deposit(
        Array.from(paymentId),
        Array.from(await destinationHash()),
        amount,
        reserver.publicKey,
        releaser.publicKey,
        nonce,
        issuedAt,
        deadline,
        Array.from(depositHash)
      )
      .accountsPartial({
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket,
        authorityAta,
        deposit,
        escrowAta,
        mint,
        protocolConfig,
        mintFeeConfig,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), ed25519Instruction])
      .signers([payer])
      .rpc();

    return { deposit, escrowAta, depositHash };
  }

  before(async () => {
    protocolConfig = await ensureProtocolInitialized(escrowProgram, provider);
  });

  // Test 10.1: Percentage-only fee on release
  it("10.1 percentage-only fee on release", async () => {
    // Setup fresh mint and accounts
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // Set 1% fee (1_000_000 in the scale where 100_000_000 = 100%)
    await escrowProgram.methods
      .setMintFeeConfig(new BN(1_000_000), new BN(0), new BN(0))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Setup actors
    const [depositor, delegateSigner, reserver, releaser, payer, recipient] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );

    // Transfer tokens to depositor
    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000) // 200 tokens
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    // Deposit 100 tokens (100_000_000 atomics for 6 decimals)
    const amount = new BN(100_000_000);
    const expectedFee = computeExpectedFeeAtoms(BigInt(100_000_000), 6, {
      feePercentage6: 1_000_000n,
      minFee6: 0n,
      maxFee6: 0n,
    });

    // Create deposit
    const { deposit, escrowAta, depositHash } = await createDeposit(
      depositor,
      delegateSigner,
      delegate,
      mint,
      mintFeeConfig,
      authorityAta,
      reserver,
      releaser,
      payer,
      amount
    );

    // Verify depositInfo.feeAmount matches expectedFee
    const depositAccount = await escrowProgram.account.depositInfo.fetch(
      deposit
    );
    expect(depositAccount.feeAmount.toString()).to.equal(
      expectedFee.toString()
    );

    // Reserve
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      amount.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), amount)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveSigIx(reserver, reserveMessage)])
      .rpc();

    // Get balances before release
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      mint,
      treasurerKeypair.publicKey
    );
    const recipientBalanceBefore = await getBalance(
      provider.connection,
      recipientAta
    );
    const treasuryBalanceBefore = await getBalance(
      provider.connection,
      treasuryAta
    );

    // Release
    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    await escrowProgram.methods
      .release()
      .accountsPartial({
        protocolConfig,
        deposit,
        escrowAta,
        recipient: recipient.publicKey,
        recipientAta,
        depositor: depositor.publicKey,
        depositorAta: authorityAta,
        treasurer: treasurerKeypair.publicKey,
        treasuryAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([releaseSigIx(releaser, releaseMessage)])
      .signers([payer])
      .rpc();

    // Assert recipient delta = amount - fee
    await assertBalanceDelta(
      provider.connection,
      recipientAta,
      BigInt(amount.toString()) - expectedFee,
      recipientBalanceBefore
    );

    // Assert treasury delta = fee
    await assertBalanceDelta(
      provider.connection,
      treasuryAta,
      expectedFee,
      treasuryBalanceBefore
    );

    // Clear fee config for next test
    await escrowProgram.methods
      .clearMintFeeConfig()
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintFeeConfig,
      })
      .rpc();
  });

  // Test 10.2: Min-only (flat) fee
  it("10.2 min-only (flat) fee on release", async () => {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // Set min fee only: 1 token min (1_000_000 in 6-decimal = 1 token)
    await escrowProgram.methods
      .setMintFeeConfig(new BN(0), new BN(1_000_000), new BN(0))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const [depositor, delegateSigner, reserver, releaser, payer, recipient] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );

    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const amount = new BN(50_000_000); // 50 tokens
    const expectedFee = computeExpectedFeeAtoms(BigInt(50_000_000), 6, {
      feePercentage6: 0n,
      minFee6: 1_000_000n,
      maxFee6: 0n,
    });
    // With no percentage, fee is just min_fee_atoms = 1_000_000 (1 token in 6 decimals)
    expect(expectedFee.toString()).to.equal("1000000");

    const { deposit, escrowAta, depositHash } = await createDeposit(
      depositor,
      delegateSigner,
      delegate,
      mint,
      mintFeeConfig,
      authorityAta,
      reserver,
      releaser,
      payer,
      amount
    );

    const depositAccount = await escrowProgram.account.depositInfo.fetch(
      deposit
    );
    expect(depositAccount.feeAmount.toString()).to.equal(
      expectedFee.toString()
    );

    // Reserve and release
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      amount.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), amount)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveSigIx(reserver, reserveMessage)])
      .rpc();

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      mint,
      treasurerKeypair.publicKey
    );
    const recipientBalanceBefore = await getBalance(
      provider.connection,
      recipientAta
    );
    const treasuryBalanceBefore = await getBalance(
      provider.connection,
      treasuryAta
    );

    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    await escrowProgram.methods
      .release()
      .accountsPartial({
        protocolConfig,
        deposit,
        escrowAta,
        recipient: recipient.publicKey,
        recipientAta,
        depositor: depositor.publicKey,
        depositorAta: authorityAta,
        treasurer: treasurerKeypair.publicKey,
        treasuryAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([releaseSigIx(releaser, releaseMessage)])
      .signers([payer])
      .rpc();

    await assertBalanceDelta(
      provider.connection,
      recipientAta,
      BigInt(amount.toString()) - expectedFee,
      recipientBalanceBefore
    );
    await assertBalanceDelta(
      provider.connection,
      treasuryAta,
      expectedFee,
      treasuryBalanceBefore
    );

    await escrowProgram.methods
      .clearMintFeeConfig()
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintFeeConfig,
      })
      .rpc();
  });

  // Test 10.3: Percentage + min clamp
  it("10.3 percentage + min clamp", async () => {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // Set 0.1% (100_000) with min 2 tokens (2_000_000)
    // For 100 tokens, 0.1% = 0.1 tokens = 100_000 atomics
    // But min is 2 tokens = 2_000_000 atomics, so fee should be clamped to min
    await escrowProgram.methods
      .setMintFeeConfig(new BN(100_000), new BN(2_000_000), new BN(0))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const [depositor, delegateSigner, reserver, releaser, payer, recipient] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );

    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const amount = new BN(100_000_000); // 100 tokens
    const expectedFee = computeExpectedFeeAtoms(BigInt(100_000_000), 6, {
      feePercentage6: 100_000n,
      minFee6: 2_000_000n,
      maxFee6: 0n,
    });
    // 0.1% of 100 tokens = 0.1 tokens = 100_000 atomics
    // Min is 2 tokens = 2_000_000 atomics
    // Fee should be clamped to 2_000_000
    expect(expectedFee.toString()).to.equal("2000000");

    const { deposit, escrowAta, depositHash } = await createDeposit(
      depositor,
      delegateSigner,
      delegate,
      mint,
      mintFeeConfig,
      authorityAta,
      reserver,
      releaser,
      payer,
      amount
    );

    const depositAccount = await escrowProgram.account.depositInfo.fetch(
      deposit
    );
    expect(depositAccount.feeAmount.toString()).to.equal(
      expectedFee.toString()
    );

    // Reserve and release
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      amount.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), amount)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveSigIx(reserver, reserveMessage)])
      .rpc();

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      mint,
      treasurerKeypair.publicKey
    );
    const recipientBalanceBefore = await getBalance(
      provider.connection,
      recipientAta
    );
    const treasuryBalanceBefore = await getBalance(
      provider.connection,
      treasuryAta
    );

    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    await escrowProgram.methods
      .release()
      .accountsPartial({
        protocolConfig,
        deposit,
        escrowAta,
        recipient: recipient.publicKey,
        recipientAta,
        depositor: depositor.publicKey,
        depositorAta: authorityAta,
        treasurer: treasurerKeypair.publicKey,
        treasuryAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([releaseSigIx(releaser, releaseMessage)])
      .signers([payer])
      .rpc();

    await assertBalanceDelta(
      provider.connection,
      recipientAta,
      BigInt(amount.toString()) - expectedFee,
      recipientBalanceBefore
    );
    await assertBalanceDelta(
      provider.connection,
      treasuryAta,
      expectedFee,
      treasuryBalanceBefore
    );

    await escrowProgram.methods
      .clearMintFeeConfig()
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintFeeConfig,
      })
      .rpc();
  });

  // Test 10.4: Percentage + max clamp
  it("10.4 percentage + max clamp", async () => {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // Set 10% (10_000_000) with max 5 tokens (5_000_000)
    // For 100 tokens, 10% = 10 tokens = 10_000_000 atomics
    // But max is 5 tokens = 5_000_000 atomics, so fee should be clamped to max
    await escrowProgram.methods
      .setMintFeeConfig(new BN(10_000_000), new BN(0), new BN(5_000_000))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const [depositor, delegateSigner, reserver, releaser, payer, recipient] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );

    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const amount = new BN(100_000_000); // 100 tokens
    const expectedFee = computeExpectedFeeAtoms(BigInt(100_000_000), 6, {
      feePercentage6: 10_000_000n,
      minFee6: 0n,
      maxFee6: 5_000_000n,
    });
    // 10% of 100 tokens = 10 tokens = 10_000_000 atomics
    // Max is 5 tokens = 5_000_000 atomics
    // Fee should be clamped to 5_000_000
    expect(expectedFee.toString()).to.equal("5000000");

    const { deposit, escrowAta, depositHash } = await createDeposit(
      depositor,
      delegateSigner,
      delegate,
      mint,
      mintFeeConfig,
      authorityAta,
      reserver,
      releaser,
      payer,
      amount
    );

    const depositAccount = await escrowProgram.account.depositInfo.fetch(
      deposit
    );
    expect(depositAccount.feeAmount.toString()).to.equal(
      expectedFee.toString()
    );

    // Reserve and release
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      amount.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), amount)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveSigIx(reserver, reserveMessage)])
      .rpc();

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      mint,
      treasurerKeypair.publicKey
    );
    const recipientBalanceBefore = await getBalance(
      provider.connection,
      recipientAta
    );
    const treasuryBalanceBefore = await getBalance(
      provider.connection,
      treasuryAta
    );

    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    await escrowProgram.methods
      .release()
      .accountsPartial({
        protocolConfig,
        deposit,
        escrowAta,
        recipient: recipient.publicKey,
        recipientAta,
        depositor: depositor.publicKey,
        depositorAta: authorityAta,
        treasurer: treasurerKeypair.publicKey,
        treasuryAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([releaseSigIx(releaser, releaseMessage)])
      .signers([payer])
      .rpc();

    await assertBalanceDelta(
      provider.connection,
      recipientAta,
      BigInt(amount.toString()) - expectedFee,
      recipientBalanceBefore
    );
    await assertBalanceDelta(
      provider.connection,
      treasuryAta,
      expectedFee,
      treasuryBalanceBefore
    );

    await escrowProgram.methods
      .clearMintFeeConfig()
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintFeeConfig,
      })
      .rpc();
  });

  // Test 10.5: Percentage + min + max (within bounds)
  it("10.5 percentage + min + max within bounds", async () => {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // Set 5% (5_000_000) with min 1 token (1_000_000) and max 10 tokens (10_000_000)
    // For 100 tokens, 5% = 5 tokens = 5_000_000 atomics
    // This is between min (1) and max (10), so fee should be 5_000_000
    await escrowProgram.methods
      .setMintFeeConfig(
        new BN(5_000_000),
        new BN(1_000_000),
        new BN(10_000_000)
      )
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const [depositor, delegateSigner, reserver, releaser, payer, recipient] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );

    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const amount = new BN(100_000_000); // 100 tokens
    const expectedFee = computeExpectedFeeAtoms(BigInt(100_000_000), 6, {
      feePercentage6: 5_000_000n,
      minFee6: 1_000_000n,
      maxFee6: 10_000_000n,
    });
    // 5% of 100 tokens = 5 tokens = 5_000_000 atomics
    // This is between min (1_000_000) and max (10_000_000)
    expect(expectedFee.toString()).to.equal("5000000");

    const { deposit, escrowAta, depositHash } = await createDeposit(
      depositor,
      delegateSigner,
      delegate,
      mint,
      mintFeeConfig,
      authorityAta,
      reserver,
      releaser,
      payer,
      amount
    );

    const depositAccount = await escrowProgram.account.depositInfo.fetch(
      deposit
    );
    expect(depositAccount.feeAmount.toString()).to.equal(
      expectedFee.toString()
    );

    // Reserve and release
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      amount.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), amount)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveSigIx(reserver, reserveMessage)])
      .rpc();

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      mint,
      treasurerKeypair.publicKey
    );
    const recipientBalanceBefore = await getBalance(
      provider.connection,
      recipientAta
    );
    const treasuryBalanceBefore = await getBalance(
      provider.connection,
      treasuryAta
    );

    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    await escrowProgram.methods
      .release()
      .accountsPartial({
        protocolConfig,
        deposit,
        escrowAta,
        recipient: recipient.publicKey,
        recipientAta,
        depositor: depositor.publicKey,
        depositorAta: authorityAta,
        treasurer: treasurerKeypair.publicKey,
        treasuryAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([releaseSigIx(releaser, releaseMessage)])
      .signers([payer])
      .rpc();

    await assertBalanceDelta(
      provider.connection,
      recipientAta,
      BigInt(amount.toString()) - expectedFee,
      recipientBalanceBefore
    );
    await assertBalanceDelta(
      provider.connection,
      treasuryAta,
      expectedFee,
      treasuryBalanceBefore
    );

    await escrowProgram.methods
      .clearMintFeeConfig()
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintFeeConfig,
      })
      .rpc();
  });

  // Test 10.6: Fee snapshot stability
  it("10.6 fee snapshot is stable across config changes", async () => {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // Set initial 1% fee
    await escrowProgram.methods
      .setMintFeeConfig(new BN(1_000_000), new BN(0), new BN(0))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const [depositor, delegateSigner, reserver, releaser, payer, recipient] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );

    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const amount = new BN(100_000_000); // 100 tokens
    // Fee at deposit time: 1% of 100 = 1 token = 1_000_000 atomics
    const originalFee = computeExpectedFeeAtoms(BigInt(100_000_000), 6, {
      feePercentage6: 1_000_000n,
      minFee6: 0n,
      maxFee6: 0n,
    });

    const { deposit, escrowAta, depositHash } = await createDeposit(
      depositor,
      delegateSigner,
      delegate,
      mint,
      mintFeeConfig,
      authorityAta,
      reserver,
      releaser,
      payer,
      amount
    );

    // Verify fee was snapshotted
    const depositAccount = await escrowProgram.account.depositInfo.fetch(
      deposit
    );
    expect(depositAccount.feeAmount.toString()).to.equal(
      originalFee.toString()
    );

    // Change config to 10% fee (10_000_000)
    await escrowProgram.methods
      .setMintFeeConfig(new BN(10_000_000), new BN(0), new BN(0))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Reserve
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      amount.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), amount)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveSigIx(reserver, reserveMessage)])
      .rpc();

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      mint,
      treasurerKeypair.publicKey
    );
    const recipientBalanceBefore = await getBalance(
      provider.connection,
      recipientAta
    );
    const treasuryBalanceBefore = await getBalance(
      provider.connection,
      treasuryAta
    );

    // Release - fee should match original config (1%), not new config (10%)
    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    await escrowProgram.methods
      .release()
      .accountsPartial({
        protocolConfig,
        deposit,
        escrowAta,
        recipient: recipient.publicKey,
        recipientAta,
        depositor: depositor.publicKey,
        depositorAta: authorityAta,
        treasurer: treasurerKeypair.publicKey,
        treasuryAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([releaseSigIx(releaser, releaseMessage)])
      .signers([payer])
      .rpc();

    // Assert original fee was used (1_000_000), not new fee (10_000_000)
    await assertBalanceDelta(
      provider.connection,
      recipientAta,
      BigInt(amount.toString()) - originalFee,
      recipientBalanceBefore
    );
    await assertBalanceDelta(
      provider.connection,
      treasuryAta,
      originalFee,
      treasuryBalanceBefore
    );

    await escrowProgram.methods
      .clearMintFeeConfig()
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintFeeConfig,
      })
      .rpc();
  });

  // Test 10.7: Extra tokens are returned to the depositor
  it("10.7 extra tokens are returned to the depositor", async () => {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // Set 1% fee
    await escrowProgram.methods
      .setMintFeeConfig(new BN(1_000_000), new BN(0), new BN(0))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const [depositor, delegateSigner, reserver, releaser, payer, recipient] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );

    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const amount = new BN(50_000_000); // 50 tokens
    const expectedFee = computeExpectedFeeAtoms(BigInt(50_000_000), 6, {
      feePercentage6: 1_000_000n,
      minFee6: 0n,
      maxFee6: 0n,
    });

    const { deposit, escrowAta, depositHash } = await createDeposit(
      depositor,
      delegateSigner,
      delegate,
      mint,
      mintFeeConfig,
      authorityAta,
      reserver,
      releaser,
      payer,
      amount
    );

    // Mint extra tokens directly to escrow ATA
    const extraTokens = BigInt(10_000_000); // 10 extra tokens
    await splMintTo(
      provider.connection,
      provider.wallet.payer!,
      mint,
      escrowAta,
      provider.wallet.payer!,
      extraTokens
    );

    // Reserve
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      amount.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), amount)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveSigIx(reserver, reserveMessage)])
      .rpc();

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      mint,
      treasurerKeypair.publicKey
    );
    const recipientBalanceBefore = await getBalance(
      provider.connection,
      recipientAta
    );
    const depositorBalanceBefore = await getBalance(
      provider.connection,
      authorityAta
    );
    const treasuryBalanceBefore = await getBalance(
      provider.connection,
      treasuryAta
    );

    // Release
    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    const txSig = await escrowProgram.methods
      .release()
      .accountsPartial({
        protocolConfig,
        deposit,
        escrowAta,
        recipient: recipient.publicKey,
        recipientAta,
        depositor: depositor.publicKey,
        depositorAta: authorityAta,
        treasurer: treasurerKeypair.publicKey,
        treasuryAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([releaseSigIx(releaser, releaseMessage)])
      .signers([payer])
      .rpc();

    const releaseEvent = await findProgramEvent<any>(
      escrowProgram,
      txSig,
      "Released"
    );

    await assertBalanceDelta(
      provider.connection,
      recipientAta,
      BigInt(amount.toString()) - expectedFee,
      recipientBalanceBefore
    );
    await assertBalanceDelta(
      provider.connection,
      authorityAta,
      extraTokens,
      depositorBalanceBefore
    );
    await assertBalanceDelta(
      provider.connection,
      treasuryAta,
      expectedFee,
      treasuryBalanceBefore
    );
    expect(releaseEvent.grossAmount.toString()).to.equal(
      (BigInt(amount.toString()) + extraTokens).toString()
    );
    expect(releaseEvent.intendedAmount.toString()).to.equal(amount.toString());
    expect(releaseEvent.surplusAmount.toString()).to.equal(
      extraTokens.toString()
    );
    expect(releaseEvent.feeAmount.toString()).to.equal(expectedFee.toString());
    expect(releaseEvent.netAmount.toString()).to.equal(
      (BigInt(amount.toString()) - expectedFee).toString()
    );

    await escrowProgram.methods
      .clearMintFeeConfig()
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintFeeConfig,
      })
      .rpc();
  });

  // Test 10.8: Refund charges no fee
  it("10.8 refund charges no fee", async () => {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // Set 5% fee
    await escrowProgram.methods
      .setMintFeeConfig(new BN(5_000_000), new BN(0), new BN(0))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const [depositor, delegateSigner, reserver, releaser, payer] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );

    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const amount = new BN(50_000_000); // 50 tokens
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      mint,
      treasurerKeypair.publicKey
    );
    const treasuryBalanceBefore = await getBalance(
      provider.connection,
      treasuryAta
    );

    const { deposit, escrowAta, depositHash } = await createDeposit(
      depositor,
      delegateSigner,
      delegate,
      mint,
      mintFeeConfig,
      authorityAta,
      reserver,
      releaser,
      payer,
      amount
    );

    const depositorBalanceBefore = await getBalance(
      provider.connection,
      authorityAta
    );

    // Refund
    const refundMessage = await createMessage("refund", [
      depositHash,
      ZERO_QUOTE_HASH,
    ]);
    await escrowProgram.methods
      .refund()
      .accountsPartial({
        protocolConfig,
        deposit,
        escrowAta,
        depositor: depositor.publicKey,
        depositorAta: authorityAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([refundSigIx(releaser, refundMessage)])
      .signers([payer])
      .rpc();

    // Depositor gets full amount back (no fee deducted)
    await assertBalanceDelta(
      provider.connection,
      authorityAta,
      BigInt(amount.toString()),
      depositorBalanceBefore
    );

    // Treasury unchanged
    const treasuryBalanceAfter = await getBalance(
      provider.connection,
      treasuryAta
    );
    expect(treasuryBalanceAfter.toString()).to.equal(
      treasuryBalanceBefore.toString()
    );

    await escrowProgram.methods
      .clearMintFeeConfig()
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintFeeConfig,
      })
      .rpc();
  });

  // Test 10.9: Reject FeeExceedsAmount at deposit
  it("10.9 rejects FeeExceedsAmount at deposit", async () => {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // Set min fee of 10 tokens (10_000_000 in 6-decimal)
    // Then try to deposit 5 tokens - fee would exceed amount
    await escrowProgram.methods
      .setMintFeeConfig(new BN(0), new BN(10_000_000), new BN(0))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const [depositor, delegateSigner, reserver, releaser, payer] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );

    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const amount = new BN(5_000_000); // 5 tokens, less than min fee of 10 tokens

    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new BN(Math.floor(Date.now() / 1000) - 5);
    const deadline = new BN(issuedAt.toNumber() + 60);

    const message = await createMessage("deposit", [
      paymentId,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      amount.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAt.toBuffer("le", 8),
      deadline.toBuffer("le", 8),
    ]);
    const depositHash = message;

    const ed25519Instruction = depositSigIx(
      delegateSigner,
      message
    );

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, depositHash],
      escrowProgram.programId
    );
    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

    try {
      await escrowProgram.methods
        .deposit(
          Array.from(paymentId),
          Array.from(await destinationHash()),
          amount,
          reserver.publicKey,
          releaser.publicKey,
          nonce,
          issuedAt,
          deadline,
          Array.from(depositHash)
        )
        .accountsPartial({
          escrowDelegate: delegate,
          authority: depositor.publicKey,
          replayBucket,
          authorityAta,
          deposit,
          escrowAta,
          mint,
          protocolConfig,
          mintFeeConfig,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([depositComputeBudgetIx(), ed25519Instruction])
        .signers([payer])
        .rpc();
      expect.fail("Should have thrown FeeExceedsAmount");
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal("FeeExceedsAmount");
    }

    await escrowProgram.methods
      .clearMintFeeConfig()
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintFeeConfig,
      })
      .rpc();
  });

  // Test 10.10: the smallest taxable deposit. Named for the removed atomic fallback; since
  // Cantina F1 the step-2 ceiling is what yields the one-atom fee.
  it("10.10 smallest taxable deposit charges one atom", async () => {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // Set very small percentage: 0.0001% (10 in the scale).
    //
    // This used to read "for amount=1, fee = floor(1 * 10 / 100_000_000) = 0, but the atomic
    // fallback should make fee = 1". Since Cantina F1 the percentage step takes the CEILING to
    // match EVM/TVM, so a one-atom fee falls straight out of the arithmetic and the fallback is
    // no longer what produces it. The assertion below is unchanged because both routes give 1.
    //
    // Note that amount=1 would now be REJECTED rather than charged: ceil(1 * 10 / 1e8) = 1, and
    // the boundary check is `fee < amount` on all three VMs. Hence the 2-atom deposit below.
    await escrowProgram.methods
      .setMintFeeConfig(new BN(10), new BN(0), new BN(0))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const [depositor, delegateSigner, reserver, releaser, payer, recipient] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );

    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    // Deposit 2 atomics (minimum to allow fee=1 and still have recipient > 0)
    const amount = new BN(2);
    const expectedFee = computeExpectedFeeAtoms(BigInt(2), 6, {
      feePercentage6: 10n,
      minFee6: 0n,
      maxFee6: 0n,
    });
    // The step-2 ceiling yields 1, not the removed fallback: ceil(2 * 10 / 1e8) = 1.
    expect(expectedFee.toString()).to.equal("1");

    const { deposit, escrowAta, depositHash } = await createDeposit(
      depositor,
      delegateSigner,
      delegate,
      mint,
      mintFeeConfig,
      authorityAta,
      reserver,
      releaser,
      payer,
      amount
    );

    const depositAccount = await escrowProgram.account.depositInfo.fetch(
      deposit
    );
    expect(depositAccount.feeAmount.toString()).to.equal("1");

    // Reserve and release
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      amount.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), amount)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveSigIx(reserver, reserveMessage)])
      .rpc();

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      mint,
      treasurerKeypair.publicKey
    );
    const recipientBalanceBefore = await getBalance(
      provider.connection,
      recipientAta
    );
    const treasuryBalanceBefore = await getBalance(
      provider.connection,
      treasuryAta
    );

    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    await escrowProgram.methods
      .release()
      .accountsPartial({
        protocolConfig,
        deposit,
        escrowAta,
        recipient: recipient.publicKey,
        recipientAta,
        depositor: depositor.publicKey,
        depositorAta: authorityAta,
        treasurer: treasurerKeypair.publicKey,
        treasuryAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([releaseSigIx(releaser, releaseMessage)])
      .signers([payer])
      .rpc();

    // Recipient gets amount - fee = 2 - 1 = 1
    await assertBalanceDelta(
      provider.connection,
      recipientAta,
      1n,
      recipientBalanceBefore
    );
    // Treasury gets fee = 1
    await assertBalanceDelta(
      provider.connection,
      treasuryAta,
      1n,
      treasuryBalanceBefore
    );

    await escrowProgram.methods
      .clearMintFeeConfig()
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintFeeConfig,
      })
      .rpc();
  });

  // Test 10.11: Reject fee > 100%
  it("10.11 rejects fee_percentage_6 > 100%", async () => {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;

    try {
      await escrowProgram.methods
        .setMintFeeConfig(new BN(100_000_001), new BN(0), new BN(0))
        .accountsPartial({
          tokenConfigAuthority: provider.wallet.publicKey,
          protocolConfig,
          mintAccount: mint,
          mintFeeConfig,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("Should have thrown FeePercentageTooHigh");
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal("FeePercentageTooHigh");
    }
  });

  // Test 10.12: Reject min > max
  it("10.12 rejects min_fee_6 > max_fee_6", async () => {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;

    try {
      await escrowProgram.methods
        .setMintFeeConfig(
          new BN(1_000_000),
          new BN(2_000_000),
          new BN(1_000_000)
        )
        .accountsPartial({
          tokenConfigAuthority: provider.wallet.publicKey,
          protocolConfig,
          mintAccount: mint,
          mintFeeConfig,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("Should have thrown MinFeeGreaterThanMaxFee");
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal("MinFeeGreaterThanMaxFee");
    }
  });

  // Test 10.13: Reject max without percentage
  it("10.13 rejects max_fee_6 > 0 without percentage", async () => {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;

    try {
      await escrowProgram.methods
        .setMintFeeConfig(new BN(0), new BN(0), new BN(1_000_000))
        .accountsPartial({
          tokenConfigAuthority: provider.wallet.publicKey,
          protocolConfig,
          mintAccount: mint,
          mintFeeConfig,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("Should have thrown MaxFeeSetButPercentageZero");
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal("MaxFeeSetButPercentageZero");
    }
  });

  // Test 10.14: Reject non-allowlisted mint at delegate creation
  it("10.14 rejects createDelegate when mint not allowlisted", async () => {
    // Create mint with skipAllowlist: true (not allowlisted)
    const { mint: nonAllowedMint, authorityTokenAccount: mainAuthorityAta } =
      await setupMintAndFund(6, BigInt(1_000_000_000), true);

    const [depositor, delegateSigner, _reserver, _releaser, payer] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      nonAllowedMint,
      depositor.publicKey
    );

    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const ESCROW_DELEGATE_SEED = Buffer.from("escrow_delegate");
    const [delegate] = PublicKey.findProgramAddressSync(
      [
        ESCROW_DELEGATE_SEED,
        depositor.publicKey.toBuffer(),
        nonAllowedMint.toBuffer(),
      ],
      escrowProgram.programId
    );
    const mintFeeConfig = getMintFeeConfigAddress(
      nonAllowedMint,
      escrowProgram.programId
    );

    const expiration = new BN(Math.floor(Date.now() / 1000) + 1 * 24 * 60 * 60);

    try {
      await escrowProgram.methods
        .createDelegate(
          delegateSigner.publicKey,
          DELEGATE_CAPACITY,
          MAX_TRANSFER_SIZE,
          expiration
        )
        .accountsPartial({
          protocolConfig,
          authority: depositor.publicKey,
          escrowDelegate: delegate,
          authorityAta,
          mint: nonAllowedMint,
          mintFeeConfig,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([depositor, payer])
        .rpc();
      expect.fail("Should have thrown MintNotAllowed");
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal("MintNotAllowed");
    }

    const delegateAccountInfo = await provider.connection.getAccountInfo(
      delegate
    );
    expect(delegateAccountInfo).to.equal(null);
  });

  // CORE-2022 Solana parity (CORE-1887). The sweep that added `source_amount` to every existing
  // reserve call passes each site's own deposit amount, so those tests keep asserting exactly what
  // they asserted before. This is the case that exercises the behaviour that is actually NEW:
  // reserving LESS than was deposited.
  it("10.15 charges the quote's source_amount, not the payer's ceiling, and scales the fee to it", async () => {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // 1% fee, no min/max clamp.
    await escrowProgram.methods
      .setMintFeeConfig(new BN(1_000_000), new BN(0), new BN(0))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const [depositor, delegateSigner, reserver, releaser, payer, recipient] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );

    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    // The payer authorizes a CEILING of 100 tokens...
    const ceiling = new BN(100_000_000);
    // ...but the winning quote only charges 90.
    const charge = new BN(90_000_000);

    const { deposit, depositHash } = await createDeposit(
      depositor,
      delegateSigner,
      delegate,
      mint,
      mintFeeConfig,
      authorityAta,
      reserver,
      releaser,
      payer,
      ceiling
    );

    // At deposit time the escrow holds the ceiling and the fee is computed over it — the
    // pre-CORE-2022 state, and what the payer would have been charged.
    const beforeReserve = await escrowProgram.account.depositInfo.fetch(deposit);
    expect(beforeReserve.amount.toString()).to.equal(ceiling.toString());
    expect(beforeReserve.feeAmount.toString()).to.equal(
      computeExpectedFeeAtoms(BigInt(100_000_000), 6, {
        feePercentage6: 1_000_000n,
        minFee6: 0n,
        maxFee6: 0n,
      }).toString()
    );

    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      charge.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), charge)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveSigIx(reserver, reserveMessage)])
      .rpc();

    const afterReserve = await escrowProgram.account.depositInfo.fetch(deposit);

    // The charge, not the ceiling.
    expect(afterReserve.amount.toString()).to.equal(charge.toString());

    // And the fee follows the charge. Scaled from the deposit-time fee, so the RATE stays
    // frozen at deposit (see 10.6) — with no clamp in play that equals determineFee(charge).
    // This is the assertion most likely to regress silently:
    // `release` pays the settler `deposit.amount - fee_amount`, so a fee left computed over the
    // ceiling would quietly underpay them while every other assertion here still passed.
    expect(afterReserve.feeAmount.toString()).to.equal(
      computeExpectedFeeAtoms(BigInt(90_000_000), 6, {
        feePercentage6: 1_000_000n,
        minFee6: 0n,
        maxFee6: 0n,
      }).toString()
    );
    expect(afterReserve.feeAmount.lt(beforeReserve.feeAmount)).to.equal(true);
  });

  it("10.16 refuses a source_amount above what the depositor authorized", async () => {
    // The bound that keeps the reserver from spending more of the payer's authorization than they
    // gave. Without it the ceiling would be advisory.
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // 1% fee, no min/max clamp.
    await escrowProgram.methods
      .setMintFeeConfig(new BN(1_000_000), new BN(0), new BN(0))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const [depositor, delegateSigner, reserver, releaser, payer, recipient] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );
    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const ceiling = new BN(100_000_000);
    const tooMuch = new BN(100_000_001);

    const { deposit, depositHash } = await createDeposit(
      depositor,
      delegateSigner,
      delegate,
      mint,
      mintFeeConfig,
      authorityAta,
      reserver,
      releaser,
      payer,
      ceiling
    );

    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      tooMuch.toBuffer("le", 8),
    ]);

    try {
      await escrowProgram.methods
        .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), tooMuch)
        .accountsPartial({
          deposit,
          protocolConfig,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([reserveSigIx(reserver, reserveMessage)])
        .rpc();
      expect.fail("Should have thrown SourceAmountExceedsDeposit");
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal("SourceAmountExceedsDeposit");
    }
  });

  it("10.17 refuses a reserve signature that authorized a different charge", async () => {
    // source_amount is inside the reserver-signed preimage precisely so the settler cannot pick
    // it. Signing 90 and submitting 80 must not verify — otherwise the field would be decorative.
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // 1% fee, no min/max clamp.
    await escrowProgram.methods
      .setMintFeeConfig(new BN(1_000_000), new BN(0), new BN(0))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const [depositor, delegateSigner, reserver, releaser, payer, recipient] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );
    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(200_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const { deposit, depositHash } = await createDeposit(
      depositor,
      delegateSigner,
      delegate,
      mint,
      mintFeeConfig,
      authorityAta,
      reserver,
      releaser,
      payer,
      new BN(100_000_000)
    );

    // Signed for 90...
    const signedFor = new BN(90_000_000);
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      signedFor.toBuffer("le", 8),
    ]);

    try {
      // ...submitted for 80.
      await escrowProgram.methods
        .reserve(
          recipient.publicKey,
          Array.from(DEFAULT_QUOTE_HASH),
          new BN(80_000_000)
        )
        .accountsPartial({
          deposit,
          protocolConfig,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([reserveSigIx(reserver, reserveMessage)])
        .rpc();
      expect.fail("Should have rejected the mismatched reserve signature");
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal("InvalidMessage");
    }
  });

});
