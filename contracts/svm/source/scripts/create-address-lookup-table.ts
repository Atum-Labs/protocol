#!/usr/bin/env ts-node

/**
 * Create (or extend) the per-cluster Address Lookup Table the v4 deposit + reserve transaction needs.
 *
 * WHY THIS EXISTS. A legacy Solana transaction caps at PACKET_DATA_SIZE = 1232 bytes. A v4 deposit
 * fits on its own, but deposit and reserve in one transaction, each with its signed-text ed25519
 * instruction, do not: `--measure` puts it at 1373 bytes with one signature. The overrun is not a
 * clean error: it surfaces as `RangeError: encoding overruns Uint8Array` thrown inside
 * `simulateTransaction`, naming neither the limit nor the field that grew. An ALT replaces each
 * tabled 32-byte account key with a 1-byte index and buys that room back (1192 bytes with the table).
 *
 * ORDERING. Run this AFTER the program-id flip (deploy guide step 6a), never before. The table is
 * keyed on the escrow program id: run it against the old id and it holds the old `protocol_config`
 * PDA — a plausible-looking table that is silently wrong on every deposit, because the PDA it
 * caches is one no v4 deposit ever references. This script therefore prints the escrow id and the
 * `protocol_config` PDA prominently and refuses to proceed unless that PDA exists, is owned by the
 * escrow program, has the v4 216-byte layout AND reports signature_domain_version 5. The last check
 * is the one that catches a stale cluster: devnet's retired escrow satisfies the first three.
 *
 * Usage:
 *   # 1. offline: what deposit + reserve costs and what the table buys back
 *   npx ts-node scripts/create-address-lookup-table.ts --measure
 *
 *   # 2. rehearse against the live cluster — reads only, sends nothing
 *   npx ts-node scripts/create-address-lookup-table.ts --dry-run --mint <MINT>
 *
 *   # 3. create and extend (--keypair is what authorises sending)
 *   npx ts-node scripts/create-address-lookup-table.ts \
 *     --keypair <path> --mint <MINT> --rpc <url>
 *
 *   # add a mint later without recreating the table
 *   npx ts-node scripts/create-address-lookup-table.ts \
 *     --keypair <path> --table <existing> --mint <new-mint>
 *
 * Flags:
 *   --measure                 Offline size report. No RPC, no keypair, no transaction.
 *   --dry-run                 Read the cluster, print the plan, send nothing.
 *   --mint <address>          SPL mint to table (repeatable).
 *   --table <address>         Extend this existing table instead of creating one.
 *   --keypair <path>          Table authority + fee payer. Required to send anything.
 *   --rpc <url>               Defaults to $SOLANA_RPC_URL, then devnet.
 *   --allow-unverified-mint   Table a mint that is absent or not owned by a token program.
 *
 * Environment:
 * - ESCROW_ID: Escrow program id for the target cluster (REQUIRED, no default)
 * - FP_ID: FulfillmentProxy program id for the target cluster (REQUIRED, no default)
 * - ALLOW_RETIRED_PROGRAM_IDS: "true" to permit the v1/v3 ids, which are otherwise refused
 * - SOLANA_RPC_URL / SOLANA_WS_URL: endpoints, as everywhere else in scripts/
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import {
  fetchProtocolConfig,
  formatNullablePubkey,
  getProtocolConfigAddress,
  resolveAnchorCluster,
} from "./solana-admin-utils.ts";
import {
  ED25519_PROGRAM_ID,
  ESCROW_LABEL_DEPOSIT,
  ESCROW_LABEL_RESERVE,
  ESCROW_MESSAGE_FORMS,
  escrowEd25519Instruction,
  escrowMessage,
  type EscrowLabel,
  type EscrowMessageForm,
} from "../../bindings/typescript/escrow-encoding/src/signed-text.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

// Program IDs.
//
// Same trap, same refusal as deploy.ts. Anchor.toml (and therefore target/idl/*.json, which is
// stamped from it) still carries the retired v1/v3 ids on every cluster, so resolving the escrow id
// from either of those files would produce a table for the OLD program with no error anywhere: the
// retired programs are deployed and initialised on devnet, testnet AND mainnet, so every
// "does it exist on chain" check passes. That is why loadVerifiedProgramInfo() is deliberately not
// used here — it cross-checks Anchor.toml against the IDL, and those two agree on exactly the wrong
// id. The ids come from ESCROW_ID / FP_ID with no fallback instead.
const RETIRED_PROGRAM_IDS = new Map<string, string>([
  ["44DjKbs1uV3uq26HjJLY67EXuVvwCbBoSUC2tDBWbkrs", "v1/v3 Escrow"],
  ["77AqGeSh3GLFcBwSxdTnefgv92Cosi9o6NsK992TZsRe", "v1/v3 FulfillmentProxy"],
]);

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

// 8 discriminator + 4 x 32 roles + 1 paused + 32 cluster_id + 1 signature_domain_version
// + 4 default_admin_delay_seconds + 33 Option<Pubkey> + 9 Option<i64> = 216.
// Mirrors programs/escrow/src/state.rs::ProtocolConfig and the deploy guide's verification table.
// Checked by size BEFORE any Anchor decode: a v1/v3 ProtocolConfig is 119 bytes and decoding it
// with the v4 IDL FABRICATES fields rather than failing, so a size assertion is the only thing that
// distinguishes "flipped" from "plausible garbage".
const ESCROW_PROTOCOL_CONFIG_SIZE = 216;

// Expected ProtocolConfig::signature_domain_version for v4, stamped at initialize_protocol with no
// setter. This is the FOURTH place the number is written down (after
// programs/escrow/src/state.rs, the Go/TS encoders, and deploy.ts) and the drift is real — see the
// note in deploy-local.ts about deriving it from the IDL instead.
//
// It is checked here because ESCROW_PROTOCOL_CONFIG_SIZE alone does NOT separate a v4 deployment
// from an older one: the retired devnet escrow's config is also 216 bytes and decodes cleanly, and
// only reports version 2. Size catches a fabricated decode; the version catches the wrong
// deployment. Both are needed.
const ESCROW_SIGNATURE_DOMAIN_VERSION = 5;

// Address lookup table account: 56-byte metadata prefix, then 32 bytes per address.
const LOOKUP_TABLE_META_SIZE = 56;
const LOOKUP_TABLE_MAX_ADDRESSES = 256;
// One extend instruction carries 32 bytes per address plus the table, authority and payer keys;
// 20 keeps a single extend transaction comfortably inside the same 1232-byte limit this table
// exists to work around. The deployment-static set is far smaller than this today.
const EXTEND_CHUNK_SIZE = 20;

// ─── Size model constants ────────────────────────────────────────────────────
//
// These describe the transaction whose size is being reported. They are the ESTIMATED half of
// --measure: the shape of the deposit + reserve the settler sends. The encoding of that shape is measured.

// tests/helpers.ts DEPOSIT_COMPUTE_UNIT_LIMIT. Every deposit must raise the limit or it exceeds
// the 200k default, so the instruction is part of the transaction's size.
const MODEL_COMPUTE_UNIT_LIMIT = 400_000;
// A priority fee is not in the test path but any client on a live cluster sets one, and leaving it
// out would understate the size — the dangerous direction. ~12 bytes.
const MODEL_COMPUTE_UNIT_PRICE = 1_000;
// The deposit signature is modelled in its longest accepted form and the reserve one bare, the
// form payment-gw's selector key signs. Both are built by the escrow-encoding signed-text builder.
// A payer that signs its own reserve (awardQuote with no selectorSigner) may send it in any accepted
// form, so the report also measures the worst case, a v0 reserve.
const MODEL_RESERVE_SIGNATURE_FORM: EscrowMessageForm = "bare";
const WORST_RESERVE_SIGNATURE_FORM: EscrowMessageForm = "v0";

interface Args {
  mode: "measure" | "dry-run" | "send";
  rpcUrl: string;
  keypairPath: string;
  mints: string[];
  table: string;
  allowUnverifiedMint: boolean;
}

export interface TabledAddress {
  address: PublicKey;
  label: string;
}

export interface StaticAddressArgs {
  escrowProgramId: PublicKey;
  fulfillmentProxyProgramId: PublicKey;
  /** SPL mints this cluster will transact. Each contributes two entries. */
  mints: PublicKey[];
  /**
   * Token programs the mints are owned by. Defaults to legacy SPL Token; the caller passes the
   * owners it actually observed on chain so a Token-2022 mint's program id gets tabled too.
   */
  tokenPrograms?: PublicKey[];
}

