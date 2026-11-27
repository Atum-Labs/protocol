import * as anchor from "@coral-xyz/anchor";
import { Program, Wallet } from "@coral-xyz/anchor";
import {
  createMint as splCreateMint,
  createAccount as splCreateAccount,
  mintTo as splMintTo,
  getAccount as splGetAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  getMintLen,
  ExtensionType,
  createInitializeTransferFeeConfigInstruction,
  createInitializeTransferHookInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeNonTransferableMintInstruction,
  getOrCreateAssociatedTokenAccount as splGetOrCreateAssociatedTokenAccount,
  mintTo as splMintToV2,
} from "@solana/spl-token";
import { expect } from "chai";
import {
  AccountMeta,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Connection,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { randomBytes, randomInt } from "crypto";
import { Escrow } from "../target/types/escrow";
import { FulfillmentProxy } from "../target/types/fulfillment_proxy";
import { MockTransferHook } from "../target/types/mock_transfer_hook";
import { keccak } from "hash-wasm";
import mockTransferHookIdl from "../target/idl/mock_transfer_hook.json";

// Re-export common utilities
export {
  anchor,
  Program,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  expect,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
};

// ============================================================
// ROLE KEYPAIRS - Stable across test suite
// ============================================================

/**
 * Pauser role keypair - can pause/unpause the protocol
 * Generated once for the test suite
 */
/// Default non-zero offchain quote hash used across reserve/release/refund test flows.
export const DEFAULT_QUOTE_HASH = Buffer.alloc(32, 1);
export const ZERO_QUOTE_HASH = Buffer.alloc(32, 0);

export const pauserKeypair = Keypair.generate();

/**
 * Treasurer role keypair - receives protocol fees
 * Only the pubkey is used (no signing required for ATA creation)
 */
export const treasurerKeypair = Keypair.generate();

/**
 * Secondary admin keypair for testing admin transfers
 */
export const secondaryAdminKeypair = Keypair.generate();

/**
 * Secondary token config authority for testing role changes
 */
export const secondaryTokenConfigKeypair = Keypair.generate();

// ============================================================
// ROLE HELPER FUNCTIONS
// ============================================================

/**
 * Get the default admin pubkey (provider wallet in tests)
 */
export function getDefaultAdmin(provider: anchor.AnchorProvider): PublicKey {
  return provider.wallet.publicKey;
}

/**
 * Get the token config authority pubkey (provider wallet in tests)
 */
export function getTokenConfigAuthority(
  provider: anchor.AnchorProvider
): PublicKey {
  return provider.wallet.publicKey;
}

/**
 * Fund the pauser keypair with SOL for signing transactions
 */
export async function fundPauser(
  provider: anchor.AnchorProvider,
  lamports: number = anchor.web3.LAMPORTS_PER_SOL
): Promise<void> {
  const sig = await provider.connection.requestAirdrop(
    pauserKeypair.publicKey,
    lamports
  );
  await provider.connection.confirmTransaction(sig);
}

/**
 * Fund the secondary admin keypair with SOL for testing admin transfers
 */
export async function fundSecondaryAdmin(
  provider: anchor.AnchorProvider,
  lamports: number = anchor.web3.LAMPORTS_PER_SOL
): Promise<void> {
  const sig = await provider.connection.requestAirdrop(
    secondaryAdminKeypair.publicKey,
    lamports
  );
  await provider.connection.confirmTransaction(sig);
}

// ============================================================
// PROTOCOL CONFIG HELPERS
// ============================================================

/**
 * Get the ProtocolConfig PDA address
 */
export function getProtocolConfigAddress(programId: PublicKey): PublicKey {
  const [protocolConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_config")],
    programId
  );
  return protocolConfig;
}

/**
 * Get the MintFeeConfig PDA address for a mint
 */
export function getMintFeeConfigAddress(
  mint: PublicKey,
  programId: PublicKey
): PublicKey {
  const [mintFeeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_fee_config"), mint.toBuffer()],
    programId
  );
  return mintFeeConfig;
}

/**
 * Get the ProgramData address for the escrow program
 */
export function getProgramDataAddress(programId: PublicKey): PublicKey {
  const [programData] = PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
  );
  return programData;
}

/**
 * Ensures ProtocolConfig PDA is initialized.
 * Idempotent - safe to call multiple times.
 * Uses provider wallet as default_admin and token_config_authority.
 */
