/**
 * Create the escrow delegate a Turnkey-managed Solana wallet needs before it can be
 * the SOURCE of a payment. Solana sibling of ../evm/approve-permit2.ts: there is no
 * Permit2 on Solana, so the equivalent allowance is the escrow program's own
 * `create_delegate` instruction. It creates an `EscrowDelegate` PDA for
 * (authority, mint) — seeds ["escrow_delegate", authority, mint] — and approves SPL
 * delegation of the authority's token account to that PDA. Every deposit then
 * decrements the delegate's `remaining_capacity`, so size it for the expected
 * volume. Without it the settler's deposit pre-flight fails with
 * "sender ATA ... delegate is null but escrow program ... expects <PDA>".
 *
 * The Turnkey signer only signs, so this script builds the instruction from the
 * escrow IDL, compiles a v0 transaction, signs it with the Turnkey Solana signer,
 * and broadcasts it via an RPC.
 *
 * Run it (workspace must be installed first with `pnpm install` at the repo root):
 *
 *   # 1000 USDC of capacity, 100 USDC per deposit, valid one year (whole units):
 *   npx tsx scripts/svm/create-delegate.ts <escrowProgramId> <mintBase58> 1000
 *   npx tsx scripts/svm/create-delegate.ts <escrowProgramId> <mintBase58> 1000 --max-transfer 100 --expires-days 365
 *
 *   # derive and print everything, read on-chain state, sign nothing:
 *   TURNKEY_WALLET_ADDRESS=<base58> npx tsx scripts/svm/create-delegate.ts <escrowProgramId> <mintBase58> 1000 --dry-run
 *
 * Env is read from `scripts/.env` (gitignored, see .env.example); anything already
 * exported in the shell wins over it.
 *
 * Required env:
 *   RPC_URL                  Solana JSON-RPC endpoint to broadcast on
 *   TURNKEY_ORGANIZATION_ID  Turnkey (sub-)organization id
 *   TURNKEY_API_PUBLIC_KEY   Turnkey API key (public)
 *   TURNKEY_API_PRIVATE_KEY  Turnkey API key (private)
 *   TURNKEY_WALLET_ID        Turnkey wallet id holding the account
 *     (or TURNKEY_WALLET_ADDRESS to discover the wallet id from an address)
 *   (--dry-run with TURNKEY_WALLET_ADDRESS needs none of the TURNKEY_* keys)
 * Optional env:
 *   TURNKEY_API_URL          Turnkey API base (default https://api.turnkey.com)
 *   TURNKEY_WALLET_ADDRESS   address to send from; discovers the wallet id
 *                            and is pinned as the expected resolved address
 *   TURNKEY_PINNED_ADDRESS   assert the wallet resolves to this exact address
 */
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getOrCreateTurnkeyClient, TurnkeySolanaSigner, noopLogger } from '../../src/index';
import { DEFAULT_API_URL, loadScriptEnv, readEnv } from '../_shared';

const IDL_PATH = fileURLToPath(
  new URL('../../../../../../contracts/svm/bindings/typescript/escrow-encoding/src/generated/escrow.json', import.meta.url),
);

// Anchor account layout: 8-byte discriminator, then the EscrowDelegate fields in IDL order.
const DELEGATE_ACCOUNT_LEN = 8 + 32 + 32 + 8 + 8 + 8 + 32;

const MIN_SOL_FOR_RENT = 0.005;

