/**
 * Resolves the `epoch` of a payer's delegate record on the Stellar escrow, the one value of a
 * Stellar deposit that is on-chain state.
 *
 * The escrow's deposit digest commits to the epoch of the delegate record that authorises the
 * deposit (`get_delegate(depositor, token).epoch`, 1 for the first record of the pair and +1 for each
 * re-creation), so a deposit signed before a revoke stays void when the same signer is enrolled
 * again. The builder therefore needs the current epoch before the payer signs. It is never guessed:
 * with no delegate registered, or no way to read one, the build fails rather than sign a deposit the
 * escrow would void.
 *
 * The default reader reads the persistent `Delegate(depositor, token)` entry from a Soroban RPC with
 * `getLedgerEntries`. It uses `@stellar/stellar-sdk`, an optional peer dependency loaded only here,
 * so a caller that supplies the epoch itself (`stellarDelegateEpoch`) never loads it.
 */

import { Pubkey } from '@atum-labs/stellar-escrow-encoding';
import { resolveStellarRpcUrl } from './stellar-clock';

/** What a reader is asked for. */
export interface StellarDelegateQuery {
  rpcUrl: string;
  /** The escrow's `C...` contract id, from the chain defaults. */
  escrow: string;
  /** The payer's `G...` or `C...` account (the deposit's depositor). */
  depositor: string;
  /** The SEP-41 token's `C...` contract id. */
  token: string;
  timeoutMs: number;
}

/**
 * Reads the delegate record's epoch, or `undefined` when no live record exists for the pair. A
 * reader that cannot answer throws; it must not return a guess.
 */
export type StellarDelegateEpochReader = (
  query: StellarDelegateQuery,
) => Promise<bigint | undefined>;

/** The escrow's `Delegate` record for a (depositor, token), as `get_delegate` returns it. */
export interface StellarDelegateRecord {
  /** 1 for the first record of the pair, +1 for each re-creation. */
  epoch: bigint;
  /** The `G...` strkey of the ed25519 key whose signature over the deposit digest the escrow accepts. */
  delegateSigner: string;
  /** Still spendable; zero after `renounce_delegate`, and each deposit takes its charged amount. */
  remainingCapacity: bigint;
  maxTransferSize: bigint;
  /** Ledger time in unix seconds; the delegate is usable while the ledger time is below it. */
  expiration: bigint;
}

/**
 * Reads the whole delegate record, or `undefined` when none exists for the pair. A reader that
 * cannot answer throws; it must not return a guess. Unlike {@link StellarDelegateEpochReader} it
 * lets the build refuse a record the escrow would reject at `deposit`
 * ({@link assertStellarDelegateUsable}).
 */
export type StellarDelegateRecordReader = (
  query: StellarDelegateQuery,
) => Promise<StellarDelegateRecord | undefined>;

/** Give up on the delegate read after this. */
export const STELLAR_DELEGATE_RPC_TIMEOUT_MS = 5000;

const MAX_U64 = (1n << 64n) - 1n;

/**
 * The slice of `@stellar/stellar-sdk` the default reader uses, typed against the SDK itself so a
 * change to its shape fails the build, not a payment. The import is type-only: the SDK is an
 * optional peer and is loaded at runtime only when no epoch was supplied.
 */
export type StellarSdkSlice = Pick<
  typeof import('@stellar/stellar-sdk'),
  'Address' | 'xdr' | 'scValToNative' | 'rpc'
>;

export async function loadStellarSdk(): Promise<StellarSdkSlice> {
  try {
    return await import('@stellar/stellar-sdk');
  } catch (cause) {
    throw new Error(
      'payment-gateway-client: reading a Stellar delegate epoch needs the optional peer dependency ' +
        '@stellar/stellar-sdk (npm install @stellar/stellar-sdk), or pass stellarDelegateEpoch ' +
        "(the epoch from the escrow's get_delegate) instead",
      { cause },
    );
  }
}

/**
 * The default reader: the `Delegate(depositor, token)` entry of the escrow's persistent storage, as
 * `getLedgerEntries` returns it. An absent entry reads as no record. An entry whose lifetime has
 * ended (archived, and so not readable until restored) is an error, not an absent record: the payer
 * has a delegate and has to restore it.
 */
export const readDelegateEpochFromRpc: StellarDelegateEpochReader = async (query) => {
  return readDelegateEpochWith(await loadStellarSdk(), query);
};

/** The reader's logic over an injected SDK, so it is testable without the network. */
export async function readDelegateEpochWith(
  sdk: StellarSdkSlice,
  query: StellarDelegateQuery,
): Promise<bigint | undefined> {
  const record = await readDelegateNativeWith(sdk, query);
  if (record === undefined) return undefined;
  return integerOf(record, 'epoch');
}