export async function ensureProtocolInitialized(
  program: Program<Escrow>,
  anchorProvider: anchor.AnchorProvider
): Promise<PublicKey> {
  const protocolConfig = getProtocolConfigAddress(program.programId);

  // Check if already initialized
  const accountInfo = await anchorProvider.connection.getAccountInfo(
    protocolConfig
  );
  if (accountInfo !== null) {
    return protocolConfig;
  }

  // Fund pauser for signing transactions
  const sig = await anchorProvider.connection.requestAirdrop(
    pauserKeypair.publicKey,
    anchor.web3.LAMPORTS_PER_SOL
  );
  await anchorProvider.connection.confirmTransaction(sig);

  // Get program data for upgrade authority verification
  const programData = getProgramDataAddress(program.programId);

  // Initialize with provider wallet as admin roles
  await program.methods
    .initializeProtocol(
      anchorProvider.wallet.publicKey, // default_admin
      anchorProvider.wallet.publicKey, // token_config_authority
      treasurerKeypair.publicKey, // treasurer
      pauserKeypair.publicKey, // pauser
      Array.from(ESCROW_TEST_CLUSTER_ID), // cluster_id
      0 // default_admin_delay_seconds
    )
    .accountsPartial({
      authority: anchorProvider.wallet.publicKey,
      protocolConfig,
      program: program.programId,
      programData,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return protocolConfig;
}

/**
 * Ensures Fulfillment Proxy ProtocolConfig PDA is initialized.
 * Idempotent - safe to call multiple times.
 * Uses provider wallet as default_admin and `pauserKeypair` as pauser.
 */
export async function ensureFulfillmentProxyInitialized(
  program: Program<FulfillmentProxy>,
  anchorProvider: anchor.AnchorProvider
): Promise<PublicKey> {
  const protocolConfig = getProtocolConfigAddress(program.programId);

  // Check if already initialized
  const accountInfo = await anchorProvider.connection.getAccountInfo(
    protocolConfig
  );
  if (accountInfo !== null) {
    return protocolConfig;
  }

  // Fund pauser for pause/unpause tests (pauser doesn't sign init).
  await fundPauser(anchorProvider);

  // Get program data for upgrade authority verification
  const programData = getProgramDataAddress(program.programId);

  // Initialize with provider wallet as default_admin
  await program.methods
    .initializeProtocol(
      anchorProvider.wallet.publicKey, // default_admin
      pauserKeypair.publicKey, // pauser
      0 // default_admin_delay_seconds
    )
    .accountsPartial({
      authority: anchorProvider.wallet.publicKey,
      protocolConfig,
      program: program.programId,
      programData,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return protocolConfig;
}

// Configure the client to use the local cluster.
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

// Export configured clients and programs.
export { provider };
export const escrowProgram = anchor.workspace.Escrow as Program<Escrow>;
export const fulfillmentProgram = anchor.workspace
  .FulfillmentProxy as Program<FulfillmentProxy>;
export const authority = provider.wallet as Wallet;

// Constants
export const ESCROW_DELEGATE_SEED = Buffer.from("escrow_delegate");
export const DEPOSIT_SEED = Buffer.from("deposit");
export const CONFIG_SEED = Buffer.from("config");
export const REPLAY_SEED = Buffer.from("replay");
export const FULFILLMENT_REPLAY_SEED = Buffer.from("replay");
export const REPLAY_HORIZON_SECS = 128;
// One replay time slice. It has to be at least twice the horizon, so a nonce's record outlives every
// authorization that overlapped it (see REPLAY_SLICE_SHIFT in crates/replay).
export const REPLAY_SLICE_SECS = 256;
export const REPLAY_VALID_NONCE_SLOTS = 235;
export const REPLAY_NONCE_BUCKET_OFFSET = 4;
export const REPLAY_NONCE_BUCKET_LENGTH = 4;

export const MINT_DECIMALS = 6;
// Fees removed from protocol; keep timing constants only where relevant to bitmap.

export const ONE_DAY_IN_SECONDS = 60 * 60 * 24;

// Mock TransferHook Program ID
export const MOCK_TRANSFER_HOOK_PROGRAM_ID = new PublicKey(
  "HekWAieNQ7T8xa1Wtq3tn3T8a7obiWusq6kXmWHLBmR1"
);

export const DELEGATE_CAPACITY = new anchor.BN(1000 * 10 ** MINT_DECIMALS); // 1000 tokens
export const MAX_TRANSFER_SIZE = new anchor.BN(100 * 10 ** MINT_DECIMALS); // 100 tokens
export const DEPOSIT_AMOUNT = new anchor.BN(50 * 10 ** MINT_DECIMALS); // 50 tokens
// Mirrors ProtocolConfig::CURRENT_SIGNATURE_DOMAIN_VERSION. Bumped 3 -> 4 by CORE-2120: destination_hash
// entered the deposit preimage, so every deposit hash changes and a v3 signature must not replay against
// a v4 program.
export const ESCROW_SIGNATURE_DOMAIN_VERSION = 5;

function fixedSizeUtf8Bytes(value: string, length: number): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(
      `Value "${value}" exceeds fixed byte length ${length}: ${bytes.length}`
    );
  }

  return Buffer.concat([bytes, Buffer.alloc(length - bytes.length)]);
}

export const ESCROW_TEST_CLUSTER_ID = fixedSizeUtf8Bytes("localnet", 32);

type EscrowSignatureDomain = {
  clusterId: Buffer;
  signatureDomainVersion: number;
};

let cachedEscrowSignatureDomain: EscrowSignatureDomain | null = null;

/**
 * Airdrops SOL to a wallet.
 */
export async function topUp(
  wallet: Keypair | PublicKey,
  amount = 1 * LAMPORTS_PER_SOL
) {
  const pubkey = wallet instanceof Keypair ? wallet.publicKey : wallet;
  const airdropTx = await provider.connection.requestAirdrop(pubkey, amount);
  const latestBlockhash = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({
    signature: airdropTx,
    ...latestBlockhash,
  });
}

/**
 * Creates a new SPL mint.
 */
export async function createMint(
  connection: Connection,
  payer: Keypair,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null,
  decimals: number
) {
  return splCreateMint(
    connection,
    payer,
    mintAuthority,
    freezeAuthority,
    decimals
  );
}

/**
 * Creates a new SPL token account.
 */
export async function createAccount(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
) {
  return splCreateAccount(connection, payer, mint, owner);
}

/**
 * Mints tokens to a token account.
 */
export async function mintTo(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  tokenAccount: PublicKey,
  mintAuthority: Keypair | PublicKey,
  amount: number | bigint
) {
  if (mintAuthority instanceof Keypair) {
    await splMintTo(
      connection,
      payer,
      mint,
      tokenAccount,
      mintAuthority,
      amount
    );
  } else {
    await splMintTo(
      connection,
      payer,
      mint,
      tokenAccount,
      mintAuthority,
      amount
    );
  }
}

/**
 * Fetches an SPL token account.
 */
export async function getAccount(
  connection: Connection,
  tokenAccount: PublicKey
) {
  return splGetAccount(connection, tokenAccount);
}

/**
 * Creates a new payment ID.
 */
export function createPaymentId(): Buffer {
  return randomBytes(32);
}

/**
 * Generates a valid random nonce for replay protection.
 * Ensures the slot (nonce & 0xFF) is < REPLAY_VALID_NONCE_SLOTS as required by the program.
 * Uses bucket >= 0x10 to avoid conflicts with hardcoded test nonces (buckets 0x01-0x0F).
 */
export function createValidNonce(): anchor.BN {
  // Generate random 8 bytes
  const nonceBuffer = randomBytes(8);

  // Ensure the lower 8 bits generate a valid slot (< REPLAY_VALID_NONCE_SLOTS).
  // In little-endian, the first byte contains the lowest 8 bits.
  //
  // randomInt rather than `randomBytes % N`: the modulo is only uniform when N divides 256, and
  // REPLAY_VALID_NONCE_SLOTS does not, so the low slots would be drawn more often than the high ones.
  // Bias in a test nonce is not a security problem, but it skews which replay slots ever get exercised
  // and it is what CodeQL's biased-cryptographic-random rule flags.
  nonceBuffer[0] = randomInt(0, REPLAY_VALID_NONCE_SLOTS);

  // Ensure upper 32 bits (bucket) is >= 0x10 to avoid conflicts with the hardcoded test nonces in
  // buckets 0x01-0x0F. In little-endian, bytes 4-7 contain bits 32-63, so byte 7 is the most
  // significant. Drawn uniformly over [0x10, 0xFF] for the same reason as above.
  nonceBuffer[7] = randomInt(0x10, 0x100);

  return new anchor.BN(nonceBuffer, "le");
}

export interface StrictFulfillReplayArgs {
  nonce: anchor.BN;
  issuedAt: anchor.BN;
  deadline: anchor.BN;
}

/**
 * Create strict_fulfill replay/timing arguments aligned with the instruction ABI.
 * `issuedAt` defaults to 5 seconds in the past to reduce localnet timing flakiness.
 */
export function createStrictFulfillReplayArgs(
  options: {
    nonce?: anchor.BN;
    issuedAt?: anchor.BN;
    ttlSecs?: number;
  } = {}
): StrictFulfillReplayArgs {
  const nonce = options.nonce ?? createValidNonce();
  const issuedAt =
    options.issuedAt ?? new anchor.BN(Math.floor(Date.now() / 1000) - 5);
  const ttlSecs = options.ttlSecs ?? REPLAY_HORIZON_SECS;
  const deadline = new anchor.BN(issuedAt.toNumber() + ttlSecs);

  return { nonce, issuedAt, deadline };
}

/**
 * Build strict_fulfill method arguments in ABI order:
 * (payment_id, nonce, issued_at, amount, deadline)
 */
export type StrictFulfillArgs = [
  paymentId: number[],
  nonce: anchor.BN,
  issuedAt: anchor.BN,
  amount: anchor.BN,
  deadline: anchor.BN
];

export function createStrictFulfillArgs(
  paymentId: Uint8Array | Buffer,
  amount: anchor.BN,
  replayArgs: StrictFulfillReplayArgs = createStrictFulfillReplayArgs()
): StrictFulfillArgs {
  return [
    Array.from(paymentId),
    replayArgs.nonce,
    replayArgs.issuedAt,
    amount,
    replayArgs.deadline,
  ];
}

type NonceLike = anchor.BN | Uint8Array | Buffer;

function nonceToLeBytes(nonce: NonceLike): Buffer {
  if (nonce instanceof anchor.BN) {
    return nonce.toBuffer("le", 8);
  }

  const bytes = Buffer.from(nonce);
  if (bytes.length !== 8) {
    throw new Error(
      `Invalid nonce length: expected 8 bytes, received ${bytes.length}`
    );
  }

  return bytes;
}

/**
 * Derive replay bucket selector bytes from nonce[4..8] (little-endian).
 */
export function deriveReplayBucketSelectorFromNonce(nonce: NonceLike): Buffer {
  const nonceBytes = nonceToLeBytes(nonce);
  return nonceBytes.slice(
    REPLAY_NONCE_BUCKET_OFFSET,
    REPLAY_NONCE_BUCKET_OFFSET + REPLAY_NONCE_BUCKET_LENGTH
  );
}

/**
 * Helper to create an EscrowDelegate.
 */
export async function createDelegate(
  authority: Keypair,
  delegateSigner: Keypair,
  mint: PublicKey,
  capacity: anchor.BN,
  maxTransferSize: anchor.BN,
  expirationInDays: number,
  payer?: Keypair
): Promise<PublicKey> {
  const [delegate] = PublicKey.findProgramAddressSync(
    [ESCROW_DELEGATE_SEED, authority.publicKey.toBuffer(), mint.toBuffer()],
    escrowProgram.programId
  );

  const authorityAta = await getOrCreateAssociatedTokenAccount(
    mint,
    authority.publicKey
  );

  const expiration = new anchor.BN(
    Math.floor(Date.now() / 1000) + expirationInDays * 24 * 60 * 60
  );

  // Use provided payer or default to authority
  const actualPayer = payer || authority;

  // Ensure protocol is initialized and get config address
  const protocolConfig = await ensureProtocolInitialized(
    escrowProgram,
    provider
  );
  const mintFeeConfig = getMintFeeConfigAddress(mint, escrowProgram.programId);

  await escrowProgram.methods
    .createDelegate(
      delegateSigner.publicKey,
      capacity,
      maxTransferSize,
      expiration
    )
    .accountsPartial({
      protocolConfig,
      authority: authority.publicKey,
      escrowDelegate: delegate,
      authorityAta,
      mint,
      mintFeeConfig,
      payer: actualPayer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers(payer ? [payer, authority] : [authority])
    .rpc();

  return delegate;
}

/** Ed25519 verification instruction over `message` exactly as given. */
export function rawSigIx(
  signer: Keypair,
  message: Buffer | Uint8Array
): anchor.web3.TransactionInstruction {
  return anchor.web3.Ed25519Program.createInstructionWithPrivateKey({
    privateKey: signer.secretKey,
    message: Buffer.from(message),
  });
}

export const DEPOSIT_LABEL = "atum deposit v1";
export const RESERVE_LABEL = "atum reserve v1";
export const RELEASE_LABEL = "atum release v1";
export const REFUND_LABEL = "atum refund v1";

/** The escrow signed text `<label> <base64url-nopad(hash)>`. */
export function escrowSignedText(
  label: string,
  hash: Buffer | Uint8Array
): Buffer {
  if (hash.length !== 32) throw new Error("escrow hash must be 32 bytes");
  return Buffer.from(`${label} ${Buffer.from(hash).toString("base64url")}`);
}

export function depositSigIx(signer: Keypair, hash: Buffer | Uint8Array) {
  return rawSigIx(signer, escrowSignedText(DEPOSIT_LABEL, hash));
}

export function reserveSigIx(signer: Keypair, hash: Buffer | Uint8Array) {
  return rawSigIx(signer, escrowSignedText(RESERVE_LABEL, hash));
}

export function releaseSigIx(signer: Keypair, hash: Buffer | Uint8Array) {
  return rawSigIx(signer, escrowSignedText(RELEASE_LABEL, hash));
}

export function refundSigIx(signer: Keypair, hash: Buffer | Uint8Array) {
  return rawSigIx(signer, escrowSignedText(REFUND_LABEL, hash));
}

/**
 * Sends instructions as a v0 transaction through a fresh address lookup table, the way the
 * settler ships transactions that outgrow the 1232-byte legacy limit. Every account that is
 * neither a signer nor an invoked program goes in the table. Throws on failure like .rpc().
 */
export async function sendV0WithLookupTable(
  instructions: TransactionInstruction[],
  signers: Keypair[]
): Promise<string> {
  const connection = provider.connection;
  const feePayer = provider.wallet.payer as Keypair;
  const programIds = new Set(instructions.map((ix) => ix.programId.toBase58()));
  const lookupKeys = new Map<string, PublicKey>();
  for (const ix of instructions) {
    for (const meta of ix.keys) {
      const key = meta.pubkey.toBase58();
      if (!meta.isSigner && !programIds.has(key))
        lookupKeys.set(key, meta.pubkey);
    }
  }

  const [createIx, lookupTable] = AddressLookupTableProgram.createLookupTable({
    authority: feePayer.publicKey,
    payer: feePayer.publicKey,
    recentSlot: await connection.getSlot("finalized"),
  });
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: feePayer.publicKey,
    authority: feePayer.publicKey,
    lookupTable,
    addresses: [...lookupKeys.values()],
  });
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(createIx, extendIx),
    [feePayer],
    { commitment: "confirmed" }
  );

  // Addresses added by extend are usable only from the next slot on.
  const extendedAt = await connection.getSlot("confirmed");
  while ((await connection.getSlot("confirmed")) <= extendedAt) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const table = (await connection.getAddressLookupTable(lookupTable)).value;
  if (!table) throw new Error("address lookup table not found");

  const blockhash = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions,
  }).compileToV0Message([table]);
  const tx = new VersionedTransaction(message);
  tx.sign([feePayer, ...signers]);
  const signature = await connection.sendTransaction(tx);
  const result = await connection.confirmTransaction(
    { signature, ...blockhash },
    "confirmed"
  );
  if (result.value.err) {
    throw new Error(
      `transaction ${signature} failed: ${JSON.stringify(result.value.err)}`
    );
  }
  return signature;
}

