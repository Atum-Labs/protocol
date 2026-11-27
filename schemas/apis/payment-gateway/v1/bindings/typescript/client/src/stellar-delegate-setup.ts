/**
 * The payer's one-time setup for paying from Stellar: register a delegate signer on the escrow
 * (`create_delegate`) and let the escrow pull the token (SEP-41 `approve`). Both are transactions
 * signed by the payer's own Stellar account; the delegate signer then signs each deposit offchain.
 *
 * What the escrow requires of them, which this module checks before anything is submitted:
 *
 * - one delegate record per (payer, token): `create_delegate` fails while one exists, even an expired
 *   one, so an existing record is reported and never replaced;
 * - `0 < max_transfer_size <= capacity`, both in the token's base units and within an `i128`;
 * - a non-zero ed25519 delegate key, and an `expiration` (Unix seconds) after the ledger's time. Each
 *   deposit must also fall before it;
 * - the payer's allowance to the escrow covers each deposit's `source_amount`: a deposit that exceeds
 *   either the allowance or the record's remaining capacity fails. Capacity is spent by each
 *   deposit and not given back by a refund, so register enough for the deposits you plan.
 *
 * The delegate may be the payer's own key or a separate one. A payment signed by a separate delegate
 * is built and signed by the SDK, but an offline verifier (`verifyPaymentRequest`) refuses it, since
 * the record is on chain.
 *
 * The record's `epoch` is assigned by the escrow, not chosen: it is read back after the record is
 * created and returned, and it is what `awardQuote` and `preparePaymentRequest` take as
 * `stellarDelegateEpoch`.
 *
 * Both transactions go through `@stellar/stellar-sdk`, an optional peer dependency loaded only here.
 */

import type { Transaction } from '@stellar/stellar-sdk';
import nacl from 'tweetnacl';
import {
  ACCOUNT_ADDRESS,
  Address,
  CONTRACT_ADDRESS,
  MAX_I128,
  PASSPHRASE_PUBLIC,
  PASSPHRASE_TESTNET,
} from '@atum-labs/stellar-escrow-encoding';
import { parseAssetIdentifier } from './asset-identifier';
import { resolveStellarRpcUrl } from './chain-adapters/stellar-clock';
import { loadStellarSdk, readStoredDelegateRecordWith } from './chain-adapters/stellar-delegate';
import type {
  StellarDelegateQuery,
  StellarStoredDelegateRecord,
  StellarSdkSlice,
} from './chain-adapters/stellar-delegate';

/** A delegate must outlive the ledger it is created in by at least this many seconds. */
export const STELLAR_DELEGATE_MIN_LIFETIME_SECS = 60n;

/** Seconds a ledger takes to close, for the default allowance expiry. */
const LEDGER_SECS = 5n;
/** Ledgers added to the default allowance expiry, so it outlives the delegate. */
const ALLOWANCE_LEDGER_MARGIN = 1000n;

const DECIMAL_UINT = /^(?:0|[1-9][0-9]*)$/;
const U32_MAX = 0xffffffff;
const U64_MAX = (1n << 64n) - 1n;

/** An argument of a contract call, as `createStellarDelegate` makes them. */
export type StellarCallArg =
  | { type: 'address'; value: string }
  | { type: 'bytes32'; value: Uint8Array }
  | { type: 'i128'; value: bigint }
  | { type: 'u64'; value: bigint }
  | { type: 'u32'; value: number };

/** One contract call signed by the payer's account. */
export interface StellarContractCall {
  contract: string;
  method: string;
  args: StellarCallArg[];
}

/** The latest closed ledger. */
export interface StellarLedgerHead {
  sequence: number;
  /** Close time, Unix seconds. */
  closeTime: bigint;
  /** The network's maximum ledger-entry lifetime from its state archival settings. */
  maxEntryTtl: number;
}

/**
 * What `createStellarDelegate` needs from the network. The default talks to a Soroban RPC through
 * `@stellar/stellar-sdk`; a caller can supply its own (an offline or test seam).
 */
export interface StellarSetupChain {
  latestLedger(): Promise<StellarLedgerHead>;
  /** The escrow's delegate record for the pair, or `undefined` when there is none. */
  readDelegate(query: {
    escrow: string;
    depositor: string;
    token: string;
  }): Promise<StellarStoredDelegateRecord | undefined>;
  /** Simulates, signs with the 32-byte ed25519 seed, submits and waits for success. */
  invoke(call: StellarContractCall, signerSeed: Uint8Array): Promise<{ hash: string }>;
}

