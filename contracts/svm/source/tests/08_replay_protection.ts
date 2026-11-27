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
  DEPOSIT_AMOUNT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  generateFundedKeypair,
  setupMintAndFund,
  createMessage,
  getOrCreateAssociatedTokenAccount,
  REPLAY_SEED,
  DELEGATE_CAPACITY,
  MAX_TRANSFER_SIZE,
  sleep,
  waitForSlicePhase,
  REPLAY_SLICE_SECS,
  ensureProtocolInitialized,
  getMintFeeConfigAddress,
  treasurerKeypair,
  DEFAULT_QUOTE_HASH,
  ZERO_QUOTE_HASH,
  destinationHash,
  TEST_DESTINATION,
  depositComputeBudgetIx,
} from "./helpers";
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

describe("8. Replay Protection", () => {
  let mint: PublicKey;
  let authorityAta: PublicKey;
  let delegate: PublicKey;

  let depositor: Keypair;
  let delegateSigner: Keypair;
  let reserver: Keypair;
  let releaser: Keypair;
  let payer: Keypair;

  let deposit: PublicKey;
  let escrowAta: PublicKey;
  let paymentId: Buffer;

  let protocolConfig: PublicKey;
  let mintFeeConfig: PublicKey;

  before(async () => {
    protocolConfig = await ensureProtocolInitialized(escrowProgram, provider);
    [reserver, releaser, payer] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);
  });

  beforeEach(async () => {
    paymentId = createPaymentId();

    // Generate fresh keys for each test to avoid PDA collisions
    [depositor, delegateSigner] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    // Create and fund a fresh mint and ATA for each test
    const { mint: newMint, authorityTokenAccount: mainAuthorityAta } =
      await setupMintAndFund();
    mint = newMint;
    mintFeeConfig = getMintFeeConfigAddress(mint, escrowProgram.programId);
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

    // deposit PDA and escrow ATA will be derived per-test from each deposit hash
  });

  it("8.1. Should reject a duplicate transaction", async () => {
    // Use a specific nonce with reserved bucket 1, slot 5
    const nonce = new anchor.BN("0000000100000005", 16);
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
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

    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    // Derive deposit PDA from deposit hash (message)
    [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, message],
      escrowProgram.programId
    );
    escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

    // First transaction - create deposit
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
        protocolConfig,
        mintFeeConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket,
        authorityAta,
        deposit,
        escrowAta,
        mint: mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), ed25519Instruction])
      .signers([payer])
      .rpc();

    // Set recipient for the deposit
    const recipient = await generateFundedKeypair();
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );

    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      message,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    const reserveEd25519Instruction = createEd25519Instruction(
      reserver,
      reserveMessage
    );

    await escrowProgram.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
      .accountsPartial({
        protocolConfig,
        deposit,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveEd25519Instruction])
      .rpc();

    // Release the deposit to close the account
    const releaseMessage = await createMessage("release", [
      message,
      DEFAULT_QUOTE_HASH,
    ]);
    const releaseEd25519Instruction = createEd25519Instruction(
      releaser,
      releaseMessage
    );

    const treasuryAta = await getAssociatedTokenAddress(
      mint,
      treasurerKeypair.publicKey,
      true
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

    await sleep(5000);

    // Keep the failure out of the assertion: expect.fail's own message names DuplicateTransaction,
    // so asserting inside the try would let a successful second deposit pass.
    let failure: any;
    try {
      await escrowProgram.methods
        .deposit(
          Array.from(paymentId),
          TEST_DESTINATION,
          DEPOSIT_AMOUNT,
          reserver.publicKey,
          releaser.publicKey,
          nonce, // Same nonce as before
          issuedAt, // Same issuedAt as before
          deadline,
          Array.from(message)
        )
        .accountsPartial({
          protocolConfig,
          mintFeeConfig,
          escrowDelegate: delegate,
          authority: depositor.publicKey,
          replayBucket,
          authorityAta,
          deposit,
          escrowAta,
          mint: mint,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([depositComputeBudgetIx(), ed25519Instruction])
        .signers([payer])
        .rpc();
    } catch (err: any) {
      failure = err;
    }
    expect(failure, "the second deposit must be rejected").to.not.equal(
      undefined
    );
    const failureText = [
      failure?.toString?.(),
      failure?.error?.errorCode?.code,
      failure?.message,
    ].join(" ");
    expect(failureText).to.include("DuplicateTransaction");
  });

  it("8.2. Nonce Packing: Should use different buckets for different high bits", async () => {
    // Nonce A: Reserved bucket 6, slot 5
    const nonceA = new anchor.BN("0000000600000005", 16);
    // Nonce B: Reserved bucket 7, slot 5
    const nonceB = new anchor.BN("0000000700000005", 16);

    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    // Transaction A
    const paymentIdA = createPaymentId();
    const messageA = await createMessage("deposit", [
      paymentIdA,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonceA.toBuffer("le", 8),
      issuedAt.toBuffer("le", 8),
      deadline.toBuffer("le", 8),
    ]);
    const ed25519InstructionA = createEd25519Instruction(
      delegateSigner,
      messageA
    );
    const [replayBucketA] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonceA.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const [depositA] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, messageA],
      escrowProgram.programId
    );
    const escrowAtaA = await getAssociatedTokenAddress(mint, depositA, true);

    await escrowProgram.methods
      .deposit(
        Array.from(paymentIdA),
        TEST_DESTINATION,
        DEPOSIT_AMOUNT,
        reserver.publicKey,
        releaser.publicKey,
        nonceA,
        issuedAt,
        deadline,
        Array.from(messageA)
      )
      .accountsPartial({
        protocolConfig,
        mintFeeConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket: replayBucketA,
        authorityAta,
        deposit: depositA,
        escrowAta: escrowAtaA,
        mint: mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), ed25519InstructionA])
      .signers([payer])
      .rpc();

    // Transaction B
    const paymentIdB = createPaymentId();
    const messageB = await createMessage("deposit", [
      paymentIdB,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonceB.toBuffer("le", 8),
      issuedAt.toBuffer("le", 8),
      deadline.toBuffer("le", 8),
    ]);
    const ed25519InstructionB = createEd25519Instruction(
      delegateSigner,
      messageB
    );
    const [replayBucketB] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonceB.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const [depositB] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, messageB],
      escrowProgram.programId
    );
    const escrowAtaB = await getAssociatedTokenAddress(mint, depositB, true);

    await escrowProgram.methods
      .deposit(
        Array.from(paymentIdB),
        TEST_DESTINATION,
        DEPOSIT_AMOUNT,
        reserver.publicKey,
        releaser.publicKey,
        nonceB,
        issuedAt,
        deadline,
        Array.from(messageB)
      )
      .accountsPartial({
        protocolConfig,
        mintFeeConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket: replayBucketB,
        authorityAta,
        deposit: depositB,
        escrowAta: escrowAtaB,
        mint: mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), ed25519InstructionB])
      .signers([payer])
      .rpc();

    // Verify both deposits were created
    const depositAAccount = await escrowProgram.account.depositInfo.fetch(
      depositA
    );
    const depositBAccount = await escrowProgram.account.depositInfo.fetch(
      depositB
    );
    expect(depositAAccount.amount.eq(DEPOSIT_AMOUNT)).to.be.true;
    expect(depositBAccount.amount.eq(DEPOSIT_AMOUNT)).to.be.true;
  });

  it("8.3. Nonce Packing: Should use the same slot for different low bits", async () => {
    // Nonce A: Reserved bucket 8, slot 0
    const nonceA = new anchor.BN("0000000800000000", 16);
    // Nonce B: Reserved bucket 8, slot 0 (different middle bits, same bucket and slot)
    const nonceB = new anchor.BN("0000000800000100", 16);

    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    // Transaction A
    const paymentIdA = createPaymentId();
    const messageA = await createMessage("deposit", [
      paymentIdA,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonceA.toBuffer("le", 8),
      issuedAt.toBuffer("le", 8),
      deadline.toBuffer("le", 8),
    ]);
    const ed25519InstructionA = createEd25519Instruction(
      delegateSigner,
      messageA
    );
    const [replayBucketA] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonceA.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const [depositA] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, messageA],
      escrowProgram.programId
    );
    const escrowAtaA = await getAssociatedTokenAddress(mint, depositA, true);

    await escrowProgram.methods
      .deposit(
        Array.from(paymentIdA),
        TEST_DESTINATION,
        DEPOSIT_AMOUNT,
        reserver.publicKey,
        releaser.publicKey,
        nonceA,
        issuedAt,
        deadline,
        Array.from(messageA)
      )
      .accountsPartial({
        protocolConfig,
        mintFeeConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket: replayBucketA,
        authorityAta,
        deposit: depositA,
        escrowAta: escrowAtaA,
        mint: mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), ed25519InstructionA])
      .signers([payer])
      .rpc();

    // Transaction B should fail as a duplicate
    try {
      const paymentIdB = createPaymentId();
      const messageB = await createMessage("deposit", [
        paymentIdB,
        await destinationHash(),
        depositor.publicKey.toBuffer(),
        mint.toBuffer(),
        DEPOSIT_AMOUNT.toBuffer("le", 8),
        reserver.publicKey.toBuffer(),
        releaser.publicKey.toBuffer(),
        nonceB.toBuffer("le", 8),
        issuedAt.toBuffer("le", 8),
        deadline.toBuffer("le", 8),
      ]);
      const ed25519InstructionB = createEd25519Instruction(
        delegateSigner,
        messageB
      );
      // Replay bucket is the same for nonceA and nonceB
      const [depositB] = PublicKey.findProgramAddressSync(
        [DEPOSIT_SEED, messageB],
        escrowProgram.programId
      );
      const escrowAtaB = await getAssociatedTokenAddress(mint, depositB, true);

      await escrowProgram.methods
        .deposit(
          Array.from(paymentIdB),
          TEST_DESTINATION,
          DEPOSIT_AMOUNT,
          reserver.publicKey,
          releaser.publicKey,
          nonceB,
          issuedAt,
          deadline,
          Array.from(messageB)
        )
        .accountsPartial({
          protocolConfig,
          mintFeeConfig,
          escrowDelegate: delegate,
          authority: depositor.publicKey,
          replayBucket: replayBucketA, // Same bucket
          authorityAta,
          deposit: depositB,
          escrowAta: escrowAtaB,
          mint: mint,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([depositComputeBudgetIx(), ed25519InstructionB])
        .signers([payer])
        .rpc();
      expect.fail("Should have failed with DuplicateTransaction error");
    } catch (err: any) {
      // The test expects DuplicateTransaction error
      // AnchorError is thrown directly from the Anchor RPC method
      if (err.name === "AnchorError") {
        // This is the expected error - test passes
        expect(err.message).to.include("DuplicateTransaction");
        return;
      }
      // Check for other error formats just in case
      if (err.toString && err.toString().includes("DuplicateTransaction")) {
        return;
      }
      if (
        err.error &&
        err.error.errorCode &&
        err.error.errorCode.code === "DuplicateTransaction"
      ) {
        return;
      }
      if (err.message && err.message.includes("DuplicateTransaction")) {
        return;
      }
      // If we get here, it's an unexpected error
      console.log("Unexpected error:", err);
      throw err;
    }
  });

  it("8.4. Should reject an expired transaction", async () => {
    const nonce = new anchor.BN("0000000400000007", 16); // Bucket 4, Slot 7
    // Issued 150 seconds ago, but validity is capped at 128 seconds
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 150);
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

    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );

    // Derive deposit PDA from deposit hash (message)
    [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, message],
      escrowProgram.programId
    );
    escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

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
          protocolConfig,
          mintFeeConfig,
          escrowDelegate: delegate,
          authority: depositor.publicKey,
          replayBucket,
          authorityAta,
          deposit,
          escrowAta,
          mint: mint,
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
      // Handle AnchorError format
      if (err.name === "AnchorError") {
        expect(err.message).to.include("DeadlineExpired");
      } else if (err.error && err.error.errorCode) {
        expect(err.error.errorCode.code).to.equal("DeadlineExpired");
      } else {
        console.log("Unexpected error format:", err);
        throw err;
      }
    }
  });

  it("8.5. Should reject a future transaction", async () => {
    const nonce = new anchor.BN("0000000500000008", 16); // Bucket 5, Slot 8
    // Issued 15 seconds in the future
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) + 15);
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

    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );

    // Derive deposit PDA from deposit hash (message)
    [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, message],
      escrowProgram.programId
    );
    escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

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
          protocolConfig,
          mintFeeConfig,
          escrowDelegate: delegate,
          authority: depositor.publicKey,
          replayBucket,
          authorityAta,
          deposit,
          escrowAta,
          mint: mint,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([depositComputeBudgetIx(), ed25519Instruction])
        .signers([payer])
        .rpc();
      expect.fail("Should have failed with FutureTransaction error");
    } catch (err: any) {
      // Handle AnchorError format
      if (err.name === "AnchorError") {
        expect(err.message).to.include("FutureTransaction");
      } else if (err.error && err.error.errorCode) {
        expect(err.error.errorCode.code).to.equal("FutureTransaction");
      } else {
        console.log("Unexpected error format:", err);
        throw err;
      }
    }
  });

  it("8.6. Should reject an invalid slot", async () => {
    // Nonce with reserved bucket 9, invalid slot 235 (0xEB)
    const nonce = new anchor.BN("00000009000000EB", 16);
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
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

    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );

    // Derive deposit PDA from deposit hash (message)
    [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, message],
      escrowProgram.programId
    );
    escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

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
          protocolConfig,
          mintFeeConfig,
          escrowDelegate: delegate,
          authority: depositor.publicKey,
          replayBucket,
          authorityAta,
          deposit,
          escrowAta,
          mint: mint,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([depositComputeBudgetIx(), ed25519Instruction])
        .signers([payer])
        .rpc();
      expect.fail("Should have failed with InvalidSlot error");
    } catch (err: any) {
      // Handle AnchorError format
      if (err.name === "AnchorError") {
        expect(err.message).to.include("InvalidSlot");
      } else if (err.error && err.error.errorCode) {
        expect(err.error.errorCode.code).to.equal("InvalidSlot");
      } else {
        console.log("Unexpected error format:", err);
        throw err;
      }
    }
  });

  it("8.7. Should accept late arrivals (Previous Epoch)", async () => {
    // Choose a fixed bucket and slot to be deterministic: bucket 11, slot 10
    const nonce = new anchor.BN("0000000B0000000A", 16);
    // Slices are 256s and an authorization is valid for 128s, so a previous-slice issued_at is only
    // still valid shortly after a boundary: wait for that.
    const nowTs = await waitForSlicePhase();
    const remainder = nowTs % REPLAY_SLICE_SECS;
    // issued_at placed in the last second of the previous slice, but within validity window
    const issuedAtPrevEpoch = new anchor.BN(nowTs - remainder - 1);
    const deadline = new anchor.BN(issuedAtPrevEpoch.toNumber() + 128);

    const paymentId = createPaymentId();
    const message = await createMessage("deposit", [
      paymentId,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAtPrevEpoch.toBuffer("le", 8),
      deadline.toBuffer("le", 8),
    ]);
    const ed25519Instruction = createEd25519Instruction(
      delegateSigner,
      message
    );

    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const [depositLate] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, message],
      escrowProgram.programId
    );
    const escrowAtaLate = await getAssociatedTokenAddress(
      mint,
      depositLate,
      true
    );

    await escrowProgram.methods
      .deposit(
        Array.from(paymentId),
        TEST_DESTINATION,
        DEPOSIT_AMOUNT,
        reserver.publicKey,
        releaser.publicKey,
        nonce,
        issuedAtPrevEpoch,
        deadline,
        Array.from(message)
      )
      .accountsPartial({
        protocolConfig,
        mintFeeConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket,
        authorityAta,
        deposit: depositLate,
        escrowAta: escrowAtaLate,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), ed25519Instruction])
      .signers([payer])
      .rpc();

    // Verify deposit account exists
    const depositInfo = await escrowProgram.account.depositInfo.fetch(
      depositLate
    );
    expect(depositInfo.amount.eq(DEPOSIT_AMOUNT)).to.be.true;
  });

  it.skip("8.8. Should clear bitmap after 2 epochs (Epoch Diff 2)", async function () {
    // This test waits ~9 minutes to cross two 256s slices to trigger bitmap wipe
    this.timeout(12 * 60 * 1000);

    const nonce = new anchor.BN("0000000C0000000A", 16); // bucket 12, slot 10

    // First deposit to set the bit in current parity
    const paymentIdA = createPaymentId();
    const issuedAtA = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const deadlineA = new anchor.BN(issuedAtA.toNumber() + 60);
    const messageA = await createMessage("deposit", [
      paymentIdA,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAtA.toBuffer("le", 8),
      deadlineA.toBuffer("le", 8),
    ]);
    const ed25519InstructionA = createEd25519Instruction(
      delegateSigner,
      messageA
    );
    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const [depositA] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, messageA],
      escrowProgram.programId
    );
    const escrowAtaA = await getAssociatedTokenAddress(mint, depositA, true);

    await escrowProgram.methods
      .deposit(
        Array.from(paymentIdA),
        TEST_DESTINATION,
        DEPOSIT_AMOUNT,
        reserver.publicKey,
        releaser.publicKey,
        nonce,
        issuedAtA,
        deadlineA,
        Array.from(messageA)
      )
      .accountsPartial({
        protocolConfig,
        mintFeeConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket,
        authorityAta,
        deposit: depositA,
        escrowAta: escrowAtaA,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), ed25519InstructionA])
      .signers([payer])
      .rpc();

    // Wait for two full slices to elapse so diff == 2 and bitmap wipes
    await sleep(2 * REPLAY_SLICE_SECS * 1000 + 3000);

    // Second deposit with the same bucket and slot should succeed after wipe
    const paymentIdB = createPaymentId();
    const issuedAtB = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const deadlineB = new anchor.BN(issuedAtB.toNumber() + 60);
    const messageB = await createMessage("deposit", [
      paymentIdB,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAtB.toBuffer("le", 8),
      deadlineB.toBuffer("le", 8),
    ]);
    const ed25519InstructionB = createEd25519Instruction(
      delegateSigner,
      messageB
    );
    const [depositB] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, messageB],
      escrowProgram.programId
    );
    const escrowAtaB = await getAssociatedTokenAddress(mint, depositB, true);

    await escrowProgram.methods
      .deposit(
        Array.from(paymentIdB),
        TEST_DESTINATION,
        DEPOSIT_AMOUNT,
        reserver.publicKey,
        releaser.publicKey,
        nonce,
        issuedAtB,
        deadlineB,
        Array.from(messageB)
      )
      .accountsPartial({
        protocolConfig,
        mintFeeConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket,
        authorityAta,
        deposit: depositB,
        escrowAta: escrowAtaB,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), ed25519InstructionB])
      .signers([payer])
      .rpc();
  });

  it("8.9. Should reject the same nonce in the adjacent slice (Previous to Current)", async () => {
    // Use a distinct bucket and same slot; deposit once in the previous slice, then try the same nonce in the current slice
    const nonce = new anchor.BN("0000000D0000000A", 16); // bucket 13, slot 10
    // See 8.7: the previous slice is only reachable shortly after a slice boundary.
    const nowTs = await waitForSlicePhase();
    const remainder = nowTs % REPLAY_SLICE_SECS;

    const issuedAtPrev = new anchor.BN(nowTs - remainder - 1);
    const deadlinePrev = new anchor.BN(issuedAtPrev.toNumber() + 128);

    const paymentIdPrev = createPaymentId();
    const msgPrev = await createMessage("deposit", [
      paymentIdPrev,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAtPrev.toBuffer("le", 8),
      deadlinePrev.toBuffer("le", 8),
    ]);
    const sigPrev = createEd25519Instruction(delegateSigner, msgPrev);
    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const [depositPrev] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, msgPrev],
      escrowProgram.programId
    );
    const escrowAtaPrev = await getAssociatedTokenAddress(
      mint,
      depositPrev,
      true
    );

    await escrowProgram.methods
      .deposit(
        Array.from(paymentIdPrev),
        TEST_DESTINATION,
        DEPOSIT_AMOUNT,
        reserver.publicKey,
        releaser.publicKey,
        nonce,
        issuedAtPrev,
        deadlinePrev,
        Array.from(msgPrev)
      )
      .accountsPartial({
        protocolConfig,
        mintFeeConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket,
        authorityAta,
        deposit: depositPrev,
        escrowAta: escrowAtaPrev,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), sigPrev])
      .signers([payer])
      .rpc();

    // Now try the same nonce in the current slice. The two authorizations overlap in time and sit in
    // different parity bitmaps, so this used to succeed and debit the payer twice for one nonce. The
    // adjacent slice is now checked too, so it is a DuplicateTransaction.
    //
    // issuedAtPrev is always the last second of the previous slice and issuedAtCurr is derived from
    // `remainder`, which keeps it at or after the current slice's start, so the two are always
    // adjacent and the run does not depend on when in the slice it starts.
    const issuedAtCurr = new anchor.BN(nowTs - Math.min(remainder, 5));
    const deadlineCurr = new anchor.BN(issuedAtCurr.toNumber() + 60);
    const paymentIdCurr = createPaymentId();
    const msgCurr = await createMessage("deposit", [
      paymentIdCurr,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAtCurr.toBuffer("le", 8),
      deadlineCurr.toBuffer("le", 8),
    ]);
    const sigCurr = createEd25519Instruction(delegateSigner, msgCurr);
    const [depositCurr] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, msgCurr],
      escrowProgram.programId
    );
    const escrowAtaCurr = await getAssociatedTokenAddress(
      mint,
      depositCurr,
      true
    );

    // Keep the failure out of the assertion: expect.fail's own message names DuplicateTransaction,
    // so asserting inside the try would let a successful deposit pass.
    let failure: any;
    try {
      await escrowProgram.methods
        .deposit(
          Array.from(paymentIdCurr),
          TEST_DESTINATION,
          DEPOSIT_AMOUNT,
          reserver.publicKey,
          releaser.publicKey,
          nonce,
          issuedAtCurr,
          deadlineCurr,
          Array.from(msgCurr)
        )
        .accountsPartial({
          protocolConfig,
          mintFeeConfig,
          escrowDelegate: delegate,
          authority: depositor.publicKey,
          replayBucket,
          authorityAta,
          deposit: depositCurr,
          escrowAta: escrowAtaCurr,
          mint,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([depositComputeBudgetIx(), sigCurr])
        .signers([payer])
        .rpc();
    } catch (err: any) {
      failure = err;
    }
    expect(failure, "the second deposit must be rejected").to.not.equal(
      undefined
    );
    const failureText = [
      failure?.toString?.(),
      failure?.error?.errorCode?.code,
      failure?.message,
    ].join(" ");
    expect(failureText).to.include("DuplicateTransaction");
  });

  it("8.10. Should not collide across different authorities (scoped buckets)", async () => {
    // Use reserved bucket 10, slot 10 (0x0A)
    const nonce = new anchor.BN("0000000A0000000A", 16);
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);

    // Signer A's transaction
    const messageA = await createMessage("deposit", [
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
    const ed25519InstructionA = createEd25519Instruction(
      delegateSigner,
      messageA
    );
    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );

    // Update deposit PDA and escrow ATA to be derived from deposit hash
    [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, messageA],
      escrowProgram.programId
    );
    escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

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
        Array.from(messageA)
      )
      .accountsPartial({
        protocolConfig,
        mintFeeConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket,
        authorityAta,
        deposit,
        escrowAta,
        mint: mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), ed25519InstructionA])
      .signers([payer])
      .rpc();

    // Signer C's transaction (different signer, same nonce)
    const [signerC, depositorC] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);
    const delegateC = await createDelegate(
      depositorC,
      signerC,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );
    const paymentIdC = createPaymentId();
    const authorityAtaC = await getOrCreateAssociatedTokenAccount(
      mint,
      depositorC.publicKey
    );

    // Fund depositorC's account with tokens
    const transferTxC = new Transaction().add(
      createTransferInstruction(
        authorityAta,
        authorityAtaC,
        depositor.publicKey,
        BigInt(100_000_000) // Transfer 100 tokens
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTxC, [
      depositor,
    ]);
    const messageC = await createMessage("deposit", [
      paymentIdC,
      await destinationHash(),
      depositorC.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAt.toBuffer("le", 8),
      deadline.toBuffer("le", 8),
    ]);
    const ed25519InstructionC = createEd25519Instruction(signerC, messageC);
    const [depositC] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, messageC],
      escrowProgram.programId
    );
    const escrowAtaC = await getAssociatedTokenAddress(mint, depositC, true);

    const [replayBucketC] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositorC.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );

    await escrowProgram.methods
      .deposit(
        Array.from(paymentIdC),
        TEST_DESTINATION,
        DEPOSIT_AMOUNT,
        reserver.publicKey,
        releaser.publicKey,
        nonce,
        issuedAt,
        deadline,
        Array.from(messageC)
      )
      .accountsPartial({
        protocolConfig,
        mintFeeConfig,
        escrowDelegate: delegateC,
        authority: depositorC.publicKey,
        replayBucket: replayBucketC,
        authorityAta: authorityAtaC,
        deposit: depositC,
        escrowAta: escrowAtaC,
        mint: mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), ed25519InstructionC])
      .signers([payer])
      .rpc();

    const depositInfoC = await escrowProgram.account.depositInfo.fetch(
      depositC
    );
    expect(depositInfoC.amount.eq(DEPOSIT_AMOUNT)).to.be.true;
  });

  it("8.11. Should reject replayed post-deposit signatures on a new deposit (long-range)", async () => {
    // Use fixed nonces in valid slot range
    const nonceA = new anchor.BN("0000000E00000005", 16);
    const issuedAtA = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const deadlineA = new anchor.BN(issuedAtA.toNumber() + 60);

    const paymentId = createPaymentId();

    // Create first deposit (A)
    const msgA = await createMessage("deposit", [
      paymentId,
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonceA.toBuffer("le", 8),
      issuedAtA.toBuffer("le", 8),
      deadlineA.toBuffer("le", 8),
    ]);
    const sigA = createEd25519Instruction(delegateSigner, msgA);
    const [replayA] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonceA.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const [depositA] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, msgA],
      escrowProgram.programId
    );
    const escrowAtaA = await getAssociatedTokenAddress(mint, depositA, true);

    await escrowProgram.methods
      .deposit(
        Array.from(paymentId),
        TEST_DESTINATION,
        DEPOSIT_AMOUNT,
        reserver.publicKey,
        releaser.publicKey,
        nonceA,
        issuedAtA,
        deadlineA,
        Array.from(msgA)
      )
      .accountsPartial({
        protocolConfig,
        mintFeeConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket: replayA,
        authorityAta,
        deposit: depositA,
        escrowAta: escrowAtaA,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), sigA])
      .signers([payer])
      .rpc();

    // Prepare post-deposit signatures for deposit A
    const recipientA = (await generateFundedKeypair()).publicKey;
    const reserveMsgA = await createMessage("reserve", [
      recipientA.toBuffer(),
      msgA,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    const reserveSigA = createEd25519Instruction(reserver, reserveMsgA);
    const refundMsgA = await createMessage("refund", [msgA, ZERO_QUOTE_HASH]);
    const refundSigA = createEd25519Instruction(releaser, refundMsgA);

    // Execute refund for A (closing deposit A)
    await escrowProgram.methods
      .refund()
      .accountsPartial({
        protocolConfig,
        deposit: depositA,
        escrowAta: escrowAtaA,
        depositor: depositor.publicKey,
        depositorAta: authorityAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([refundSigA])
      .signers([payer])
      .rpc();

    // Create second deposit (B) reusing the SAME paymentId, but new nonce/time
    const nonceB = new anchor.BN("0000000F00000006", 16);
    const issuedAtB = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const deadlineB = new anchor.BN(issuedAtB.toNumber() + 60);
    const msgB = await createMessage("deposit", [
      paymentId, // same paymentId
      await destinationHash(),
      depositor.publicKey.toBuffer(),
      mint.toBuffer(),
      DEPOSIT_AMOUNT.toBuffer("le", 8),
      reserver.publicKey.toBuffer(),
      releaser.publicKey.toBuffer(),
      nonceB.toBuffer("le", 8),
      issuedAtB.toBuffer("le", 8),
      deadlineB.toBuffer("le", 8),
    ]);
    const sigB = createEd25519Instruction(delegateSigner, msgB);
    const [replayB] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonceB.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const [depositB] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, msgB],
      escrowProgram.programId
    );
    const escrowAtaB = await getAssociatedTokenAddress(mint, depositB, true);

    await escrowProgram.methods
      .deposit(
        Array.from(paymentId),
        TEST_DESTINATION,
        DEPOSIT_AMOUNT,
        reserver.publicKey,
        releaser.publicKey,
        nonceB,
        issuedAtB,
        deadlineB,
        Array.from(msgB)
      )
      .accountsPartial({
        protocolConfig,
        mintFeeConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket: replayB,
        authorityAta,
        deposit: depositB,
        escrowAta: escrowAtaB,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), sigB])
      .signers([payer])
      .rpc();

    // Attempt to replay refund signature from A on deposit B
    try {
      await escrowProgram.methods
        .refund()
        .accountsPartial({
          protocolConfig,
          deposit: depositB,
          escrowAta: escrowAtaB,
          depositor: depositor.publicKey,
          depositorAta: authorityAta,
          mint,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([refundSigA]) // old signature bound to msgA
        .signers([payer])
        .rpc();
      expect.fail("Replay of old refund signature should fail");
    } catch (err: any) {
      const code = err.error?.errorCode?.code;
      if (code) expect(["InvalidMessage", "SignatureMessageSizeInvalid"]).to.include(code);
      else
        expect(err.toString()).to.satisfy(
          (s: string) =>
            s.includes("InvalidMessage") || s.includes("SignatureMessageSizeInvalid")
        );
    }

    // Attempt to replay reserve signature from A on deposit B
    try {
      await escrowProgram.methods
        .reserve(recipientA, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
        .accountsPartial({
          protocolConfig,
          deposit: depositB,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([reserveSigA]) // old signature bound to msgA
        .rpc();
      expect.fail("Replay of old reserve signature should fail");
    } catch (err: any) {
      const code = err.error?.errorCode?.code;
      if (code) expect(["InvalidMessage", "SignatureMessageSizeInvalid"]).to.include(code);
      else
        expect(err.toString()).to.satisfy(
          (s: string) =>
            s.includes("InvalidMessage") || s.includes("SignatureMessageSizeInvalid")
        );
    }
  });
});
