/**
 * Smoke flow for a deployed escrow: delegate + allowance, delegate-signed deposit with a
 * reserver-signed reserve, release by the releaser witness; then a second deposit that ends in refund.
 *
 * Executed on a local Protocol 30 network and on Stellar testnet (2026-11-10, see deploy/README.md). The
 * unit tests drive it against an in-memory fake chain; the encoders it uses are the ones pinned by
 * contracts/stellar/conformance.
 */
import { randomBytes } from 'node:crypto';
import { scValToNative, type Keypair, type xdr } from '@stellar/stellar-sdk';
import {
  Address,
  Pubkey,
  computeActiveDepositHash,
  computeDepositHash,
  computeDestinationHash,
  computeRefundHash,
  computeReleaseHash,
  computeReserveHash,
  newEscrowDomain,
  type EscrowActiveDeposit,
  type EscrowDomain,
} from '@atum-labs/stellar-escrow-encoding';
import { encodeValue, escrowArgs, tokenArgs, type ArgValue } from './abi.js';

export const SMOKE_BANNER =
  'smoke-deposit-release: moves tokens. Testnet/local only; executed on a local Protocol 30 network and on testnet.';

/** What the smoke script needs from the chain. The real one wraps TxRunner; tests use a fake. */
export interface SmokeChain {
  invoke(
    source: Keypair,
    label: string,
    contractId: string,
    fn: string,
    args: xdr.ScVal[],
  ): Promise<xdr.ScVal | undefined>;
  read(contractId: string, fn: string, args?: xdr.ScVal[]): Promise<xdr.ScVal | undefined>;
  /** Close time of the latest ledger, in unix seconds. The contract compares against ledger time, never the wall clock (witness-layouts.md). */
  ledgerTimeSecs(): Promise<number>;
  latestLedger(): Promise<number>;
  accountExists(address: string): Promise<boolean>;
}

export interface SmokeKeys {
  /** Owns the funds; signs create_delegate and token.approve as a transaction */
  readonly depositor: Keypair;
  /** Raw ed25519 key whose signature over the deposit digest authorises deposits */
  readonly delegate: Keypair;
  /** Raw ed25519 key that signs the reserve digest */
  readonly reserver: Keypair;
  /** Raw ed25519 key that signs release and refund digests */
  readonly releaser: Keypair;
  /** Source account for the permissionless deposit / release / refund transactions */
  readonly submitter: Keypair;
}

export interface SmokeInputs {
  readonly networkPassphrase: string;
  readonly escrow: string;
  readonly token: string;
  /** Receives the release payout; defaults to the submitter's address */
  readonly settler: string;
  readonly keys: SmokeKeys;
  /** Atoms charged per deposit (the reserve's source_amount); the signed ceiling is the same */
  readonly amount: bigint;
  readonly log: (line: string) => void;
  /** Injectable for tests */
  readonly random?: (n: number) => Uint8Array;
}

export interface DepositPlan {
  readonly depositId: Uint8Array;
  readonly input: Record<string, ArgValue>;
  readonly active: EscrowActiveDeposit;
  readonly activeHash: Uint8Array;
}

export interface BuildDepositParams {
  readonly domain: EscrowDomain;
  readonly depositor: string;
  readonly token: string;
  readonly settler: string;
  /** Epoch of the delegate record the deposit is signed under (`get_delegate`), bound into the id */
  readonly delegateEpoch: bigint;
  readonly amount: bigint;
  readonly feeAmount: bigint;
  readonly nonce: bigint;
  readonly issuedAt: bigint;
  readonly deadline: bigint;
  readonly depositRequestHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly destination: string;
  readonly keys: SmokeKeys;
}