/** The inputs of {@link createStellarDelegate}. */
export interface CreateStellarDelegateParams {
  /** The token the payer will pay with, `stellar:<network>/sep41:<C... token contract id>`. */
  sourceAsset: string;
  /** The escrow's `C...` contract id requested for this payment. It must match `trustedEscrow`. */
  escrow: string;
  /**
   * The expected escrow for the asset's Stellar network, from your application's trusted deployment
   * configuration. Keep this independent of the quote request, gateway defaults and the RPC.
   */
  trustedEscrow: string;
  /**
   * The payer's own Stellar account key, a 32-byte ed25519 seed as 64 hex digits. It signs both
   * transactions and names the depositor. Stellar's `S...` secret is not accepted.
   */
  depositorPrivateKey: string;
  /** The delegate signer's `G...` public key: the key whose seed signs each deposit. */
  delegateSigner: string;
  /** Total the delegate may deposit over its life, in the token's base units. */
  capacity: bigint | number | string;
  /** The most one deposit may take, in the token's base units. At most `capacity`. */
  maxTransferSize: bigint | number | string;
  /** When the delegate stops being usable, Unix seconds. Give this or `expiresInSeconds`. */
  expiration?: bigint | number | string;
  /** The delegate's life from the latest closed ledger, in seconds. Give this or `expiration`. */
  expiresInSeconds?: number;
  /** The token allowance to give the escrow, in base units. Defaults to `capacity`. */
  allowance?: bigint | number | string;
  /**
   * The ledger sequence the allowance lasts to. Defaults to the delegate's life at five seconds a
   * ledger, plus a margin. The allowance must fit within the network's maximum entry lifetime.
   */
  allowanceExpirationLedger?: number;
  /** Override the Soroban RPC. Defaults to the public testnet endpoint; other networks need one. */
  stellarRpcUrl?: string;
  /** The network passphrase, needed for a network other than `stellar:testnet` and `stellar:pubnet`. */
  networkPassphrase?: string;
  /** Replaces the Soroban RPC with your own network access. */
  chain?: StellarSetupChain;
}

/** The original absolute terms for finishing approval for an existing, unspent delegate. */
export interface FinishStellarDelegateApprovalParams extends Omit<
  CreateStellarDelegateParams,
  'expiresInSeconds' | 'expiration' | 'allowanceExpirationLedger'
> {
  finishApprovalForEpoch: bigint;
  expiration: bigint | number | string;
  allowanceExpirationLedger: number;
  expiresInSeconds?: never;
}

/** What {@link createStellarDelegate} registered. */
export interface CreateStellarDelegateResult {
  /** The payer's `G...` account, which the key derives. */
  depositor: string;
  /** The escrow-assigned `epoch` of the new record, to pass as `stellarDelegateEpoch`. */
  epoch: bigint;
  delegateSigner: string;
  capacity: bigint;
  maxTransferSize: bigint;
  /** Unix seconds. */
  expiration: bigint;
  allowance: bigint;
  allowanceExpirationLedger: number;
  createDelegateTxHash: string;
  approveTxHash: string;
}

export type FinishStellarDelegateApprovalResult = Omit<
  CreateStellarDelegateResult,
  'createDelegateTxHash'
> & { createDelegateTxHash?: never };

/**
 * Raised after the create transaction was confirmed when the delegate record or approval could
 * not be confirmed. The creation hash is always available. The epoch is present once the new
 * record has been read and validated.
 */
export class StellarDelegateSetupError extends Error {
  constructor(
    message: string,
    readonly createDelegateTxHash: string,
    readonly epoch: bigint | undefined,
    readonly expiration: bigint,
    readonly allowanceExpirationLedger: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StellarDelegateSetupError';
  }
}

/**
 * Registers a delegate signer for the payer, validates the new record, then approves the escrow
 * to pull the token and returns the record's epoch.
 *
 * A normal setup refuses an existing record. To finish an approval, supply the original absolute
 * expiry values and `finishApprovalForEpoch` after checking the current on-chain allowance. This
 * mode approves only an unchanged, unspent record with that epoch.
 */