/**
 * The accounts that are byte-identical on EVERY deposit, and therefore the only ones worth tabling
 * at deployment time.
 *
 * WHAT IS DELIBERATELY ABSENT, AND WHY. The depositor, reserver, releaser, payer, the deposit PDA,
 * the replay bucket, the per-owner ATAs and `escrow_delegate` all vary per transaction — per
 * deposit hash, per nonce, per authority. Tabling them is not merely useless (a v0 message can only
 * dereference an address the table already holds, so a fresh deposit's keys would still ride as 32
 * raw bytes); it is misleading, because the table then reads as if it covered the whole account
 * list and costs 32 bytes of rent per dead entry.
 *
 * tests/03_deposit_lifecycle.ts:443-488 tables exactly those accounts, and is right to: it builds
 * the table inside one test, for one deposit whose keys it has already derived, and throws it away
 * afterwards. A deployment-time table cannot know them, and re-creating a table per deposit would
 * cost a create+extend transaction plus a slot of warm-up before every single deposit.
 *
 * The program ids are a subtler case. A v0 message must keep the program id of every instruction it
 * INVOKES in its static keys — the runtime rejects a program id resolved through a lookup table,
 * and @solana/web3.js's compiler skips invoked keys when it extracts a table lookup. So tabling the
 * escrow and fulfillment_proxy ids buys nothing on the transactions that call them; it pays off
 * only where an id rides as a plain account (escrow as the CPI target account of a proxy fulfill,
 * for instance) and costs nothing otherwise. That is why --measure reports how many entries the v0
 * encoder actually dereferenced instead of assuming all of them were.
 */
export function staticAddresses(args: StaticAddressArgs): TabledAddress[] {
  const tokenPrograms = args.tokenPrograms?.length
    ? args.tokenPrograms
    : [TOKEN_PROGRAM_ID];

  const entries: TabledAddress[] = [
    {
      address: getProtocolConfigAddress(args.escrowProgramId),
      label: "escrow protocol_config PDA",
    },
    { address: SYSVAR_INSTRUCTIONS_PUBKEY, label: "instructions sysvar" },
    { address: SystemProgram.programId, label: "system program" },
    ...tokenPrograms.map((programId) => ({
      address: programId,
      label: programId.equals(TOKEN_2022_PROGRAM_ID)
        ? "token-2022 program"
        : "token program",
    })),
    {
      address: ASSOCIATED_TOKEN_PROGRAM_ID,
      label: "associated token program",
    },
    { address: args.escrowProgramId, label: "escrow program" },
    {
      address: args.fulfillmentProxyProgramId,
      label: "fulfillment_proxy program",
    },
  ];

  for (const mint of args.mints) {
    entries.push({ address: mint, label: `mint ${mint.toBase58()}` });
    entries.push({
      address: getMintFeeConfigAddress(args.escrowProgramId, mint),
      label: `mint_fee_config PDA (${mint.toBase58()})`,
    });
  }

  return dedupeAddresses(entries);
}

export function getMintFeeConfigAddress(
  escrowProgramId: PublicKey,
  mint: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_fee_config"), mint.toBuffer()],
    escrowProgramId
  );
  return pda;
}

function getProgramDataAddress(programId: PublicKey): PublicKey {
  const [programData] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID
  );
  return programData;
}

