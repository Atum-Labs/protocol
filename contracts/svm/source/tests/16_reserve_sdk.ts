import { createRequire } from "module";
import path from "path";
import bs58 from "bs58";
import {
  anchor,
  escrowProgram,
  provider,
  expect,
  Keypair,
  PublicKey,
  SystemProgram,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  DEPOSIT_SEED,
  REPLAY_SEED,
  DELEGATE_CAPACITY,
  DEPOSIT_AMOUNT,
  ESCROW_SIGNATURE_DOMAIN_VERSION,
  MAX_TRANSFER_SIZE,
  createDelegate,
  depositComputeBudgetIx,
  destinationHash,
  escrowSignedText,
  DEPOSIT_LABEL,
  RESERVE_LABEL,
  ensureProtocolInitialized,
  generateFundedKeypair,
  getOrCreateAssociatedTokenAccount,
  setupMintAndFund,
} from "./helpers";
import {
  createTransferInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { randomBytes } from "crypto";

// The parts of the TypeScript SDK this suite drives, as an integrator runs them.
type SignedMessage = {
  message: string;
  message_prehash: string;
  signature: string;
  svmMessageScheme?: string;
};
type SenderAuthSdk = {
  getChainAdapter(network: string): {
    buildAuthMessage(params: Record<string, unknown>): Promise<{
      messageHash: string;
      messagePrehash: string;
    }>;
  };
  localKeySigner(
    network: string,
    privateKey: string
  ): { sign(message: SignedMessage): Promise<{ signature: string }> };
  buildReserveMessage(input: Record<string, unknown>): {
    message: string;
    message_prehash: string;
  };
};

// From its build output, required: a missing build fails the run, never skips it.
const SENDER_AUTH = path.resolve(
  __dirname,
  "../../../../schemas/declarations/PaymentRequest/v1/bindings/typescript/sender-auth"
);
function loadSdk(): SenderAuthSdk {
  try {
    return createRequire(path.join(SENDER_AUTH, "package.json"))(SENDER_AUTH);
  } catch (error) {
    throw new Error(
      `the sender-auth SDK is not built. At the repository root run \`pnpm install\` and ` +
        `\`pnpm --filter "@atum-labs/payment-request-sender-auth..." build\`. (${
          (error as Error).message
        })`,
      { cause: error }
    );
  }
}
const sdk = loadSdk();

const NETWORK = "solana:localnet";
// The program under test is the v5 escrow, which accepts text signatures only; the SDK signs raw
// unless told the escrow's scheme.
const SCHEME = "escrow-text-v1";
// The local validator's escrow is initialized for this cluster name (helpers' ESCROW_TEST_CLUSTER_ID).
const CLUSTER = "localnet";
const DESTINATION_ASSET =
  "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const DESTINATION_ACCOUNT = "0xc0ffee254729296a45a3885639ac7e10f9d54979";

type SolanaDepositPrehash = {
  deposit_request_hash: string;
  destination: string;
  depositor: string;
  mint: string;
  amount: string;
  reserver: string;
  releaser: string;
  nonce: string;
  issued_at: string;
  deadline: string;
};

const hexBytes = (hex: string) => Buffer.from(hex.replace(/^0x/, ""), "hex");

// The SDK builds the deposit and the reserve, each key signs through the SDK's signer, and the
// escrow program on the local validator must accept them: the deposit hash is the SDK's payment id,
// and the reserve's signature domain (cluster, program id, version) is the program's.
describe("16. SDK-built reserve", () => {
  let protocolConfig: PublicKey;
  let otherRecipient: Keypair;

  before(async () => {
    protocolConfig = await ensureProtocolInitialized(escrowProgram, provider);
    otherRecipient = Keypair.generate();
  });

  const escrowDefaults = (reserver: Keypair, releaser: Keypair) => ({
    escrowContract: escrowProgram.programId.toBase58(),
    quoteSelector: reserver.publicKey.toBase58(),
    fulfillmentVerifierAccount: releaser.publicKey.toBase58(),
    svmSignatureClusterId: CLUSTER,
    svmSignatureDomainVersion: ESCROW_SIGNATURE_DOMAIN_VERSION,
  });

  // The validator's clock, as the SDK reads a cluster's clock for issued_at.
  const validatorClock = async () => {
    const time = await provider.connection.getBlockTime(
      await provider.connection.getSlot()
    );
    if (time === null)
      throw new Error("the local validator returned no block time");
    return BigInt(time);
  };

  // An SDK-built deposit for the quote's source amount, held by the escrow on the local validator.
  async function depositWithSdk() {
    const mintSetup = await setupMintAndFund();
    const { mint, authorityTokenAccount } = mintSetup;
    const mintFeeConfig = mintSetup.mintFeeConfig!;
    const [depositor, delegateSigner, reserver, releaser, payer] =
      await Promise.all([
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
        generateFundedKeypair(),
      ]);
    const settler = Keypair.generate();

    const authorityAta = await getOrCreateAssociatedTokenAccount(
      mint,
      depositor.publicKey
    );
    await sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createTransferInstruction(
          authorityTokenAccount,
          authorityAta,
          provider.wallet.publicKey,
          BigInt(DEPOSIT_AMOUNT.toString())
        )
      ),
      [provider.wallet.payer!]
    );
    const delegate = await createDelegate(
      depositor,
      delegateSigner,
      mint,
      DELEGATE_CAPACITY,
      MAX_TRANSFER_SIZE,
      1
    );

    const built = await sdk.getChainAdapter(NETWORK).buildAuthMessage({
      sourceAsset: `${NETWORK}/token:${mint.toBase58()}`,
      depositor: depositor.publicKey.toBase58(),
      maxSourceAmount: "",
      quoteSourceAmount: DEPOSIT_AMOUNT.toString(),
      requestId: `sdk-award-${randomBytes(8).toString("hex")}`,
      destinationAsset: DESTINATION_ASSET,
      destinationAccount: DESTINATION_ACCOUNT,
      sourceDefaults: escrowDefaults(reserver, releaser),
      solanaClockReader: validatorClock,
    });
    const { signature } = await sdk
      .localKeySigner(NETWORK, bs58.encode(delegateSigner.secretKey))
      .sign({
        message: built.messageHash,
        message_prehash: built.messagePrehash,
        signature: "",
        svmMessageScheme: SCHEME,
      });
    const prehash: SolanaDepositPrehash = JSON.parse(built.messagePrehash);
    const depositHash = hexBytes(built.messageHash);
    const nonce = new anchor.BN(prehash.nonce);

    const [deposit] = PublicKey.findProgramAddressSync(
      [DEPOSIT_SEED, depositHash],
      escrowProgram.programId
    );
    const [replayBucket] = PublicKey.findProgramAddressSync(
      [
        REPLAY_SEED,
        depositor.publicKey.toBuffer(),
        nonce.toBuffer("le", 8).subarray(4),
      ],
      escrowProgram.programId
    );
    await escrowProgram.methods
      .deposit(
        Array.from(hexBytes(prehash.deposit_request_hash)),
        Array.from(await destinationHash(prehash.destination)),
        new anchor.BN(prehash.amount),
        new PublicKey(prehash.reserver),
        new PublicKey(prehash.releaser),
        nonce,
        new anchor.BN(prehash.issued_at),
        new anchor.BN(prehash.deadline),
        Array.from(depositHash)
      )
      .accountsPartial({
        escrowDelegate: delegate,
        authority: depositor.publicKey,
        replayBucket,
        authorityAta,
        deposit,
        escrowAta: await getAssociatedTokenAddress(mint, deposit, true),
        mint,
        protocolConfig,
        mintFeeConfig,
        payer: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        depositComputeBudgetIx(),
        anchor.web3.Ed25519Program.createInstructionWithPublicKey({
          publicKey: delegateSigner.publicKey.toBytes(),
          message: escrowSignedText(DEPOSIT_LABEL, depositHash),
          signature: hexBytes(signature),
        }),
      ])
      .signers([payer])
      .rpc();

    const stored = await escrowProgram.account.depositInfo.fetch(deposit);
    expect(Buffer.from(stored.depositHash).equals(depositHash)).to.equal(
      true,
      "the escrow holds the deposit under the SDK payment id"
    );

    // The reserve the reserver signs for the chosen quote, through the SDK.
    const witness = {
      depositId: built.messageHash,
      quoteHash: "0x" + randomBytes(32).toString("hex"),
      settler: settler.publicKey.toBase58(),
      sourceAmount: DEPOSIT_AMOUNT.toString(),
    };
    const reserve = sdk.buildReserveMessage({
      network: NETWORK,
      escrowContract: escrowProgram.programId.toBase58(),
      svmSignatureClusterId: CLUSTER,
      svmSignatureDomainVersion: ESCROW_SIGNATURE_DOMAIN_VERSION,
      ...witness,
    });
    const reserveSignature = await sdk
      .localKeySigner(NETWORK, bs58.encode(reserver.secretKey))
      .sign({ ...reserve, signature: "", svmMessageScheme: SCHEME });

    return {
      deposit,
      reserver,
      witness,
      reserveMessage: escrowSignedText(
        RESERVE_LABEL,
        hexBytes(reserve.message)
      ),
      reserveSignature: hexBytes(reserveSignature.signature),
    };
  }

  type Award = Awaited<ReturnType<typeof depositWithSdk>>;

  // The settler submits the reserve with the SDK's signature over `award.witness`, and the fields
  // it names in the instruction.
  const submitReserve = (
    award: Award,
    recipient: PublicKey,
    sourceAmount: anchor.BN
  ) =>
    escrowProgram.methods
      .reserve(
        recipient,
        Array.from(hexBytes(award.witness.quoteHash)),
        sourceAmount
      )
      .accountsPartial({
        deposit: award.deposit,
        protocolConfig,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([
        anchor.web3.Ed25519Program.createInstructionWithPublicKey({
          publicKey: award.reserver.publicKey.toBytes(),
          message: award.reserveMessage,
          signature: award.reserveSignature,
        }),
      ])
      .rpc();

  const genuineReserve = (award: Award) =>
    submitReserve(
      award,
      new PublicKey(award.witness.settler),
      new anchor.BN(award.witness.sourceAmount)
    );

  async function expectReserveError(promise: Promise<unknown>, code: string) {
    try {
      await promise;
      expect.fail(`the reserve should have failed with ${code}`);
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal(code);
    }
  }

  async function expectReserved(award: Award) {
    const stored = await escrowProgram.account.depositInfo.fetch(award.deposit);
    expect(stored.recipient?.toBase58()).to.equal(award.witness.settler);
    expect("0x" + Buffer.from(stored.quoteHash).toString("hex")).to.equal(
      award.witness.quoteHash
    );
    expect(stored.amount.toString()).to.equal(award.witness.sourceAmount);
  }

  it("16.1 SDK reserve is accepted", async () => {
    const award = await depositWithSdk();
    await genuineReserve(award);
    await expectReserved(award);
  });

  it("16.2 a changed recipient fails InvalidMessage", async () => {
    const award = await depositWithSdk();
    await expectReserveError(
      submitReserve(
        award,
        otherRecipient.publicKey,
        new anchor.BN(award.witness.sourceAmount)
      ),
      "InvalidMessage"
    );
    // The same deposit still takes the reserve as signed.
    await genuineReserve(award);
    await expectReserved(award);
  });

  it("16.3 a changed source_amount fails InvalidMessage", async () => {
    const award = await depositWithSdk();
    await expectReserveError(
      submitReserve(
        award,
        new PublicKey(award.witness.settler),
        new anchor.BN(award.witness.sourceAmount).subn(1)
      ),
      "InvalidMessage"
    );
    await genuineReserve(award);
    await expectReserved(award);
  });
});