export function createStellarDelegate(
  params: FinishStellarDelegateApprovalParams,
): Promise<FinishStellarDelegateApprovalResult>;
export function createStellarDelegate(
  params: CreateStellarDelegateParams,
): Promise<CreateStellarDelegateResult>;
export async function createStellarDelegate(
  params: CreateStellarDelegateParams | FinishStellarDelegateApprovalParams,
): Promise<CreateStellarDelegateResult | FinishStellarDelegateApprovalResult> {
  const source = parseAssetIdentifier(params.sourceAsset);
  if (source.namespace !== 'stellar') {
    throw new Error(
      `payment-gateway-client: createStellarDelegate needs a Stellar source asset, got ${source.chainId}`,
    );
  }
  const token = source.tokenAddress;
  requireAddress(token, CONTRACT_ADDRESS, 'the token');
  requireAddress(params.escrow, CONTRACT_ADDRESS, 'the escrow');
  requireAddress(params.trustedEscrow, CONTRACT_ADDRESS, 'the trusted escrow');
  if (params.escrow !== params.trustedEscrow) {
    throw new Error(
      'payment-gateway-client: the requested Stellar escrow does not match trustedEscrow',
    );
  }
  const seed = readSeed(params.depositorPrivateKey);
  const depositor = Address.account(nacl.sign.keyPair.fromSeed(seed).publicKey).toString();
  const delegateKey = readDelegateKey(params.delegateSigner);
  const capacity = readAmount(params.capacity, 'capacity');
  const maxTransferSize = readAmount(params.maxTransferSize, 'maxTransferSize');
  if (maxTransferSize > capacity) {
    throw new Error('payment-gateway-client: maxTransferSize must not exceed capacity');
  }
  const allowance =
    params.allowance === undefined ? capacity : readAmount(params.allowance, 'allowance');
  if (allowance < maxTransferSize) {
    throw new Error(
      'payment-gateway-client: allowance must cover at least one deposit of maxTransferSize',
    );
  }
  const finishExisting = 'finishApprovalForEpoch' in params;
  const finishEpoch = finishExisting ? params.finishApprovalForEpoch : undefined;
  if (
    finishExisting &&
    (typeof finishEpoch !== 'bigint' ||
      finishEpoch < 1n ||
      params.expiration === undefined ||
      params.allowanceExpirationLedger === undefined)
  ) {
    throw new Error(
      'payment-gateway-client: finishing approval needs a positive epoch and the original absolute expiration and allowance ledger',
    );
  }
  if ((params.expiration === undefined) === (params.expiresInSeconds === undefined)) {
    throw new Error('payment-gateway-client: give exactly one of expiration and expiresInSeconds');
  }
  if (
    params.allowanceExpirationLedger !== undefined &&
    (!Number.isInteger(params.allowanceExpirationLedger) ||
      params.allowanceExpirationLedger < 1 ||
      params.allowanceExpirationLedger > U32_MAX)
  ) {
    throw new Error('payment-gateway-client: allowanceExpirationLedger must be a ledger sequence');
  }

  const chain = params.chain ?? (await defaultChain(source.chainId, params));
  const head = await chain.latestLedger();

  // The escrow requires the expiry to be after the ledger's time; leave the transactions room to land.
  let expiration: bigint;
  if (params.expiration !== undefined) {
    expiration = readUnixSeconds(params.expiration, 'expiration');
  } else {
    const life = params.expiresInSeconds!;
    if (!Number.isInteger(life) || life <= 0) {
      throw new Error('payment-gateway-client: expiresInSeconds must be a positive integer');
    }
    expiration = head.closeTime + BigInt(life);
  }
  if (expiration <= head.closeTime + STELLAR_DELEGATE_MIN_LIFETIME_SECS) {
    throw new Error(
      `payment-gateway-client: the delegate's expiration ${expiration} is not at least ` +
        `${STELLAR_DELEGATE_MIN_LIFETIME_SECS}s after the latest ledger's close time ${head.closeTime}`,
    );
  }
  if (expiration > U64_MAX) {
    throw new Error('payment-gateway-client: expiration does not fit an unsigned 64-bit integer');
  }
  const allowanceExpirationLedger =
    params.allowanceExpirationLedger ?? defaultAllowanceExpiry(head, expiration);
  if (allowanceExpirationLedger <= head.sequence) {
    throw new Error(
      `payment-gateway-client: allowanceExpirationLedger ${allowanceExpirationLedger} is not after the latest ledger ${head.sequence}`,
    );
  }
  if (!Number.isInteger(head.maxEntryTtl) || head.maxEntryTtl <= 1 || head.maxEntryTtl > U32_MAX) {
    throw new Error(
      'payment-gateway-client: could not read the Stellar maximum ledger-entry lifetime',
    );
  }
  const maxAllowanceLedger = Math.min(head.sequence + head.maxEntryTtl - 1, U32_MAX);
  if (allowanceExpirationLedger > maxAllowanceLedger) {
    throw new Error(
      `payment-gateway-client: allowanceExpirationLedger ${allowanceExpirationLedger} exceeds the network limit ${maxAllowanceLedger}; shorten the delegate lifetime or pass an earlier allowanceExpirationLedger`,
    );
  }

  const query = { escrow: params.escrow, depositor, token };
  const existing = await chain.readDelegate(query);
  const expected = { delegateKey, capacity, maxTransferSize, expiration };
  let record: StellarStoredDelegateRecord;
  let createDelegateTxHash: string | undefined;
  if (finishEpoch !== undefined) {
    if (existing === undefined || existing.epoch !== finishEpoch) {
      throw new Error(
        'payment-gateway-client: finishing approval needs the matching existing delegate epoch',
      );
    }
    assertRecord(existing, expected, 'existing delegate');
    if (allowance > capacity) {
      throw new Error(
        'payment-gateway-client: recovery allowance cannot exceed the unspent delegate capacity',
      );
    }
    record = existing;
  } else {
    if (existing !== undefined) {
      throw new Error(
        `payment-gateway-client: ${depositor} already has a delegate record (epoch ${existing.epoch}` +
          (existing.expiration !== undefined ? `, expires ${existing.expiration}` : '') +
          `) for token ${token} at escrow ${params.escrow}: the escrow keeps one per pair, so revoke it ` +
          'with revoke_delegate first, or keep using it',
      );
    }

    const created = await chain.invoke(
      {
        contract: params.escrow,
        method: 'create_delegate',
        args: [
          { type: 'address', value: depositor },
          { type: 'address', value: token },
          { type: 'bytes32', value: delegateKey },
          { type: 'i128', value: capacity },
          { type: 'i128', value: maxTransferSize },
          { type: 'u64', value: expiration },
        ],
      },
      seed,
    );

    createDelegateTxHash = created.hash;
    try {
      const stored = await chain.readDelegate(query);
      if (stored === undefined) {
        throw new Error('the escrow has no delegate record for the payer');
      }
      assertRecord(stored, expected, `delegate created by ${created.hash}`);
      record = stored;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new StellarDelegateSetupError(
        `payment-gateway-client: create_delegate (${created.hash}) succeeded but its record could not be confirmed: ${reason}. Check the creation transaction and record before sending an approval.`,
        created.hash,
        undefined,
        expiration,
        allowanceExpirationLedger,
        { cause },
      );
    }
  }

  let approved: { hash: string };
  try {
    approved = await chain.invoke(
      {
        contract: token,
        method: 'approve',
        args: [
          { type: 'address', value: depositor },
          { type: 'address', value: params.escrow },
          { type: 'i128', value: allowance },
          { type: 'u32', value: allowanceExpirationLedger },
        ],
      },
      seed,
    );
  } catch (cause) {
    if (createDelegateTxHash === undefined) throw cause;
    throw new StellarDelegateSetupError(
      `payment-gateway-client: the delegate was registered (epoch ${record.epoch}, ` +
        `create_delegate ${createDelegateTxHash}) but token approval was not confirmed. Verify the existing allowance before retrying approval of ${allowance} for ${token}.`,
      createDelegateTxHash,
      record.epoch,
      expiration,
      allowanceExpirationLedger,
      { cause },
    );
  }

  const result = {
    depositor,
    epoch: record.epoch,
    delegateSigner: params.delegateSigner,
    capacity,
    maxTransferSize,
    expiration,
    allowance,
    allowanceExpirationLedger,
    approveTxHash: approved.hash,
  };
  return createDelegateTxHash === undefined ? result : { ...result, createDelegateTxHash };
}

