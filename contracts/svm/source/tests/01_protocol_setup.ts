import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Escrow } from "../target/types/escrow";
import {
  expect,
  ESCROW_SIGNATURE_DOMAIN_VERSION,
  ESCROW_TEST_CLUSTER_ID,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  findProgramEvent,
  getProtocolConfigAddress,
  getProgramDataAddress,
  pauserKeypair,
  treasurerKeypair,
} from "./helpers";

describe("1. Protocol Setup", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Escrow as Program<Escrow>;

  const protocolConfig = getProtocolConfigAddress(program.programId);
  const programData = getProgramDataAddress(program.programId);

  describe("1.1 Reject initialize_protocol by non-upgrade authority", () => {
    it("should fail with Unauthorized error", async () => {
      const randomSigner = Keypair.generate();
      const sig = await provider.connection.requestAirdrop(
        randomSigner.publicKey,
        LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig);

      try {
        await program.methods
          .initializeProtocol(
            provider.wallet.publicKey,
            provider.wallet.publicKey,
            treasurerKeypair.publicKey,
            pauserKeypair.publicKey,
            Array.from(ESCROW_TEST_CLUSTER_ID),
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
  });

  describe("1.2 Initialize ProtocolConfig by upgrade authority", () => {
    it("should initialize with correct field values", async () => {
      const txSig = await program.methods
        .initializeProtocol(
          provider.wallet.publicKey, // default_admin
          provider.wallet.publicKey, // token_config_authority
          treasurerKeypair.publicKey, // treasurer
          pauserKeypair.publicKey, // pauser
          Array.from(ESCROW_TEST_CLUSTER_ID), // cluster_id
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
      const initEvent = await findProgramEvent<any>(
        program,
        txSig,
        "ProtocolInitialized"
      );

      expect(config.defaultAdmin.toString()).to.equal(
        provider.wallet.publicKey.toString()
      );
      expect(config.tokenConfigAuthority.toString()).to.equal(
        provider.wallet.publicKey.toString()
      );
      expect(config.treasurer.toString()).to.equal(
        treasurerKeypair.publicKey.toString()
      );
      expect(config.pauser.toString()).to.equal(
        pauserKeypair.publicKey.toString()
      );
      expect(config.paused).to.equal(false);
      expect(Buffer.from(config.clusterId).equals(ESCROW_TEST_CLUSTER_ID)).to.be
        .true;
      expect(config.signatureDomainVersion).to.equal(
        ESCROW_SIGNATURE_DOMAIN_VERSION
      );
      expect(config.defaultAdminDelaySeconds).to.equal(0);
      expect(config.pendingDefaultAdmin).to.be.null;
      expect(config.pendingDefaultAdminAcceptAfterTs).to.be.null;

      expect(Buffer.from(initEvent.clusterId).equals(ESCROW_TEST_CLUSTER_ID)).to
        .be.true;
      expect(initEvent.signatureDomainVersion).to.equal(
        ESCROW_SIGNATURE_DOMAIN_VERSION
      );
    });
  });

  describe("1.3 Reject duplicate initialization", () => {
    it("should fail when called again", async () => {
      try {
        await program.methods
          .initializeProtocol(
            provider.wallet.publicKey,
            provider.wallet.publicKey,
            treasurerKeypair.publicKey,
            pauserKeypair.publicKey,
            Array.from(ESCROW_TEST_CLUSTER_ID),
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

        expect.fail("Should have thrown");
      } catch (err: any) {
        // Custom AlreadyInitialized error
        expect(err.error?.errorCode?.code).to.equal("AlreadyInitialized");
      }
    });
  });
});