export async function generateFundedKeypair(
  amount = LAMPORTS_PER_SOL
): Promise<Keypair> {
  const kp = Keypair.generate();
  await topUp(kp, amount);
  return kp;
}

export async function setupMintAndFund(
  decimals = MINT_DECIMALS,
  amount = BigInt(1_000_000_000),
  skipAllowlist = false
): Promise<{
  mint: PublicKey;
  mintFeeConfig: PublicKey | null;
  authorityTokenAccount: PublicKey;
}> {
  const mint = await splCreateMint(
    provider.connection,
    authority.payer,
    authority.publicKey,
    null,
    decimals
  );

  const authorityTokenAccount = await getAssociatedTokenAddress(
    mint,
    authority.publicKey
  );

  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      authority.payer.publicKey,
      authorityTokenAccount,
      authority.publicKey,
      mint
    )
  );

  await sendAndConfirmTransaction(provider.connection, tx, [authority.payer]);

  await splMintTo(
    provider.connection,
    authority.payer,
    mint,
    authorityTokenAccount,
    authority.payer,
    amount
  );

  let mintFeeConfig: PublicKey | null = null;

  if (!skipAllowlist) {
    // Ensure protocol is initialized
    const protocolConfig = await ensureProtocolInitialized(
      escrowProgram,
      provider
    );

    // Derive MintFeeConfig PDA
    mintFeeConfig = getMintFeeConfigAddress(mint, escrowProgram.programId);

    // Allowlist the mint with zero fees
    await escrowProgram.methods
      .allowMint()
      .accountsPartial({
        tokenConfigAuthority: provider.wallet.publicKey,
        protocolConfig,
        mintAccount: mint,
        mintFeeConfig,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  return { mint, mintFeeConfig, authorityTokenAccount };
}

export async function fetchEscrowProtocolConfig(
  protocolConfigAddress?: PublicKey
) {
  const protocolConfig =
    protocolConfigAddress ??
    (await ensureProtocolInitialized(escrowProgram, provider));
  return escrowProgram.account.protocolConfig.fetch(protocolConfig);
}

async function getEscrowSignatureDomain(
  protocolConfigAddress?: PublicKey
): Promise<EscrowSignatureDomain> {
  if (cachedEscrowSignatureDomain !== null && !protocolConfigAddress) {
    return cachedEscrowSignatureDomain;
  }

  const config = await fetchEscrowProtocolConfig(protocolConfigAddress);
  const domain = {
    clusterId: Buffer.from(config.clusterId),
    signatureDomainVersion: config.signatureDomainVersion,
  };

  if (!protocolConfigAddress) {
    cachedEscrowSignatureDomain = domain;
  }

  return domain;
}

export interface EscrowMessageOptions {
  clusterId?: Buffer | Uint8Array;
  programId?: PublicKey;
  signatureDomainVersion?: number;
  protocolConfig?: PublicKey;
}

/**
 * The destination every deposit test commits to (CORE-2120).
 *
 * The ratified canonical form, `<CAIP-19 asset>@<account>`, lowercase throughout for an eip155
 * namespace. 103 bytes, comfortably inside the 256-byte limit the bindings enforce.
 */
export const TEST_DESTINATION =
  "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@0xc0ffee254729296a45a3885639ac7e10f9d54979";

/**
 * keccak256 of a destination string: the deposit instruction's `destination_hash` argument and the
 * 32 bytes that enter the deposit preimage.
 *
 * The deposit hash commits to keccak256(destination), NOT the string: keccak concatenates without
 * length prefixes, so injectivity depends on every hashed field being fixed-width. Tests must feed this,
 * never the raw string, or they will compute a hash the program rejects.
 */
export async function destinationHash(
  destination: string = TEST_DESTINATION
): Promise<Buffer> {
  const hash = await keccak(Buffer.from(destination), 256);
  return Buffer.from(hash, "hex");
}

export async function createMessage(
  action: string,
  params: (Buffer | Uint8Array)[],
  options: EscrowMessageOptions = {}
): Promise<Buffer> {
  const domain = await getEscrowSignatureDomain(options.protocolConfig);
  const buffers = params.map((p) => (p instanceof Buffer ? p : Buffer.from(p)));
  const clusterId = Buffer.from(options.clusterId ?? domain.clusterId);
  if (clusterId.length !== 32) {
    throw new Error(
      `cluster_id must be 32 bytes, received ${clusterId.length}`
    );
  }

  const version = Buffer.from([
    options.signatureDomainVersion ?? domain.signatureDomainVersion,
  ]);
  const programId = (options.programId ?? escrowProgram.programId).toBuffer();
  const concat = Buffer.concat([
    Buffer.from("escrow"),
    version,
    clusterId,
    programId,
    Buffer.from(action),
    ...buffers,
  ]);
  const hash = await keccak(concat, 256);
  return Buffer.from(hash, "hex");
}

// Fee handling has been removed from the protocol.

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until the clock is `minOffset` to `maxOffset` seconds past a replay slice boundary and
 * returns it. In that window an authorization issued just before the boundary is still valid, so a
 * test can place one authorization in the previous slice and one in the current slice, which is
 * the adjacent-slice case. Slices are 256 seconds and an authorization lives for 128, so this
 * waits at most about two minutes.
 */
export async function waitForSlicePhase(
  minOffset = 2,
  maxOffset = 100
): Promise<number> {
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    const offset = now % REPLAY_SLICE_SECS;
    if (offset >= minOffset && offset <= maxOffset) return now;
    const waitSecs =
      offset > maxOffset
        ? REPLAY_SLICE_SECS - offset + minOffset
        : minOffset - offset;
    await sleep(waitSecs * 1000);
  }
}

export async function getOrCreateAssociatedTokenAccount(
  mint: PublicKey,
  owner: PublicKey,
  payer = authority.payer
): Promise<PublicKey> {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  try {
    await splGetAccount(provider.connection, ata);
  } catch {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint)
    );
    await sendAndConfirmTransaction(provider.connection, tx, [payer]);
  }
  return ata;
}