function dedupeAddresses(entries: TabledAddress[]): TabledAddress[] {
  const seen = new Set<string>();
  const unique: TabledAddress[] = [];
  for (const entry of entries) {
    const key = entry.address.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function requireProgramId(envVar: string, label: string): PublicKey {
  const raw = process.env[envVar]?.trim();
  if (!raw) {
    throw new Error(
      `${envVar} is not set, and there is no default. It is the ${label} program id for the ` +
        `cluster whose table you are building.\n` +
        `  Set it in "\${ATUM_HOME:-$HOME/.atum}/env/svm.env" and source that file.\n` +
        `  Resolving it from Anchor.toml instead would silently table the retired v1/v3 program.`
    );
  }
  let id: PublicKey;
  try {
    id = new PublicKey(raw);
  } catch {
    throw new Error(`${envVar}="${raw}" is not a valid base58 Solana address`);
  }
  const retired = RETIRED_PROGRAM_IDS.get(id.toBase58());
  if (
    retired &&
    process.env.ALLOW_RETIRED_PROGRAM_IDS?.toLowerCase() !== "true"
  ) {
    throw new Error(
      `${envVar} names ${id.toBase58()}, which is the ${retired} program id.\n` +
        `  Those programs are live on devnet, testnet AND mainnet, so a table built for them ` +
        `looks healthy: the protocol_config PDA exists and is initialised, only no v4 deposit ` +
        `will ever reference it.\n` +
        `  If you genuinely mean to operate on the retired programs, set ` +
        `ALLOW_RETIRED_PROGRAM_IDS=true.`
    );
  }
  return id;
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
  let table = "";
  let measure = false;
  let dryRun = false;
  let send = false;
  let allowUnverifiedMint = false;
  const mints: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rpc" && args[i + 1]) {
      rpcUrl = args[++i]!;
    } else if (args[i] === "--keypair" && args[i + 1]) {
      keypairPath = args[++i]!;
    } else if (args[i] === "--mint" && args[i + 1]) {
      mints.push(args[++i]!);
    } else if (args[i] === "--table" && args[i + 1]) {
      table = args[++i]!;
    } else if (args[i] === "--measure") {
      measure = true;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (args[i] === "--send") {
      send = true;
    } else if (args[i] === "--allow-unverified-mint") {
      allowUnverifiedMint = true;
    } else {
      throw new Error(
        `Unrecognised argument "${args[i]}". Supported: --measure, --dry-run, --mint <address>, ` +
          `--table <address>, --keypair <path>, --rpc <url>, --allow-unverified-mint.`
      );
    }
  }

  if (measure && (keypairPath || dryRun || table)) {
    // --measure is arithmetic on an offline model. Combining it with the flags that decide
    // whether something is sent leaves the operator guessing which happened.
    throw new Error(
      "--measure is offline and sends nothing. Run it on its own (optionally with --mint), " +
        "then re-run without --measure to rehearse or create."
    );
  }

  // Dry by default, and sending needs BOTH --keypair (the table authority and fee
  // payer) and an explicit --send. --keypair alone used to be enough, which made
  // this script disagree with its sibling fp-settler-allowlist.ts, where --keypair
  // builds and --send broadcasts. Two admin scripts in the same directory with
  // opposite meanings for the same flag is how someone broadcasts by accident after
  // learning the other one.
  const mode: Args["mode"] = measure
    ? "measure"
    : keypairPath && send && !dryRun
    ? "send"
    : "dry-run";

  if (keypairPath && !send && !dryRun && !measure) {
    console.log(
      "Note: --keypair given without --send, so this is a rehearsal and nothing will be\n" +
        "      created. Add --send to broadcast."
    );
  }

  if (mode === "send" && mints.length === 0 && !table) {
    throw new Error(
      "--mint <address> is required (repeat for more than one): a table with no mint accounts " +
        "saves almost nothing, and the per-mint entries are the point."
    );
  }
  return { mode, rpcUrl, keypairPath, mints, table, allowUnverifiedMint };
}

// ─── Deposit size model ──────────────────────────────────────────────────────

interface IdlAccount {
  name: string;
  address?: string;
  writable?: boolean;
  signer?: boolean;
}

interface IdlArg {
  name: string;
  type: unknown;
}

interface IdlInstruction {
  name: string;
  accounts: IdlAccount[];
  args: IdlArg[];
  discriminator: number[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadEscrowIdl(): any {
  const idlPath = path.join(REPO_ROOT, "target", "idl", "escrow.json");
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL not found at ${idlPath}. Run 'anchor build' first.`);
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf-8"));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function escrowInstruction(idl: any, name: string): IdlInstruction {
  const ix = (idl.instructions as IdlInstruction[] | undefined)?.find(
    (candidate) => candidate.name === name
  );
  if (!ix) {
    throw new Error(
      `target/idl/escrow.json has no \`${name}\` instruction. The size model is derived from it, ` +
        "so there is nothing to measure — rebuild the IDL."
    );
  }
  return ix;
}

/**
 * Byte width of an IDL type. Throws on anything it cannot size rather than guessing: a wrong width
 * here becomes a confident headroom number that is wrong in the direction that fails in production.
 */
function idlTypeSize(type: unknown): number {
  if (typeof type === "string") {
    switch (type) {
      case "bool":
      case "u8":
      case "i8":
        return 1;
      case "u16":
      case "i16":
        return 2;
      case "u32":
      case "i32":
        return 4;
      case "u64":
      case "i64":
        return 8;
      case "u128":
      case "i128":
        return 16;
      case "pubkey":
      case "publicKey":
        return 32;
      default:
        throw new Error(`Cannot size IDL type "${type}"; refusing to guess`);
    }
  }
  if (typeof type === "object" && type !== null && "array" in type) {
    const array = (type as { array: [unknown, number] }).array;
    return idlTypeSize(array[0]) * array[1];
  }
  throw new Error(
    `Cannot size IDL type ${JSON.stringify(type)}; refusing to guess`
  );
}

function instructionDataLength(ix: IdlInstruction): number {
  return ix.args.reduce(
    (total, arg) => total + idlTypeSize(arg.type),
    ix.discriminator.length
  );
}

/**
 * A stand-in key for an account that varies per deposit. Derived rather than random so two runs
 * report identical byte counts.
 */
function placeholderKey(name: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("alt-size-model"), Buffer.from(name)],
    SystemProgram.programId
  );
  return pda;
}