interface EscrowIdl {
  instructions: { name: string; discriminator: number[] }[];
  accounts: { name: string; discriminator: number[] }[];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

/** Whole units → base units using the mint's decimals; rejects more precision than the mint has. */
function toBaseUnits(whole: string, decimals: number): bigint {
  const m = whole.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`invalid amount: ${whole}`);
  const frac = (m[2] ?? '').padEnd(decimals, '0');
  if (frac.length > decimals) throw new Error(`amount ${whole} has more than ${decimals} decimals`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

/** Find the walletId holding an address — operators usually have the address, not the id. */
async function resolveWalletId(
  client: ReturnType<typeof getOrCreateTurnkeyClient>,
  address: string,
): Promise<string> {
  for (const w of await client.listWallets()) {
    const accounts = await client.listWalletAccounts(w.walletId);
    if (accounts.some((a) => a.address === address)) {
      return w.walletId;
    }
  }
  throw new Error(`no Turnkey wallet in this organization holds address ${address}`);
}

function decodeDelegate(idl: EscrowIdl, data: Buffer) {
  const disc = idl.accounts.find((a) => a.name === 'EscrowDelegate')?.discriminator;
  if (!disc) throw new Error('IDL has no EscrowDelegate account');
  if (data.length !== DELEGATE_ACCOUNT_LEN || !data.subarray(0, 8).equals(Buffer.from(disc))) {
    throw new Error(`account at the delegate PDA is not an EscrowDelegate (len ${data.length})`);
  }
  return {
    authority: new PublicKey(data.subarray(8, 40)),
    delegateSigner: new PublicKey(data.subarray(40, 72)),
    maxTransferSize: data.readBigUInt64LE(72),
    remainingCapacity: data.readBigUInt64LE(80),
    expiration: data.readBigUInt64LE(88),
    allowedMint: new PublicKey(data.subarray(96, 128)),
  };
}

async function main(): Promise<void> {
  loadScriptEnv();
  const positional: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max-transfer' || argv[i] === '--expires-days') i++;
    else if (!argv[i].startsWith('--')) positional.push(argv[i]);
  }
  const [programArg, mintArg, capacity] = positional;
  const maxTransferArg = option('max-transfer');
  const expiresDaysArg = option('expires-days') ?? '365';
  const dryRun = flag('dry-run');
  if (!programArg || !mintArg || !capacity) {
    console.error(
      'usage: tsx scripts/svm/create-delegate.ts <escrowProgramId> <mintBase58> <capacityWholeUnits> [--max-transfer N] [--expires-days N] [--dry-run]',
    );
    process.exit(1);
  }
  const escrowProgram = new PublicKey(programArg);
  const mint = new PublicKey(mintArg);
  const expiresDays = Number(expiresDaysArg);
  if (!Number.isInteger(expiresDays) || expiresDays <= 0) {
    console.error(`✗ --expires-days must be a positive integer, got ${expiresDaysArg}`);
    process.exit(1);
  }

  const idl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8')) as EscrowIdl;
  const ixDisc = idl.instructions.find((i) => i.name === 'create_delegate')?.discriminator;
  if (!ixDisc) throw new Error(`IDL at ${IDL_PATH} has no create_delegate instruction`);

  const connection = new Connection(readEnv('RPC_URL'), 'confirmed');

  // Resolve the sender. --dry-run with TURNKEY_WALLET_ADDRESS never touches Turnkey, so
  // the derivation can be checked before any credentials are handled.
  const walletAddress = process.env.TURNKEY_WALLET_ADDRESS;
  let signer: TurnkeySolanaSigner | undefined;
  let sender: PublicKey;
  if (dryRun && walletAddress && !process.env.TURNKEY_API_PRIVATE_KEY) {
    sender = new PublicKey(walletAddress);
  } else {
    const client = getOrCreateTurnkeyClient({
      organizationId: readEnv('TURNKEY_ORGANIZATION_ID'),
      apiUrl: process.env.TURNKEY_API_URL ?? DEFAULT_API_URL,
      apiPublicKey: readEnv('TURNKEY_API_PUBLIC_KEY'),
      apiPrivateKey: readEnv('TURNKEY_API_PRIVATE_KEY'),
      concurrencyLimit: 10,
      requestTimeoutMs: 30_000,
    });
    let walletId = process.env.TURNKEY_WALLET_ID;
    if (!walletId) {
      if (!walletAddress) {
        console.error('✗ set TURNKEY_WALLET_ID or TURNKEY_WALLET_ADDRESS');
        process.exit(1);
      }
      walletId = await resolveWalletId(client, walletAddress);
    }
    signer = new TurnkeySolanaSigner(client, {
      walletId,
      log: noopLogger,
      discoveryTimeoutMs: 30_000,
      pinnedAddress: walletAddress ?? process.env.TURNKEY_PINNED_ADDRESS,
    });
    await signer.initialize();
    sender = signer.identity.publicKey;
  }

  const [protocolConfig] = PublicKey.findProgramAddressSync([Buffer.from('protocol_config')], escrowProgram);
  const [mintFeeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('mint_fee_config'), mint.toBuffer()],
    escrowProgram,
  );
  const [escrowDelegate] = PublicKey.findProgramAddressSync(
    [Buffer.from('escrow_delegate'), sender.toBuffer(), mint.toBuffer()],
    escrowProgram,
  );
  const authorityAta = getAssociatedTokenAddressSync(mint, sender);

