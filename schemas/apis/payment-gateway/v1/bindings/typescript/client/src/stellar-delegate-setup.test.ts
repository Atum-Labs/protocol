// The payer's one-time Stellar setup, over a recording stand-in for the network. `@stellar/stellar-sdk`
// 17 ships an ESM-only dependency that jest's CommonJS runtime cannot load, so the default Soroban
// chain is tested over a recording stand-in for the slice of the SDK it uses; the same code runs
// against the real SDK and testnet in the one-off check described in the pull request.
import nacl from 'tweetnacl';
import { Address, PASSPHRASE_PUBLIC, PASSPHRASE_TESTNET } from '@atum-labs/stellar-escrow-encoding';
import {
  createStellarDelegate,
  defaultChain,
  sorobanRpcChain,
  StellarDelegateSetupError,
  STELLAR_DELEGATE_MIN_LIFETIME_SECS,
} from './stellar-delegate-setup';
import type {
  CreateStellarDelegateParams,
  FinishStellarDelegateApprovalParams,
  StellarContractCall,
  StellarSetupChain,
  StellarTxSdkSlice,
} from './stellar-delegate-setup';
import * as stellarDelegate from './chain-adapters/stellar-delegate';
import type { StellarStoredDelegateRecord } from './chain-adapters/stellar-delegate';

const fill = (byte: number) => new Uint8Array(32).fill(byte);
const contract = (byte: number) => Address.contract(fill(byte)).toString();
const keyOf = (seed: string) => nacl.sign.keyPair.fromSeed(Buffer.from(seed, 'hex'));

const PAYER_SEED = '22'.repeat(32);
const PAYER = Address.account(keyOf(PAYER_SEED).publicKey).toString();
const DELEGATE_PUBLIC = keyOf('33'.repeat(32)).publicKey;
const DELEGATE = Address.account(DELEGATE_PUBLIC).toString();
const ESCROW = contract(0xc0);
const TOKEN = contract(0xe1);
const HEAD = { sequence: 1000, closeTime: 1_800_000_000n, maxEntryTtl: 100_000 };

interface Recorded {
  steps: string[];
  calls: Array<{ call: StellarContractCall; signer: string }>;
}

/** A chain that records what it is asked, and answers with `record` once `create_delegate` ran. */
function fakeChain(
  opts: {
    existing?: StellarStoredDelegateRecord;
    record?: Partial<StellarStoredDelegateRecord> | null;
    failOn?: string;
  } = {},
): { chain: StellarSetupChain; rec: Recorded } {
  const rec: Recorded = { steps: [], calls: [] };
  let created = false;
  const chain: StellarSetupChain = {
    async latestLedger() {
      rec.steps.push('latestLedger');
      return HEAD;
    },
    async readDelegate(query) {
      rec.steps.push('readDelegate');
      expect(query).toEqual({ escrow: ESCROW, depositor: PAYER, token: TOKEN });
      if (!created) return opts.existing;
      if (opts.record === null) return undefined;
      const call = rec.calls[0]!.call.args;
      return {
        epoch: 4n,
        delegateSigner: DELEGATE_PUBLIC,
        remainingCapacity: (call[3] as { value: bigint }).value,
        maxTransferSize: (call[4] as { value: bigint }).value,
        expiration: (call[5] as { value: bigint }).value,
        ...opts.record,
      };
    },
    async invoke(call, signerSeed) {
      rec.steps.push(call.method);
      rec.calls.push({ call, signer: Buffer.from(signerSeed).toString('hex') });
      if (opts.failOn === call.method) throw new Error(`${call.method} reverted`);
      if (call.method === 'create_delegate') created = true;
      return { hash: `${call.method}-hash` };
    },
  };
  return { chain, rec };
}

const base = (chain: StellarSetupChain): CreateStellarDelegateParams => ({
  sourceAsset: `stellar:testnet/sep41:${TOKEN}`,
  escrow: ESCROW,
  trustedEscrow: ESCROW,
  depositorPrivateKey: PAYER_SEED,
  delegateSigner: DELEGATE,
  capacity: '50000000',
  maxTransferSize: '10000000',
  expiresInSeconds: 86400,
  chain,
});

