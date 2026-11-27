/**
 * Smoke script tests. The chain here is an in-memory MODEL that re-verifies every signature and
 * digest with the same TS encoders the script uses, so these tests prove the script wires the
 * arguments, signers and ordering correctly. They do NOT prove the Soroban contract accepts the
 * result; that is what the (not yet executed) real smoke run is for.
 */
import { Keypair, StrKey, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  Address,
  Pubkey,
  computeActiveDepositHash,
  computeDepositHash,
  computeDestinationHash,
  computeRefundHash,
  computeReleaseHash,
  computeReserveHash,
  PASSPHRASE_TESTNET,
  newEscrowDomain,
} from '@atum-labs/stellar-escrow-encoding';
import { describe, expect, it } from 'vitest';
import { encodeValue } from './abi.js';
import { UsageError } from './args.js';
import { NetworkGuardError } from './networks.js';
import { ledgerCloseTime, loadSmokeKeys, parseSmokeArgs } from './smoke-deposit-release.js';
import {
  SMOKE_BANNER,
  buildDeposit,
  decideDelegate,
  runSmoke,
  settlementWitness,
  type SmokeChain,
  type SmokeKeys,
} from './smoke-lib.js';

const escrow = StrKey.encodeContract(Buffer.alloc(32, 0xe1));
const token = StrKey.encodeContract(Buffer.alloc(32, 0xaa));
const keys: SmokeKeys = {
  depositor: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)),
  delegate: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)),
  reserver: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)),
  releaser: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)),
  submitter: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 5)),
};
const settler = keys.submitter.publicKey();
const domain = newEscrowDomain(PASSPHRASE_TESTNET, Address.fromStrkey(escrow));

const native = (v: xdr.ScVal) => scValToNative(v) as unknown;
const toBytes = (b: unknown) => new Uint8Array(b as Uint8Array);

class ModelChain implements SmokeChain {
  readonly calls: { who: string; fn: string }[] = [];
  readonly balances = new Map<string, bigint>();
  readonly deposits = new Map<string, Uint8Array>();
  delegate:
    | { signer: Uint8Array; remaining: bigint; max: bigint; expiration: bigint; epoch?: bigint }
    | undefined;
  /** Epoch of the last record created for the (depositor, token); the contract bumps it per creation */
  lastEpoch = 0n;
  allowance = 0n;
  feeRevenue = 0n;
  usedNonces = new Set<string>();
  missingAccount: string | undefined;
  clock = 1_800_000_000;

  constructor(depositorFunds: bigint) {
    this.balances.set(keys.depositor.publicKey(), depositorFunds);
  }

  async ledgerTimeSecs() {
    return this.clock;
  }
  async latestLedger() {
    return 5000;
  }
  async accountExists(a: string) {
    return a !== this.missingAccount;
  }
  private bal(a: string) {
    return this.balances.get(a) ?? 0n;
  }

  async read(contractId: string, fn: string, args: xdr.ScVal[] = []) {
    const a = args.map(native);
    if (contractId === token && fn === 'balance')
      return nativeToScVal(this.bal(a[0] as string), { type: 'i128' });
    switch (fn) {
      case 'is_token_allowed':
        return xdr.ScVal.scvBool(true);
      case 'get_token_config':
        return encodeValue('TokenConfig', {
          fee_percentage_6: 1_000_000,
          max_fee_6: 0n,
          min_fee_6: 0n,
          token_decimals: 7,
        });
      case 'determine_fee': {
        const cfg = a[1] as { fee_percentage_6: number };
        const amount = a[0] as bigint;
        return nativeToScVal((amount * BigInt(cfg.fee_percentage_6) + 99_999_999n) / 100_000_000n, {
          type: 'i128',
        });
      }
      case 'get_delegate':
        return this.delegate === undefined
          ? xdr.ScVal.scvVoid()
          : nativeToScVal(
              {
                epoch: this.delegate.epoch ?? this.lastEpoch,
                delegate_signer: Buffer.from(this.delegate.signer),
                remaining_capacity: this.delegate.remaining,
                max_transfer_size: this.delegate.max,
                expiration: this.delegate.expiration,
              },
              {
                type: {
                  epoch: ['symbol', 'u64'],
                  delegate_signer: ['symbol', null],
                  remaining_capacity: ['symbol', 'i128'],
                  max_transfer_size: ['symbol', 'i128'],
                  expiration: ['symbol', 'u64'],
                },
              },
            );
      case 'get_fee_revenue':
        return nativeToScVal(this.feeRevenue, { type: 'i128' });
      case 'get_deposit_hash': {
        const h = this.deposits.get(Buffer.from(a[0] as Uint8Array).toString('hex'));
        return h === undefined ? xdr.ScVal.scvVoid() : xdr.ScVal.scvBytes(Buffer.from(h));
      }
      default:
        throw new Error(`model: unsupported read ${fn}`);
    }
  }