interface ModelContext {
  escrowProgramId: PublicKey;
  protocolConfig: PublicKey;
  mint: PublicKey;
  mintFeeConfig: PublicKey;
  tokenProgram: PublicKey;
}

/**
 * Resolve one IDL account of `deposit` to the key the model will use.
 *
 * Accounts the IDL pins to a fixed address are cross-checked against the constants
 * staticAddresses() tables, so a drift between the two shows up here instead of as a table that
 * caches the wrong sysvar.
 */
function modelAccountKey(account: IdlAccount, ctx: ModelContext): PublicKey {
  if (account.address) {
    const pinned = new PublicKey(account.address);
    const expected = new Map<string, PublicKey>([
      ["associated_token_program", ASSOCIATED_TOKEN_PROGRAM_ID],
      ["system_program", SystemProgram.programId],
      ["instructions", SYSVAR_INSTRUCTIONS_PUBKEY],
    ]).get(account.name);
    if (expected && !expected.equals(pinned)) {
      throw new Error(
        `IDL pins deposit account "${
          account.name
        }" to ${pinned.toBase58()}, but this script ` +
          `tables ${expected.toBase58()}. One of the two is wrong; the table would cache an ` +
          `address no deposit references.`
      );
    }
    return pinned;
  }
  switch (account.name) {
    case "protocol_config":
      return ctx.protocolConfig;
    case "mint":
      return ctx.mint;
    case "mint_fee_config":
      return ctx.mintFeeConfig;
    case "token_program":
      return ctx.tokenProgram;
    default:
      return placeholderKey(account.name);
  }
}

/** An Ed25519SigVerify instruction carrying `label` text in `form`, with a zero signature. */
function escrowSigInstruction(
  label: EscrowLabel,
  form: EscrowMessageForm,
  signer: string
): TransactionInstruction {
  const publicKey = placeholderKey(signer).toBytes();
  const message = escrowMessage(form, label, new Uint8Array(32), publicKey);
  return new TransactionInstruction({
    programId: new PublicKey(ED25519_PROGRAM_ID),
    keys: [],
    data: Buffer.from(
      escrowEd25519Instruction(form, publicKey, message, new Uint8Array(64))
    ),
  });
}

/** The deposit signature instruction in the accepted form with the most bytes. */
function longestDepositSigInstruction(): {
  form: EscrowMessageForm;
  ix: TransactionInstruction;
} {
  return ESCROW_MESSAGE_FORMS.map((form) => ({
    form,
    ix: escrowSigInstruction(ESCROW_LABEL_DEPOSIT, form, "delegate_signer"),
  })).reduce((a, b) => (b.ix.data.length > a.ix.data.length ? b : a));
}

interface SizeReport {
  staticKeyCount: number;
  legacyMessageBytes: number;
  v0MessageBytes: number;
  dereferenced: number;
  /** Table entries the v0 encoder did NOT use, with the reason visible in the label. */
  unusedLabels: string[];
  tabledCount: number;
}

// What a v0 message pays for one lookup table, over and above the legacy encoding: 32 bytes of
// table key, one compact-u16 count each for the writable and readonly index lists, one compact-u16
// count for the lookups vector itself, and the 1-byte version prefix. Each dereferenced address
// then costs 1 index byte instead of 32 in the static keys, i.e. saves 31.
const V0_TABLE_OVERHEAD_BYTES = 32 + 1 + 1 + 1 + 1;
const BYTES_SAVED_PER_DEREFERENCED_ADDRESS = 31;

/**
 * Compile the modelled deposit + reserve both ways and report the real serialized byte counts.
 *
 * The account list, the account flags and the argument widths all come from the escrow IDL, and the
 * encoding is done by the same @solana/web3.js compiler the settler uses — so the ALT accounting
 * (which keys are dereferenced, which must stay in static keys) is measured rather than asserted.
 */
function measureDepositReserve(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  idl: any,
  ctx: ModelContext,
  tabled: TabledAddress[],
  reserveForm: EscrowMessageForm = MODEL_RESERVE_SIGNATURE_FORM
): SizeReport {
  const ix = escrowInstruction(idl, "deposit");
  const reserveIx = escrowInstruction(idl, "reserve");
  const keysOf = (instruction: IdlInstruction) =>
    instruction.accounts.map((account) => ({
      pubkey: modelAccountKey(account, ctx),
      isSigner: account.signer === true,
      isWritable: account.writable === true,
    }));

  const payerAccount = ix.accounts.find((account) => account.signer === true);
  if (!payerAccount) {
    throw new Error(
      "deposit has no signer account in the IDL; the model has no fee payer to compile against"
    );
  }
  const payerKey = modelAccountKey(payerAccount, ctx);

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: MODEL_COMPUTE_UNIT_LIMIT,
    }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: MODEL_COMPUTE_UNIT_PRICE,
    }),
    longestDepositSigInstruction().ix,
    new TransactionInstruction({
      programId: ctx.escrowProgramId,
      keys: keysOf(ix),
      data: Buffer.alloc(instructionDataLength(ix)),
    }),
    escrowSigInstruction(ESCROW_LABEL_RESERVE, reserveForm, "reserver"),
    new TransactionInstruction({
      programId: ctx.escrowProgramId,
      keys: keysOf(reserveIx),
      data: Buffer.alloc(instructionDataLength(reserveIx)),
    }),
  ];

  const message = new TransactionMessage({
    payerKey,
    // Any 32-byte value: only its length reaches the wire.
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  });

  const lookupTable = new AddressLookupTableAccount({
    key: placeholderKey("lookup_table"),
    state: {
      deactivationSlot: BigInt("0xffffffffffffffff"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: tabled.map((entry) => entry.address),
    },
  });

  const legacy = message.compileToLegacyMessage();
  const v0 = message.compileToV0Message([lookupTable]);
  const usedIndexes = new Set<number>();
  for (const lookup of v0.addressTableLookups) {
    for (const index of lookup.writableIndexes) usedIndexes.add(index);
    for (const index of lookup.readonlyIndexes) usedIndexes.add(index);
  }

  return {
    staticKeyCount: legacy.accountKeys.length,
    legacyMessageBytes: legacy.serialize().length,
    v0MessageBytes: v0.serialize().length,
    dereferenced: usedIndexes.size,
    unusedLabels: tabled
      .filter((_, index) => !usedIndexes.has(index))
      .map((entry) => entry.label),
    tabledCount: tabled.length,
  };
}

