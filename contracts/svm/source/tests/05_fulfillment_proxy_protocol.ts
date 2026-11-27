import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { FulfillmentProxy } from "../target/types/fulfillment_proxy";
import {
  expect,
  Keypair,
  SystemProgram,
  getProtocolConfigAddress,
  getProgramDataAddress,
  pauserKeypair,
  fundPauser,
  generateFundedKeypair,
  provider,
} from "./helpers";

describe("5. Fulfillment Proxy Protocol", () => {
  const program = anchor.workspace
    .FulfillmentProxy as Program<FulfillmentProxy>;

  const protocolConfig = getProtocolConfigAddress(program.programId);
  const programData = getProgramDataAddress(program.programId);

  it("5.1 Reject initialize_protocol by non-upgrade authority", async () => {
    const randomSigner = await generateFundedKeypair();

    try {
      await program.methods
        .initializeProtocol(
          provider.wallet.publicKey,
          pauserKeypair.publicKey,
          0
        )
        .accountsPartial({
          authority: randomSigner.publicKey,
          protocolConfig,
          program: program.programId,
          programData,
          systemProgram: SystemProgram.programId,
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

  it("5.2 Initialize ProtocolConfig by upgrade authority", async () => {
    await fundPauser(provider);

    await program.methods
      .initializeProtocol(
        provider.wallet.publicKey, // default_admin
        pauserKeypair.publicKey, // pauser
        0 // default_admin_delay_seconds
      )
      .accountsPartial({
        authority: provider.wallet.publicKey,
        protocolConfig,
        program: program.programId,
        programData,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.protocolConfig.fetch(protocolConfig);
    expect(config.defaultAdmin.toString()).to.equal(
      provider.wallet.publicKey.toString()
    );
    expect(config.pauser.toString()).to.equal(
      pauserKeypair.publicKey.toString()
    );
    expect(config.paused).to.equal(false);
    expect(config.defaultAdminDelaySeconds).to.equal(0);
    expect(config.pendingDefaultAdmin).to.be.null;
    expect(config.pendingDefaultAdminAcceptAfterTs).to.be.null;
  });

  it("5.3 Reject duplicate initialization", async () => {
    try {
      await program.methods
        .initializeProtocol(
          provider.wallet.publicKey,
          pauserKeypair.publicKey,
          0
        )
        .accountsPartial({
          authority: provider.wallet.publicKey,
          protocolConfig,
          program: program.programId,
          programData,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      expect.fail("Should have thrown AlreadyInitialized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code).to.equal("AlreadyInitialized");
    }
  });

  it("5.4 Reject pause/unpause by non-pauser", async () => {
    const randomSigner = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      randomSigner.publicKey,
      anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    try {
      await program.methods
        .pause()
        .accountsPartial({
          pauser: randomSigner.publicKey,
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

    // Pause with real pauser
    await program.methods
      .pause()
      .accountsPartial({
        pauser: pauserKeypair.publicKey,
        protocolConfig,
      })
      .signers([pauserKeypair])
      .rpc();

    try {
      await program.methods
        .unpause()
        .accountsPartial({
          pauser: randomSigner.publicKey,
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

    // Unpause with real pauser (avoid impacting later tests).
    await program.methods
      .unpause()
      .accountsPartial({
        pauser: pauserKeypair.publicKey,
        protocolConfig,
      })
      .signers([pauserKeypair])
      .rpc();
  });

  it("5.5 Rotate pauser while paused (recovery)", async () => {
    const newPauser = await generateFundedKeypair();

    await program.methods
      .pause()
      .accountsPartial({
        pauser: pauserKeypair.publicKey,
        protocolConfig,
      })
      .signers([pauserKeypair])
      .rpc();

    // Admin can rotate pauser while paused.
    await program.methods
      .setPauser(newPauser.publicKey)
      .accountsPartial({
        defaultAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();

    // Old pauser can no longer unpause.
    try {
      await program.methods
        .unpause()
        .accountsPartial({
          pauser: pauserKeypair.publicKey,
          protocolConfig,
        })
        .signers([pauserKeypair])
        .rpc();
      expect.fail("Should have thrown Unauthorized");
    } catch (err: any) {
      expect(err.error?.errorCode?.code || err.message).to.include(
        "Unauthorized"
      );
    }

    // New pauser can unpause.
    await program.methods
      .unpause()
      .accountsPartial({
        pauser: newPauser.publicKey,
        protocolConfig,
      })
      .signers([newPauser])
      .rpc();

    // Restore pauser for later suites.
    await program.methods
      .setPauser(pauserKeypair.publicKey)
      .accountsPartial({
        defaultAdmin: provider.wallet.publicKey,
        protocolConfig,
      })
      .rpc();

    const config = await program.account.protocolConfig.fetch(protocolConfig);
    expect(config.pauser.toBase58()).to.equal(
      pauserKeypair.publicKey.toBase58()
    );
    expect(config.paused).to.equal(false);
  });

  it("5.6 Reject set_pauser by non-admin", async () => {
    const randomSigner = await generateFundedKeypair();

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
  });

  it("5.7 Reject set_default_admin_delay_seconds by non-admin", async () => {
    const randomSigner = await generateFundedKeypair();

    try {
      await program.methods
        .setDefaultAdminDelaySeconds(60)
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
  });

  it("5.8 Reject begin_default_admin_transfer by non-admin", async () => {
    const randomSigner = await generateFundedKeypair();

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
  });
});
