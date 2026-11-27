#!/usr/bin/env ts-node

/**
 * Transfer SOL from one account to another.
 *
 * Usage:
 *   npx ts-node scripts/transfer-sol.ts --keypair <sender.json> --to <pubkey> --amount <sol>
 */

import fs from "node:fs";
import path from "node:path";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

function loadKeypair(filePath: string): Keypair {
  const resolved = path.resolve(filePath);
  const data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(data));
}

function parseArgs(): { rpcUrl: string; keypairPath: string; to: string; amount: number } {
  const args = process.argv.slice(2);
  let rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.testnet.solana.com";
  let keypairPath = "";
  let to = "";
  let amount = 0;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc" && args[i + 1]) { rpcUrl = args[++i]!; }
    else if (args[i] === "--keypair" && args[i + 1]) { keypairPath = args[++i]!; }
    else if (args[i] === "--to" && args[i + 1]) { to = args[++i]!; }
    else if (args[i] === "--amount" && args[i + 1]) { amount = parseFloat(args[++i]!); }
  }

  if (!keypairPath) throw new Error("--keypair <path> is required");
  if (!to) throw new Error("--to <pubkey> is required");
  if (!amount || amount <= 0) throw new Error("--amount <sol> must be positive");

  return { rpcUrl, keypairPath, to, amount };
}

async function main(): Promise<void> {
  const { rpcUrl, keypairPath, to, amount } = parseArgs();
  const sender = loadKeypair(keypairPath);
  const recipient = new PublicKey(to);
  const lamports = Math.round(amount * LAMPORTS_PER_SOL);
  const connection = new Connection(rpcUrl, "confirmed");

  console.log(`Transfer SOL`);
  console.log(`  From:   ${sender.publicKey.toBase58()}`);
  console.log(`  To:     ${recipient.toBase58()}`);
  console.log(`  Amount: ${amount} SOL (${lamports} lamports)`);
  console.log(`  RPC:    ${rpcUrl}`);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: sender.publicKey,
      toPubkey: recipient,
      lamports,
    })
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [sender]);
  console.log(`\n  Transaction: ${sig}`);
  console.log("  Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
