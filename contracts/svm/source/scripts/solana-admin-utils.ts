import fs from "node:fs";
import path from "node:path";

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

export type SolanaProgramName = "escrow" | "fulfillment_proxy";

const PROGRAM_LABELS: Record<SolanaProgramName, string> = {
  escrow: "Escrow",
  fulfillment_proxy: "Fulfillment Proxy",
};

const KNOWN_GENESIS_CLUSTERS: Record<string, string> = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

export type VerifiedProgramInfo = {
  cluster: string;
  label: string;
  programId: PublicKey;
  protocolConfig: PublicKey;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  idl: any;
  // The IDL stored with the deployed program, which describes what the live program accepts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onchainIdl: any;
};

function inferClusterHintFromRpcUrl(rpcUrl: string): string | null {
  const lower = rpcUrl.toLowerCase();
  if (lower.includes("mainnet")) return "mainnet";
  if (lower.includes("testnet")) return "testnet";
  if (lower.includes("devnet")) return "devnet";
  if (
    lower.includes("localnet") ||
    lower.includes("localhost") ||
    lower.includes("127.0.0.1") ||
    lower.includes("0.0.0.0")
  ) {
    return "localnet";
  }
  return null;
}

export async function resolveAnchorCluster(
  connection: Connection,
  rpcUrl: string
): Promise<string> {
  const urlHint = inferClusterHintFromRpcUrl(rpcUrl);
  const genesisHash = await connection.getGenesisHash();
  const genesisCluster = KNOWN_GENESIS_CLUSTERS[genesisHash];

  if (genesisCluster) {
    if (urlHint && urlHint !== genesisCluster) {
      throw new Error(
        `RPC URL suggests ${urlHint}, but genesis hash ${genesisHash} is ${genesisCluster}. Aborting before selecting an Anchor.toml program ID.`
      );
    }
    return genesisCluster;
  }

  if (urlHint === "localnet") {
    return "localnet";
  }

  throw new Error(
    `Unknown Solana genesis hash ${genesisHash} for RPC URL ${rpcUrl}. Aborting before selecting an Anchor.toml program ID.`
  );
}

function readAnchorTomlProgramIds(
  repoRoot: string,
  cluster: string
): Record<string, string> {
  const anchorTomlPath = path.join(repoRoot, "Anchor.toml");
  const lines = fs.readFileSync(anchorTomlPath, "utf-8").split(/\r?\n/);
  const section = `[programs.${cluster}]`;
  const ids: Record<string, string> = {};
  let inSection = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      if (inSection) break;
      inSection = line === section;
      continue;
    }

    if (!inSection) continue;

    const match =
      line.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]+)"$/) ??
      line.match(
        /^([A-Za-z0-9_]+)\s*=\s*\{[^}]*address\s*=\s*"([^"]+)"[^}]*\}$/
      );
    if (match) {
      ids[match[1]!] = match[2]!;
    }
  }

  if (Object.keys(ids).length === 0) {
    throw new Error(`No ${section} program IDs found in ${anchorTomlPath}`);
  }

  return ids;
}

function readIdl(repoRoot: string, programName: SolanaProgramName): unknown {
  const idlPath = path.join(repoRoot, "target", "idl", `${programName}.json`);
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

function idlAddress(idl: unknown, source: string): string {
  if (typeof idl !== "object" || idl === null) {
    throw new Error(`${source} IDL is not an object`);
  }
  const maybeAddress = (idl as { address?: unknown }).address;
  if (typeof maybeAddress !== "string") {
    throw new Error(`${source} IDL is missing mandatory address field`);
  }
  return maybeAddress;
}

function idlName(idl: unknown): string | undefined {
  if (typeof idl !== "object" || idl === null) return undefined;
  const rootName = (idl as { name?: unknown }).name;
  if (typeof rootName === "string") return rootName;
  const metadata = (idl as { metadata?: { name?: unknown } }).metadata;
  return typeof metadata?.name === "string" ? metadata.name : undefined;
}

async function fetchOnchainIdl(
  connection: Connection,
  programId: PublicKey,
  programName: SolanaProgramName
): Promise<unknown> {
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(Keypair.generate()),
    { commitment: "finalized" }
  );
  const idl = await anchor.Program.fetchIdl(programId, provider);
  if (!idl) {
    throw new Error(
      `${
        PROGRAM_LABELS[programName]
      } on-chain IDL is not available for ${programId.toBase58()}`
    );
  }
  return idl;
}