/** Wire size of a transaction: compact-u16 signature count, the signatures, then the message. */
function transactionBytes(messageBytes: number, signatures: number): number {
  return 1 + 64 * signatures + messageBytes;
}

function printSizeReport(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  idl: any,
  ctx: ModelContext,
  tabled: TabledAddress[]
): void {
  const report = measureDepositReserve(idl, ctx, tabled);
  const rentBytes = LOOKUP_TABLE_META_SIZE + 32 * tabled.length;

  console.log("Deposit + reserve transaction size");
  console.log(
    `  MEASURED — both encodings serialized by @solana/web3.js, exact for the shape below:`
  );
  console.log(`    static account keys (legacy):  ${report.staticKeyCount}`);
  console.log(`    addresses in the table:        ${report.tabledCount}`);
  console.log(
    `    of those, dereferenced by v0:  ${report.dereferenced} of ${report.tabledCount}`
  );
  for (const label of report.unusedLabels) {
    // Not a defect: an invoked program id may not be resolved through a table, and an entry this
    // transaction does not touch still earns its place for the flows that do. Named so the operator
    // can tell those two cases apart instead of reading a bare count.
    console.log(`      not used by this transaction: ${label}`);
  }
  console.log(
    `    legacy message:                ${report.legacyMessageBytes} bytes`
  );
  console.log(
    `    v0 message + 1 table:          ${report.v0MessageBytes} bytes`
  );
  const saved = report.legacyMessageBytes - report.v0MessageBytes;
  const predicted =
    report.dereferenced * BYTES_SAVED_PER_DEREFERENCED_ADDRESS -
    V0_TABLE_OVERHEAD_BYTES;
  console.log(`    bytes saved (measured):        ${saved}`);
  console.log(
    `    arithmetic check:              ${report.dereferenced} x ` +
      `${BYTES_SAVED_PER_DEREFERENCED_ADDRESS} - ${V0_TABLE_OVERHEAD_BYTES} = ${predicted}` +
      (saved === predicted
        ? ""
        : "   MISMATCH — trust the measured number, not this one")
  );
  if (saved <= 0) {
    console.log(
      `    WARNING: the table costs more than it saves at this shape. Below two dereferenced ` +
        `addresses the ${V0_TABLE_OVERHEAD_BYTES}-byte table overhead wins.`
    );
  }

  console.log();
  console.log(
    `  ESTIMATED — the SHAPE of the transaction, not its encoding. Account list, account flags`
  );
  console.log(
    `  and argument widths come from target/idl/escrow.json; the rest is assumed:`
  );
  console.log(
    `    deposit signature:             ${
      longestDepositSigInstruction().form
    } escrow text (longest accepted form)`
  );
  console.log(
    `    reserve signature:             ${MODEL_RESERVE_SIGNATURE_FORM} escrow text`
  );
  console.log(
    `    compute-budget instructions:   2 (unit limit ${MODEL_COMPUTE_UNIT_LIMIT}, unit price ${MODEL_COMPUTE_UNIT_PRICE})`
  );
  console.log(`    no ATA-creation or memo instruction, no durable nonce`);

  console.log();
  console.log(`  TOTAL against the ${PACKET_DATA_SIZE}-byte packet limit:`);
  console.log("    signatures  legacy      headroom   with table  headroom");
  for (const signatures of [1, 2]) {
    const legacyTotal = transactionBytes(report.legacyMessageBytes, signatures);
    const v0Total = transactionBytes(report.v0MessageBytes, signatures);
    console.log(
      `    ${String(signatures).padEnd(11)} ` +
        `${String(legacyTotal).padEnd(11)} ` +
        `${String(PACKET_DATA_SIZE - legacyTotal).padStart(5)}      ` +
        `${String(v0Total).padEnd(11)} ` +
        `${String(PACKET_DATA_SIZE - v0Total).padStart(5)}`
    );
  }
  const worst = measureDepositReserve(
    idl,
    ctx,
    tabled,
    WORST_RESERVE_SIGNATURE_FORM
  );
  const worstTotal = transactionBytes(worst.v0MessageBytes, 1);
  console.log(
    `    worst case, ${WORST_RESERVE_SIGNATURE_FORM} reserve, 1 signature, with table: ${worstTotal} ` +
      (worstTotal > PACKET_DATA_SIZE
        ? `— OVER by ${
            worstTotal - PACKET_DATA_SIZE
          }: a payer that signs its own reserve as a ` +
          `${WORST_RESERVE_SIGNATURE_FORM} off-chain message (a Ledger) is refused after the award`
        : `— fits, headroom ${PACKET_DATA_SIZE - worstTotal}`)
  );
  console.log();
  console.log(
    `  Table account size: ${rentBytes} bytes (${LOOKUP_TABLE_META_SIZE} metadata + 32 x ` +
      `${tabled.length})`
  );
  console.log(
    `  NOT MEASURED: the settler's real instruction list, its signer count, and whether it passes`
  );
  console.log(
    `  the table at BOTH compileToV0Message() sites (send AND simulation — a mismatch lets an`
  );
  console.log(`  overrun pass simulation and fail on send).`);
}