function defaultAllowanceExpiry(head: StellarLedgerHead, expiration: bigint): number {
  const lifeLedgers = (expiration - head.closeTime + LEDGER_SECS - 1n) / LEDGER_SECS;
  const expiry = BigInt(head.sequence) + lifeLedgers + ALLOWANCE_LEDGER_MARGIN;
  if (expiry > BigInt(U32_MAX)) {
    throw new Error('payment-gateway-client: the delegate expires too far ahead for an allowance');
  }
  return Number(expiry);
}

function assertRecord(
  record: StellarStoredDelegateRecord,
  want: { delegateKey: Uint8Array; capacity: bigint; maxTransferSize: bigint; expiration: bigint },
  label: string,
): void {
  const differs = (what: string): never => {
    throw new Error(
      `payment-gateway-client: the ${label} has ` + `another ${what} than was asked for`,
    );
  };
  if (record.epoch < 1n) differs('epoch');
  if (
    record.delegateSigner === undefined ||
    Buffer.compare(Buffer.from(record.delegateSigner), Buffer.from(want.delegateKey)) !== 0
  ) {
    differs('delegate signer');
  }
  if (record.remainingCapacity !== want.capacity) differs('capacity');
  if (record.maxTransferSize !== want.maxTransferSize) differs('max transfer size');
  if (record.expiration !== want.expiration) differs('expiration');
}

