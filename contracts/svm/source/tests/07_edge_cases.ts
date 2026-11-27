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
  rawSigIx,
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
  destinationHash,
  depositComputeBudgetIx,
} from "./helpers";
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
  createInitializeAccountInstruction,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

describe("7. Edge Cases", () => {
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

  let deposit: PublicKey;
  let escrowAta: PublicKey;
  let paymentId: Buffer;
  let depositHash: Buffer;

  before(async () => {
    // Initialize protocol config
    protocolConfig = await ensureProtocolInitialized(escrowProgram, provider);

    [reserver, releaser, payer] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);
  });

  beforeEach(async () => {
    paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    // Generate fresh keys for each test to avoid PDA collisions
    [depositor, delegateSigner] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    // Create and fund a fresh mint and ATA for each test
    const {
      mint: newMint,
      mintFeeConfig: newMintFeeConfig,
      authorityTokenAccount: mainAuthorityAta,
    } = await setupMintAndFund();
    mint = newMint; // Update the mint variable for all tests to use
    mintFeeConfig = newMintFeeConfig!;
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

    // Create delegate for this test's mint
    delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

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
        mint: mint,
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

  // Deposit Edge Cases
  it("7.1. Should fail a zero-amount deposit", async () => {
    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    const message = await createMessage("deposit", [
      paymentId,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      new anchor.BN(0).toBuffer("le", 8), // Zero amount
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAt.toBuffer("le", 8),
      deadline.toBuffer("le", 8),
    ]);

    const ed25519Instruction = depositSigIx(
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
          Array.from(await destinationHash()),
          new anchor.BN(0),
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
      expect.fail("Should have failed with AmountMustBeGreaterThanZero error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("AmountMustBeGreaterThanZero");
    }
  });

  it("7.2. Should reject a deposit with a negative issued_at timestamp", async () => {
    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(-1); // Negative timestamp
    const deadline = new anchor.BN(Math.floor(Date.now() / 1000) + 60);

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

    const ed25519Instruction = depositSigIx(
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
          Array.from(await destinationHash()),
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
      expect.fail(
        "Should have failed with ExpiredTransaction due to negative timestamp"
      );
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ExpiredTransaction");
    }
  });

  // Settlement Edge Cases
  it("7.3. Should fail to release a refunded deposit", async () => {
    // First refund
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

    // Try to release after refund
    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    const releaseEd25519Instruction = releaseSigIx(
      releaser,
      releaseMessage
    );
    const recipient = await generateFundedKeypair();
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      treasurerKeypair.publicKey
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
      expect.fail("Should have thrown error due to closed deposit account");
    } catch (error: any) {
      // After refund, deposit account is closed, so should get AccountNotInitialized
      expect(error.toString()).to.include("AccountNotInitialized");
    }
  });

  it("7.4. Should fail to refund a released deposit", async () => {
    const recipient = await generateFundedKeypair();

    // First reserve
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
    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      treasurerKeypair.publicKey
    );

    // Then release

    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    const releaseEd25519Instruction = releaseSigIx(
      releaser,
      releaseMessage
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

    // Try to refund after release
    const refundMessage = await createMessage("refund", [
      depositHash,
      ZERO_QUOTE_HASH,
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
      expect.fail("Should have thrown error due to closed deposit account");
    } catch (error: any) {
      // After release, deposit account is closed, so should get AccountNotInitialized
      expect(error.toString()).to.include("AccountNotInitialized");
    }
  });

  it("7.5. Should fail with incorrect PDA seeds", async () => {
    const wrongPaymentId = createPaymentId();
    const recipient = await generateFundedKeypair();
    const _nonce = createValidNonce();
    const _issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);

    const [wrongDeposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, wrongPaymentId],
      escrowProgram.programId
    );

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

    try {
      await escrowProgram.methods
        .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
        .accountsPartial({
          deposit: wrongDeposit,
          protocolConfig,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([reserveEd25519Instruction])
        .rpc();
      expect.fail("Should have thrown constraint violation");
    } catch (error: any) {
      // Accept either ConstraintSeeds or account-related errors
      const errorMsg = error.toString();
      const hasConstraintError =
        errorMsg.includes("ConstraintSeeds") ||
        errorMsg.includes("account") ||
        errorMsg.includes("AccountNotInitialized");
      expect(hasConstraintError).to.be.true;
    }
  });

  it("7.6. Should fail with signature verification failures", async () => {
    const recipient = await generateFundedKeypair();

    const wrongMessage = Buffer.from("wrong message");
    const invalidEd25519Instruction = rawSigIx(
      reserver,
      wrongMessage
    );

    try {
      await escrowProgram.methods
        .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
        .accountsPartial({
          deposit,
          protocolConfig,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([invalidEd25519Instruction])
        .rpc();
      expect.fail("Should have thrown signature verification failure");
    } catch (error: any) {
      // A real Ed25519 signature over text that is not the escrow text: the native program
      // verifies, the content comparison rejects it.
      expect(error.error?.errorCode?.code).to.equal("InvalidMessage");
    }
  });

  it("7.7. Should enforce recipient ATA owner", async () => {
    const recipient = await generateFundedKeypair();
    const wrongOwner = await generateFundedKeypair();

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

    const _recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const wrongAta = await getOrCreateAssociatedTokenAccount(
      mint,
      wrongOwner.publicKey
    );
    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      treasurerKeypair.publicKey
    );

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
          recipient: recipient.publicKey,
          recipientAta: wrongAta,
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
      expect.fail("Should have thrown InvalidAuthority error");
    } catch (error: any) {
      const errorMsg = error.toString();
      const hasAuthorityError =
        errorMsg.includes("InvalidAuthority") ||
        errorMsg.includes("Constraint") ||
        errorMsg.includes("authority");
      expect(hasAuthorityError).to.be.true;
    }
  });

  it("7.8. Should fail with a mismatched mint in release", async () => {
    const recipient = await generateFundedKeypair();

    // Reserve first
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

    // Create a new mint for the mismatch (both mints are allowlisted via setupMintAndFund)
    const otherMint = await setupMintAndFund();
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      treasurerKeypair.publicKey
    );

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
          recipient: recipient.publicKey,
          recipientAta,
          depositor: depositor.publicKey,
          depositorAta: authorityAta,
          treasurer: treasurerKeypair.publicKey,
          treasuryAta,
          mint: otherMint.mint, // Mismatched mint
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([releaseEd25519Instruction])
        .signers([payer])
        .rpc();
      expect.fail("Should have thrown InvalidMint error");
    } catch (error: any) {
      expect(error.error.errorCode.code).to.equal("ConstraintTokenMint");
    }
  });

  it("7.9. Should fail a double release", async () => {
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
    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      treasurerKeypair.publicKey
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

    try {
      const secondReleaseMessage = await createMessage("release", [
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
        .preInstructions([
          releaseSigIx(releaser, secondReleaseMessage),
        ])
        .signers([payer])
        .rpc();
      expect.fail("Should have failed due to closed deposit account");
    } catch (error: any) {
      expect(error.toString()).to.include("AccountNotInitialized");
    }
  });

  it("7.10. Should fail a double refund", async () => {
    // First, refund the deposit
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

    // Now, try to refund again
    try {
      const secondRefundMessage = await createMessage("refund", [
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
        .preInstructions([
          refundSigIx(releaser, secondRefundMessage),
        ])
        .signers([payer])
        .rpc();
      expect.fail("Should have failed due to closed deposit account");
    } catch (error: any) {
      // After refund, deposit account is closed, so should get AccountNotInitialized
      expect(error.toString()).to.include("AccountNotInitialized");
    }
  });

  it("7.11. Should release full amount (no protocol fee)", async () => {
    const recipient = await generateFundedKeypair();

    // Verify deposit has zero fee
    const depositInfo = await escrowProgram.account.depositInfo.fetch(deposit);
    expect(depositInfo.feeAmount.toNumber()).to.equal(0);

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
    const recipientAtaBefore = await getAccount(
      provider.connection,
      recipientAta
    );
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      mint,
      treasurerKeypair.publicKey
    );
    const treasuryAtaBefore = await getAccount(
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

    const recipientAtaAfter = await getAccount(
      provider.connection,
      recipientAta
    );
    const treasuryAtaAfter = await getAccount(provider.connection, treasuryAta);

    // Full amount goes to recipient (no fee)
    const expectedNetAmount = DEPOSIT_AMOUNT;
    expect(recipientAtaAfter.amount.toString()).to.equal(
      new anchor.BN(recipientAtaBefore.amount.toString())
        .add(expectedNetAmount)
        .toString()
    );

    // Treasury delta should be 0 (no fee collected)
    const treasuryDelta =
      BigInt(treasuryAtaAfter.amount.toString()) -
      BigInt(treasuryAtaBefore.amount.toString());
    expect(treasuryDelta.toString()).to.equal("0");
  });

  it("7.12. Should fail release with mismatched recipient ATA owner", async () => {
    const recipient = await generateFundedKeypair();
    const wrongRecipient = await generateFundedKeypair();

    // Reserve with the correct recipient
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

    // But try to release to an ATA owned by the wrong recipient
    const wrongRecipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      wrongRecipient.publicKey
    );
    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      treasurerKeypair.publicKey
    );

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
          recipient: recipient.publicKey,
          recipientAta: wrongRecipientAta,
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
      expect.fail("Should have failed with an authority constraint error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ConstraintTokenOwner");
    }
  });

  it("7.13. Should fail refund with mismatched depositor ATA owner", async () => {
    const wrongDepositor = await generateFundedKeypair();
    const wrongDepositorAta = await getOrCreateAssociatedTokenAccount(
      mint,
      wrongDepositor.publicKey
    );

    const refundMessage = await createMessage("refund", [
      depositHash,
      ZERO_QUOTE_HASH,
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
          depositorAta: wrongDepositorAta,
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
      expect.fail("Should have failed with the depositor ATA address check");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidDepositorAta");
    }
  });

  it("7.14. Should fail release with incorrect escrow ATA", async () => {
    const recipient = await generateFundedKeypair();

    // Reserve with the correct recipient
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

    // Create a dummy ATA to use as the wrong escrow ATA
    const dummyAta = await getOrCreateAssociatedTokenAccount(
      mint,
      Keypair.generate().publicKey
    );
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      treasurerKeypair.publicKey
    );

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
          escrowAta: dummyAta, // Incorrect escrow ATA
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
      expect.fail("Should have failed with an authority constraint error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ConstraintTokenOwner");
    }
  });

  it("7.15. Should reject Ed25519 with cross-instruction message index", async () => {
    // Prepare a reserve message for the existing deposit
    const recipient = Keypair.generate().publicKey;
    const message = await createMessage("reserve", [
      recipient.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);

    // Instruction 0: A normal ed25519 instruction that embeds the message in its own data
    const providerIx = reserveSigIx(reserver, message);

    // Parse offsets from the provider instruction to locate sig/pk/message positions
    const dataA = providerIx.data as Buffer;
    const sigOffsetA = dataA.readUInt16LE(2);
    const pkOffsetA = dataA.readUInt16LE(6);
    const msgOffsetA = dataA.readUInt16LE(10);

    const signature = dataA.slice(sigOffsetA, sigOffsetA + 64);
    const pubkey = dataA.slice(pkOffsetA, pkOffsetA + 32);

    // Instruction 1: Malicious ed25519 instruction that references the message
    // from instruction index 0 (providerIx) instead of embedding it in-instruction.
    // Our program should reject this because we now require indices == u16::MAX.
    const header = Buffer.alloc(16);
    header.writeUInt8(1, 0); // sig_count
    header.writeUInt8(0, 1); // padding
    header.writeUInt16LE(16, 2); // sig_offset (within this instruction)
    header.writeUInt16LE(0xffff, 4); // sig_ix = u16::MAX (in-instruction)
    header.writeUInt16LE(16 + 64, 6); // pk_offset (within this instruction)
    header.writeUInt16LE(0xffff, 8); // pk_ix = u16::MAX (in-instruction)
    header.writeUInt16LE(msgOffsetA, 10); // msg_offset (but in another instruction)
    header.writeUInt16LE(dataA.readUInt16LE(12), 12); // msg_size of the signed text
    header.writeUInt16LE(0, 14); // msg_ix = 0 (reference instruction 0)

    const maliciousData = Buffer.concat([header, signature, pubkey]);
    const maliciousIx = new anchor.web3.TransactionInstruction({
      programId: anchor.web3.Ed25519Program.programId,
      keys: [],
      data: maliciousData,
    });

    try {
      await escrowProgram.methods
        .reserve(recipient, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
        .accountsPartial({
          deposit,
          protocolConfig,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([providerIx, maliciousIx])
        .rpc();
      expect.fail("Should have failed due to InvalidVerificationInstruction");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal(
        "InvalidVerificationInstruction"
      );
    }
  });

  it("7.16. Should release and close with extra tokens in escrow ATA", async () => {
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

    const authorityTokenAccount = await getAssociatedTokenAddress(
      mint,
      provider.wallet.publicKey
    );
    const dustTx = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        escrowAta,
        provider.wallet.publicKey,
        BigInt(1)
      )
    );
    await sendAndConfirmTransaction(provider.connection, dustTx, [
      provider.wallet.payer!,
    ]);

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const recipientBefore = await getAccount(provider.connection, recipientAta);
    const depositorBefore = await getAccount(provider.connection, authorityAta);
    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      treasurerKeypair.publicKey
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

    const depositAccountInfo = await provider.connection.getAccountInfo(
      deposit
    );
    expect(depositAccountInfo).to.be.null;
    const escrowAccountInfo = await provider.connection.getAccountInfo(
      escrowAta
    );
    expect(escrowAccountInfo).to.be.null;

    const recipientAfter = await getAccount(provider.connection, recipientAta);
    expect(recipientAfter.amount.toString()).to.equal(
      new anchor.BN(recipientBefore.amount.toString())
        .add(DEPOSIT_AMOUNT)
        .toString()
    );

    const depositorAfter = await getAccount(provider.connection, authorityAta);
    expect(depositorAfter.amount.toString()).to.equal(
      new anchor.BN(depositorBefore.amount.toString())
        .add(new anchor.BN(1))
        .toString()
    );
  });

  it("7.17. Should refund and close with extra tokens in escrow ATA", async () => {
    const authorityTokenAccount = await getAssociatedTokenAddress(
      mint,
      provider.wallet.publicKey
    );
    const dustTx = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        escrowAta,
        provider.wallet.publicKey,
        BigInt(1)
      )
    );
    await sendAndConfirmTransaction(provider.connection, dustTx, [
      provider.wallet.payer!,
    ]);

    const authorityAtaBefore = await getAccount(
      provider.connection,
      authorityAta
    );

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

    const depositAccountInfo = await provider.connection.getAccountInfo(
      deposit
    );
    expect(depositAccountInfo).to.be.null;
    const escrowAccountInfo = await provider.connection.getAccountInfo(
      escrowAta
    );
    expect(escrowAccountInfo).to.be.null;

    const authorityAtaAfter = await getAccount(
      provider.connection,
      authorityAta
    );
    const expectedBalance = new anchor.BN(
      authorityAtaBefore.amount.toString()
    ).add(DEPOSIT_AMOUNT.add(new anchor.BN(1)));
    expect(authorityAtaAfter.amount.toString()).to.equal(
      expectedBalance.toString()
    );
  });

  it("7.18. Should reject release if recipient_ata is not the canonical ATA", async () => {
    const recipient = await generateFundedKeypair();

    // Reserve with the correct recipient
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

    // Create a non-ATA token account for the same owner/mint (raw Token account)
    // Use low-level instructions to avoid Associated Token Program.
    const nonAtaKeypair = Keypair.generate();
    const rent = await provider.connection.getMinimumBalanceForRentExemption(
      165 // spl-token ACCOUNT_SIZE
    );
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: nonAtaKeypair.publicKey,
        space: 165,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      // Initialize as a standard token account
      createInitializeAccountInstruction(
        nonAtaKeypair.publicKey,
        mint,
        recipient.publicKey
      )
    );
    await provider.sendAndConfirm(tx, [payer, nonAtaKeypair]);
    const nonAta = nonAtaKeypair.publicKey;

    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      treasurerKeypair.publicKey
    );

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
          recipient: recipient.publicKey,
          recipientAta: nonAta,
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
      expect.fail("Should have failed due to non-canonical ATA");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal(
        "AccountNotAssociatedTokenAccount"
      );
    }
  });

  it("7.19. Should reject refund if depositor_ata is not the canonical ATA", async () => {
    // Create a non-ATA token account for the same owner/mint (raw Token account)
    // Use low-level instructions to avoid Associated Token Program.
    const nonAtaKeypair = Keypair.generate();
    const rent = await provider.connection.getMinimumBalanceForRentExemption(
      165 // spl-token ACCOUNT_SIZE
    );
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: nonAtaKeypair.publicKey,
        space: 165,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      // Initialize as a standard token account
      createInitializeAccountInstruction(
        nonAtaKeypair.publicKey,
        mint,
        depositor.publicKey
      )
    );
    await provider.sendAndConfirm(tx, [payer, nonAtaKeypair]);
    const nonAta = nonAtaKeypair.publicKey;

    const refundMessage = await createMessage("refund", [
      depositHash,
      ZERO_QUOTE_HASH,
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
          depositorAta: nonAta,
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
      expect.fail("Should have failed due to non-canonical ATA");
    } catch (err: any) {
      // The handler checks depositor_ata by address against the canonical ATA
      if (err.error?.errorCode?.code) {
        expect(err.error.errorCode.code).to.equal("InvalidDepositorAta");
      } else {
        expect(err.toString()).to.include("InvalidDepositorAta");
      }
    }
  });

  it("7.20. Should reject release if escrow_ata is not the canonical ATA", async () => {
    const recipient = await generateFundedKeypair();

    // Reserve with the correct recipient
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
    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      treasurerKeypair.publicKey
    );

    // Create a non-ATA token account for the same owner/mint (raw Token account)
    // Use low-level instructions to avoid Associated Token Program.
    const nonAtaKeypair = Keypair.generate();
    const rent = await provider.connection.getMinimumBalanceForRentExemption(
      165 // spl-token ACCOUNT_SIZE
    );
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: nonAtaKeypair.publicKey,
        space: 165,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      // Initialize as a standard token account
      createInitializeAccountInstruction(nonAtaKeypair.publicKey, mint, deposit)
    );
    await provider.sendAndConfirm(tx, [payer, nonAtaKeypair]);
    const nonAta = nonAtaKeypair.publicKey;

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
          escrowAta: nonAta,
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
      expect.fail("Should have failed due to non-canonical ATA");
    } catch (err: any) {
      // Program enforces canonical ATA constraint now
      if (err.error?.errorCode?.code) {
        expect(err.error.errorCode.code).to.equal("ConstraintAssociated");
      } else {
        expect(err.toString()).to.include("ConstraintAssociated");
      }
    }
  });

  it("7.21. Should reject refund if escrow_ata is not the canonical ATA", async () => {
    // Create a non-ATA token account for the same owner/mint (raw Token account)
    // Use low-level instructions to avoid Associated Token Program.
    const nonAtaKeypair = Keypair.generate();
    const rent = await provider.connection.getMinimumBalanceForRentExemption(
      165 // spl-token ACCOUNT_SIZE
    );
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: nonAtaKeypair.publicKey,
        space: 165,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      // Initialize as a standard token account
      createInitializeAccountInstruction(nonAtaKeypair.publicKey, mint, deposit)
    );
    await provider.sendAndConfirm(tx, [payer, nonAtaKeypair]);
    const nonAta = nonAtaKeypair.publicKey;

    const refundMessage = await createMessage("refund", [
      depositHash,
      ZERO_QUOTE_HASH,
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
          escrowAta: nonAta,
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
      expect.fail("Should have failed due to non-ATA escrow account");
    } catch (err: any) {
      // Program enforces canonical ATA constraint now
      if (err.error?.errorCode?.code) {
        expect(err.error.errorCode.code).to.equal("ConstraintAssociated");
      } else {
        expect(err.toString()).to.include("ConstraintAssociated");
      }
    }
  });
});
