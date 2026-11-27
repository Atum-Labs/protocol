import {
  anchor,
  escrowProgram,
  fulfillmentProgram,
  provider,
  DEPOSIT_SEED,
  REPLAY_SEED,
  ESCROW_DELEGATE_SEED,
  DELEGATE_CAPACITY,
  MAX_TRANSFER_SIZE,
  DEPOSIT_AMOUNT,
  DEFAULT_QUOTE_HASH,
  ZERO_QUOTE_HASH,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  expect,
  Keypair,
  PublicKey,
  SystemProgram,
  computeExpectedFeeAtoms,
  depositSigIx,
  refundSigIx,
  releaseSigIx,
  reserveSigIx,
  createMessage,
  createPaymentId,
  createStrictFulfillArgs,
  createStrictFulfillReplayArgs,
  createValidNonce,
  deriveFulfillmentReplayBucket,
  depositComputeBudgetIx,
  destinationHash,
  ensureFulfillmentProxyInitialized,
  ensureProtocolInitialized,
  generateFundedKeypair,
  getMintFeeConfigAddress,
} from "./helpers";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getOrCreateAssociatedTokenAccount,
  getPermanentDelegate,
  getTransferFeeConfig,
  getTransferHook,
  mintToChecked,
  unpackMint,
} from "@solana/spl-token";
import { createHash } from "crypto";
import manifest from "./fixtures/real-mints/manifest.json";

// Real mainnet/devnet mint accounts loaded at genesis by the [[test.validator.account]] blocks in
// Anchor.toml. Only mint_authority is patched (to this key) so the suite can mint; see
// scripts/refresh-real-mint-fixtures.ts, which derives the same key.
const FIXTURE_MINT_AUTHORITY = Keypair.fromSeed(
  createHash("sha256").update("atum-real-mint-fixture-authority").digest()
);

const FEE_PERCENTAGE_6 = new anchor.BN(20_000);
const MIN_FEE_6 = new anchor.BN(0);
const MAX_FEE_6 = new anchor.BN(25_000_000);
const RESERVED_AMOUNT = DEPOSIT_AMOUNT.muln(4).divn(5);