function requireAddress(value: string, type: number, what: string): void {
  let address: Address;
  try {
    address = Address.fromStrkey(value);
  } catch {
    throw new Error(
      `payment-gateway-client: ${what} is not a ${type === CONTRACT_ADDRESS ? 'C...' : 'G...'} address`,
    );
  }
  if (address.type !== type) {
    throw new Error(
      `payment-gateway-client: ${what} is not a ${type === CONTRACT_ADDRESS ? 'C... contract' : 'G... account'} address`,
    );
  }
}

function readSeed(privateKey: string): Uint8Array {
  const hex =
    typeof privateKey === 'string' && privateKey.startsWith('0x')
      ? privateKey.slice(2)
      : privateKey;
  // Value-free: never interpolate the key.
  if (typeof hex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'payment-gateway-client: depositorPrivateKey must be a 32-byte ed25519 seed as 64 hex digits',
    );
  }
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function readDelegateKey(strkey: string): Uint8Array {
  let address: Address;
  try {
    address = Address.fromStrkey(strkey);
  } catch {
    throw new Error('payment-gateway-client: delegateSigner is not a G... public key');
  }
  if (address.type !== ACCOUNT_ADDRESS || address.isZero()) {
    throw new Error('payment-gateway-client: delegateSigner is not a non-zero G... public key');
  }
  return address.toBytes();
}

function readAmount(value: bigint | number | string, what: string): bigint {
  const text = typeof value === 'number' && !Number.isSafeInteger(value) ? 'x' : String(value);
  if (!DECIMAL_UINT.test(text) || BigInt(text) === 0n || BigInt(text) > MAX_I128) {
    throw new Error(
      `payment-gateway-client: ${what} must be a decimal integer from 1 to 2^127-1 (token base units)`,
    );
  }
  return BigInt(text);
}

function readUnixSeconds(value: bigint | number | string, what: string): bigint {
  const text = typeof value === 'number' && !Number.isSafeInteger(value) ? 'x' : String(value);
  if (!DECIMAL_UINT.test(text) || BigInt(text) === 0n) {
    throw new Error(`payment-gateway-client: ${what} must be a positive integer of Unix seconds`);
  }
  return BigInt(text);
}

// ─── The default chain: a Soroban RPC through @stellar/stellar-sdk ──────────────────────────────

/** Give up on an RPC read after this. */
const SETUP_RPC_TIMEOUT_MS = 10_000;
const TX_TIMEOUT_SECONDS = 60;
/** Allow a ledger to close after the transaction's time bound before ending confirmation polling. */
const TX_WAIT_MS = (TX_TIMEOUT_SECONDS + Number(LEDGER_SECS)) * 1_000;