export function getProtocolConfigAddress(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    programId
  );
  return pda;
}

export async function loadVerifiedProgramInfo(args: {
  connection: Connection;
  rpcUrl: string;
  repoRoot: string;
  programName: SolanaProgramName;
}): Promise<VerifiedProgramInfo> {
  const { connection, rpcUrl, repoRoot, programName } = args;
  const cluster = await resolveAnchorCluster(connection, rpcUrl);
  const ids = readAnchorTomlProgramIds(repoRoot, cluster);
  const configuredProgramId = ids[programName];

  if (!configuredProgramId) {
    throw new Error(
      `Missing ${programName} in Anchor.toml [programs.${cluster}]`
    );
  }

  const programId = new PublicKey(configuredProgramId);
  const idl = readIdl(repoRoot, programName);
  const configuredIdlAddress = idlAddress(
    idl,
    `${PROGRAM_LABELS[programName]} local`
  );
  if (configuredIdlAddress !== programId.toBase58()) {
    throw new Error(
      `${
        PROGRAM_LABELS[programName]
      } ID mismatch: Anchor.toml [programs.${cluster}] has ${programId.toBase58()}, but target IDL has ${configuredIdlAddress}`
    );
  }

  const localIdlName = idlName(idl);
  if (localIdlName && localIdlName !== programName) {
    throw new Error(
      `${PROGRAM_LABELS[programName]} local IDL name mismatch: expected ${programName}, got ${localIdlName}`
    );
  }

  const account = await connection.getAccountInfo(programId, "finalized");
  if (!account) {
    throw new Error(
      `${
        PROGRAM_LABELS[programName]
      } program ${programId.toBase58()} from Anchor.toml [programs.${cluster}] is not deployed on ${rpcUrl}`
    );
  }
  if (!account.executable) {
    throw new Error(
      `${
        PROGRAM_LABELS[programName]
      } program ${programId.toBase58()} from Anchor.toml [programs.${cluster}] exists on ${rpcUrl} but is not executable`
    );
  }

  const onchainIdl = await fetchOnchainIdl(connection, programId, programName);
  const onchainIdlAddress = idlAddress(
    onchainIdl,
    `${PROGRAM_LABELS[programName]} on-chain`
  );
  if (onchainIdlAddress !== programId.toBase58()) {
    throw new Error(
      `${
        PROGRAM_LABELS[programName]
      } on-chain IDL address ${onchainIdlAddress} does not match Anchor.toml [programs.${cluster}] ${programId.toBase58()}`
    );
  }

  const onchainIdlName = idlName(onchainIdl);
  if (onchainIdlName && onchainIdlName !== programName) {
    throw new Error(
      `${PROGRAM_LABELS[programName]} on-chain IDL name mismatch: expected ${programName}, got ${onchainIdlName}`
    );
  }

  return {
    cluster,
    label: PROGRAM_LABELS[programName],
    programId,
    protocolConfig: getProtocolConfigAddress(programId),
    idl,
    onchainIdl,
  };
}

export async function fetchProtocolConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any,
  protocolConfig: PublicKey,
  label: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  try {
    return await program.account.protocolConfig.fetch(
      protocolConfig,
      "finalized"
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read live ${label} ProtocolConfig ${protocolConfig.toBase58()}. Aborting before mutation. ${message}`
    );
  }
}

export function formatNullablePubkey(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (value instanceof PublicKey) return value.toBase58();
  if (
    typeof value === "object" &&
    "toBase58" in value &&
    typeof value.toBase58 === "function"
  ) {
    return value.toBase58();
  }
  return String(value);
}
