#!/usr/bin/env ts-node

/**
 * FulfillmentProxy: strict_fulfill settler allowlist administration.
 *
 * Wraps the three default_admin-gated instructions (all take the shared SetRoleKey context —
 * programs/fulfillment_proxy/src/instructions/protocol.rs:203) plus a read-only view:
 *   set_enforce_settler_allowlist(enforced)  <- enforce-on / enforce-off
 *   add_authorized_settler(settler)          <- add
 *   remove_authorized_settler(settler)       <- remove
 *
 * Until this script existed the instructions were reachable only from
 * tests/14_strict_fulfill_allowlist.ts, so the allowlist could not be provisioned on a real cluster.
 *
 * SEMANTICS THAT DECIDE WHETHER A RUN IS AN OUTAGE:
 *   - The allowlist ships DORMANT (enforce_settler_allowlist = false), so a fresh redeploy behaves
 *     exactly like the prior program: strict_fulfill stays permissionless. Enforcement is a separate,
 *     deliberate flip, reversible at any time (`enforce-off` is the instant rollback).
 *   - Enforcement is evaluated ahead of every other strict_fulfill guard
 *     (instructions/fulfillment.rs:59). Turning it on while the allowlist is EMPTY — or holds the
 *     wrong keys — rejects EVERY strict_fulfill with UnauthorizedSettler. That is an outage, not a
 *     tightening. `enforce-on` therefore refuses an empty allowlist, and `remove` refuses to empty a
 *     live allowlist, unless --allow-empty-allowlist is passed.
 *   - The allowlist is capped at MAX_AUTHORIZED_SETTLERS (16) and lives inline in ProtocolConfig.
 *
 * Dry by default: every mutating subcommand only builds and prints the instruction. --send broadcasts.
 *
 * Usage:
 *   npx ts-node scripts/fp-settler-allowlist.ts show [--rpc <url>]
 *   npx ts-node scripts/fp-settler-allowlist.ts add    --keypair <admin.json> --settler <pubkey> [--send]
 *   npx ts-node scripts/fp-settler-allowlist.ts remove --keypair <admin.json> --settler <pubkey> [--send]
 *   npx ts-node scripts/fp-settler-allowlist.ts enforce-on  --keypair <admin.json> [--send]
 *   npx ts-node scripts/fp-settler-allowlist.ts enforce-off --keypair <admin.json> [--send]
 *
 * Flags:
 *   --rpc <url>                 RPC endpoint. Defaults to SOLANA_RPC_URL, then testnet.
 *   --keypair <path>            default_admin keypair. Required by every mutating subcommand.
 *   --settler <pubkey>          Settler to add/remove.
 *   --send                      Broadcast. Without it nothing is sent.
 *   --allow-empty-allowlist     Override the outage guards described above. Read them first.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
// AccountInfo is a type, and web3.js is CJS: a value import of it is a runtime
// "Named export not found" under ts-node's ESM loader.
import type { AccountInfo } from "@solana/web3.js";
import {
  fetchProtocolConfig,
  formatNullablePubkey,
  loadVerifiedProgramInfo,
} from "./solana-admin-utils.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

// Mirrors ProtocolConfig::MAX_AUTHORIZED_SETTLERS and ::SIZE
// (programs/fulfillment_proxy/src/state.rs:41 and :54) so the arithmetic stays comparable to the Rust
// side line for line: 8 discriminator + 32 default_admin + 32 pauser + 1 paused
// + 4 delay + 33 Option<Pubkey> + 9 Option<i64> + 1 enforce flag + 4 vec len + 32 per settler.
const MAX_AUTHORIZED_SETTLERS = 16;
const PROTOCOL_CONFIG_SIZE =
  8 + 32 + 32 + 1 + 4 + 33 + 9 + 1 + 4 + 32 * MAX_AUTHORIZED_SETTLERS;
const PRE_ALLOWLIST_PROTOCOL_CONFIG_SIZE = 119;

const MUTATING_COMMANDS = [
  "add",
  "remove",
  "enforce-on",
  "enforce-off",
] as const;
type MutatingCommand = (typeof MUTATING_COMMANDS)[number];
type Command = "show" | MutatingCommand;

const USAGE = [
  "Usage:",
  "  fp-settler-allowlist.ts show [--rpc <url>]",
  "  fp-settler-allowlist.ts add    --keypair <admin.json> --settler <pubkey> [--send]",
  "  fp-settler-allowlist.ts remove --keypair <admin.json> --settler <pubkey> [--send]",
  "  fp-settler-allowlist.ts enforce-on  --keypair <admin.json> [--send] [--allow-empty-allowlist]",
  "  fp-settler-allowlist.ts enforce-off --keypair <admin.json> [--send]",
].join("\n");

interface Args {
  command: Command;
  rpcUrl: string;
  keypairPath: string;
  settler: string;
  send: boolean;
  allowEmptyAllowlist: boolean;
}

function loadKeypair(filePath: string): Keypair {
  const resolved = path.resolve(filePath);
  const data = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(data));
}

function isCommand(value: string): value is Command {
  return (
    value === "show" || (MUTATING_COMMANDS as readonly string[]).includes(value)
  );
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const rawCommand = args[0] ?? "";
  if (!isCommand(rawCommand)) {
    throw new Error(
      `${
        rawCommand
          ? `Unknown subcommand "${rawCommand}"`
          : "A subcommand is required"
      }.\n${USAGE}`
    );
  }
  const command: Command = rawCommand;

  let rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.testnet.solana.com";
  let keypairPath = "";
  let settler = "";
  let send = false;
  let allowEmptyAllowlist = false;

  // Unknown flags are rejected rather than ignored: the difference between a dry run and a live
  // enforcement flip is a single flag, so a typo must not be absorbed silently either way.
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--rpc" && args[i + 1]) {
      rpcUrl = args[++i]!;
    } else if (args[i] === "--keypair" && args[i + 1]) {
      keypairPath = args[++i]!;
    } else if (args[i] === "--settler" && args[i + 1]) {
      settler = args[++i]!;
    } else if (args[i] === "--send") {
      send = true;
    } else if (args[i] === "--allow-empty-allowlist") {
      allowEmptyAllowlist = true;
    } else {
      throw new Error(`Unrecognized argument "${args[i]}".\n${USAGE}`);
    }
  }

  if (command === "show") {
    if (keypairPath || send) {
      throw new Error(
        "show is read-only and never signs or sends; --keypair and --send are not accepted here."
      );
    }
  } else if (!keypairPath) {
    throw new Error(
      `--keypair <path-to-default-admin.json> is required for ${command}`
    );
  }

  if (command === "add" || command === "remove") {
    if (!settler)
      throw new Error(`--settler <pubkey> is required for ${command}`);
  } else if (settler) {
    throw new Error(`--settler is not used by ${command}`);
  }

  return { command, rpcUrl, keypairPath, settler, send, allowEmptyAllowlist };
}

/**
 * Decide on the account's byte length before letting Anchor decode it.
 *
 * state.rs:6 records that this struct grew ~119 -> 636 bytes to hold the allowlist, with no realloc and no
 * migration instruction, so a config created by an older program physically cannot hold the
 * allowlist. A short account does not reliably fail the decode: a 119-byte ProtocolConfig has been
 * observed decoding against the 636-byte IDL as "enforcement off, 0 of 16 settlers" — which is
 * indistinguishable from a healthy dormant deployment, and would make this script report success
 * while the fields it printed were fabricated at the wrong offsets.
 */
