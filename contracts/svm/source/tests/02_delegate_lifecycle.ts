import * as anchor from "@coral-xyz/anchor";
import {
  escrowProgram,
  provider,
  expect,
  Keypair,
  PublicKey,
  createDelegate,
  setupMintAndFund,
  DELEGATE_CAPACITY,
  MAX_TRANSFER_SIZE,
  generateFundedKeypair,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  createEd25519Instruction,
  createMessage,
  DEPOSIT_SEED,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SystemProgram,
  ESCROW_DELEGATE_SEED,
  REPLAY_SEED,
  createValidNonce,
  ensureProtocolInitialized,
  destinationHash,
  TEST_DESTINATION,
  depositComputeBudgetIx,
} from "./helpers";
import { Transaction } from "@solana/web3.js";
import { createInitializeAccountInstruction } from "@solana/spl-token";

describe("2. Delegate Lifecycle", () => {
  let mint: PublicKey;
  let protocolConfig: PublicKey;

  before(async () => {
    protocolConfig = await ensureProtocolInitialized(escrowProgram, provider);
    const mintSetup = await setupMintAndFund();
    mint = mintSetup.mint;
  });

  it("2.1. Should create a new delegate", async () => {
    const [delegateAuthority, delegateSigner] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      delegateAuthority.publicKey
    );

    const delegate = await createDelegate(
      delegateAuthority,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const [delegateAccount, authorityTokenAccount] = await Promise.all([
      escrowProgram.account.escrowDelegate.fetch(delegate),
      getAccount(provider.connection, authorityAta),
    ]);

    expect(delegateAccount.authority.toBase58()).to.equal(
      delegateAuthority.publicKey.toBase58()
    );
    expect(delegateAccount.delegateSigner.toBase58()).to.equal(
      delegateSigner.publicKey.toBase58()
    );
    expect(delegateAccount.allowedMint.toBase58()).to.equal(mint.toBase58());
    expect(delegateAccount.remainingCapacity.toString()).to.equal(
      DELEGATE_CAPACITY.toString()
    );
    expect(delegateAccount.maxTransferSize.toString()).to.equal(
      MAX_TRANSFER_SIZE.toString()
    );

    // Verify the token delegation
    expect(authorityTokenAccount.delegate!.toBase58()).to.equal(
      delegate.toBase58()
    );
    expect(authorityTokenAccount.delegatedAmount.toString()).to.equal(
      DELEGATE_CAPACITY.toString()
    );
  });

  it("2.2. Should allow the authority to revoke a delegate", async () => {
    const [delegateAuthority, delegateSigner] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    const delegate = await createDelegate(
      delegateAuthority,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const delegateAccountInfo = await provider.connection.getAccountInfo(
      delegate
    );
    const rentLamports = delegateAccountInfo!.lamports;

    const authorityBalanceBefore = await provider.connection.getBalance(
      delegateAuthority.publicKey
    );

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      delegateAuthority.publicKey
    );

    await escrowProgram.methods
      .revokeDelegate()
      .accountsPartial({
        protocolConfig,
        escrowDelegate: delegate,
        authority: delegateAuthority.publicKey,
        authorityAta,
        payer: delegateAuthority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([delegateAuthority])
      .rpc();

    // Verify the delegate account is closed
    const delegateAccount =
      await escrowProgram.account.escrowDelegate.fetchNullable(delegate);
    expect(delegateAccount).to.be.null;

    const authorityBalanceAfter = await provider.connection.getBalance(
      delegateAuthority.publicKey
    );
    // Rough check, as it won't be exact due to transaction fees
    expect(authorityBalanceAfter).to.be.greaterThan(authorityBalanceBefore);
    // A more precise check would involve calculating the exact fee, but for this test,
    // ensuring the balance increases by approximately the rent is sufficient.
    const expectedBalance = authorityBalanceBefore + rentLamports - 5000; // 5000 is an estimate for the tx fee
    expect(authorityBalanceAfter).to.be.closeTo(expectedBalance, 5000);
  });

  it("2.3. Should allow the delegate signer to renounce a delegate (disable immediately)", async () => {
    const [delegateAuthority, delegateSigner] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    const delegate = await createDelegate(
      delegateAuthority,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    // Renounce by delegate signer
    await escrowProgram.methods
      .renounceDelegate()
      .accountsPartial({
        protocolConfig,
        escrowDelegate: delegate,
        delegateSigner: delegateSigner.publicKey,
      })
      .signers([delegateSigner])
      .rpc();

    // Verify account remains but capacity set to 0 and expiration <= now
    const after = await escrowProgram.account.escrowDelegate.fetch(delegate);
    expect(after.remainingCapacity.toNumber()).to.equal(0);
    const nowTs = Math.floor(Date.now() / 1000);
    expect(after.expiration.toNumber()).to.be.at.most(nowTs);
  });

  it("2.4. Revoke should clear SPL delegation on the authority's ATA", async () => {
    const [delegateAuthority, delegateSigner] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    const delegate = await createDelegate(
      delegateAuthority,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      delegateAuthority.publicKey
    );

    await escrowProgram.methods
      .revokeDelegate()
      .accountsPartial({
        protocolConfig,
        escrowDelegate: delegate,
        authority: delegateAuthority.publicKey,
        authorityAta,
        payer: delegateAuthority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([delegateAuthority])
      .rpc();

    const ataAfter = await getAccount(provider.connection, authorityAta);
    expect(ataAfter.delegate).to.equal(null);
    expect(ataAfter.delegatedAmount.toString()).to.equal("0");
  });

  it("2.4.b. Should reject revocation if authority_ata is not the canonical ATA", async () => {
    const [delegateAuthority, delegateSigner] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    const delegate = await createDelegate(
      delegateAuthority,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    // Create a non-ATA token account for the same owner/mint (raw Token-2020 account)
    // Use low-level instructions to avoid Associated Token Program.
    const nonAtaKeypair = Keypair.generate();
    const rent = await provider.connection.getMinimumBalanceForRentExemption(
      165 // spl-token ACCOUNT_SIZE
    );
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: delegateAuthority.publicKey,
        newAccountPubkey: nonAtaKeypair.publicKey,
        space: 165,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      // Initialize as a standard token account
      // Note: createInitializeAccountInstruction is available from spl-token
      createInitializeAccountInstruction(
        nonAtaKeypair.publicKey,
        mint,
        delegateAuthority.publicKey
      )
    );
    await provider.sendAndConfirm(tx, [delegateAuthority, nonAtaKeypair]);
    const nonAta = nonAtaKeypair.publicKey;

    // Attempt to revoke using the wrong (non-ATA) token account
    try {
      await escrowProgram.methods
        .revokeDelegate()
        .accountsPartial({
          protocolConfig,
          escrowDelegate: delegate,
          authority: delegateAuthority.publicKey,
          authorityAta: nonAta,
          payer: delegateAuthority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([delegateAuthority])
        .rpc();
      expect.fail("Should have failed due to non-ATA account");
    } catch (err: any) {
      // Program enforces canonical ATA constraint now
      if (err.error?.errorCode?.code) {
        expect(err.error.errorCode.code).to.equal("ConstraintAssociated");
      } else {
        expect(err.toString()).to.include("ConstraintAssociated");
      }
    }

    // Verify delegate account still exists (was not closed)
    const stillOpen = await escrowProgram.account.escrowDelegate.fetchNullable(
      delegate
    );
    expect(stillOpen).to.not.equal(null);

    // And the actual ATA still delegates to the escrow delegate
    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      delegateAuthority.publicKey
    );
    const ataInfo = await getAccount(provider.connection, authorityAta);
    expect(ataInfo.delegate?.toBase58()).to.equal(delegate.toBase58());
  });

  it("2.5. Should fail to create a duplicate delegate", async () => {
    const [delegateAuthority, delegateSignerA, delegateSignerB] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    // First creation should succeed
    const delegate = await createDelegate(
      delegateAuthority,
      delegateSignerA,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    // Second creation with a different signer should fail
    try {
      await createDelegate(
        delegateAuthority,
        delegateSignerB,
        mint,
        DELEGATE_CAPACITY,
        MAX_TRANSFER_SIZE,
        1
      );
      expect.fail("Should have failed with 'already in use' error");
    } catch (err: any) {
      expect(err.toString()).to.include("already in use");
    }

    // Verify original delegate signer remains unchanged
    const delegateAccount = await escrowProgram.account.escrowDelegate.fetch(
      delegate
    );
    expect(delegateAccount.delegateSigner.toBase58()).to.equal(
      delegateSignerA.publicKey.toBase58()
    );
  });

  it("2.6. Should fail to create a delegate with invalid parameters", async () => {
    const [delegateAuthority, delegateSigner] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    // Test case 1: Zero capacity
    try {
      await createDelegate(
        delegateAuthority,
        delegateSigner,
        mint,
        new anchor.BN(0),
        MAX_TRANSFER_SIZE,
        1
      );
      expect.fail("Should have failed with zero capacity");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("DelegateLimitsInvalid");
    }

    // Test case 2: Zero max transfer size
    try {
      await createDelegate(
        delegateAuthority,
        delegateSigner,
        mint,
        DELEGATE_CAPACITY,
        new anchor.BN(0),
        1
      );
      expect.fail("Should have failed with zero max transfer size");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("DelegateLimitsInvalid");
    }

    // Test case 3: Max transfer size > capacity
    try {
      await createDelegate(
        delegateAuthority,
        delegateSigner,
        mint,
        new anchor.BN(100),
        new anchor.BN(101),
        1
      );
      expect.fail("Should have failed with max transfer > capacity");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("DelegateLimitsInvalid");
    }
  });

  it("2.7. Should prevent a non-authority from revoking", async () => {
    const [delegateAuthority, delegateSigner, invalidRevoker] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);

    const delegate = await createDelegate(
      delegateAuthority,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    try {
      await escrowProgram.methods
        .revokeDelegate()
        .accountsPartial({
          protocolConfig,
          escrowDelegate: delegate,
          authority: delegateAuthority.publicKey,
          authorityAta: await getOrCreateAssociatedTokenAccount(
            mint,
            delegateAuthority.publicKey
          ),
          payer: invalidRevoker.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([invalidRevoker])
        .rpc();
      expect.fail("Should have failed due to missing authority signature");
    } catch (err: any) {
      expect(err.toString().toLowerCase()).to.include(
        "signature verification failed"
      );
    }
  });

  it("2.8. Should prevent a non-delegate signer from renouncing", async () => {
    const [delegateAuthority, delegateSigner, nonSigner] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    const delegate = await createDelegate(
      delegateAuthority,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    try {
      await escrowProgram.methods
        .renounceDelegate()
        .accountsPartial({
          protocolConfig,
          escrowDelegate: delegate,
          delegateSigner: nonSigner.publicKey,
        })
        .signers([nonSigner])
        .rpc();
      expect.fail("Should have failed due to unauthorized renounce");
    } catch (err: any) {
      expect(err.toString()).to.include("Unauthorized");
    }
  });

  it("2.9. Should prevent deposits to a revoked delegate", async () => {
    const [delegateAuthority, delegateSigner] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);
    const payer = await generateFundedKeypair();

    const delegate = await createDelegate(
      delegateAuthority,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const authorityAta2 = await getOrCreateAssociatedTokenAccount(
      mint,
      delegateAuthority.publicKey
    );

    await escrowProgram.methods
      .revokeDelegate()
      .accountsPartial({
        protocolConfig,
        escrowDelegate: delegate,
        authority: delegateAuthority.publicKey,
        authorityAta: authorityAta2,
        payer: delegateAuthority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([delegateAuthority])
      .rpc();

    // Attempt to deposit against the revoked delegate
    try {
      const paymentId = Keypair.generate().publicKey.toBuffer().slice(0, 32);
      const reserver = Keypair.generate().publicKey;
      const releaser = Keypair.generate().publicKey;
      const nonce = createValidNonce();
      const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
      const amount = new anchor.BN(100);

      const message = await createMessage("deposit", [
        Buffer.from(paymentId),
        await destinationHash(),
        delegateAuthority.publicKey.toBuffer(),
        mint.toBuffer(),
        amount.toBuffer("le", 8),
        reserver.toBuffer(),
        releaser.toBuffer(),
        nonce.toBuffer("le", 8),
        issuedAt.toBuffer("le", 8),
      ]);
      const depositHash = message;

      const ed25519Instruction = createEd25519Instruction(
        delegateSigner,
        message
      );

      const [depositPda] = PublicKey.findProgramAddressSync(
        [DEPOSIT_SEED, depositHash],
        escrowProgram.programId
      );
      const [replayBucket] = PublicKey.findProgramAddressSync(
        [
          REPLAY_SEED,
          delegateAuthority.publicKey.toBuffer(),
          nonce.toBuffer("le", 8).slice(4),
        ],
        escrowProgram.programId
      );
      const escrowAta = await getOrCreateAssociatedTokenAccount(
        mint,
        depositPda
      );
      const authorityAta = await getOrCreateAssociatedTokenAccount(
        mint,
        delegateAuthority.publicKey
      );

      const deadline = new anchor.BN(issuedAt.toNumber() + 60);
      await escrowProgram.methods
        .deposit(
          Array.from(paymentId),
          TEST_DESTINATION,
          amount,
          reserver,
          releaser,
          nonce,
          issuedAt,
          deadline,
          Array.from(depositHash)
        )
        .accountsPartial({
          escrowDelegate: delegate,
          authority: delegateAuthority.publicKey,
          replayBucket,
          authorityAta: authorityAta,
          deposit: depositPda,
          escrowAta: escrowAta,
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

      expect.fail("Should have failed to deposit against a revoked delegate");
    } catch (err: any) {
      // The delegate account no longer exists, so any reference to it should fail
      // This can manifest as AnchorError or other related errors
      const errorStr = err.toString();
      expect(
        errorStr.includes("AnchorError") ||
          errorStr.includes("TokenOwnerOffCurveError") ||
          errorStr.includes("Account does not exist")
      ).to.equal(true, `Unexpected error: ${errorStr}`);
    }
  });

  it("2.10. Should prevent deposits to a renounced (expired) delegate", async () => {
    const [delegateAuthority, delegateSigner] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    const delegate = await createDelegate(
      delegateAuthority,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    // Renounce by delegate signer
    await escrowProgram.methods
      .renounceDelegate()
      .accountsPartial({
        protocolConfig,
        escrowDelegate: delegate,
        delegateSigner: delegateSigner.publicKey,
      })
      .signers([delegateSigner])
      .rpc();

    // Try to deposit after renounce -> should fail with Expired
    const paymentId = Keypair.generate().publicKey.toBuffer().slice(0, 32);
    const reserver = Keypair.generate().publicKey;
    const releaser = Keypair.generate().publicKey;
    const nonce = createValidNonce();
    const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
    const amount = new anchor.BN(100);
    const message = await createMessage("deposit", [
      Buffer.from(paymentId),
      await destinationHash(),
      delegateAuthority.publicKey.toBuffer(),
      mint.toBuffer(),
      amount.toBuffer("le", 8),
      reserver.toBuffer(),
      releaser.toBuffer(),
      nonce.toBuffer("le", 8),
      issuedAt.toBuffer("le", 8),
      issuedAt.addn(60).toBuffer("le", 8),
    ]);
    const depositHash = message;

    const ed25519Instruction = createEd25519Instruction(
      delegateSigner,
      message
    );

    const [depositPda] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, depositHash],
      escrowProgram.programId
    );
    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        delegateAuthority.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).slice(4),
      ],
      escrowProgram.programId
    );
    const escrowAta = await getOrCreateAssociatedTokenAccount(mint, depositPda);
    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      delegateAuthority.publicKey
    );

    try {
      await escrowProgram.methods
        .deposit(
          Array.from(paymentId),
          TEST_DESTINATION,
          amount,
          reserver,
          releaser,
          nonce,
          issuedAt,
          issuedAt.addn(60),
          Array.from(depositHash)
        )
        .accountsPartial({
          escrowDelegate: delegate,
          authority: delegateAuthority.publicKey,
          replayBucket,
          authorityAta,
          deposit: depositPda,
          escrowAta,
          mint,
          payer: delegateAuthority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([depositComputeBudgetIx(), ed25519Instruction])
        .signers([delegateAuthority])
        .rpc();
      expect.fail("Should have failed with Expired error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("CapacityExceeded");
    }
  });

  it("2.11. Should allow a distinct fee payer for delegate creation", async () => {
    const [delegateAuthority, delegateSigner, feePayer] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    const expiration = new anchor.BN(Math.floor(Date.now() / 1000) + 3600); // 1 hour

    // Record initial balances to verify fee payment
    const [feePayerBalanceBefore, authorityBalanceBefore] = await Promise.all([
      provider.connection.getBalance(feePayer.publicKey),
      provider.connection.getBalance(delegateAuthority.publicKey),
    ]);

    // STEP 1: Authority prepares the transaction but doesn't pay fees

    // Calculate the delegate PDA (Program Derived Address)
    const [delegatePda] = PublicKey.findProgramAddressSync(
      [
        ESCROW_DELEGATE_SEED,
        delegateAuthority.publicKey.toBuffer(),
        mint.toBuffer(),
      ],
      escrowProgram.programId
    );

    // Get or create the authority's token account
    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      delegateAuthority.publicKey
    );

    // Build the transaction instruction
    const tx = await escrowProgram.methods
      .createDelegate(
        delegateSigner.publicKey,
        DELEGATE_CAPACITY,
        MAX_TRANSFER_SIZE,
        expiration
      )
      .accountsPartial({
        protocolConfig,
        authority: delegateAuthority.publicKey,
        escrowDelegate: delegatePda,
        authorityAta,
        mint,
        payer: feePayer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();

    // Get fresh blockhash and set fee payer
    const { blockhash, lastValidBlockHeight } =
      await provider.connection.getLatestBlockhash();
    tx.feePayer = feePayer.publicKey;
    tx.recentBlockhash = blockhash;

    // Authority signs their part of the transaction
    tx.partialSign(delegateAuthority);

    // Serialize transaction for transfer (e.g., over HTTP to fee payer)
    const serializedTx = tx.serialize({ requireAllSignatures: false });

    // STEP 2: Fee payer receives, signs, and submits the transaction

    // Deserialize the transaction received from authority
    const receivedTx = Transaction.from(serializedTx);

    // SECURITY: Verify the transaction before signing as fee payer
    // This prevents the fee payer from being tricked into paying for malicious transactions

    // Check 1: Verify fee payer is correctly set
    if (!receivedTx.feePayer!.equals(feePayer.publicKey)) {
      throw new Error(
        "Transaction fee payer does not match expected fee payer"
      );
    }

    // Check 2: Verify there's only one instruction (should be createDelegate)
    if (receivedTx.instructions.length !== 1) {
      throw new Error(
        `Expected 1 instruction, got ${receivedTx.instructions.length}`
      );
    }

    const receivedIx = receivedTx.instructions[0]!;

    // Check 3: Verify the instruction is calling the correct program
    if (!receivedIx.programId.equals(escrowProgram.programId)) {
      throw new Error("Instruction is not calling the expected escrow program");
    }

    // Check 4: Re-create the expected instruction to verify it matches
    const expectedIx = await escrowProgram.methods
      .createDelegate(
        delegateSigner.publicKey,
        DELEGATE_CAPACITY,
        MAX_TRANSFER_SIZE,
        expiration
      )
      .accountsPartial({
        protocolConfig,
        authority: delegateAuthority.publicKey,
        escrowDelegate: delegatePda,
        mint,
        payer: feePayer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // Check 5: Verify instruction data matches exactly
    if (!receivedIx.data.equals(expectedIx.data)) {
      throw new Error(
        "Instruction data does not match expected createDelegate call"
      );
    }

    // Check 6: Verify accounts match exactly
    if (receivedIx.keys.length !== expectedIx.keys.length) {
      throw new Error("Account count mismatch in instruction");
    }

    for (let i = 0; i < receivedIx.keys.length; i++) {
      if (!receivedIx.keys[i]!.pubkey.equals(expectedIx.keys[i]!.pubkey)) {
        throw new Error(`Account ${i} public key mismatch`);
      }
      if (receivedIx.keys[i]!.isSigner !== expectedIx.keys[i]!.isSigner) {
        throw new Error(`Account ${i} signer flag mismatch`);
      }
      if (receivedIx.keys[i]!.isWritable !== expectedIx.keys[i]!.isWritable) {
        throw new Error(`Account ${i} writable flag mismatch`);
      }
    }

    // Check 7: Verify the authority has signed but fee payer hasn't
    const authoritySignature = receivedTx.signatures.find((s) =>
      s.publicKey.equals(delegateAuthority.publicKey)
    );
    if (!authoritySignature || !authoritySignature.signature) {
      throw new Error("Authority has not signed the transaction");
    }

    const feePayerSignature = receivedTx.signatures.find((s) =>
      s.publicKey.equals(feePayer.publicKey)
    );
    if (!feePayerSignature || feePayerSignature.signature !== null) {
      throw new Error("Fee payer signature state is unexpected");
    }

    // Fee payer adds their signature
    receivedTx.partialSign(feePayer);

    // Send the fully signed transaction to the network
    const signature = await provider.connection.sendRawTransaction(
      receivedTx.serialize()
    );

    // Wait for transaction confirmation
    await provider.connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    });

    // STEP 3: Verify the delegate was created successfully

    const delegateAccount = await escrowProgram.account.escrowDelegate.fetch(
      delegatePda
    );

    expect(delegateAccount.authority.toBase58()).to.equal(
      delegateAuthority.publicKey.toBase58()
    );
    expect(delegateAccount.delegateSigner.toBase58()).to.equal(
      delegateSigner.publicKey.toBase58()
    );

    // STEP 4: Verify fee payment worked as expected

    const [feePayerBalanceAfter, authorityBalanceAfter] = await Promise.all([
      provider.connection.getBalance(feePayer.publicKey),
      provider.connection.getBalance(delegateAuthority.publicKey),
    ]);

    // Fee payer should have paid transaction fees
    expect(feePayerBalanceAfter).to.be.lessThan(feePayerBalanceBefore);
    // Authority balance should remain the same
    expect(authorityBalanceAfter).to.be.equal(authorityBalanceBefore);
  });

  it("2.12. Should allow a distinct fee payer for delegate revocation", async () => {
    const [delegateAuthority, delegateSigner, feePayer] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    const delegate = await createDelegate(
      delegateAuthority,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    // Capture rent on the delegate account to validate who receives it on close
    const delegateAccountInfo = await provider.connection.getAccountInfo(
      delegate
    );
    const rentLamports = delegateAccountInfo?.lamports ?? 0;

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      delegateAuthority.publicKey
    );

    // Record initial balances
    const [feePayerBefore, authorityBefore] = await Promise.all([
      provider.connection.getBalance(feePayer.publicKey),
      provider.connection.getBalance(delegateAuthority.publicKey),
    ]);

    // Build revoke tx with external fee payer
    const tx = await escrowProgram.methods
      .revokeDelegate()
      .accountsPartial({
        protocolConfig,
        escrowDelegate: delegate,
        authority: delegateAuthority.publicKey,
        authorityAta,
        payer: feePayer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .transaction();

    const { blockhash, lastValidBlockHeight } =
      await provider.connection.getLatestBlockhash();
    tx.feePayer = feePayer.publicKey;
    tx.recentBlockhash = blockhash;

    // Authority signs
    tx.partialSign(delegateAuthority);

    // Fee payer signs and submits
    const signed = Transaction.from(
      tx.serialize({ requireAllSignatures: false })
    );
    signed.partialSign(feePayer);
    const sig = await provider.connection.sendRawTransaction(
      signed.serialize()
    );
    await provider.connection.confirmTransaction({
      signature: sig,
      blockhash,
      lastValidBlockHeight,
    });

    // Verify closed
    const closed = await escrowProgram.account.escrowDelegate.fetchNullable(
      delegate
    );
    expect(closed).to.be.null;

    // Balances reflect: fee payer receives rent back (from account close) and pays tx fees; authority unchanged
    const [feePayerAfter, authorityAfter] = await Promise.all([
      provider.connection.getBalance(feePayer.publicKey),
      provider.connection.getBalance(delegateAuthority.publicKey),
    ]);
    expect(feePayerAfter).to.be.at.least(feePayerBefore);
    // Rough check around expected net (rent - fee). Allow some tolerance for fee variability.
    const expectedFeePayerBalance = feePayerBefore + rentLamports - 10_000; // ~fee
    expect(feePayerAfter).to.be.at.least(expectedFeePayerBalance);
    expect(authorityAfter).to.equal(authorityBefore);
  });

  it("2.13. Should allow the same delegate signer across multiple mints", async () => {
    const [delegateAuthority, delegateSigner] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);

    const firstMintSetup = await setupMintAndFund();
    const firstMint = firstMintSetup.mint;
    const delegateA = await createDelegate(
      delegateAuthority,
      delegateSigner,
      firstMint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const secondMintSetup = await setupMintAndFund();
    const secondMint = secondMintSetup.mint;
    const delegateB = await createDelegate(
      delegateAuthority,
      delegateSigner,
      secondMint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    expect(delegateA.toBase58()).to.not.equal(delegateB.toBase58());

    const [delegateAAccount, delegateBAccount] = await Promise.all([
      escrowProgram.account.escrowDelegate.fetch(delegateA),
      escrowProgram.account.escrowDelegate.fetch(delegateB),
    ]);
    expect(delegateAAccount.allowedMint.toBase58()).to.equal(
      firstMint.toBase58()
    );
    expect(delegateBAccount.allowedMint.toBase58()).to.equal(
      secondMint.toBase58()
    );
  });
});
