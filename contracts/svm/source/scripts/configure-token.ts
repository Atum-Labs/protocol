#!/usr/bin/env ts-node

/**
 * Escrow: Allowlist a token mint and set its fee configuration.
 *
 * If the mint is already allowlisted, skips allowMint and only updates fees.
 *
 * Usage:
 *   npx ts-node scripts/configure-token.ts \
 *     --keypair <path-to-token-config-authority.json> \
 *     --mint <mint-address> \
 *     --fee-percentage <fee_percentage_6> \
 *     --min-fee <min_fee_6> \
 *     --max-fee <max_fee_6> \
 *     [--rpc <url>]
 *
 * Fee parameters (all in 6-decimal scale):
 *   --fee-percentage   Fee rate where 100_000_000 = 100%. E.g. 20000 = 2 BIPs (0.02%)
 *   --min-fee          Minimum fee floor in 6-decimal units. E.g. 1_000_000 = 1 token
 *   --max-fee          Maximum fee cap in 6-decimal units. E.g. 250_000_000 = 250 tokens. 0 = uncapped
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import {
  fetchProtocolConfig,
  loadVerifiedProgramInfo,
} from "./solana-admin-utils.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

interface Args {
  rpcUrl: string;
  keypairPath: string;
  mint: string;
  feePercentage6: number;
  minFee6: number;
  maxFee6: number;
}

function loadKeypair(filePath: string): Keypair {
  const resolved = path.resolve(filePath);
  const data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(data));
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  let keypairPath = "";
  let mint = "";
  let feePercentage6 = -1;
  let minFee6 = -1;
  let maxFee6 = -1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc" && args[i + 1]) {
      rpcUrl = args[++i]!;
    } else if (args[i] === "--keypair" && args[i + 1]) {
      keypairPath = args[++i]!;
    } else if (args[i] === "--mint" && args[i + 1]) {
      mint = args[++i]!;
    } else if (args[i] === "--fee-percentage" && args[i + 1]) {
      feePercentage6 = parseInt(args[++i]!, 10);
    } else if (args[i] === "--min-fee" && args[i + 1]) {
      minFee6 = parseInt(args[++i]!, 10);
    } else if (args[i] === "--max-fee" && args[i + 1]) {
      maxFee6 = parseInt(args[++i]!, 10);
    }
  }

  if (!keypairPath) throw new Error("--keypair <path> is required");
  if (!mint) throw new Error("--mint <address> is required");
  if (feePercentage6 < 0)
    throw new Error("--fee-percentage <value> is required");
  if (minFee6 < 0) throw new Error("--min-fee <value> is required");
  if (maxFee6 < 0) throw new Error("--max-fee <value> is required");

  return { rpcUrl, keypairPath, mint, feePercentage6, minFee6, maxFee6 };
}

async function main(): Promise<void> {
  const { rpcUrl, keypairPath, mint, feePercentage6, minFee6, maxFee6 } =
    parseArgs();
  const authority = loadKeypair(keypairPath);
  const mintPubkey = new PublicKey(mint);
  const wsEndpoint = process.env.SOLANA_WS_URL;
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    ...(wsEndpoint ? { wsEndpoint } : {}),
  });

  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const escrowInfo = await loadVerifiedProgramInfo({
    connection,
    rpcUrl,
    repoRoot: REPO_ROOT,
    programName: "escrow",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(escrowInfo.idl as any, provider);

  const protocolConfig = escrowInfo.protocolConfig;
  const [mintFeeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_fee_config"), mintPubkey.toBuffer()],
    escrowInfo.programId
  );

  console.log("Escrow: Configure Token");
  console.log(`  Authority:       ${authority.publicKey.toBase58()}`);
  console.log(`  Mint:            ${mintPubkey.toBase58()}`);
  console.log(`  Program:         ${escrowInfo.programId.toBase58()}`);
  console.log(`  ProtocolConfig:  ${protocolConfig.toBase58()}`);
  console.log(`  fee_percentage_6: ${feePercentage6}`);
  console.log(`  min_fee_6:        ${minFee6}`);
  console.log(`  max_fee_6:        ${maxFee6}`);
  console.log(`  RPC:             ${rpcUrl}`);
  console.log();

  const protocolState = await fetchProtocolConfig(
    program,
    protocolConfig,
    escrowInfo.label
  );
  if (!protocolState.tokenConfigAuthority.equals(authority.publicKey)) {
    throw new Error(
      `Signer ${authority.publicKey.toBase58()} is not live token_config_authority ${protocolState.tokenConfigAuthority.toBase58()}`
    );
  }

  // Step 1: Allowlist (skip if already exists)
  const existing = await connection.getAccountInfo(mintFeeConfig);
  if (existing === null) {
    console.log("[1/2] Allowlisting mint...");
    const tx = await program.methods
      .allowMint()
      .accountsPartial({
        tokenConfigAuthority: authority.publicKey,
        protocolConfig,
        mintAccount: mintPubkey,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  tx: ${tx}`);
  } else {
    console.log("[1/2] Mint already allowlisted, skipping.");
  }

  // Step 2: Set fee config
  console.log("[2/2] Setting fee config...");
  const tx = await program.methods
    .setMintFeeConfig(new BN(feePercentage6), new BN(minFee6), new BN(maxFee6))
    .accountsPartial({
      tokenConfigAuthority: authority.publicKey,
      protocolConfig,
      mintAccount: mintPubkey,
      mintFeeConfig,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log(`  tx: ${tx}`);

  // Verify
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config = await (program.account as any).mintFeeConfig.fetch(
    mintFeeConfig
  );
  console.log("\nVerification:");
  console.log(`  mint:             ${config.mint.toBase58()}`);
  console.log(`  fee_percentage_6: ${config.feePercentage6.toString()}`);
  console.log(`  min_fee_6:        ${config.minFee6.toString()}`);
  console.log(`  max_fee_6:        ${config.maxFee6.toString()}`);
  console.log("\nDone.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