  const decimals = (await getMint(connection, mint)).decimals;
  const capacityBase = toBaseUnits(capacity, decimals);
  const maxTransferBase = maxTransferArg ? toBaseUnits(maxTransferArg, decimals) : capacityBase / 10n;
  const expiration = BigInt(Math.floor(Date.now() / 1000) + expiresDays * 86_400);

  console.log(`From:          ${sender.toBase58()}`);
  console.log(`Escrow:        ${escrowProgram.toBase58()}`);
  console.log(`Mint:          ${mint.toBase58()} (${decimals} decimals)`);
  console.log(`ATA:           ${authorityAta.toBase58()}`);
  console.log(`Delegate PDA:  ${escrowDelegate.toBase58()}`);
  console.log(`Capacity:      ${capacity} (${capacityBase} base units)`);
  console.log(`Max transfer:  ${maxTransferBase} base units per deposit`);
  console.log(`Expiration:    ${expiration} (${new Date(Number(expiration) * 1000).toISOString()})`);

  if (!(await connection.getAccountInfo(protocolConfig))) {
    throw new Error(`protocol_config ${protocolConfig.toBase58()} not found — wrong program or cluster`);
  }
  if (!(await connection.getAccountInfo(mintFeeConfig))) {
    throw new Error(`mint_fee_config ${mintFeeConfig.toBase58()} not found — mint not allowlisted on this escrow`);
  }

  const sol = (await connection.getBalance(sender)) / LAMPORTS_PER_SOL;
  console.log(`SOL balance:   ${sol}`);
  try {
    const ata = await getAccount(connection, authorityAta);
    console.log(`Token balance: ${ata.amount} base units`);
    console.log(`ATA delegate:  ${ata.delegate ? ata.delegate.toBase58() : 'null'} (delegated ${ata.delegatedAmount})`);
  } catch {
    console.log('Token account: missing (create_delegate creates it; fund it afterwards)');
  }

  const existing = await connection.getAccountInfo(escrowDelegate);
  if (existing) {
    const d = decodeDelegate(idl, existing.data);
    const expired = Number(d.expiration) < Date.now() / 1000;
    console.log('');
    console.log('Delegate already exists:');
    console.log(`  delegate_signer:    ${d.delegateSigner.toBase58()}`);
    console.log(`  remaining_capacity: ${d.remainingCapacity}`);
    console.log(`  max_transfer_size:  ${d.maxTransferSize}`);
    console.log(`  expiration:         ${d.expiration}${expired ? ' (EXPIRED)' : ''}`);
    console.log('Nothing to do — revoke_delegate first to resize or re-approve.');
    return;
  }

  if (dryRun) {
    console.log('');
    console.log('Dry run: nothing signed or broadcast.');
    return;
  }
  if (!signer) throw new Error('signer not initialized');
  if (sol < MIN_SOL_FOR_RENT) {
    throw new Error(`sender holds ${sol} SOL; needs at least ${MIN_SOL_FOR_RENT} for rent and fees`);
  }

  // create_delegate(delegate_signer, remaining_capacity, max_transfer_size, expiration); the
  // sender signs its own deposits, so it is also the delegate signer.
  const data = Buffer.concat([
    Buffer.from(ixDisc),
    sender.toBuffer(),
    u64le(capacityBase),
    u64le(maxTransferBase),
    u64le(expiration),
  ]);
  const ix = new TransactionInstruction({
    programId: escrowProgram,
    keys: [
      { pubkey: protocolConfig, isSigner: false, isWritable: false },
      { pubkey: sender, isSigner: true, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: mintFeeConfig, isSigner: false, isWritable: false },
      { pubkey: escrowDelegate, isSigner: false, isWritable: true },
      { pubkey: authorityAta, isSigner: false, isWritable: true },
      { pubkey: sender, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: sender,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const signed = await signer.signTransaction(new VersionedTransaction(message));

  const signature = await connection.sendRawTransaction(signed.serialize());
  console.log(`Broadcast: ${signature}`);
  const conf = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (conf.value.err) throw new Error(`transaction failed: ${JSON.stringify(conf.value.err)}`);

  const after = await getAccount(connection, authorityAta);
  console.log(`Confirmed. ATA delegate is now ${after.delegate?.toBase58()} (delegated ${after.delegatedAmount}).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
