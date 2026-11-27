#!/usr/bin/env ts-node

/**
 * FulfillmentProxy: Full key rotation — transfers all roles from old admin to new admin.
 *
 * Steps:
 *   1. set_pauser(new)                   — signed by old admin
 *   2. begin_default_admin_transfer(new) — signed by old admin
 *   3. accept_default_admin_transfer()   — signed by new admin
 *
 * Usage:
 *   npx ts-node scripts/fp-rotate-all-roles.ts \
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
function makeProgram(
  connection: Connection,
  keypair: Keypair,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  idl: any
): Program<any> {
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(idl as any, provider);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readState(
  program: Program<any>,
  protocolConfig: PublicKey
): Promise<void> {
  const config = await fetchProtocolConfig(
    program,
    protocolConfig,
    "Fulfillment Proxy"
  );
  console.log(`    default_admin:          ${config.defaultAdmin.toBase58()}`);
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

  const fpInfo = await loadVerifiedProgramInfo({
    connection,
    rpcUrl,
    repoRoot: REPO_ROOT,
    programName: "fulfillment_proxy",
  });
  const protocolConfig = fpInfo.protocolConfig;

  console.log("FulfillmentProxy: Full Role Rotation");
  console.log(`  Old admin: ${oldAdmin.publicKey.toBase58()}`);
  console.log(`  New admin: ${newAdmin.publicKey.toBase58()}`);
  console.log(`  Program:   ${fpInfo.programId.toBase58()}`);
  console.log(`  Config:    ${protocolConfig.toBase58()}`);
  console.log(`  RPC:       ${rpcUrl}`);
  console.log();

  const oldProgram = makeProgram(connection, oldAdmin, fpInfo.idl);
  const newProgram = makeProgram(connection, newAdmin, fpInfo.idl);

  const initialState = await fetchProtocolConfig(
    oldProgram,
    protocolConfig,
    fpInfo.label
  );
  if (!initialState.defaultAdmin.equals(oldAdmin.publicKey)) {
    throw new Error(
      `Old admin ${oldAdmin.publicKey.toBase58()} is not live default_admin ${initialState.defaultAdmin.toBase58()}`
    );
  }

  // Step 1: set_pauser
  console.log("[1/3] set_pauser...");
  const tx1 = await oldProgram.methods
    .setPauser(newAdmin.publicKey)
    .accountsPartial({ defaultAdmin: oldAdmin.publicKey, protocolConfig })
    .rpc();
  console.log(`  tx: ${tx1}`);
  await readState(oldProgram, protocolConfig);
  console.log();

  // Step 2: begin_default_admin_transfer
  console.log("[2/3] begin_default_admin_transfer...");
  const tx2 = await oldProgram.methods
    .beginDefaultAdminTransfer(newAdmin.publicKey)
    .accountsPartial({ defaultAdmin: oldAdmin.publicKey, protocolConfig })
    .rpc();
  console.log(`  tx: ${tx2}`);
  await readState(oldProgram, protocolConfig);
  console.log();

  // Step 3: accept_default_admin_transfer
  console.log("[3/3] accept_default_admin_transfer...");
  const tx3 = await newProgram.methods
    .acceptDefaultAdminTransfer()
    .accountsPartial({ pendingAdmin: newAdmin.publicKey, protocolConfig })
    .rpc();
  console.log(`  tx: ${tx3}`);
  await readState(newProgram, protocolConfig);
  console.log();

  console.log("FulfillmentProxy key rotation complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
