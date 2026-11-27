import { Pubkey } from '@atum-labs/stellar-escrow-encoding';
import {
  assertStellarDelegateUsable,
  readDelegateEpochWith,
  readDelegateRecordWith,
  resolveStellarDelegate,
  resolveStellarDelegateEpoch,
  type StellarDelegateRecord,
  type StellarSdkSlice,
} from './stellar-delegate';

// `@stellar/stellar-sdk` 17 ships an ESM-only dependency its CommonJS build requires, which jest's
// CommonJS runtime cannot load, so the reader is tested over a recording stand-in for the slice of
// the SDK it uses; the reader is typed against the SDK itself, so the compiler checks the shape the
// stand-in cannot.
const ESCROW = 'CESCROW';
const TOKEN = 'CTOKEN';
const DEPOSITOR = 'GDEPOSITOR';

type Node = { kind: string; [k: string]: unknown };

function fakeSdk(
  entries: unknown[],
  asked: unknown[],
  native: (v: unknown) => unknown = () => ({}),
  latestLedger = 1000,
): StellarSdkSlice {
  class FakeAddress {
    constructor(readonly strkey: string) {}
    toScAddress() {
      return { kind: 'scAddress', strkey: this.strkey } as Node;
    }
    toScVal() {
      return { kind: 'scvAddress', strkey: this.strkey } as Node;
    }
  }
  class FakeServer {
    constructor(
      readonly url: string,
      readonly opts?: { allowHttp?: boolean },
    ) {
      servers.push({ url, allowHttp: opts?.allowHttp });
    }
    async getLedgerEntries(...keys: unknown[]) {
      asked.push(...keys);
      return { entries, latestLedger } as never;
    }
  }
  const servers: Array<{ url: string; allowHttp?: boolean }> = [];
  (fakeSdk as unknown as { servers: typeof servers }).servers = servers;
  return {
    Address: FakeAddress as never,
    xdr: {
      ScVal: {
        scvVec: (items: unknown[]) => ({ kind: 'scvVec', items }),
        scvSymbol: (name: string) => ({ kind: 'scvSymbol', name }),
      },
      LedgerKey: { contractData: (key: unknown) => ({ kind: 'ledgerKeyContractData', key }) },
      LedgerKeyContractData: class {
        constructor(args: Record<string, unknown>) {
          Object.assign(this, { kind: 'keyContractData', ...args });
        }
      } as never,
      ContractDataDurability: { persistent: 'persistent' },
    },
    scValToNative: native,
    rpc: { Server: FakeServer as never },
  } as unknown as StellarSdkSlice;
}

const entryOf = (val: unknown, type = 'contractData', liveUntilLedgerSeq?: number) => ({
  val: { type, contractData: { val } },
  liveUntilLedgerSeq,
});

const query = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  escrow: ESCROW,
  depositor: DEPOSITOR,
  token: TOKEN,
  timeoutMs: 1000,
};

