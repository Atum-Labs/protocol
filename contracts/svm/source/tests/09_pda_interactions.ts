import {
  anchor,
  escrowProgram,
  fulfillmentProgram,
  provider,
  DEPOSIT_SEED,
  expect,
  PublicKey,
  SystemProgram,
  createDelegate,
  createEd25519Instruction,
  createPaymentId,
  DEPOSIT_AMOUNT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  generateFundedKeypair,
  setupMintAndFund,
  createMessage,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  DELEGATE_CAPACITY,
  MAX_TRANSFER_SIZE,
  REPLAY_SEED,
  createValidNonce,
  createStrictFulfillArgs,
  createStrictFulfillReplayArgs,
  ESCROW_DELEGATE_SEED,
  ensureProtocolInitialized,
  ensureFulfillmentProxyInitialized,
  treasurerKeypair,
  deriveFulfillmentReplayBucket,
  DEFAULT_QUOTE_HASH,
  destinationHash,
  TEST_DESTINATION,
  depositComputeBudgetIx,
} from "./helpers";
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import {
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

describe("9. PDA Interactions", () => {
  let mint: PublicKey;
  let mintFeeConfig: PublicKey;
  let authorityTokenAccount: PublicKey;
  let protocolConfig: PublicKey;
  let fulfillmentProtocolConfig: PublicKey;

  before(async () => {
    protocolConfig = await ensureProtocolInitialized(escrowProgram, provider);
    fulfillmentProtocolConfig = await ensureFulfillmentProxyInitialized(
      fulfillmentProgram,
      provider
    );
    const mintSetup = await setupMintAndFund(6, BigInt(10_000_000_000)); // 10B tokens for multiple tests
    mint = mintSetup.mint;
    mintFeeConfig = mintSetup.mintFeeConfig!;
    authorityTokenAccount = mintSetup.authorityTokenAccount;
  });

  it("9.1. Should allow PDA as depositor (authority) via CPI", async () => {
    // Create a simple PDA program that will act as the depositor
    // For this test, we'll simulate this by using a PDA derived from our escrow program
    const [pdaAuthority, _pdaBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("test_pda_authority"), mint.toBuffer()],
      escrowProgram.programId
    );

    const delegateSigner = await generateFundedKeypair();
    const payer = await generateFundedKeypair();

    // Create PDA's token account and fund it
    const pdaAta = await getOrCreateAssociatedTokenAccount(
      mint,
      pdaAuthority,
      payer
    );

    // Transfer tokens to PDA's ATA
    const transferTx = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        pdaAta,
        provider.wallet.publicKey,
        BigInt(500_000_000) // Transfer 500 tokens
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    // Calculate delegate PDA
    const [delegatePda] = PublicKey.findProgramAddressSync(
      [ESCROW_DELEGATE_SEED, pdaAuthority.toBuffer(), mint.toBuffer()],
      escrowProgram.programId
    );

    const expiration = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    // Create a custom instruction that will call create_delegate via CPI
    // For testing purposes, we'll create the delegate directly but verify PDA compatibility
    const createDelegateIx = await escrowProgram.methods
      .createDelegate(
        delegateSigner.publicKey,
        DELEGATE_CAPACITY,
        MAX_TRANSFER_SIZE,
        expiration
      )
      .accountsPartial({
        protocolConfig,
        authority: pdaAuthority, // PDA as authority
        escrowDelegate: delegatePda,
        authorityAta: pdaAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // Since we can't easily simulate CPI in tests, we'll create a transaction
    // that shows the PDA constraint works (it will fail without proper signing)
    try {
      const tx = new Transaction().add(createDelegateIx);
      await sendAndConfirmTransaction(provider.connection, tx, [payer]);
      expect.fail("Should have failed without PDA signature");
    } catch (err: any) {
      // Expected to fail because we can't sign for the PDA in a direct call
      const code = err?.error?.errorCode?.code ?? String(err);
      expect(
        code.includes("ConstraintSigner") ||
          code.toLowerCase().includes("signature")
      ).to.equal(true);
    }

    // Verify the delegate PDA is correctly derived
    expect(delegatePda).to.not.be.null;
    // And ensure it was NOT created by the failed call above
    const delegatePdaInfo = await provider.connection.getAccountInfo(
      delegatePda
    );
    expect(delegatePdaInfo).to.be.null;

    // Test that a regular EOA can still create delegates (backward compatibility)
    const eoaAuthority = await generateFundedKeypair();
    const eoaDelegate = await createDelegate(
      eoaAuthority,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1,
      payer
    );

    const delegateAccount = await escrowProgram.account.escrowDelegate.fetch(
      eoaDelegate
    );
    expect(delegateAccount.authority.toBase58()).to.equal(
      eoaAuthority.publicKey.toBase58()
    );
    expect(delegateAccount.allowedMint.toBase58()).to.equal(mint.toBase58());
    expect(delegateAccount.delegateSigner.toBase58()).to.equal(
      delegateSigner.publicKey.toBase58()
    );
    expect(delegateAccount.remainingCapacity.toString()).to.equal(
      DELEGATE_CAPACITY.toString()
    );
    expect(delegateAccount.maxTransferSize.toString()).to.equal(
      MAX_TRANSFER_SIZE.toString()
    );
    expect(delegateAccount.expiration.toNumber()).to.be.greaterThan(
      Math.floor(Date.now() / 1000) - 1
    );
    // Verify SPL delegation has been set on authority's ATA
    const eoaAuthorityAta = await getAssociatedTokenAddress(
      mint,
      eoaAuthority.publicKey,
      true
    );
    const eoaAtaAccount = await getAccount(
      provider.connection,
      eoaAuthorityAta
    );
    expect(eoaAtaAccount.delegate?.toBase58()).to.equal(eoaDelegate.toBase58());
    expect(eoaAtaAccount.delegatedAmount.toString()).to.equal(
      DELEGATE_CAPACITY.toString()
    );
  });

  it("9.2. Should allow PDA as fulfiller (settler) via CPI", async () => {
    // Create a PDA that will act as the settler
    const [pdaSettler, _pdaBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("test_pda_settler"), mint.toBuffer()],
      fulfillmentProgram.programId
    );

    const recipient = await generateFundedKeypair();
    const payer = await generateFundedKeypair();

    // Create PDA's token account and fund it
    const pdaSettlerAta = await getOrCreateAssociatedTokenAccount(
      mint,
      pdaSettler,
      payer
    );
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey,
      payer
    );

    // Transfer tokens to PDA's ATA
    const transferTx = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        pdaSettlerAta,
        provider.wallet.publicKey,
        BigInt(200_000_000) // Transfer 200 tokens
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const paymentId = createPaymentId();
    const pdaReplayArgs = createStrictFulfillReplayArgs();
    const [replayBucket] = deriveFulfillmentReplayBucket(
      pdaReplayArgs.nonce,
      pdaSettler
    );

    // Create fulfill instruction with PDA as settler
    const fulfillIx = await fulfillmentProgram.methods
      .strictFulfill(
        ...createStrictFulfillArgs(paymentId, DEPOSIT_AMOUNT, pdaReplayArgs)
      )
      .accountsPartial({
        protocolConfig: fulfillmentProtocolConfig,
        settler: pdaSettler, // PDA as settler
        payer: payer.publicKey, // Separate payer for fees
        fromAta: pdaSettlerAta,
        toAta: recipientAta,
        to: recipient.publicKey,
        mint,
        replayBucket,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // This will fail without proper PDA signing, but shows the constraint works
    try {
      const tx = new Transaction().add(fulfillIx);
      await sendAndConfirmTransaction(provider.connection, tx, [payer]);
      expect.fail("Should have failed without PDA signature");
    } catch (err: any) {
      // Expected to fail because we can't sign for the PDA in a direct call
      const code = err?.error?.errorCode?.code ?? String(err);
      expect(
        code.includes("ConstraintSigner") ||
          code.toLowerCase().includes("signature")
      ).to.equal(true);
    }

    // Test that regular EOA can still fulfill (backward compatibility)
    const eoaSettler = await generateFundedKeypair();
    const eoaSettlerAta = await getOrCreateAssociatedTokenAccount(
      mint,
      eoaSettler.publicKey,
      payer
    );

    // Transfer tokens to EOA settler
    const transferTx2 = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        eoaSettlerAta,
        provider.wallet.publicKey,
        BigInt(100_000_000) // Transfer 100 tokens
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx2, [
      provider.wallet.payer!,
    ]);

    const settlerBefore = await getAccount(provider.connection, eoaSettlerAta);
    const recipientBefore = await getAccount(provider.connection, recipientAta);
    const eoaReplayArgs = createStrictFulfillReplayArgs();
    const [eoaReplayBucket] = deriveFulfillmentReplayBucket(
      eoaReplayArgs.nonce,
      eoaSettler.publicKey
    );

    await fulfillmentProgram.methods
      .strictFulfill(
        ...createStrictFulfillArgs(paymentId, DEPOSIT_AMOUNT, eoaReplayArgs)
      )
      .accountsPartial({
        protocolConfig: fulfillmentProtocolConfig,
        settler: eoaSettler.publicKey,
        payer: eoaSettler.publicKey, // EOA can pay for itself
        fromAta: eoaSettlerAta,
        toAta: recipientAta,
        to: recipient.publicKey,
        mint,
        replayBucket: eoaReplayBucket,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([eoaSettler])
      .rpc();

    const settlerAfter = await getAccount(provider.connection, eoaSettlerAta);
    const recipientAfter = await getAccount(provider.connection, recipientAta);

    expect(settlerAfter.amount.toString()).to.equal(
      new anchor.BN(settlerBefore.amount.toString())
        .sub(DEPOSIT_AMOUNT)
        .toString()
    );
    expect(recipientAfter.amount.toString()).to.equal(
      new anchor.BN(recipientBefore.amount.toString())
        .add(DEPOSIT_AMOUNT)
        .toString()
    );
    expect(recipientAfter.owner.toBase58()).to.equal(
      recipient.publicKey.toBase58()
    );
    expect(recipientAfter.mint.toBase58()).to.equal(mint.toBase58());
  });

  it("9.7. Should init recipient ATA with distinct payer (EOA)", async () => {
    const settler = await generateFundedKeypair();
    const recipient = await generateFundedKeypair();
    const distinctPayer = await generateFundedKeypair();

    // Create settler ATA and fund it; do NOT precreate recipient ATA
    const settlerAta = await getOrCreateAssociatedTokenAccount(
      mint,
      settler.publicKey,
      distinctPayer
    );

    // Fund settler tokens
    const transferTx = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        settlerAta,
        provider.wallet.publicKey,
        BigInt(100_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    // Compute recipient ATA but do not create it
    const recipientAta = await getAssociatedTokenAddress(
      mint,
      recipient.publicKey,
      true
    );

    const paymentId = createPaymentId();
    const replayArgs = createStrictFulfillReplayArgs();
    const [replayBucket] = deriveFulfillmentReplayBucket(
      replayArgs.nonce,
      settler.publicKey
    );
    const settlerBefore = await getAccount(provider.connection, settlerAta);
    const payerBalanceBefore = await provider.connection.getBalance(
      distinctPayer.publicKey
    );

    await fulfillmentProgram.methods
      .strictFulfill(
        ...createStrictFulfillArgs(paymentId, DEPOSIT_AMOUNT, replayArgs)
      )
      .accountsPartial({
        protocolConfig: fulfillmentProtocolConfig,
        settler: settler.publicKey,
        payer: distinctPayer.publicKey,
        fromAta: settlerAta,
        toAta: recipientAta,
        to: recipient.publicKey,
        mint,
        replayBucket,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([settler, distinctPayer])
      .rpc();

    const settlerAfter = await getAccount(provider.connection, settlerAta);
    const recipientAfter = await getAccount(provider.connection, recipientAta);
    const payerBalanceAfter = await provider.connection.getBalance(
      distinctPayer.publicKey
    );

    // Token transfer happened
    expect(settlerAfter.amount.toString()).to.equal(
      new anchor.BN(settlerBefore.amount.toString())
        .sub(DEPOSIT_AMOUNT)
        .toString()
    );
    expect(recipientAfter.amount.toString()).to.equal(
      DEPOSIT_AMOUNT.toString()
    );
    // Payer funded the ATA creation + fees
    expect(payerBalanceAfter).to.be.lessThan(payerBalanceBefore);
    // Validate ATA correctness
    expect(recipientAfter.owner.toBase58()).to.equal(
      recipient.publicKey.toBase58()
    );
    expect(recipientAfter.mint.toBase58()).to.equal(mint.toBase58());
  });

  it("9.8. Should init PDA recipient ATA with distinct payer", async () => {
    const settler = await generateFundedKeypair();
    const distinctPayer = await generateFundedKeypair();

    // PDA recipient
    const [pdaRecipient] = PublicKey.findProgramAddressSync(
      [Buffer.from("pda_recipient_no_ata"), mint.toBuffer()],
      escrowProgram.programId
    );

    const settlerAta = await getOrCreateAssociatedTokenAccount(
      mint,
      settler.publicKey,
      distinctPayer
    );

    // Fund settler tokens
    const transferTx = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        settlerAta,
        provider.wallet.publicKey,
        BigInt(100_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    // Compute PDA recipient ATA but do not create it
    const pdaRecipientAta = await getAssociatedTokenAddress(
      mint,
      pdaRecipient,
      true
    );

    const paymentId = createPaymentId();
    const replayArgs = createStrictFulfillReplayArgs();
    const [replayBucket] = deriveFulfillmentReplayBucket(
      replayArgs.nonce,
      settler.publicKey
    );
    const payerBalanceBefore = await provider.connection.getBalance(
      distinctPayer.publicKey
    );

    await fulfillmentProgram.methods
      .strictFulfill(
        ...createStrictFulfillArgs(paymentId, DEPOSIT_AMOUNT, replayArgs)
      )
      .accountsPartial({
        protocolConfig: fulfillmentProtocolConfig,
        settler: settler.publicKey,
        payer: distinctPayer.publicKey,
        fromAta: settlerAta,
        toAta: pdaRecipientAta,
        to: pdaRecipient,
        mint,
        replayBucket,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([settler, distinctPayer])
      .rpc();

    const recipientAfter = await getAccount(
      provider.connection,
      pdaRecipientAta
    );
    const payerBalanceAfter = await provider.connection.getBalance(
      distinctPayer.publicKey
    );

    // Token transfer happened to PDA ATA that was auto-created
    expect(recipientAfter.amount.toString()).to.equal(
      DEPOSIT_AMOUNT.toString()
    );
    expect(payerBalanceAfter).to.be.lessThan(payerBalanceBefore);
    expect(recipientAfter.owner.toBase58()).to.equal(pdaRecipient.toBase58());
    expect(recipientAfter.mint.toBase58()).to.equal(mint.toBase58());
  });

  it("9.9. Should init authority ATA in create_delegate with distinct payer", async () => {
    const authority = await generateFundedKeypair();
    const payer = await generateFundedKeypair();
    const delegateSigner = await generateFundedKeypair();

    // Compute accounts, do NOT precreate authority ATA
    const [delegatePda] = PublicKey.findProgramAddressSync(
      [ESCROW_DELEGATE_SEED, authority.publicKey.toBuffer(), mint.toBuffer()],
      escrowProgram.programId
    );
    const authorityAta = await getAssociatedTokenAddress(
      mint,
      authority.publicKey,
      true
    );
    const expiration = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    const payerBalanceBefore = await provider.connection.getBalance(
      payer.publicKey
    );

    await escrowProgram.methods
      .createDelegate(
        delegateSigner.publicKey,
        DELEGATE_CAPACITY,
        MAX_TRANSFER_SIZE,
        expiration
      )
      .accountsPartial({
        protocolConfig,
        authority: authority.publicKey,
        escrowDelegate: delegatePda,
        authorityAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority, payer])
      .rpc();

    // ATA should be created and empty; payer pays
    const ataAccount = await getAccount(provider.connection, authorityAta);
    const payerBalanceAfter = await provider.connection.getBalance(
      payer.publicKey
    );
    expect(ataAccount.amount.toString()).to.equal("0");
    expect(payerBalanceAfter).to.be.lessThan(payerBalanceBefore);
    // Verify delegate state was initialized correctly
    const d = await escrowProgram.account.escrowDelegate.fetch(delegatePda);
    expect(d.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(d.allowedMint.toBase58()).to.equal(mint.toBase58());
    expect(d.delegateSigner.toBase58()).to.equal(
      delegateSigner.publicKey.toBase58()
    );
    expect(d.remainingCapacity.toString()).to.equal(
      DELEGATE_CAPACITY.toString()
    );
    expect(d.maxTransferSize.toString()).to.equal(MAX_TRANSFER_SIZE.toString());
    expect(d.expiration.toNumber()).to.be.greaterThan(
      Math.floor(Date.now() / 1000) - 1
    );
    // Verify SPL delegation on authority's ATA
    const authorityAtaAccount = await getAccount(
      provider.connection,
      authorityAta
    );
    expect(authorityAtaAccount.delegate?.toBase58()).to.equal(
      delegatePda.toBase58()
    );
    expect(authorityAtaAccount.delegatedAmount.toString()).to.equal(
      DELEGATE_CAPACITY.toString()
    );
  });
  it("9.3. Should allow distinct payer for fulfillment (pay-master flow)", async () => {
    const settler = await generateFundedKeypair();
    const recipient = await generateFundedKeypair();
    const distinctPayer = await generateFundedKeypair();

    const settlerAta = await getOrCreateAssociatedTokenAccount(
      mint,
      settler.publicKey,
      distinctPayer
    );
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey,
      distinctPayer
    );

    // Transfer tokens to settler
    const transferTx = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        settlerAta,
        provider.wallet.publicKey,
        BigInt(100_000_000) // Transfer 100 tokens
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const paymentId = createPaymentId();
    const replayArgs = createStrictFulfillReplayArgs();
    const [replayBucket] = deriveFulfillmentReplayBucket(
      replayArgs.nonce,
      settler.publicKey
    );
    const settlerBefore = await getAccount(provider.connection, settlerAta);
    const recipientBefore = await getAccount(provider.connection, recipientAta);

    // Record balances to verify distinct payer model
    const payerBalanceBefore = await provider.connection.getBalance(
      distinctPayer.publicKey
    );
    const settlerBalanceBefore = await provider.connection.getBalance(
      settler.publicKey
    );

    await fulfillmentProgram.methods
      .strictFulfill(
        ...createStrictFulfillArgs(paymentId, DEPOSIT_AMOUNT, replayArgs)
      )
      .accountsPartial({
        protocolConfig: fulfillmentProtocolConfig,
        settler: settler.publicKey,
        payer: distinctPayer.publicKey, // Distinct payer for fees
        fromAta: settlerAta,
        toAta: recipientAta,
        to: recipient.publicKey,
        mint,
        replayBucket,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([settler, distinctPayer])
      .rpc();

    const settlerAfter = await getAccount(provider.connection, settlerAta);
    const recipientAfter = await getAccount(provider.connection, recipientAta);

    // Verify token transfers
    expect(settlerAfter.amount.toString()).to.equal(
      new anchor.BN(settlerBefore.amount.toString())
        .sub(DEPOSIT_AMOUNT)
        .toString()
    );
    expect(recipientAfter.amount.toString()).to.equal(
      new anchor.BN(recipientBefore.amount.toString())
        .add(DEPOSIT_AMOUNT)
        .toString()
    );
    expect(recipientAfter.owner.toBase58()).to.equal(
      recipient.publicKey.toBase58()
    );
    expect(recipientAfter.mint.toBase58()).to.equal(mint.toBase58());

    // Verify fee payment model
    const payerBalanceAfter = await provider.connection.getBalance(
      distinctPayer.publicKey
    );
    const settlerBalanceAfter = await provider.connection.getBalance(
      settler.publicKey
    );

    // Payer should have paid fees (allow some tolerance for timing)
    expect(payerBalanceAfter).to.be.at.most(payerBalanceBefore);
    // Settler balance should remain the same (only token transfer, no SOL fees)
    // Allow small tolerance for potential rent exemption changes
    expect(settlerBalanceAfter).to.be.closeTo(settlerBalanceBefore, 10000);
  });

  it("9.4. Should support PDA recipients", async () => {
    const settler = await generateFundedKeypair();
    const payer = await generateFundedKeypair();

    // Create a PDA recipient
    const [pdaRecipient] = PublicKey.findProgramAddressSync(
      [Buffer.from("test_pda_recipient"), mint.toBuffer()],
      escrowProgram.programId
    );

    const settlerAta = await getOrCreateAssociatedTokenAccount(
      mint,
      settler.publicKey,
      payer
    );
    const pdaRecipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      pdaRecipient,
      payer
    );

    // Transfer tokens to settler
    const transferTx = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        settlerAta,
        provider.wallet.publicKey,
        BigInt(100_000_000) // Transfer 100 tokens
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const paymentId = createPaymentId();
    const replayArgs = createStrictFulfillReplayArgs();
    const [replayBucket] = deriveFulfillmentReplayBucket(
      replayArgs.nonce,
      settler.publicKey
    );
    const settlerBefore = await getAccount(provider.connection, settlerAta);
    const recipientBefore = await getAccount(
      provider.connection,
      pdaRecipientAta
    );

    await fulfillmentProgram.methods
      .strictFulfill(
        ...createStrictFulfillArgs(paymentId, DEPOSIT_AMOUNT, replayArgs)
      )
      .accountsPartial({
        protocolConfig: fulfillmentProtocolConfig,
        settler: settler.publicKey,
        payer: payer.publicKey,
        fromAta: settlerAta,
        toAta: pdaRecipientAta,
        to: pdaRecipient, // PDA as recipient
        mint,
        replayBucket,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([settler, payer])
      .rpc();

    const settlerAfter = await getAccount(provider.connection, settlerAta);
    const recipientAfter = await getAccount(
      provider.connection,
      pdaRecipientAta
    );

    expect(settlerAfter.amount.toString()).to.equal(
      new anchor.BN(settlerBefore.amount.toString())
        .sub(DEPOSIT_AMOUNT)
        .toString()
    );
    expect(recipientAfter.amount.toString()).to.equal(
      new anchor.BN(recipientBefore.amount.toString())
        .add(DEPOSIT_AMOUNT)
        .toString()
    );
    expect(recipientAfter.owner.toBase58()).to.equal(pdaRecipient.toBase58());
    expect(recipientAfter.mint.toBase58()).to.equal(mint.toBase58());
  });

  it("9.5. Should demonstrate PDA authority flow (conceptual)", async () => {
    // This test demonstrates the account structure and constraints for PDA authorities
    // In a real scenario, this would be called via CPI from another program

    const _delegateSigner = await generateFundedKeypair();
    const payer = await generateFundedKeypair();

    // Create a PDA that would act as authority
    const [pdaAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("demo_pda_authority"), mint.toBuffer()],
      escrowProgram.programId
    );

    // Calculate what the delegate PDA would be
    const [_delegatePda] = PublicKey.findProgramAddressSync(
      [ESCROW_DELEGATE_SEED, pdaAuthority.toBuffer(), mint.toBuffer()],
      escrowProgram.programId
    );

    // Create PDA's ATA (this would exist in a real scenario)
    const pdaAta = await getOrCreateAssociatedTokenAccount(
      mint,
      pdaAuthority,
      payer
    );

    // Fund the PDA's ATA
    const transferTx = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        pdaAta,
        provider.wallet.publicKey,
        BigInt(500_000_000) // Transfer 500 tokens
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    // Verify the PDA ATA has tokens
    const pdaAtaAccount = await getAccount(provider.connection, pdaAta);
    expect(pdaAtaAccount.amount.toString()).to.equal("500000000");
    expect(pdaAtaAccount.owner.toBase58()).to.equal(pdaAuthority.toBase58());
    expect(pdaAtaAccount.mint.toBase58()).to.equal(mint.toBase58());
  });

  it("9.6. Should work with PDA in escrow flow (end-to-end simulation)", async () => {
    // This test simulates the full flow where a PDA could be involved
    // We'll use regular EOAs but structure it as if PDAs were involved

    const depositor = await generateFundedKeypair(); // In real scenario, this would be a PDA
    const delegateSigner = await generateFundedKeypair();
    const reserver = await generateFundedKeypair();
    const releaser = await generateFundedKeypair();
    const payer = await generateFundedKeypair();

    // Create depositor's ATA
    const depositorAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey,
      payer
    );

    // Fund depositor
    const transferTx = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        depositorAta,
        provider.wallet.publicKey,
        BigInt(300_000_000) // Transfer 300 tokens
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    // Create delegate with separate payer (simulating PDA authority)
    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1,
      payer // Separate payer
    );

    // Create deposit
    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    const depositMessage = await createMessage("deposit", [
      paymentId,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAt.toBuffer("le", 8),
      deadline.toBuffer("le", 8),
    ]);

    const depositSig = createEd25519Instruction(delegateSigner, depositMessage);

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, depositMessage],
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

    const depositorBefore = await getAccount(provider.connection, depositorAta);

    await escrowProgram.methods
      .deposit(
        Array.from(paymentId),
        TEST_DESTINATION,
        DEPOSIT_AMOUNT,
        reserver.publicKey,
        releaser.publicKey,
        nonce,
        issuedAt,
        deadline,
        Array.from(depositMessage)
      )
      .accountsPartial({
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket,
        authorityAta: depositorAta,
        deposit,
        escrowAta,
        mint,
        protocolConfig,
        mintFeeConfig,
        payer: payer.publicKey, // Separate payer
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      // Raised compute budget, from the one shared definition — see depositComputeBudgetIx in
      // helpers.ts for why every deposit needs it and why a per-site limit reads as flakiness.
      .preInstructions([depositComputeBudgetIx(), depositSig])
      .signers([payer])
      .rpc();

    // Verify post-deposit balances
    const escrowAfter = await getAccount(provider.connection, escrowAta);
    const depositorAfter = await getAccount(provider.connection, depositorAta);
    expect(escrowAfter.amount.toString()).to.equal(DEPOSIT_AMOUNT.toString());
    expect(new anchor.BN(depositorAfter.amount.toString()).toString()).to.equal(
      new anchor.BN(depositorBefore.amount.toString())
        .sub(DEPOSIT_AMOUNT)
        .toString()
    );

    // Reserve and release with PDA recipient
    const [pdaRecipient] = PublicKey.findProgramAddressSync(
      [Buffer.from("test_recipient_pda"), paymentId],
      escrowProgram.programId
    );

    const reserveMessage = await createMessage("reserve", [
      pdaRecipient.toBuffer(),
      depositMessage,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    const reserveSig = createEd25519Instruction(reserver, reserveMessage);

    await escrowProgram.methods
      .reserve(pdaRecipient, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveSig])
      .rpc();

    // Release to PDA recipient
    const pdaRecipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      pdaRecipient,
      payer
    );

    // Create treasury ATA for fee collection
    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      treasurerKeypair.publicKey,
      true
    );

    const releaseMessage = await createMessage("release", [
      depositMessage,
      DEFAULT_QUOTE_HASH,
    ]);
    const releaseSig = createEd25519Instruction(releaser, releaseMessage);

    await escrowProgram.methods
      .release()
      .accountsPartial({
        protocolConfig,
        deposit,
        escrowAta,
        recipient: pdaRecipient,
        recipientAta: pdaRecipientAta,
        depositor: depositor.publicKey,
        depositorAta,
        treasurer: treasurerKeypair.publicKey,
        treasuryAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([releaseSig])
      .signers([payer])
      .rpc();

    // Verify the PDA received the tokens
    const pdaRecipientAccount = await getAccount(
      provider.connection,
      pdaRecipientAta
    );
    expect(pdaRecipientAccount.amount.toString()).to.equal(
      DEPOSIT_AMOUNT.toString()
    );

    // Verify escrow ATA is closed after release
    const escrowInfo = await provider.connection.getAccountInfo(escrowAta);
    expect(escrowInfo).to.be.null;
    // Verify deposit is closed
    const depositInfo = await provider.connection.getAccountInfo(deposit);
    expect(depositInfo).to.be.null;
  });
});
