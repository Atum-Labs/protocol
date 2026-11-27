#!/usr/bin/env ts-node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import type { Escrow } from "../target/types/escrow";
import type { FulfillmentProxy } from "../target/types/fulfillment_proxy";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const ARTIFACT_FILENAME = path.join(REPO_ROOT, "deployment-addresses.json");
const KEYPAIR_DIRECTORY = path.join(REPO_ROOT, ".keys");
const LOADER_V4_PROGRAM_ID = new PublicKey(
  "LoaderV411111111111111111111111111111111111"
);
const UPGRADEABLE_LOADER_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

type LocalnetProgramIds = {
  escrow?: string;
  fulfillmentProxy?: string;
  mockTransferHook?: string;
};

const DEPLOYED_PROGRAMS = [
  { key: "escrow", fileBase: "escrow" },
  { key: "fulfillmentProxy", fileBase: "fulfillment_proxy" },
  { key: "mockTransferHook", fileBase: "mock_transfer_hook" },
] as const;
// Must match the on-chain ProtocolConfig::CURRENT_SIGNATURE_DOMAIN_VERSION, which
// initialize_protocol hardcodes (the passed value is ignored, so this is only ever
// compared against what the chain reports -- never what gets written).
//
// v3 bound quote_hash into the reserve/release/refund preimages (CORE-2118); v4 adds
// keccak256(destination) to the deposit preimage (CORE-2120).
//
// NOTE: this is the third place the version is written down, after
// programs/escrow/src/state.rs and the Go/TS encoders. Deriving it from the IDL would
// remove the drift -- see the comment in deploy-local.ts.
const ESCROW_SIGNATURE_DOMAIN_VERSION = 5;
const ESCROW_LOCAL_CLUSTER_ID = fixedSizeUtf8Bytes("localnet", 32);