describe('Stellar delegate epoch read', () => {
  it('asks for the escrow persistent DataKey::Delegate(depositor, token) entry', async () => {
    const asked: unknown[] = [];
    await readDelegateEpochWith(fakeSdk([], asked), query);
    // `#[contracttype] DataKey::Delegate(Address, Address)` is a vec of the variant's symbol and its two
    // fields, stored in the escrow's persistent storage.
    expect(asked).toEqual([
      {
        kind: 'ledgerKeyContractData',
        key: {
          kind: 'keyContractData',
          contract: { kind: 'scAddress', strkey: ESCROW },
          key: {
            kind: 'scvVec',
            items: [
              { kind: 'scvSymbol', name: 'Delegate' },
              { kind: 'scvAddress', strkey: DEPOSITOR },
              { kind: 'scvAddress', strkey: TOKEN },
            ],
          },
          durability: 'persistent',
        },
      },
    ]);
  });

  it('reads the epoch of the stored record, as a bigint', async () => {
    const val = { kind: 'record' };
    expect(
      await readDelegateEpochWith(
        fakeSdk([entryOf(val)], [], () => ({ epoch: 5n })),
        query,
      ),
    ).toBe(5n);
    expect(
      await readDelegateEpochWith(
        fakeSdk([entryOf(val)], [], () => ({ epoch: 2n ** 40n })),
        query,
      ),
    ).toBe(2n ** 40n);
  });

  it('reads no entry as no record, never as epoch 1', async () => {
    expect(await readDelegateEpochWith(fakeSdk([], []), query)).toBeUndefined();
  });

  it('refuses an entry whose lifetime has ended, and reads one that is still live', async () => {
    const val = { kind: 'record' };
    const native = () => ({ epoch: 3n });
    await expect(
      readDelegateEpochWith(fakeSdk([entryOf(val, 'contractData', 999)], [], native, 1000), query),
    ).rejects.toThrow(/is archived.*restore it/);
    expect(
      await readDelegateEpochWith(
        fakeSdk([entryOf(val, 'contractData', 1000)], [], native, 1000),
        query,
      ),
    ).toBe(3n);
  });

  it('refuses a record with no epoch and an entry that is not contract data', async () => {
    await expect(
      readDelegateEpochWith(
        fakeSdk([entryOf({})], [], () => ({})),
        query,
      ),
    ).rejects.toThrow(/no numeric epoch/);
    await expect(
      readDelegateEpochWith(fakeSdk([entryOf({}, 'account')], []), query),
    ).rejects.toThrow(/not contract data/);
  });

  it('allows plain http only for a local node', async () => {
    const sdk = fakeSdk([], []);
    await readDelegateEpochWith(sdk, { ...query, rpcUrl: 'http://localhost:8000/rpc' });
    await readDelegateEpochWith(sdk, { ...query, rpcUrl: 'http://soroban.example/rpc' });
    await readDelegateEpochWith(sdk, { ...query, rpcUrl: 'http://localhost.evil.example/rpc' });
    const servers = (fakeSdk as unknown as { servers: Array<{ allowHttp?: boolean }> }).servers;
    expect(servers.slice(-3).map((s) => s.allowHttp)).toEqual([true, false, false]);
  });

  it('gives up when the RPC does not answer in time', async () => {
    const stalled = {
      ...fakeSdk([], []),
      rpc: {
        Server: class {
          getLedgerEntries() {
            return new Promise<never>(() => undefined);
          }
        } as never,
      },
    } as unknown as StellarSdkSlice;
    await expect(readDelegateEpochWith(stalled, { ...query, timeoutMs: 20 })).rejects.toThrow(
      /did not answer within 20ms/,
    );
  });
});

describe('resolveStellarDelegateEpoch', () => {
  const base = {
    sourceChainId: 'stellar:testnet',
    escrow: ESCROW,
    depositor: DEPOSITOR,
    token: TOKEN,
  };

  it('needs an RPC on a network with no default, unless the epoch is supplied', async () => {
    await expect(
      resolveStellarDelegateEpoch({ ...base, sourceChainId: 'stellar:pubnet' }),
    ).rejects.toThrow(/pass stellarRpcUrl, or stellarDelegateEpoch/);
    expect(
      await resolveStellarDelegateEpoch({ ...base, sourceChainId: 'stellar:pubnet', epoch: '4' }),
    ).toBe(4n);
  });

  it('uses the override RPC over the default', async () => {
    let url = '';
    await resolveStellarDelegateEpoch({
      ...base,
      rpcUrlOverride: 'http://localhost:8000/rpc',
      reader: async (q) => {
        url = q.rpcUrl;
        return 1n;
      },
    });
    expect(url).toBe('http://localhost:8000/rpc');
  });

  it('refuses an epoch outside 1..2^64-1 from the reader too', async () => {
    await expect(resolveStellarDelegateEpoch({ ...base, reader: async () => 0n })).rejects.toThrow(
      /integer from 1 to 2\^64-1/,
    );
  });
});

const SIGNER_BYTES = new Uint8Array(32).fill(0x77);
const SIGNER = Pubkey.fromBytes(SIGNER_BYTES).toString();
// What `scValToNative` returns for the escrow's `Delegate` struct.
const nativeRecord = (over: Record<string, unknown> = {}) => ({
  epoch: 5n,
  delegate_signer: SIGNER_BYTES,
  remaining_capacity: 1000n,
  max_transfer_size: 500n,
  expiration: 2000000000n,
  ...over,
});
const RECORD: StellarDelegateRecord = {
  epoch: 5n,
  delegateSigner: SIGNER,
  remainingCapacity: 1000n,
  maxTransferSize: 500n,
  expiration: 2000000000n,
};