describe('createStellarDelegate', () => {
  it('creates the delegate, reads its epoch back, then approves the escrow, signed by the payer', async () => {
    const { chain, rec } = fakeChain();
    const result = await createStellarDelegate(base(chain));

    expect(rec.steps).toEqual([
      'latestLedger',
      'readDelegate',
      'create_delegate',
      'readDelegate',
      'approve',
    ]);
    expect(rec.calls.map((c) => c.signer)).toEqual([PAYER_SEED, PAYER_SEED]);
    const [create, approve] = rec.calls.map((c) => c.call);
    expect(create).toEqual({
      contract: ESCROW,
      method: 'create_delegate',
      args: [
        { type: 'address', value: PAYER },
        { type: 'address', value: TOKEN },
        { type: 'bytes32', value: DELEGATE_PUBLIC },
        { type: 'i128', value: 50_000_000n },
        { type: 'i128', value: 10_000_000n },
        { type: 'u64', value: HEAD.closeTime + 86400n },
      ],
    });
    // The allowance defaults to the capacity and outlives the delegate: a ledger every five seconds,
    // plus a margin.
    expect(approve).toEqual({
      contract: TOKEN,
      method: 'approve',
      args: [
        { type: 'address', value: PAYER },
        { type: 'address', value: ESCROW },
        { type: 'i128', value: 50_000_000n },
        { type: 'u32', value: 1000 + 17280 + 1000 },
      ],
    });
    expect(result).toEqual({
      depositor: PAYER,
      epoch: 4n,
      delegateSigner: DELEGATE,
      capacity: 50_000_000n,
      maxTransferSize: 10_000_000n,
      expiration: HEAD.closeTime + 86400n,
      allowance: 50_000_000n,
      allowanceExpirationLedger: 19280,
      createDelegateTxHash: 'create_delegate-hash',
      approveTxHash: 'approve-hash',
    });
  });

  it('takes an absolute expiration, an allowance and an allowance ledger as given', async () => {
    const { chain, rec } = fakeChain();
    const result = await createStellarDelegate({
      ...base(chain),
      expiresInSeconds: undefined,
      expiration: HEAD.closeTime + 3600n,
      allowance: 12_000_000n,
      allowanceExpirationLedger: 5000,
    });
    expect(result).toMatchObject({
      expiration: HEAD.closeTime + 3600n,
      allowance: 12_000_000n,
      allowanceExpirationLedger: 5000,
    });
    expect(rec.calls[1]!.call.args.slice(2)).toEqual([
      { type: 'i128', value: 12_000_000n },
      { type: 'u32', value: 5000 },
    ]);
  });

  it('refuses an out-of-range default and explicit allowance before either write', async () => {
    const { chain, rec } = fakeChain();
    await expect(
      createStellarDelegate({ ...base(chain), expiresInSeconds: 365 * 86400 }),
    ).rejects.toThrow(/exceeds the network limit/);
    await expect(
      createStellarDelegate({
        ...base(chain),
        allowanceExpirationLedger: HEAD.sequence + HEAD.maxEntryTtl,
      }),
    ).rejects.toThrow(/exceeds the network limit/);
    expect(rec.calls).toEqual([]);
  });

  it('accepts an explicit allowance at the maximum ledger', async () => {
    const { chain } = fakeChain();
    const max = HEAD.sequence + HEAD.maxEntryTtl - 1;
    await expect(
      createStellarDelegate({ ...base(chain), allowanceExpirationLedger: max }),
    ).resolves.toMatchObject({ allowanceExpirationLedger: max });
  });

  it('accepts a 0x-prefixed seed and numeric amounts', async () => {
    const { chain } = fakeChain();
    const result = await createStellarDelegate({
      ...base(chain),
      depositorPrivateKey: '0x' + PAYER_SEED,
      capacity: 50_000_000,
      maxTransferSize: 10_000_000n,
    });
    expect(result.depositor).toBe(PAYER);
  });

  it('refuses an unexpected escrow before looking at the ledger', async () => {
    const { chain, rec } = fakeChain();
    await expect(createStellarDelegate({ ...base(chain), escrow: contract(0xa3) })).rejects.toThrow(
      /does not match trustedEscrow/,
    );
    expect(rec.steps).toEqual([]);
  });

  it('never replaces a delegate the payer already has, and submits nothing', async () => {
    const { chain, rec } = fakeChain({ existing: { epoch: 2n, expiration: 1n } });
    await expect(createStellarDelegate(base(chain))).rejects.toThrow(
      /already has a delegate record \(epoch 2, expires 1\)[^]*revoke it with revoke_delegate first/,
    );
    expect(rec.calls).toEqual([]);
  });

  describe('refuses what the escrow would refuse, before anything is submitted', () => {
    const cases: Array<[string, Partial<CreateStellarDelegateParams>, RegExp]> = [
      ['a zero capacity', { capacity: 0 }, /capacity must be a decimal integer from 1 to 2\^127-1/],
      [
        'a max transfer above the capacity',
        { maxTransferSize: '50000001' },
        /maxTransferSize must not exceed capacity/,
      ],
      ['a zero max transfer', { maxTransferSize: '0' }, /maxTransferSize must be a decimal/],
      [
        'a capacity above i128',
        { capacity: (1n << 127n).toString() },
        /capacity must be a decimal integer from 1 to 2\^127-1/,
      ],
      ['a negative capacity', { capacity: -5 }, /capacity must be a decimal integer/],
      ['a fractional capacity', { capacity: 1.5 }, /capacity must be a decimal integer/],
      ['a hex capacity', { capacity: '0x10' }, /capacity must be a decimal integer/],
      [
        'an allowance below one deposit',
        { allowance: '9999999' },
        /allowance must cover at least one deposit/,
      ],
      [
        'no expiry',
        { expiresInSeconds: undefined },
        /give exactly one of expiration and expiresInSeconds/,
      ],
      [
        'two expiries',
        { expiration: HEAD.closeTime + 3600n },
        /give exactly one of expiration and expiresInSeconds/,
      ],
      [
        'an expiry already past',
        { expiresInSeconds: undefined, expiration: HEAD.closeTime - 1n },
        /is not at least 60s after the latest ledger/,
      ],
      [
        'an expiry too close to the ledger to be used',
        {
          expiresInSeconds: undefined,
          expiration: HEAD.closeTime + STELLAR_DELEGATE_MIN_LIFETIME_SECS,
        },
        /is not at least 60s after the latest ledger/,
      ],
      ['a zero life', { expiresInSeconds: 0 }, /expiresInSeconds must be a positive integer/],
      [
        'an expiry that does not fit u64',
        { expiresInSeconds: undefined, expiration: 1n << 64n },
        /does not fit an unsigned 64-bit integer/,
      ],
      [
        'an allowance ledger that has passed',
        { allowanceExpirationLedger: 1000 },
        /is not after the latest ledger 1000/,
      ],
      [
        'an allowance ledger that is not a sequence',
        { allowanceExpirationLedger: 1.5 },
        /allowanceExpirationLedger must be a ledger sequence/,
      ],
      [
        'the zero delegate key',
        { delegateSigner: Address.account(fill(0)).toString() },
        /delegateSigner is not a non-zero G\.\.\. public key/,
      ],
      [
        'a contract as delegate signer',
        { delegateSigner: contract(0x33) },
        /delegateSigner is not a non-zero G\.\.\. public key/,
      ],
      [
        'a delegate signer that is not a strkey',
        { delegateSigner: 'nope' },
        /delegateSigner is not a G\.\.\. public key/,
      ],
      [
        'a token that is an account',
        { sourceAsset: `stellar:testnet/sep41:${PAYER}` },
        /the token is not a C\.\.\. contract address/,
      ],
      [
        'an escrow that is an account',
        { escrow: PAYER },
        /the escrow is not a C\.\.\. contract address/,
      ],
      [
        'a source on another chain',
        { sourceAsset: 'eip155:2/erc20:0x0000000000000000000000000000000000000008' },
        /needs a Stellar source asset/,
      ],
    ];
    it.each(cases)('%s', async (_name, change, message) => {
      const { chain, rec } = fakeChain();
      await expect(createStellarDelegate({ ...base(chain), ...change })).rejects.toThrow(message);
      expect(rec.calls).toEqual([]);
    });

    it.each(['', '00', 'zz'.repeat(32), '11'.repeat(31), 'S' + 'A'.repeat(55)])(
      'a payer key that is not a hex seed, without echoing it (%#)',
      async (bad) => {
        const { chain, rec } = fakeChain();
        let message = '';
        try {
          await createStellarDelegate({ ...base(chain), depositorPrivateKey: bad });
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toMatch(/depositorPrivateKey must be a 32-byte ed25519 seed/);
        if (bad !== '') expect(message).not.toContain(bad);
        expect(rec.calls).toEqual([]);
      },
    );
  });

  it('stops at a create_delegate that fails, without approving', async () => {
    const { chain, rec } = fakeChain({ failOn: 'create_delegate' });
    await expect(createStellarDelegate(base(chain))).rejects.toThrow('create_delegate reverted');
    expect(rec.steps).not.toContain('approve');
  });

  describe('checks the record it reads back, and approves nothing otherwise', () => {
    const wrong: Array<[string, Partial<StellarStoredDelegateRecord> | null, RegExp]> = [
      ['no record', null, /escrow has no delegate record/],
      ['another signer', { delegateSigner: fill(9) }, /another delegate signer/],
      ['a missing signer', { delegateSigner: undefined }, /another delegate signer/],
      ['another capacity', { remainingCapacity: 1n }, /another capacity/],
      ['another max transfer', { maxTransferSize: 1n }, /another max transfer size/],
      ['another expiration', { expiration: 1n }, /another expiration/],
      ['an epoch of zero', { epoch: 0n }, /another epoch/],
    ];
    it.each(wrong)('%s', async (_name, record, message) => {
      const { chain, rec } = fakeChain({ record });
      const failure = await createStellarDelegate(base(chain)).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(StellarDelegateSetupError);
      expect(failure).toMatchObject({
        createDelegateTxHash: 'create_delegate-hash',
        epoch: undefined,
        message: expect.stringMatching(message),
      });
      expect(rec.steps).not.toContain('approve');
    });
  });

  describe('finishes approval only for an unchanged existing delegate', () => {
    const record = {
      epoch: 4n,
      delegateSigner: DELEGATE_PUBLIC,
      remainingCapacity: 50_000_000n,
      maxTransferSize: 10_000_000n,
      expiration: HEAD.closeTime + 86400n,
    };
    const finish = (chain: StellarSetupChain): FinishStellarDelegateApprovalParams => ({
      ...base(chain),
      expiresInSeconds: undefined,
      expiration: record.expiration,
      allowanceExpirationLedger: 19280,
      finishApprovalForEpoch: record.epoch,
    });

    it('approves the original allowance without issuing a second create', async () => {
      const { chain, rec } = fakeChain({ existing: record });
      const result = await createStellarDelegate(finish(chain));
      expect(result).toMatchObject({ epoch: 4n, approveTxHash: 'approve-hash' });
      expect(result.createDelegateTxHash).toBeUndefined();
      expect(rec.calls.map(({ call }) => call.method)).toEqual(['approve']);
      expect(rec.calls[0]?.call.args.slice(2)).toEqual([
        { type: 'i128', value: 50_000_000n },
        { type: 'u32', value: 19280 },
      ]);
    });

    it.each([
      ['missing', undefined, /matching existing delegate epoch/],
      ['a different epoch', { ...record, epoch: 3n }, /matching existing delegate epoch/],
      [
        'a different expiration',
        { ...record, expiration: record.expiration + 1n },
        /another expiration/,
      ],
      [
        'partially spent',
        { ...record, remainingCapacity: record.remainingCapacity - 1n },
        /another capacity/,
      ],
    ])('refuses recovery if the record is %s', async (_label, existing, message) => {
      const { chain, rec } = fakeChain({ existing });
      await expect(createStellarDelegate(finish(chain))).rejects.toThrow(message);
      expect(rec.calls).toHaveLength(0);
    });

    it('refuses a larger allowance or a missing original allowance ledger', async () => {
      const { chain, rec } = fakeChain({ existing: record });
      await expect(
        createStellarDelegate({ ...finish(chain), allowance: 50_000_001n }),
      ).rejects.toThrow(/cannot exceed the unspent delegate capacity/);
      await expect(
        createStellarDelegate({ ...finish(chain), allowanceExpirationLedger: undefined as never }),
      ).rejects.toThrow(/original absolute expiration and allowance ledger/);
      expect(rec.calls).toHaveLength(0);
    });
  });

  it('reports a failed approve with what is already on chain, so only the approve is retried', async () => {
    const { chain } = fakeChain({ failOn: 'approve' });
    const error = await createStellarDelegate(base(chain)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StellarDelegateSetupError);
    const failure = error as StellarDelegateSetupError;
    expect(failure.createDelegateTxHash).toBe('create_delegate-hash');
    expect(failure.epoch).toBe(4n);
    expect(failure.expiration).toBe(HEAD.closeTime + 86400n);
    expect(failure.allowanceExpirationLedger).toBe(19280);
    expect(failure.message).toMatch(
      /registered \(epoch 4[^]*verify the existing allowance before retrying approval of 50000000/i,
    );
    expect((failure.cause as Error).message).toBe('approve reverted');
  });
});

describe('the default Soroban chain', () => {
  type Sent = { op: unknown; signed: boolean };
  function fakeSdk(opts: {
    simulationError?: string;
    missingAuthorization?: boolean;
    missingNetworkSettings?: boolean;
    sendStatus?: string;
    outcomes?: string[];
    initialReadError?: boolean;
    confirmationStatus?: string;
  }): {
    sdk: StellarTxSdkSlice;
    sent: Sent[];
    built: unknown[];
    serverOptions: unknown[];
  } {
    const sent: Sent[] = [];
    const built: unknown[] = [];
    const serverOptions: unknown[] = [];
    const outcomes = [...(opts.outcomes ?? ['SUCCESS'])];
    let readError = opts.initialReadError ?? false;
    const sdk = {
      Address: class {
        constructor(readonly strkey: string) {}
        toScVal() {
          return { sc: 'address', strkey: this.strkey };
        }
        toScAddress() {
          return {};
        }
      },
      xdr: {
        ConfigSettingId: { configSettingStateArchival: 'archival' },
        LedgerKeyConfigSetting: class {
          constructor(readonly input: { configSettingId: string }) {}
        },
        LedgerKey: { configSetting: (key: unknown) => key },
      },
      scValToNative: () => ({}),
      Keypair: {
        fromRawEd25519Seed: (seed: Uint8Array) => ({
          publicKey: () => `G-of-${Buffer.from(seed).toString('hex').slice(0, 4)}`,
        }),
      },
      TransactionBuilder: class {
        op: unknown;
        constructor(
          readonly account: unknown,
          readonly opts: unknown,
        ) {}
        addOperation(op: unknown) {
          this.op = op;
          return this;
        }
        setTimeout() {
          return this;
        }
        build() {
          built.push({ account: this.account, opts: this.opts, op: this.op });
          return {
            op: this.op,
            source: (this.account as { account: string }).account,
            operations: [
              {
                type: 'invokeHostFunction',
                func: {
                  type: 'hostFunctionTypeInvokeContract',
                  toXdr: () => 'invocation',
                  value: { toXdr: () => 'arguments' },
                },
              },
            ],
          };
        }
      },
      Contract: class {
        constructor(readonly id: string) {}
        call(method: string, ...args: unknown[]) {
          return { contract: this.id, method, args };
        }
      },
      BASE_FEE: '100',
      nativeToScVal: (value: unknown, o?: { type: string }) => ({ sc: o?.type, value }),
      rpc: {
        Server: class {
          constructor(url: string, opts: unknown) {
            serverOptions.push({ url, opts });
          }
          async getAccount(id: string) {
            return { account: id };
          }
          async getLedgerEntries(key: { input: { configSettingId: string } }) {
            expect(key.input.configSettingId).toBe('archival');
            return {
              entries: opts.missingNetworkSettings
                ? []
                : [
                    {
                      val: {
                        type: 'configSetting',
                        value: {
                          type: 'configSettingStateArchival',
                          value: { maxEntryTtl: 100_000 },
                        },
                      },
                    },
                  ],
            };
          }
          async simulateTransaction() {
            return opts.simulationError === undefined ? {} : { error: opts.simulationError };
          }
          async sendTransaction(tx: { op: unknown; signed?: boolean }) {
            sent.push({ op: tx.op, signed: tx.signed === true });
            return { status: opts.sendStatus ?? 'PENDING', hash: 'abc123' };
          }
          async getTransaction(hash: string) {
            expect(hash).toBe('ab'.repeat(32));
            if (readError) {
              readError = false;
              throw new Error('temporary read failure');
            }
            return { status: opts.confirmationStatus ?? outcomes.shift() ?? 'SUCCESS' };
          }
        },
        Api: {
          isSimulationError: (sim: { error?: unknown }) => sim.error !== undefined,
        },
        assembleTransaction: (tx: {
          op: unknown;
          source: string;
          operations: Array<{ func: { value: unknown } }>;
        }) => ({
          build: () => ({
            op: tx.op,
            source: tx.source,
            operations: tx.operations.map((operation) => ({
              ...operation,
              auth: opts.missingAuthorization
                ? []
                : [
                    {
                      credentials: { type: 'sorobanCredentialsSourceAccount' },
                      rootInvocation: {
                        subInvocations: [],
                        function: {
                          type: 'sorobanAuthorizedFunctionTypeContractFn',
                          value: operation.func.value,
                        },
                      },
                    },
                  ],
            })),
            hash: () => Buffer.from('ab'.repeat(32), 'hex'),
            signed: false,
            sign(this: { signed: boolean }) {
              this.signed = true;
            },
          }),
        }),
      },
    } as unknown as StellarTxSdkSlice;
    return { sdk, sent, built, serverOptions };
  }

  const call: StellarContractCall = {
    contract: ESCROW,
    method: 'create_delegate',
    args: [
      { type: 'address', value: PAYER },
      { type: 'bytes32', value: DELEGATE_PUBLIC },
      { type: 'i128', value: 7n },
      { type: 'u64', value: 8n },
      { type: 'u32', value: 9 },
    ],
  };
  const seed = Uint8Array.from(Buffer.from(PAYER_SEED, 'hex'));
  const url = 'https://soroban-testnet.stellar.org';

  it('builds the call from typed arguments, signs it with the payer key and waits for success', async () => {
    const { sdk, sent, built } = fakeSdk({ outcomes: ['NOT_FOUND', 'SUCCESS'] });
    // The wait between polls is one second; the stand-in answers the first poll as not yet applied.
    const result = await sorobanRpcChain(sdk, url, 'Test SDF Network ; September 2015').invoke(
      call,
      seed,
    );
    expect(result).toEqual({ hash: 'ab'.repeat(32) });
    expect(built[0]).toMatchObject({
      account: { account: 'G-of-2222' },
      opts: { fee: '100', networkPassphrase: 'Test SDF Network ; September 2015' },
      op: {
        contract: ESCROW,
        method: 'create_delegate',
        args: [
          { sc: 'address', strkey: PAYER },
          { sc: 'bytes', value: Buffer.from(DELEGATE_PUBLIC) },
          { sc: 'i128', value: 7n },
          { sc: 'u64', value: 8n },
          { sc: 'u32', value: 9 },
        ],
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.signed).toBe(true);
  }, 10_000);

  it.each([
    ['http://localhost:8000', true],
    ['http://127.0.0.1:8000', true],
    ['http://remote.example', false],
    ['https://remote.example', false],
  ])('sets allowHttp only for loopback (%s)', async (rpcUrl, allowHttp) => {
    const { sdk, serverOptions } = fakeSdk({});
    await sorobanRpcChain(sdk, rpcUrl, 'x').invoke(call, seed);
    expect(serverOptions).toEqual([{ url: rpcUrl, opts: { allowHttp, timeout: 10_000 } }]);
  });

  it.each([
    ['stellar:testnet', undefined, PASSPHRASE_TESTNET],
    ['stellar:pubnet', undefined, PASSPHRASE_PUBLIC],
    ['stellar:standalone', 'private ledger', 'private ledger'],
  ])('hands %s the expected transaction passphrase', async (network, override, passphrase) => {
    const { sdk, built } = fakeSdk({});
    const mock = jest.spyOn(stellarDelegate, 'loadStellarSdk').mockResolvedValue(sdk);
    try {
      const chain = await defaultChain(network, {
        stellarRpcUrl: url,
        networkPassphrase: override,
      });
      await chain.invoke(call, seed);
      expect(built[0]).toMatchObject({ opts: { networkPassphrase: passphrase } });
    } finally {
      mock.mockRestore();
    }
  });

  it('stops polling an unconfirmed transaction and reports its hash', async () => {
    jest.useFakeTimers();
    try {
      const { sdk, sent } = fakeSdk({ confirmationStatus: 'NOT_FOUND' });
      const result = expect(sorobanRpcChain(sdk, url, 'x').invoke(call, seed)).rejects.toThrow(
        /ababab.*was not confirmed within/,
      );
      await jest.advanceTimersByTimeAsync(67_000);
      await result;
      expect(sent).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('continues confirmation on a transient read failure without submitting twice', async () => {
    const { sdk, sent } = fakeSdk({ initialReadError: true });
    await expect(sorobanRpcChain(sdk, url, 'x').invoke(call, seed)).resolves.toEqual({
      hash: 'ab'.repeat(32),
    });
    expect(sent).toHaveLength(1);
  });

  it('does not sign or submit a call without the expected authorization', async () => {
    const { sdk, sent } = fakeSdk({ missingAuthorization: true });
    await expect(sorobanRpcChain(sdk, url, 'x').invoke(call, seed)).rejects.toThrow(
      /simulated Stellar authorization differs from the requested contract call/,
    );
    expect(sent).toEqual([]);
  });

  it('does not submit a call that fails in simulation', async () => {
    const { sdk, sent } = fakeSdk({ simulationError: 'HostError: Error(Contract, #12)' });
    await expect(sorobanRpcChain(sdk, url, 'x').invoke(call, seed)).rejects.toThrow(
      /create_delegate failed in simulation: HostError: Error\(Contract, #12\)/,
    );
    expect(sent).toEqual([]);
  });

  it('refuses a transaction the network does not accept, and one that fails on chain', async () => {
    for (const sendStatus of ['ERROR', 'TRY_AGAIN_LATER']) {
      await expect(
        sorobanRpcChain(fakeSdk({ sendStatus }).sdk, url, 'x').invoke(call, seed),
      ).rejects.toThrow(`was not accepted: ${sendStatus}`);
    }
    await expect(
      sorobanRpcChain(fakeSdk({ outcomes: ['FAILED'] }).sdk, url, 'x').invoke(call, seed),
    ).rejects.toThrow(/failed on chain \(ababab/);
  });

  it('reads the latest ledger from the RPC and refuses an answer without a close time', async () => {
    const original = global.fetch;
    try {
      global.fetch = (async () =>
        new Response(
          JSON.stringify({ result: { sequence: 123, closeTime: '1800000000' } }),
        )) as typeof fetch;
      expect(await sorobanRpcChain(fakeSdk({}).sdk, url, 'x').latestLedger()).toEqual({
        sequence: 123,
        closeTime: 1_800_000_000n,
        maxEntryTtl: 100_000,
      });
      await expect(
        sorobanRpcChain(fakeSdk({ missingNetworkSettings: true }).sdk, url, 'x').latestLedger(),
      ).rejects.toThrow(/could not read the Stellar state archival settings/);
      global.fetch = (async () =>
        new Response(JSON.stringify({ result: { sequence: 123 } }))) as typeof fetch;
      await expect(sorobanRpcChain(fakeSdk({}).sdk, url, 'x').latestLedger()).rejects.toThrow(
        /no sequence and closeTime/,
      );
      global.fetch = (async () => new Response('', { status: 503 })) as typeof fetch;
      await expect(sorobanRpcChain(fakeSdk({}).sdk, url, 'x').latestLedger()).rejects.toThrow(
        /returned HTTP 503/,
      );
    } finally {
      global.fetch = original;
    }
  });
});

describe('createStellarDelegate without a chain of its own', () => {
  it('needs an RPC on a network with no default, and a passphrase on one it does not know', async () => {
    const params = { ...base(undefined as never), chain: undefined };
    await expect(
      createStellarDelegate({ ...params, sourceAsset: `stellar:pubnet/sep41:${TOKEN}` }),
    ).rejects.toThrow(/no Soroban RPC is known for stellar:pubnet: pass stellarRpcUrl/);
    await expect(
      createStellarDelegate({
        ...params,
        sourceAsset: `stellar:standalone/sep41:${TOKEN}`,
        stellarRpcUrl: 'http://localhost:8000/rpc',
      }),
    ).rejects.toThrow(/no known network passphrase: pass networkPassphrase/);
  });
});