async function main(): Promise<void> {
  const rpcUrl =
    process.env.SOLANA_RPC_URL ??
    process.env.ANCHOR_PROVIDER_URL ??
    "http://127.0.0.1:8899";
  const anchorWalletPath = resolveAnchorWalletPath();
  const payer = readWalletKeypair(anchorWalletPath);

  if (process.env.SOLANA_PRIVATE_KEY || process.env.LOCAL_SOLANA_PRIVATE_KEY) {
    console.warn(
      `Ignoring SOLANA_PRIVATE_KEY/LOCAL_SOLANA_PRIVATE_KEY for deploy-local; using Anchor wallet ${anchorWalletPath}.`
    );
  }

  const anchorEnv = {
    ...process.env,
    ANCHOR_WALLET: anchorWalletPath,
    ANCHOR_PROVIDER_URL: rpcUrl,
    SOLANA_URL: rpcUrl,
  };

  const connection = new Connection(rpcUrl, "confirmed");
  await ensurePayerBalance(connection, payer);

  const hasCanonicalKeys =
    fs.existsSync(KEYPAIR_DIRECTORY) &&
    DEPLOYED_PROGRAMS.some((p) =>
      fs.existsSync(path.join(KEYPAIR_DIRECTORY, `${p.fileBase}-keypair.json`))
    );

  let programIds: LocalnetProgramIds;
  if (hasCanonicalKeys) {
    // Local dev / mainnet-aligned path: deploy at canonical addresses using
    // the keypairs in .keys/.
    programIds = readProgramIds();
    ensureCanonicalProgramKeypairs(programIds);
    runCommand("anchor", ["build"], anchorEnv, "anchor build");
    ensureCanonicalProgramKeypairs(programIds);
    await deployProgramsV4(
      connection,
      anchorEnv,
      rpcUrl,
      anchorWalletPath,
      programIds
    );
  } else {
    // Fresh deploy path (CI / first run): generate keypairs, sync Anchor.toml
    // and source declare_id!() macros, then deploy. Mainnet/devnet/testnet
    // entries in Anchor.toml are not touched.
    console.log(
      "\nNo canonical keypairs found in .keys/ — running fresh deploy."
    );
    patchAnchorTomlCluster("localnet");
    runCommand("anchor", ["build"], anchorEnv, "anchor build");
    runCommand("anchor", ["keys", "sync"], anchorEnv, "anchor keys sync");
    runCommand("anchor", ["build"], anchorEnv, "anchor build (post keys sync)");
    programIds = readProgramIds();
    await deployProgramsV4(
      connection,
      anchorEnv,
      rpcUrl,
      anchorWalletPath,
      programIds
    );
  }

  if (!programIds.escrow || !programIds.fulfillmentProxy) {
    throw new Error(
      "Failed to determine program IDs from Anchor.toml after deployment"
    );
  }

  // Initialize protocol configs for both programs
  await initializeProtocols(connection, payer, programIds);

  const { mints, accounts } = await deployMockTokens(connection, payer);

  // Allowlist mints on the escrow program
  await allowMints(connection, payer, programIds.escrow, [
    mints.usdc,
    mints.usdt,
  ]);

  const artifact = {
    programs: programIds,
    protocolSettings: {
      escrow: {
        clusterIdUtf8: decodeFixedSizeUtf8Bytes(ESCROW_LOCAL_CLUSTER_ID),
        clusterIdHex: Buffer.from(ESCROW_LOCAL_CLUSTER_ID).toString("hex"),
        signatureDomainVersion: ESCROW_SIGNATURE_DOMAIN_VERSION,
      },
    },
    mints,
    accounts,
  };

  fs.writeFileSync(ARTIFACT_FILENAME, JSON.stringify(artifact, null, 2));

  console.log("\nLocal Solana deployment complete.");
  console.log("---------------------------------------");
  console.log(`SOLANA_ESCROW_PROGRAM_ID=${programIds.escrow}`);
  console.log(
    `SOLANA_FULFILLMENT_PROXY_PROGRAM_ID=${programIds.fulfillmentProxy}`
  );
  console.log(`SOLANA_USDC_MINT=${mints.usdc}`);
  console.log(`SOLANA_USDT_MINT=${mints.usdt}`);
  console.log("---------------------------------------");
  console.log(`Deployment artifacts written to: ${ARTIFACT_FILENAME}`);
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string
): void {
  console.log(`\n> ${label}`);
  // execFileSync, not execSync on an interpolated string: the command and args come from the
  // environment, and a shell would treat metacharacters in them as syntax. Passing argv directly means
  // there is no shell to inject into, which is the actual fix rather than quoting harder.
  execFileSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env,
  });
}

function resolveAnchorWalletPath(): string {
  const explicit = process.env.ANCHOR_WALLET?.trim();
  if (explicit) {
    return explicit.replace("~", process.env.HOME ?? "");
  }

  const anchorTomlPath = path.join(REPO_ROOT, "Anchor.toml");
  const anchorToml = fs.readFileSync(anchorTomlPath, "utf-8");
  const walletMatch = anchorToml.match(/wallet\s*=\s*"([^"]+)"/);
  if (walletMatch?.[1]) {
    return walletMatch[1].replace("~", process.env.HOME ?? "");
  }

  return path.join(process.env.HOME ?? "", ".config", "solana", "id.json");
}

function fixedSizeUtf8Bytes(value: string, length: number): Uint8Array {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length > length) {
    throw new Error(
      `ESCROW_CLUSTER_ID must be at most ${length} bytes, received ${encoded.length}`
    );
  }
  const bytes = Buffer.alloc(length);
  encoded.copy(bytes);
  return Uint8Array.from(bytes);
}

function decodeFixedSizeUtf8Bytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").replace(/\0+$/u, "");
}

function readWalletKeypair(walletPath: string): Keypair {
  const keyData = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(keyData));
}

function readProgramIds(): LocalnetProgramIds {
  const anchorTomlPath = path.join(REPO_ROOT, "Anchor.toml");
  const raw = fs.readFileSync(anchorTomlPath, "utf-8");

  const sectionMatch = raw.match(/\[programs\.localnet\]([\s\S]*?)(\n\[|\n$)/);
  if (!sectionMatch) {
    throw new Error(
      "Unable to locate [programs.localnet] section in Anchor.toml"
    );
  }

  const body = sectionMatch[1] ?? "";
  const lines = body.split("\n");
  const programIds: LocalnetProgramIds = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, value] = trimmed.split("=").map((part) => part.trim());
    if (key === "escrow") {
      programIds.escrow = stripQuotes(value);
    } else if (key === "fulfillment_proxy") {
      programIds.fulfillmentProxy = stripQuotes(value);
    } else if (key === "mock_transfer_hook") {
      programIds.mockTransferHook = stripQuotes(value);
    }
  }

  return programIds;
}

