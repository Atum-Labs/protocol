#!/usr/bin/env ts-node

/**
 * Production deployment script for Escrow and Fulfillment Proxy programs.
 *
 * This script:
 * 1. Builds and deploys both programs
 * 2. Initializes both programs with RBAC roles
 * 3. Verifies RBAC configuration matches expected values
 * 4. Revokes upgrade authority (makes programs immutable)
 *
 * Environment Variables:
 * - ESCROW_ID: Escrow program id for the target cluster (REQUIRED, no default)
 * - FP_ID: FulfillmentProxy program id for the target cluster (REQUIRED, no default)
 * - ALLOW_RETIRED_PROGRAM_IDS: "true" to permit the v1/v3 ids, which are otherwise refused
 * - SOLANA_RPC_URL: RPC endpoint (required)
 * - DEPLOYER_KEYPAIR: Path to deployer keypair JSON file (optional, defaults to .anchor/deployer.json)
 * - DEPLOYER_PRIVATE_KEY: Deployer private key in base58 (optional, alternative to DEPLOYER_KEYPAIR)
 * - DEFAULT_ADMIN: Admin role pubkey (optional, defaults to deployer)
 * - TOKEN_CONFIG_AUTHORITY: Token config authority pubkey (optional, defaults to deployer)
 * - TREASURER: Treasurer pubkey (optional, defaults to deployer)
 * - PAUSER: Pauser pubkey (optional, defaults to deployer)
 * - DEFAULT_ADMIN_DELAY_SECONDS: Admin transfer delay in seconds (optional, defaults to 0)
 * - SOLANA_DEPLOY_ARGS: forwarded to `solana program deploy` after `--` (see the guide's
 *   mainnet note; --buffer / --use-rpc / --with-compute-unit-price / --max-sign-attempts)
 * - SKIP_BUILD: Set to "true" to skip anchor build (optional)
 * - REVOKE_UPGRADE_AUTHORITY: "true" to PERMANENTLY revoke the upgrade authority after
 *   deploying (optional, default OFF). One-way door; run deploy/pre-finalize.sh first.
 *   The old SKIP_REVOKE_AUTHORITY is refused rather than ignored.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import bs58 from "bs58";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_DEPLOYER_KEYPAIR = path.join(
  REPO_ROOT,
  ".anchor",
  "deployer.json"
);
const ARTIFACT_FILENAME = path.join(REPO_ROOT, "deployment-artifact.json");

// Program IDs.
//
// These were `const` literals holding the v1/v3 ids, with no env override, which
// made every id-dependent step in this script silently target the OLD programs:
// initializeProtocol went to the old escrow and demanded ITS upgrade authority
// (on mainnet a Squads PDA, so unsignable), and verifyDeployment asserted that a
// program existed and was executable at those same old ids -- which it does, on
// every cluster -- so the check passed no matter what had just been deployed.
// That is the definition of a false green.
//
// They now come from ESCROW_ID / FP_ID, which env/svm.env already defines, and
// there is deliberately NO fallback: a missing id fails loudly rather than
// quietly reverting to the ids this comment used to describe.
const RETIRED_PROGRAM_IDS = new Map<string, string>([
  ["44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs", "v1/v3 Escrow"],
  ["77AqGeSh3GLFcBwSxdTnefgv92Cosi9o6NsK992TZsRe", "v1/v3 FulfillmentProxy"],
]);

function requireProgramId(envVar: string, label: string): PublicKey {
  const raw = process.env[envVar]?.trim();
  if (!raw) {
    throw new Error(
      `${envVar} is not set, and there is no default. It is the ${label} program id for the ` +
        `cluster you are deploying to.\n` +
        `  Set it in "\${ATUM_HOME:-$HOME/.atum}/env/svm.env" and source that file.\n` +
        `  This used to fall back to the v1/v3 id, which meant the deploy targeted the old ` +
        `program and reported success.`
    );
  }
  let id: PublicKey;
  try {
    id = new PublicKey(raw);
  } catch {
    throw new Error(`${envVar}="${raw}" is not a valid base58 Solana address`);
  }
  const retired = RETIRED_PROGRAM_IDS.get(id.toBase58());
  if (retired && process.env.ALLOW_RETIRED_PROGRAM_IDS?.toLowerCase() !== "true") {
    throw new Error(
      `${envVar} names ${id.toBase58()}, which is the ${retired} program id.\n` +
        `  Those programs are live on devnet, testnet AND mainnet, so pointing at them will ` +
        `appear to work: verifyDeployment would pass and initializeProtocol would demand the ` +
        `OLD program's upgrade authority (on mainnet an off-curve Squads PDA).\n` +
        `  If you genuinely mean to operate on the retired programs, set ` +
        `ALLOW_RETIRED_PROGRAM_IDS=true.`
    );
  }
  return id;
}

const ESCROW_PROGRAM_ID = requireProgramId("ESCROW_ID", "Escrow");
const FULFILLMENT_PROXY_PROGRAM_ID = requireProgramId("FP_ID", "FulfillmentProxy");
// Must match the on-chain ProtocolConfig::CURRENT_SIGNATURE_DOMAIN_VERSION, which
// initialize_protocol hardcodes (the passed value is ignored, so this is only ever
// compared against what the chain reports -- never what gets written).
//
// v3 bound quote_hash into the reserve/release/refund preimages; v4 adds
// keccak256(destination) to the deposit preimage.
//
// NOTE: this is the third place the version is written down, after
// programs/escrow/src/state.rs and the Go/TS encoders. Deriving it from the IDL would
// remove the drift -- see the comment in deploy-local.ts.
const ESCROW_SIGNATURE_DOMAIN_VERSION = 5;

interface DeploymentConfig {
  rpcUrl: string;
  deployer: Keypair;
  deployerKeypairPath: string;
  defaultAdmin: PublicKey;
  tokenConfigAuthority: PublicKey;
  treasurer: PublicKey;
  pauser: PublicKey;
  escrowClusterId: Uint8Array;
  escrowClusterIdLabel: string;
  escrowSignatureDomainVersion: number;
  defaultAdminDelaySeconds: number;
  skipBuild: boolean;
  skipDeploy: boolean;
  revokeAuthority: boolean;
  // The escrow alone (ESCROW_ONLY=true): a new escrow beside a proxy that is already live, whose
  // config and upgrade authority this run must not touch.
  escrowOnly: boolean;
}

interface DeploymentArtifact {
  network: string;
  timestamp: string;
  programs: {
    escrow: string;
    fulfillmentProxy: string;
  };
  rbac: {
    defaultAdmin: string;
    tokenConfigAuthority: string;
    treasurer: string;
    pauser: string;
    defaultAdminDelaySeconds: number;
  };
  escrowSignatureDomain: {
    clusterIdUtf8: string;
    clusterIdHex: string;
    signatureDomainVersion: number;
  };
  // Absent on an escrow only run: this run did not initialize the proxy, so its roles are not this
  // run's to report.
  fulfillmentProxyRbac?: {
    defaultAdmin: string;
    pauser: string;
    defaultAdminDelaySeconds: number;
  };
  upgradeAuthorityRevoked: boolean;
  // True on an escrow only run: upgradeAuthorityRevoked covers the escrow alone.
  escrowOnly: boolean;
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Solana Escrow & Fulfillment Proxy Deployment");
  console.log("=".repeat(60));

  const config = loadConfig();
  printConfig(config);

  // Ensure keypair file exists for Anchor CLI (write if using base58 key)
  const keypairPath = ensureKeypairFile(config);

  const anchorEnv = {
    ...process.env,
    ANCHOR_WALLET: keypairPath,
    ANCHOR_PROVIDER_URL: config.rpcUrl,
  };

  // Step 1: Build programs
  if (!config.skipBuild) {
    console.log("\n[1/4] Building programs...");
    runCommand("anchor", ["build"], anchorEnv, "anchor build");
  } else {
    console.log("\n[1/4] Skipping build (SKIP_BUILD=true)");
  }

  // Step 2: Deploy programs
  const cluster = detectCluster(config.rpcUrl);
  if (!config.skipDeploy) {
    console.log("\n[2/4] Deploying programs...");
    // `anchor deploy [-- <SOLANA_ARGS>]` forwards to `solana program deploy`, and
    // without that passthrough none of the flags that decide whether a mainnet
    // upload succeeds were reachable: --buffer (resume a failed upload into the
    // SAME buffer, so a retry costs no extra rent), --use-rpc (send writes via the
    // RPC rather than validator TPUs, which usually fail from a laptop),
    // --with-compute-unit-price (priority fee; without one the upload may never
    // land under congestion) and --max-sign-attempts (blockhash expiry is the
    // common failure).
    const extraDeployArgs = (process.env.SOLANA_DEPLOY_ARGS ?? "")
      .split(/\s+/)
      .filter((a) => a.length > 0);
    if (cluster === "mainnet" && extraDeployArgs.length === 0) {
      console.warn(
        "  WARNING: deploying to mainnet with no SOLANA_DEPLOY_ARGS.\n" +
          "    Without --buffer a failed upload strands its rent and a retry needs fresh SOL;\n" +
          "    without --use-rpc the write transactions go via validator TPUs and often fail;\n" +
          "    without --with-compute-unit-price the upload may not land under congestion.\n" +
          "    See the guide's mainnet funding note. Set SOLANA_DEPLOY_ARGS to proceed deliberately."
      );
    }
    runCommand(
      "anchor",
      [
        "deploy",
        "--provider.cluster",
        cluster,
        "--provider.wallet",
        keypairPath,
        ...(extraDeployArgs.length > 0 ? ["--", ...extraDeployArgs] : []),
      ],
      anchorEnv,
      `anchor deploy${extraDeployArgs.length ? ` -- ${extraDeployArgs.join(" ")}` : ""}`
    );
  } else {
    console.log("\n[2/4] Skipping deploy (SKIP_DEPLOY=true)");
  }

  // Verify deployment
  const wsEndpoint = process.env.SOLANA_WS_URL;
  const connection = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    ...(wsEndpoint ? { wsEndpoint } : {}),
  });
  await verifyDeployment(connection);

  // Step 3: Initialize protocol with RBAC roles
  console.log("\n[3/4] Initializing protocols with RBAC configuration...");
  await initializeEscrowProtocol(connection, config);
  if (config.escrowOnly) {
    console.log("  Skipping Fulfillment Proxy initialization (ESCROW_ONLY=true, it is already live)");
  } else {
    await initializeFulfillmentProxyProtocol(connection, config);
  }

  // Step 4: Revoke upgrade authority — only when explicitly asked for.
  if (config.revokeAuthority) {
    console.log("\n[4/4] Revoking upgrade authority (REVOKE_UPGRADE_AUTHORITY=true)...");
    console.log(
      "        This is PERMANENT. The program can never be upgraded again, and it does " +
        "NOT\n        affect default_admin / token_config_authority / treasurer / pauser."
    );
    await revokeUpgradeAuthority(config, keypairPath);
  } else {
    console.log(
      "\n[4/4] Keeping the upgrade authority (default). Set REVOKE_UPGRADE_AUTHORITY=true\n" +
        "      to make the program permanently immutable — see deploy/pre-finalize.sh."
    );
  }

  // Write deployment artifact
  const artifact: DeploymentArtifact = {
    network: cluster,
    timestamp: new Date().toISOString(),
    programs: {
      escrow: ESCROW_PROGRAM_ID.toBase58(),
      fulfillmentProxy: FULFILLMENT_PROXY_PROGRAM_ID.toBase58(),
    },
    rbac: {
      defaultAdmin: config.defaultAdmin.toBase58(),
      tokenConfigAuthority: config.tokenConfigAuthority.toBase58(),
      treasurer: config.treasurer.toBase58(),
      pauser: config.pauser.toBase58(),
      defaultAdminDelaySeconds: config.defaultAdminDelaySeconds,
    },
    escrowSignatureDomain: {
      clusterIdUtf8: decodeFixedSizeUtf8Bytes(config.escrowClusterId),
      clusterIdHex: Buffer.from(config.escrowClusterId).toString("hex"),
      signatureDomainVersion: config.escrowSignatureDomainVersion,
    },
    ...(config.escrowOnly
      ? {}
      : {
          fulfillmentProxyRbac: {
            defaultAdmin: config.defaultAdmin.toBase58(),
            pauser: config.pauser.toBase58(),
            defaultAdminDelaySeconds: config.defaultAdminDelaySeconds,
          },
        }),
    upgradeAuthorityRevoked: config.revokeAuthority,
    escrowOnly: config.escrowOnly,
  };

  fs.writeFileSync(ARTIFACT_FILENAME, JSON.stringify(artifact, null, 2));

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("Deployment Complete");
  console.log("=".repeat(60));
  console.log(`\nPrograms:`);
  console.log(`  Escrow:            ${ESCROW_PROGRAM_ID.toBase58()}`);
  console.log(
    `  Fulfillment Proxy: ${FULFILLMENT_PROXY_PROGRAM_ID.toBase58()}`
  );
  console.log(`\nRBAC Configuration:`);
  console.log(`  Default Admin:           ${config.defaultAdmin.toBase58()}`);
  console.log(
    `  Token Config Authority:  ${config.tokenConfigAuthority.toBase58()}`
  );
  console.log(`  Treasurer:               ${config.treasurer.toBase58()}`);
  console.log(`  Pauser:                  ${config.pauser.toBase58()}`);
  console.log(
    `  Escrow Cluster ID:       ${decodeFixedSizeUtf8Bytes(
      config.escrowClusterId
    )}`
  );
  console.log(
    `  Signature Domain Ver.:   ${config.escrowSignatureDomainVersion}`
  );
  console.log(`  Admin Delay:             ${config.defaultAdminDelaySeconds}s`);
  console.log(
    `\nUpgrade Authority: ${
      config.revokeAuthority ? "REVOKED (immutable)" : "RETAINED"
    }`
  );
  console.log(`\nArtifact written to: ${ARTIFACT_FILENAME}`);
}

function loadConfig(): DeploymentConfig {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? process.env.ANCHOR_PROVIDER_URL;
  if (!rpcUrl) {
    throw new Error("SOLANA_RPC_URL environment variable is required");
  }

  // Load deployer keypair from file or base58 env var
  const deployerKeypairPath =
    process.env.DEPLOYER_KEYPAIR ?? DEFAULT_DEPLOYER_KEYPAIR;
  const privateKeyBase58 = process.env.DEPLOYER_PRIVATE_KEY?.trim();

  let deployer: Keypair;
  if (privateKeyBase58) {
    // Use base58 private key from env
    deployer = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
  } else if (fs.existsSync(deployerKeypairPath)) {
    // Load from keypair file
    const keypairData = JSON.parse(
      fs.readFileSync(deployerKeypairPath, "utf-8")
    );
    deployer = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  } else {
    throw new Error(
      `Deployer keypair not found. Either set DEPLOYER_PRIVATE_KEY (base58) or ` +
        `provide a keypair file at DEPLOYER_KEYPAIR (default: ${DEFAULT_DEPLOYER_KEYPAIR})`
    );
  }

  const deployerPubkey = deployer.publicKey;

  // Parse role addresses, defaulting to deployer if not specified
  const defaultAdmin = parsePublicKey(
    process.env.DEFAULT_ADMIN,
    "DEFAULT_ADMIN",
    deployerPubkey
  );
  const tokenConfigAuthority = parsePublicKey(
    process.env.TOKEN_CONFIG_AUTHORITY,
    "TOKEN_CONFIG_AUTHORITY",
    deployerPubkey
  );
  const treasurer = parsePublicKey(
    process.env.TREASURER,
    "TREASURER",
    deployerPubkey
  );
  const pauser = parsePublicKey(process.env.PAUSER, "PAUSER", deployerPubkey);
  const escrowClusterIdLabel =
    process.env.ESCROW_CLUSTER_ID?.trim() || detectCluster(rpcUrl);
  const escrowClusterId = fixedSizeUtf8Bytes(escrowClusterIdLabel, 32);

  const defaultAdminDelaySeconds = parseInt(
    process.env.DEFAULT_ADMIN_DELAY_SECONDS ?? "0",
    10
  );
  if (isNaN(defaultAdminDelaySeconds) || defaultAdminDelaySeconds < 0) {
    throw new Error(
      "DEFAULT_ADMIN_DELAY_SECONDS must be a non-negative integer"
    );
  }

  const skipBuild = process.env.SKIP_BUILD?.toLowerCase() === "true";
  const skipDeploy = process.env.SKIP_DEPLOY?.toLowerCase() === "true";
  // Opt-in, not opt-out. Revoking the upgrade authority is a one-way door: the program can
  // never be patched afterwards, and a bug then needs a new program id, which changes every
  // signature preimage and invalidates all 13 hash anchors.
  //
  // SKIP_REVOKE_AUTHORITY is obsolete and refuses the run on any presence, so a script or
  // runbook carrying it fails loudly instead of silently changing meaning.
  //
  // Deliberately not gated on `&& !revokeAuthority`. That let the contradictory combination --
  // both variables set -- pass silently and then REVOKE, which is the one outcome an operator
  // who set SKIP_REVOKE_AUTHORITY was trying to prevent.
  const revokeAuthority =
    process.env.REVOKE_UPGRADE_AUTHORITY?.toLowerCase() === "true";
  const escrowOnly = process.env.ESCROW_ONLY?.toLowerCase() === "true";
  // `anchor deploy` here deploys every program, so an escrow only run must deploy through
  // deploy.sh (which deploys one program at a time) and reach this script with SKIP_DEPLOY.
  if (escrowOnly && !skipDeploy) {
    throw new Error(
      "ESCROW_ONLY=true needs SKIP_DEPLOY=true: this script's deploy step deploys the proxy too. " +
        "Deploy with contracts/svm/deploy/deploy.sh and PROGRAMS=escrow."
    );
  }
  if (process.env.SKIP_REVOKE_AUTHORITY !== undefined) {
    throw new Error(
      "SKIP_REVOKE_AUTHORITY is obsolete: revocation is now opt-in. Not revoking is the " +
        "default, so remove the variable. To revoke deliberately, set " +
        "REVOKE_UPGRADE_AUTHORITY=true -- and read the pre-finalize gate first " +
        "(contracts/svm/deploy/pre-finalize.sh), because it cannot be undone."
    );
  }

  return {
    rpcUrl,
    deployer,
    deployerKeypairPath,
    defaultAdmin,
    tokenConfigAuthority,
    treasurer,
    pauser,
    escrowClusterId,
    escrowClusterIdLabel,
    escrowSignatureDomainVersion: ESCROW_SIGNATURE_DOMAIN_VERSION,
    defaultAdminDelaySeconds,
    skipBuild,
    skipDeploy,
    revokeAuthority,
    escrowOnly,
  };
}

function parsePublicKey(
  value: string | undefined,
  name: string,
  fallback: PublicKey
): PublicKey {
  if (!value?.trim()) {
    return fallback;
  }
  try {
    return new PublicKey(value.trim());
  } catch {
    throw new Error(`Invalid ${name}: "${value}" is not a valid public key`);
  }
}

function printConfig(config: DeploymentConfig): void {
  console.log(`\nConfiguration:`);
  console.log(`  RPC URL:                 ${config.rpcUrl}`);
  console.log(`  Deployer Keypair:        ${config.deployerKeypairPath}`);
  console.log(
    `  Deployer:                ${config.deployer.publicKey.toBase58()}`
  );
  console.log(
    `  Default Admin:           ${config.defaultAdmin.toBase58()}${
      config.defaultAdmin.equals(config.deployer.publicKey) ? " (deployer)" : ""
    }`
  );
  console.log(
    `  Token Config Authority:  ${config.tokenConfigAuthority.toBase58()}${
      config.tokenConfigAuthority.equals(config.deployer.publicKey)
        ? " (deployer)"
        : ""
    }`
  );
  console.log(
    `  Treasurer:               ${config.treasurer.toBase58()}${
      config.treasurer.equals(config.deployer.publicKey) ? " (deployer)" : ""
    }`
  );
  console.log(
    `  Pauser:                  ${config.pauser.toBase58()}${
      config.pauser.equals(config.deployer.publicKey) ? " (deployer)" : ""
    }`
  );
  console.log(`  Escrow Cluster ID:       ${config.escrowClusterIdLabel}`);
  console.log(
    `  Signature Domain Ver.:   ${config.escrowSignatureDomainVersion}`
  );
  console.log(`  Admin Delay:             ${config.defaultAdminDelaySeconds}s`);
  console.log(`  Skip Build:              ${config.skipBuild}`);
  console.log(
    `  Revoke Upgrade Authority: ${config.revokeAuthority}${
      config.revokeAuthority ? "   *** PERMANENT ***" : ""
    }`
  );
}

function ensureKeypairFile(config: DeploymentConfig): string {
  // If keypair file already exists, use it
  if (fs.existsSync(config.deployerKeypairPath)) {
    return config.deployerKeypairPath;
  }

  // Otherwise, write the keypair to the default location
  const secret = Array.from(config.deployer.secretKey);
  const dir = path.dirname(config.deployerKeypairPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.deployerKeypairPath, JSON.stringify(secret));
  return config.deployerKeypairPath;
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string
): void {
  console.log(`  > ${label}`);
  // execFileSync, not execSync on an interpolated string: the command and args come from the
  // environment, and a shell would treat metacharacters in them as syntax. Passing argv directly means
  // there is no shell to inject into, which is the actual fix rather than quoting harder.
  execFileSync(command, args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env,
  });
}

function detectCluster(rpcUrl: string): string {
  const lower = rpcUrl.toLowerCase();
  if (lower.includes("mainnet")) return "mainnet";
  if (lower.includes("devnet")) return "devnet";
  if (lower.includes("testnet")) return "testnet";
  if (lower.includes("127.0.0.1") || lower.includes("localhost"))
    return "localnet";
  // Default to devnet for unknown URLs
  return "devnet";
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

async function verifyDeployment(connection: Connection): Promise<void> {
  console.log("  Verifying program deployment...");

  const escrowInfo = await connection.getAccountInfo(ESCROW_PROGRAM_ID);
  if (!escrowInfo || !escrowInfo.executable) {
    throw new Error(
      `Escrow program not found or not executable at ${ESCROW_PROGRAM_ID.toBase58()}`
    );
  }
  console.log(`    Escrow program verified: ${ESCROW_PROGRAM_ID.toBase58()}`);

  const proxyInfo = await connection.getAccountInfo(
    FULFILLMENT_PROXY_PROGRAM_ID
  );
  if (!proxyInfo || !proxyInfo.executable) {
    throw new Error(
      `Fulfillment Proxy program not found or not executable at ${FULFILLMENT_PROXY_PROGRAM_ID.toBase58()}`
    );
  }
  console.log(
    `    Fulfillment Proxy verified: ${FULFILLMENT_PROXY_PROGRAM_ID.toBase58()}`
  );

  // "exists and is executable" is a weak assertion on its own: it holds for any
  // program ever deployed at that address, including one deployed months ago by
  // someone else. Report the owner and the size of each program account so a stale
  // or unexpected program is visible in the log rather than silently accepted.
  for (const [label, id, info] of [
    ["Escrow", ESCROW_PROGRAM_ID, escrowInfo] as const,
    ["Fulfillment Proxy", FULFILLMENT_PROXY_PROGRAM_ID, proxyInfo] as const,
  ]) {
    console.log(
      `      ${label}: owner ${info.owner.toBase58()}, ${info.data.length} bytes, ` +
        `${info.lamports / 1e9} SOL`
    );
    const programData = getProgramDataAddress(id);
    const pd = await connection.getAccountInfo(programData);
    if (!pd) {
      console.log(`      ${label}: no ProgramData account — not an upgradeable program`);
      continue;
    }
    // ProgramData layout: 4-byte enum, 8-byte slot, 1-byte Option<Pubkey>, 32-byte authority.
    const slot = Number(pd.data.readBigUInt64LE(4));
    const hasAuthority = pd.data[12] === 1;
    const authority = hasAuthority
      ? new PublicKey(pd.data.subarray(13, 45)).toBase58()
      : "NONE (immutable)";
    console.log(`      ${label}: last deployed in slot ${slot}, upgrade authority ${authority}`);
  }
}

function getProtocolConfigAddress(programId: PublicKey): PublicKey {
  const [protocolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    programId
  );
  return protocolConfig;
}

function getProgramDataAddress(programId: PublicKey): PublicKey {
  const [programData] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
  );
  return programData;
}

async function initializeEscrowProtocol(
  connection: Connection,
  config: DeploymentConfig
): Promise<void> {
  const protocolConfig = getProtocolConfigAddress(ESCROW_PROGRAM_ID);

  // Check if already initialized
  const existingConfig = await connection.getAccountInfo(protocolConfig);
  if (existingConfig !== null) {
    console.log(
      "  Protocol already initialized, verifying existing configuration..."
    );
    console.log(`    ProtocolConfig PDA: ${protocolConfig.toBase58()}`);

    // Still verify the RBAC configuration matches expectations
    const wallet = new anchor.Wallet(config.deployer);
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    const idlPath = path.join(REPO_ROOT, "target", "idl", "escrow.json");
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const program = new Program(idl as any, provider);

    await verifyEscrowRbacConfiguration(program, protocolConfig, config);
    return;
  }

  // Create Anchor provider and program
  const wallet = new anchor.Wallet(config.deployer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  // Load the IDL
  const idlPath = path.join(REPO_ROOT, "target", "idl", "escrow.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(idl as any, provider);

  const programData = getProgramDataAddress(ESCROW_PROGRAM_ID);

  console.log("  Calling initializeProtocol...");
  console.log(`    ProtocolConfig PDA: ${protocolConfig.toBase58()}`);

  const tx = await program.methods
    .initializeProtocol(
      config.defaultAdmin,
      config.tokenConfigAuthority,
      config.treasurer,
      config.pauser,
      Array.from(config.escrowClusterId),
      config.defaultAdminDelaySeconds
    )
    .accountsPartial({
      authority: config.deployer.publicKey,
      protocolConfig,
      program: ESCROW_PROGRAM_ID,
      programData,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`    Transaction: ${tx}`);

  // Verify and assert RBAC configuration
  await verifyEscrowRbacConfiguration(program, protocolConfig, config);
}

async function verifyEscrowRbacConfiguration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any>,
  protocolConfig: PublicKey,
  config: DeploymentConfig
): Promise<void> {
  console.log("  Verifying RBAC configuration...");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAccount = await (program.account as any).protocolConfig.fetch(
    protocolConfig
  );

  const errors: string[] = [];

  // Assert default admin
  if (!configAccount.defaultAdmin.equals(config.defaultAdmin)) {
    errors.push(
      `Default Admin mismatch: expected ${config.defaultAdmin.toBase58()}, ` +
        `got ${configAccount.defaultAdmin.toBase58()}`
    );
  }

  // Assert token config authority
  if (!configAccount.tokenConfigAuthority.equals(config.tokenConfigAuthority)) {
    errors.push(
      `Token Config Authority mismatch: expected ${config.tokenConfigAuthority.toBase58()}, ` +
        `got ${configAccount.tokenConfigAuthority.toBase58()}`
    );
  }

  // Assert treasurer
  if (!configAccount.treasurer.equals(config.treasurer)) {
    errors.push(
      `Treasurer mismatch: expected ${config.treasurer.toBase58()}, ` +
        `got ${configAccount.treasurer.toBase58()}`
    );
  }

  // Assert pauser
  if (!configAccount.pauser.equals(config.pauser)) {
    errors.push(
      `Pauser mismatch: expected ${config.pauser.toBase58()}, ` +
        `got ${configAccount.pauser.toBase58()}`
    );
  }

  // Assert admin delay
  if (
    configAccount.defaultAdminDelaySeconds !== config.defaultAdminDelaySeconds
  ) {
    errors.push(
      `Admin Delay mismatch: expected ${config.defaultAdminDelaySeconds}s, ` +
        `got ${configAccount.defaultAdminDelaySeconds}s`
    );
  }

  // Assert not paused
  if (configAccount.paused) {
    errors.push("Protocol should not be paused after initialization");
  }

  if (
    !Buffer.from(configAccount.clusterId).equals(
      Buffer.from(config.escrowClusterId)
    )
  ) {
    errors.push(
      `Cluster ID mismatch: expected ${decodeFixedSizeUtf8Bytes(
        config.escrowClusterId
      )}, got ${decodeFixedSizeUtf8Bytes(
        Uint8Array.from(configAccount.clusterId)
      )}`
    );
  }

  if (
    configAccount.signatureDomainVersion !== config.escrowSignatureDomainVersion
  ) {
    errors.push(
      `Signature domain version mismatch: expected ${config.escrowSignatureDomainVersion}, ` +
        `got ${configAccount.signatureDomainVersion}`
    );
  }

  if (errors.length > 0) {
    console.error("  RBAC verification FAILED:");
    for (const error of errors) {
      console.error(`    - ${error}`);
    }
    throw new Error(
      `RBAC configuration verification failed: ${errors.join("; ")}`
    );
  }

  console.log("  RBAC configuration verified successfully:");
  console.log(
    `    Default Admin:          ${configAccount.defaultAdmin.toBase58()} ✓`
  );
  console.log(
    `    Token Config Authority: ${configAccount.tokenConfigAuthority.toBase58()} ✓`
  );
  console.log(
    `    Treasurer:              ${configAccount.treasurer.toBase58()} ✓`
  );
  console.log(
    `    Pauser:                 ${configAccount.pauser.toBase58()} ✓`
  );
  console.log(
    `    Admin Delay:            ${configAccount.defaultAdminDelaySeconds}s ✓`
  );
  console.log(`    Paused:                 ${configAccount.paused} ✓`);
  console.log(
    `    Escrow Cluster ID:      ${decodeFixedSizeUtf8Bytes(
      Uint8Array.from(configAccount.clusterId)
    )} ✓`
  );
  console.log(
    `    Signature Domain Ver.:  ${configAccount.signatureDomainVersion} ✓`
  );
}

async function initializeFulfillmentProxyProtocol(
  connection: Connection,
  config: DeploymentConfig
): Promise<void> {
  const protocolConfig = getProtocolConfigAddress(FULFILLMENT_PROXY_PROGRAM_ID);

  // Check if already initialized
  const existingConfig = await connection.getAccountInfo(protocolConfig);
  if (existingConfig !== null) {
    console.log(
      "  Fulfillment Proxy already initialized, verifying existing configuration..."
    );
    console.log(`    ProtocolConfig PDA: ${protocolConfig.toBase58()}`);

    const wallet = new anchor.Wallet(config.deployer);
    const provider = new anchor.AnchorProvider(connection, wallet, {
      commitment: "confirmed",
    });
    const idlPath = path.join(
      REPO_ROOT,
      "target",
      "idl",
      "fulfillment_proxy.json"
    );
    const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const program = new Program(idl as any, provider);

    await verifyFulfillmentProxyRbacConfiguration(
      program,
      protocolConfig,
      config
    );
    return;
  }

  const wallet = new anchor.Wallet(config.deployer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });

  const idlPath = path.join(
    REPO_ROOT,
    "target",
    "idl",
    "fulfillment_proxy.json"
  );
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = new Program(idl as any, provider);

  const programData = getProgramDataAddress(FULFILLMENT_PROXY_PROGRAM_ID);

  console.log("  Calling fulfillment proxy initializeProtocol...");
  console.log(`    ProtocolConfig PDA: ${protocolConfig.toBase58()}`);

  const tx = await program.methods
    .initializeProtocol(
      config.defaultAdmin,
      config.pauser,
      config.defaultAdminDelaySeconds
    )
    .accountsPartial({
      authority: config.deployer.publicKey,
      protocolConfig,
      program: FULFILLMENT_PROXY_PROGRAM_ID,
      programData,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`    Transaction: ${tx}`);

  await verifyFulfillmentProxyRbacConfiguration(
    program,
    protocolConfig,
    config
  );
}

async function verifyFulfillmentProxyRbacConfiguration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: Program<any>,
  protocolConfig: PublicKey,
  config: DeploymentConfig
): Promise<void> {
  console.log("  Verifying Fulfillment Proxy RBAC configuration...");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const configAccount = await (program.account as any).protocolConfig.fetch(
    protocolConfig
  );

  const errors: string[] = [];

  // Assert default admin
  if (!configAccount.defaultAdmin.equals(config.defaultAdmin)) {
    errors.push(
      `Default Admin mismatch: expected ${config.defaultAdmin.toBase58()}, ` +
        `got ${configAccount.defaultAdmin.toBase58()}`
    );
  }

  // Assert pauser
  if (!configAccount.pauser.equals(config.pauser)) {
    errors.push(
      `Pauser mismatch: expected ${config.pauser.toBase58()}, ` +
        `got ${configAccount.pauser.toBase58()}`
    );
  }

  // Assert admin delay
  if (
    configAccount.defaultAdminDelaySeconds !== config.defaultAdminDelaySeconds
  ) {
    errors.push(
      `Admin Delay mismatch: expected ${config.defaultAdminDelaySeconds}s, ` +
        `got ${configAccount.defaultAdminDelaySeconds}s`
    );
  }

  // Assert not paused
  if (configAccount.paused) {
    errors.push("Protocol should not be paused after initialization");
  }

  if (errors.length > 0) {
    console.error("  Fulfillment Proxy RBAC verification FAILED:");
    for (const error of errors) {
      console.error(`    - ${error}`);
    }
    throw new Error(
      `Fulfillment Proxy RBAC configuration verification failed: ${errors.join(
        "; "
      )}`
    );
  }

  console.log("  Fulfillment Proxy RBAC configuration verified successfully:");
  console.log(
    `    Default Admin:          ${configAccount.defaultAdmin.toBase58()} ✓`
  );
  console.log(
    `    Pauser:                 ${configAccount.pauser.toBase58()} ✓`
  );
  console.log(
    `    Admin Delay:            ${configAccount.defaultAdminDelaySeconds}s ✓`
  );
  console.log(`    Paused:                 ${configAccount.paused} ✓`);
}

async function revokeUpgradeAuthority(
  config: DeploymentConfig,
  keypairPath: string
): Promise<void> {
  // Revoke escrow program upgrade authority
  console.log("  Revoking Escrow program upgrade authority...");
  try {
    // execFileSync for the same reason as runStep: keypairPath and config.rpcUrl are
    // environment-derived, and passing argv avoids a shell entirely rather than quoting harder.
    execFileSync(
      "solana",
      [
        "program",
        "set-upgrade-authority",
        ESCROW_PROGRAM_ID.toBase58(),
        "--final",
        "--keypair",
        keypairPath,
        "--url",
        config.rpcUrl,
      ],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
      }
    );
    console.log(`    Escrow upgrade authority revoked`);
  } catch (error) {
    console.error("    Failed to revoke Escrow upgrade authority:", error);
    throw error;
  }

  if (config.escrowOnly) {
    console.log("  Leaving the Fulfillment Proxy upgrade authority as it is (ESCROW_ONLY=true)");
    return;
  }
  // Revoke fulfillment proxy program upgrade authority
  console.log("  Revoking Fulfillment Proxy program upgrade authority...");
  try {
    // execFileSync for the same reason as runStep: keypairPath and config.rpcUrl are
    // environment-derived, and passing argv avoids a shell entirely rather than quoting harder.
    execFileSync(
      "solana",
      [
        "program",
        "set-upgrade-authority",
        FULFILLMENT_PROXY_PROGRAM_ID.toBase58(),
        "--final",
        "--keypair",
        keypairPath,
        "--url",
        config.rpcUrl,
      ],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
      }
    );
    console.log(`    Fulfillment Proxy upgrade authority revoked`);
  } catch (error) {
    console.error(
      "    Failed to revoke Fulfillment Proxy upgrade authority:",
      error
    );
    throw error;
  }
}

main()
  .then(() => {
    console.log("\nDeployment finished successfully.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\nDeployment failed:", error);
    process.exit(1);
  });