/** Pure: derive the deposit id, sign it and the reserve, and lay out the DepositInput struct. */
export function buildDeposit(p: BuildDepositParams): DepositPlan {
  const depositor = Address.fromStrkey(p.depositor);
  const token = Address.fromStrkey(p.token);
  const settler = Address.fromStrkey(p.settler);
  const reserver = Pubkey.fromBytes(p.keys.reserver.rawPublicKey());
  const releaser = Pubkey.fromBytes(p.keys.releaser.rawPublicKey());

  const depositId = computeDepositHash(
    {
      depositRequestHash: p.depositRequestHash,
      destination: p.destination,
      depositor,
      token,
      epoch: p.delegateEpoch,
      amount: p.amount,
      reserver,
      releaser,
      nonce: p.nonce,
      issuedAt: p.issuedAt,
      deadline: p.deadline,
    },
    p.domain,
  );
  const reserveDigest = computeReserveHash(
    { depositId, quoteHash: p.quoteHash, settler, sourceAmount: p.amount },
    p.domain,
  );
  const delegateSignature = p.keys.delegate.sign(Buffer.from(depositId));
  const reserveSignature = p.keys.reserver.sign(Buffer.from(reserveDigest));

  const active: EscrowActiveDeposit = {
    depositor,
    quoteHash: p.quoteHash,
    depositRequestHash: p.depositRequestHash,
    destinationHash: computeDestinationHash(p.destination),
    token,
    amount: p.amount,
    feeAmount: p.feeAmount,
    reserver,
    releaser,
    settler,
  };

  const input = {
    depositor: p.depositor,
    token: p.token,
    amount: p.amount,
    deposit_witness: {
      deposit_request_hash: p.depositRequestHash,
      destination: p.destination,
      reserver: reserver.toBytes(),
      releaser: releaser.toBytes(),
    },
    nonce: p.nonce,
    issued_at: p.issuedAt,
    deadline: p.deadline,
    delegate_signature: new Uint8Array(delegateSignature),
    reserve_witness: {
      deposit_id: depositId,
      quote_hash: p.quoteHash,
      settler: p.settler,
      source_amount: p.amount,
    },
    reserve_signature: new Uint8Array(reserveSignature),
  };
  return {
    depositId,
    input,
    active,
    activeHash: computeActiveDepositHash(active),
  };
}

/** Release / refund witness (the same eleven members) from a stored active deposit. */
export function settlementWitness(plan: DepositPlan): Record<string, ArgValue> {
  const a = plan.active;
  return {
    deposit_id: plan.depositId,
    quote_hash: a.quoteHash,
    deposit_request_hash: a.depositRequestHash,
    destination_hash: a.destinationHash,
    depositor: a.depositor.toString(),
    token: a.token.toString(),
    amount: a.amount,
    fee_amount: a.feeAmount,
    reserver: a.reserver.toBytes(),
    releaser: a.releaser.toBytes(),
    settler: a.settler.toString(),
  };
}

function toBigInt(v: xdr.ScVal | undefined, what: string): bigint {
  if (v === undefined) throw new Error(`${what}: no value`);
  const n = scValToNative(v) as unknown;
  if (typeof n === 'bigint') return n;
  if (typeof n === 'number') return BigInt(n);
  throw new Error(`${what}: not an integer`);
}

function toBytes(v: xdr.ScVal | undefined): Uint8Array | undefined {
  if (v === undefined) return undefined;
  const n = scValToNative(v) as unknown;
  if (n === null || n === undefined) return undefined;
  if (n instanceof Uint8Array) return n;
  throw new Error('expected bytes or void');
}

const eq = (a: Uint8Array | undefined, b: Uint8Array) =>
  a !== undefined && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** The `get_delegate` record as decoded by scValToNative, or null when there is none. */
export type DelegateRecord = Record<string, unknown>;

export interface DelegateCtx {
  readonly chain: SmokeChain;
  readonly escrow: string;
  readonly token: string;
  readonly keys: SmokeKeys;
}

export async function readDelegate(c: DelegateCtx): Promise<DelegateRecord | null> {
  const v = await c.chain.read(
    c.escrow,
    'get_delegate',
    escrowArgs('get_delegate', c.keys.depositor.publicKey(), c.token),
  );
  return v === undefined ? null : (scValToNative(v) as DelegateRecord | null);
}

export type DelegateDecision = 'create' | 'reuse' | 'reset';

/**
 * Whether the smoke can use the delegate that is already on chain. Reuse needs the same signer,
 * capacity for both flows, a per-transfer cap that admits one deposit, and more than two hours of
 * life; anything else is reset, because only the depositor can revoke and nothing else would.
 */
export function decideDelegate(
  existing: DelegateRecord | null,
  delegatePub: Uint8Array,
  need: { amount: bigint; now: bigint },
): DelegateDecision {
  if (existing == null) return 'create';
  const sameSigner = eq(existing.delegate_signer as Uint8Array, delegatePub);
  const fits =
    BigInt(existing.remaining_capacity as bigint) >= 2n * need.amount &&
    BigInt(existing.max_transfer_size as bigint) >= need.amount &&
    BigInt(existing.expiration as bigint) > need.now + 7200n;
  return sameSigner && fits ? 'reuse' : 'reset';
}