/**
 * Derive the replay bucket PDA for a fulfillment settler and nonce.
 * Seed layout mirrors on-chain: ["replay", settler, nonce[4..8]].
 */
export function deriveFulfillmentReplayBucket(
  nonce: NonceLike,
  settler: PublicKey
): [PublicKey, number] {
  const bucketSelector = deriveReplayBucketSelectorFromNonce(nonce);
  return PublicKey.findProgramAddressSync(
    [FULFILLMENT_REPLAY_SEED, settler.toBuffer(), bucketSelector],
    fulfillmentProgram.programId
  );
}

/**
 * Derive the strict-fulfillment marker PDA for a quote hash and settler.
 * Seed layout mirrors on-chain: ["strict_fulfilled", quote_hash, settler].
 */
export function deriveStrictFulfillment(
  quoteHash: Uint8Array | Buffer,
  settler: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("strict_fulfilled"),
      Buffer.from(quoteHash),
      settler.toBuffer(),
    ],
    fulfillmentProgram.programId
  )[0];
}

// ============================================================
// FEE CALCULATION HELPERS
// ============================================================

/**
 * Fee calculation configuration
 */
export interface FeeConfig {
  feePercentage6: bigint; // scaled by 1e6 (1_000_000 = 1%)
  minFee6: bigint; // scaled by 1e6
  maxFee6: bigint; // scaled by 1e6
}