  async invoke(source: Keypair, label: string, contractId: string, fn: string, args: xdr.ScVal[]) {
    const a = args.map(native);
    this.calls.push({
      who: source.publicKey(),
      fn: `${contractId === token ? 'token.' : ''}${fn}`,
    });
    if (contractId === token && fn === 'approve') {
      expect(a[0]).toBe(keys.depositor.publicKey());
      expect(source.publicKey()).toBe(keys.depositor.publicKey());
      this.allowance = a[2] as bigint;
      return undefined;
    }
    switch (fn) {
      case 'create_delegate': {
        expect(source.publicKey()).toBe(a[0]); // depositor.require_auth
        if (this.delegate !== undefined) throw new Error('DelegateAlreadyExists');
        this.lastEpoch += 1n;
        this.delegate = {
          epoch: this.lastEpoch,
          signer: toBytes(a[2]),
          remaining: a[3] as bigint,
          max: a[4] as bigint,
          expiration: a[5] as bigint,
        };
        return undefined;
      }
      case 'revoke_delegate':
        expect(source.publicKey()).toBe(a[0]);
        if (this.delegate === undefined) throw new Error('DelegateNotFound');
        this.delegate = undefined;
        return undefined;
      case 'deposit':
        return this.deposit(a[0] as Record<string, unknown>);
      case 'release':
      case 'refund':
        return this.settle(fn, a[0] as Record<string, unknown>, toBytes(a[1]));
      default:
        throw new Error(`model: unsupported invoke ${fn}`);
    }
  }