/**
 * Revoke the depositor's delegate for this token if one exists, create a fresh one and approve the
 * escrow for `capacity`. Returns the new record's epoch, read back from the contract rather than
 * assumed, because the deposit digest binds to it.
 */
export async function resetDelegate(
  c: DelegateCtx,
  capacity: bigint,
  max: bigint,
  ttlSecs: bigint,
): Promise<{ epoch: bigint }> {
  const depositor = c.keys.depositor.publicKey();
  if ((await readDelegate(c)) != null) {
    await c.chain.invoke(
      c.keys.depositor,
      'revoke_delegate',
      c.escrow,
      'revoke_delegate',
      escrowArgs('revoke_delegate', depositor, c.token),
    );
  }
  await c.chain.invoke(
    c.keys.depositor,
    'create_delegate',
    c.escrow,
    'create_delegate',
    escrowArgs(
      'create_delegate',
      depositor,
      c.token,
      c.keys.delegate.rawPublicKey(),
      capacity,
      max,
      BigInt(await c.chain.ledgerTimeSecs()) + ttlSecs,
    ),
  );
  await c.chain.invoke(
    c.keys.depositor,
    'token.approve',
    c.token,
    'approve',
    tokenArgs('approve', depositor, c.escrow, capacity, (await c.chain.latestLedger()) + 100_000),
  );
  const created = await readDelegate(c);
  if (created == null) throw new Error('create_delegate succeeded but get_delegate returned none');
  return { epoch: BigInt(created.epoch as bigint) };
}

export interface SmokeReport {
  readonly flows: readonly { name: 'release' | 'refund'; depositId: string; feeAmount: bigint }[];
}

