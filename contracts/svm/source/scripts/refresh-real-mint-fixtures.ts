#!/usr/bin/env ts-node

/**
 * Refreshes the real mint fixtures that suite 15 (tests/15_real_token_compat.ts) loads into the
 * local validator through the [[test.validator.account]] blocks in Anchor.toml.
 *
 * For every row of tests/fixtures/real-mints/manifest.json it fetches the live mint, refuses to
 * write a fixture that no longer matches the row (owner, decimals, exact extension set, permanent
 * delegate, a set transfer hook program, a non-zero older or newer transfer fee), then rewrites ONLY the
 * mint_authority COption (bytes 0..36) to the fixture authority so the tests can mint. Everything
 * else (supply, freeze authority, every extension) stays byte-identical to the chain.
 *
 * Usage:
 *   pnpm fixtures:real-mints [--mainnet-rpc <url>] [--devnet-rpc <url>] [--only <name,...>]
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getExtensionTypes,
  getPermanentDelegate,
  getTransferFeeConfig,
  getTransferHook,
  unpackMint,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.resolve(
  __dirname,
  "..",
  "tests",
  "fixtures",
  "real-mints"
);

// Same derivation as tests/15_real_token_compat.ts. Public by construction: it only signs on the
// local validator, where the patched fixture makes it the mint authority.
const FIXTURE_MINT_AUTHORITY = Keypair.fromSeed(
  createHash("sha256").update("atum-real-mint-fixture-authority").digest()
);

interface RealMintRow {
  name: string;
  cluster: "mainnet-beta" | "devnet";
  mint: string;
  tokenProgram: "spl" | "token2022";
  decimals: number;
  extensions: number[];
  // The live permanent delegate, null when the mint has none or it was cleared.
  permanentDelegate: string | null;
  expectAllowMint: string;
}

function parseArgs(): {
  urls: Record<RealMintRow["cluster"], string>;
  only: string[] | null;
} {
  const args = process.argv.slice(2);
  const urls = {
    "mainnet-beta": "https://api.mainnet-beta.solana.com",
    devnet: "https://api.devnet.solana.com",
  };
  let only: string[] | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mainnet-rpc" && args[i + 1])
      urls["mainnet-beta"] = args[++i]!;
    else if (args[i] === "--devnet-rpc" && args[i + 1])
      urls.devnet = args[++i]!;
    else if (args[i] === "--only" && args[i + 1])
      only = args[++i]!.split(",").map((name) => name.trim());
  }
  return { urls, only };
}

async function refreshRow(
  row: RealMintRow,
  connection: Connection
): Promise<void> {
  const mint = new PublicKey(row.mint);
  const programId =
    row.tokenProgram === "token2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  const info = await connection.getAccountInfo(mint);
  if (!info)
    throw new Error(`${row.name}: ${row.mint} not found on ${row.cluster}`);
  if (!info.owner.equals(programId)) {
    throw new Error(
      `${row.name}: owner ${info.owner.toBase58()}, manifest says ${
        row.tokenProgram
      }`
    );
  }

  const parsed = unpackMint(mint, info, programId);
  if (parsed.decimals !== row.decimals) {
    throw new Error(
      `${row.name}: decimals ${parsed.decimals}, manifest says ${row.decimals}`
    );
  }

  const extensions = [...getExtensionTypes(parsed.tlvData)].sort(
    (a, b) => a - b
  );
  if (JSON.stringify(extensions) !== JSON.stringify(row.extensions)) {
    throw new Error(
      `${row.name}: extensions ${JSON.stringify(
        extensions
      )}, manifest says ${JSON.stringify(row.extensions)}`
    );
  }

  // A changed delegate is a re-review, not a refresh: the suite pins the manifest key.
  const delegate = getPermanentDelegate(parsed)?.delegate.toBase58() ?? null;
  const liveDelegate =
    delegate === PublicKey.default.toBase58() ? null : delegate;
  if (liveDelegate !== row.permanentDelegate) {
    throw new Error(
      `${row.name}: permanent delegate ${liveDelegate}, manifest says ${row.permanentDelegate}`
    );
  }

  const hook = getTransferHook(parsed);
  if (hook && !hook.programId.equals(PublicKey.default)) {
    throw new Error(
      `${row.name}: transfer hook program set to ${hook.programId.toBase58()}`
    );
  }

  const fee = getTransferFeeConfig(parsed);
  if (fee) {
    for (const [slot, f] of [
      ["older", fee.olderTransferFee],
      ["newer", fee.newerTransferFee],
    ] as const) {
      if (f.transferFeeBasisPoints !== 0 || f.maximumFee !== 0n) {
        throw new Error(
          `${row.name}: ${slot} transfer fee ${f.transferFeeBasisPoints} bps / max ${f.maximumFee}`
        );
      }
    }
  }
  if (extensions.includes(ExtensionType.TransferFeeConfig) !== Boolean(fee)) {
    throw new Error(`${row.name}: TransferFeeConfig listed but not readable`);
  }

  const data = Buffer.from(info.data);
  data.writeUInt32LE(1, 0);
  FIXTURE_MINT_AUTHORITY.publicKey.toBuffer().copy(data, 4);

  const fixture = {
    pubkey: row.mint,
    account: {
      lamports: info.lamports,
      data: [data.toString("base64"), "base64"],
      owner: info.owner.toBase58(),
      executable: false,
      // Mainnet stores u64::MAX here, which JSON.parse rounds to a value the validator rejects.
      rentEpoch: 0,
      space: data.length,
    },
  };
  writeFileSync(
    path.join(FIXTURES_DIR, `${row.name}.json`),
    JSON.stringify(fixture, null, 2) + "\n"
  );

  console.log(
    `${row.name}: wrote ${data.length} bytes (original mint authority ${
      parsed.mintAuthority?.toBase58() ?? "none"
    }, supply ${parsed.supply})`
  );
}

async function main(): Promise<void> {
  const { urls, only } = parseArgs();
  const rows = JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, "manifest.json"), "utf8")
  ) as RealMintRow[];

  const unknown = (only ?? []).filter(
    (name) => !rows.some((row) => row.name === name)
  );
  if (unknown.length) {
    throw new Error(`--only names no manifest row: ${unknown.join(", ")}`);
  }
  for (const row of rows) {
    if (only && !only.includes(row.name)) continue;
    await refreshRow(row, new Connection(urls[row.cluster], "confirmed"));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