function stripQuotes(value?: string): string | undefined {
  if (!value) return undefined;
  return value.replace(/^"|"$/g, "");
}

function patchAnchorTomlCluster(cluster: string): void {
  const anchorTomlPath = path.join(REPO_ROOT, "Anchor.toml");
  const raw = fs.readFileSync(anchorTomlPath, "utf-8");
  const patched = raw.replace(
    /^cluster\s*=\s*"[^"]*"/m,
    `cluster = "${cluster}"`
  );
  fs.writeFileSync(anchorTomlPath, patched);
  console.log(`Patched Anchor.toml cluster to "${cluster}"`);
}

function readKeypairAddress(keypairPath: string): string {
  const keyData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(keyData));
  return keypair.publicKey.toBase58();
}

function ensureCanonicalProgramKeypairs(programIds: LocalnetProgramIds): void {
  fs.mkdirSync(path.join(REPO_ROOT, "target", "deploy"), { recursive: true });

  for (const program of DEPLOYED_PROGRAMS) {
    const expectedAddress = programIds[program.key];
    if (!expectedAddress) continue;

    const targetKeypairPath = path.join(
      REPO_ROOT,
      "target",
      "deploy",
      `${program.fileBase}-keypair.json`
    );
    const canonicalKeypairPath = path.join(
      KEYPAIR_DIRECTORY,
      `${program.fileBase}-keypair.json`
    );

    if (fs.existsSync(targetKeypairPath)) {
      const currentAddress = readKeypairAddress(targetKeypairPath);
      if (currentAddress === expectedAddress) {
        continue;
      }
    }

    if (!fs.existsSync(canonicalKeypairPath)) {
      const currentAddress = fs.existsSync(targetKeypairPath)
        ? readKeypairAddress(targetKeypairPath)
        : "missing";
      throw new Error(
        [
          `Missing canonical keypair for ${program.fileBase}.`,
          `Expected address from Anchor.toml: ${expectedAddress}`,
          `Current target keypair address: ${currentAddress}`,
          `Required file: ${canonicalKeypairPath}`,
          "Populate .keys with canonical program keypairs, then rerun deploy-local.",
        ].join("\n")
      );
    }

    const canonicalAddress = readKeypairAddress(canonicalKeypairPath);
    if (canonicalAddress !== expectedAddress) {
      throw new Error(
        [
          `Canonical keypair mismatch for ${program.fileBase}.`,
          `Expected address from Anchor.toml: ${expectedAddress}`,
          `Canonical keypair address: ${canonicalAddress}`,
          `File: ${canonicalKeypairPath}`,
        ].join("\n")
      );
    }

    fs.copyFileSync(canonicalKeypairPath, targetKeypairPath);
  }
}

