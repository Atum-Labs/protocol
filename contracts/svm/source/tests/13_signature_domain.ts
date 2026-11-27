import {
  anchor,
  escrowProgram,
  provider,
  DEPOSIT_SEED,
  REPLAY_SEED,
  DEPOSIT_AMOUNT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SystemProgram,
  expect,
  PublicKey,
  ESCROW_SIGNATURE_DOMAIN_VERSION,
  ESCROW_TEST_CLUSTER_ID,
  createDelegate,
  depositSigIx,
  refundSigIx,
  releaseSigIx,
  reserveSigIx,
  createMessage,
  createPaymentId,
  createValidNonce,
  ensureProtocolInitialized,
  fetchEscrowProtocolConfig,
  generateFundedKeypair,
  getOrCreateAssociatedTokenAccount,
  setupMintAndFund,
  treasurerKeypair,
  DEFAULT_QUOTE_HASH,
  ZERO_QUOTE_HASH,
  destinationHash,
  depositComputeBudgetIx,
} from "./helpers";
import { createTransferInstruction } from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

describe("13. Signature Domain", () => {
  let protocolConfig: PublicKey;

  before(async () => {
    protocolConfig = await ensureProtocolInitialized(escrowProgram, provider);
  });

  async function buildDepositFixture() {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const mainAuthorityAta = mintSetup.authorityTokenAccount;

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
        BigInt(500_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      new anchor.BN(1_000_000_000),
      new anchor.BN(100_000_000),
      1
    );

    const paymentId = createPaymentId();
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const deadline = new anchor.BN(issuedAt.toNumber() + 60);
    const messageArgs: Buffer[] = [
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
    ];

    const correctMessage = await createMessage("deposit", messageArgs, {
      protocolConfig,
    });
    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, correctMessage],
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
    const escrowAta = await getOrCreateAssociatedTokenAccount(
      mint,
      deposit,
      provider.wallet.payer!
    );

    return {
      authorityAta,
      correctMessage,
      deadline,
      delegate,
      delegateSigner,
      deposit,
      depositHash: correctMessage,
      depositor,
      escrowAta,
      issuedAt,
      messageArgs,
      mint,
      mintFeeConfig,
      nonce,
      payer,
      paymentId,
      releaser,
      replayBucket,
      reserver,
    };
  }

  async function expectDepositResult(
    fixture: Awaited<ReturnType<typeof buildDepositFixture>>,
    signingMessage: Buffer,
    expectedErrorCode?: string
  ) {
    const builder = escrowProgram.methods
      .deposit(
        Array.from(fixture.paymentId),
        Array.from(await destinationHash()),
        DEPOSIT_AMOUNT,
        fixture.reserver.publicKey,
        fixture.releaser.publicKey,
        fixture.nonce,
        fixture.issuedAt,
        fixture.deadline,
        Array.from(fixture.depositHash)
      )
      .accountsPartial({
        escrowDelegate: fixture.delegate,
        authority: fixture.depositor.publicKey,
        replayBucket: fixture.replayBucket,
        authorityAta: fixture.authorityAta,
        deposit: fixture.deposit,
        escrowAta: fixture.escrowAta,
        mint: fixture.mint,
        protocolConfig,
        mintFeeConfig: fixture.mintFeeConfig,
        payer: fixture.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), 
        depositSigIx(fixture.delegateSigner, signingMessage),
      ])
      .signers([fixture.payer]);

    if (!expectedErrorCode) {
      await builder.rpc();
      return fixture;
    }

    try {
      await builder.rpc();
      expect.fail(`Should have thrown ${expectedErrorCode}`);
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal(expectedErrorCode);
    }

    return fixture;
  }

  async function buildDepositedFixture() {
    const fixture = await buildDepositFixture();
    await expectDepositResult(fixture, fixture.correctMessage);
    return fixture;
  }

  async function expectReserveResult(
    fixture: Awaited<ReturnType<typeof buildDepositedFixture>>,
    recipient: PublicKey,
    signingMessage: Buffer,
    expectedErrorCode?: string
  ) {
    const builder = escrowProgram.methods
      .reserve(recipient, Array.from(DEFAULT_QUOTE_HASH), DEPOSIT_AMOUNT)
      .accountsPartial({
        deposit: fixture.deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        reserveSigIx(fixture.reserver, signingMessage),
      ]);

    if (!expectedErrorCode) {
      await builder.rpc();
      return fixture;
    }

    try {
      await builder.rpc();
      expect.fail(`Should have thrown ${expectedErrorCode}`);
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal(expectedErrorCode);
    }

    return fixture;
  }

  async function buildReservedFixture() {
    const fixture = await buildDepositedFixture();
    const recipient = await generateFundedKeypair();
    const reserveMessage = await createMessage(
      "reserve",
      [recipient.publicKey.toBuffer(), fixture.depositHash, DEFAULT_QUOTE_HASH,
        DEPOSIT_AMOUNT.toBuffer("le", 8),
      ],
      { protocolConfig }
    );
    await expectReserveResult(fixture, recipient.publicKey, reserveMessage);

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      fixture.mint,
      recipient.publicKey
    );
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      fixture.mint,
      treasurerKeypair.publicKey
    );

    return {
      ...fixture,
      recipient,
      recipientAta,
      treasuryAta,
    };
  }

  async function expectReleaseResult(
    fixture: Awaited<ReturnType<typeof buildReservedFixture>>,
    signingMessage: Buffer,
    expectedErrorCode?: string
  ) {
    const builder = escrowProgram.methods
      .release()
      .accountsPartial({
        protocolConfig,
        deposit: fixture.deposit,
        escrowAta: fixture.escrowAta,
        recipient: fixture.recipient.publicKey,
        recipientAta: fixture.recipientAta,
        depositor: fixture.depositor.publicKey,
        depositorAta: fixture.authorityAta,
        treasurer: treasurerKeypair.publicKey,
        treasuryAta: fixture.treasuryAta,
        mint: fixture.mint,
        payer: fixture.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        releaseSigIx(fixture.releaser, signingMessage),
      ])
      .signers([fixture.payer]);

    if (!expectedErrorCode) {
      await builder.rpc();
      return fixture;
    }

    try {
      await builder.rpc();
      expect.fail(`Should have thrown ${expectedErrorCode}`);
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal(expectedErrorCode);
    }

    return fixture;
  }

  async function expectRefundResult(
    fixture: Awaited<ReturnType<typeof buildDepositedFixture>>,
    signingMessage: Buffer,
    expectedErrorCode?: string
  ) {
    const builder = escrowProgram.methods
      .refund()
      .accountsPartial({
        protocolConfig,
        deposit: fixture.deposit,
        escrowAta: fixture.escrowAta,
        depositor: fixture.depositor.publicKey,
        depositorAta: fixture.authorityAta,
        mint: fixture.mint,
        payer: fixture.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        refundSigIx(fixture.releaser, signingMessage),
      ])
      .signers([fixture.payer]);

    if (!expectedErrorCode) {
      await builder.rpc();
      return fixture;
    }

    try {
      await builder.rpc();
      expect.fail(`Should have thrown ${expectedErrorCode}`);
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal(expectedErrorCode);
    }

    return fixture;
  }

  it("13.1 discovers the signature domain from ProtocolConfig", async () => {
    const config = await fetchEscrowProtocolConfig(protocolConfig);
    expect(Buffer.from(config.clusterId).equals(ESCROW_TEST_CLUSTER_ID)).to.be
      .true;
    expect(config.signatureDomainVersion).to.equal(
      ESCROW_SIGNATURE_DOMAIN_VERSION
    );

    const fixture = await buildDepositFixture();
    await expectDepositResult(fixture, fixture.correctMessage);

    const depositAccount = await escrowProgram.account.depositInfo.fetch(
      fixture.deposit
    );
    expect(Buffer.from(depositAccount.depositHash).equals(fixture.depositHash))
      .to.be.true;
  });

  it("13.2 rejects deposit signatures built with the wrong cluster_id", async () => {
    const fixture = await buildDepositFixture();
    const wrongClusterId = Buffer.from(ESCROW_TEST_CLUSTER_ID);
    wrongClusterId[0] = (wrongClusterId[0] ?? 0) ^ 1;

    const wrongMessage = await createMessage("deposit", fixture.messageArgs, {
      protocolConfig,
      clusterId: wrongClusterId,
    });

    await expectDepositResult(fixture, wrongMessage, "InvalidMessage");
  });

  it("13.3 rejects deposit signatures built with the wrong program_id", async () => {
    const fixture = await buildDepositFixture();
    const wrongMessage = await createMessage("deposit", fixture.messageArgs, {
      protocolConfig,
      programId: SystemProgram.programId,
    });

    await expectDepositResult(fixture, wrongMessage, "InvalidMessage");
  });

  it("13.4 rejects deposit signatures built with the wrong version byte", async () => {
    const fixture = await buildDepositFixture();
    const wrongMessage = await createMessage("deposit", fixture.messageArgs, {
      protocolConfig,
      signatureDomainVersion: ESCROW_SIGNATURE_DOMAIN_VERSION + 1,
    });

    await expectDepositResult(fixture, wrongMessage, "InvalidMessage");
  });

  it("13.5 rejects reserve signatures built with the wrong cluster_id", async () => {
    const fixture = await buildDepositedFixture();
    const recipient = await generateFundedKeypair();
    const wrongClusterId = Buffer.from(ESCROW_TEST_CLUSTER_ID);
    wrongClusterId[0] = (wrongClusterId[0] ?? 0) ^ 1;

    const wrongMessage = await createMessage(
      "reserve",
      [recipient.publicKey.toBuffer(), fixture.depositHash, DEFAULT_QUOTE_HASH,
        DEPOSIT_AMOUNT.toBuffer("le", 8),
      ],
      { protocolConfig, clusterId: wrongClusterId }
    );

    await expectReserveResult(
      fixture,
      recipient.publicKey,
      wrongMessage,
      "InvalidMessage"
    );
  });

  it("13.6 rejects release signatures built with the wrong version byte", async () => {
    const fixture = await buildReservedFixture();
    const wrongMessage = await createMessage(
      "release",
      [fixture.depositHash, DEFAULT_QUOTE_HASH],
      {
        protocolConfig,
        signatureDomainVersion: ESCROW_SIGNATURE_DOMAIN_VERSION + 1,
      }
    );

    await expectReleaseResult(fixture, wrongMessage, "InvalidMessage");
  });

  it("13.7 rejects refund signatures built with the wrong program_id", async () => {
    const fixture = await buildDepositedFixture();
    const wrongMessage = await createMessage(
      "refund",
      [fixture.depositHash, ZERO_QUOTE_HASH],
      {
        protocolConfig,
        programId: SystemProgram.programId,
      }
    );

    await expectRefundResult(fixture, wrongMessage, "InvalidMessage");
  });
});