// ─── Cluster checks ──────────────────────────────────────────────────────────

async function inspectEscrowProgram(
  connection: Connection,
  escrowProgramId: PublicKey,
  rpcUrl: string
): Promise<void> {
  const account = await connection.getAccountInfo(escrowProgramId, "finalized");
  if (!account) {
    throw new Error(
      `Escrow program ${escrowProgramId.toBase58()} is not deployed on ${rpcUrl}. ` +
        `The table is derived from this id, so there is nothing to build a table for yet.`
    );
  }
  if (!account.executable) {
    throw new Error(
      `Escrow program ${escrowProgramId.toBase58()} exists on ${rpcUrl} but is not executable`
    );
  }
  console.log(
    `    program account: owner ${account.owner.toBase58()}, ${
      account.data.length
    } bytes`
  );

  // The last-deployed slot is the cheapest evidence that the program-id flip has happened: a slot
  // that predates the v4 deploy means this id is not the program you just shipped.
  const programData = await connection.getAccountInfo(
    getProgramDataAddress(escrowProgramId),
    "finalized"
  );
  if (!programData) {
    console.log(`    ProgramData:     none — not an upgradeable program`);
    return;
  }
  // ProgramData layout: 4-byte enum, 8-byte slot, 1-byte Option<Pubkey>, 32-byte authority.
  const slot = Number(programData.data.readBigUInt64LE(4));
  const hasAuthority = programData.data[12] === 1;
  const authority = hasAuthority
    ? new PublicKey(programData.data.subarray(13, 45)).toBase58()
    : "NONE (immutable)";
  console.log(
    `    last deployed in slot ${slot}, upgrade authority ${authority}`
  );
}

/**
 * Refuse unless the escrow's protocol_config exists, belongs to this program id and has the v4
 * layout. This is the ordering gate: an uninitialised (or wrong-layout) config means the flip has
 * not happened, and a table built now caches a PDA no deposit will reference.
 */
async function requireProtocolConfig(
  connection: Connection,
  escrowProgramId: PublicKey,
  protocolConfig: PublicKey,
  rpcUrl: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  idl: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const account = await connection.getAccountInfo(protocolConfig, "finalized");
  if (!account) {
    throw new Error(
      `protocol_config PDA ${protocolConfig.toBase58()} does not exist on ${rpcUrl}.\n` +
        `  Either the escrow program at ${escrowProgramId.toBase58()} has not been initialised ` +
        `(deploy guide step 6a), or ESCROW_ID still names the program you are flipping away from.\n` +
        `  Creating the table now would cache a protocol_config PDA that no deposit references — ` +
        `a table that looks right and is wrong on every deposit.`
    );
  }
  if (!account.owner.equals(escrowProgramId)) {
    throw new Error(
      `protocol_config PDA ${protocolConfig.toBase58()} is owned by ${account.owner.toBase58()}, ` +
        `not by the escrow program ${escrowProgramId.toBase58()}`
    );
  }
  if (account.data.length !== ESCROW_PROTOCOL_CONFIG_SIZE) {
    throw new Error(
      `protocol_config PDA ${protocolConfig.toBase58()} is ${
        account.data.length
      } bytes, ` +
        `expected ${ESCROW_PROTOCOL_CONFIG_SIZE} for the v4 layout.\n` +
        `  A v1/v3 config is 119 bytes. Decoding it with the v4 IDL does not fail — it fabricates ` +
        `fields — so this is checked by size before any decode. Size mismatch means the ` +
        `program-id flip has not happened on this cluster.`
    );
  }

  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(Keypair.generate()),
    { commitment: "finalized" }
  );
  // The IDL's own `address` is stamped from Anchor.toml, i.e. the retired id. Override it so the
  // account client fetches against the program this table is actually for.
  const program = new Program(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { ...(idl as any), address: escrowProgramId.toBase58() } as any,
    provider
  );
  const state = await fetchProtocolConfig(program, protocolConfig, "Escrow");

  const clusterId = Buffer.from(state.clusterId as number[] | Uint8Array);
  console.log(
    `    cluster_id:      "${clusterId
      .toString("utf8")
      .replace(/\0+$/u, "")}" (${clusterId.toString("hex")})`
  );
  console.log(
    `    signature_domain_version: ${state.signatureDomainVersion}` +
      `   paused: ${state.paused}`
  );
  console.log(
    `    default_admin:   ${formatNullablePubkey(state.defaultAdmin)}`
  );
  console.log(
    `    token_config_authority: ${formatNullablePubkey(
      state.tokenConfigAuthority
    )}`
  );

  if (state.signatureDomainVersion !== ESCROW_SIGNATURE_DOMAIN_VERSION) {
    const message =
      `Escrow ${escrowProgramId.toBase58()} reports signature_domain_version ` +
      `${state.signatureDomainVersion}, expected ${ESCROW_SIGNATURE_DOMAIN_VERSION} for v4. ` +
      `There is no setter for it, so this config was initialised by a pre-v4 program: the ` +
      `program-id flip has not happened on ${rpcUrl}, and a table built now caches the wrong ` +
      `protocol_config PDA.`;
    if (process.env.ALLOW_RETIRED_PROGRAM_IDS?.toLowerCase() !== "true") {
      throw new Error(
        `${message}\n  Set ALLOW_RETIRED_PROGRAM_IDS=true if you are deliberately building a ` +
          `table for a pre-v4 deployment.`
      );
    }
    console.log(`    WARNING: ${message}`);
  }
  return state;
}

interface InspectedMint {
  mint: PublicKey;
  tokenProgram: PublicKey;
  feeConfigExists: boolean;
}