const FEE_PERCENTAGE_SCALE = 100_000_000n; // 100% = 100_000_000
const FEE_6_SCALE = 1_000_000n; // 6-decimal normalization

/**
 * Compute expected fee in token atomics, mirroring on-chain algorithm.
 *
 * Algorithm:
 * 1. If amount == 0 -> invalid (not handled here, test should catch)
 * 2. Percentage fee = floor(amount * percentage / 100_000_000)
 * 3. Min clamp: fee = max(fee, min_fee_atoms)
 * 4. Max clamp: fee = min(fee, max_fee_atoms)
 *
 * @param amountAtoms - Deposit amount in token atomics
 * @param decimals - Token mint decimals
 * @param config - Fee configuration
 * @returns Expected fee in token atomics
 */
export function computeExpectedFeeAtoms(
  amountAtoms: bigint,
  decimals: number,
  config: FeeConfig
): bigint {
  const amount = amountAtoms;
  const decimalsFactor = 10n ** BigInt(decimals);

  // Step 2: Calculate percentage fee — CEILING, as (a*b + c - 1) / c.
  // This mirrors the on-chain `compute_fee`, which now takes the ceiling to match EVM/TVM's
  // `Escrow.determineFee` (Cantina F1). Truncating here would silently re-diverge the mirror
  // from the program and make these tests assert the old behaviour.
  let fee = 0n;
  if (config.feePercentage6 > 0n) {
    fee =
      (amount * config.feePercentage6 + FEE_PERCENTAGE_SCALE - 1n) /
      FEE_PERCENTAGE_SCALE;
  }

  // Step 3: Min fee clamp
  if (config.minFee6 > 0n) {
    const minFeeAtoms = (config.minFee6 * decimalsFactor) / FEE_6_SCALE;
    if (fee < minFeeAtoms) {
      fee = minFeeAtoms;
    }
  }

  // Step 4: Max fee clamp
  if (config.maxFee6 > 0n) {
    const maxFeeAtoms = (config.maxFee6 * decimalsFactor) / FEE_6_SCALE;
    if (fee > maxFeeAtoms) {
      fee = maxFeeAtoms;
    }
  }

  return fee;
}

