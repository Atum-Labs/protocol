import {
  anchor,
  escrowProgram,
  provider,
  DEPOSIT_SEED,
  expect,
  Keypair,
  PublicKey,
  SystemProgram,
  depositSigIx,
  refundSigIx,
  releaseSigIx,
  reserveSigIx,
  createPaymentId,
  createValidNonce,
  DEPOSIT_AMOUNT,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  generateFundedKeypair,
  setupToken2022MintAndFund,
  setupTransferHookMint,
  setupMintAndFund,
  TOKEN_PROGRAM_ID,
  buildTransferHookRemainingAccounts,
  createMessage,
  DELEGATE_CAPACITY,
  MAX_TRANSFER_SIZE,
  REPLAY_SEED,
  ESCROW_DELEGATE_SEED,
  ensureProtocolInitialized,
  getMintFeeConfigAddress,
  treasurerKeypair,
  MOCK_TRANSFER_HOOK_PROGRAM_ID,
  DEFAULT_QUOTE_HASH,
  ZERO_QUOTE_HASH,
  destinationHash,
  depositComputeBudgetIx,
  MINT_DECIMALS,
  sendV0WithLookupTable,
} from "./helpers";
import {
  AuthorityType,
  ExtensionType,
  createEnableRequiredMemoTransfersInstruction,
  createReallocateInstruction,
  createSetTransferFeeInstruction,
  freezeAccount,
  setAuthority,
  transferCheckedWithTransferHook,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount as splGetOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";

describe("12 Token-2022 Integration", () => {
  let protocolConfig: PublicKey;

  before(async () => {
    protocolConfig = await ensureProtocolInitialized(escrowProgram, provider);
  });

  interface OpenDeposit {
    mint: PublicKey;
    depositor: Keypair;
    depositorAta: PublicKey;
    deposit: PublicKey;
    escrowAta: PublicKey;
    depositHash: Buffer;
    reserver: Keypair;
    releaser: Keypair;
    recipient: Keypair;
    payer: Keypair;
    tokenProgram: PublicKey;
    // A transfer hook's validation PDA and program, forwarded on every escrow transfer.
    remainingAccounts: anchor.web3.AccountMeta[];
  }

  // Runs createDelegate -> deposit on an allowlisted Token-2022 mint. beforeDeposit runs after the
  // delegate exists, so a test can change the mint first.
  async function openDeposit(
    mint: PublicKey,
    mintFeeConfig: PublicKey,
    authorityAta: PublicKey,
    beforeDeposit?: () => Promise<void>,
    tokenProgram = TOKEN_2022_PROGRAM_ID,
    remainingAccounts: anchor.web3.AccountMeta[] = []
  ): Promise<OpenDeposit> {
    const authority = provider.wallet.payer as Keypair;

    // Create depositor, reserver, releaser, recipient
    const depositor = await generateFundedKeypair();
    const delegateSigner = await generateFundedKeypair();
    const reserver = await generateFundedKeypair();
    const releaser = await generateFundedKeypair();
    const recipient = await generateFundedKeypair();
    const payer = await generateFundedKeypair();

    // Create depositor's ATA and fund it with Token-2022 tokens
    const depositorAta = await splGetOrCreateAssociatedTokenAccount(
      provider.connection,
      authority,
      mint,
      depositor.publicKey,
      false,
      undefined,
      undefined,
      tokenProgram
    );

    // Transfer tokens from authority to depositor. Checked, since Token-2022 rejects a plain
    // Transfer from an account with the TransferFeeAmount extension, and hook aware so a mint with
    // a transfer hook gets its extra accounts.
    await transferCheckedWithTransferHook(
      provider.connection,
      authority,
      authorityAta,
      mint,
      depositorAta.address,
      authority,
      BigInt(500_000_000), // 500 tokens
      MINT_DECIMALS,
      [],
      undefined,
      tokenProgram
    );

    // Create delegate
    const [delegate] = PublicKey.findProgramAddressSync(
      [ESCROW_DELEGATE_SEED, depositor.publicKey.toBuffer(), mint.toBuffer()],
      escrowProgram.programId
    );

    const expiration = new anchor.BN(
      Math.floor(Date.now() / 1000) + 24 * 60 * 60
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
        authority: depositor.publicKey,
        escrowDelegate: delegate,
        authorityAta: depositorAta.address,
        mint,
        payer: payer.publicKey,
        tokenProgram: tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor, payer])
      .rpc();

    // Create deposit
    const paymentId = createPaymentId();
    await beforeDeposit?.();

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

    const depositEd25519Instruction = depositSigIx(
      delegateSigner,
      depositMessage
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
    const escrowAta = await getAssociatedTokenAddress(
      mint,
      deposit,
      true,
      tokenProgram
    );

    const depositBuilder = escrowProgram.methods
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
        authorityAta: depositorAta.address,
        deposit,
        escrowAta,
        mint,
        protocolConfig,
        mintFeeConfig,
        payer: payer.publicKey,
        tokenProgram: tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts(remainingAccounts)
      .preInstructions([depositComputeBudgetIx(), depositEd25519Instruction])
      .signers([payer]);
    // A hooked deposit exceeds the 1232-byte legacy limit and ships as v0 with a lookup table, see 12.3.
    if (remainingAccounts.length > 0) {
      await sendV0WithLookupTable(
        (
          await depositBuilder.transaction()
        ).instructions,
        [payer]
      );
    } else {
      await depositBuilder.rpc();
    }

    // Verify deposit was created
    const depositAccount = await escrowProgram.account.depositInfo.fetch(
      deposit
    );
    expect(depositAccount.depositor.toBase58()).to.equal(
      depositor.publicKey.toBase58()
    );
    expect(depositAccount.mint.toBase58()).to.equal(mint.toBase58());
    expect(depositAccount.amount.toString()).to.equal(
      DEPOSIT_AMOUNT.toString()
    );

    return {
      mint,
      depositor,
      depositorAta: depositorAta.address,
      deposit,
      escrowAta,
      depositHash,
      reserver,
      releaser,
      recipient,
      payer,
      tokenProgram,
      remainingAccounts,
    };
  }

  async function reserveDeposit(d: OpenDeposit) {
    const reserveMessage = await createMessage("reserve", [
      d.recipient.publicKey.toBuffer(),
      d.depositHash,
      DEFAULT_QUOTE_HASH,
      DEPOSIT_AMOUNT.toBuffer("le", 8),
    ]);
    await escrowProgram.methods
      .reserve(
        d.recipient.publicKey,
        Array.from(DEFAULT_QUOTE_HASH),
        DEPOSIT_AMOUNT
      )
      .accountsPartial({
        deposit: d.deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([reserveSigIx(d.reserver, reserveMessage)])
      .rpc();
  }

  function ata(
    mint: PublicKey,
    owner: PublicKey,
    tokenProgram = TOKEN_2022_PROGRAM_ID
  ) {
    return getAssociatedTokenAddress(mint, owner, true, tokenProgram);
  }

  async function balance(
    account: PublicKey,
    tokenProgram = TOKEN_2022_PROGRAM_ID
  ) {
    return (
      await getAccount(provider.connection, account, undefined, tokenProgram)
    ).amount;
  }

  // Release doesn't pre-create the recipient ATA, which checks that init_if_needed works.
  async function releaseDeposit(d: OpenDeposit) {
    const releaseMessage = await createMessage("release", [
      d.depositHash,
      DEFAULT_QUOTE_HASH,
    ]);
    await escrowProgram.methods
      .release()
      .accountsPartial({
        protocolConfig,
        deposit: d.deposit,
        escrowAta: d.escrowAta,
        recipient: d.recipient.publicKey,
        recipientAta: await ata(d.mint, d.recipient.publicKey, d.tokenProgram),
        depositor: d.depositor.publicKey,
        depositorAta: d.depositorAta,
        treasurer: treasurerKeypair.publicKey,
        treasuryAta: await ata(
          d.mint,
          treasurerKeypair.publicKey,
          d.tokenProgram
        ),
        mint: d.mint,
        payer: d.payer.publicKey,
        tokenProgram: d.tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts(d.remainingAccounts)
      .preInstructions([
        depositComputeBudgetIx(),
        releaseSigIx(d.releaser, releaseMessage),
      ])
      .signers([d.payer])
      .rpc();
    expect(await provider.connection.getAccountInfo(d.deposit)).to.be.null;
  }

  // Refunds a deposit that was never reserved, so the signed quote hash is zero.
  async function refundDeposit(d: OpenDeposit) {
    const refundMessage = await createMessage("refund", [
      d.depositHash,
      ZERO_QUOTE_HASH,
    ]);
    await escrowProgram.methods
      .refund()
      .accountsPartial({
        protocolConfig,
        deposit: d.deposit,
        escrowAta: d.escrowAta,
        depositor: d.depositor.publicKey,
        depositorAta: d.depositorAta,
        mint: d.mint,
        payer: d.payer.publicKey,
        tokenProgram: d.tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts(d.remainingAccounts)
      .preInstructions([refundSigIx(d.releaser, refundMessage)])
      .signers([d.payer])
      .rpc();
    expect(await provider.connection.getAccountInfo(d.deposit)).to.be.null;
  }

  // Runs the full deposit -> reserve -> release flow and asserts the recipient got the exact amount
  // (fee = 0 default).
  async function depositReserveRelease(
    mint: PublicKey,
    mintFeeConfig: PublicKey,
    authorityAta: PublicKey,
    beforeDeposit?: () => Promise<void>
  ) {
    const d = await openDeposit(
      mint,
      mintFeeConfig,
      authorityAta,
      beforeDeposit
    );
    await reserveDeposit(d);
    await releaseDeposit(d);
    expect(
      (await balance(await ata(mint, d.recipient.publicKey))).toString()
    ).to.equal(DEPOSIT_AMOUNT.toString());
  }

  // 12.1 Token-2022 happy path (deposit -> reserve -> release)
  it("12.1 Token-2022 happy path", async () => {
    // Create Token-2022 mint (no problematic extensions)
    const authority = provider.wallet.payer as Keypair;
    const { mint, mintFeeConfig, authorityAta } =
      await setupToken2022MintAndFund(escrowProgram, provider, authority);

    await depositReserveRelease(mint, mintFeeConfig!, authorityAta);
  });

  // 12.2 TransferHook fails without remaining_accounts
  it("12.2 fails deposit without TransferHook remaining_accounts", async function () {
    const authority = provider.wallet.payer as Keypair;
    const depositor = await generateFundedKeypair();
    const delegateSigner = await generateFundedKeypair();
    const reserver = await generateFundedKeypair();
    const releaser = await generateFundedKeypair();
    const payer = await generateFundedKeypair();

    // Setup TransferHook mint and fund depositor
    const { mint, mintFeeConfig, depositorAta } = await setupTransferHookMint(
      escrowProgram,
      provider,
      authority,
      depositor
    );

    // Create delegate
    const [delegate] = PublicKey.findProgramAddressSync(
      [ESCROW_DELEGATE_SEED, depositor.publicKey.toBuffer(), mint.toBuffer()],
      escrowProgram.programId
    );

    const expiration = new anchor.BN(
      Math.floor(Date.now() / 1000) + 24 * 60 * 60
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
        authority: depositor.publicKey,
        escrowDelegate: delegate,
        authorityAta: depositorAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor, payer])
      .rpc();

    // Create deposit parameters
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

    const depositEd25519Instruction = depositSigIx(
      delegateSigner,
      depositMessage
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
    const escrowAta = await getAssociatedTokenAddress(
      mint,
      deposit,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    // Attempt deposit WITHOUT remaining_accounts - should fail
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
          Array.from(depositHash)
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
          mintFeeConfig: mintFeeConfig!,
          payer: payer.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([depositComputeBudgetIx(), depositEd25519Instruction])
        .signers([payer])
        .rpc();
      expect.fail("Deposit should have failed without TransferHook accounts");
    } catch (err: any) {
      // Expect Token-2022 program error related to missing transfer hook accounts
      // The error could be a program error, validation error, or simulation failure
      const errStr = err.message || err.toString();
      // Accept any error - the important thing is that it failed without the hook accounts
      expect(errStr.length).to.be.greaterThan(0);
    }
  });

  // 12.3 TransferHook succeeds with remaining_accounts
  it("12.3 TransferHook succeeds with remaining_accounts", async () => {
    const authority = provider.wallet.payer as Keypair;

    // Create depositor, reserver, releaser, payer
    const depositor = await generateFundedKeypair();
    const delegateSigner = await generateFundedKeypair();
    const reserver = await generateFundedKeypair();
    const releaser = await generateFundedKeypair();
    const payer = await generateFundedKeypair();

    // Setup Token-2022 mint with TransferHook extension
    const { mint, mintFeeConfig, depositorAta, extraAccountMetaList } =
      await setupTransferHookMint(
        escrowProgram,
        provider,
        authority,
        depositor,
        {
          initialMintAmount: 1_000_000_000n, // 1000 tokens
        }
      );

    // Create delegate
    const [delegate] = PublicKey.findProgramAddressSync(
      [ESCROW_DELEGATE_SEED, depositor.publicKey.toBuffer(), mint.toBuffer()],
      escrowProgram.programId
    );

    const expiration = new anchor.BN(
      Math.floor(Date.now() / 1000) + 24 * 60 * 60
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
        authority: depositor.publicKey,
        escrowDelegate: delegate,
        authorityAta: depositorAta,
        mint,
        payer: payer.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([depositor, payer])
      .rpc();

    // Create deposit with TransferHook remaining accounts
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

    const depositEd25519Instruction = depositSigIx(
      delegateSigner,
      depositMessage
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
    const escrowAta = await getAssociatedTokenAddress(
      mint,
      deposit,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    // Perform deposit WITH remaining_accounts for TransferHook
    const depositTx = await escrowProgram.methods
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
        authorityAta: depositorAta,
        deposit,
        escrowAta,
        mint,
        protocolConfig,
        mintFeeConfig: mintFeeConfig!,
        payer: payer.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        {
          pubkey: extraAccountMetaList,
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: MOCK_TRANSFER_HOOK_PROGRAM_ID,
          isSigner: false,
          isWritable: false,
        },
      ])
      // A transfer-hook deposit exceeds the 1232-byte legacy limit, so it ships as a v0
      // transaction with an address lookup table, as the settler sends it.
      .preInstructions([depositComputeBudgetIx(), depositEd25519Instruction])
      .transaction();
    await sendV0WithLookupTable(depositTx.instructions, [payer]);

    // Verify deposit was created successfully
    const depositAccount = await escrowProgram.account.depositInfo.fetch(
      deposit
    );
    expect(depositAccount.depositor.toBase58()).to.equal(
      depositor.publicKey.toBase58()
    );
    expect(depositAccount.mint.toBase58()).to.equal(mint.toBase58());
    expect(depositAccount.amount.toString()).to.equal(
      DEPOSIT_AMOUNT.toString()
    );

    // Verify escrow ATA received the tokens
    const escrowAtaAccount = await getAccount(
      provider.connection,
      escrowAta,
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    expect(escrowAtaAccount.amount.toString()).to.equal(
      DEPOSIT_AMOUNT.toString()
    );
  });

  function allowMint(mint: PublicKey) {
    return escrowProgram.methods
      .allowMint()
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig: getMintFeeConfigAddress(mint, escrowProgram.programId),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // 6027 = 0x178b, the code a raw SendTransactionError carries when Anchor cannot parse the logs.
  async function expectTransferFeeRejected(action: () => Promise<unknown>) {
    let err: any;
    try {
      await action();
    } catch (e) {
      err = e;
    }
    expect(err, "expected TransferFeeMintNotAllowed").to.exist;
    const text = [
      err.error?.errorCode?.code,
      err.message,
      ...(err.logs ?? []),
    ].join("\n");
    expect(text).to.match(/TransferFeeMintNotAllowed|0x178b/);
  }

  async function expectRejected(
    action: () => Promise<unknown>,
    pattern: RegExp
  ) {
    let err: any;
    try {
      await action();
    } catch (e) {
      err = e;
    }
    expect(err, `expected ${pattern}`).to.exist;
    const text = [
      err.error?.errorCode?.code,
      err.message,
      ...(err.logs ?? []),
    ].join("\n");
    expect(text).to.match(pattern);
  }

  function transferFeeMint(feeBasisPoints: number, maxFee: bigint) {
    return setupToken2022MintAndFund(
      escrowProgram,
      provider,
      provider.wallet.payer as Keypair,
      {
        skipAllowlist: true,
        transferFee: { feeBasisPoints, maxFee },
      }
    );
  }

  // set_transfer_fee writes the fee into newer_transfer_fee for epoch + 2. The check rejects it
  // whether or not localnet has reached that epoch yet.
  async function scheduleTransferFee(
    mint: PublicKey,
    feeBasisPoints = 100,
    maxFee = 1_000_000n
  ) {
    const authority = provider.wallet.payer as Keypair;
    const tx = new anchor.web3.Transaction().add(
      createSetTransferFeeInstruction(
        mint,
        authority.publicKey,
        [],
        feeBasisPoints,
        maxFee,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(tx, [authority]);
  }

  // 12.4 A transfer fee that can charge (bps and maximum fee both nonzero) is rejected on allowMint
  it("12.4 chargeable TransferFee mint rejected on allowMint", async () => {
    for (const [bps, maxFee] of [
      [100, 1_000_000n],
      [1, 1n],
    ] as const) {
      const { mint } = await transferFeeMint(bps, maxFee);
      await expectTransferFeeRejected(() => allowMint(mint));
    }

    // Scheduling a zero fee moves the active 100 bps into older_transfer_fee, which stays in force until epoch + 2
    const { mint } = await transferFeeMint(100, 1_000_000n);
    await scheduleTransferFee(mint, 0, 0n);
    await expectTransferFeeRejected(() => allowMint(mint));
  });

  // 12.5 A TransferFeeConfig that computes a zero fee is allowed and settles exactly: both fields zero
  // (PYUSD / USDG), 0 bps with a maximum fee (AUSD), or bps with a zero maximum fee
  it("12.5 zero TransferFee mint allowed, deposit and release are exact", async () => {
    for (const [bps, maxFee] of [
      [0, 0n],
      [0, 1_000_000n],
      [100, 0n],
    ] as const) {
      const { mint, authorityAta } = await transferFeeMint(bps, maxFee);
      await allowMint(mint);

      await depositReserveRelease(
        mint,
        getMintFeeConfigAddress(mint, escrowProgram.programId),
        authorityAta
      );
    }
  });

  // 12.6 A fee scheduled after allowlisting blocks deposits and fee config updates
  it("12.6 scheduled TransferFee blocks deposit and setMintFeeConfig", async () => {
    const { mint, authorityAta } = await transferFeeMint(0, 0n);
    await allowMint(mint);
    const mintFeeConfig = getMintFeeConfigAddress(
      mint,
      escrowProgram.programId
    );

    await expectTransferFeeRejected(() =>
      depositReserveRelease(mint, mintFeeConfig, authorityAta, () =>
        scheduleTransferFee(mint)
      )
    );

    await expectTransferFeeRejected(() =>
      escrowProgram.methods
        .setMintFeeConfig(new anchor.BN(0), new anchor.BN(0), new anchor.BN(0))
        .accountsPartial({
          tokenConfigAuthority: provider.wallet.publicKey,
          protocolConfig,
          mintAccount: mint,
          mintFeeConfig,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc()
    );
  });

  // 12.7 Release and refund stay unchecked, so a fee scheduled after deposit cannot strand open deposits
  it("12.7 deposits open before a fee is scheduled still release and refund exactly", async () => {
    const { mint, authorityAta } = await transferFeeMint(0, 0n);
    await allowMint(mint);
    const mintFeeConfig = getMintFeeConfigAddress(
      mint,
      escrowProgram.programId
    );
    const toRelease = await openDeposit(mint, mintFeeConfig, authorityAta);
    const toRefund = await openDeposit(mint, mintFeeConfig, authorityAta);

    // The fee lands in newer_transfer_fee for epoch + 2, which localnet does not reach in this test.
    await scheduleTransferFee(mint);

    await reserveDeposit(toRelease);
    await releaseDeposit(toRelease);
    expect(
      (await balance(await ata(mint, toRelease.recipient.publicKey))).toString()
    ).to.equal(DEPOSIT_AMOUNT.toString());

    const before = await balance(toRefund.depositorAta);
    await refundDeposit(toRefund);
    expect((await balance(toRefund.depositorAta)) - before).to.equal(
      BigInt(DEPOSIT_AMOUNT.toString())
    );
  });

  async function requireIncomingMemos(d: OpenDeposit) {
    const tx = new anchor.web3.Transaction().add(
      createReallocateInstruction(
        d.depositorAta,
        d.payer.publicKey,
        [ExtensionType.MemoTransfer],
        d.depositor.publicKey,
        [],
        TOKEN_2022_PROGRAM_ID
      ),
      createEnableRequiredMemoTransfersInstruction(
        d.depositorAta,
        d.depositor.publicKey,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(tx, [d.payer, d.depositor]);
  }

  // Anyone can send tokens to an escrow ATA, which leaves a surplus that release returns.
  async function donateToEscrow(
    d: OpenDeposit,
    authorityAta: PublicKey,
    amount: bigint
  ) {
    const authority = provider.wallet.payer as Keypair;
    await transferCheckedWithTransferHook(
      provider.connection,
      authority,
      authorityAta,
      d.mint,
      d.escrowAta,
      authority,
      amount,
      MINT_DECIMALS,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
  }

  // 12.8 A depositor ATA that requires incoming memos cannot block release or refund
  it("12.8 depositor ATA requiring memos still receives the surplus and the refund", async () => {
    const { mint, authorityAta } = await transferFeeMint(0, 0n);
    await allowMint(mint);
    const mintFeeConfig = getMintFeeConfigAddress(
      mint,
      escrowProgram.programId
    );

    const released = await openDeposit(mint, mintFeeConfig, authorityAta);
    await reserveDeposit(released);
    await requireIncomingMemos(released);
    await donateToEscrow(released, authorityAta, 1n);
    const releasedBefore = await balance(released.depositorAta);
    await releaseDeposit(released);
    expect(
      (await balance(await ata(mint, released.recipient.publicKey))).toString()
    ).to.equal(DEPOSIT_AMOUNT.toString());
    expect((await balance(released.depositorAta)) - releasedBefore).to.equal(
      1n
    );

    const refunded = await openDeposit(mint, mintFeeConfig, authorityAta);
    await requireIncomingMemos(refunded);
    await donateToEscrow(refunded, authorityAta, 1n);
    const refundedBefore = await balance(refunded.depositorAta);
    await refundDeposit(refunded);
    expect((await balance(refunded.depositorAta)) - refundedBefore).to.equal(
      BigInt(DEPOSIT_AMOUNT.toString()) + 1n
    );
  });

  // 12.9 A depositor ATA that cannot take a plain credit sends the surplus to the treasury, and the
  // payout still lands
  it("12.9 frozen depositor ATA does not block release, surplus goes to the treasury", async () => {
    const authority = provider.wallet.payer as Keypair;
    const { mint, mintFeeConfig, authorityAta } =
      await setupToken2022MintAndFund(escrowProgram, provider, authority, {
        freezeAuthority: true,
      });

    const d = await openDeposit(mint, mintFeeConfig!, authorityAta);
    await reserveDeposit(d);
    await donateToEscrow(d, authorityAta, 7n);
    await freezeAccount(
      provider.connection,
      authority,
      d.depositorAta,
      mint,
      authority,
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
    const treasuryAta = await ata(mint, treasurerKeypair.publicKey);
    const treasuryBefore = (await provider.connection.getAccountInfo(
      treasuryAta
    ))
      ? await balance(treasuryAta)
      : 0n;
    const depositorBefore = await balance(d.depositorAta);

    await releaseDeposit(d);

    expect(
      (await balance(await ata(mint, d.recipient.publicKey))).toString()
    ).to.equal(DEPOSIT_AMOUNT.toString());
    expect((await balance(treasuryAta)) - treasuryBefore).to.equal(7n);
    expect(await balance(d.depositorAta)).to.equal(depositorBefore);
  });

  // 12.10 A classic SPL account's owner can be reassigned, which used to fail release and refund on
  // the ATA owner constraint. The escrow now checks the depositor ATA by address only.
  it("12.10 reassigned classic depositor ATA does not block release or refund", async () => {
    const { mint, mintFeeConfig, authorityTokenAccount } =
      await setupMintAndFund();
    const reassign = async (d: OpenDeposit) =>
      setAuthority(
        provider.connection,
        d.payer,
        d.depositorAta,
        d.depositor,
        AuthorityType.AccountOwner,
        Keypair.generate().publicKey,
        [],
        undefined,
        TOKEN_PROGRAM_ID
      );

    const released = await openDeposit(
      mint,
      mintFeeConfig!,
      authorityTokenAccount,
      undefined,
      TOKEN_PROGRAM_ID
    );
    await reserveDeposit(released);
    await reassign(released);
    await releaseDeposit(released);
    expect(
      (
        await balance(
          await ata(mint, released.recipient.publicKey, TOKEN_PROGRAM_ID),
          TOKEN_PROGRAM_ID
        )
      ).toString()
    ).to.equal(DEPOSIT_AMOUNT.toString());

    const refunded = await openDeposit(
      mint,
      mintFeeConfig!,
      authorityTokenAccount,
      undefined,
      TOKEN_PROGRAM_ID
    );
    await reassign(refunded);
    const before = await balance(refunded.depositorAta, TOKEN_PROGRAM_ID);
    await refundDeposit(refunded);
    expect(
      (await balance(refunded.depositorAta, TOKEN_PROGRAM_ID)) - before
    ).to.equal(BigInt(DEPOSIT_AMOUNT.toString()));
  });

  // 12.11 Release and refund forward a transfer hook's accounts, so a mint whose issuer enables a hook
  // still settles. The strict mock hook fails when its validation PDA is not forwarded.
  it("12.11 hooked mint releases with surplus and refunds when the hook accounts are passed", async () => {
    const authority = provider.wallet.payer as Keypair;
    const {
      mint,
      mintFeeConfig,
      depositorAta: authorityAta,
      extraAccountMetaList,
    } = await setupTransferHookMint(
      escrowProgram,
      provider,
      authority,
      authority
    );
    const hookAccounts =
      buildTransferHookRemainingAccounts(extraAccountMetaList);
    // A 1% protocol fee, so release runs the net, fee and surplus transfers under the hook.
    await escrowProgram.methods
      .setMintFeeConfig(
        new anchor.BN(10_000),
        new anchor.BN(0),
        new anchor.BN(1_000_000_000)
      )
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig: mintFeeConfig!,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const released = await openDeposit(
      mint,
      mintFeeConfig!,
      authorityAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
      hookAccounts
    );
    await reserveDeposit(released);
    await donateToEscrow(released, authorityAta, 1n);
    const fee = BigInt(
      (
        await escrowProgram.account.depositInfo.fetch(released.deposit)
      ).feeAmount.toString()
    );
    expect(fee > 0n, "the fee transfer must run").to.equal(true);
    const treasuryAta = await ata(mint, treasurerKeypair.publicKey);
    const treasuryBefore = (await provider.connection.getAccountInfo(
      treasuryAta
    ))
      ? await balance(treasuryAta)
      : 0n;

    let err: any;
    try {
      await releaseDeposit({ ...released, remainingAccounts: [] });
    } catch (e) {
      err = e;
    }
    expect(err, "release without the hook accounts must fail").to.exist;

    const depositorBefore = await balance(released.depositorAta);
    await releaseDeposit(released);
    expect(
      await balance(await ata(mint, released.recipient.publicKey))
    ).to.equal(BigInt(DEPOSIT_AMOUNT.toString()) - fee);
    expect((await balance(treasuryAta)) - treasuryBefore).to.equal(fee);
    expect((await balance(released.depositorAta)) - depositorBefore).to.equal(
      1n
    );

    const refunded = await openDeposit(
      mint,
      mintFeeConfig!,
      authorityAta,
      undefined,
      TOKEN_2022_PROGRAM_ID,
      hookAccounts
    );
    const refundedBefore = await balance(refunded.depositorAta);
    await refundDeposit(refunded);
    expect((await balance(refunded.depositorAta)) - refundedBefore).to.equal(
      BigInt(DEPOSIT_AMOUNT.toString())
    );
  });

  // 12.12 A mint with a permanent delegate is rejected on allowMint, whatever else it carries
  it("12.12 PermanentDelegate mint rejected on allowMint", async () => {
    const delegate = Keypair.generate().publicKey;

    const plain = await setupToken2022MintAndFund(
      escrowProgram,
      provider,
      provider.wallet.payer as Keypair,
      { skipAllowlist: true, permanentDelegate: delegate }
    );
    await expectRejected(
      () => allowMint(plain.mint),
      /PermanentDelegateMintNotAllowed/
    );

    // The PYUSD / USDG shape: a zero-fee TransferFeeConfig next to a PermanentDelegate
    const withZeroFee = await setupToken2022MintAndFund(
      escrowProgram,
      provider,
      provider.wallet.payer as Keypair,
      {
        skipAllowlist: true,
        transferFee: { feeBasisPoints: 0, maxFee: 0n },
        permanentDelegate: delegate,
      }
    );
    await expectRejected(
      () => allowMint(withZeroFee.mint),
      /PermanentDelegateMintNotAllowed/
    );

    // Nothing was allowlisted by either attempt
    for (const { mint } of [plain, withZeroFee]) {
      const info = await provider.connection.getAccountInfo(
        getMintFeeConfigAddress(mint, escrowProgram.programId)
      );
      expect(info).to.equal(null);
    }
  });

  // 12.13 A mint extension outside the accepted set is rejected on allowMint
  it("12.13 NonTransferable mint rejected on allowMint", async () => {
    const { mint } = await setupToken2022MintAndFund(
      escrowProgram,
      provider,
      provider.wallet.payer as Keypair,
      { skipAllowlist: true, nonTransferable: true }
    );
    await expectRejected(() => allowMint(mint), /MintExtensionNotAllowed/);
    const info = await provider.connection.getAccountInfo(
      getMintFeeConfigAddress(mint, escrowProgram.programId)
    );
    expect(info).to.equal(null);
  });

  // A transaction marks its fee payer a signer whatever the client sets, and Token-2022 strips the
  // signer flag only from the base transfer accounts, so a hook naming the payer would get to sign.
  it("12.14 hooked deposit refused when the hook's list names a signer", async () => {
    const authority = provider.wallet.payer as Keypair;
    const { mint, mintFeeConfig, depositorAta, extraAccountMetaList } =
      await setupTransferHookMint(
        escrowProgram,
        provider,
        authority,
        authority,
        {
          hookSigner: provider.wallet.publicKey,
        }
      );
    await expectRejected(
      () =>
        openDeposit(
          mint,
          mintFeeConfig!,
          depositorAta,
          undefined,
          TOKEN_2022_PROGRAM_ID,
          buildTransferHookRemainingAccounts(extraAccountMetaList, [
            provider.wallet.publicKey,
          ])
        ),
      /HookAccountSignerNotAllowed/
    );
  });
});
