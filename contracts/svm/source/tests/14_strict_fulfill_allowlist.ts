import {
  anchor,
  fulfillmentProgram,
  provider,
  expect,
  Keypair,
  PublicKey,
  createPaymentId,
  DEPOSIT_AMOUNT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SystemProgram,
  generateFundedKeypair,
  setupMintAndFund,
  getOrCreateAssociatedTokenAccount,
  createStrictFulfillArgs,
  createStrictFulfillReplayArgs,
  deriveFulfillmentReplayBucket,
  ensureFulfillmentProxyInitialized,
  getParsedTransaction,
} from "./helpers";
import {
  createTransferInstruction,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

// CORE-2116: the strict-fulfill settler allowlist is a dark-flagged, admin-toggleable gate.
// It ships dormant (enforce_settler_allowlist = false) so a fresh redeploy is behavior-neutral;
// the admin flips it on after provisioning the allowlist, and can flip it back off (rollback).
// NOTE: verified locally with `cargo check` + `cargo clippy -D warnings` + `cargo fmt`; this suite
// still needs a local `anchor test` (validator) run before the contract redeploy.
describe("14. Strict-fulfill settler allowlist (CORE-2116)", () => {
  let mint: PublicKey;
  let protocolConfig: PublicKey;
  let authorityTokenAccount: PublicKey;
  let settler: Keypair;
  let settlerAta: PublicKey;
  let to: Keypair;
  let toAta: PublicKey;

  const admin = () => provider.wallet.publicKey;

  const fundSettler = async (kp: Keypair): Promise<PublicKey> => {
    const ata = await getOrCreateAssociatedTokenAccount(mint, kp.publicKey);
    const tx = new Transaction().add(
      createTransferInstruction(
        authorityTokenAccount,
        ata,
        provider.wallet.publicKey,
        BigInt(1_000_000_000)
      )
    );
    await sendAndConfirmTransaction(provider.connection, tx, [
      provider.wallet.payer!,
    ]);
    return ata;
  };

  const strictFulfill = async ({
    settlerSigner,
    fromAta,
    paymentId = createPaymentId(),
    amount = DEPOSIT_AMOUNT,
  }: {
    settlerSigner: Keypair;
    fromAta: PublicKey;
    paymentId?: Buffer;
    amount?: anchor.BN;
  }) => {
    const replayArgs = createStrictFulfillReplayArgs();
    const strictArgs = createStrictFulfillArgs(paymentId, amount, replayArgs);
    const [replayBucket] = deriveFulfillmentReplayBucket(
      replayArgs.nonce,
      settlerSigner.publicKey
    );
    return fulfillmentProgram.methods
      .strictFulfill(...strictArgs)
      .accountsPartial({
        protocolConfig,
        settler: settlerSigner.publicKey,
        payer: settlerSigner.publicKey,
        replayBucket,
        fromAta,
        toAta,
        to: to.publicKey,
        mint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([settlerSigner])
      .rpc();
  };

  const setEnforced = (enforced: boolean) =>
    fulfillmentProgram.methods
      .setEnforceSettlerAllowlist(enforced)
      .accountsPartial({ defaultAdmin: admin(), protocolConfig })
      .rpc();

  before(async () => {
    protocolConfig = await ensureFulfillmentProxyInitialized(
      fulfillmentProgram,
      provider
    );
    [settler, to] = await Promise.all([
      generateFundedKeypair(),
      generateFundedKeypair(),
    ]);
    const mintSetup = await setupMintAndFund(6, BigInt(20_000_000_000));
    mint = mintSetup.mint;
    authorityTokenAccount = mintSetup.authorityTokenAccount;
    settlerAta = await fundSettler(settler);
    toAta = await getOrCreateAssociatedTokenAccount(mint, to.publicKey);
  });

  afterEach(async () => {
    // Leave the protocol dormant for any following suites / reruns.
    await setEnforced(false);
  });

  it("14.1. Ships dormant: an unauthorized settler can strictly fulfill", async () => {
    const cfg = await fulfillmentProgram.account.protocolConfig.fetch(
      protocolConfig
    );
    expect(cfg.enforceSettlerAllowlist).to.equal(false);
    await strictFulfill({ settlerSigner: settler, fromAta: settlerAta });
  });

  it("14.2. Only the default admin can toggle enforcement", async () => {
    const notAdmin = await generateFundedKeypair();
    let failed = false;
    try {
      await fulfillmentProgram.methods
        .setEnforceSettlerAllowlist(true)
        .accountsPartial({ defaultAdmin: notAdmin.publicKey, protocolConfig })
        .signers([notAdmin])
        .rpc();
    } catch (e) {
      failed = true;
      expect((e as Error).toString()).to.match(/Unauthorized|constraint/i);
    }
    expect(failed, "non-admin toggle must revert").to.equal(true);
  });

  it("14.3. When enforced, an unauthorized settler is rejected", async () => {
    await setEnforced(true);
    const attacker = await generateFundedKeypair();
    const attackerAta = await fundSettler(attacker);
    let failed = false;
    try {
      await strictFulfill({ settlerSigner: attacker, fromAta: attackerAta });
    } catch (e) {
      failed = true;
      expect((e as Error).toString()).to.include("UnauthorizedSettler");
    }
    expect(failed, "unauthorized settler must revert when enforced").to.equal(
      true
    );
  });

  it("14.4. When enforced, an allowlisted settler succeeds", async () => {
    await setEnforced(true);
    await fulfillmentProgram.methods
      .addAuthorizedSettler(settler.publicKey)
      .accountsPartial({ defaultAdmin: admin(), protocolConfig })
      .rpc();

    const cfg = await fulfillmentProgram.account.protocolConfig.fetch(
      protocolConfig
    );
    expect(
      cfg.authorizedSettlers.map((s: PublicKey) => s.toBase58())
    ).to.include(settler.publicKey.toBase58());

    await strictFulfill({ settlerSigner: settler, fromAta: settlerAta });

    // Cleanup the allowlist entry.
    await fulfillmentProgram.methods
      .removeAuthorizedSettler(settler.publicKey)
      .accountsPartial({ defaultAdmin: admin(), protocolConfig })
      .rpc();
  });

  it("14.5. An empty quote hash is rejected (guard is unconditional)", async () => {
    let failed = false;
    try {
      await strictFulfill({
        settlerSigner: settler,
        fromAta: settlerAta,
        paymentId: Buffer.alloc(32),
      });
    } catch (e) {
      failed = true;
      expect((e as Error).toString()).to.include("QuoteHashCannotBeEmpty");
    }
    expect(failed, "empty quote hash must revert").to.equal(true);
  });

  it("14.6. When enforced, the allowlist check precedes the input guards", async () => {
    // An unauthorized settler submitting an otherwise-invalid strict fulfill (empty quote hash) must
    // revert with UnauthorizedSettler, NOT QuoteHashCannotBeEmpty — proving the allowlist gate runs
    // before the amount/quote_hash guards, matching EVM/Tron's role-check-first ordering.
    await setEnforced(true);
    const attacker = await generateFundedKeypair();
    const attackerAta = await fundSettler(attacker);
    let failed = false;
    try {
      await strictFulfill({
        settlerSigner: attacker,
        fromAta: attackerAta,
        paymentId: Buffer.alloc(32),
      });
    } catch (e) {
      failed = true;
      const msg = (e as Error).toString();
      expect(msg).to.include("UnauthorizedSettler");
      expect(msg).to.not.include("QuoteHashCannotBeEmpty");
    }
    expect(
      failed,
      "unauthorized settler must revert before the input guards"
    ).to.equal(true);
  });

  it("14.7. removeAuthorizedSettler emits only on a real removal", async () => {
    // Mirrors addAuthorizedSettler: a no-op removal (settler absent) must emit no
    // AuthorizedSettlerRemoved event, so an indexer never sees a phantom removal. Parse the tx logs
    // rather than a live listener (matches the suite's no-listener idiom).
    const parser = new anchor.EventParser(
      fulfillmentProgram.programId,
      fulfillmentProgram.coder
    );
    const countRemovedEvents = async (txSig: string): Promise<number> => {
      // Localnet lags on getTransaction, so reuse the suite's confirm-then-retry reader
      // rather than a single-shot fetch whose `tx!.meta!` would throw on a null result.
      const tx = await getParsedTransaction(txSig);
      let count = 0;
      for (const ev of parser.parseLogs(tx.meta?.logMessages ?? [])) {
        if (ev.name.toLowerCase() === "authorizedsettlerremoved") count++;
      }
      return count;
    };

    const target = await generateFundedKeypair();

    // Real removal (add first) emits exactly one event.
    await fulfillmentProgram.methods
      .addAuthorizedSettler(target.publicKey)
      .accountsPartial({ defaultAdmin: admin(), protocolConfig })
      .rpc();
    const realRemovalSig = await fulfillmentProgram.methods
      .removeAuthorizedSettler(target.publicKey)
      .accountsPartial({ defaultAdmin: admin(), protocolConfig })
      .rpc();
    expect(
      await countRemovedEvents(realRemovalSig),
      "real removal emits one event"
    ).to.equal(1);

    // Removing the now-absent settler is a no-op and emits nothing.
    const noopSig = await fulfillmentProgram.methods
      .removeAuthorizedSettler(target.publicKey)
      .accountsPartial({ defaultAdmin: admin(), protocolConfig })
      .rpc();
    expect(
      await countRemovedEvents(noopSig),
      "no-op removal emits nothing"
    ).to.equal(0);
  });
});