/** The default record reader: the same entry as {@link readDelegateEpochFromRpc}, whole. */
export const readDelegateRecordFromRpc: StellarDelegateRecordReader = async (query) => {
  return readDelegateRecordWith(await loadStellarSdk(), query);
};

/** The record reader's logic over an injected SDK. Every member must be present and well formed. */
export async function readDelegateRecordWith(
  sdk: StellarSdkSlice,
  query: StellarDelegateQuery,
): Promise<StellarDelegateRecord | undefined> {
  const record = await readDelegateNativeWith(sdk, query);
  if (record === undefined) return undefined;
  const epoch = integerOf(record, 'epoch');
  const remainingCapacity = integerOf(record, 'remaining_capacity');
  const maxTransferSize = integerOf(record, 'max_transfer_size');
  const expiration = integerOf(record, 'expiration');
  const signer = record['delegate_signer'];
  if (!(signer instanceof Uint8Array) || signer.length !== 32) {
    throw new Error(
      'payment-gateway-client: the Stellar delegate record has no 32-byte delegate_signer',
    );
  }
  return {
    epoch,
    delegateSigner: Pubkey.fromBytes(signer).toString(),
    remainingCapacity,
    maxTransferSize,
    expiration,
  };
}

/**
 * The escrow's delegate record as stored, read leniently: `delegateSigner` is the raw 32-byte key and
 * a member the escrow did not return is `undefined`. `createStellarDelegate` reads back what it just
 * wrote with this and compares each member itself; the build-time check of a payer's record uses the
 * strict {@link StellarDelegateRecord} instead.
 */
export interface StellarStoredDelegateRecord {
  epoch: bigint;
  delegateSigner?: Uint8Array;
  remainingCapacity?: bigint;
  maxTransferSize?: bigint;
  expiration?: bigint;
}

/** The lenient read of the record: the same entry as {@link readDelegateRecordWith}'s. */
export async function readStoredDelegateRecordWith(
  sdk: StellarSdkSlice,
  query: StellarDelegateQuery,
): Promise<StellarStoredDelegateRecord | undefined> {
  const record = await readDelegateNativeWith(sdk, query);
  if (record === undefined) return undefined;
  const epoch = record['epoch'];
  if (typeof epoch !== 'bigint' && typeof epoch !== 'number') {
    throw new Error('payment-gateway-client: the Stellar delegate record has no numeric epoch');
  }
  const amount = (v: unknown): bigint | undefined =>
    typeof v === 'bigint' || typeof v === 'number' ? BigInt(v) : undefined;
  return {
    epoch: BigInt(epoch),
    ...(record['delegate_signer'] instanceof Uint8Array
      ? { delegateSigner: Uint8Array.from(record['delegate_signer']) }
      : {}),
    remainingCapacity: amount(record['remaining_capacity']),
    maxTransferSize: amount(record['max_transfer_size']),
    expiration: amount(record['expiration']),
  };
}

function integerOf(record: Record<string, unknown>, name: string): bigint {
  const value = record[name];
  if (typeof value !== 'bigint' && typeof value !== 'number') {
    throw new Error(`payment-gateway-client: the Stellar delegate record has no numeric ${name}`);
  }
  return BigInt(value);
}

/** The stored `Delegate` entry decoded to its native shape, or `undefined` when there is none. */
async function readDelegateNativeWith(
  sdk: StellarSdkSlice,
  query: StellarDelegateQuery,
): Promise<Record<string, unknown> | undefined> {
  const { Address, xdr, scValToNative, rpc } = sdk;
  // `DataKey::Delegate(depositor, token)`: a contracttype enum variant is a vec of the variant's
  // symbol and its fields.
  const key = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol('Delegate'),
    new Address(query.depositor).toScVal(),
    new Address(query.token).toScVal(),
  ]);
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(query.escrow).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  const server = new rpc.Server(query.rpcUrl, {
    allowHttp: /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(query.rpcUrl),
  });
  const response = await withTimeout(server.getLedgerEntries(ledgerKey), query.timeoutMs);
  const entry = response.entries[0];
  if (entry === undefined) return undefined;
  if (entry.liveUntilLedgerSeq !== undefined && entry.liveUntilLedgerSeq < response.latestLedger) {
    throw new Error(
      `payment-gateway-client: the Stellar delegate entry for ${query.depositor} is archived (live until ledger ${entry.liveUntilLedgerSeq}, ledger ${response.latestLedger} is current): restore it before signing a deposit`,
    );
  }
  if (entry.val.type !== 'contractData') {
    throw new Error('payment-gateway-client: the Stellar delegate entry is not contract data');
  }
  return (scValToNative(entry.val.contractData.val) ?? {}) as Record<string, unknown>;
}

