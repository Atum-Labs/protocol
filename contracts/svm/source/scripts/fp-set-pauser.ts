#!/usr/bin/env ts-node

/**
 * FulfillmentProxy: Set a new pauser address.
 *
 * Usage:
 *   npx ts-node scripts/fp-set-pauser.ts --keypair <path-to-admin.json> --new-pauser <pubkey> [--rpc <url>]
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
  newPauser: string;
} {
  const args = process.argv.slice(2);
  let rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.testnet.solana.com";
  let keypairPath = "";
  let newPauser = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc" && args[i + 1]) {
      rpcUrl = args[++i]!;
    } else if (args[i] === "--keypair" && args[i + 1]) {
      keypairPath = args[++i]!;
    } else if (args[i] === "--new-pauser" && args[i + 1]) {
      newPauser = args[++i]!;
    }
  }

  if (!keypairPath) throw new Error("--keypair <path> is required");
  if (!newPauser) throw new Error("--new-pauser <pubkey> is required");

  return { rpcUrl, keypairPath, newPauser };
}

async function main(): Promise<void> {
  const { rpcUrl, keypairPath, newPauser } = parseArgs();
  const adminKeypair = loadKeypair(keypairPath);
  const newPauserPubkey = new PublicKey(newPauser);
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

  console.log("FulfillmentProxy: set_pauser");
  console.log(`  Admin signer:  ${adminKeypair.publicKey.toBase58()}`);
  console.log(`  New pauser:    ${newPauserPubkey.toBase58()}`);
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
    .setPauser(newPauserPubkey)
    .accountsPartial({
      defaultAdmin: adminKeypair.publicKey,
      protocolConfig,
    })
    .rpc();

  console.log(`\n  Transaction: ${tx}`);
  console.log("  Done. Run read-state.ts to verify pauser has changed.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
