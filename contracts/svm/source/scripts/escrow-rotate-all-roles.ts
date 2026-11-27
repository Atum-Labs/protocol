#!/usr/bin/env ts-node

/**
 * Escrow: Full key rotation — transfers all roles from old admin to new admin.
 *
 * Steps:
 *   1. set_token_config_authority(new)  — signed by old admin
 *   2. set_treasurer(new)              — signed by old admin
 *   3. set_pauser(new)                 — signed by old admin
 *   4. begin_default_admin_transfer(new) — signed by old admin
 *   5. accept_default_admin_transfer()   — signed by new admin
 *
 * Usage:
 *   npx ts-node scripts/escrow-rotate-all-roles.ts \
 *     --old-keypair <path-to-old-admin.json> \
 *     --new-keypair <path-to-new-admin.json> \
 *     [--rpc <url>]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  fetchProtocolConfig,
  formatNullablePubkey,
  loadVerifiedProgramInfo,
} from "./solana-admin-utils.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function loadKeypair(filePath: string): Keypair {
  const resolved = path.resolve(filePath);
  const data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(data));
}

function parseArgs(): {
  rpcUrl: string;
  oldKeypairPath: string;
  newKeypairPath: string;
} {
  const args = process.argv.slice(2);
  let rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.testnet.solana.com";
  let oldKeypairPath = "";
  let newKeypairPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc" && args[i + 1]) {
      rpcUrl = args[++i]!;
    } else if (args[i] === "--old-keypair" && args[i + 1]) {
      oldKeypairPath = args[++i]!;
    } else if (args[i] === "--new-keypair" && args[i + 1]) {
      newKeypairPath = args[++i]!;
    }
  }

  if (!oldKeypairPath) throw new Error("--old-keypair <path> is required");
  if (!newKeypairPath) throw new Error("--new-keypair <path> is required");

  return { rpcUrl, oldKeypairPath, newKeypairPath };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeProvider(
  connection: Connection,
  keypair: Keypair,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  idl: any
): { provider: anchor.AnchorProvider; program: Program<any> } {
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(idl as any, provider);
  return { provider, program };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readState(
  program: Program<any>,
  protocolConfig: PublicKey
): Promise<void> {
  const config = await fetchProtocolConfig(program, protocolConfig, "Escrow");
  console.log(`    default_admin:          ${config.defaultAdmin.toBase58()}`);
  console.log(
    `    token_config_authority: ${config.tokenConfigAuthority.toBase58()}`
  );
  console.log(`    treasurer:              ${config.treasurer.toBase58()}`);
  console.log(`    pauser:                 ${config.pauser.toBase58()}`);
  console.log(
    `    pending_default_admin:  ${formatNullablePubkey(
      config.pendingDefaultAdmin
    )}`
  );
}

async function main(): Promise<void> {
  const { rpcUrl, oldKeypairPath, newKeypairPath } = parseArgs();
  const oldAdmin = loadKeypair(oldKeypairPath);
  const newAdmin = loadKeypair(newKeypairPath);
  const connection = new Connection(rpcUrl, "confirmed");

  const escrowInfo = await loadVerifiedProgramInfo({
    connection,
    rpcUrl,
    repoRoot: REPO_ROOT,
    programName: "escrow",
  });
  const protocolConfig = escrowInfo.protocolConfig;

  console.log("Escrow: Full Role Rotation");
  console.log(`  Old admin: ${oldAdmin.publicKey.toBase58()}`);
  console.log(`  New admin: ${newAdmin.publicKey.toBase58()}`);
  console.log(`  Program:   ${escrowInfo.programId.toBase58()}`);
  console.log(`  Config:    ${protocolConfig.toBase58()}`);
  console.log(`  RPC:       ${rpcUrl}`);
  console.log();

  // Programs with different signers
  const { program: oldProgram } = makeProvider(
    connection,
    oldAdmin,
    escrowInfo.idl
  );
  const { program: newProgram } = makeProvider(
    connection,
    newAdmin,
    escrowInfo.idl
  );

  const initialState = await fetchProtocolConfig(
    oldProgram,
    protocolConfig,
    escrowInfo.label
  );
  if (!initialState.defaultAdmin.equals(oldAdmin.publicKey)) {
    throw new Error(
      `Old admin ${oldAdmin.publicKey.toBase58()} is not live default_admin ${initialState.defaultAdmin.toBase58()}`
    );
  }

  // Step 1: set_token_config_authority
  console.log("[1/5] set_token_config_authority...");
  const tx1 = await oldProgram.methods
    .setTokenConfigAuthority(newAdmin.publicKey)
    .accountsPartial({ defaultAdmin: oldAdmin.publicKey, protocolConfig })
    .rpc();
  console.log(`  tx: ${tx1}`);
  await readState(oldProgram, protocolConfig);
  console.log();

  // Step 2: set_treasurer
  console.log("[2/5] set_treasurer...");
  const tx2 = await oldProgram.methods
    .setTreasurer(newAdmin.publicKey)
    .accountsPartial({ defaultAdmin: oldAdmin.publicKey, protocolConfig })
    .rpc();
  console.log(`  tx: ${tx2}`);
  await readState(oldProgram, protocolConfig);
  console.log();

  // Step 3: set_pauser
  console.log("[3/5] set_pauser...");
  const tx3 = await oldProgram.methods
    .setPauser(newAdmin.publicKey)
    .accountsPartial({ defaultAdmin: oldAdmin.publicKey, protocolConfig })
    .rpc();
  console.log(`  tx: ${tx3}`);
  await readState(oldProgram, protocolConfig);
  console.log();

  // Step 4: begin_default_admin_transfer
  console.log("[4/5] begin_default_admin_transfer...");
  const tx4 = await oldProgram.methods
    .beginDefaultAdminTransfer(newAdmin.publicKey)
    .accountsPartial({ defaultAdmin: oldAdmin.publicKey, protocolConfig })
    .rpc();
  console.log(`  tx: ${tx4}`);
  await readState(oldProgram, protocolConfig);
  console.log();

  // Step 5: accept_default_admin_transfer
  console.log("[5/5] accept_default_admin_transfer...");
  const tx5 = await newProgram.methods
    .acceptDefaultAdminTransfer()
    .accountsPartial({ pendingAdmin: newAdmin.publicKey, protocolConfig })
    .rpc();
  console.log(`  tx: ${tx5}`);
  await readState(newProgram, protocolConfig);
  console.log();

  console.log("Escrow key rotation complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