/**
 * Get token account balance as bigint
 */
export async function getBalance(
  connection: anchor.web3.Connection,
  tokenAccount: PublicKey
): Promise<bigint> {
  const info = await splGetAccount(connection, tokenAccount);
  return BigInt(info.amount.toString());
}

/**
 * Assert token account balance delta
 */
export async function assertBalanceDelta(
  connection: anchor.web3.Connection,
  tokenAccount: PublicKey,
  expectedDelta: bigint,
  beforeBalance: bigint
): Promise<void> {
  const afterInfo = await splGetAccount(connection, tokenAccount);
  const actualDelta = BigInt(afterInfo.amount.toString()) - beforeBalance;
  // Use string comparison for better error messages with bigint values
  expect(actualDelta.toString()).to.equal(
    expectedDelta.toString(),
    `Balance delta mismatch: expected ${expectedDelta}, got ${actualDelta}`
  );
}

export async function getParsedTransaction(signature: string) {
  await provider.connection.confirmTransaction(signature, "confirmed");

  let tx = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    tx = await provider.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    if (tx === null) {
      tx = await provider.connection.getTransaction(signature, {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      });
    }
    if (tx !== null) {
      return tx;
    }
    await sleep(300);
  }

  throw new Error(`Transaction ${signature} was not available after retries`);
}

export async function findProgramEvent<T = any>(
  program: Program<any>,
  signature: string,
  eventName: string
): Promise<T> {
  const tx = await getParsedTransaction(signature);
  const logs = tx.meta?.logMessages ?? [];
  const parser = new anchor.EventParser(
    program.programId,
    new anchor.BorshCoder(program.idl)
  );

  const eventNameLower = eventName.toLowerCase();
  for (const event of parser.parseLogs(logs)) {
    if (event.name.toLowerCase() === eventNameLower) {
      return event.data as T;
    }
  }

  throw new Error(`Event ${eventName} not found in transaction ${signature}`);
}

