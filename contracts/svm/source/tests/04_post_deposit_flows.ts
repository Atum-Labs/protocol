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
  treasurerKeypair,
  ensureProtocolInitialized,
  DEFAULT_QUOTE_HASH,
  ZERO_QUOTE_HASH,
  findProgramEvent,
  destinationHash,
  depositComputeBudgetIx,
} from "./helpers";
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

describe("4. Post-Deposit Flows", () => {
  let mint: PublicKey;
  let mintFeeConfig: PublicKey;
  let authorityAta: PublicKey;
  let delegate: PublicKey;
  let protocolConfig: PublicKey;
  let treasuryAta: PublicKey;

  let depositor: Keypair;
  let delegateSigner: Keypair;
  let reserver: Keypair;
  let releaser: Keypair;
  let payer: Keypair;

  let deposit: PublicKey;
  let escrowAta: PublicKey;
  let paymentId: Buffer;
  let depositHash: Buffer;

  before(async () => {
    // Initialize protocol and get config address
    protocolConfig = await ensureProtocolInitialized(escrowProgram, provider);
    const mintSetup = await setupMintAndFund();
    mint = mintSetup.mint;
    mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // Create treasury ATA for the treasurer
    treasuryAta = await getOrCreateAssociatedTokenAccount(
      mint,
      treasurerKeypair.publicKey
    );

    [depositor, delegateSigner, reserver, releaser, payer] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
      generateFundedKeypair(),
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    // Create the depositor's ATA
    authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );

    // Transfer tokens from the main authority to the depositor
    const transferTx = new Transaction().add(
      createTransferInstruction(
        mainAuthorityAta,
        authorityAta,
        provider.wallet.publicKey,
        BigInt(800_000_000) // Transfer 800 tokens for all per-test deposits
      )
    );

    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);
  });

  beforeEach(async () => {
    delegateSigner = await generateFundedKeypair();
    delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5); // 5 seconds in the past
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
    // Persist the deposit hash for post-deposit messages
    depositHash = message;

    const ed25519Instruction = depositSigIx(
      delegateSigner,
      message
    );

    [deposit] = PublicKey.findProgramAddressSync(
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

    escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

    await escrowProgram.methods
      .deposit(
        Array.from(paymentId),
        Array.from(await destinationHash()),
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
  });

  // Ensure each test cleans up its delegate to avoid PDA collisions
  afterEach(async () => {
    try {
      await escrowProgram.methods
        .revokeDelegate()
        .accountsPartial({
          escrowDelegate: delegate,
          authority: depositor.publicKey,
          authorityAta,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor, payer])
        .rpc();
    } catch {
      // Ignore errors (already revoked/renounced or account closed)
    }
  });

  // Reserve
  it("4.1. Should reserve a deposit", async () => {
    const recipient = Keypair.generate().publicKey;
    const message = await createMessage("reserve", [
      recipient.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    const ed25519Instruction = reserveSigIx(reserver, message);

    const txSig = await escrowProgram.methods
      .reserve(recipient, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Instruction])
      .rpc();

    const depositAccount = await escrowProgram.account.depositInfo.fetch(
      deposit
    );
    expect(depositAccount.recipient!.toBase58()).to.equal(recipient.toBase58());
    expect(
      Buffer.from(depositAccount.quoteHash).equals(DEFAULT_QUOTE_HASH)
    ).to.be.true;

    // Reserved event carries the attested quote hash (veri-fill reads this).
    const reservedEvent = await findProgramEvent<any>(
      escrowProgram,
      txSig,
      "Reserved"
    );
    expect(Buffer.from(reservedEvent.quoteHash).equals(DEFAULT_QUOTE_HASH)).to.be
      .true;
  });

  it("4.2. Should fail to reserve a deposit that is already reserved", async () => {
    const recipient1 = Keypair.generate().publicKey;
    let message = await createMessage("reserve", [
      recipient1.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    let ed25519Instruction = reserveSigIx(reserver, message);

    await escrowProgram.methods
      .reserve(recipient1, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Instruction])
      .rpc();

    try {
      const recipient2 = Keypair.generate().publicKey;
      message = await createMessage("reserve", [
        recipient2.toBuffer(),
        depositHash,
        DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
      ed25519Instruction = reserveSigIx(reserver, message);

      await escrowProgram.methods
        .reserve(recipient2, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
        .accountsPartial({
          deposit,
          protocolConfig,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Instruction])
        .rpc();
      expect.fail("Should have failed with RecipientAlreadySet");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("RecipientAlreadySet");
    }
  });

  it("4.3. Should fail to reserve with an invalid reserver", async () => {
    const invalidReserver = await generateFundedKeypair();
    const recipient = Keypair.generate().publicKey;
    const message = await createMessage("reserve", [
      recipient.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    const ed25519Instruction = reserveSigIx(
      invalidReserver,
      message
    );

    try {
      await escrowProgram.methods
        .reserve(recipient, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
        .accountsPartial({
          deposit,
          protocolConfig,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Instruction])
        .rpc();
      expect.fail("Should have failed with InvalidPublicKey");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidPublicKey");
    }
  });

  it("4.4. Should fail to reserve a released deposit", async () => {
    const recipient = await generateFundedKeypair();
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    const reserveEd25519Instruction = reserveSigIx(
      reserver,
      reserveMessage
    );

    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveEd25519Instruction])
      .rpc();

    // Now release the deposit
    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    const releaseEd25519Instruction = releaseSigIx(
      releaser,
      releaseMessage
    );
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );

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
      .preInstructions([releaseEd25519Instruction])
      .signers([payer])
      .rpc();

    // Now try to reserve again
    try {
      const newRecipient = Keypair.generate().publicKey;
      const newReserveMessage = await createMessage("reserve", [
        newRecipient.toBuffer(),
        depositHash,
        DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
      const newReserveEd25519Instruction = reserveSigIx(
        reserver,
        newReserveMessage
      );
      await escrowProgram.methods
        .reserve(newRecipient, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
        .accountsPartial({
          deposit,
          protocolConfig,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([newReserveEd25519Instruction])
        .rpc();
      expect.fail("Should have failed because deposit account is closed");
    } catch (err: any) {
      expect(err.toString()).to.include("AccountNotInitialized");
    }
  });

  // Release
  it("4.5. Should release a reserved deposit and close accounts", async () => {
    const recipient = await generateFundedKeypair();
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    const reserveEd25519Instruction = reserveSigIx(
      reserver,
      reserveMessage
    );

    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveEd25519Instruction])
      .rpc();

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );

    const recipientAtaBefore = await getAccount(
      provider.connection,
      recipientAta
    );

    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    const releaseEd25519Instruction = releaseSigIx(
      releaser,
      releaseMessage
    );

    const releaseTxSig = await escrowProgram.methods
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
      .preInstructions([releaseEd25519Instruction])
      .signers([payer])
      .rpc();

    // Verify deposit account is closed
    const depositAccountInfo = await provider.connection.getAccountInfo(
      deposit
    );
    expect(depositAccountInfo).to.be.null;

    // Verify balances: full amount to recipient (no fee)
    const expectedNetAmount = DEPOSIT_AMOUNT;

    const recipientAtaAfter = await getAccount(
      provider.connection,
      recipientAta
    );

    expect(recipientAtaAfter.amount.toString()).to.equal(
      new anchor.BN(recipientAtaBefore.amount.toString())
        .add(expectedNetAmount)
        .toString()
    );

    // Released event carries the reserved quote hash (veri-fill reads this).
    const releasedEvent = await findProgramEvent<any>(
      escrowProgram,
      releaseTxSig,
      "Released"
    );
    expect(Buffer.from(releasedEvent.quoteHash).equals(DEFAULT_QUOTE_HASH)).to.be
      .true;

    // Verify escrow ATA is closed
    const closedEscrowAta = await provider.connection.getAccountInfo(escrowAta);
    expect(closedEscrowAta).to.be.null;
  });

  it("4.5a. Should fail to reserve with an empty quote hash", async () => {
    const recipient = Keypair.generate().publicKey;
    const emptyQuoteHash = Buffer.alloc(32, 0);
    const message = await createMessage("reserve", [
      recipient.toBuffer(),
      depositHash,
      emptyQuoteHash,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    const ed25519Instruction = reserveSigIx(reserver, message);

    try {
      await escrowProgram.methods
        .reserve(recipient, Array.from(emptyQuoteHash), DEPOSIT_AMOUNT)
        .accountsPartial({
          deposit,
          protocolConfig,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Instruction])
        .rpc();
      expect.fail("Should have failed with QuoteHashCannotBeEmpty");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("QuoteHashCannotBeEmpty");
    }
  });

  it("4.5b. Should fail to release when the quote hash does not match the reserved one", async () => {
    const recipient = await generateFundedKeypair();
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
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

    // Release message signed over a different quote hash than the reserved one.
    const wrongQuoteHash = Buffer.alloc(32, 2);
    const releaseMessage = await createMessage("release", [
      depositHash,
      wrongQuoteHash,
    ]);
    const releaseEd25519Instruction = releaseSigIx(
      releaser,
      releaseMessage
    );

    try {
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
        .preInstructions([releaseEd25519Instruction])
        .signers([payer])
        .rpc();
      expect.fail("Should have failed with InvalidMessage");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidMessage");
    }
  });

  it("4.6. Should fail to release a deposit that is not reserved", async () => {
    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    const releaseEd25519Instruction = releaseSigIx(
      releaser,
      releaseMessage
    );

    try {
      await escrowProgram.methods
        .release()
        .accountsPartial({
          protocolConfig,
          deposit,
          escrowAta,
          recipient: depositor.publicKey, // Placeholder, won't be used
          recipientAta: authorityAta, // Placeholder, won't be used
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
        .preInstructions([releaseEd25519Instruction])
        .signers([payer])
        .rpc();
      expect.fail("Should have thrown an error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("RecipientNotSet");
    }
  });

  // Refund
  it("4.7. Should refund a deposit and close accounts", async () => {
    const refundMessage = await createMessage("refund", [
      depositHash,
      ZERO_QUOTE_HASH,
    ]);
    const refundEd25519Instruction = refundSigIx(
      releaser,
      refundMessage
    );

    const authorityAtaBefore = await getAccount(
      provider.connection,
      authorityAta
    );

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
      .preInstructions([refundEd25519Instruction])
      .signers([payer])
      .rpc();

    // Verify deposit account is closed
    const depositAccountInfo = await provider.connection.getAccountInfo(
      deposit
    );
    expect(depositAccountInfo).to.be.null;

    // Verify balance
    const authorityAtaAfter = await getAccount(
      provider.connection,
      authorityAta
    );
    const expectedBalance = new anchor.BN(
      authorityAtaBefore.amount.toString()
    ).add(DEPOSIT_AMOUNT);
    expect(authorityAtaAfter.amount.toString()).to.equal(
      expectedBalance.toString()
    );

    // Verify escrow ATA is closed
    const closedEscrowAta = await provider.connection.getAccountInfo(escrowAta);
    expect(closedEscrowAta).to.be.null;
  });

  it("4.7a. Should refund a reserved deposit with the correct quote hash", async () => {
    // Reserve first so the deposit carries a non-zero quote hash.
    const recipient = Keypair.generate().publicKey;
    const reserveMessage = await createMessage("reserve", [
      recipient.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveSigIx(reserver, reserveMessage)])
      .rpc();

    // Refund must bind the reserved quote hash (deposit.quote_hash), not zero.
    const refundMessage = await createMessage("refund", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    const refundEd25519Instruction = refundSigIx(
      releaser,
      refundMessage
    );

    const authorityAtaBefore = await getAccount(
      provider.connection,
      authorityAta
    );

    const txSig = await escrowProgram.methods
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
      .preInstructions([refundEd25519Instruction])
      .signers([payer])
      .rpc();

    // Deposit account closed and funds returned to the depositor.
    const depositAccountInfo = await provider.connection.getAccountInfo(deposit);
    expect(depositAccountInfo).to.be.null;

    const authorityAtaAfter = await getAccount(
      provider.connection,
      authorityAta
    );
    expect(authorityAtaAfter.amount.toString()).to.equal(
      new anchor.BN(authorityAtaBefore.amount.toString())
        .add(DEPOSIT_AMOUNT)
        .toString()
    );

    // Refunded event carries the reserved quote hash (veri-fill reads this).
    const refundedEvent = await findProgramEvent<any>(
      escrowProgram,
      txSig,
      "Refunded"
    );
    expect(Buffer.from(refundedEvent.quoteHash).equals(DEFAULT_QUOTE_HASH)).to.be
      .true;
  });

  it("4.7b. Should fail to refund when the quote hash does not match the reserved one", async () => {
    // Reserve so the deposit binds DEFAULT_QUOTE_HASH.
    const recipient = Keypair.generate().publicKey;
    const reserveMessage = await createMessage("reserve", [
      recipient.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveSigIx(reserver, reserveMessage)])
      .rpc();

    // Refund signed over a different quote hash than the reserved one. The refund
    // preimage binds deposit.quote_hash via compute_refund_hash, so verification fails.
    const wrongQuoteHash = Buffer.alloc(32, 2);
    const refundMessage = await createMessage("refund", [
      depositHash,
      wrongQuoteHash,
    ]);
    const refundEd25519Instruction = refundSigIx(
      releaser,
      refundMessage
    );

    try {
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
        .preInstructions([refundEd25519Instruction])
        .signers([payer])
        .rpc();
      expect.fail("Should have failed with InvalidMessage");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidMessage");
    }
  });

  it("4.8. Should fail to refund with an invalid releaser", async () => {
    const invalidReleaser = await generateFundedKeypair();
    const refundMessage = await createMessage("refund", [
      depositHash,
      ZERO_QUOTE_HASH,
    ]);
    const refundEd25519Instruction = refundSigIx(
      invalidReleaser,
      refundMessage
    );

    try {
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
        .preInstructions([refundEd25519Instruction])
        .signers([payer])
        .rpc();
      expect.fail("Should have thrown an error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidPublicKey");
    }
  });

  it("4.9. Should fail to release with an invalid releaser signature", async () => {
    const invalidReleaser = await generateFundedKeypair();

    // First, reserve the deposit
    const recipient = await generateFundedKeypair();
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    const reserveEd25519Instruction = reserveSigIx(
      reserver,
      reserveMessage
    );

    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveEd25519Instruction])
      .rpc();

    // Now, try to release with an invalid releaser
    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    const releaseEd25519Instruction = releaseSigIx(
      invalidReleaser,
      releaseMessage
    );

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );

    try {
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
        .preInstructions([releaseEd25519Instruction])
        .signers([payer])
        .rpc();
      expect.fail("Should have failed with InvalidPublicKey");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidPublicKey");
    }
  });

  // Settlement Finality
  it("4.10. Should fail to act on a settled deposit", async () => {
    // First, refund the deposit to close the account
    const refundMessage = await createMessage("refund", [
      depositHash,
      ZERO_QUOTE_HASH,
    ]);
    const refundEd25519Instruction = refundSigIx(
      releaser,
      refundMessage
    );
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
      .preInstructions([refundEd25519Instruction])
      .signers([payer])
      .rpc();

    // Now, try to reserve the closed deposit
    try {
      const recipient = Keypair.generate().publicKey;
      const reserveMessage = await createMessage("reserve", [
        recipient.toBuffer(),
        depositHash,
        DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
      const reserveEd25519Instruction = reserveSigIx(
        reserver,
        reserveMessage
      );

      await escrowProgram.methods
        .reserve(recipient, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
        .accountsPartial({
          deposit,
          protocolConfig,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([reserveEd25519Instruction])
        .rpc();
      expect.fail("Should have failed because the deposit account is closed");
    } catch (err: any) {
      expect(err.toString()).to.include("AccountNotInitialized");
    }
  });

  it("4.11. Should fail to reserve a refunded deposit", async () => {
    // First, refund
    const refundMessage = await createMessage("refund", [
      depositHash,
      ZERO_QUOTE_HASH,
    ]);
    const refundEd25519Instruction = refundSigIx(
      releaser,
      refundMessage
    );
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
      .preInstructions([refundEd25519Instruction])
      .signers([payer])
      .rpc();

    // Now, try to reserve
    try {
      const recipient = Keypair.generate().publicKey;
      const reserveMessage = await createMessage("reserve", [
        recipient.toBuffer(),
        depositHash,
        DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
      const reserveEd25519Instruction = reserveSigIx(
        reserver,
        reserveMessage
      );
      await escrowProgram.methods
        .reserve(recipient, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
        .accountsPartial({
          deposit,
          protocolConfig,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([reserveEd25519Instruction])
        .rpc();
      expect.fail("Should have failed because deposit account is closed");
    } catch (err: any) {
      expect(err.toString()).to.include("AccountNotInitialized");
    }
  });

  // Settlement after delegate changes
  it("4.12. Should settle (release) after delegate is revoked", async () => {
    // Revoke delegate (close PDA and revoke SPL approval) before settlement
    await escrowProgram.methods
      .revokeDelegate()
      .accountsPartial({
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        authorityAta,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor, payer])
      .rpc();

    // Reserve then release should still work
    const recipient = await generateFundedKeypair();
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
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
  });

  it("4.13. Should settle (refund) after delegate is renounced (expired)", async () => {
    // Renounce from delegate signer to expire immediately
    await escrowProgram.methods
      .renounceDelegate()
      .accountsPartial({
        escrowDelegate: delegate,
        delegateSigner: delegateSigner.publicKey,
      })
      .signers([delegateSigner])
      .rpc();

    // Refund should still be allowed
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
  });

  it("4.14. Should settle (release) after delegate is renounced (expired)", async () => {
    // Renounce from delegate signer to expire immediately
    await escrowProgram.methods
      .renounceDelegate()
      .accountsPartial({
        escrowDelegate: delegate,
        delegateSigner: delegateSigner.publicKey,
      })
      .signers([delegateSigner])
      .rpc();

    // Reserve and then release should still succeed
    const recipient = await generateFundedKeypair();
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
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
  });

  it("4.15. Should settle (refund) after delegate is revoked", async () => {
    // Revoke delegate before settlement
    await escrowProgram.methods
      .revokeDelegate()
      .accountsPartial({
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        authorityAta,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor, payer])
      .rpc();

    // Refund should still be allowed
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
  });
});
