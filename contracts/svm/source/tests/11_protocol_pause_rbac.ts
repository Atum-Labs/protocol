import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Escrow } from "../target/types/escrow";
import {
  expect,
  Keypair,
  PublicKey,
  SystemProgram,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ESCROW_DELEGATE_SEED,
  DEPOSIT_SEED,
  REPLAY_SEED,
  DELEGATE_CAPACITY,
  MAX_TRANSFER_SIZE,
  DEPOSIT_AMOUNT,
  ensureProtocolInitialized,
  getMintFeeConfigAddress,
  setupMintAndFund,
  pauserKeypair,
  treasurerKeypair,
  secondaryAdminKeypair,
  fundPauser,
  fundSecondaryAdmin,
  topUp,
  generateFundedKeypair,
  createDelegate,
  depositSigIx,
  refundSigIx,
  releaseSigIx,
  reserveSigIx,
  createPaymentId,
  createValidNonce,
  createMessage,
  getOrCreateAssociatedTokenAccount,
  DEFAULT_QUOTE_HASH,
  ZERO_QUOTE_HASH,
  destinationHash,
  depositComputeBudgetIx,
} from "./helpers";
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

describe("11 Pause + RBAC", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Escrow as Program<Escrow>;

  let protocolConfig: PublicKey;
  let mint: PublicKey;
  let mintFeeConfig: PublicKey;
  let authorityAta: PublicKey;

  // For deposit/reserve/release/refund tests while paused
  let depositor: Keypair;
  let _delegateSigner: Keypair;
  let reserver: Keypair;
  let releaser: Keypair;
  let payer: Keypair;

  before(async () => {
    protocolConfig = await ensureProtocolInitialized(program, provider);
    await fundPauser(provider);
    await fundSecondaryAdmin(provider);

    const mintSetup = await setupMintAndFund();
    mint = mintSetup.mint;
    mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

    // Setup test accounts for paused operation tests
    [depositor, _delegateSigner, reserver, releaser, payer] = await Promise.all(
      [
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]
    );

    // Create the depositor's ATA and fund it
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
  });

  afterEach(async () => {
    // Ensure protocol is unpaused after each test
    const config = await program.account.protocolConfig.fetch(protocolConfig);
    if (config.paused) {
      await program.methods
        .unpause()
        .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
        .signers([pauserKeypair])
        .rpc();
    }
  });

  // ============================================================
  // 11.1 - 11.2: Basic pause/unpause authorization
  // ============================================================

  it("11.1 non-pauser cannot pause", async () => {
    const randomSigner = Keypair.generate();
    await topUp(randomSigner);

    try {
      await program.methods
        .pause()
        .accountsPartial({ pauser: randomSigner.publicKey, protocolConfig })
        .signers([randomSigner])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "Unauthorized"
      );
    }
  });

  it("11.2 non-pauser cannot unpause", async () => {
    // First pause with valid pauser
    await program.methods
      .pause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    const randomSigner = Keypair.generate();
    await topUp(randomSigner);

    try {
      await program.methods
        .unpause()
        .accountsPartial({ pauser: randomSigner.publicKey, protocolConfig })
        .signers([randomSigner])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "Unauthorized"
      );
    }
  });

  // ============================================================
  // 11.3 - 11.9: Paused blocks operations
  // ============================================================

  it("11.3 paused blocks create_delegate", async () => {
    // Pause the protocol
    await program.methods
      .pause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    const newAuthority = await generateFundedKeypair();
    const newDelegateSigner = Keypair.generate();
    const expiration = new anchor.BN(Math.floor(Date.now() / 1000) + 86400);

    const [delegatePda] = PublicKey.findProgramAddressSync(
      [
        ESCROW_DELEGATE_SEED,
        newAuthority.publicKey.toBuffer(),
        mint.toBuffer(),
      ],
      program.programId
    );

    const newAuthorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      newAuthority.publicKey
    );

    try {
      await program.methods
        .createDelegate(
          newDelegateSigner.publicKey,
          DELEGATE_CAPACITY,
          MAX_TRANSFER_SIZE,
          expiration
        )
        .accountsPartial({
          protocolConfig,
          authority: newAuthority.publicKey,
          escrowDelegate: delegatePda,
          authorityAta: newAuthorityAta,
          mint,
          payer: newAuthority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([newAuthority])
        .rpc();
      expect.fail("Should have thrown ProtocolPaused");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "ProtocolPaused"
      );
    }
  });

  it("11.4 paused blocks revoke_delegate", async () => {
    // First create a delegate while unpaused
    const newDelegateSigner = await generateFundedKeypair();
    const delegate = await createDelegate(
      depositor,
      newDelegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    // Pause the protocol
    await program.methods
      .pause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    try {
      await program.methods
        .revokeDelegate()
        .accountsPartial({
          protocolConfig,
          escrowDelegate: delegate,
          authority: depositor.publicKey,
          authorityAta,
          payer: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([depositor, payer])
        .rpc();
      expect.fail("Should have thrown ProtocolPaused");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "ProtocolPaused"
      );
    }

    // Unpause and clean up
    await program.methods
      .unpause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    await program.methods
      .revokeDelegate()
      .accountsPartial({
        protocolConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        authorityAta,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor, payer])
      .rpc();
  });

  it("11.5 paused blocks renounce_delegate", async () => {
    // First create a delegate while unpaused
    const newDelegateSigner = await generateFundedKeypair();
    const delegate = await createDelegate(
      depositor,
      newDelegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    // Pause the protocol
    await program.methods
      .pause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    try {
      await program.methods
        .renounceDelegate()
        .accountsPartial({
          protocolConfig,
          escrowDelegate: delegate,
          delegateSigner: newDelegateSigner.publicKey,
        })
        .signers([newDelegateSigner])
        .rpc();
      expect.fail("Should have thrown ProtocolPaused");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "ProtocolPaused"
      );
    }

    // Unpause and clean up
    await program.methods
      .unpause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    await program.methods
      .revokeDelegate()
      .accountsPartial({
        protocolConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        authorityAta,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor, payer])
      .rpc();
  });

  it("11.6 paused blocks deposit", async () => {
    // Create delegate while unpaused
    const newDelegateSigner = await generateFundedKeypair();
    const delegate = await createDelegate(
      depositor,
      newDelegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    // Pause the protocol
    await program.methods
      .pause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    const paymentId = createPaymentId();
    const nonce = createValidNonce();
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
    const depositHash = message;

    const ed25519Instruction = depositSigIx(
      newDelegateSigner,
      message
    );

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, depositHash],
      program.programId
    );
    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      program.programId
    );
    const escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

    try {
      await program.methods
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
      expect.fail("Should have thrown ProtocolPaused");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "ProtocolPaused"
      );
    }

    // Unpause and clean up delegate
    await program.methods
      .unpause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    await program.methods
      .revokeDelegate()
      .accountsPartial({
        protocolConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        authorityAta,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor, payer])
      .rpc();
  });

  it("11.7 paused blocks reserve", async () => {
    // Create delegate and deposit while unpaused
    const newDelegateSigner = await generateFundedKeypair();
    const delegate = await createDelegate(
      depositor,
      newDelegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

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
    const depositHash = depositMessage;

    const depositEd25519 = depositSigIx(
      newDelegateSigner,
      depositMessage
    );

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, depositHash],
      program.programId
    );
    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      program.programId
    );
    const escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

    await program.methods
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
      .preInstructions([depositComputeBudgetIx(), depositEd25519])
      .signers([payer])
      .rpc();

    // Pause the protocol
    await program.methods
      .pause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    // Try to reserve
    const recipient = Keypair.generate().publicKey;
    const reserveMessage = await createMessage("reserve", [
      recipient.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    const reserveEd25519 = reserveSigIx(reserver, reserveMessage);

    try {
      await program.methods
        .reserve(recipient, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
        .accountsPartial({
          deposit,
          protocolConfig,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([reserveEd25519])
        .rpc();
      expect.fail("Should have thrown ProtocolPaused");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "ProtocolPaused"
      );
    }

    // Unpause and clean up: refund and revoke delegate
    await program.methods
      .unpause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    const refundMessage = await createMessage("refund", [
      depositHash,
      ZERO_QUOTE_HASH,
    ]);
    const refundEd25519 = refundSigIx(releaser, refundMessage);

    await program.methods
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
      .preInstructions([refundEd25519])
      .signers([payer])
      .rpc();

    await program.methods
      .revokeDelegate()
      .accountsPartial({
        protocolConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        authorityAta,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor, payer])
      .rpc();
  });

  it("11.8 paused blocks release", async () => {
    // Create delegate, deposit, and reserve while unpaused
    const newDelegateSigner = await generateFundedKeypair();
    const delegate = await createDelegate(
      depositor,
      newDelegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

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
    const depositHash = depositMessage;

    const depositEd25519 = depositSigIx(
      newDelegateSigner,
      depositMessage
    );

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, depositHash],
      program.programId
    );
    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      program.programId
    );
    const escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

    await program.methods
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
      .preInstructions([depositComputeBudgetIx(), depositEd25519])
      .signers([payer])
      .rpc();

    // Reserve
    const recipient = await generateFundedKeypair();
    const reserveMessage = await createMessage("reserve", [
      recipient.publicKey.toBuffer(),
      depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    const reserveEd25519 = reserveSigIx(reserver, reserveMessage);

    await program.methods
      .reserve(recipient.publicKey, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
      .accountsPartial({
        deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveEd25519])
      .rpc();

    // Pause the protocol
    await program.methods
      .pause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    // Try to release
    const releaseMessage = await createMessage("release", [
      depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    const releaseEd25519 = releaseSigIx(releaser, releaseMessage);
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      mint,
      recipient.publicKey
    );
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      mint,
      treasurerKeypair.publicKey
    );

    try {
      await program.methods
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
        .preInstructions([releaseEd25519])
        .signers([payer])
        .rpc();
      expect.fail("Should have thrown ProtocolPaused");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "ProtocolPaused"
      );
    }

    // Unpause and clean up: release and revoke delegate
    await program.methods
      .unpause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    await program.methods
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
      .preInstructions([releaseEd25519])
      .signers([payer])
      .rpc();

    await program.methods
      .revokeDelegate()
      .accountsPartial({
        protocolConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        authorityAta,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor, payer])
      .rpc();
  });

  it("11.9 paused blocks refund", async () => {
    // Create delegate and deposit while unpaused
    const newDelegateSigner = await generateFundedKeypair();
    const delegate = await createDelegate(
      depositor,
      newDelegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

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
    const depositHash = depositMessage;

    const depositEd25519 = depositSigIx(
      newDelegateSigner,
      depositMessage
    );

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, depositHash],
      program.programId
    );
    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      program.programId
    );
    const escrowAta = await getAssociatedTokenAddress(mint, deposit, true);

    await program.methods
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
      .preInstructions([depositComputeBudgetIx(), depositEd25519])
      .signers([payer])
      .rpc();

    // Pause the protocol
    await program.methods
      .pause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    // Try to refund
    const refundMessage = await createMessage("refund", [
      depositHash,
      ZERO_QUOTE_HASH,
    ]);
    const refundEd25519 = refundSigIx(releaser, refundMessage);

    try {
      await program.methods
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
        .preInstructions([refundEd25519])
        .signers([payer])
        .rpc();
      expect.fail("Should have thrown ProtocolPaused");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "ProtocolPaused"
      );
    }

    // Unpause and clean up: refund and revoke delegate
    await program.methods
      .unpause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    await program.methods
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
      .preInstructions([refundEd25519])
      .signers([payer])
      .rpc();

    await program.methods
      .revokeDelegate()
      .accountsPartial({
        protocolConfig,
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        authorityAta,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor, payer])
      .rpc();
  });

  // ============================================================
  // 11.10: Admin functions allowed while paused
  // ============================================================

  it("11.10 mint config allowed while paused", async () => {
    await program.methods
      .pause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    // Should succeed even while paused - set_mint_fee_config
    await program.methods
      .setMintFeeConfig(new BN(1_000_000), new BN(0), new BN(0))
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Verify it worked
    const feeConfig = await program.account.mintFeeConfig.fetch(mintFeeConfig);
    expect(feeConfig.feePercentage6.toString()).to.equal("1000000");

    // Cleanup - clear the fee config
    await program.methods
      .clearMintFeeConfig()
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintFeeConfig,
      })
      .rpc();

    // Verify cleared
    const clearedConfig = await program.account.mintFeeConfig.fetch(
      mintFeeConfig
    );
    expect(clearedConfig.feePercentage6.toString()).to.equal("0");
  });

  // ============================================================
  // 11.11 - 11.12: Pauser rotation
  // ============================================================

  it("11.11 pauser rotation while paused", async () => {
    const newPauser = Keypair.generate();
    await topUp(newPauser);

    // Pause
    await program.methods
      .pause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    // Rotate pauser (allowed while paused)
    await program.methods
      .setPauser(newPauser.publicKey)
      .accountsPartial({
        defaultAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();

    // Verify new pauser is set
    const configAfterRotation = await program.account.protocolConfig.fetch(
      protocolConfig
    );
    expect(configAfterRotation.pauser.toBase58()).to.equal(
      newPauser.publicKey.toBase58()
    );

    // Old pauser cannot unpause
    try {
      await program.methods
        .unpause()
        .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
        .signers([pauserKeypair])
        .rpc();
      expect.fail("Old pauser should not be able to unpause");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "Unauthorized"
      );
    }

    // New pauser can unpause
    await program.methods
      .unpause()
      .accountsPartial({ pauser: newPauser.publicKey, protocolConfig })
      .signers([newPauser])
      .rpc();

    // Restore original pauser
    await program.methods
      .setPauser(pauserKeypair.publicKey)
      .accountsPartial({
        defaultAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();
  });

  it("11.12 pauser rotation while unpaused", async () => {
    const newPauser = Keypair.generate();
    await topUp(newPauser);

    // Verify protocol is unpaused
    const configBefore = await program.account.protocolConfig.fetch(
      protocolConfig
    );
    expect(configBefore.paused).to.equal(false);

    // Rotate pauser
    await program.methods
      .setPauser(newPauser.publicKey)
      .accountsPartial({
        defaultAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();

    // Verify new pauser is set
    const configAfter = await program.account.protocolConfig.fetch(
      protocolConfig
    );
    expect(configAfter.pauser.toBase58()).to.equal(
      newPauser.publicKey.toBase58()
    );

    // New pauser can pause
    await program.methods
      .pause()
      .accountsPartial({ pauser: newPauser.publicKey, protocolConfig })
      .signers([newPauser])
      .rpc();

    // Verify paused
    const configPaused = await program.account.protocolConfig.fetch(
      protocolConfig
    );
    expect(configPaused.paused).to.equal(true);

    // New pauser can unpause
    await program.methods
      .unpause()
      .accountsPartial({ pauser: newPauser.publicKey, protocolConfig })
      .signers([newPauser])
      .rpc();

    // Restore original pauser
    await program.methods
      .setPauser(pauserKeypair.publicKey)
      .accountsPartial({
        defaultAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();
  });

  // ============================================================
  // 11.13: Default admin transfer while paused
  // ============================================================

  it("11.13 default admin transfer while paused (with delay)", async () => {
    // Pause
    await program.methods
      .pause()
      .accountsPartial({ pauser: pauserKeypair.publicKey, protocolConfig })
      .signers([pauserKeypair])
      .rpc();

    // Begin admin transfer (allowed while paused)
    await program.methods
      .beginDefaultAdminTransfer(secondaryAdminKeypair.publicKey)
      .accountsPartial({
        defaultAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();

    // Verify pending admin is set
    const configPending = await program.account.protocolConfig.fetch(
      protocolConfig
    );
    expect(configPending.pendingDefaultAdmin?.toBase58()).to.equal(
      secondaryAdminKeypair.publicKey.toBase58()
    );

    // Since delay is 0, accept immediately (allowed while paused)
    await program.methods
      .acceptDefaultAdminTransfer()
      .accountsPartial({
        pendingAdmin: secondaryAdminKeypair.publicKey,
        protocolConfig,
      })
      .signers([secondaryAdminKeypair])
      .rpc();

    // Verify admin changed
    const configAfter = await program.account.protocolConfig.fetch(
      protocolConfig
    );
    expect(configAfter.defaultAdmin.toBase58()).to.equal(
      secondaryAdminKeypair.publicKey.toBase58()
    );
    expect(configAfter.pendingDefaultAdmin).to.be.null;

    // Transfer admin back to original
    await program.methods
      .beginDefaultAdminTransfer(provider.wallet.publicKey)
      .accountsPartial({
        defaultAdmin: secondaryAdminKeypair.publicKey,
        protocolConfig,
      })
      .signers([secondaryAdminKeypair])
      .rpc();

    await program.methods
      .acceptDefaultAdminTransfer()
      .accountsPartial({
        pendingAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();
  });

  it("11.13b reject premature admin transfer acceptance (delay > 0)", async () => {
    // Set a non-zero delay (e.g., 60 seconds)
    await program.methods
      .setDefaultAdminDelaySeconds(60)
      .accountsPartial({
        defaultAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();

    // Begin admin transfer
    await program.methods
      .beginDefaultAdminTransfer(secondaryAdminKeypair.publicKey)
      .accountsPartial({
        defaultAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();

    // Try to accept immediately - should fail with AdminTransferNotReady
    try {
      await program.methods
        .acceptDefaultAdminTransfer()
        .accountsPartial({
          pendingAdmin: secondaryAdminKeypair.publicKey,
          protocolConfig,
        })
        .signers([secondaryAdminKeypair])
        .rpc();
      expect.fail("Should have thrown AdminTransferNotReady");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "AdminTransferNotReady"
      );
    }

    // Clean up: reset delay to 0 and complete the transfer
    // First cancel by initiating a new transfer to the original admin
    await program.methods
      .beginDefaultAdminTransfer(provider.wallet.publicKey)
      .accountsPartial({
        defaultAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();

    // Reset delay to 0 so we can accept immediately
    await program.methods
      .setDefaultAdminDelaySeconds(0)
      .accountsPartial({
        defaultAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();

    // Note: after setting delay to 0, new transfers will have immediate acceptance
    // but the pending transfer still has its original accept_after_ts
    // So just clear the pending admin by starting a fresh transfer with delay=0
    await program.methods
      .beginDefaultAdminTransfer(provider.wallet.publicKey)
      .accountsPartial({
        defaultAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();

    // Accept immediately
    await program.methods
      .acceptDefaultAdminTransfer()
      .accountsPartial({
        pendingAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();
  });

  // ============================================================
  // 11.14: Unauthorized role/config changes
  // ============================================================

  it("11.14 unauthorized role/config changes rejected", async () => {
    const randomSigner = Keypair.generate();
    await topUp(randomSigner);

    // Non-admin cannot set pauser
    try {
      await program.methods
        .setPauser(randomSigner.publicKey)
        .accountsPartial({
          defaultAdmin: randomSigner.publicKey,
          protocolConfig,
        })
        .signers([randomSigner])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "Unauthorized"
      );
    }

    // Non-admin cannot set treasurer
    try {
      await program.methods
        .setTreasurer(randomSigner.publicKey)
        .accountsPartial({
          defaultAdmin: randomSigner.publicKey,
          protocolConfig,
        })
        .signers([randomSigner])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "Unauthorized"
      );
    }

    // Non-admin cannot set token config authority
    try {
      await program.methods
        .setTokenConfigAuthority(randomSigner.publicKey)
        .accountsPartial({
          defaultAdmin: randomSigner.publicKey,
          protocolConfig,
        })
        .signers([randomSigner])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "Unauthorized"
      );
    }

    // Non-admin cannot begin admin transfer
    try {
      await program.methods
        .beginDefaultAdminTransfer(randomSigner.publicKey)
        .accountsPartial({
          defaultAdmin: randomSigner.publicKey,
          protocolConfig,
        })
        .signers([randomSigner])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "Unauthorized"
      );
    }

    // Non-token-config-authority cannot set mint fee config
    try {
      await program.methods
        .setMintFeeConfig(new BN(1_000_000), new BN(0), new BN(0))
        .accountsPartial({
          tokenConfigAuthority: randomSigner.publicKey,
          protocolConfig,
          mintAccount: mint,
          mintFeeConfig,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([randomSigner])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "Unauthorized"
      );
    }

    // Non-token-config-authority cannot allow mint
    const newMint = Keypair.generate().publicKey;
    const newMintFeeConfig = getMintFeeConfigAddress(
      newMint,
      program.programId
    );

    try {
      await program.methods
        .allowMint(PublicKey.default)
        .accountsPartial({
          tokenConfigAuthority: randomSigner.publicKey,
          protocolConfig,
          mintAccount: newMint,
          mintFeeConfig: newMintFeeConfig,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([randomSigner])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      // Can be Unauthorized or AccountNotInitialized depending on constraint order
      const code = err.error?.errorCode?.code || err.message;
      expect(
        code.includes("Unauthorized") || code.includes("AccountNotInitialized")
      ).to.equal(true);
    }

    // Non-token-config-authority cannot disallow mint
    try {
      await program.methods
        .disallowMint()
        .accountsPartial({
          tokenConfigAuthority: randomSigner.publicKey,
          protocolConfig,
          mintFeeConfig,
        })
        .signers([randomSigner])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "Unauthorized"
      );
    }
  });
});