function assertAllowlistCapableLayout(
  account: AccountInfo<Buffer> | null,
  protocolConfig: PublicKey,
  cluster: string
): void {
  if (account === null) {
    throw new Error(
      `ProtocolConfig ${protocolConfig.toBase58()} does not exist on ${cluster}. The program is ` +
        `deployed but never initialized — run initialize_protocol (scripts/deploy.ts) first.`
    );
  }

  const size = account.data.length;
  if (size === PROTOCOL_CONFIG_SIZE) return;

  if (size < PROTOCOL_CONFIG_SIZE) {
    throw new Error(
      `On-chain ProtocolConfig ${protocolConfig.toBase58()} on ${cluster} is ${size} bytes; this ` +
        `build's ProtocolConfig is ${PROTOCOL_CONFIG_SIZE} bytes.\n` +
        `  That is the pre-allowlist layout${
          size === PRE_ALLOWLIST_PROTOCOL_CONFIG_SIZE
            ? ""
            : " (or another older one)"
        }: the struct grew ~${PRE_ALLOWLIST_PROTOCOL_CONFIG_SIZE} -> ${PROTOCOL_CONFIG_SIZE} bytes ` +
        `to hold enforce_settler_allowlist and the pre-sized authorized_settlers vec (state.rs:6).\n` +
        `  There is intentionally NO realloc and NO migration instruction, so this account cannot ` +
        `hold an allowlist and nothing in this script can fix that.\n` +
        `  The settler allowlist can only be provisioned on a config created at the full size by a ` +
        `fresh redeploy that re-runs initialize_protocol — see docs/operations/deployment.md.\n` +
        `  Refusing to decode rather than reporting fabricated fields.`
    );
  }

  throw new Error(
    `On-chain ProtocolConfig ${protocolConfig.toBase58()} on ${cluster} is ${size} bytes, LARGER ` +
      `than the ${PROTOCOL_CONFIG_SIZE} bytes this checkout expects. The deployed program is ahead ` +
      `of this source tree. Refusing before reading fields at offsets that may have moved.`
  );
}

