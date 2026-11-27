/**
 * In-memory fake of the Soroban RPC surface the scripts use, with just enough contract behaviour
 * (upload, create with constructor, roles, token config, TTL) to exercise orchestration and
 * idempotence. It is a MOCK: it proves the scripts send the right operations in the right order and
 * skip what is already done; it does not prove the contracts accept them. That needs a P30 network.
 */
import {
  Account,
  Address,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import { encodeValue } from './abi.js';
import { deriveContractId, sha256, toHex, tokenBalanceKey } from './ids.js';
import type { SorobanRpc } from './runner.js';

export interface SentOp {
  readonly kind: 'upload' | 'create' | 'invoke' | 'extend';
  readonly source: string;
  readonly fn?: string;
  readonly contract?: string;
  readonly args?: unknown[];
  readonly footprintKeys?: number;
}

interface Stored {
  readonly val: unknown;
  liveUntil: number;
}

export const WASM_A = Buffer.concat([
  Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  Buffer.from('escrow-wasm'),
]);
export const WASM_B = Buffer.concat([
  Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
  Buffer.from('proxy-wasm'),
]);

export class FakeChain implements SorobanRpc {
  passphrase: string;
  latestLedger = 1000;
  maxEntryTtl = 3_110_400;
  readonly sent: SentOp[] = [];
  readonly simulated: string[] = [];
  readonly accounts = new Map<string, number>();
  private readonly entries = new Map<string, Stored>();
  private readonly ctor = new Map<string, unknown[]>();
  private readonly roles = new Set<string>();
  private readonly tokens = new Map<string, Record<string, number | bigint>>();
  private readonly pending = new Map<string, xdr.ScVal | undefined>();
  private hashCounter = 0;

  constructor(passphrase: string, funded: string[] = []) {
    this.passphrase = passphrase;
    for (const a of funded) this.accounts.set(a, 100);
  }

  async getNetwork() {
    return { passphrase: this.passphrase, protocolVersion: '30' };
  }

  async getAccount(address: string): Promise<Account> {
    const seq = this.accounts.get(address);
    if (seq === undefined) throw new Error(`account ${address} not found`);
    return new Account(address, String(seq));
  }

  async getLatestLedger() {
    return { sequence: this.latestLedger, closeTime: String(this.closeTime) };
  }

  closeTime = 1_800_000_000;

  async getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse> {
    const entries: rpc.Api.LedgerEntryResult[] = [];
    for (const key of keys) {
      if (key.type === 'configSetting') {
        entries.push({
          key,
          val: {
            type: 'configSetting',
            configSetting: {
              type: 'configSettingStateArchival',
              stateArchivalSettings: { maxEntryTtl: this.maxEntryTtl },
            },
          } as unknown as xdr.LedgerEntryData,
          liveUntilLedgerSeq: this.latestLedger + 1_000_000,
        });
        continue;
      }
      const s = this.entries.get(key.toXDR('base64'));
      if (s !== undefined)
        entries.push({ key, val: s.val as xdr.LedgerEntryData, liveUntilLedgerSeq: s.liveUntil });
    }
    return { entries, latestLedger: this.latestLedger };
  }

  private codeKey(hash: Uint8Array) {
    return xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: Buffer.from(hash) }),
    ).toXDR('base64');
  }

  private instanceKey(id: string) {
    return xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(id).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
      }),
    ).toXDR('base64');
  }

  /** Test setup: pretend a contract instance already exists, running `wasmHashHex` */
  seedInstance(id: string, wasmHashHex: string) {
    this.entries.set(this.instanceKey(id), {
      val: {
        type: 'contractData',
        contractData: {
          val: {
            type: 'scvContractInstance',
            instance: {
              executable: {
                type: 'contractExecutableWasm',
                wasmHash: { value: Buffer.from(wasmHashHex, 'hex') },
              },
            },
          },
        },
      },
      liveUntil: this.latestLedger + 100,
    });
  }

  /** Test setup: `holder` has a balance entry in the Stellar Asset Contract `token`, live for 100 ledgers */
  seedBalance(token: string, holder: string, liveFor = 100) {
    this.entries.set(tokenBalanceKey(token, holder).toXDR('base64'), {
      val: { type: 'contractData', contractData: {} },
      liveUntil: this.latestLedger + liveFor,
    });
  }

  /** Test setup: the ledger a seeded entry lives until, undefined if it is not stored */
  liveUntilOf(key: xdr.LedgerKey): number | undefined {
    return this.entries.get(key.toXDR('base64'))?.liveUntil;
  }

  /** Test setup: state an admin changed outside the script (handoff, manual grants) */
  forceRole(role: string, account: string, on = true) {
    if (on) this.roles.add(`${role}:${account}`);
    else this.roles.delete(`${role}:${account}`);
  }

  forceToken(token: string, cfg: { pct: number; decimals: number }) {
    this.tokens.set(token, {
      fee_percentage_6: cfg.pct,
      min_fee_6: 0n,
      max_fee_6: 0n,
      token_decimals: cfg.decimals,
    });
  }

  forceAdmin(contract: string, admin: string) {
    const c = this.ctor.get(contract);
    if (c === undefined) throw new Error('no such contract');
    c[0] = admin;
  }

  private describe(tx: Transaction): SentOp {
    const op = tx.operations[0] as unknown as {
      type: string;
      func?: {
        type: string;
        wasm?: Buffer;
        createContractV2?: {
          contractIdPreimage: { fromAddress: { salt: { value: Uint8Array } } };
          executable: { wasmHash: { value: Uint8Array } };
          constructorArgs: xdr.ScVal[];
        };
        invokeContract?: {
          contractAddress: xdr.ScAddress;
          functionName: { toString(): string };
          args: xdr.ScVal[];
        };
      };
    };
    const source = tx.source;
    if (op.type === 'extendFootprintTtl') {
      return { kind: 'extend', source, footprintKeys: this.footprintLen(tx) };
    }
    const f = op.func;
    if (f?.type === 'hostFunctionTypeUploadContractWasm')
      return { kind: 'upload', source, args: [f.wasm] };
    if (f?.type === 'hostFunctionTypeCreateContractV2' && f.createContractV2) {
      const c = f.createContractV2;
      return {
        kind: 'create',
        source,
        args: [
          c.contractIdPreimage.fromAddress.salt.value,
          c.executable.wasmHash.value,
          c.constructorArgs.map((a) => scValToNative(a)),
        ],
      };
    }
    if (f?.type === 'hostFunctionTypeInvokeContract' && f.invokeContract) {
      const ic = f.invokeContract;
      return {
        kind: 'invoke',
        source,
        contract: Address.fromScAddress(ic.contractAddress).toString(),
        fn: ic.functionName.toString(),
        args: ic.args.map((a) => scValToNative(a)),
      };
    }
    throw new Error('fake chain: unsupported operation');
  }

  private sorobanDataOf(tx: Transaction): xdr.SorobanTransactionData | undefined {
    const env = tx.toEnvelope() as unknown as {
      value: { tx: { ext: { type: string; value: xdr.SorobanTransactionData } } };
    };
    return env.value.tx.ext.type === 'sorobanData' ? env.value.tx.ext.value : undefined;
  }

  private footprintLen(tx: Transaction): number {
    const env = tx.toEnvelope() as unknown as {
      type: string;
      value: {
        tx: { ext: { type: string; value: { resources: { footprint: { readOnly: unknown[] } } } } };
      };
    };
    const ext = env.value.tx.ext;
    return ext.type === 'sorobanData' ? ext.value.resources.footprint.readOnly.length : 0;
  }

  private contractIdFor(source: string, salt: Uint8Array) {
    return deriveContractId(this.passphrase, source, salt);
  }

  /** Result of running a read-only or mutating call against fake state; throws on a contract error */
  private run(op: SentOp, mutate: boolean): xdr.ScVal | undefined {
    if (op.kind === 'upload') {
      const wasm = op.args?.[0] as Buffer;
      if (mutate)
        this.entries.set(this.codeKey(sha256(wasm)), {
          val: { type: 'contractCode' },
          liveUntil: this.latestLedger + 100,
        });
      return undefined;
    }
    if (op.kind === 'create') {
      const [salt, hash, ctor] = op.args as [Uint8Array, Uint8Array, unknown[]];
      if (!this.entries.has(this.codeKey(hash))) throw new Error('missing wasm: upload it first');
      const id = this.contractIdFor(op.source, salt);
      if (mutate) {
        this.seedInstance(id, toHex(hash));
        this.ctor.set(id, ctor);
      }
      return new Address(id).toScVal();
    }
    if (op.kind === 'extend') {
      if (mutate)
        for (const s of this.entries.values())
          s.liveUntil = this.latestLedger + this.requestedExtend;
      return undefined;
    }
    const ctor = this.ctor.get(op.contract as string);
    if (ctor === undefined) throw new Error('contract does not exist');
    const a = op.args as unknown[];
    switch (op.fn) {
      case 'default_admin':
        return new Address(ctor[0] as string).toScVal();
      case 'default_admin_delay':
        return xdr.ScVal.scvU32(Number(ctor[ctor.length - 1]));
      case 'get_allowed_tokens':
        return xdr.ScVal.scvVec([...this.tokens.keys()].map((t) => new Address(t).toScVal()));
      case 'pauser':
        return new Address(ctor[1] as string).toScVal();
      case 'has_role':
        return xdr.ScVal.scvBool(this.roles.has(`${(a[0] as string[])[0]}:${a[1]}`));
      case 'grant_role':
        if (op.source !== ctor[0]) throw new Error('auth: default admin must sign grant_role');
        if (mutate) this.roles.add(`${(a[0] as string[])[0]}:${a[1]}`);
        return xdr.ScVal.scvVoid();
      case 'get_token_config': {
        const t = this.tokens.get(a[0] as string);
        return t === undefined
          ? xdr.ScVal.scvVoid()
          : encodeValue('TokenConfig', {
              fee_percentage_6: Number(t.fee_percentage_6),
              max_fee_6: BigInt(t.max_fee_6 ?? 0),
              min_fee_6: BigInt(t.min_fee_6 ?? 0),
              token_decimals: Number(t.token_decimals),
            });
      }
      case 'allow_token_and_set_fee_config':
      case 'set_token_fee_config': {
        const allow = op.fn === 'allow_token_and_set_fee_config';
        if (a[0] !== op.source || !this.roles.has(`TokenConfig:${a[0]}`))
          throw new Error('MissingRole');
        const off = allow ? 3 : 2;
        if (allow === this.tokens.has(a[1] as string))
          throw new Error(allow ? 'TokenAlreadyAllowed' : 'TokenNotAllowed');
        if (mutate) {
          const prev = this.tokens.get(a[1] as string);
          this.tokens.set(a[1] as string, {
            fee_percentage_6: a[off] as number,
            min_fee_6: a[off + 1] as bigint,
            max_fee_6: a[off + 2] as bigint,
            token_decimals: allow ? (a[2] as number) : (prev?.token_decimals as number),
          });
        }
        return xdr.ScVal.scvVoid();
      }
      default:
        throw new Error(`fake chain: unsupported function ${String(op.fn)}`);
    }
  }

  private requestedExtend = 0;

  async simulateTransaction(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse> {
    const op = this.describe(tx);
    this.simulated.push(op.kind === 'invoke' ? (op.fn as string) : op.kind);
    if (op.kind === 'extend')
      this.requestedExtend = Number((tx.operations[0] as unknown as { extendTo: number }).extendTo);
    try {
      const retval = this.run(op, false);
      return {
        id: '1',
        latestLedger: this.latestLedger,
        events: [],
        _parsed: true,
        // The real RPC echoes the footprint of an extend/restore it was given
        transactionData: new SorobanDataBuilder(this.sorobanDataOf(tx)),
        minResourceFee: '100',
        // the real RPC returns a result for every invokeHostFunction (void for upload), none for extend
        ...(op.kind === 'extend'
          ? {}
          : { result: { auth: [], retval: retval ?? xdr.ScVal.scvVoid() } }),
      } as unknown as rpc.Api.SimulateTransactionResponse;
    } catch (e) {
      return {
        id: '1',
        latestLedger: this.latestLedger,
        events: [],
        _parsed: true,
        error: (e as Error).message,
      } as rpc.Api.SimulateTransactionResponse;
    }
  }

  async sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse> {
    const op = this.describe(tx);
    const retval = this.run(op, true);
    this.sent.push(op);
    this.accounts.set(tx.source, (this.accounts.get(tx.source) ?? 0) + 1);
    const hash = `fakehash${++this.hashCounter}`;
    this.pending.set(hash, retval);
    return { status: 'PENDING', hash, latestLedger: this.latestLedger, latestLedgerCloseTime: 0 };
  }

  async pollTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    return {
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      txHash: hash,
      latestLedger: this.latestLedger,
      returnValue: this.pending.get(hash),
    } as unknown as rpc.Api.GetTransactionResponse;
  }
}

export function newAccount(): Keypair {
  return Keypair.random();
}

export function contractId(n: number): string {
  return StrKey.encodeContract(Buffer.alloc(32, n));
}

export { nativeToScVal };