/** The slice of `@stellar/stellar-sdk` the default chain submits transactions with. */
export interface StellarTxSdkSlice extends Omit<StellarSdkSlice, 'rpc'> {
  rpc: StellarSdkSlice['rpc'] & {
    Api: { isSimulationError(sim: unknown): sim is { error: unknown } };
    assembleTransaction(tx: unknown, sim: unknown): { build(): SetupTransaction };
  };
  Keypair: { fromRawEd25519Seed(seed: Uint8Array): { publicKey(): string } };
  TransactionBuilder: new (
    account: unknown,
    opts: { fee: string; networkPassphrase: string },
  ) => {
    addOperation(op: unknown): unknown;
    setTimeout(secs: number): unknown;
    build(): SetupTransaction;
  };
  Contract: new (id: string) => { call(method: string, ...args: unknown[]): unknown };
  BASE_FEE: string;
  nativeToScVal(value: unknown, opts?: { type: string }): unknown;
}

function networkPassphraseFor(chainId: string, override?: string): string {
  if (override !== undefined && override !== '') return override;
  if (chainId === 'stellar:testnet') return PASSPHRASE_TESTNET;
  if (chainId === 'stellar:pubnet') return PASSPHRASE_PUBLIC;
  throw new Error(
    `payment-gateway-client: ${chainId} has no known network passphrase: pass networkPassphrase`,
  );
}

export async function defaultChain(
  chainId: string,
  params: Pick<CreateStellarDelegateParams, 'stellarRpcUrl' | 'networkPassphrase'>,
): Promise<StellarSetupChain> {
  const rpcUrl = resolveStellarRpcUrl(chainId, params.stellarRpcUrl);
  if (!rpcUrl) {
    throw new Error(
      `payment-gateway-client: no Soroban RPC is known for ${chainId}: pass stellarRpcUrl`,
    );
  }
  const passphrase = networkPassphraseFor(chainId, params.networkPassphrase);
  const sdk = (await loadStellarSdk()) as unknown as StellarTxSdkSlice;
  return sorobanRpcChain(sdk, rpcUrl, passphrase);
}