// No `?? []` fallback: the byte-size gate has already established that this account was created by a
// program carrying the field, so an absent one means the IDL does not describe the deployed program
// and every guard below would be reasoning about a fabricated empty allowlist.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function allowlistOf(state: any): PublicKey[] {
  if (!Array.isArray(state.authorizedSettlers)) {
    throw new Error(
      "Decoded ProtocolConfig has no authorized_settlers array, despite being the expected " +
        `${PROTOCOL_CONFIG_SIZE} bytes. The IDL in target/idl does not match the deployed program.`
    );
  }
  return state.authorizedSettlers as PublicKey[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function printState(state: any, accountSize: number): void {
  const allowlist = allowlistOf(state);
  console.log("  Current on-chain state:");
  console.log(`    account size:               ${accountSize} bytes`);
  console.log(
    `    default_admin:              ${state.defaultAdmin.toBase58()}`
  );
  // A pending transfer means someone else is about to own this control surface; worth seeing before
  // provisioning an allowlist against the outgoing admin.
  console.log(
    `    pending_default_admin:      ${formatNullablePubkey(
      state.pendingDefaultAdmin
    )}`
  );
  console.log(`    paused:                     ${state.paused}`);
  console.log(
    `    enforce_settler_allowlist:  ${state.enforceSettlerAllowlist}` +
      `${
        state.enforceSettlerAllowlist
          ? " (ENFORCED)"
          : " (dormant — strict_fulfill is permissionless)"
      }`
  );
  console.log(
    `    authorized_settlers:        ${allowlist.length} of ${MAX_AUTHORIZED_SETTLERS}`
  );
  for (const [i, settler] of allowlist.entries()) {
    console.log(`      [${i}] ${settler.toBase58()}`);
  }
  if (allowlist.length === 0) {
    console.log("      (empty)");
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function printSemantics(state: any): void {
  const allowlist = allowlistOf(state);
  console.log();
  if (!state.enforceSettlerAllowlist) {
    console.log(
      "  The allowlist is DORMANT here: strict_fulfill accepts any settler, exactly as it did before " +
        "the allowlist shipped."
    );
    console.log(
      allowlist.length === 0
        ? "  Provision the allowlist with `add` BEFORE `enforce-on`; enforcing an empty allowlist " +
            "rejects every strict_fulfill."
        : "  The allowlist is provisioned. `enforce-on` will start rejecting every settler not " +
            "listed above."
    );
  } else {
    console.log(
      `  The allowlist is ENFORCED here: strict_fulfill rejects any settler outside the ${allowlist.length} ` +
        "listed above with UnauthorizedSettler."
    );
    console.log(
      "  `enforce-off` is the instant rollback to permissionless strict_fulfill."
    );
  }
}

/**
 * Guards that must hold before a mutation is worth building. Returns false when the requested change
 * is already the on-chain state, so a no-op is reported instead of being broadcast (all three
 * instructions are idempotent on-chain, and remove_authorized_settler deliberately emits no event for
 * a no-op — sending one would just burn a signature and confuse an indexer's audit trail).
 */
function checkMutationPreconditions(
  command: MutatingCommand,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any,
  settlerPubkey: PublicKey | null,
  allowEmptyAllowlist: boolean
): boolean {
  const allowlist = allowlistOf(state);
  const enforced: boolean = state.enforceSettlerAllowlist;

  if (command === "add") {
    const target = settlerPubkey!;
    if (allowlist.some((s) => s.equals(target))) {
      console.log(
        `  ${target.toBase58()} is already on the allowlist. Nothing to do (add_authorized_settler ` +
          "returns Ok without a state change)."
      );
      return false;
    }
    if (allowlist.length >= MAX_AUTHORIZED_SETTLERS) {
      throw new Error(
        `The allowlist already holds ${allowlist.length} settlers, the MAX_AUTHORIZED_SETTLERS cap. ` +
          `add_authorized_settler would fail with CapacityExceeded. Remove an entry first.`
      );
    }
    return true;
  }

  if (command === "remove") {
    const target = settlerPubkey!;
    if (!allowlist.some((s) => s.equals(target))) {
      console.log(
        `  ${target.toBase58()} is not on the allowlist. Nothing to do (remove_authorized_settler ` +
          "returns Ok and emits no event for a no-op)."
      );
      return false;
    }
    // Emptying a live allowlist is the same outage as enforcing an empty one, reached from the other
    // direction, so it is gated by the same override.
    if (enforced && allowlist.length === 1 && !allowEmptyAllowlist) {
      throw new Error(
        `Refusing to remove the last settler while enforce_settler_allowlist is TRUE.\n` +
          `  ${target.toBase58()} is the only authorized settler, so removing it leaves an empty ` +
          `allowlist under live enforcement and EVERY strict_fulfill would then fail with ` +
          `UnauthorizedSettler. That is an outage.\n` +
          `  Either run \`enforce-off\` first (instant rollback to permissionless strict_fulfill), ` +
          `\`add\` the replacement settler first, or pass --allow-empty-allowlist if the outage is ` +
          `the intent.`
      );
    }
    return true;
  }

  if (command === "enforce-on") {
    if (enforced) {
      console.log(
        "  enforce_settler_allowlist is already true. Nothing to do."
      );
      return false;
    }
    if (allowlist.length === 0 && !allowEmptyAllowlist) {
      throw new Error(
        `Refusing to enable enforcement with an EMPTY allowlist.\n` +
          `  The allowlist check runs ahead of every other strict_fulfill guard ` +
          `(instructions/fulfillment.rs:59), so with no authorized settlers EVERY strict_fulfill ` +
          `would fail with UnauthorizedSettler. On a live deployment that is an outage, not a ` +
          `tightening.\n` +
          `  Run \`add --settler <pubkey>\` for each settler first, confirm with \`show\`, then ` +
          `\`enforce-on\`.\n` +
          `  Pass --allow-empty-allowlist only if a total strict_fulfill freeze is the intent.`
      );
    }
    return true;
  }

  if (!enforced) {
    console.log(
      "  enforce_settler_allowlist is already false (dormant). Nothing to do."
    );
    return false;
  }
  return true;
}

function buildMethod(
  // `any` matches fetchProtocolConfig's own signature in solana-admin-utils.ts: the IDL is loaded
  // untyped, so Program<any>.methods is an index signature and every call site would need a
  // non-null assertion for nothing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  program: any,
  command: MutatingCommand,
  settlerPubkey: PublicKey | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  switch (command) {
    case "add":
      return program.methods.addAuthorizedSettler(settlerPubkey!);
    case "remove":
      return program.methods.removeAuthorizedSettler(settlerPubkey!);
    case "enforce-on":
      return program.methods.setEnforceSettlerAllowlist(true);
    case "enforce-off":
      return program.methods.setEnforceSettlerAllowlist(false);
  }
}

async function main(): Promise<void> {
  const { command, rpcUrl, keypairPath, settler, send, allowEmptyAllowlist } =
    parseArgs();
  const settlerPubkey = settler ? new PublicKey(settler) : null;
  // Any 32 well-formed base58 bytes parse as a PublicKey, including ones that are
  // certainly mistakes. Allowlisting one of those fills the allowlist without
  // authorising anything, so the emptiness guard below would then happily let
  // enforcement be turned on -- and every strict_fulfill would be rejected.
  if (settlerPubkey) {
    const rejected = new Map<string, string>([
      [PublicKey.default.toBase58(), "the all-zero default pubkey"],
      [SystemProgram.programId.toBase58(), "the System program"],
      ["SysvarC1ock11111111111111111111111111111111", "the clock sysvar"],
    ]);
    const why = rejected.get(settlerPubkey.toBase58());
    if (why) {
      throw new Error(
        `--settler is ${why} (${settlerPubkey.toBase58()}), which cannot sign a ` +
          `strict_fulfill. Allowlisting it would fill the allowlist without ` +
          `authorising anything, and the empty-allowlist guard would then let ` +
          `enforcement be enabled with every fulfilment rejected.`
      );
    }
  }
  const connection = new Connection(rpcUrl, "confirmed");

  // show must not need a key to read; mutations sign with the admin keypair.
  const adminKeypair = keypairPath ? loadKeypair(keypairPath) : null;
  const wallet = new anchor.Wallet(adminKeypair ?? Keypair.generate());
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

  console.log(`FulfillmentProxy: settler allowlist — ${command}`);
  console.log(`  Cluster:        ${fpInfo.cluster}`);
  console.log(`  Program:        ${fpInfo.programId.toBase58()}`);
  console.log(`  ProtocolConfig: ${protocolConfig.toBase58()}`);
  console.log(`  RPC:            ${rpcUrl}`);
  if (adminKeypair) {
    console.log(`  Admin signer:   ${adminKeypair.publicKey.toBase58()}`);
  }
  if (settlerPubkey) {
    console.log(`  Settler:        ${settlerPubkey.toBase58()}`);
  }
  console.log();

  const account = await connection.getAccountInfo(protocolConfig, "finalized");
  assertAllowlistCapableLayout(account, protocolConfig, fpInfo.cluster);

  const state = await fetchProtocolConfig(
    program,
    protocolConfig,
    fpInfo.label
  );
  printState(state, account!.data.length);

  if (command === "show") {
    printSemantics(state);
    return;
  }

  if (!state.defaultAdmin.equals(adminKeypair!.publicKey)) {
    throw new Error(
      `Signer ${adminKeypair!.publicKey.toBase58()} is not live default_admin ${state.defaultAdmin.toBase58()}`
    );
  }

  console.log();
  if (
    !checkMutationPreconditions(
      command,
      state,
      settlerPubkey,
      allowEmptyAllowlist
    )
  ) {
    return;
  }
  if (allowEmptyAllowlist) {
    console.log(
      "  --allow-empty-allowlist given: the empty-allowlist outage guard is OFF for this run."
    );
  }

  const builder = buildMethod(program, command, settlerPubkey).accountsPartial({
    defaultAdmin: adminKeypair!.publicKey,
    protocolConfig,
  });

  if (!send) {
    // Build the instruction without submitting it: this resolves the accounts and encodes the args
    // for real, so a dry run still catches a bad account set rather than only a bad argument.
    const ix = await builder.instruction();
    console.log("  Would send:");
    console.log(`    program:   ${ix.programId.toBase58()}`);
    console.log(
      `    data:      ${ix.data.length} bytes (${ix.data.toString("hex")})`
    );
    for (const key of ix.keys) {
      console.log(
        `    account:   ${key.pubkey.toBase58()}` +
          `${key.isSigner ? " signer" : ""}${key.isWritable ? " writable" : ""}`
      );
    }
    console.log();
    console.log(
      "  DRY RUN — nothing was sent. Re-run with --send to broadcast."
    );
    return;
  }

  const tx = await builder.rpc();
  console.log(`  Transaction: ${tx}`);
  console.log();

  // Read back at the SAME commitment the send confirmed at. `builder.rpc()`
  // confirms at the connection's commitment ("confirmed"); reading at "finalized"
  // asks for a stricter view that lags by ~13 slots, so this verification could
  // report the OLD state and announce a failure for a transaction that landed.
  const after = await connection.getAccountInfo(protocolConfig, "confirmed");
  assertAllowlistCapableLayout(after, protocolConfig, fpInfo.cluster);
  const newState = await fetchProtocolConfig(
    program,
    protocolConfig,
    fpInfo.label
  );
  printState(newState, after!.data.length);
  printSemantics(newState);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