async function inspectMints(
  connection: Connection,
  escrowProgramId: PublicKey,
  mints: PublicKey[],
  allowUnverified: boolean
): Promise<InspectedMint[]> {
  const inspected: InspectedMint[] = [];
  for (const mint of mints) {
    const account = await connection.getAccountInfo(mint, "finalized");
    let tokenProgram = TOKEN_PROGRAM_ID;

    if (!account || account.data.length === 0) {
      const message =
        `Mint ${mint.toBase58()} does not exist on this cluster (no account, or zero-length ` +
        `data). config/tokens/testnet.yaml lists exactly such a phantom entry for devnet USDT, ` +
        `so a copy-paste from config is the likely cause.`;
      if (!allowUnverified) {
        throw new Error(
          `${message}\n  Pass --allow-unverified-mint to table it anyway.`
        );
      }
      console.log(`    ${mint.toBase58()}: UNVERIFIED — ${message}`);
    } else if (
      !account.owner.equals(TOKEN_PROGRAM_ID) &&
      !account.owner.equals(TOKEN_2022_PROGRAM_ID)
    ) {
      const message =
        `Mint ${mint.toBase58()} is owned by ${account.owner.toBase58()}, which is neither the ` +
        `SPL Token nor the Token-2022 program, so it is not a mint.`;
      if (!allowUnverified) {
        throw new Error(
          `${message}\n  Pass --allow-unverified-mint to table it anyway.`
        );
      }
      console.log(`    ${mint.toBase58()}: UNVERIFIED — ${message}`);
    } else {
      tokenProgram = account.owner;
      console.log(
        `    ${mint.toBase58()}: ${account.data.length} bytes, owner ${
          account.owner.equals(TOKEN_2022_PROGRAM_ID)
            ? "token-2022"
            : "spl-token"
        }`
      );
    }

    const feeConfig = getMintFeeConfigAddress(escrowProgramId, mint);
    const feeConfigAccount = await connection.getAccountInfo(
      feeConfig,
      "finalized"
    );
    if (!feeConfigAccount) {
      // Expected here: the guide allowlists mints in step 6c, AFTER the table. The PDA address is
      // fixed by the seeds either way, so tabling it before it exists is safe.
      console.log(
        `      mint_fee_config ${feeConfig.toBase58()} not created yet — expected before step 6c`
      );
    }
    inspected.push({
      mint,
      tokenProgram,
      feeConfigExists: feeConfigAccount !== null,
    });
  }
  return inspected;
}

