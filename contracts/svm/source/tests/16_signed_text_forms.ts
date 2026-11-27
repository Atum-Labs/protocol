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
  Keypair,
  createDelegate,
  createMessage,
  createPaymentId,
  createValidNonce,
  ensureProtocolInitialized,
  generateFundedKeypair,
  getOrCreateAssociatedTokenAccount,
  setupMintAndFund,
  treasurerKeypair,
  DEFAULT_QUOTE_HASH,
  ZERO_QUOTE_HASH,
  destinationHash,
  depositComputeBudgetIx,
  rawSigIx,
  escrowSignedText,
  RELEASE_LABEL,
} from "./helpers";
import {
  ESCROW_LABEL_DEPOSIT,
  ESCROW_LABEL_REFUND,
  ESCROW_LABEL_RELEASE,
  ESCROW_LABEL_RESERVE,
  escrowEd25519Instruction,
  escrowMessage,
} from "../../bindings/typescript/escrow-encoding/src/signed-text";
import type {
  EscrowLabel,
  EscrowMessageForm,
} from "../../bindings/typescript/escrow-encoding/src/signed-text";
import { createTransferInstruction } from "@solana/spl-token";
import {
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// Every signed escrow instruction accepts the escrow text bare, in a v1 envelope and in a v0
// envelope, with the instruction data built by the shared escrow-encoding builder.
const FORMS: EscrowMessageForm[] = ["bare", "v1", "v0"];

const LEGACY_TX_LIMIT = 1232;

/** Signs `escrowMessage(form, ...)` and wraps it with the shared builder. */
function formSigIx(
  signer: Keypair,
  label: EscrowLabel,
  hash: Buffer,
  form: EscrowMessageForm
): TransactionInstruction {
  const pk = signer.publicKey.toBytes();
  const message = escrowMessage(form, label, hash, pk);
  // web3.js signs; its instruction keeps the signature at offset 48.
  const signed = rawSigIx(signer, message);
  const signature = Uint8Array.from(signed.data.subarray(48, 112));
  return new TransactionInstruction({
    programId: anchor.web3.Ed25519Program.programId,
    keys: [],
    data: Buffer.from(escrowEd25519Instruction(form, pk, message, signature)),
  });
}

describe("16. Signed text forms", () => {
  let protocolConfig: PublicKey;

  before(async () => {
    protocolConfig = await ensureProtocolInitialized(escrowProgram, provider);
  });

  async function buildFixture() {
    const mintSetup = await setupMintAndFund();
    const mint = mintSetup.mint;
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
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createTransferInstruction(
          mintSetup.authorityTokenAccount,
          authorityAta,
          provider.wallet.publicKey,
          BigInt(500_000_000)
        )
      ),
      [provider.wallet.payer!]
    );
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
    const destHash = await destinationHash();
    const depositHash = await createMessage(
      "deposit",
      [
        paymentId,
        destHash,
        depositor.publicKey.toBuffer(),
        mint.toBuffer(),
        DEPOSIT_AMOUNT.toBuffer("le", 8),
        reserver.publicKey.toBuffer(),
        releaser.publicKey.toBuffer(),
        nonce.toBuffer("le", 8),
        issuedAt.toBuffer("le", 8),
        deadline.toBuffer("le", 8),
      ],
      { protocolConfig }
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
    const escrowAta = await getOrCreateAssociatedTokenAccount(
      mint,
      deposit,
      provider.wallet.payer!
    );
    const recipient = await generateFundedKeypair();

    return {
      authorityAta,
      deadline,
      destHash,
      delegate,
      delegateSigner,
      deposit,
      depositHash,
      depositor,
      escrowAta,
      issuedAt,
      mint,
      mintFeeConfig: mintSetup.mintFeeConfig!,
      nonce,
      payer,
      paymentId,
      recipient,
      releaser,
      replayBucket,
      reserver,
    };
  }

  type Fixture = Awaited<ReturnType<typeof buildFixture>>;

  async function expectResult(
    run: () => Promise<string>,
    expectedErrorCode?: string
  ) {
    if (!expectedErrorCode) {
      await run();
      return;
    }
    try {
      await run();
      expect.fail(`Should have thrown ${expectedErrorCode}`);
    } catch (err: any) {
      expect(err.error?.errorCode?.code, String(err)).to.equal(
        expectedErrorCode
      );
    }
  }

  function depositBuilder(f: Fixture, sigIx: TransactionInstruction) {
    return escrowProgram.methods
      .deposit(
        Array.from(f.paymentId),
        Array.from(f.destHash),
        DEPOSIT_AMOUNT,
        f.reserver.publicKey,
        f.releaser.publicKey,
        f.nonce,
        f.issuedAt,
        f.deadline,
        Array.from(f.depositHash)
      )
      .accountsPartial({
        escrowDelegate: f.delegate,
        authority: f.depositor.publicKey,
        replayBucket: f.replayBucket,
        authorityAta: f.authorityAta,
        deposit: f.deposit,
        escrowAta: f.escrowAta,
        mint: f.mint,
        protocolConfig,
        mintFeeConfig: f.mintFeeConfig,
        payer: f.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([depositComputeBudgetIx(), sigIx])
      .signers([f.payer]);
  }

  async function reserveHash(f: Fixture) {
    return createMessage(
      "reserve",
      [
        f.recipient.publicKey.toBuffer(),
        f.depositHash,
        DEFAULT_QUOTE_HASH,
        DEPOSIT_AMOUNT.toBuffer("le", 8),
      ],
      { protocolConfig }
    );
  }

  function reserveBuilder(f: Fixture, sigIx: TransactionInstruction) {
    return escrowProgram.methods
      .reserve(
        f.recipient.publicKey,
        Array.from(DEFAULT_QUOTE_HASH),
        DEPOSIT_AMOUNT
      )
      .accountsPartial({
        deposit: f.deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([sigIx]);
  }

  async function releaseBuilder(f: Fixture, sigIx: TransactionInstruction) {
    const recipientAta = await getOrCreateAssociatedTokenAccount(
      f.mint,
      f.recipient.publicKey
    );
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      f.mint,
      treasurerKeypair.publicKey
    );
    return escrowProgram.methods
      .release()
      .accountsPartial({
        protocolConfig,
        deposit: f.deposit,
        escrowAta: f.escrowAta,
        recipient: f.recipient.publicKey,
        recipientAta,
        depositor: f.depositor.publicKey,
        depositorAta: f.authorityAta,
        treasurer: treasurerKeypair.publicKey,
        treasuryAta,
        mint: f.mint,
        payer: f.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([sigIx])
      .signers([f.payer]);
  }

  function refundBuilder(f: Fixture, sigIx: TransactionInstruction) {
    return escrowProgram.methods
      .refund()
      .accountsPartial({
        protocolConfig,
        deposit: f.deposit,
        escrowAta: f.escrowAta,
        depositor: f.depositor.publicKey,
        depositorAta: f.authorityAta,
        mint: f.mint,
        payer: f.payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([sigIx])
      .signers([f.payer]);
  }

  function releaseHash(f: Fixture) {
    return createMessage("release", [f.depositHash, DEFAULT_QUOTE_HASH], {
      protocolConfig,
    });
  }

  function refundHash(f: Fixture, quoteHash: Buffer) {
    return createMessage("refund", [f.depositHash, quoteHash], {
      protocolConfig,
    });
  }

  async function depositWith(f: Fixture, form: EscrowMessageForm) {
    const ix = formSigIx(
      f.delegateSigner,
      ESCROW_LABEL_DEPOSIT,
      f.depositHash,
      form
    );
    await depositBuilder(f, ix).rpc();
  }

  for (const form of FORMS) {
    it(`16.1 ${form}: deposit, reserve and release`, async () => {
      const f = await buildFixture();
      await depositWith(f, form);

      const reserveIx = formSigIx(
        f.reserver,
        ESCROW_LABEL_RESERVE,
        await reserveHash(f),
        form
      );
      await reserveBuilder(f, reserveIx).rpc();

      const releaseIx = formSigIx(
        f.releaser,
        ESCROW_LABEL_RELEASE,
        await releaseHash(f),
        form
      );
      await (await releaseBuilder(f, releaseIx)).rpc();
      expect(await provider.connection.getAccountInfo(f.deposit)).to.equal(
        null
      );
    });

    it(`16.2 ${form}: deposit and refund`, async () => {
      const f = await buildFixture();
      await depositWith(f, form);
      const refundIx = formSigIx(
        f.releaser,
        ESCROW_LABEL_REFUND,
        await refundHash(f, ZERO_QUOTE_HASH),
        form
      );
      await refundBuilder(f, refundIx).rpc();
      expect(await provider.connection.getAccountInfo(f.deposit)).to.equal(
        null
      );
    });
  }

  it("16.3 rejects the raw 32-byte hash on every instruction", async () => {
    const f = await buildFixture();
    await expectResult(
      () => depositBuilder(f, rawSigIx(f.delegateSigner, f.depositHash)).rpc(),
      "InvalidMessage"
    );
    await depositWith(f, "bare");

    await expectResult(
      async () =>
        reserveBuilder(f, rawSigIx(f.reserver, await reserveHash(f))).rpc(),
      "InvalidMessage"
    );
    await expectResult(
      async () =>
        refundBuilder(
          f,
          rawSigIx(f.releaser, await refundHash(f, ZERO_QUOTE_HASH))
        ).rpc(),
      "InvalidMessage"
    );

    await reserveBuilder(
      f,
      formSigIx(f.reserver, ESCROW_LABEL_RESERVE, await reserveHash(f), "bare")
    ).rpc();
    await expectResult(
      async () =>
        (
          await releaseBuilder(f, rawSigIx(f.releaser, await releaseHash(f)))
        ).rpc(),
      "InvalidMessage"
    );
  });

  it("16.4 rejects text signed under another instruction's label", async () => {
    const f = await buildFixture();
    await depositWith(f, "bare");
    // The release text over the refund hash: right signer, right hash, wrong label.
    const hash = await refundHash(f, ZERO_QUOTE_HASH);
    await expectResult(
      () =>
        refundBuilder(
          f,
          rawSigIx(f.releaser, escrowSignedText(RELEASE_LABEL, hash))
        ).rpc(),
      "InvalidMessage"
    );
  });

  it("16.5 accepts an envelope with the pubkey outside the message", async () => {
    const f = await buildFixture();
    const message = escrowMessage(
      "v0",
      ESCROW_LABEL_DEPOSIT,
      f.depositHash,
      f.delegateSigner.publicKey.toBytes()
    );
    await depositBuilder(f, rawSigIx(f.delegateSigner, message)).rpc();
  });

  it("16.6 rejects an envelope that names another signer", async () => {
    const f = await buildFixture();
    const other = Keypair.generate();
    const message = escrowMessage(
      "v1",
      ESCROW_LABEL_DEPOSIT,
      f.depositHash,
      other.publicKey.toBytes()
    );
    await expectResult(
      () => depositBuilder(f, rawSigIx(f.delegateSigner, message)).rpc(),
      "InvalidMessage"
    );
  });

  it("16.7 fits the deposit transaction in a legacy transaction in every form", async () => {
    const f = await buildFixture();
    const blockhash = (await provider.connection.getLatestBlockhash())
      .blockhash;
    for (const form of FORMS) {
      const ix = formSigIx(
        f.delegateSigner,
        ESCROW_LABEL_DEPOSIT,
        f.depositHash,
        form
      );
      // Same signers as rpc(): the provider wallet pays fees, f.payer pays rent.
      const tx = await depositBuilder(f, ix).transaction();
      tx.feePayer = provider.wallet.publicKey;
      tx.recentBlockhash = blockhash;
      // serialize() throws above the limit, so size the wire form by hand.
      const message = tx.compileMessage();
      const size =
        1 +
        64 * message.header.numRequiredSignatures +
        message.serialize().length;
      console.log(
        `      deposit tx (${form}): ${size} bytes, legacy limit ${LEGACY_TX_LIMIT}`
      );
      expect(size).to.be.at.most(LEGACY_TX_LIMIT);
    }
  });
});