  private deposit(input: Record<string, unknown>) {
    const w = input.deposit_witness as Record<string, unknown>;
    const r = input.reserve_witness as Record<string, unknown>;
    const d = this.delegate;
    if (d === undefined) throw new Error('DelegateNotFound');
    const depositId = computeDepositHash(
      {
        depositRequestHash: toBytes(w.deposit_request_hash),
        destination: w.destination as string,
        depositor: Address.fromStrkey(input.depositor as string),
        token: Address.fromStrkey(input.token as string),
        epoch: BigInt(d.epoch ?? this.lastEpoch),
        amount: input.amount as bigint,
        reserver: Pubkey.fromBytes(toBytes(w.reserver)),
        releaser: Pubkey.fromBytes(toBytes(w.releaser)),
        nonce: input.nonce as bigint,
        issuedAt: input.issued_at as bigint,
        deadline: input.deadline as bigint,
      },
      domain,
    );
    expect(Buffer.from(toBytes(r.deposit_id))).toEqual(Buffer.from(depositId)); // DepositIdMismatch
    // delegate signs the deposit digest, reserver signs the reserve digest
    expect(
      Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).verify(
        Buffer.from(depositId),
        Buffer.from(toBytes(input.delegate_signature)),
      ),
    ).toBe(true);
    const reserveDigest = computeReserveHash(
      {
        depositId,
        quoteHash: toBytes(r.quote_hash),
        settler: Address.fromStrkey(r.settler as string),
        sourceAmount: r.source_amount as bigint,
      },
      domain,
    );
    expect(
      Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).verify(
        Buffer.from(reserveDigest),
        Buffer.from(toBytes(input.reserve_signature)),
      ),
    ).toBe(true);
    // delegate record + allowance + nonce
    const nonceKey = String(input.nonce);
    if (this.usedNonces.has(nonceKey)) throw new Error('NonceAlreadyUsed');
    this.usedNonces.add(nonceKey);
    const charge = r.source_amount as bigint;
    if (charge > d.max || charge > d.remaining || charge > this.allowance)
      throw new Error('over limits');
    if ((input.deadline as bigint) - (input.issued_at as bigint) > 86_400n)
      throw new Error('DeadlineTooFarInFuture');
    if ((input.issued_at as bigint) > BigInt(this.clock)) throw new Error('FutureDeposit');
    d.remaining -= charge;
    this.allowance -= charge;
    const depositor = input.depositor as string;
    this.balances.set(depositor, this.bal(depositor) - charge);
    const fee = (charge * 1_000_000n + 99_999_999n) / 100_000_000n;
    const active = computeActiveDepositHash({
      depositor: Address.fromStrkey(depositor),
      quoteHash: toBytes(r.quote_hash),
      depositRequestHash: toBytes(w.deposit_request_hash),
      destinationHash: computeDestinationHash(w.destination as string),
      token: Address.fromStrkey(input.token as string),
      amount: charge,
      feeAmount: fee,
      reserver: Pubkey.fromBytes(toBytes(w.reserver)),
      releaser: Pubkey.fromBytes(toBytes(w.releaser)),
      settler: Address.fromStrkey(r.settler as string),
    });
    this.deposits.set(Buffer.from(depositId).toString('hex'), active);
    return undefined;
  }

  private settle(kind: 'release' | 'refund', w: Record<string, unknown>, sig: Uint8Array) {
    const id = Buffer.from(toBytes(w.deposit_id)).toString('hex');
    const stored = this.deposits.get(id);
    if (stored === undefined) throw new Error('DepositNotFound');
    const active = {
      depositor: Address.fromStrkey(w.depositor as string),
      quoteHash: toBytes(w.quote_hash),
      depositRequestHash: toBytes(w.deposit_request_hash),
      destinationHash: toBytes(w.destination_hash),
      token: Address.fromStrkey(w.token as string),
      amount: w.amount as bigint,
      feeAmount: w.fee_amount as bigint,
      reserver: Pubkey.fromBytes(toBytes(w.reserver)),
      releaser: Pubkey.fromBytes(toBytes(w.releaser)),
      settler: Address.fromStrkey(w.settler as string),
    };
    expect(Buffer.from(computeActiveDepositHash(active))).toEqual(Buffer.from(stored)); // InvalidWitnessValues
    const params = { depositId: toBytes(w.deposit_id), ...active };
    const digest =
      kind === 'release' ? computeReleaseHash(params, domain) : computeRefundHash(params, domain);
    expect(
      Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).verify(Buffer.from(digest), Buffer.from(sig)),
    ).toBe(true);
    this.deposits.delete(id);
    const amount = w.amount as bigint;
    const fee = w.fee_amount as bigint;
    if (kind === 'release') {
      this.feeRevenue += fee;
      this.balances.set(w.settler as string, this.bal(w.settler as string) + amount - fee);
    } else {
      this.balances.set(w.depositor as string, this.bal(w.depositor as string) + amount);
    }
    return undefined;
  }
}

const counter = () => {
  let n = 0;
  return (len: number) => Uint8Array.from({ length: len }, (_x, i) => (++n + i) & 0xff || 1);
};

const inputs = (over: Partial<Parameters<typeof runSmoke>[0]> = {}) => ({
  networkPassphrase: PASSPHRASE_TESTNET,
  escrow,
  token,
  settler,
  keys,
  amount: 10_000_000n,
  log: () => undefined,
  random: counter(),
  ...over,
});