describe('Stellar delegate record read', () => {
  const val = { kind: 'record' };

  it('reads epoch, signer as a G strkey, capacity, transfer max and expiration', async () => {
    expect(
      await readDelegateRecordWith(
        fakeSdk([entryOf(val)], [], () => nativeRecord()),
        query,
      ),
    ).toEqual(RECORD);
  });

  it('reads no entry as no record, and refuses an archived one as the epoch read does', async () => {
    expect(await readDelegateRecordWith(fakeSdk([], []), query)).toBeUndefined();
    await expect(
      readDelegateRecordWith(
        fakeSdk([entryOf(val, 'contractData', 999)], [], () => nativeRecord(), 1000),
        query,
      ),
    ).rejects.toThrow(/is archived.*restore it/);
  });

  it('refuses a record missing or malforming any member', async () => {
    for (const name of ['epoch', 'remaining_capacity', 'max_transfer_size', 'expiration']) {
      await expect(
        readDelegateRecordWith(
          fakeSdk([entryOf(val)], [], () => nativeRecord({ [name]: undefined })),
          query,
        ),
      ).rejects.toThrow(new RegExp(`no numeric ${name}`));
    }
    for (const bad of [undefined, new Uint8Array(31), 'GABC']) {
      await expect(
        readDelegateRecordWith(
          fakeSdk([entryOf(val)], [], () => nativeRecord({ delegate_signer: bad })),
          query,
        ),
      ).rejects.toThrow(/no 32-byte delegate_signer/);
    }
  });
});

describe('resolveStellarDelegate', () => {
  const base = {
    sourceChainId: 'stellar:testnet',
    escrow: ESCROW,
    depositor: DEPOSITOR,
    token: TOKEN,
  };

  it('returns the record the record reader read, next to its epoch', async () => {
    expect(await resolveStellarDelegate({ ...base, recordReader: async () => RECORD })).toEqual({
      epoch: 5n,
      record: RECORD,
    });
  });

  it('returns no record for a supplied epoch or an epoch-only reader, so nothing can be checked', async () => {
    expect(await resolveStellarDelegate({ ...base, epoch: '4' })).toEqual({ epoch: 4n });
    expect(
      await resolveStellarDelegate({
        ...base,
        reader: async () => 6n,
        recordReader: async () => {
          throw new Error('not read when an epoch reader is given');
        },
      }),
    ).toEqual({ epoch: 6n });
  });

  it('fails when the payer has no delegate, and on an epoch outside 1..2^64-1', async () => {
    await expect(
      resolveStellarDelegate({ ...base, recordReader: async () => undefined }),
    ).rejects.toThrow(/no delegate registered/);
    await expect(
      resolveStellarDelegate({ ...base, recordReader: async () => ({ ...RECORD, epoch: 0n }) }),
    ).rejects.toThrow(/integer from 1 to 2\^64-1/);
  });

  it('keeps resolveStellarDelegateEpoch returning the epoch alone', async () => {
    expect(
      await resolveStellarDelegateEpoch({
        ...base,
        reader: async () => 9n,
      }),
    ).toBe(9n);
  });
});

// The escrow accepts a deposit only while the ledger time is below the record's expiration, the
// charged amount fits the remaining capacity, and the signature verifies under the record's signer
// (escrow lib.rs `deposit`). Each of these reverts there, after the request has passed the gateway.
describe('assertStellarDelegateUsable', () => {
  const issuedAt = 1_900_000_000n;
  const opts = { depositor: DEPOSITOR, issuedAt };

  it('accepts a live record with capacity, with or without the signer pinned', () => {
    expect(() => assertStellarDelegateUsable(RECORD, opts)).not.toThrow();
    expect(() => assertStellarDelegateUsable(RECORD, { ...opts, signerKey: SIGNER })).not.toThrow();
  });

  it('refuses a record that has expired at issued_at, and one that expires exactly then', () => {
    for (const expiration of [issuedAt - 1n, issuedAt]) {
      expect(() => assertStellarDelegateUsable({ ...RECORD, expiration }, opts)).toThrow(
        /expired at/,
      );
    }
    expect(() =>
      assertStellarDelegateUsable({ ...RECORD, expiration: issuedAt + 1n }, opts),
    ).not.toThrow();
  });

  it('refuses a record with no capacity left, which is what a renounced record has', () => {
    expect(() => assertStellarDelegateUsable({ ...RECORD, remainingCapacity: 0n }, opts)).toThrow(
      /no capacity left/,
    );
  });

  it('refuses a payer whose key is not the registered signer, and says which keys', () => {
    const other = Pubkey.fromBytes(new Uint8Array(32).fill(0x11)).toString();
    expect(() => assertStellarDelegateUsable(RECORD, { ...opts, signerKey: other })).toThrow(
      new RegExp(
        `the key signing is ${other}, but the delegate registered for ${DEPOSITOR} is ${SIGNER}`,
      ),
    );
  });
});