describe("15 Real Token Compatibility", () => {
  let protocolConfig: PublicKey;
  let proxyProtocolConfig: PublicKey;
  let treasurer: PublicKey;

  before(async () => {
    protocolConfig = await ensureProtocolInitialized(escrowProgram, provider);
    proxyProtocolConfig = await ensureFulfillmentProxyInitialized(
      fulfillmentProgram,
      provider
    );

    // Asserted rather than reset, so state leaked by an earlier suite fails here by name instead
    // of reading as a token incompatibility below.
    const escrowConfig = await escrowProgram.account.protocolConfig.fetch(
      protocolConfig
    );
    expect(escrowConfig.paused).to.equal(false);
    expect(escrowConfig.tokenConfigAuthority.toBase58()).to.equal(
      provider.wallet.publicKey.toBase58()
    );
    treasurer = escrowConfig.treasurer;

    const proxyConfig = await fulfillmentProgram.account.protocolConfig.fetch(
      proxyProtocolConfig
    );
    expect(proxyConfig.paused).to.equal(false);
    expect(proxyConfig.enforceSettlerAllowlist).to.equal(false);
  });

  for (const row of manifest) {
    describe(row.name, () => {
      const mint = new PublicKey(row.mint);
      const tokenProgram =
        row.tokenProgram === "token2022"
          ? TOKEN_2022_PROGRAM_ID
          : TOKEN_PROGRAM_ID;
      const mintFeeConfig = getMintFeeConfigAddress(
        mint,
        escrowProgram.programId
      );
      const allowed = row.expectAllowMint === "ok";
      const payerWallet = provider.wallet.payer as Keypair;

      const ata = (owner: PublicKey) =>
        getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);

      const balance = async (account: PublicKey) =>
        (
          await getAccount(
            provider.connection,
            account,
            undefined,
            tokenProgram
          )
        ).amount;

      const fund = async (owner: PublicKey, amount: anchor.BN) => {
        const account = await getOrCreateAssociatedTokenAccount(
          provider.connection,
          payerWallet,
          mint,
          owner,
          false,
          undefined,
          undefined,
          tokenProgram
        );
        await mintToChecked(
          provider.connection,
          payerWallet,
          mint,
          account.address,
          FIXTURE_MINT_AUTHORITY,
          BigInt(amount.toString()),
          row.decimals,
          [],
          undefined,
          tokenProgram
        );
        return account.address;
      };

      const createDelegate = (
        depositor: Keypair,
        delegateSigner: Keypair,
        payer: Keypair
      ) =>
        escrowProgram.methods
          .createDelegate(
            delegateSigner.publicKey,
            DELEGATE_CAPACITY,
            MAX_TRANSFER_SIZE,
            new anchor.BN(Math.floor(Date.now() / 1000) + 24 * 60 * 60)
          )
          .accountsPartial({
            protocolConfig,
            authority: depositor.publicKey,
            escrowDelegate: PublicKey.findProgramAddressSync(
              [
                ESCROW_DELEGATE_SEED,
                depositor.publicKey.toBuffer(),
                mint.toBuffer(),
              ],
              escrowProgram.programId
            )[0],
            authorityAta: ata(depositor.publicKey),
            mint,
            mintFeeConfig,
            payer: payer.publicKey,
            tokenProgram,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([depositor, payer])
          .rpc();

      // Funds a fresh depositor, approves its delegate and deposits DEPOSIT_AMOUNT.
      const fundAndDeposit = async () => {
        const [depositor, delegateSigner, reserver, releaser, payer] =
          await Promise.all([
            generateFundedKeypair(),
            generateFundedKeypair(),
            generateFundedKeypair(),
            generateFundedKeypair(),
            generateFundedKeypair(),
          ]);
        const depositorAta = await fund(depositor.publicKey, DEPOSIT_AMOUNT);
        await createDelegate(depositor, delegateSigner, payer);

        const paymentId = createPaymentId();
        const nonce = createValidNonce();
        const issuedAt = new anchor.BN(Math.floor(Date.now() / 1000) - 5);
        const deadline = new anchor.BN(issuedAt.toNumber() + 60);
        const depositHash = await createMessage("deposit", [
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
        const [deposit] = PublicKey.findProgramAddressSync(
          [DEPOSIT_SEED, depositHash],
          escrowProgram.programId
        );
        const escrowAta = ata(deposit);

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
            escrowDelegate: PublicKey.findProgramAddressSync(
              [
                ESCROW_DELEGATE_SEED,
                depositor.publicKey.toBuffer(),
                mint.toBuffer(),
              ],
              escrowProgram.programId
            )[0],
            authority: depositor.publicKey,
            replayBucket: PublicKey.findProgramAddressSync(
              [
                REPLAY_SEED,
                depositor.publicKey.toBuffer(),
                nonce.toBuffer("le", 8).slice(4),
              ],
              escrowProgram.programId
            )[0],
            authorityAta: depositorAta,
            deposit,
            escrowAta,
            mint,
            protocolConfig,
            mintFeeConfig,
            payer: payer.publicKey,
            tokenProgram,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
            instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          })
          .preInstructions([
            depositComputeBudgetIx(),
            depositSigIx(delegateSigner, depositHash),
          ])
          .signers([payer])
          .rpc();

        expect((await balance(escrowAta)).toString()).to.equal(
          DEPOSIT_AMOUNT.toString()
        );
        return {
          depositor,
          depositorAta,
          reserver,
          releaser,
          payer,
          deposit,
          depositHash,
          escrowAta,
        };
      };

      it(`15.${row.name}.a fixture matches the manifest`, async () => {
        const info = await provider.connection.getAccountInfo(mint);
        expect(info, "missing [[test.validator.account]] in Anchor.toml").to.not
          .be.null;
        expect(info!.owner.toBase58()).to.equal(tokenProgram.toBase58());

        const parsed = unpackMint(mint, info, tokenProgram);
        expect(parsed.decimals).to.equal(row.decimals);
        expect(parsed.mintAuthority?.toBase58()).to.equal(
          FIXTURE_MINT_AUTHORITY.publicKey.toBase58()
        );
        expect(
          [...getExtensionTypes(parsed.tlvData)].sort((a, b) => a - b)
        ).to.deep.equal(row.extensions);

        // A cleared delegate reads as the default key, which the manifest writes as null.
        const delegate =
          getPermanentDelegate(parsed)?.delegate.toBase58() ?? null;
        expect(
          delegate === PublicKey.default.toBase58() ? null : delegate
        ).to.equal(row.permanentDelegate);

        const hook = getTransferHook(parsed);
        if (hook) {
          expect(hook.programId.toBase58()).to.equal(
            PublicKey.default.toBase58()
          );
        }
        const fee = getTransferFeeConfig(parsed);
        if (fee) {
          for (const f of [fee.olderTransferFee, fee.newerTransferFee]) {
            expect(f.transferFeeBasisPoints).to.equal(0);
            expect(f.maximumFee.toString()).to.equal("0");
          }
        }
      });

      it(`15.${row.name}.b allowMint: ${row.expectAllowMint}`, async () => {
        const permanentDelegate = row.permanentDelegate
          ? new PublicKey(row.permanentDelegate)
          : PublicKey.default;
        const allowMintWith = (expected: PublicKey) =>
          escrowProgram.methods
            .allowMint(expected)
            .accountsPartial({
              tokenConfigAuthority: provider.wallet.publicKey,
              protocolConfig,
              mintAccount: mint,
              mintFeeConfig,
              tokenProgram,
              systemProgram: SystemProgram.programId,
            })
            .rpc();

        if (allowed && row.permanentDelegate) {
          // The real delegate is pinned only when it is the key the caller expected.
          let refused: any;
          try {
            await allowMintWith(PublicKey.default);
          } catch (err) {
            refused = err;
          }
          expect(refused, "allowMint should fail").to.exist;
          expect(refused.error?.errorCode?.code).to.equal(
            "PermanentDelegateChanged"
          );
          expect(await provider.connection.getAccountInfo(mintFeeConfig)).to.be
            .null;
        }
        const allowMint = allowMintWith(permanentDelegate);

        if (allowed) {
          await allowMint;
          const config = await escrowProgram.account.mintFeeConfig.fetch(
            mintFeeConfig
          );
          expect(config.mint.toBase58()).to.equal(mint.toBase58());
          expect(config.permanentDelegate.toBase58()).to.equal(
            permanentDelegate.toBase58()
          );
          return;
        }
        try {
          await allowMint;
          expect.fail(`allowMint should fail with ${row.expectAllowMint}`);
        } catch (err: any) {
          expect(err.error?.errorCode?.code).to.equal(row.expectAllowMint);
        }
      });

      if (!allowed) {
        it(`15.${row.name}.c createDelegate rejects the unlisted mint`, async () => {
          const [depositor, delegateSigner, payer] = await Promise.all([
            generateFundedKeypair(),
            generateFundedKeypair(),
            generateFundedKeypair(),
          ]);
          await fund(depositor.publicKey, DEPOSIT_AMOUNT);
          try {
            await createDelegate(depositor, delegateSigner, payer);
            expect.fail("createDelegate should fail with MintNotAllowed");
          } catch (err: any) {
            expect(err.error?.errorCode?.code).to.equal("MintNotAllowed");
          }
        });
      }

      if (allowed) {
        it(`15.${row.name}.c fee, partial reserve and release`, async () => {
          await escrowProgram.methods
            .setMintFeeConfig(FEE_PERCENTAGE_6, MIN_FEE_6, MAX_FEE_6)
            .accountsPartial({
              tokenConfigAuthority: provider.wallet.publicKey,
              protocolConfig,
              mintAccount: mint,
              mintFeeConfig,
              tokenProgram,
            })
            .rpc();

          const {
            depositor,
            depositorAta,
            reserver,
            releaser,
            payer,
            deposit,
            depositHash,
            escrowAta,
          } = await fundAndDeposit();
          expect(
            (
              await escrowProgram.account.depositInfo.fetch(deposit)
            ).feeAmount.toString()
          ).to.equal(
            computeExpectedFeeAtoms(
              BigInt(DEPOSIT_AMOUNT.toString()),
              row.decimals,
              {
                feePercentage6: BigInt(FEE_PERCENTAGE_6.toString()),
                minFee6: BigInt(MIN_FEE_6.toString()),
                maxFee6: BigInt(MAX_FEE_6.toString()),
              }
            ).toString()
          );

          const recipient = Keypair.generate();
          await escrowProgram.methods
            .reserve(
              recipient.publicKey,
              Array.from(DEFAULT_QUOTE_HASH),
              RESERVED_AMOUNT
            )
            .accountsPartial({
              deposit,
              protocolConfig,
              instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
            })
            .preInstructions([
              reserveSigIx(
                reserver,
                await createMessage("reserve", [
                  recipient.publicKey.toBuffer(),
                  depositHash,
                  DEFAULT_QUOTE_HASH,
                  RESERVED_AMOUNT.toBuffer("le", 8),
                ])
              ),
            ])
            .rpc();
          // Reserve rescales the deposit-time fee to the reserved amount; release pays from it.
          const fee = BigInt(
            (
              await escrowProgram.account.depositInfo.fetch(deposit)
            ).feeAmount.toString()
          );
          expect(fee > 0n).to.equal(true);

          const recipientAta = ata(recipient.publicKey);
          const treasuryAta = ata(treasurer);
          expect(await provider.connection.getAccountInfo(recipientAta)).to.be
            .null;
          expect(await provider.connection.getAccountInfo(treasuryAta)).to.be
            .null;
          const depositorBefore = await balance(depositorAta);

          await escrowProgram.methods
            .release()
            .accountsPartial({
              protocolConfig,
              deposit,
              escrowAta,
              recipient: recipient.publicKey,
              recipientAta,
              depositor: depositor.publicKey,
              depositorAta,
              treasurer,
              treasuryAta,
              mint,
              payer: payer.publicKey,
              tokenProgram,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
              instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
            })
            .preInstructions([
              // Creating the recipient and treasury ATAs puts this release near the default 200k.
              depositComputeBudgetIx(),
              releaseSigIx(
                releaser,
                await createMessage("release", [
                  depositHash,
                  DEFAULT_QUOTE_HASH,
                ])
              ),
            ])
            .signers([payer])
            .rpc();

          const reserved = BigInt(RESERVED_AMOUNT.toString());
          expect((await balance(recipientAta)).toString()).to.equal(
            (reserved - fee).toString()
          );
          expect((await balance(treasuryAta)).toString()).to.equal(
            fee.toString()
          );
          expect(
            ((await balance(depositorAta)) - depositorBefore).toString()
          ).to.equal((BigInt(DEPOSIT_AMOUNT.toString()) - reserved).toString());
          expect(await provider.connection.getAccountInfo(deposit)).to.be.null;
          expect(await provider.connection.getAccountInfo(escrowAta)).to.be
            .null;
        });

        it(`15.${row.name}.d refund`, async () => {
          const {
            depositor,
            depositorAta,
            releaser,
            payer,
            deposit,
            depositHash,
            escrowAta,
          } = await fundAndDeposit();
          expect((await balance(depositorAta)).toString()).to.equal("0");

          await escrowProgram.methods
            .refund()
            .accountsPartial({
              protocolConfig,
              deposit,
              escrowAta,
              depositor: depositor.publicKey,
              depositorAta,
              mint,
              payer: payer.publicKey,
              tokenProgram,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
              instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
            })
            .preInstructions([
              depositComputeBudgetIx(),
              refundSigIx(
                releaser,
                await createMessage("refund", [depositHash, ZERO_QUOTE_HASH])
              ),
            ])
            .signers([payer])
            .rpc();

          expect((await balance(depositorAta)).toString()).to.equal(
            DEPOSIT_AMOUNT.toString()
          );
          expect(await provider.connection.getAccountInfo(deposit)).to.be.null;
          expect(await provider.connection.getAccountInfo(escrowAta)).to.be
            .null;
        });
      }

      // The proxy takes any mint (no escrow allowlist), so this runs for every row.
      it(`15.${row.name}.e fulfillment proxy fulfill and strictFulfill`, async () => {
        const settler = await generateFundedKeypair();
        const to = Keypair.generate();
        const fromAta = await fund(settler.publicKey, DEPOSIT_AMOUNT.muln(2));
        const toAta = ata(to.publicKey);
        const accounts = {
          protocolConfig: proxyProtocolConfig,
          settler: settler.publicKey,
          payer: settler.publicKey,
          fromAta,
          toAta,
          to: to.publicKey,
          mint,
          tokenProgram,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        };

        // Creates toAta through init_if_needed.
        await fulfillmentProgram.methods
          .fulfill(Array.from(createPaymentId()), DEPOSIT_AMOUNT)
          .accountsPartial(accounts)
          .signers([settler])
          .rpc();
        expect((await balance(toAta)).toString()).to.equal(
          DEPOSIT_AMOUNT.toString()
        );

        const replayArgs = createStrictFulfillReplayArgs();
        await fulfillmentProgram.methods
          .strictFulfill(
            ...createStrictFulfillArgs(
              createPaymentId(),
              DEPOSIT_AMOUNT,
              replayArgs
            )
          )
          .accountsPartial({
            ...accounts,
            replayBucket: deriveFulfillmentReplayBucket(
              replayArgs.nonce,
              settler.publicKey
            )[0],
          })
          .signers([settler])
          .rpc();

        expect((await balance(toAta)).toString()).to.equal(
          DEPOSIT_AMOUNT.muln(2).toString()
        );
        expect((await balance(fromAta)).toString()).to.equal("0");
      });
    });
  }
});