/** The default {@link StellarSetupChain} over an injected SDK, so it is testable without the network. */
export function sorobanRpcChain(
  sdk: StellarTxSdkSlice,
  rpcUrl: string,
  networkPassphrase: string,
): StellarSetupChain {
  const allowHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(rpcUrl);
  const server = () =>
    new sdk.rpc.Server(rpcUrl, {
      allowHttp,
      timeout: SETUP_RPC_TIMEOUT_MS,
    }) as unknown as SetupServer;
  return {
    async latestLedger() {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger' }),
        signal: AbortSignal.timeout(SETUP_RPC_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Stellar RPC ${rpcUrl} returned HTTP ${res.status}`);
      const result = ((await res.json()) as { result?: Record<string, unknown> }).result;
      const sequence = result?.sequence;
      const closeTime = result?.closeTime;
      if (
        typeof sequence !== 'number' ||
        (typeof closeTime !== 'string' && typeof closeTime !== 'number')
      ) {
        throw new Error('Stellar getLatestLedger response has no sequence and closeTime');
      }
      const { xdr } = sdk;
      const archivalKey = xdr.LedgerKey.configSetting(
        new xdr.LedgerKeyConfigSetting({
          configSettingId: xdr.ConfigSettingId.configSettingStateArchival,
        }),
      );
      const { entries } = await server().getLedgerEntries(archivalKey);
      const setting = entries[0]?.val;
      if (
        setting?.type !== 'configSetting' ||
        setting.value.type !== 'configSettingStateArchival'
      ) {
        throw new Error(
          'payment-gateway-client: could not read the Stellar state archival settings',
        );
      }
      return {
        sequence,
        closeTime: BigInt(closeTime),
        maxEntryTtl: setting.value.value.maxEntryTtl,
      };
    },

    readDelegate(query) {
      const q: StellarDelegateQuery = { rpcUrl, timeoutMs: SETUP_RPC_TIMEOUT_MS, ...query };
      return readStoredDelegateRecordWith(sdk, q);
    },

    async invoke(call, signerSeed) {
      const keypair = sdk.Keypair.fromRawEd25519Seed(signerSeed) as unknown as SigningKeypair;
      const rpcServer = server();
      const account = await rpcServer.getAccount(keypair.publicKey());
      const builder = new sdk.TransactionBuilder(account, {
        fee: sdk.BASE_FEE,
        networkPassphrase,
      });
      builder.addOperation(
        new sdk.Contract(call.contract).call(call.method, ...call.args.map((a) => toScVal(sdk, a))),
      );
      builder.setTimeout(TX_TIMEOUT_SECONDS);
      const tx = builder.build();
      const sim = await rpcServer.simulateTransaction(tx);
      if (sdk.rpc.Api.isSimulationError(sim)) {
        throw new Error(`${call.method} failed in simulation: ${String(sim.error)}`);
      }
      const prepared = sdk.rpc.assembleTransaction(tx, sim).build();
      assertIntendedAuthorization(tx, prepared, keypair.publicKey());
      prepared.sign(keypair);
      const hash = Buffer.from(prepared.hash()).toString('hex');
      try {
        const sent = await rpcServer.sendTransaction(prepared);
        if (sent.status === 'ERROR' || sent.status === 'TRY_AGAIN_LATER') {
          throw new Error(`${call.method} was not accepted: ${sent.status}`);
        }
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`${reason} (transaction ${hash})`, { cause });
      }

      const deadline = Date.now() + TX_WAIT_MS;
      let readError: unknown;
      while (Date.now() <= deadline) {
        const done = await rpcServer.getTransaction(hash).catch((cause: unknown) => {
          readError = cause;
          return undefined;
        });
        if (done?.status === 'SUCCESS') return { hash };
        if (done?.status === 'FAILED') {
          throw new Error(`${call.method} failed on chain (${hash})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error(`${call.method} (${hash}) was not confirmed within ${TX_WAIT_MS}ms`, {
        cause: readError,
      });
    },
  };
}

type SigningKeypair = { publicKey(): string };

interface SetupTransaction extends Pick<Transaction, 'operations' | 'hash' | 'source'> {
  sign(keypair: SigningKeypair): void;
}

/** Inspect the authorization that actually goes into the transaction before signing it. */
function assertIntendedAuthorization(
  unsigned: SetupTransaction,
  prepared: SetupTransaction,
  source: string,
): void {
  const intended = unsigned.operations[0];
  const operation = prepared.operations[0];
  if (
    unsigned.source !== source ||
    prepared.source !== source ||
    unsigned.operations.length !== 1 ||
    prepared.operations.length !== 1 ||
    intended?.type !== 'invokeHostFunction' ||
    intended.func.type !== 'hostFunctionTypeInvokeContract' ||
    operation?.type !== 'invokeHostFunction' ||
    operation.func.type !== 'hostFunctionTypeInvokeContract' ||
    (operation.source !== undefined && operation.source !== source) ||
    operation.func.toXdr('base64') !== intended.func.toXdr('base64')
  ) {
    throw new Error(
      'payment-gateway-client: prepared Stellar operation differs from the requested contract call',
    );
  }

  const auth = operation.auth ?? [];
  const entry = auth[0];
  const root = entry?.rootInvocation;
  if (
    auth.length !== 1 ||
    entry?.credentials.type !== 'sorobanCredentialsSourceAccount' ||
    root?.subInvocations.length !== 0 ||
    root.function.type !== 'sorobanAuthorizedFunctionTypeContractFn' ||
    root.function.value.toXdr('base64') !== intended.func.value.toXdr('base64')
  ) {
    throw new Error(
      'payment-gateway-client: simulated Stellar authorization differs from the requested contract call',
    );
  }
}

interface SetupServer extends Pick<
  InstanceType<StellarSdkSlice['rpc']['Server']>,
  'getLedgerEntries'
> {
  getAccount(id: string): Promise<unknown>;
  simulateTransaction(tx: unknown): Promise<{ error?: unknown }>;
  sendTransaction(tx: unknown): Promise<{ status: string; hash: string }>;
  getTransaction(hash: string): Promise<{ status: string }>;
}

function toScVal(sdk: StellarTxSdkSlice, arg: StellarCallArg): unknown {
  switch (arg.type) {
    case 'address':
      return new sdk.Address(arg.value).toScVal();
    case 'bytes32':
      return sdk.nativeToScVal(Buffer.from(arg.value), { type: 'bytes' });
    case 'i128':
    case 'u64':
    case 'u32':
      return sdk.nativeToScVal(arg.value, { type: arg.type });
  }
}