async function deployProgramsV4(
  connection: Connection,
  env: NodeJS.ProcessEnv,
  rpcUrl: string,
  anchorWalletPath: string,
  programIds: LocalnetProgramIds
): Promise<void> {
  for (const program of DEPLOYED_PROGRAMS) {
    const expectedAddress = programIds[program.key];
    if (!expectedAddress) continue;

    const programKeypairPath = path.join(
      REPO_ROOT,
      "target",
      "deploy",
      `${program.fileBase}-keypair.json`
    );
    const programBinaryPath = path.join(
      REPO_ROOT,
      "target",
      "deploy",
      `${program.fileBase}.so`
    );

    if (!fs.existsSync(programBinaryPath)) {
      throw new Error(`Missing program binary: ${programBinaryPath}`);
    }
    if (!fs.existsSync(programKeypairPath)) {
      throw new Error(`Missing program keypair: ${programKeypairPath}`);
    }

    const deployedAddress = readKeypairAddress(programKeypairPath);
    if (deployedAddress !== expectedAddress) {
      throw new Error(
        [
          `Program keypair mismatch for ${program.fileBase}.`,
          `Expected address from Anchor.toml: ${expectedAddress}`,
          `Target/deploy keypair address: ${deployedAddress}`,
        ].join("\n")
      );
    }

    const existingProgram = await connection.getAccountInfo(
      new PublicKey(expectedAddress),
      "confirmed"
    );

    if (!existingProgram) {
      runCommand(
        "solana",
        [
          "program-v4",
          "deploy",
          "--url",
          rpcUrl,
          "--keypair",
          anchorWalletPath,
          "--program-keypair",
          programKeypairPath,
          programBinaryPath,
        ],
        env,
        `solana program-v4 deploy ${program.fileBase} (new)`
      );
      continue;
    }

    if (existingProgram.owner.equals(LOADER_V4_PROGRAM_ID)) {
      runCommand(
        "solana",
        [
          "program-v4",
          "deploy",
          "--url",
          rpcUrl,
          "--keypair",
          anchorWalletPath,
          "--program-id",
          expectedAddress,
          programBinaryPath,
        ],
        env,
        `solana program-v4 deploy ${program.fileBase} (redeploy-v4)`
      );
      continue;
    }

    if (existingProgram.owner.equals(UPGRADEABLE_LOADER_PROGRAM_ID)) {
      runCommand(
        "solana",
        [
          "program",
          "deploy",
          "--url",
          rpcUrl,
          "--keypair",
          anchorWalletPath,
          "--program-id",
          programKeypairPath,
          programBinaryPath,
        ],
        env,
        `solana program deploy ${program.fileBase} (redeploy-legacy-loader)`
      );
      continue;
    }

    throw new Error(
      [
        `Unsupported program owner for ${
          program.fileBase
        }: ${existingProgram.owner.toBase58()}`,
        `Expected ${LOADER_V4_PROGRAM_ID.toBase58()} or ${UPGRADEABLE_LOADER_PROGRAM_ID.toBase58()}.`,
      ].join("\n")
    );
  }
}

async function ensurePayerBalance(
  connection: Connection,
  payer: Keypair
): Promise<void> {
  const minimumSol = Math.max(
    1,
    Number.parseInt(process.env.SOLANA_DEPLOY_MIN_BALANCE_SOL ?? "20", 10)
  );
  const minimumLamports = minimumSol * LAMPORTS_PER_SOL;
  const chunkLamports = Math.max(
    LAMPORTS_PER_SOL,
    Number.parseInt(process.env.SOLANA_DEPLOY_AIRDROP_CHUNK_SOL ?? "2", 10) *
      LAMPORTS_PER_SOL
  );
  const maxAttempts = Math.max(
    1,
    Number.parseInt(process.env.SOLANA_DEPLOY_AIRDROP_MAX_ATTEMPTS ?? "20", 10)
  );
  let balance = await connection.getBalance(payer.publicKey);

  if (balance >= minimumLamports) {
    return;
  }

  let attempt = 0;
  while (balance < minimumLamports && attempt < maxAttempts) {
    attempt += 1;
    const remaining = minimumLamports - balance;
    const requestLamports = Math.min(chunkLamports, remaining);
    const signature = await connection.requestAirdrop(
      payer.publicKey,
      requestLamports
    );
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      {
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed"
    );
    balance = await connection.getBalance(payer.publicKey);
  }

  if (balance < minimumLamports) {
    throw new Error(
      `Insufficient SOL deploy balance for ${payer.publicKey.toBase58()}: has ${(
        balance / LAMPORTS_PER_SOL
      ).toFixed(3)} SOL, requires ${minimumSol} SOL`
    );
  }

  console.log(
    `Funded local deploy payer ${payer.publicKey.toBase58()} to ${(
      balance / LAMPORTS_PER_SOL
    ).toFixed(3)} SOL`
  );
}

function getProtocolConfigAddress(programId: PublicKey): PublicKey {
  const [protocolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    programId
  );
  return protocolConfig;
}