describe('smoke flow against the model chain', () => {
  it('runs delegate+approve, deposit, release, then deposit, refund, in that order', async () => {
    const chain = new ModelChain(100_000_000n);
    const logs: string[] = [];
    const report = await runSmoke(inputs({ log: (l) => logs.push(l) }), chain);

    expect(chain.calls.map((c) => c.fn)).toEqual([
      'create_delegate',
      'token.approve',
      'deposit',
      'release',
      'deposit',
      'refund',
    ]);
    // who signs the transaction for each call
    const who = Object.fromEntries(chain.calls.map((c) => [c.fn, c.who]));
    expect(who.create_delegate).toBe(keys.depositor.publicKey());
    expect(who['token.approve']).toBe(keys.depositor.publicKey());
    expect(who.deposit).toBe(keys.submitter.publicKey());
    expect(report.flows.map((f) => f.name)).toEqual(['release', 'refund']);
    expect(logs[0]).toBe(SMOKE_BANNER);
  });

  it('settles the money: release pays amount - fee and books the fee; refund restores the depositor', async () => {
    const chain = new ModelChain(100_000_000n);
    await runSmoke(inputs(), chain);
    const fee = 100_000n; // 1% of 10_000_000
    expect(chain.feeRevenue).toBe(fee);
    expect(chain.balances.get(settler)).toBe(10_000_000n - fee);
    expect(chain.balances.get(keys.depositor.publicKey())).toBe(100_000_000n - 10_000_000n); // one release paid out, one refunded
    expect(chain.deposits.size).toBe(0);
  });

  it('uses a fresh nonce, deposit id and destination for each flow', async () => {
    const chain = new ModelChain(100_000_000n);
    const report = await runSmoke(inputs(), chain);
    expect(report.flows[0]?.depositId).not.toBe(report.flows[1]?.depositId);
  });

  it('fails with a funding hint when an account does not exist', async () => {
    const chain = new ModelChain(100_000_000n);
    chain.missingAccount = keys.depositor.publicKey();
    await expect(runSmoke(inputs(), chain)).rejects.toThrow(
      /does not exist.*Friendbot is testnet-only/,
    );
    expect(chain.calls).toHaveLength(0);
  });

  it('fails before spending when the depositor cannot cover both flows', async () => {
    const chain = new ModelChain(15_000_000n);
    await expect(runSmoke(inputs(), chain)).rejects.toThrow(/needs 20000000/);
    expect(chain.calls).toHaveLength(0);
  });

  it('revokes and re-creates a delegate with a different signer instead of refusing', async () => {
    const chain = new ModelChain(100_000_000n);
    chain.delegate = { signer: new Uint8Array(32).fill(7), remaining: 1n, max: 1n, expiration: 1n };
    await runSmoke(inputs(), chain);
    expect(chain.calls.map((c) => c.fn).slice(0, 3)).toEqual([
      'revoke_delegate',
      'create_delegate',
      'token.approve',
    ]);
    expect(Buffer.from(chain.delegate?.signer ?? [])).toEqual(
      Buffer.from(keys.delegate.rawPublicKey()),
    );
  });

  it('can run twice against the same escrow: the second run resets the spent delegate and reads its epoch', async () => {
    const chain = new ModelChain(100_000_000n);
    const random = counter(); // one stream across both runs, so nonces stay unique like real ones
    await runSmoke(inputs({ random }), chain);
    expect(chain.delegate?.remaining).toBe(0n); // refund does not restore capacity
    chain.calls.length = 0;
    const logs: string[] = [];
    const report = await runSmoke(inputs({ random, log: (l) => logs.push(l) }), chain);
    expect(report.flows.map((f) => f.name)).toEqual(['release', 'refund']);
    expect(chain.calls.map((c) => c.fn).slice(0, 3)).toEqual([
      'revoke_delegate',
      'create_delegate',
      'token.approve',
    ]);
    expect(logs).toContain('delegate epoch 2'); // read back from get_delegate, not assumed
  });

  it('reuses a delegate that still fits both flows and only re-approves', async () => {
    const chain = new ModelChain(100_000_000n);
    chain.delegate = {
      signer: keys.delegate.rawPublicKey(),
      remaining: 40_000_000n,
      max: 10_000_000n,
      expiration: BigInt(chain.clock) + 86_400n,
    };
    chain.lastEpoch = 4n;
    const logs: string[] = [];
    await runSmoke(inputs({ log: (l) => logs.push(l) }), chain);
    expect(chain.calls.map((c) => c.fn).slice(0, 2)).toEqual(['token.approve', 'deposit']);
    expect(logs).toContain('delegate epoch 4');
  });
  it('detects encoder/contract drift in the stored hash', async () => {
    const chain = new ModelChain(100_000_000n);
    const real = chain.read.bind(chain);
    chain.read = async (c, fn, args) =>
      fn === 'get_deposit_hash' ? xdr.ScVal.scvBytes(Buffer.alloc(32, 9)) : real(c, fn, args);
    await expect(runSmoke(inputs(), chain)).rejects.toThrow(/encoder\/contract drift/);
  });
});

