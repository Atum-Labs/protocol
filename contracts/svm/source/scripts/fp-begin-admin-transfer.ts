#!/usr/bin/env ts-node

/**
 * FulfillmentProxy: Begin default admin transfer.
 *
 * Usage:
 *   npx ts-node scripts/fp-begin-admin-transfer.ts --keypair <path-to-current-admin.json> --new-admin <pubkey> [--rpc <url>]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  fetchProtocolConfig,
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
  keypairPath: string;
  newAdmin: string;
} {
  const args = process.argv.slice(2);
  let rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.testnet.solana.com";
  let keypairPath = "";
  let newAdmin = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc" && args[i + 1]) {
      rpcUrl = args[++i]!;
    } else if (args[i] === "--keypair" && args[i + 1]) {
      keypairPath = args[++i]!;
    } else if (args[i] === "--new-admin" && args[i + 1]) {
      newAdmin = args[++i]!;
    }
  }

  if (!keypairPath) throw new Error("--keypair <path> is required");
  if (!newAdmin) throw new Error("--new-admin <pubkey> is required");

  return { rpcUrl, keypairPath, newAdmin };
}

async function main(): Promise<void> {
  const { rpcUrl, keypairPath, newAdmin } = parseArgs();
  const adminKeypair = loadKeypair(keypairPath);
  const newAdminPubkey = new PublicKey(newAdmin);
  const connection = new Connection(rpcUrl, "confirmed");

  const wallet = new anchor.Wallet(adminKeypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const fpInfo = await loadVerifiedProgramInfo({
    connection,
    rpcUrl,
    repoRoot: REPO_ROOT,
    programName: "fulfillment_proxy",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(fpInfo.idl as any, provider);

  const protocolConfig = fpInfo.protocolConfig;

  console.log("FulfillmentProxy: begin_default_admin_transfer");
  console.log(`  Current admin: ${adminKeypair.publicKey.toBase58()}`);
  console.log(`  New admin:     ${newAdminPubkey.toBase58()}`);
  console.log(`  Program:       ${fpInfo.programId.toBase58()}`);
  console.log(`  ProtocolConfig:${protocolConfig.toBase58()}`);
  console.log(`  RPC:           ${rpcUrl}`);

  const state = await fetchProtocolConfig(
    program,
    protocolConfig,
    fpInfo.label
  );
  if (!state.defaultAdmin.equals(adminKeypair.publicKey)) {
    throw new Error(
      `Signer ${adminKeypair.publicKey.toBase58()} is not live default_admin ${state.defaultAdmin.toBase58()}`
    );
  }

  const tx = await program.methods
    .beginDefaultAdminTransfer(newAdminPubkey)
    .accountsPartial({
      defaultAdmin: adminKeypair.publicKey,
      protocolConfig,
    })
    .rpc();

  console.log(`\n  Transaction: ${tx}`);
  console.log(
    "  Done. Run read-state.ts to verify pending_default_admin is set."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
