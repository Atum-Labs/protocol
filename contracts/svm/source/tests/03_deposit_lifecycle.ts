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
  createEd25519Instruction,
  createPaymentId,
  createValidNonce,
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
  ESCROW_DELEGATE_SEED,
  ensureProtocolInitialized,
  treasurerKeypair,
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
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableProgram,
} from "@solana/web3.js";

describe("3. Deposit Lifecycle", () => {
  let mint: PublicKey;
  let mintFeeConfig: PublicKey;
  let authorityAta: PublicKey;
  let delegate: PublicKey;
  let protocolConfig: PublicKey;

  let depositor: Keypair;
  let delegateSigner: Keypair;
  let reserver: Keypair;
  let releaser: Keypair;
  let payer: Keypair;

  before(async () => {
    protocolConfig = await ensureProtocolInitialized(escrowProgram, provider);
    [depositor, delegateSigner, reserver, releaser, payer] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
      generateFundedKeypair(),
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    const mintSetup = await setupMintAndFund();
    mint = mintSetup.mint;
    mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // Create the depositor's ATA
    authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );

    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(500_000_000) // Transfer 500 tokens
      )
    );

    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1 // 1 day expiration
    );
  });

  it("3.1. Should create a new deposit", async () => {
    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5); // 5 seconds in the past to account for processing time
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    const message = await createMessage("deposit", [
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
    const depositHash = message;

    const ed25519Instruction = createEd25519Instruction(
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

    const authorityAtaBefore = await getAccount(
      provider.connection,
      authorityAta
    );
    const delegateBefore = await escrowProgram.account.escrowDelegate.fetch(
      delegate
    );

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

    const [depositAccount, delegateAfter, authorityAtaAfter, escrowAtaAccount] =
      await Promise.all([
        escrowProgram.account.depositInfo.fetch(deposit),
        escrowProgram.account.escrowDelegate.fetch(delegate),
        getAccount(provider.connection, authorityAta),
        getAccount(provider.connection, escrowAta),
      ]);

    // Verify deposit account state
    expect(depositAccount.depositor.toBase58()).to.equal(
      depositor.publicKey.toBase58()
    );
    expect(depositAccount.mint.toBase58()).to.equal(mint.toBase58());
    expect(depositAccount.amount.toString()).to.equal(
      DEPOSIT_AMOUNT.toString()
    );
    expect(depositAccount.reserver.toBase58()).to.equal(
      reserver.publicKey.toBase58()
    );
    expect(depositAccount.releaser.toBase58()).to.equal(
      releaser.publicKey.toBase58()
    );
    expect(depositAccount.recipient).to.be.null;

    // Verify delegate capacity reduction
    const expectedCapacity =
      delegateBefore.remainingCapacity.sub(DEPOSIT_AMOUNT);
    expect(delegateAfter.remainingCapacity.toString()).to.equal(
      expectedCapacity.toString()
    );

    // Verify token balances
    const expectedAuthorityBalance = new anchor.BN(
      authorityAtaBefore.amount.toString()
    ).sub(DEPOSIT_AMOUNT);
    expect(authorityAtaAfter.amount.toString()).to.equal(
      expectedAuthorityBalance.toString()
    );
    expect(escrowAtaAccount.amount.toString()).to.equal(
      DEPOSIT_AMOUNT.toString()
    );
  });

  it("3.2. Should allow a distinct payer for a deposit", async () => {
    const distinctPayer = await generateFundedKeypair();
    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5); // 5 seconds in the past to account for processing time
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    const message = await createMessage("deposit", [
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
    const depositHash = message;

    const ed25519Instruction = createEd25519Instruction(
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

    const authorityAtaBefore = await getAccount(
      provider.connection,
      authorityAta
    );

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
        payer: distinctPayer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), ed25519Instruction])
      .signers([distinctPayer])
      .rpc();

    const authorityAtaAfter = await getAccount(
      provider.connection,
      authorityAta
    );
    const expectedAuthorityBalance = new anchor.BN(
      authorityAtaBefore.amount.toString()
    ).sub(DEPOSIT_AMOUNT);
    expect(authorityAtaAfter.amount.toString()).to.equal(
      expectedAuthorityBalance.toString()
    );
  });

  it("3.3. Should execute atomic Deposit + Reserve + Release (Multi-Instruction TX with ALT)", async () => {
    // This test demonstrates using Address Lookup Tables (ALTs) to compress
    // a large multi-instruction transaction that would otherwise exceed the
    // 1232 byte transaction size limit
    const paymentId = createPaymentId();
    const recipientKp = await generateFundedKeypair();

    // Create nonces and timestamps for each action
    const depositNonce = createValidNonce();
    const depositIssuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const depositDeadline = new anchor.BN(depositIssuedAt.toNumber() + 60);

    // Create messages and signatures
    const depositMessage = await createMessage("deposit", [
      paymentId,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      depositNonce.toBuffer("le", 8),
      depositIssuedAt.toBuffer("le", 8),
      depositDeadline.toBuffer("le", 8),
    ]);
    const reserveMessage = await createMessage("reserve", [
      recipientKp.publicKey.toBuffer(),
      depositMessage,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    const releaseMessage = await createMessage("release", [
      depositMessage,
      DEFAULT_QUOTE_HASH,
    ]);

    const depositSig = createEd25519Instruction(delegateSigner, depositMessage);
    const reserveSig = createEd25519Instruction(reserver, reserveMessage);
    const releaseSig = createEd25519Instruction(releaser, releaseMessage);

    // Get PDAs
    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, depositMessage],
      escrowProgram.programId
    );
    const [depositReplay] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        depositNonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

    // Get pre-balances and create recipient ATA
    const depositorAtaBefore = await getAccount(
      provider.connection,
      authorityAta
    );
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipientKp.publicKey
    );

    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      treasurerKeypair.publicKey
    );

    const depositIx = await escrowProgram.methods
      .deposit(
        Array.from(paymentId),
        TEST_DESTINATION,
        DEPOSIT_AMOUNT,
        reserver.publicKey,
        releaser.publicKey,
        depositNonce,
        depositIssuedAt,
        depositDeadline,
        Array.from(depositMessage)
      )
      .accountsPartial({
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket: depositReplay,
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
      .instruction();

    const reserveIx = await escrowProgram.methods
      .reserve(recipientKp.publicKey, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const releaseIx = await escrowProgram.methods
      .release()
      .accountsPartial({
        protocolConfig,
        deposit,
        escrowAta,
        recipient: recipientKp.publicKey,
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
      .instruction();

    // Create Address Lookup Table to compress the transaction
    const slot = await provider.connection.getSlot("finalized");
    const [createLutIx, lutAddress] =
      AddressLookupTableProgram.createLookupTable({
        authority: payer.publicKey,
        payer: payer.publicKey,
        recentSlot: slot,
      });

    // Collect all addresses that appear in multiple instructions
    const addressesToCompress = [
      mint,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      SystemProgram.programId,
      anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      delegate,
      depositor.publicKey,
      reserver.publicKey,
      releaser.publicKey,
      payer.publicKey,
      deposit,
      depositReplay,
      authorityAta,
      escrowAta,
      recipientAta,
      recipientKp.publicKey,
      protocolConfig,
      mintFeeConfig,
      treasurerKeypair.publicKey,
      treasuryAta,
    ];

    const extendLutIx = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: lutAddress,
      addresses: addressesToCompress,
    });

    // Create and activate the lookup table
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(createLutIx, extendLutIx),
      [payer]
    );

    // Wait for the lookup table to be activated
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Fetch the activated lookup table
    const lutAccount = await provider.connection.getAddressLookupTable(
      lutAddress
    );
    if (!lutAccount.value) {
      throw new Error("Failed to fetch lookup table");
    }

    // Build the versioned transaction with ALT
    const blockhash = await provider.connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: [
        depositSig,
        depositIx,
        reserveSig,
        reserveIx,
        releaseSig,
        releaseIx,
      ],
    }).compileToV0Message([lutAccount.value]); // Use the lookup table here

    const versionedTx = new VersionedTransaction(messageV0);
    versionedTx.sign([payer]);

    // Send and confirm the transaction
    const signature = await provider.connection.sendTransaction(versionedTx);
    await provider.connection.confirmTransaction({
      signature,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    });

    // Verify deposit was created, reserved, and released atomically
    // The deposit account should be closed after release
    try {
      await escrowProgram.account.depositInfo.fetch(deposit);
      expect.fail("Deposit account should have been closed");
    } catch (e: any) {
      expect(e.message).to.include("Account does not exist");
    }

    const depositorAtaAfter = await getAccount(
      provider.connection,
      authorityAta
    );
    const recipientAtaAfter = await getAccount(
      provider.connection,
      recipientAta
    );

    // Escrow ATA should be closed, check if it exists
    const escrowAtaInfo = await provider.connection.getAccountInfo(escrowAta);
    expect(escrowAtaInfo).to.be.null;

    // Verify token balances
    const expectedAuthorityBalance = new anchor.BN(
      depositorAtaBefore.amount.toString()
    ).sub(DEPOSIT_AMOUNT);
    expect(depositorAtaAfter.amount.toString()).to.equal(
      expectedAuthorityBalance.toString()
    );

    // No fees; recipient receives full amount
    const expectedRecipientAmount = DEPOSIT_AMOUNT;
    expect(recipientAtaAfter.amount.toString()).to.equal(
      expectedRecipientAmount.toString()
    );
  });

  it("3.4. Should fail a deposit with an expired delegate", async () => {
    const expiredDelegateAuthority = await generateFundedKeypair();
    // Manually create a delegate that expires very soon (in 1 second),
    // then wait so it becomes expired before attempting deposit.
    const [expiredDelegate] = PublicKey.findProgramAddressSync(
      [
        ESCROW_DELEGATE_SEED,
        expiredDelegateAuthority.publicKey.toBuffer(),
        mint.toBuffer(),
      ],
      escrowProgram.programId
    );
    const soonExpiringTs = new anchor.BN(Math.floor(Date.now() / 1000) + 1);
    const expiredAuthorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      expiredDelegateAuthority.publicKey
    );
    await escrowProgram.methods
      .createDelegate(
        delegateSigner.publicKey,
        DELEGATE_CAPACITY,
        MAX_TRANSFER_SIZE,
        soonExpiringTs
      )
      .accountsPartial({
        protocolConfig,
        authority: expiredDelegateAuthority.publicKey,
        escrowDelegate: expiredDelegate,
        authorityAta: expiredAuthorityAta,
        mint,
        payer: expiredDelegateAuthority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([expiredDelegateAuthority])
      .rpc();
    // Ensure expiration has passed
    await new Promise((r) => setTimeout(r, 2000));

    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5); // 5 seconds in the past to account for processing time
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    const message = await createMessage("deposit", [
      paymentId,
      await destinationHash(),
      expiredDelegateAuthority.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAt.toBuffer("le", 8),
      deadline.toBuffer("le", 8),
    ]);
    const depositHash = message;

    const ed25519Instruction = createEd25519Instruction(
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
        expiredDelegateAuthority.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

    try {
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
          Array.from(depositHash)
        )
        .accountsPartial({
          escrowDelegate: expiredDelegate,
          authority: expiredDelegateAuthority.publicKey,
          replayBucket,
          authorityAta: expiredAuthorityAta,
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
      expect.fail("Should have failed with Expired error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("Expired");
    }
  });

  it("3.5. Should fail a deposit with insufficient delegate capacity", async () => {
    const smallCapacity = new anchor.BN(DEPOSIT_AMOUNT.subn(1));
    const lowCapacityDelegateAuthority = await generateFundedKeypair();
    const lowCapacityDelegate = await createDelegate(
      lowCapacityDelegateAuthority,
      delegateSigner,
      mint,
      smallCapacity,
      smallCapacity, // max_transfer_size must be <= remaining_capacity
      1
    );

    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5); // 5 seconds in the past to account for processing time
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    const message = await createMessage("deposit", [
      paymentId,
      await destinationHash(),
      lowCapacityDelegateAuthority.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAt.toBuffer("le", 8),
      deadline.toBuffer("le", 8),
    ]);
    const depositHash = message;

    const ed25519Instruction = createEd25519Instruction(
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
        lowCapacityDelegateAuthority.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

    try {
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
          Array.from(depositHash)
        )
        .accountsPartial({
          escrowDelegate: lowCapacityDelegate,
          authority: lowCapacityDelegateAuthority.publicKey,
          replayBucket,
          authorityAta: await getOrCreateAssociatedTokenAccount(
            mint,
            lowCapacityDelegateAuthority.publicKey
          ),
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
      expect.fail("Should have failed with CapacityExceeded error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("CapacityExceeded");
    }
  });

  it("3.6. Should fail a deposit exceeding the max transfer size", async () => {
    const largeAmount = new anchor.BN(MAX_TRANSFER_SIZE).addn(1);
    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5); // 5 seconds in the past to account for processing time
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    const message = await createMessage("deposit", [
      paymentId,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      largeAmount.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAt.toBuffer("le", 8),
      deadline.toBuffer("le", 8),
    ]);

    const ed25519Instruction = createEd25519Instruction(
      delegateSigner,
      message
    );

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, message],
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
          TEST_DESTINATION,
          largeAmount,
          reserver.publicKey,
          releaser.publicKey,
          nonce,
          issuedAt,
          deadline,
          Array.from(message)
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
      expect.fail("Should have failed with TransferSizeExceeded error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("TransferSizeExceeded");
    }
  });

  it("3.7. Should fail a deposit with an invalid delegate signer", async () => {
    const invalidSigner = await generateFundedKeypair();
    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5); // 5 seconds in the past to account for processing time
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    const message = await createMessage("deposit", [
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

    const ed25519Instruction = createEd25519Instruction(invalidSigner, message);

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, message],
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
          TEST_DESTINATION,
          DEPOSIT_AMOUNT,
          reserver.publicKey,
          releaser.publicKey,
          nonce,
          issuedAt,
          deadline,
          Array.from(message)
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
      expect.fail("Should have failed with InvalidPublicKey error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidPublicKey");
    }
  });

  it("3.8. Should fail to create a deposit that already exists", async () => {
    // First deposit
    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5); // 5 seconds in the past to account for processing time
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    const message = await createMessage("deposit", [
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

    const ed25519Instruction = createEd25519Instruction(
      delegateSigner,
      message
    );

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, message],
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
        TEST_DESTINATION,
        DEPOSIT_AMOUNT,
        reserver.publicKey,
        releaser.publicKey,
        nonce,
        issuedAt,
        deadline,
        Array.from(message)
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

    // Second deposit with same paymentId - should fail
    try {
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
          Array.from(message)
        )
        .accountsPartial({
          escrowDelegate: delegate,
          authority: depositor.publicKey,
          replayBucket,
          authorityAta,
          deposit, // Same deposit account
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
      expect.fail("Should have failed because deposit already exists");
    } catch (err: any) {
      expect(err.toString()).to.include("already in use");
    }
  });

  it("3.9. Should fail a deposit with an invalid mint", async () => {
    const invalidMintSetup = await setupMintAndFund();
    const invalidMint = invalidMintSetup.mint;
    const invalidMintFeeConfig = invalidMintSetup.mintFeeConfig;

    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5); // 5 seconds in the past to account for processing time
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    const message = await createMessage("deposit", [
      paymentId,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      invalidMint.toBuffer(), // Using invalid mint
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAt.toBuffer("le", 8),
      deadline.toBuffer("le", 8),
    ]);

    const ed25519Instruction = createEd25519Instruction(
      delegateSigner,
      message
    );

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, message],
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
    const escrowAta = await getAssociatedTokenAddress(
      invalidMint,
      deposit,
      true
    );

    try {
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
          Array.from(message)
        )
        .accountsPartial({
          escrowDelegate: delegate,
          authority: depositor.publicKey,
          replayBucket,
          authorityAta,
          deposit,
          escrowAta,
          mint: invalidMint, // Using invalid mint
          protocolConfig,
          mintFeeConfig: invalidMintFeeConfig!,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([depositComputeBudgetIx(), ed25519Instruction])
        .signers([payer])
        .rpc();
      expect.fail("Should have failed with InvalidMint or ConstraintTokenMint");
    } catch (err: any) {
      // Accept either our custom error or Anchor's constraint error
      const errorCode = err.error.errorCode.code;
      expect(["InvalidMint", "ConstraintTokenMint"].includes(errorCode)).to.be
        .true;
    }
  });

  it("3.10. Should fail a deposit with an expired deadline", async () => {
    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 10);
    const deadline = new anchor.BN(issuedAt.toNumber() - 1); // Deadline in the past

    const message = await createMessage("deposit", [
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

    const ed25519Instruction = createEd25519Instruction(
      delegateSigner,
      message
    );

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, message],
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
          TEST_DESTINATION,
          DEPOSIT_AMOUNT,
          reserver.publicKey,
          releaser.publicKey,
          nonce,
          issuedAt,
          deadline,
          Array.from(message)
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
      expect.fail("Should have failed with DeadlineExpired error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("DeadlineExpired");
    }
  });

  it("3.11. Should fail a deposit with a deadline too far in the future", async () => {
    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const deadline = new anchor.BN(issuedAt.toNumber() + 129); // 129 seconds, > REPLAY_HORIZON_SECS

    const message = await createMessage("deposit", [
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

    const ed25519Instruction = createEd25519Instruction(
      delegateSigner,
      message
    );

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, message],
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
          TEST_DESTINATION,
          DEPOSIT_AMOUNT,
          reserver.publicKey,
          releaser.publicKey,
          nonce,
          issuedAt,
          deadline,
          Array.from(message)
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
      expect.fail("Should have failed with DeadlineTooFarInFuture error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("DeadlineTooFarInFuture");
    }
  });
});