// ─── Table creation ──────────────────────────────────────────────────────────

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function loadExistingTable(
  connection: Connection,
  table: PublicKey
): Promise<AddressLookupTableAccount> {
  // getAddressLookupTable throws a bare "lookup table is invalid" out of its deserializer when the
  // address holds something that is not a table, which reads as a bug in this script rather than a
  // wrong --table argument.
  let fetched;
  try {
    fetched = await connection.getAddressLookupTable(table);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${table.toBase58()} is not an address lookup table: ${message}`
    );
  }
  if (!fetched.value) {
    throw new Error(
      `Address lookup table ${table.toBase58()} does not exist on this cluster`
    );
  }
  return fetched.value;
}

async function extendTable(
  connection: Connection,
  payer: Keypair,
  table: PublicKey,
  addresses: PublicKey[]
): Promise<void> {
  for (const [index, batch] of chunk(addresses, EXTEND_CHUNK_SIZE).entries()) {
    const tx = new Transaction().add(
      AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: table,
        addresses: batch,
      })
    );
    const signature = await sendAndConfirmTransaction(connection, tx, [payer]);
    console.log(
      `    extend ${index + 1}: +${batch.length} addresses, tx ${signature}`
    );
  }
}

async function createTable(
  connection: Connection,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<PublicKey> {
  // createLookupTable derives the address from the authority and a recent slot, and the on-chain
  // program re-derives it, so the slot has to be one the cluster still has in its slot hashes.
  const recentSlot = await connection.getSlot("finalized");
  const [createIx, table] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot,
  });

  const first = addresses.slice(0, EXTEND_CHUNK_SIZE);
  const tx = new Transaction().add(createIx);
  if (first.length > 0) {
    tx.add(
      AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: table,
        addresses: first,
      })
    );
  }
  const signature = await sendAndConfirmTransaction(connection, tx, [payer]);
  console.log(`    create: ${table.toBase58()}, tx ${signature}`);

  const rest = addresses.slice(first.length);
  if (rest.length > 0) {
    await extendTable(connection, payer, table, rest);
  }
  return table;
}

function lookupTableEnvVar(cluster: string): string {
  // The settler reads only these two names; anything else has no config home yet, which the guide
  // flags as still unowned.
  if (cluster === "mainnet") return "SOLANA_ADDRESS_LOOKUP_TABLE";
  if (cluster === "devnet") return "SOLANA_DEVNET_ADDRESS_LOOKUP_TABLE";
  return `SOLANA_${cluster.toUpperCase()}_ADDRESS_LOOKUP_TABLE (not read by the settler today)`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const escrowProgramId = requireProgramId("ESCROW_ID", "Escrow");
  const fulfillmentProxyProgramId = requireProgramId(
    "FP_ID",
    "FulfillmentProxy"
  );
  const protocolConfig = getProtocolConfigAddress(escrowProgramId);
  const idl = loadEscrowIdl();
  const mints = args.mints.map((mint) => new PublicKey(mint));

  console.log("Escrow: Address Lookup Table");
  console.log(`  Mode:            ${args.mode}`);
  // Printed prominently and together: these two lines are how an operator checks that the table is
  // being built for the program that was just flipped to, not the one before it.
  console.log(`  Escrow program:  ${escrowProgramId.toBase58()}`);
  console.log(`  protocol_config: ${protocolConfig.toBase58()}`);
  console.log(`  fulfillment_proxy: ${fulfillmentProxyProgramId.toBase58()}`);

  if (args.mode === "measure") {
    const modelMint =
      mints[0] ?? placeholderKey("placeholder_mint_for_measurement");
    if (mints.length === 0) {
      console.log(
        `  Mint:            ${modelMint.toBase58()} (PLACEHOLDER — no --mint given; the real` +
          ` mint changes the addresses, not the byte counts)`
      );
    } else {
      console.log(`  Mints:           ${mints.length}`);
    }
    console.log(`  Chain access:    none (offline)`);
    console.log();

    // Every supplied mint goes into the table, but the modelled deposit can only touch one of
    // them. A second mint therefore shows up as two entries this deposit does not dereference —
    // which is the truth about what a multi-mint table buys a single transaction.
    const tabled = staticAddresses({
      escrowProgramId,
      fulfillmentProxyProgramId,
      mints: mints.length > 0 ? mints : [modelMint],
    });
    printSizeReport(
      idl,
      {
        escrowProgramId,
        protocolConfig,
        mint: modelMint,
        mintFeeConfig: getMintFeeConfigAddress(escrowProgramId, modelMint),
        tokenProgram: TOKEN_PROGRAM_ID,
      },
      tabled
    );
    return;
  }

  const wsEndpoint = process.env.SOLANA_WS_URL;
  const connection = new Connection(args.rpcUrl, {
    commitment: "confirmed",
    ...(wsEndpoint ? { wsEndpoint } : {}),
  });
  const cluster = await resolveAnchorCluster(connection, args.rpcUrl);
  console.log(`  Cluster:         ${cluster}`);
  console.log(`  RPC:             ${args.rpcUrl}`);
  console.log();

  console.log("[1/4] Verifying the escrow deployment...");
  await inspectEscrowProgram(connection, escrowProgramId, args.rpcUrl);
  await requireProtocolConfig(
    connection,
    escrowProgramId,
    protocolConfig,
    args.rpcUrl,
    idl
  );

  console.log("\n[2/4] Inspecting mints...");
  if (mints.length === 0) {
    // Not fatal in a rehearsal, but the size report below will show the difference: the two
    // per-mint entries are the ones a deposit actually dereferences most.
    console.log("    none given — pass --mint <address> for the real table");
  }
  const inspected = await inspectMints(
    connection,
    escrowProgramId,
    mints,
    args.allowUnverifiedMint
  );

  const tabled = staticAddresses({
    escrowProgramId,
    fulfillmentProxyProgramId,
    mints,
    tokenPrograms: dedupeAddresses(
      inspected.map((entry) => ({
        address: entry.tokenProgram,
        label: "token program",
      }))
    ).map((entry) => entry.address),
  });

  console.log("\n[3/4] Table contents");
  tabled.forEach((entry, index) => {
    console.log(
      `  [${String(index).padStart(2)}] ${entry.address.toBase58()}  ${
        entry.label
      }`
    );
  });
  if (tabled.length > LOOKUP_TABLE_MAX_ADDRESSES) {
    throw new Error(
      `${tabled.length} addresses exceeds the ${LOOKUP_TABLE_MAX_ADDRESSES}-address table limit`
    );
  }
  const rent = await connection.getMinimumBalanceForRentExemption(
    LOOKUP_TABLE_META_SIZE + 32 * tabled.length
  );
  console.log(`  Rent-exempt minimum: ${rent / 1e9} SOL`);
  console.log();
  const modelMint =
    mints[0] ?? placeholderKey("placeholder_mint_for_measurement");
  printSizeReport(
    idl,
    {
      escrowProgramId,
      protocolConfig,
      mint: modelMint,
      mintFeeConfig: getMintFeeConfigAddress(escrowProgramId, modelMint),
      tokenProgram: inspected[0]?.tokenProgram ?? TOKEN_PROGRAM_ID,
    },
    tabled
  );

  console.log("\n[4/4] Table");
  const existing = args.table ? new PublicKey(args.table) : null;
  let missing = tabled.map((entry) => entry.address);

  if (existing) {
    const account = await loadExistingTable(connection, existing);
    const held = new Set(
      account.state.addresses.map((address) => address.toBase58())
    );
    missing = missing.filter((address) => !held.has(address.toBase58()));
    console.log(
      `  Existing table ${existing.toBase58()}: ${
        account.state.addresses.length
      } addresses, authority ${formatNullablePubkey(account.state.authority)}`
    );
    console.log(`  Missing from it: ${missing.length}`);
    if (missing.length === 0) {
      console.log("  Nothing to add. Done.");
      return;
    }
    if (!args.keypairPath) {
      // Rehearsing an extend only needs to read the table, so this is allowed — but say so, rather
      // than leaving the operator to wonder whether the authority check passed or was skipped.
      console.log(
        "  Note: without --keypair this rehearsal cannot check that you hold the table's authority."
      );
    }
  }

  if (args.mode === "dry-run") {
    console.log(
      `  DRY RUN — nothing sent. Re-run with --keypair <path> to ${
        existing ? "extend" : "create"
      } it.`
    );
    return;
  }

  const payer = loadKeypair(args.keypairPath);
  console.log(`  Authority/payer: ${payer.publicKey.toBase58()}`);

  if (existing) {
    const account = await loadExistingTable(connection, existing);
    if (
      !account.state.authority ||
      !account.state.authority.equals(payer.publicKey)
    ) {
      throw new Error(
        `Table ${existing.toBase58()} authority is ${formatNullablePubkey(
          account.state.authority
        )}, not the signer ${payer.publicKey.toBase58()}. An extend from this keypair would fail.`
      );
    }
    await extendTable(connection, payer, existing, missing);
    console.log(`\n  Table: ${existing.toBase58()}`);
  } else {
    const table = await createTable(connection, payer, missing);
    console.log(`\n  Table: ${table.toBase58()}`);
    console.log(`  export ${lookupTableEnvVar(cluster)}=${table.toBase58()}`);
  }

  console.log(
    `  Newly added addresses become usable one slot after the extend lands; verify with\n` +
      `    solana address-lookup-table get <table> --url ${args.rpcUrl}`
  );
  console.log("\nDone.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