describe('decideDelegate', () => {
  const pub = keys.delegate.rawPublicKey();
  const need = { amount: 10n, now: 1_000n };
  const fits = {
    delegate_signer: pub,
    remaining_capacity: 20n,
    max_transfer_size: 10n,
    expiration: 1_000n + 7_201n,
  };
  it('creates when there is no record', () => {
    expect(decideDelegate(null, pub, need)).toBe('create');
  });
  it('reuses a record with the same signer, capacity for both flows, enough cap and life', () => {
    expect(decideDelegate(fits, pub, need)).toBe('reuse');
  });
  it.each([
    ['another signer', { delegate_signer: new Uint8Array(32).fill(7) }],
    ['capacity below two deposits', { remaining_capacity: 19n }],
    ['a per-transfer cap below one deposit', { max_transfer_size: 9n }],
    ['two hours or less to live', { expiration: 1_000n + 7_200n }],
  ])('resets on %s', (_name, over) => {
    expect(decideDelegate({ ...fits, ...over }, pub, need)).toBe('reset');
  });
});

describe('buildDeposit', () => {
  const p = {
    domain,
    depositor: keys.depositor.publicKey(),
    token,
    settler,
    delegateEpoch: 1n,
    amount: 10_000_000n,
    feeAmount: 100_000n,
    nonce: 42n,
    issuedAt: 1_000n,
    deadline: 2_000n,
    depositRequestHash: new Uint8Array(32).fill(1),
    quoteHash: new Uint8Array(32).fill(2),
    destination: 'dest',
    keys,
  };

  it('signs the deposit id with the delegate key and the reserve digest with the reserver key', () => {
    const plan = buildDeposit(p);
    const input = plan.input as { delegate_signature: Uint8Array; reserve_signature: Uint8Array };
    expect(
      keys.delegate.verify(Buffer.from(plan.depositId), Buffer.from(input.delegate_signature)),
    ).toBe(true);
    const reserve = computeReserveHash(
      {
        depositId: plan.depositId,
        quoteHash: p.quoteHash,
        settler: Address.fromStrkey(settler),
        sourceAmount: p.amount,
      },
      domain,
    );
    expect(keys.reserver.verify(Buffer.from(reserve), Buffer.from(input.reserve_signature))).toBe(
      true,
    );
    // not the other way round
    expect(
      keys.reserver.verify(Buffer.from(plan.depositId), Buffer.from(input.delegate_signature)),
    ).toBe(false);
  });

  it('binds the delegate record epoch, so a re-enrolled signer gets a different id', () => {
    const e1 = buildDeposit(p);
    const e2 = buildDeposit({ ...p, delegateEpoch: 2n });
    expect(Buffer.from(e1.depositId)).not.toEqual(Buffer.from(e2.depositId));
  });

  it('commits to reserver and releaser as raw ed25519 keys', () => {
    const plan = buildDeposit(p);
    const w = (plan.input as { deposit_witness: { reserver: Uint8Array; releaser: Uint8Array } })
      .deposit_witness;
    expect(Buffer.from(w.reserver)).toEqual(Buffer.from(keys.reserver.rawPublicKey()));
    expect(Buffer.from(w.releaser)).toEqual(Buffer.from(keys.releaser.rawPublicKey()));
  });

  it('release and refund witnesses carry the same eleven members', () => {
    const w = settlementWitness(buildDeposit(p));
    expect(Object.keys(w).sort()).toEqual([
      'amount',
      'deposit_id',
      'deposit_request_hash',
      'depositor',
      'destination_hash',
      'fee_amount',
      'quote_hash',
      'releaser',
      'reserver',
      'settler',
      'token',
    ]);
  });

  it('encodes the DepositInput struct against the contract field list', () => {
    expect(() => encodeValue('DepositInput', buildDeposit(p).input as never)).not.toThrow();
  });
});

describe('ledger time', () => {
  it('uses the ledger close time, not the wall clock, for issued_at and the deadline window', async () => {
    const chain = new ModelChain(100_000_000n);
    chain.clock = 1_000_000_000; // years before Date.now(): a wall-clock issued_at would be FutureDeposit
    const seen: { issued: bigint; deadline: bigint }[] = [];
    const real = chain.invoke.bind(chain);
    chain.invoke = async (src, label, c, fn, args) => {
      if (fn === 'deposit') {
        const n = scValToNative(args[0] as xdr.ScVal) as { issued_at: bigint; deadline: bigint };
        seen.push({ issued: n.issued_at, deadline: n.deadline });
      }
      return real(src, label, c, fn, args);
    };
    await runSmoke(inputs(), chain);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.issued).toBe(1_000_000_000n);
      expect(s.deadline).toBe(1_000_000_000n + 3600n);
    }
  });

  it('reads the close time from getLatestLedger and rejects a missing one', async () => {
    expect(
      await ledgerCloseTime({ getLatestLedger: async () => ({ closeTime: '1792761631' }) }),
    ).toBe(1792761631);
    await expect(
      ledgerCloseTime({ getLatestLedger: async () => ({ closeTime: '' }) }),
    ).rejects.toThrow(/close time/);
  });
});