async function getProgramDataAddress(
  connection: Connection,
  programId: PublicKey
): Promise<PublicKey> {
  const programAccount = await connection.getAccountInfo(
    programId,
    "confirmed"
  );
  if (!programAccount) {
    throw new Error(`Program account not found: ${programId.toBase58()}`);
  }
  if (programAccount.owner.equals(LOADER_V4_PROGRAM_ID)) {
    // Loader-v4 stores metadata and code in the program account itself.
    return programId;
  }
  const [programData] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
  );
  return programData;
}

async function initializeProtocols(
  connection: Connection,
  payer: Keypair,
  programIds: LocalnetProgramIds
): Promise<void> {
  if (!programIds.escrow || !programIds.fulfillmentProxy) {
    throw new Error("Missing escrow/fulfillmentProxy program IDs.");
  }
  const authority = payer;

  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  // Load IDLs
  const escrowIdlPath = path.join(REPO_ROOT, "target", "idl", "escrow.json");
  const fpIdlPath = path.join(
    REPO_ROOT,
    "target",
    "idl",
    "fulfillment_proxy.json"
  );
  const escrowIdl = JSON.parse(fs.readFileSync(escrowIdlPath, "utf-8"));
  const fpIdl = JSON.parse(fs.readFileSync(fpIdlPath, "utf-8"));

  const escrowProgramId = new PublicKey(programIds.escrow);
  const fpProgramId = new PublicKey(programIds.fulfillmentProxy);

  // Initialize Escrow protocol config
  const escrowConfig = getProtocolConfigAddress(escrowProgramId);
  const escrowConfigInfo = await connection.getAccountInfo(escrowConfig);
  const escrowProgram = new Program<Escrow>(escrowIdl, provider);
  if (escrowConfigInfo === null) {
    console.log("\nInitializing Escrow protocol config...");
    const programData = await getProgramDataAddress(
      connection,
      escrowProgramId
    );
    await escrowProgram.methods
      .initializeProtocol(
        authority.publicKey, // default_admin
        authority.publicKey, // token_config_authority
        authority.publicKey, // treasurer
        authority.publicKey, // pauser
        Array.from(ESCROW_LOCAL_CLUSTER_ID), // cluster_id
        0 // default_admin_delay_seconds
      )
      .accountsPartial({
        authority: authority.publicKey,
        protocolConfig: escrowConfig,
        program: escrowProgramId,
        programData,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("Escrow protocol config initialized.");
  } else {
    console.log("\nEscrow protocol config already initialized.");
  }

  const escrowConfigAccount = await escrowProgram.account.protocolConfig.fetch(
    escrowConfig
  );
  const configuredClusterId = decodeFixedSizeUtf8Bytes(
    Uint8Array.from(escrowConfigAccount.clusterId)
  );
  if (
    configuredClusterId !== decodeFixedSizeUtf8Bytes(ESCROW_LOCAL_CLUSTER_ID)
  ) {
    throw new Error(
      `Escrow cluster_id mismatch: expected ${decodeFixedSizeUtf8Bytes(
        ESCROW_LOCAL_CLUSTER_ID
      )}, got ${configuredClusterId}`
    );
  }
  if (
    escrowConfigAccount.signatureDomainVersion !==
    ESCROW_SIGNATURE_DOMAIN_VERSION
  ) {
    throw new Error(
      `Escrow signature_domain_version mismatch: expected ${ESCROW_SIGNATURE_DOMAIN_VERSION}, got ${escrowConfigAccount.signatureDomainVersion}`
    );
  }
  console.log(
    `Escrow signature domain verified: ${configuredClusterId} (v${escrowConfigAccount.signatureDomainVersion}).`
  );

  // Initialize FulfillmentProxy protocol config
  const fpConfig = getProtocolConfigAddress(fpProgramId);
  const fpConfigInfo = await connection.getAccountInfo(fpConfig);
  if (fpConfigInfo === null) {
    console.log("Initializing FulfillmentProxy protocol config...");
    const fpProgram = new Program<FulfillmentProxy>(fpIdl, provider);
    const programData = await getProgramDataAddress(connection, fpProgramId);
    await fpProgram.methods
      .initializeProtocol(
        authority.publicKey, // default_admin
        authority.publicKey, // pauser
        0 // default_admin_delay_seconds
      )
      .accountsPartial({
        authority: authority.publicKey,
        protocolConfig: fpConfig,
        program: fpProgramId,
        programData,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("FulfillmentProxy protocol config initialized.");
  } else {
    console.log("FulfillmentProxy protocol config already initialized.");
  }
}

// Fee parameters matching EVM/TVM deploy-local scripts
const FEE_PERCENTAGE_6 = 20_000; // 0.02% (scaled by 1e6)
const MIN_FEE_6 = 1; // Minimum fee floor
const MAX_FEE_6 = 0; // No maximum cap (uncapped)

async function allowMints(
  connection: Connection,
  payer: Keypair,
  escrowProgramId: string,
  mintAddresses: string[]
): Promise<void> {
  console.log("\nAllowlisting mints and setting fees on escrow...");

  const authority = payer;

  const wallet = new anchor.Wallet(authority);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const escrowIdlPath = path.join(REPO_ROOT, "target", "idl", "escrow.json");
  const escrowIdl = JSON.parse(fs.readFileSync(escrowIdlPath, "utf-8"));
  const programId = new PublicKey(escrowProgramId);
  const escrowProgram = new Program<Escrow>(escrowIdl, provider);

  const protocolConfig = getProtocolConfigAddress(programId);

  for (const mintAddr of mintAddresses) {
    const mint = new PublicKey(mintAddr);
    const [mintFeeConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_fee_config"), mint.toBuffer()],
      programId
    );

    // Allowlist if not already
    const existing = await connection.getAccountInfo(mintFeeConfig);
    if (existing === null) {
      await escrowProgram.methods
        .allowMint()
        .accountsPartial({
          tokenConfigAuthority: authority.publicKey,
          protocolConfig,
          mintAccount: mint,
          mintFeeConfig,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`  Mint ${mintAddr} allowlisted.`);
    } else {
      console.log(`  Mint ${mintAddr} already allowlisted.`);
    }

    // Set fee config (idempotent — always apply to ensure correct values)
    await escrowProgram.methods
      .setMintFeeConfig(
        new BN(FEE_PERCENTAGE_6),
        new BN(MIN_FEE_6),
        new BN(MAX_FEE_6)
      )
      .accountsPartial({
        tokenConfigAuthority: authority.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log(
      `  Mint ${mintAddr} fee config set (${
        (FEE_PERCENTAGE_6 / 1_000_000) * 100
      }% fee, min=${MIN_FEE_6}, max=${MAX_FEE_6 || "uncapped"}).`
    );
  }
  console.log("Mint allowlisting and fee configuration complete.");
}

async function deployMockTokens(
  connection: Connection,
  payer: Keypair
): Promise<{
  mints: { usdc: string; usdt: string };
  accounts: { usdc: string; usdt: string };
}> {
  console.log("\nDeploying SPL token mints...");

  const usdcMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    payer.publicKey,
    6
  );

  const usdtMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    payer.publicKey,
    6
  );

  const usdcAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    usdcMint,
    payer.publicKey
  );

  const usdtAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    usdtMint,
    payer.publicKey
  );

  await mintTo(
    connection,
    payer,
    usdcMint,
    usdcAccount.address,
    payer,
    1_000_000 * 10 ** 6
  );
  await mintTo(
    connection,
    payer,
    usdtMint,
    usdtAccount.address,
    payer,
    1_000_000 * 10 ** 6
  );

  console.log("SPL token deployment complete.");

  return {
    mints: {
      usdc: usdcMint.toBase58(),
      usdt: usdtMint.toBase58(),
    },
    accounts: {
      usdc: usdcAccount.address.toBase58(),
      usdt: usdtAccount.address.toBase58(),
    },
  };
}

main()
  .then(() => {
    console.log("\nSolana local deployment finished successfully.");
  })
  .catch((error) => {
    console.error("Solana local deployment failed:", error);
    process.exit(1);
  });