// ============================================================
// TOKEN-2022 HELPERS
// ============================================================

/**
 * Setup a Token-2022 mint with optional extensions
 */
export async function setupToken2022MintAndFund(
  program: Program<Escrow>,
  anchorProvider: anchor.AnchorProvider,
  mintAuthority: Keypair,
  options: {
    decimals?: number;
    skipAllowlist?: boolean;
    freezeAuthority?: boolean;
    transferFee?: {
      feeBasisPoints: number;
      maxFee: bigint;
    };
    permanentDelegate?: PublicKey;
    nonTransferable?: boolean;
  } = {}
): Promise<{
  mint: PublicKey;
  mintFeeConfig: PublicKey | null;
  authorityAta: PublicKey;
}> {
  const decimals = options.decimals ?? MINT_DECIMALS;
  const mintKeypair = Keypair.generate();

  // Calculate extensions
  const extensions: ExtensionType[] = [];
  if (options.transferFee) {
    extensions.push(ExtensionType.TransferFeeConfig);
  }
  if (options.permanentDelegate) {
    extensions.push(ExtensionType.PermanentDelegate);
  }
  if (options.nonTransferable) {
    extensions.push(ExtensionType.NonTransferable);
  }

  const mintLen = getMintLen(extensions);
  const lamports =
    await anchorProvider.connection.getMinimumBalanceForRentExemption(mintLen);

  // Build transaction
  const tx = new anchor.web3.Transaction();

  // Create account
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: mintAuthority.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    })
  );

  // Initialize TransferFee extension if requested
  if (options.transferFee) {
    tx.add(
      createInitializeTransferFeeConfigInstruction(
        mintKeypair.publicKey,
        mintAuthority.publicKey, // transferFeeConfigAuthority
        mintAuthority.publicKey, // withdrawWithheldAuthority
        options.transferFee.feeBasisPoints,
        options.transferFee.maxFee,
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  // Initialize PermanentDelegate extension if requested
  if (options.permanentDelegate) {
    tx.add(
      createInitializePermanentDelegateInstruction(
        mintKeypair.publicKey,
        options.permanentDelegate,
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  if (options.nonTransferable) {
    tx.add(
      createInitializeNonTransferableMintInstruction(
        mintKeypair.publicKey,
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  // Initialize mint
  tx.add(
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      mintAuthority.publicKey,
      options.freezeAuthority ? mintAuthority.publicKey : null,
      TOKEN_2022_PROGRAM_ID
    )
  );

  await anchorProvider.sendAndConfirm(tx, [mintAuthority, mintKeypair]);

  // Create ATA and mint tokens
  const ata = await splGetOrCreateAssociatedTokenAccount(
    anchorProvider.connection,
    mintAuthority,
    mintKeypair.publicKey,
    mintAuthority.publicKey,
    false,
    undefined,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );

  await splMintToV2(
    anchorProvider.connection,
    mintAuthority,
    mintKeypair.publicKey,
    ata.address,
    mintAuthority,
    1_000_000_000_000n, // 1M tokens
    [],
    undefined,
    TOKEN_2022_PROGRAM_ID
  );

  let mintFeeConfig: PublicKey | null = null;

  if (!options.skipAllowlist) {
    const protocolConfig = await ensureProtocolInitialized(
      program,
      anchorProvider
    );
    mintFeeConfig = getMintFeeConfigAddress(
      mintKeypair.publicKey,
      program.programId
    );

    await program.methods
      .allowMint()
      .accountsPartial({
        tokenConfigAuthority: anchorProvider.wallet.publicKey,
        protocolConfig,
        mintAccount: mintKeypair.publicKey,
        mintFeeConfig,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  return {
    mint: mintKeypair.publicKey,
    mintFeeConfig,
    authorityAta: ata.address,
  };
}

/**
 * Setup a Token-2022 mint with TransferHook extension
 * pointing to our mock_transfer_hook program.
 *
 * @param program - The Escrow program instance
 * @param anchorProvider - The Anchor provider
 * @param mintAuthority - Keypair with authority over the mint
 * @param depositor - Keypair for the depositor who will receive tokens
 * @param options - Configuration options
 * @returns Object containing mint, mint fee config, depositor's ATA, and extra account meta list PDA
 */
export async function setupTransferHookMint(
  program: Program<Escrow>,
  anchorProvider: anchor.AnchorProvider,
  mintAuthority: Keypair,
  depositor: Keypair,
  options: {
    decimals?: number;
    skipAllowlist?: boolean;
    initialMintAmount?: bigint;
    /** Names this key in the hook's extra-account list as a signing, writable account. */
    hookSigner?: PublicKey;
  } = {}
): Promise<{
  mint: PublicKey;
  mintFeeConfig: PublicKey | null;
  depositorAta: PublicKey;
  extraAccountMetaList: PublicKey;
}> {
  const decimals = options.decimals ?? MINT_DECIMALS;
  const initialMintAmount = options.initialMintAmount ?? 1_000_000_000_000n; // 1M tokens
  const mintKeypair = Keypair.generate();

  // Calculate space needed for TransferHook extension
  const extensions: ExtensionType[] = [ExtensionType.TransferHook];
  const mintLen = getMintLen(extensions);
  const lamports =
    await anchorProvider.connection.getMinimumBalanceForRentExemption(mintLen);

  // Build transaction to create and initialize the mint
  const tx = new anchor.web3.Transaction();

  // 1. Create account for the mint
  tx.add(
    SystemProgram.createAccount({
      fromPubkey: mintAuthority.publicKey,
      newAccountPubkey: mintKeypair.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    })
  );

  // 2. Initialize TransferHook extension
  tx.add(
    createInitializeTransferHookInstruction(
      mintKeypair.publicKey,
      mintAuthority.publicKey, // transfer hook authority
      MOCK_TRANSFER_HOOK_PROGRAM_ID,
      TOKEN_2022_PROGRAM_ID
    )
  );

  // 3. Initialize mint
  tx.add(
    createInitializeMintInstruction(
      mintKeypair.publicKey,
      decimals,
      mintAuthority.publicKey,
      null, // freeze authority
      TOKEN_2022_PROGRAM_ID
    )
  );

  await anchorProvider.sendAndConfirm(tx, [mintAuthority, mintKeypair]);

  // Create ATA for depositor and mint tokens
  const depositorAta = await splGetOrCreateAssociatedTokenAccount(
    anchorProvider.connection,
    mintAuthority,
    mintKeypair.publicKey,
    depositor.publicKey,
    false,
    undefined,
    undefined,
    TOKEN_2022_PROGRAM_ID
  );

  await splMintToV2(
    anchorProvider.connection,
    mintAuthority,
    mintKeypair.publicKey,
    depositorAta.address,
    mintAuthority,
    initialMintAmount,
    [],
    undefined,
    TOKEN_2022_PROGRAM_ID
  );

  // Derive the extra account meta list PDA
  // This follows the standard pattern for transfer hook programs
  const [extraAccountMetaList] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mintKeypair.publicKey.toBuffer()],
    MOCK_TRANSFER_HOOK_PROGRAM_ID
  );

  // Initialize the extra account meta list account
  // This is required by Token-2022 when the TransferHook extension is enabled
  const mockTransferHookProgram = new Program<MockTransferHook>(
    mockTransferHookIdl,
    anchorProvider
  );

  await (options.hookSigner
    ? mockTransferHookProgram.methods.initializeExtraAccountMetaListWithSigner(
        options.hookSigner
      )
    : mockTransferHookProgram.methods.initializeExtraAccountMetaList()
  )
    .accountsPartial({
      extraAccountMetaList,
      mint: mintKeypair.publicKey,
      payer: anchorProvider.wallet.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  let mintFeeConfig: PublicKey | null = null;

  if (!options.skipAllowlist) {
    const protocolConfig = await ensureProtocolInitialized(
      program,
      anchorProvider
    );
    mintFeeConfig = getMintFeeConfigAddress(
      mintKeypair.publicKey,
      program.programId
    );

    await program.methods
      .allowMint()
      .accountsPartial({
        tokenConfigAuthority: anchorProvider.wallet.publicKey,
        protocolConfig,
        mintAccount: mintKeypair.publicKey,
        mintFeeConfig,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  return {
    mint: mintKeypair.publicKey,
    mintFeeConfig,
    depositorAta: depositorAta.address,
    extraAccountMetaList,
  };
}

export function buildTransferHookRemainingAccounts(
  extraAccountMetaList: PublicKey,
  extraAccounts: PublicKey[] = []
): AccountMeta[] {
  return [
    {
      pubkey: extraAccountMetaList,
      isSigner: false,
      isWritable: false,
    },
    {
      pubkey: MOCK_TRANSFER_HOOK_PROGRAM_ID,
      isSigner: false,
      isWritable: false,
    },
    ...extraAccounts.map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: true,
    })),
  ];
}

// ─── Deposit compute budget ──────────────────────────────────────────────────

/**
 * Compute-unit limit every `deposit` call must request.
 *
 * WHY THIS IS NOT OPTIONAL. Solana's default is 200k compute units per instruction, and a v4
 * deposit no longer fits inside it once the transaction also carries token/ATA setup: that setup
 * consumes ~42k, leaving the escrow ~203k, and it exceeds that. CORE-2120 grew `DepositInfo`
 * 249 -> 313 bytes, eroding what margin remained.
 *
 * WHY IT PRESENTS AS FLAKINESS. Whether a given run tips over depends on incidental work — most of
 * all whether an ATA has to be created — so the same test can pass and fail across runs with no
 * change to the code. A suite where only some call sites request a raised limit is one such
 * variation away from red, which is why this lives in one place and every deposit uses it rather
 * than being set at the sites that happened to fail first.
 *
 * PRODUCTION CLIENTS MUST DO THE SAME. This is not a test artifact: any client submitting a deposit
 * has to request a raised limit or the transaction fails identically. It belongs in the client SDK
 * and in the SVM cutover notes, not only here.
 */
export const DEPOSIT_COMPUTE_UNIT_LIMIT = 400_000;

/**
 * The compute-budget instruction to prepend to every `deposit` call's `preInstructions`.
 * Prepended rather than appended so the raised limit is in force for the whole transaction.
 */
export function depositComputeBudgetIx(): anchor.web3.TransactionInstruction {
  return anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
    units: DEPOSIT_COMPUTE_UNIT_LIMIT,
  });
}
