import {
  anchor,
  escrowProgram,
  fulfillmentProgram,
  provider,
  expect,
  Keypair,
  PublicKey,
  createPaymentId,
  pauserKeypair,
  secondaryAdminKeypair,
  DEPOSIT_AMOUNT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SystemProgram,
  fundPauser,
  fundSecondaryAdmin,
  generateFundedKeypair,
  setupMintAndFund,
  setupTransferHookMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  createStrictFulfillArgs,
  createStrictFulfillReplayArgs,
  deriveFulfillmentReplayBucket,
  deriveStrictFulfillment,
  createMint,
  mintTo,
  buildTransferHookRemainingAccounts,
  ensureFulfillmentProxyInitialized,
  setupToken2022MintAndFund,
  MOCK_TRANSFER_HOOK_PROGRAM_ID,
  MINT_DECIMALS,
  REPLAY_HORIZON_SECS,
} from "./helpers";
import {
  createTransferInstruction,
  getAccount as splGetAccount,
  getOrCreateAssociatedTokenAccount as splGetOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  transferChecked,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

describe("6. Fulfillment Proxy", () => {
  const STRICT_FULFILLED_EVENT_DISCRIMINATOR = Buffer.from([
    27, 163, 12, 20, 64, 1, 100, 160,
  ]);
  const FULFILLED_EVENT_DISCRIMINATOR = Buffer.from([
    210, 174, 131, 213, 40, 182, 83, 110,
  ]);

  let mint: PublicKey;
  let protocolConfig: PublicKey;
  let settler: Keypair;
  let settlerAta: PublicKey;
  let to: Keypair;
  let toAta: PublicKey;
  let authorityTokenAccount: PublicKey;
  let transferHookMint: PublicKey;
  let transferHookSettlerAta: PublicKey;
  let transferHookToAta: PublicKey;
  let transferHookExtraAccountMetaList: PublicKey;

  before(async () => {
    protocolConfig = await ensureFulfillmentProxyInitialized(
      fulfillmentProgram,
      provider
    );

    [settler, to] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    // Mint enough tokens for the full suite.
    const mintSetup = await setupMintAndFund(6, BigInt(50_000_000_000)); // 50,000 tokens
    mint = mintSetup.mint;
    authorityTokenAccount = mintSetup.authorityTokenAccount;

    settlerAta = await getOrCreateAssociatedTokenAccount(
      mint,
      settler.publicKey
    );
    toAta = await getOrCreateAssociatedTokenAccount(mint, to.publicKey);

    // Transfer a large settler balance for all fulfillment scenarios.
    const transferTx = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        settlerAta,
        provider.wallet.publicKey,
        BigInt(5_000_000_000) // Transfer 5000 tokens
      )
    );

    await sendAndConfirmTransaction(provider.connection, transferTx, [
      provider.wallet.payer!,
    ]);

    const transferHookMintSetup = await setupTransferHookMint(
      escrowProgram,
      provider,
      provider.wallet.payer as Keypair,
      settler,
      {
        initialMintAmount: 5_000_000_000n,
      }
    );
    transferHookMint = transferHookMintSetup.mint;
    transferHookSettlerAta = transferHookMintSetup.depositorAta;
    transferHookExtraAccountMetaList =
      transferHookMintSetup.extraAccountMetaList;
    const transferHookToAtaAccount = await splGetOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer!,
      transferHookMint,
      to.publicKey,
      false,
      undefined,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    transferHookToAta = transferHookToAtaAccount.address;
  });

  const runStrictFulfill = async ({
    paymentId = createPaymentId(),
    amount = DEPOSIT_AMOUNT,
    replayArgs = createStrictFulfillReplayArgs(),
    settlerSigner = settler,
    payerSigner = settlerSigner,
    fromAta = settlerAta,
    recipient = to,
    recipientAta = toAta,
    mintKey = mint,
  }: {
    paymentId?: Buffer;
    amount?: anchor.BN;
    replayArgs?: ReturnType<typeof createStrictFulfillReplayArgs>;
    settlerSigner?: Keypair;
    payerSigner?: Keypair;
    fromAta?: PublicKey;
    recipient?: Keypair;
    recipientAta?: PublicKey;
    mintKey?: PublicKey;
  } = {}) => {
    const strictArgs = createStrictFulfillArgs(paymentId, amount, replayArgs);
    const [replayBucket] = deriveFulfillmentReplayBucket(
      replayArgs.nonce,
      settlerSigner.publicKey
    );
    const signers = payerSigner.publicKey.equals(settlerSigner.publicKey)
      ? [settlerSigner]
      : [settlerSigner, payerSigner];

    const txSig = await fulfillmentProgram.methods
      .strictFulfill(...strictArgs)
      .accountsPartial({
        protocolConfig,
        settler: settlerSigner.publicKey,
        payer: payerSigner.publicKey,
        replayBucket,
        fromAta,
        toAta: recipientAta,
        to: recipient.publicKey,
        mint: mintKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(signers)
      .rpc();

    return { txSig, replayBucket, replayArgs, paymentId, amount };
  };

  const runTransferHookFulfill = async ({
    withRemainingAccounts,
    paymentId = createPaymentId(),
  }: {
    withRemainingAccounts: boolean;
    paymentId?: Buffer;
  }) => {
    const builder = fulfillmentProgram.methods
      .fulfill(Array.from(paymentId), DEPOSIT_AMOUNT)
      .accountsPartial({
        protocolConfig,
        settler: settler.publicKey,
        payer: settler.publicKey,
        fromAta: transferHookSettlerAta,
        toAta: transferHookToAta,
        to: to.publicKey,
        mint: transferHookMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([settler]);

    if (withRemainingAccounts) {
      builder.remainingAccounts(
        buildTransferHookRemainingAccounts(transferHookExtraAccountMetaList)
      );
    }

    return builder.rpc();
  };

  const runTransferHookStrictFulfill = async ({
    withRemainingAccounts,
    paymentId = createPaymentId(),
    replayArgs = createStrictFulfillReplayArgs(),
  }: {
    withRemainingAccounts: boolean;
    paymentId?: Buffer;
    replayArgs?: ReturnType<typeof createStrictFulfillReplayArgs>;
  }) => {
    const strictArgs = createStrictFulfillArgs(
      paymentId,
      DEPOSIT_AMOUNT,
      replayArgs
    );
    const [replayBucket] = deriveFulfillmentReplayBucket(
      replayArgs.nonce,
      settler.publicKey
    );
    const builder = fulfillmentProgram.methods
      .strictFulfill(...strictArgs)
      .accountsPartial({
        protocolConfig,
        settler: settler.publicKey,
        payer: settler.publicKey,
        replayBucket,
        fromAta: transferHookSettlerAta,
        toAta: transferHookToAta,
        to: to.publicKey,
        mint: transferHookMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([settler]);

    if (withRemainingAccounts) {
      builder.remainingAccounts(
        buildTransferHookRemainingAccounts(transferHookExtraAccountMetaList)
      );
    }

    return builder.rpc();
  };

  const expectMissingTransferHookAccountsFailure = async (
    action: () => Promise<unknown>
  ) => {
    const settlerBefore = await splGetAccount(
      provider.connection,
      transferHookSettlerAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const toBefore = await splGetAccount(
      provider.connection,
      transferHookToAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    try {
      await action();
      expect.fail("Should have failed without TransferHook accounts");
    } catch (err: any) {
      const message = String(err?.message ?? err?.toString?.() ?? err);
      // 0x7dc8348c is the transfer hook interface's IncorrectAccount, raised when the hook program
      // or its extra accounts are missing from remaining_accounts.
      expect(message).to.match(
        /IncorrectAccount|Incorrect account provided|0x7dc8348c|missing|required by the instruction|unknown account|not enough account keys/i
      );
    }

    const settlerAfter = await splGetAccount(
      provider.connection,
      transferHookSettlerAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const toAfter = await splGetAccount(
      provider.connection,
      transferHookToAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    expect(settlerAfter.amount.toString()).to.equal(
      settlerBefore.amount.toString()
    );
    expect(toAfter.amount.toString()).to.equal(toBefore.amount.toString());
  };

  const findEventPayload = async (
    signature: string,
    eventDiscriminator: Buffer
  ): Promise<Buffer> => {
    // Localnet can lag for `getTransaction`; confirm first and retry with
    // `confirmed` + `finalized` before asserting.
    await provider.connection.confirmTransaction(signature, "confirmed");

    let tx = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      tx = await provider.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      if (tx === null) {
        tx = await provider.connection.getTransaction(signature, {
          commitment: "finalized",
          maxSupportedTransactionVersion: 0,
        });
      }
      if (tx !== null) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    expect(
      tx,
      `Transaction ${signature} was not available after retries`
    ).to.not.equal(null);

    const logs = tx?.meta?.logMessages ?? [];
    for (const log of logs) {
      if (!log.startsWith("Program data: ")) {
        continue;
      }
      const data = Buffer.from(log.slice("Program data: ".length), "base64");
      if (data.subarray(0, 8).equals(eventDiscriminator)) {
        return data.subarray(8);
      }
    }

    throw new Error("Expected event payload not found in transaction logs");
  };

  const readU64Le = (payload: Buffer, offset: number): anchor.BN =>
    new anchor.BN(payload.subarray(offset, offset + 8), "le");

  const decodeFulfilledEvent = (payload: Buffer) => {
    return {
      quoteHash: payload.subarray(0, 32),
      to: new PublicKey(payload.subarray(32, 64)),
      token: new PublicKey(payload.subarray(64, 96)),
      amount: readU64Le(payload, 96),
    };
  };

  const decodeStrictFulfilledEvent = (payload: Buffer) => {
    return {
      quoteHash: payload.subarray(0, 32),
      to: new PublicKey(payload.subarray(32, 64)),
      token: new PublicKey(payload.subarray(64, 96)),
      amount: readU64Le(payload, 96),
      nonce: readU64Le(payload, 104),
      issuedAt: readU64Le(payload, 112),
      deadline: readU64Le(payload, 120),
    };
  };

  it("6.1. Should fulfill a payment with replay protection", async () => {
    const paymentId = createPaymentId();
    const replayArgs = createStrictFulfillReplayArgs();
    const settlerBefore = await getAccount(provider.connection, settlerAta);
    const toBefore = await getAccount(provider.connection, toAta);

    await runStrictFulfill({ paymentId, replayArgs });

    const settlerAfter = await getAccount(provider.connection, settlerAta);
    const toAfter = await getAccount(provider.connection, toAta);

    expect(settlerAfter.amount.toString()).to.equal(
      new anchor.BN(settlerBefore.amount.toString())
        .sub(DEPOSIT_AMOUNT)
        .toString()
    );
    expect(toAfter.amount.toString()).to.equal(
      new anchor.BN(toBefore.amount.toString()).add(DEPOSIT_AMOUNT).toString()
    );
  });

  it("6.2. Should fail fulfillment after deadline", async () => {
    const paymentId = createPaymentId();
    const slot = await provider.connection.getSlot("confirmed");
    const chainNow =
      (await provider.connection.getBlockTime(slot)) ??
      Math.floor(Date.now() / 1000);
    const issuedAt = chainNow - Math.floor(REPLAY_HORIZON_SECS / 2);
    const replayArgs = {
      nonce: new anchor.BN("0000001000000001", 16),
      issuedAt: new anchor.BN(issuedAt),
      deadline: new anchor.BN(issuedAt + 1),
    };

    try {
      await runStrictFulfill({ paymentId, replayArgs });
      expect.fail("Should have failed with DeadlineExpired");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("DeadlineExpired");
    }
  });

  it("6.3. Should fail fulfillment with invalid accounts", async () => {
    const paymentId = createPaymentId();
    const replayArgs = createStrictFulfillReplayArgs();
    const wrongSettler = await generateFundedKeypair();

    // Wrong from_ata owner
    try {
      await runStrictFulfill({
        paymentId,
        replayArgs,
        settlerSigner: wrongSettler,
        fromAta: settlerAta,
      });
      expect.fail("Should have failed with InvalidAuthority");
    } catch (err: any) {
      // Accept either our custom error or Anchor's constraint error
      const errorCode = err.error.errorCode.code;
      expect(
        [
          "InvalidAuthority",
          "ConstraintTokenOwner",
          "ConstraintAssociated",
        ].includes(errorCode)
      ).to.be.true;
    }
  });

  it("6.4. Should init recipient ATA when missing using distinct payer", async () => {
    const distinctPayer = await generateFundedKeypair();
    const freshRecipient = await generateFundedKeypair();
    const replayArgs = createStrictFulfillReplayArgs();

    // Ensure settler has tokens; reuse existing settlerAta
    const topUpTx = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        settlerAta,
        provider.wallet.publicKey,
        BigInt(50_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, topUpTx, [
      provider.wallet.payer!,
    ]);

    // Compute recipient ATA but do not create it
    const freshRecipientAta = await getAssociatedTokenAddress(
      mint,
      freshRecipient.publicKey,
      true
    );

    const paymentId = createPaymentId();
    const payerLamportsBefore = await provider.connection.getBalance(
      distinctPayer.publicKey
    );

    await runStrictFulfill({
      paymentId,
      replayArgs,
      payerSigner: distinctPayer,
      recipient: freshRecipient,
      recipientAta: freshRecipientAta,
    });

    const freshAfter = await getAccount(provider.connection, freshRecipientAta);
    const payerLamportsAfter = await provider.connection.getBalance(
      distinctPayer.publicKey
    );

    expect(freshAfter.amount.toString()).to.equal(DEPOSIT_AMOUNT.toString());
    expect(freshAfter.owner.toBase58()).to.equal(
      freshRecipient.publicKey.toBase58()
    );
    expect(freshAfter.mint.toBase58()).to.equal(mint.toBase58());
    expect(payerLamportsAfter).to.be.lessThan(payerLamportsBefore);

    // This call has a fee payer that is not the settler, so it can tell which of them the marker is
    // keyed on: the settler signs the transfer and owns the marker, the payer only pays rent.
    expect(
      await provider.connection.getAccountInfo(
        deriveStrictFulfillment(paymentId, settler.publicKey)
      ),
      "marker at (quote, settler)"
    ).to.not.be.null;
    expect(
      await provider.connection.getAccountInfo(
        deriveStrictFulfillment(paymentId, distinctPayer.publicKey)
      ),
      "no marker at (quote, payer)"
    ).to.be.null;
  });

  describe("6.5. Replay Protection", () => {
    it("6.5.1. Should fulfill strict path with nonce ABI", async () => {
      const paymentId = createPaymentId();
      const replayArgs = createStrictFulfillReplayArgs();
      const settlerBefore = await getAccount(provider.connection, settlerAta);
      const toBefore = await getAccount(provider.connection, toAta);

      await runStrictFulfill({ paymentId, replayArgs });

      const settlerAfter = await getAccount(provider.connection, settlerAta);
      const toAfter = await getAccount(provider.connection, toAta);

      expect(settlerAfter.amount.toString()).to.equal(
        new anchor.BN(settlerBefore.amount.toString())
          .sub(DEPOSIT_AMOUNT)
          .toString()
      );
      expect(toAfter.amount.toString()).to.equal(
        new anchor.BN(toBefore.amount.toString()).add(DEPOSIT_AMOUNT).toString()
      );
    });

    it("6.5.1a. Should reject a second strict fulfill of the same quote by the same settler across a different nonce", async () => {
      const paymentId = createPaymentId();

      await runStrictFulfill({
        paymentId,
        replayArgs: createStrictFulfillReplayArgs(),
      });

      try {
        // Fresh nonce — the replay bucket would allow it, but the per-(quote, settler) marker must not.
        await runStrictFulfill({
          paymentId,
          replayArgs: createStrictFulfillReplayArgs(),
        });
        expect.fail("Should have failed with AlreadyFulfilled");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("AlreadyFulfilled");
      }
    });

    it("6.5.2. Should reject duplicate nonce replay", async () => {
      const paymentId = createPaymentId();
      const now = Math.floor(Date.now() / 1000);
      const replayArgs = {
        nonce: new anchor.BN("000000200000000a", 16),
        issuedAt: new anchor.BN(now - 5),
        deadline: new anchor.BN(now + 30),
      };

      await runStrictFulfill({ paymentId, replayArgs });

      try {
        await runStrictFulfill({ paymentId, replayArgs });
        expect.fail("Should have failed with AlreadyFulfilled");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("AlreadyFulfilled");
      }
    });

    it("6.5.3. Should reject replay even when payment ID changes", async () => {
      const now = Math.floor(Date.now() / 1000);
      const replayArgs = {
        nonce: new anchor.BN("0000002900000011", 16),
        issuedAt: new anchor.BN(now - 5),
        deadline: new anchor.BN(now + 30),
      };

      await runStrictFulfill({ paymentId: createPaymentId(), replayArgs });

      try {
        await runStrictFulfill({ paymentId: createPaymentId(), replayArgs });
        expect.fail("Should have failed with AlreadyFulfilled");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("AlreadyFulfilled");
      }
    });

    it("6.5.4. Should reject invalid slot", async () => {
      const now = Math.floor(Date.now() / 1000);
      const replayArgs = {
        nonce: new anchor.BN("00000021000000eb", 16), // slot = 235 (invalid)
        issuedAt: new anchor.BN(now - 5),
        deadline: new anchor.BN(now + 30),
      };

      try {
        await runStrictFulfill({ replayArgs });
        expect.fail("Should have failed with InvalidSlot");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidSlot");
      }
    });

    it("6.5.5. Should reject future transaction", async () => {
      const now = Math.floor(Date.now() / 1000);
      const replayArgs = {
        nonce: new anchor.BN("000000220000000b", 16),
        issuedAt: new anchor.BN(now + 30),
        deadline: new anchor.BN(now + 60),
      };

      try {
        await runStrictFulfill({ replayArgs });
        expect.fail("Should have failed with FutureTransaction");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("FutureTransaction");
      }
    });

    it("6.5.6. Should reject expired transaction", async () => {
      const now = Math.floor(Date.now() / 1000);
      // issued_at is beyond the replay horizon so now > issued_at + 128,
      // but deadline is in the future so the deadline check passes first.
      const issuedAt = new anchor.BN(now - (REPLAY_HORIZON_SECS + 10));
      const replayArgs = {
        nonce: new anchor.BN("000000230000000c", 16),
        issuedAt,
        deadline: new anchor.BN(now + 30),
      };

      try {
        await runStrictFulfill({ replayArgs });
        expect.fail("Should have failed with ExpiredTransaction");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ExpiredTransaction");
      }
    });

    it("6.5.7. Should reject deadline too far in future", async () => {
      const now = Math.floor(Date.now() / 1000);
      const issuedAt = new anchor.BN(now - 5);
      const replayArgs = {
        nonce: new anchor.BN("000000240000000d", 16),
        issuedAt,
        deadline: new anchor.BN(issuedAt.toNumber() + REPLAY_HORIZON_SECS + 1),
      };

      try {
        await runStrictFulfill({ replayArgs });
        expect.fail("Should have failed with DeadlineTooFarInFuture");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("DeadlineTooFarInFuture");
      }
    });

    it("6.5.8. Should reject deadline before issued_at", async () => {
      const now = Math.floor(Date.now() / 1000);
      // Both values in the future so now <= deadline passes, but deadline < issued_at fails
      const replayArgs = {
        nonce: new anchor.BN("0000002a00000012", 16),
        issuedAt: new anchor.BN(now + 60),
        deadline: new anchor.BN(now + 30),
      };

      try {
        await runStrictFulfill({ replayArgs });
        expect.fail("Should have failed with InconsistentTimestamps");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InconsistentTimestamps");
      }
    });

    it.skip("6.5.9. Should reset replay slot after epoch rollover (timing-sensitive on localnet)", async () => {
      // Placeholder: requires deterministic time control to advance issued_at
      // by >= REPLAY_HORIZON_SECS * 2 between two strictFulfill calls.
      // Expected behavior:
      // 1) First call with nonce N succeeds.
      // 2) Second call with same nonce N in the next replay epoch succeeds.
      // 3) If bitmap reset regresses, step (2) fails with AlreadyFulfilled.
    });

    it("6.5.10a. Should isolate replay buckets across settlers for distinct quotes", async () => {
      const settler2 = await generateFundedKeypair();
      const settler2Ata = await getOrCreateAssociatedTokenAccount(
        mint,
        settler2.publicKey
      );
      const fundTx = new Transaction().add(
        createTransferInstruction(
          authorityTokenAccount,
          settler2Ata,
          provider.wallet.publicKey,
          BigInt(100_000_000)
        )
      );
      await sendAndConfirmTransaction(provider.connection, fundTx, [
        provider.wallet.payer!,
      ]);

      const now = Math.floor(Date.now() / 1000);
      // Reuse one nonce across both settlers so the only isolation under test is the
      // per-(settler, nonce) replay bucket. Each settler fulfills a DISTINCT quote, so
      // the strict marker is not involved and both calls succeed.
      const replayArgs = {
        nonce: new anchor.BN("000000250000000e", 16),
        issuedAt: new anchor.BN(now - 5),
        deadline: new anchor.BN(now + 30),
      };
      const [bucket1] = deriveFulfillmentReplayBucket(
        replayArgs.nonce,
        settler.publicKey
      );
      const [bucket2] = deriveFulfillmentReplayBucket(
        replayArgs.nonce,
        settler2.publicKey
      );

      expect(bucket1.toBase58()).to.not.equal(bucket2.toBase58());

      await runStrictFulfill({ paymentId: createPaymentId(), replayArgs });
      await runStrictFulfill({
        paymentId: createPaymentId(),
        replayArgs,
        settlerSigner: settler2,
        payerSigner: settler2,
        fromAta: settler2Ata,
      });
    });

    it("6.5.10b. Should let a different settler strict-fulfill the same quote (marker is per settler)", async () => {
      const settler2 = await generateFundedKeypair();
      const settler2Ata = await getOrCreateAssociatedTokenAccount(
        mint,
        settler2.publicKey
      );
      const fundTx = new Transaction().add(
        createTransferInstruction(
          authorityTokenAccount,
          settler2Ata,
          provider.wallet.publicKey,
          BigInt(100_000_000)
        )
      );
      await sendAndConfirmTransaction(provider.connection, fundTx, [
        provider.wallet.payer!,
      ]);

      const paymentId = createPaymentId();
      const settler1Marker = deriveStrictFulfillment(
        paymentId,
        settler.publicKey
      );
      const settler2Marker = deriveStrictFulfillment(
        paymentId,
        settler2.publicKey
      );
      expect(settler1Marker.toBase58()).to.not.equal(settler2Marker.toBase58());

      // Settler A strict-fulfills the quote. Settler B fulfilling the same quote is a separate
      // (quote, settler) pair, so it is not blocked; each pays from its own funds.
      await runStrictFulfill({
        paymentId,
        replayArgs: createStrictFulfillReplayArgs(),
      });
      await runStrictFulfill({
        paymentId,
        replayArgs: createStrictFulfillReplayArgs(),
        settlerSigner: settler2,
        payerSigner: settler2,
        fromAta: settler2Ata,
      });

      expect(await provider.connection.getAccountInfo(settler1Marker)).to.not.be
        .null;
      expect(await provider.connection.getAccountInfo(settler2Marker)).to.not.be
        .null;
    });

    it("6.5.10c. Should not let another account block the assigned settler by striking first", async () => {
      const settler2 = await generateFundedKeypair();
      // The attacker pays with a token it issues itself, to a recipient it controls: the near-free
      // variant, which needs no funds of the victim's and no allowlisted mint.
      const attackerMint = await createMint(
        provider.connection,
        provider.wallet.payer!,
        settler2.publicKey,
        null,
        MINT_DECIMALS
      );
      const attackerAta = await getOrCreateAssociatedTokenAccount(
        attackerMint,
        settler2.publicKey
      );
      await mintTo(
        provider.connection,
        provider.wallet.payer!,
        attackerMint,
        attackerAta,
        settler2,
        BigInt(1)
      );
      const attackerRecipient = await generateFundedKeypair();
      const attackerRecipientAta = await getAssociatedTokenAddress(
        attackerMint,
        attackerRecipient.publicKey,
        true
      );
      const attackerStrikes = (paymentId: Buffer) =>
        runStrictFulfill({
          paymentId,
          amount: new anchor.BN(1),
          replayArgs: createStrictFulfillReplayArgs(),
          settlerSigner: settler2,
          payerSigner: settler2,
          fromAta: attackerAta,
          mintKey: attackerMint,
          recipient: attackerRecipient,
          recipientAta: attackerRecipientAta,
        });

      // The quote hash is public before the destination fulfill, so an attacker can strict-fulfill
      // it first. With a marker per (quote, settler) that burns only the attacker's own slot.
      const paymentId = createPaymentId();
      await attackerStrikes(paymentId);

      // The assigned settler is not blocked ...
      await runStrictFulfill({
        paymentId,
        replayArgs: createStrictFulfillReplayArgs(),
      });

      // ... and the attacker cannot repeat it: its own marker for this quote is already set.
      try {
        await attackerStrikes(paymentId);
        expect.fail("Should have failed with AlreadyFulfilled");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("AlreadyFulfilled");
      }
    });

    it("6.5.11. Should isolate replay state per bucket selector", async () => {
      const now = Math.floor(Date.now() / 1000);
      const replayArgsA = {
        nonce: new anchor.BN("000000260000000f", 16),
        issuedAt: new anchor.BN(now - 5),
        deadline: new anchor.BN(now + 30),
      };
      const replayArgsB = {
        nonce: new anchor.BN("000000270000000f", 16), // same slot, different bucket selector
        issuedAt: replayArgsA.issuedAt,
        deadline: replayArgsA.deadline,
      };

      const [bucketA] = deriveFulfillmentReplayBucket(
        replayArgsA.nonce,
        settler.publicKey
      );
      const [bucketB] = deriveFulfillmentReplayBucket(
        replayArgsB.nonce,
        settler.publicKey
      );

      expect(bucketA.toBase58()).to.not.equal(bucketB.toBase58());

      await runStrictFulfill({
        paymentId: createPaymentId(),
        replayArgs: replayArgsA,
      });
      await runStrictFulfill({
        paymentId: createPaymentId(),
        replayArgs: replayArgsB,
      });
    });

    it("6.5.12. Should emit StrictFulfilled event with strict fields", async () => {
      const now = Math.floor(Date.now() / 1000);
      const paymentId = createPaymentId();
      const replayArgs = {
        nonce: new anchor.BN("0000002800000010", 16),
        issuedAt: new anchor.BN(now - 5),
        deadline: new anchor.BN(now + 30),
      };

      const { txSig } = await runStrictFulfill({ paymentId, replayArgs });
      const payload = await findEventPayload(
        txSig,
        STRICT_FULFILLED_EVENT_DISCRIMINATOR
      );
      const event = decodeStrictFulfilledEvent(payload);

      expect(event.quoteHash.equals(paymentId)).to.equal(true);
      expect(event.to.toBase58()).to.equal(to.publicKey.toBase58());
      expect(event.token.toBase58()).to.equal(mint.toBase58());
      expect(event.amount.toString()).to.equal(DEPOSIT_AMOUNT.toString());
      expect(event.nonce.toString()).to.equal(replayArgs.nonce.toString());
      expect(event.issuedAt.toString()).to.equal(
        replayArgs.issuedAt.toString()
      );
      expect(event.deadline.toString()).to.equal(
        replayArgs.deadline.toString()
      );
    });

    it("6.5.13. Should emit Fulfilled event for non-strict fulfill", async () => {
      const paymentId = createPaymentId();
      const settlerBalance = new anchor.BN(
        (await getAccount(provider.connection, settlerAta)).amount.toString()
      );

      if (settlerBalance.lt(DEPOSIT_AMOUNT)) {
        const topUpTx = new Transaction().add(
          createTransferInstruction(
            authorityTokenAccount,
            settlerAta,
            provider.wallet.publicKey,
            BigInt(DEPOSIT_AMOUNT.mul(new anchor.BN(4)).toString())
          )
        );
        await sendAndConfirmTransaction(provider.connection, topUpTx, [
          provider.wallet.payer!,
        ]);
      }

      const txSig = await fulfillmentProgram.methods
        .fulfill(Array.from(paymentId), DEPOSIT_AMOUNT)
        .accountsPartial({
          protocolConfig,
          settler: settler.publicKey,
          payer: settler.publicKey,
          fromAta: settlerAta,
          toAta,
          to: to.publicKey,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([settler])
        .rpc();

      const payload = await findEventPayload(
        txSig,
        FULFILLED_EVENT_DISCRIMINATOR
      );
      const event = decodeFulfilledEvent(payload);

      expect(event.quoteHash.equals(paymentId)).to.equal(true);
      expect(event.to.toBase58()).to.equal(to.publicKey.toBase58());
      expect(event.token.toBase58()).to.equal(mint.toBase58());
      expect(event.amount.toString()).to.equal(DEPOSIT_AMOUNT.toString());
    });

    it("6.5.14. Should refuse a quote strict-fulfilled under the previous build (legacy marker)", async () => {
      // The validator is started with an account at [strict_fulfilled, quote_hash] for the quote
      // hash 0xab x 32, owned by this program and set, as the previous build left it (see
      // Anchor.toml). This settler has no marker of its own for that quote, so only the legacy
      // check stops it paying the quote a second time.
      const legacyQuote = Buffer.alloc(32, 0xab);
      const legacyMarker = PublicKey.findProgramAddressSync(
        [Buffer.from("strict_fulfilled"), legacyQuote],
        fulfillmentProgram.programId
      )[0];
      const fixture = await provider.connection.getAccountInfo(legacyMarker);
      expect(fixture, "the legacy marker fixture is loaded").to.not.be.null;
      expect(fixture!.owner.toBase58()).to.equal(
        fulfillmentProgram.programId.toBase58()
      );

      const toBefore = await getAccount(provider.connection, toAta);
      let failure: any;
      try {
        await runStrictFulfill({
          paymentId: legacyQuote,
          replayArgs: createStrictFulfillReplayArgs(),
        });
      } catch (err: any) {
        failure = err;
      }
      expect(
        failure,
        "a quote paid under the old build is refused"
      ).to.not.equal(undefined);
      expect(failure.error.errorCode.code).to.equal("AlreadyFulfilled");

      const toAfter = await getAccount(provider.connection, toAta);
      expect(toAfter.amount.toString()).to.equal(toBefore.amount.toString());
      expect(
        await provider.connection.getAccountInfo(
          deriveStrictFulfillment(legacyQuote, settler.publicKey)
        ),
        "the refused call left no marker"
      ).to.be.null;

      // Control: a quote with no legacy marker is still payable.
      await runStrictFulfill({
        paymentId: createPaymentId(),
        replayArgs: createStrictFulfillReplayArgs(),
      });
    });

    it("6.5.15. Should not let prefunding the legacy marker address block a quote", async () => {
      // Anyone can send lamports to any address. A prefunded legacy address is system owned with no
      // data, so it must not count as a set marker.
      const paymentId = createPaymentId();
      const legacyMarker = PublicKey.findProgramAddressSync(
        [Buffer.from("strict_fulfilled"), paymentId],
        fulfillmentProgram.programId
      )[0];
      const prefund = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: legacyMarker,
          lamports: 1_000_000,
        })
      );
      await sendAndConfirmTransaction(provider.connection, prefund, [
        provider.wallet.payer!,
      ]);
      expect(await provider.connection.getBalance(legacyMarker)).to.equal(
        1_000_000
      );

      await runStrictFulfill({
        paymentId,
        replayArgs: createStrictFulfillReplayArgs(),
      });
    });
  });

  describe("6.6. RBAC + Pause", () => {
    it("6.6.1. Should fulfill without replay protection", async () => {
      const paymentId = createPaymentId();

      const settlerBefore = await getAccount(provider.connection, settlerAta);
      const toBefore = await getAccount(provider.connection, toAta);

      await fulfillmentProgram.methods
        .fulfill(Array.from(paymentId), DEPOSIT_AMOUNT)
        .accountsPartial({
          protocolConfig,
          settler: settler.publicKey,
          payer: settler.publicKey,
          fromAta: settlerAta,
          toAta,
          to: to.publicKey,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([settler])
        .rpc();

      // Same payment ID should be allowed again (no replay protection).
      await fulfillmentProgram.methods
        .fulfill(Array.from(paymentId), DEPOSIT_AMOUNT)
        .accountsPartial({
          protocolConfig,
          settler: settler.publicKey,
          payer: settler.publicKey,
          fromAta: settlerAta,
          toAta,
          to: to.publicKey,
          mint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([settler])
        .rpc();

      const settlerAfter = await getAccount(provider.connection, settlerAta);
      const toAfter = await getAccount(provider.connection, toAta);

      expect(settlerAfter.amount.toString()).to.equal(
        new anchor.BN(settlerBefore.amount.toString())
          .sub(DEPOSIT_AMOUNT.mul(new anchor.BN(2)))
          .toString()
      );
      expect(toAfter.amount.toString()).to.equal(
        new anchor.BN(toBefore.amount.toString())
          .add(DEPOSIT_AMOUNT.mul(new anchor.BN(2)))
          .toString()
      );
    });

    it("6.6.2. Should block fulfill while paused (no ATA init side effects)", async () => {
      await fundPauser(provider);

      await fulfillmentProgram.methods
        .pause()
        .accountsPartial({
          pauser: pauserKeypair.publicKey,
          protocolConfig,
        })
        .signers([pauserKeypair])
        .rpc();

      const distinctPayer = await generateFundedKeypair();
      const freshRecipient = await generateFundedKeypair();
      const paymentId = createPaymentId();

      const missingRecipientAta = await getAssociatedTokenAddress(
        mint,
        freshRecipient.publicKey,
        true
      );

      // Ensure ATA is missing before the tx.
      const ataBefore = await provider.connection.getAccountInfo(
        missingRecipientAta
      );
      expect(ataBefore).to.equal(null);

      try {
        await fulfillmentProgram.methods
          .fulfill(Array.from(paymentId), DEPOSIT_AMOUNT)
          .accountsPartial({
            protocolConfig,
            settler: settler.publicKey,
            payer: distinctPayer.publicKey,
            fromAta: settlerAta,
            toAta: missingRecipientAta,
            to: freshRecipient.publicKey,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([settler, distinctPayer])
          .rpc();

        expect.fail("Should have failed with ProtocolPaused");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("ProtocolPaused");
      }

      // ATA should still be missing (hard pause = no init side effects).
      const ataAfter = await provider.connection.getAccountInfo(
        missingRecipientAta
      );
      expect(ataAfter).to.equal(null);

      await fulfillmentProgram.methods
        .unpause()
        .accountsPartial({
          pauser: pauserKeypair.publicKey,
          protocolConfig,
        })
        .signers([pauserKeypair])
        .rpc();
    });

    it("6.6.3. Should block strict_fulfill while paused (no replay bucket init side effects)", async () => {
      await fundPauser(provider);

      await fulfillmentProgram.methods
        .pause()
        .accountsPartial({
          pauser: pauserKeypair.publicKey,
          protocolConfig,
        })
        .signers([pauserKeypair])
        .rpc();

      const paymentId = createPaymentId();
      const replayArgs = createStrictFulfillReplayArgs();
      const strictArgs = createStrictFulfillArgs(
        paymentId,
        DEPOSIT_AMOUNT,
        replayArgs
      );
      const [replayBucket] = deriveFulfillmentReplayBucket(
        replayArgs.nonce,
        settler.publicKey
      );

      // Ensure replay bucket is missing before the tx.
      const replayBefore = await provider.connection.getAccountInfo(
        replayBucket
      );
      expect(replayBefore).to.equal(null);

      try {
        await fulfillmentProgram.methods
          .strictFulfill(...strictArgs)
          .accountsPartial({
            protocolConfig,
            settler: settler.publicKey,
            payer: settler.publicKey,
            replayBucket,
            fromAta: settlerAta,
            toAta,
            to: to.publicKey,
            mint,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([settler])
          .rpc();
        expect.fail("Should have failed with ProtocolPaused");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("ProtocolPaused");
      }

      // Replay bucket should still be missing (hard pause = no init side effects).
      const replayAfter = await provider.connection.getAccountInfo(
        replayBucket
      );
      expect(replayAfter).to.equal(null);

      await fulfillmentProgram.methods
        .unpause()
        .accountsPartial({
          pauser: pauserKeypair.publicKey,
          protocolConfig,
        })
        .signers([pauserKeypair])
        .rpc();
    });

    it("6.6.4. Should enforce admin transfer delay and new admin", async () => {
      await fundSecondaryAdmin(provider);

      await fulfillmentProgram.methods
        .setDefaultAdminDelaySeconds(1)
        .accountsPartial({
          defaultAdmin: provider.wallet.publicKey,
          protocolConfig,
        })
        .rpc();

      await fulfillmentProgram.methods
        .beginDefaultAdminTransfer(secondaryAdminKeypair.publicKey)
        .accountsPartial({
          defaultAdmin: provider.wallet.publicKey,
          protocolConfig,
        })
        .rpc();

      // Cannot accept immediately (delay not elapsed).
      try {
        await fulfillmentProgram.methods
          .acceptDefaultAdminTransfer()
          .accountsPartial({
            pendingAdmin: secondaryAdminKeypair.publicKey,
            protocolConfig,
          })
          .signers([secondaryAdminKeypair])
          .rpc();
        expect.fail("Should have failed with AdminTransferNotReady");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("AdminTransferNotReady");
      }

      await new Promise((resolve) => setTimeout(resolve, 2_000));

      await fulfillmentProgram.methods
        .acceptDefaultAdminTransfer()
        .accountsPartial({
          pendingAdmin: secondaryAdminKeypair.publicKey,
          protocolConfig,
        })
        .signers([secondaryAdminKeypair])
        .rpc();

      const configAfter = await fulfillmentProgram.account.protocolConfig.fetch(
        protocolConfig
      );
      expect(configAfter.defaultAdmin.toBase58()).to.equal(
        secondaryAdminKeypair.publicKey.toBase58()
      );

      // Old admin can no longer change pauser.
      try {
        await fulfillmentProgram.methods
          .setPauser(secondaryAdminKeypair.publicKey)
          .accountsPartial({
            defaultAdmin: provider.wallet.publicKey,
            protocolConfig,
          })
          .rpc();
        expect.fail("Should have failed with Unauthorized");
      } catch (err: any) {
        expect(err.error?.errorCode?.code).to.equal("Unauthorized");
      }

      // New admin can change pauser.
      await fulfillmentProgram.methods
        .setPauser(secondaryAdminKeypair.publicKey)
        .accountsPartial({
          defaultAdmin: secondaryAdminKeypair.publicKey,
          protocolConfig,
        })
        .signers([secondaryAdminKeypair])
        .rpc();

      // Cleanup: restore delay, admin, and pauser to keep later suites stable.
      await fulfillmentProgram.methods
        .setDefaultAdminDelaySeconds(0)
        .accountsPartial({
          defaultAdmin: secondaryAdminKeypair.publicKey,
          protocolConfig,
        })
        .signers([secondaryAdminKeypair])
        .rpc();

      await fulfillmentProgram.methods
        .beginDefaultAdminTransfer(provider.wallet.publicKey)
        .accountsPartial({
          defaultAdmin: secondaryAdminKeypair.publicKey,
          protocolConfig,
        })
        .signers([secondaryAdminKeypair])
        .rpc();

      await fulfillmentProgram.methods
        .acceptDefaultAdminTransfer()
        .accountsPartial({
          pendingAdmin: provider.wallet.publicKey,
          protocolConfig,
        })
        .rpc();

      await fulfillmentProgram.methods
        .setPauser(pauserKeypair.publicKey)
        .accountsPartial({
          defaultAdmin: provider.wallet.publicKey,
          protocolConfig,
        })
        .rpc();
    });
  });

  describe("6.7. Token-2022 TransferHook", () => {
    it("6.7.1. Should require remaining accounts for fulfill", async () => {
      const paymentId = createPaymentId();
      const toBefore = await splGetAccount(
        provider.connection,
        transferHookToAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await expectMissingTransferHookAccountsFailure(async () =>
        runTransferHookFulfill({
          withRemainingAccounts: false,
          paymentId,
        })
      );

      const settlerBefore = await splGetAccount(
        provider.connection,
        transferHookSettlerAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await runTransferHookFulfill({
        withRemainingAccounts: true,
        paymentId,
      });

      const settlerAfter = await splGetAccount(
        provider.connection,
        transferHookSettlerAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const toAfter = await splGetAccount(
        provider.connection,
        transferHookToAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      expect(settlerAfter.amount.toString()).to.equal(
        (
          BigInt(settlerBefore.amount.toString()) -
          BigInt(DEPOSIT_AMOUNT.toString())
        ).toString()
      );
      expect(toAfter.amount.toString()).to.equal(DEPOSIT_AMOUNT.toString());
      expect(toAfter.amount.toString()).to.equal(
        (
          BigInt(toBefore.amount.toString()) + BigInt(DEPOSIT_AMOUNT.toString())
        ).toString()
      );
    });

    it("6.7.2. Should require remaining accounts for strict_fulfill", async () => {
      const paymentId = createPaymentId();
      const replayArgs = createStrictFulfillReplayArgs();
      const toBefore = await splGetAccount(
        provider.connection,
        transferHookToAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await expectMissingTransferHookAccountsFailure(async () =>
        runTransferHookStrictFulfill({
          withRemainingAccounts: false,
          paymentId,
          replayArgs,
        })
      );

      const settlerBefore = await splGetAccount(
        provider.connection,
        transferHookSettlerAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await runTransferHookStrictFulfill({
        withRemainingAccounts: true,
        paymentId,
        replayArgs,
      });

      const settlerAfter = await splGetAccount(
        provider.connection,
        transferHookSettlerAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const toAfter = await splGetAccount(
        provider.connection,
        transferHookToAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      expect(settlerAfter.amount.toString()).to.equal(
        (
          BigInt(settlerBefore.amount.toString()) -
          BigInt(DEPOSIT_AMOUNT.toString())
        ).toString()
      );
      expect(toAfter.amount.toString()).to.equal(
        (
          BigInt(toBefore.amount.toString()) + BigInt(DEPOSIT_AMOUNT.toString())
        ).toString()
      );
    });

    it("6.7.3. Should fail when the hook's validation account is dropped", async () => {
      // Only the hook program is passed: the proxy must forward the validation PDA the hook requires,
      // so dropping it has to fail rather than reach a hook that accepts anything.
      await expectMissingTransferHookAccountsFailure(async () =>
        fulfillmentProgram.methods
          .fulfill(Array.from(createPaymentId()), DEPOSIT_AMOUNT)
          .accountsPartial({
            protocolConfig,
            settler: settler.publicKey,
            payer: settler.publicKey,
            fromAta: transferHookSettlerAta,
            toAta: transferHookToAta,
            to: to.publicKey,
            mint: transferHookMint,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            {
              pubkey: MOCK_TRANSFER_HOOK_PROGRAM_ID,
              isSigner: false,
              isWritable: false,
            },
          ])
          .signers([settler])
          .rpc()
      );
    });
  });

  // The events report `amount`, so a transfer that credits the recipient less must fail.
  describe("6.8. Token-2022 TransferFee", () => {
    const authority = () => provider.wallet.payer as Keypair;

    const feeMintWithFundedSettler = async (
      feeBasisPoints: number,
      maxFee: bigint
    ) => {
      const { mint: feeMint, authorityAta } = await setupToken2022MintAndFund(
        escrowProgram,
        provider,
        authority(),
        { skipAllowlist: true, transferFee: { feeBasisPoints, maxFee } }
      );
      const settlerFeeAta = await splGetOrCreateAssociatedTokenAccount(
        provider.connection,
        authority(),
        feeMint,
        settler.publicKey,
        false,
        undefined,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      await transferChecked(
        provider.connection,
        authority(),
        authorityAta,
        feeMint,
        settlerFeeAta.address,
        authority(),
        10n * BigInt(DEPOSIT_AMOUNT.toString()),
        MINT_DECIMALS,
        [],
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const toFeeAta = await getAssociatedTokenAddress(
        feeMint,
        to.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      return {
        protocolConfig,
        settler: settler.publicKey,
        payer: settler.publicKey,
        fromAta: settlerFeeAta.address,
        toAta: toFeeAta,
        to: to.publicKey,
        mint: feeMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      };
    };

    // 6018 = 0x1792, the code a raw SendTransactionError carries when Anchor cannot parse the logs.
    const expectNonExactTransfer = async (action: () => Promise<unknown>) => {
      let err: any;
      try {
        await action();
      } catch (e) {
        err = e;
      }
      expect(err, "expected NonExactTransfer").to.exist;
      const text = [
        err.error?.errorCode?.code,
        err.message,
        ...(err.logs ?? []),
      ].join("\n");
      expect(text).to.match(/NonExactTransfer|0x1792/);
    };

    const toBalance = async (toAta: PublicKey) => {
      const info = await provider.connection.getAccountInfo(toAta);
      if (!info) return 0n;
      return (
        await splGetAccount(
          provider.connection,
          toAta,
          undefined,
          TOKEN_2022_PROGRAM_ID
        )
      ).amount;
    };

    it("6.8.1. Should reject fulfill and strict_fulfill that would credit the recipient less", async () => {
      const accounts = await feeMintWithFundedSettler(100, 1_000_000n);

      await expectNonExactTransfer(() =>
        fulfillmentProgram.methods
          .fulfill(Array.from(createPaymentId()), DEPOSIT_AMOUNT)
          .accountsPartial(accounts)
          .signers([settler])
          .rpc()
      );

      const replayArgs = createStrictFulfillReplayArgs();
      const strictArgs = createStrictFulfillArgs(
        createPaymentId(),
        DEPOSIT_AMOUNT,
        replayArgs
      );
      const [replayBucket] = deriveFulfillmentReplayBucket(
        replayArgs.nonce,
        settler.publicKey
      );
      await expectNonExactTransfer(() =>
        fulfillmentProgram.methods
          .strictFulfill(...strictArgs)
          .accountsPartial({ ...accounts, replayBucket })
          .signers([settler])
          .rpc()
      );

      // The revert also rolls back the strict marker, so the quote can still be fulfilled.
      const strictFulfillment = deriveStrictFulfillment(
        Buffer.from(strictArgs[0]),
        settler.publicKey
      );
      expect(await provider.connection.getAccountInfo(strictFulfillment)).to.be
        .null;
      expect(await toBalance(accounts.toAta)).to.equal(0n);
    });

    it("6.8.2. Should credit a zero fee mint exactly", async () => {
      const accounts = await feeMintWithFundedSettler(0, 0n);
      const before = await toBalance(accounts.toAta);

      await fulfillmentProgram.methods
        .fulfill(Array.from(createPaymentId()), DEPOSIT_AMOUNT)
        .accountsPartial(accounts)
        .signers([settler])
        .rpc();

      expect((await toBalance(accounts.toAta)) - before).to.equal(
        BigInt(DEPOSIT_AMOUNT.toString())
      );
    });
  });
});