export async function runSmoke(i: SmokeInputs, chain: SmokeChain): Promise<SmokeReport> {
  const { log, keys } = i;
  const rnd = i.random ?? ((n: number) => randomBytes(n));
  const depositor = keys.depositor.publicKey();
  const domain = newEscrowDomain(i.networkPassphrase, Address.fromStrkey(i.escrow));
  log(SMOKE_BANNER);

  // Preflight: fail with a funding hint before spending anything
  for (const [who, addr] of [
    ['depositor', depositor],
    ['submitter', keys.submitter.publicKey()],
    ['settler', i.settler],
  ] as const) {
    if (!(await chain.accountExists(addr))) {
      throw new Error(
        `${who} account ${addr} does not exist on this network; fund it first (Friendbot is testnet-only)`,
      );
    }
  }
  const allowed = await chain.read(
    i.escrow,
    'is_token_allowed',
    escrowArgs('is_token_allowed', i.token),
  );
  if (allowed === undefined || scValToNative(allowed) !== true) {
    throw new Error(
      `token ${i.token} is not allowed on the escrow; run deploy.ts with --token first`,
    );
  }
  const tokenConfig = await chain.read(
    i.escrow,
    'get_token_config',
    escrowArgs('get_token_config', i.token),
  );
  if (tokenConfig === undefined) throw new Error('get_token_config returned nothing');
  const balanceOf = async (who: string) =>
    toBigInt(await chain.read(i.token, 'balance', tokenArgs('balance', who)), `balance(${who})`);
  const startBalance = await balanceOf(depositor);
  if (startBalance < 2n * i.amount) {
    throw new Error(`depositor holds ${startBalance} atoms, needs ${2n * i.amount} for both flows`);
  }

  // 1. delegate record + SEP-41 allowance, both signed by the depositor. A delegate left by an
  // earlier run is reused only while it still fits both flows; otherwise it is revoked and
  // re-created (a refund does not restore capacity, so a second run finds it spent).
  const delegateCtx: DelegateCtx = {
    chain,
    escrow: i.escrow,
    token: i.token,
    keys,
  };
  const existingDelegate = await readDelegate(delegateCtx);
  const decision = decideDelegate(existingDelegate, keys.delegate.rawPublicKey(), {
    amount: i.amount,
    now: BigInt(await chain.ledgerTimeSecs()),
  });
  let delegateEpoch: bigint;
  if (decision === 'reuse') {
    log('delegate record exists and fits: reusing it');
    delegateEpoch = BigInt(existingDelegate?.epoch as bigint);
    const ledger = await chain.latestLedger();
    await chain.invoke(
      keys.depositor,
      'token.approve(escrow)',
      i.token,
      'approve',
      // ~5.8 days of ledgers at 5s; must stay under the network's max entry TTL
      tokenArgs('approve', depositor, i.escrow, 2n * i.amount, ledger + 100_000),
    );
  } else {
    if (decision === 'reset')
      log('delegate record exists but cannot be reused: revoking and re-creating it');
    ({ epoch: delegateEpoch } = await resetDelegate(delegateCtx, 2n * i.amount, i.amount, 86_400n));
  }
  log(`delegate epoch ${delegateEpoch}`);

  const flows: { name: 'release' | 'refund'; depositId: string; feeAmount: bigint }[] = [];
  for (const name of ['release', 'refund'] as const) {
    log(`--- flow: ${name}`);
    const before = await balanceOf(depositor);
    const settlerBefore = await balanceOf(i.settler);
    const revenueBefore = toBigInt(
      await chain.read(i.escrow, 'get_fee_revenue', escrowArgs('get_fee_revenue', i.token)),
      'fee revenue',
    );

    const fee = toBigInt(
      await chain.read(i.escrow, 'determine_fee', [encodeValue('i128', i.amount), tokenConfig]),
      'determine_fee',
    );
    const issuedAt = BigInt(await chain.ledgerTimeSecs());
    const plan = buildDeposit({
      domain,
      depositor,
      token: i.token,
      settler: i.settler,
      delegateEpoch,
      amount: i.amount,
      feeAmount: fee,
      nonce: BigInt(`0x${Buffer.from(rnd(8)).toString('hex')}`),
      issuedAt,
      deadline: issuedAt + 3600n,
      depositRequestHash: rnd(32),
      quoteHash: rnd(32),
      destination: `smoke-${name}-${Buffer.from(rnd(4)).toString('hex')}`,
      keys,
    });

    await chain.invoke(
      keys.submitter,
      `deposit (${name})`,
      i.escrow,
      'deposit',
      escrowArgs('deposit', plan.input),
    );
    const stored = toBytes(
      await chain.read(
        i.escrow,
        'get_deposit_hash',
        escrowArgs('get_deposit_hash', plan.depositId),
      ),
    );
    if (!eq(stored, plan.activeHash)) {
      throw new Error(
        'stored active-deposit hash differs from the TS encoder: encoder/contract drift',
      );
    }
    if ((await balanceOf(depositor)) !== before - i.amount)
      throw new Error('depositor balance did not drop by the amount');

    const witness = settlementWitness(plan);
    const params = { depositId: plan.depositId, ...plan.active };
    if (name === 'release') {
      const digest = computeReleaseHash(params, domain);
      const sig = new Uint8Array(keys.releaser.sign(Buffer.from(digest)));
      await chain.invoke(
        keys.submitter,
        'release',
        i.escrow,
        'release',
        escrowArgs('release', witness, sig),
      );
      if ((await balanceOf(i.settler)) - settlerBefore !== i.amount - fee)
        throw new Error('settler did not receive amount - fee');
      const revenue = toBigInt(
        await chain.read(i.escrow, 'get_fee_revenue', escrowArgs('get_fee_revenue', i.token)),
        'fee revenue',
      );
      if (revenue - revenueBefore !== fee) throw new Error('fee revenue did not grow by the fee');
    } else {
      const digest = computeRefundHash(params, domain);
      const sig = new Uint8Array(keys.releaser.sign(Buffer.from(digest)));
      await chain.invoke(
        keys.submitter,
        'refund',
        i.escrow,
        'refund',
        escrowArgs('refund', witness, sig),
      );
      if ((await balanceOf(depositor)) !== before)
        throw new Error('depositor was not made whole by the refund');
    }
    const gone = toBytes(
      await chain.read(
        i.escrow,
        'get_deposit_hash',
        escrowArgs('get_deposit_hash', plan.depositId),
      ),
    );
    if (gone !== undefined) throw new Error('deposit hash still stored after settlement');
    flows.push({ name, depositId: Buffer.from(plan.depositId).toString('hex'), feeAmount: fee });
    log(`flow ${name} ok (deposit ${Buffer.from(plan.depositId).toString('hex')})`);
  }
  return { flows };
}
