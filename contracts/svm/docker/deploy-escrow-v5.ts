// Deploys the v5 escrow beside v4 on the local validator. Runs after deploy-local.ts, which
// deployed v4, the fulfillment proxy and the mints and wrote deployment-addresses.json.
//
// The image copies this file into the v4 source's scripts/ so its imports resolve from that
// node_modules. It deploys ESCROW_V5_SO at ESCROW_V5_KEYPAIR, initializes its ProtocolConfig like
// deploy-local.ts does for v4 (cluster "localnet", same authority), allowlists the two local mints
// with the v4 fee config, and records the id as programs.escrowV5 in deployment-addresses.json.
// The v5 deployment shares the v4 fulfillment proxy, so nothing else is deployed.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_FILENAME = path.join(REPO_ROOT, "deployment-addresses.json");
// Keep equal to deploy-local.ts: the v5 program reports the same domain version.
const SIGNATURE_DOMAIN_VERSION = 5;
const CLUSTER_ID = "localnet";
const FEE_PERCENTAGE_6 = 20_000;
const MIN_FEE_6 = 1;
const MAX_FEE_6 = 0;

function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function readKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf-8"))));
}

function clusterIdBytes(): number[] {
  const bytes = Buffer.alloc(32);
  Buffer.from(CLUSTER_ID, "utf8").copy(bytes);
  return Array.from(bytes);
}

async function main(): Promise<void> {
  const rpcUrl = env("SOLANA_RPC_URL");
  const walletPath = env("ANCHOR_WALLET");
  const programKeypairPath = env("ESCROW_V5_KEYPAIR");
  const programBinaryPath = env("ESCROW_V5_SO");
  const idl = JSON.parse(fs.readFileSync(env("ESCROW_V5_IDL"), "utf-8"));

  const payer = readKeypair(walletPath);
  const programId = readKeypair(programKeypairPath).publicKey;
  if (idl.address !== programId.toBase58()) {
    throw new Error(`v5 IDL address ${idl.address} differs from the program keypair ${programId.toBase58()}`);
  }
  const connection = new Connection(rpcUrl, "confirmed");

  if ((await connection.getAccountInfo(programId, "confirmed")) === null) {
    console.log(`\n> solana program-v4 deploy escrow v5 ${programId.toBase58()}`);
    execFileSync(
      "solana",
      [
        "program-v4",
        "deploy",
        "--url",
        rpcUrl,
        "--keypair",
        walletPath,
        "--program-keypair",
        programKeypairPath,
        programBinaryPath,
      ],
      { stdio: "inherit" }
    );
    // A loader-v4 program is not callable in the slot it was deployed in.
    const deployedAt = await connection.getSlot("confirmed");
    while ((await connection.getSlot("confirmed")) <= deployedAt + 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl, provider);
  const [protocolConfig] = PublicKey.findProgramAddressSync([Buffer.from("protocol_config")], programId);

  if ((await connection.getAccountInfo(protocolConfig)) === null) {
    await program.methods
      .initializeProtocol(payer.publicKey, payer.publicKey, payer.publicKey, payer.publicKey, clusterIdBytes(), 0)
      .accountsPartial({
        authority: payer.publicKey,
        protocolConfig,
        program: programId,
        // Loader-v4 keeps the program data in the program account itself.
        programData: programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("Escrow v5 protocol config initialized.");
  }
  const config = await (program.account as any).protocolConfig.fetch(protocolConfig);
  if (config.signatureDomainVersion !== SIGNATURE_DOMAIN_VERSION) {
    throw new Error(
      `escrow v5 signature_domain_version ${config.signatureDomainVersion}, want ${SIGNATURE_DOMAIN_VERSION}`
    );
  }

  const artifact = JSON.parse(fs.readFileSync(ARTIFACT_FILENAME, "utf-8"));
  for (const mintAddr of [artifact.mints.usdc, artifact.mints.usdt] as string[]) {
    const mint = new PublicKey(mintAddr);
    const [mintFeeConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_fee_config"), mint.toBuffer()],
      programId
    );
    const accounts = {
      tokenConfigAuthority: payer.publicKey,
      protocolConfig,
      mintAccount: mint,
      mintFeeConfig,
      tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
    };
    if ((await connection.getAccountInfo(mintFeeConfig)) === null) {
      await program.methods
        // Classic SPL mints, which have no permanent delegate.
        .allowMint(PublicKey.default)
        .accountsPartial({ ...accounts, systemProgram: SystemProgram.programId })
        .rpc();
    }
    await program.methods
      .setMintFeeConfig(new BN(FEE_PERCENTAGE_6), new BN(MIN_FEE_6), new BN(MAX_FEE_6))
      .accountsPartial(accounts)
      .rpc();
    console.log(`  Mint ${mintAddr} allowlisted on escrow v5.`);
  }

  artifact.programs.escrowV5 = programId.toBase58();
  fs.writeFileSync(ARTIFACT_FILENAME, JSON.stringify(artifact, null, 2));
  console.log(`SOLANA_ESCROW_V5_PROGRAM_ID=${programId.toBase58()}`);
}

main().catch((error) => {
  console.error("Escrow v5 local deployment failed:", error);
  process.exit(1);
});
