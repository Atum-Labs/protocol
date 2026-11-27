#!/usr/bin/env ts-node

/**
 * Reads and displays the onchain ProtocolConfig state for both
 * Escrow and FulfillmentProxy programs.
 *
 * Usage:
 *   npx ts-node scripts/read-state.ts [--rpc <url>]
 *
 * Defaults to SOLANA_RPC_URL env var, then https://api.testnet.solana.com
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import {
  fetchProtocolConfig,
  formatNullablePubkey,
  loadVerifiedProgramInfo,
} from "./solana-admin-utils.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs(): { rpcUrl: string } {
  const args = process.argv.slice(2);
  let rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.testnet.solana.com";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc" && args[i + 1]) {
      rpcUrl = args[i + 1]!;
      i++;
    }
  }

  return { rpcUrl };
}

async function main(): Promise<void> {
  const { rpcUrl } = parseArgs();
  const connection = new Connection(rpcUrl, "confirmed");

  // Anchor needs a wallet even for reads — use a dummy
  const dummyWallet = new anchor.Wallet(Keypair.generate());

  console.log(`RPC: ${rpcUrl}\n`);

  // --- Escrow ---
  const escrowInfo = await loadVerifiedProgramInfo({
    connection,
    rpcUrl,
    repoRoot: REPO_ROOT,
    programName: "escrow",
  });
  const escrowProvider = new anchor.AnchorProvider(connection, dummyWallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const escrowProgram = new Program(escrowInfo.idl as any, escrowProvider);

  console.log("=== ESCROW ===");
  console.log(`Cluster:        ${escrowInfo.cluster}`);
  console.log(`Program:        ${escrowInfo.programId.toBase58()}`);
  console.log(`ProtocolConfig: ${escrowInfo.protocolConfig.toBase58()}`);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const escrowConfig = await fetchProtocolConfig(
      escrowProgram,
      escrowInfo.protocolConfig,
      escrowInfo.label
    );
    console.log(
      `  default_admin:          ${escrowConfig.defaultAdmin.toBase58()}`
    );
    console.log(
      `  token_config_authority: ${escrowConfig.tokenConfigAuthority.toBase58()}`
    );
    console.log(
      `  treasurer:              ${escrowConfig.treasurer.toBase58()}`
    );
    console.log(`  pauser:                 ${escrowConfig.pauser.toBase58()}`);
    console.log(`  paused:                 ${escrowConfig.paused}`);
    console.log(
      `  admin_delay_seconds:    ${escrowConfig.defaultAdminDelaySeconds}`
    );
    console.log(
      `  pending_default_admin:  ${formatNullablePubkey(
        escrowConfig.pendingDefaultAdmin
      )}`
    );
    console.log(
      `  pending_accept_after:   ${formatNullablePubkey(
        escrowConfig.pendingDefaultAdminAcceptAfterTs
      )}`
    );
  } catch (e: unknown) {
    console.log(`  ERROR: ${e instanceof Error ? e.message : e}`);
  }

  // --- Fulfillment Proxy ---
  const fpInfo = await loadVerifiedProgramInfo({
    connection,
    rpcUrl,
    repoRoot: REPO_ROOT,
    programName: "fulfillment_proxy",
  });
  const fpProvider = new anchor.AnchorProvider(connection, dummyWallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fpProgram = new Program(fpInfo.idl as any, fpProvider);

  console.log(`\n=== FULFILLMENT PROXY ===`);
  console.log(`Cluster:        ${fpInfo.cluster}`);
  console.log(`Program:        ${fpInfo.programId.toBase58()}`);
  console.log(`ProtocolConfig: ${fpInfo.protocolConfig.toBase58()}`);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fpConfig = await fetchProtocolConfig(
      fpProgram,
      fpInfo.protocolConfig,
      fpInfo.label
    );
    console.log(
      `  default_admin:          ${fpConfig.defaultAdmin.toBase58()}`
    );
    console.log(`  pauser:                 ${fpConfig.pauser.toBase58()}`);
    console.log(`  paused:                 ${fpConfig.paused}`);
    console.log(
      `  admin_delay_seconds:    ${fpConfig.defaultAdminDelaySeconds}`
    );
    console.log(
      `  pending_default_admin:  ${formatNullablePubkey(
        fpConfig.pendingDefaultAdmin
      )}`
    );
    console.log(
      `  pending_accept_after:   ${formatNullablePubkey(
        fpConfig.pendingDefaultAdminAcceptAfterTs
      )}`
    );
  } catch (e: unknown) {
    console.log(`  ERROR: ${e instanceof Error ? e.message : e}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