/**
 * Refuses a delegate record the escrow would not accept a deposit under, so the payer finds out
 * before signing and the request does not pass the gateway and the auction only to revert at
 * `deposit`: a record whose `expiration` is at or before `issuedAt` (the escrow requires the ledger
 * time to be below it), one with no capacity left (a renounced record, or a spent one), and, when
 * `signerKey` is given, one whose registered signer is not that key (the escrow verifies the
 * signature against the record's signer, so a payer that signs with its own key while another key is
 * registered is refused at `deposit`).
 */
export function assertStellarDelegateUsable(
  record: StellarDelegateRecord,
  opts: { depositor: string; issuedAt: bigint; signerKey?: string },
): void {
  if (record.expiration <= opts.issuedAt) {
    throw new Error(
      `payment-gateway-client: the Stellar delegate for ${opts.depositor} expired at ${record.expiration} (issued_at is ${opts.issuedAt}): the payer must create a new delegate before a deposit can be signed`,
    );
  }
  if (record.remainingCapacity <= 0n) {
    throw new Error(
      `payment-gateway-client: the Stellar delegate for ${opts.depositor} has no capacity left (renounced or spent): the payer must create a new delegate before a deposit can be signed`,
    );
  }
  if (opts.signerKey !== undefined && opts.signerKey !== record.delegateSigner) {
    throw new Error(
      `payment-gateway-client: the key signing is ${opts.signerKey}, but the delegate registered for ${opts.depositor} is ${record.delegateSigner}: the escrow would refuse the deposit`,
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`payment-gateway-client: the Stellar RPC did not answer within ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolves the delegate epoch for a Stellar deposit: the caller's own value when supplied, else the
 * RPC read. Never returns a default: no record, no RPC, or an unreadable answer throws.
 */
export async function resolveStellarDelegateEpoch(opts: {
  sourceChainId: string;
  escrow: string;
  depositor: string;
  token: string;
  /** The epoch the caller already knows (from `get_delegate`, or what `create_delegate` returned). */
  epoch?: bigint | number | string;
  rpcUrlOverride?: string;
  reader?: StellarDelegateEpochReader;
  timeoutMs?: number;
}): Promise<bigint> {
  return (await resolveStellarDelegate(opts)).epoch;
}

/**
 * Resolves the delegate epoch for a Stellar deposit and, when the escrow's record was read, the
 * record: the caller's own `epoch` (no read, so no record), else `reader` (an epoch-only reader, so
 * no record), else the record read through the RPC (`recordReader` replaces it). The record is what
 * {@link assertStellarDelegateUsable} checks. Never returns a default.
 */
export async function resolveStellarDelegate(opts: {
  sourceChainId: string;
  escrow: string;
  depositor: string;
  token: string;
  epoch?: bigint | number | string;
  rpcUrlOverride?: string;
  reader?: StellarDelegateEpochReader;
  recordReader?: StellarDelegateRecordReader;
  timeoutMs?: number;
}): Promise<{ epoch: bigint; record?: StellarDelegateRecord }> {
  if (opts.epoch !== undefined) return { epoch: parseEpoch(opts.epoch, 'stellarDelegateEpoch') };
  const rpcUrl = resolveStellarRpcUrl(opts.sourceChainId, opts.rpcUrlOverride);
  if (!rpcUrl) {
    throw new Error(
      `payment-gateway-client: no Soroban RPC is known for ${opts.sourceChainId}: pass stellarRpcUrl, or stellarDelegateEpoch`,
    );
  }
  const query = {
    rpcUrl,
    escrow: opts.escrow,
    depositor: opts.depositor,
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? STELLAR_DELEGATE_RPC_TIMEOUT_MS,
  };
  const noDelegate = () =>
    new Error(
      `payment-gateway-client: ${opts.depositor} has no delegate registered for token ${opts.token} at ` +
        `escrow ${opts.escrow}: the payer must call create_delegate (and approve the escrow on the token) before a deposit can be signed`,
    );
  if (opts.reader !== undefined) {
    const epoch = await opts.reader(query);
    if (epoch === undefined) throw noDelegate();
    return { epoch: parseEpoch(epoch, 'the delegate epoch read from the escrow') };
  }
  const record = await (opts.recordReader ?? readDelegateRecordFromRpc)(query);
  if (record === undefined) throw noDelegate();
  return { epoch: parseEpoch(record.epoch, 'the delegate epoch read from the escrow'), record };
}

function parseEpoch(value: bigint | number | string, what: string): bigint {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || BigInt(text) < 1n || BigInt(text) > MAX_U64) {
    throw new Error(`payment-gateway-client: ${what} must be an integer from 1 to 2^64-1`);
  }
  return BigInt(text);
}