describe('smoke CLI', () => {
  const base = ['--network', 'testnet', '--escrow', escrow, '--token', token];

  it('refuses mainnet outright', () => {
    expect(() =>
      parseSmokeArgs([
        '--network',
        'mainnet',
        '--rpc-url',
        'https://x',
        '--escrow',
        escrow,
        '--token',
        token,
      ]),
    ).toThrow(NetworkGuardError);
  });

  it('parses a testnet invocation with the default amount', () => {
    expect(parseSmokeArgs(base)).toMatchObject({
      amount: 10_000_000n,
      rpcUrl: 'https://soroban-testnet.stellar.org',
    });
  });

  it('rejects bad ids and amounts and secrets on argv', () => {
    expect(() =>
      parseSmokeArgs(['--network', 'testnet', '--escrow', settler, '--token', token]),
    ).toThrow(/C\.\.\./);
    expect(() => parseSmokeArgs([...base, '--amount', '0'])).toThrow(/positive/);
    expect(() => parseSmokeArgs([...base, '--depositor-secret', 'S...'])).toThrow();
  });

  it('rejects zero, negative and non-numeric amounts as usage errors, not raw BigInt errors', () => {
    // `--amount=-5` is the form that reaches our check; `--amount -5` is already refused by parseArgs
    for (const bad of ['0', '-5', 'abc', '1.5', '']) {
      expect(() => parseSmokeArgs([...base, `--amount=${bad}`])).toThrow(UsageError);
      expect(() =>
        parseSmokeArgs([...base, '--proxy', escrow, '--settler', settler, `--amount=${bad}`], {
          proxy: true,
          settlerRequired: true,
        }),
      ).toThrow(/positive integer/);
    }
  });

  it('smoke-scenarios options: --proxy and --settler are required and validated', () => {
    const opts = { proxy: true, settlerRequired: true, script: 'smoke-scenarios' };
    const ok = [...base, '--proxy', escrow, '--settler', settler];
    expect(parseSmokeArgs(ok, opts)).toMatchObject({ proxy: escrow, settler });
    expect(() => parseSmokeArgs(base, opts)).toThrow(/--proxy/);
    expect(() => parseSmokeArgs([...base, '--proxy', escrow], opts)).toThrow(/--settler/);
    expect(() => parseSmokeArgs([...base, '--proxy', settler, '--settler', settler], opts)).toThrow(
      /--proxy/,
    );
    expect(() => parseSmokeArgs(ok)).toThrow(/proxy/); // not a flag of the plain smoke script
    expect(() =>
      parseSmokeArgs(['--network', 'mainnet', '--rpc-url', 'https://x', ...ok.slice(4)], opts),
    ).toThrow(/smoke-scenarios refuses mainnet/);
  });

  it('loads one key per role from env, or from Keychain items under a prefix', () => {
    const env: Record<string, string> = {};
    for (const r of ['DEPOSITOR', 'DELEGATE', 'RESERVER', 'RELEASER', 'SUBMITTER'])
      env[`STELLAR_SMOKE_${r}_SECRET`] = Keypair.random().secret();
    expect(loadSmokeKeys(undefined, env).depositor.secret()).toBe(
      env.STELLAR_SMOKE_DEPOSITOR_SECRET,
    );

    const items: string[] = [];
    loadSmokeKeys('atum-stellar-smoke-', {}, (args) => {
      items.push(args[2] as string);
      return `${Keypair.random().secret()}\n`;
    });
    expect(items).toEqual([
      'atum-stellar-smoke-depositor',
      'atum-stellar-smoke-delegate',
      'atum-stellar-smoke-reserver',
      'atum-stellar-smoke-releaser',
      'atum-stellar-smoke-submitter',
    ]);
  });
});
