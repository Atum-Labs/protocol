/**
 * Extra on-chain scenarios beyond the happy-path smoke: limits, expiry, pause, and the proxy.
 * Each scenario states the contract error it expects; a call that should fail but succeeds, or fails
 * with a different error, fails the scenario. Local/testnet only (run on testnet on 2026-11-11, see
 * deploy/README.md, Status), same key model as the smoke script.
 */
import { randomBytes } from 'node:crypto';
import { scValToNative, type Keypair } from '@stellar/stellar-sdk';
import { Address, newEscrowDomain } from '@atum-labs/stellar-escrow-encoding';
import { escrowArgs, proxyArgs } from './abi.js';
import {
  buildDeposit,
  resetDelegate as resetDelegateShared,
  type SmokeChain,
  type SmokeKeys,
} from './smoke-lib.js';

export interface ScenarioInputs {
  readonly networkPassphrase: string;
  readonly escrow: string;
  readonly proxy: string;
  readonly token: string;
  readonly settler: string;
  readonly keys: SmokeKeys;
  /** Holds the escrow Pauser role and is the proxy's pauser/admin (the deployer) */
  readonly admin: Keypair;
  readonly amount: bigint;
  readonly log: (line: string) => void;
  readonly random?: (n: number) => Uint8Array;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ScenarioResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** Soroban surfaces a contract error as `Error(Contract, #n)` in the failure text. */
export function contractErrorCode(message: string): number | undefined {
  const m = /Error\(Contract, #(\d+)\)/.exec(message);
  return m === null ? undefined : Number(m[1]);
}

async function expectContractError(
  what: string,
  code: number,
  run: () => Promise<unknown>,
): Promise<string> {
  try {
    await run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const got = contractErrorCode(msg);
    if (got !== code)
      throw new Error(`${what}: expected contract error #${code}, got: ${msg.slice(0, 300)}`, {
        cause: e,
      });
    return `failed as expected with #${code}`;
  }
  throw new Error(`${what}: succeeded but must fail with #${code}`);
}

export async function runScenarios(
  i: ScenarioInputs,
  chain: SmokeChain,
): Promise<ScenarioResult[]> {
  const rnd = i.random ?? ((n: number) => randomBytes(n));
  const sleep = i.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const depositor = i.keys.depositor.publicKey();
  const domain = newEscrowDomain(i.networkPassphrase, Address.fromStrkey(i.escrow));
  const results: ScenarioResult[] = [];

  const delegateCtx = { chain, escrow: i.escrow, token: i.token, keys: i.keys, log: i.log };
  // The deposit digest binds the delegate record's epoch, so remember the one the last reset created
  let delegateEpoch = 0n;
  const resetDelegate = async (capacity: bigint, max: bigint, ttlSecs: bigint) => {
    const r = await resetDelegateShared(delegateCtx, capacity, max, ttlSecs);
    delegateEpoch = r.epoch;
    return r;
  };

  const depositCall = async (amount: bigint) => {
    const issuedAt = BigInt(await chain.ledgerTimeSecs());
    const plan = buildDeposit({
      domain,
      depositor,
      token: i.token,
      settler: i.settler,
      delegateEpoch,
      amount,
      feeAmount: 0n,
      nonce: BigInt(`0x${Buffer.from(rnd(8)).toString('hex')}`),
      issuedAt,
      deadline: issuedAt + 3600n,
      depositRequestHash: rnd(32),
      quoteHash: rnd(32),
      destination: `scenario-${Buffer.from(rnd(4)).toString('hex')}`,
      keys: i.keys,
    });
    return chain.invoke(
      i.keys.submitter,
      'deposit',
      i.escrow,
      'deposit',
      escrowArgs('deposit', plan.input),
    );
  };

  const scenario = async (name: string, fn: () => Promise<string>) => {
    try {
      const detail = await fn();
      results.push({ name, passed: true, detail });
      i.log(`PASS ${name}: ${detail}`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      results.push({ name, passed: false, detail });
      i.log(`FAIL ${name}: ${detail}`);
    }
  };

  await scenario('over-cap deposit is rejected (DelegateOverTransferMax #75)', async () => {
    await resetDelegate(3n * i.amount, i.amount, 3600n);
    return expectContractError('deposit over max_transfer_size', 75, () =>
      depositCall(2n * i.amount),
    );
  });

  await scenario('expired delegate is rejected (DelegateExpired #73)', async () => {
    await resetDelegate(3n * i.amount, i.amount, 20n);
    i.log('waiting for the delegate to expire (ledger time)');
    await sleep(40_000);
    return expectContractError('deposit with expired delegate', 73, () => depositCall(i.amount));
  });

  await scenario('pause blocks deposit; unpause restores it (Paused #10)', async () => {
    await resetDelegate(3n * i.amount, i.amount, 3600n);
    await chain.invoke(
      i.admin,
      'pause',
      i.escrow,
      'pause',
      escrowArgs('pause', i.admin.publicKey()),
    );
    let detail: string;
    try {
      detail = await expectContractError('deposit while paused', 10, () => depositCall(i.amount));
    } finally {
      await chain.invoke(
        i.admin,
        'unpause',
        i.escrow,
        'unpause',
        escrowArgs('unpause', i.admin.publicKey()),
      );
    }
    await depositCall(i.amount);
    return `${detail}; deposit succeeds after unpause`;
  });

  await scenario('proxy fulfill, strict_fulfill, authorize_fulfillment', async () => {
    const s = depositor; // any funded holder can act as the paying "settler" on the proxy
    const quote = rnd(32);
    // Every fulfil call carries a single-use nonce of the paying settler (here, the depositor).
    const nonce = () => BigInt(`0x${Buffer.from(rnd(8)).toString('hex')}`);
    const deadline = BigInt(await chain.ledgerTimeSecs()) + 600n;
    await chain.invoke(
      i.keys.depositor,
      'fulfill',
      i.proxy,
      'fulfill',
      proxyArgs('fulfill', s, quote, i.settler, i.token, i.amount, deadline, nonce()),
    );
    const strictQuote = rnd(32);
    await chain.invoke(
      i.keys.depositor,
      'strict_fulfill',
      i.proxy,
      'strict_fulfill',
      proxyArgs('strict_fulfill', s, strictQuote, i.settler, i.token, i.amount, deadline, nonce()),
    );
    const done = await chain.read(
      i.proxy,
      'is_strictly_fulfilled',
      proxyArgs('is_strictly_fulfilled', strictQuote, i.settler, i.token, i.amount),
    );
    if (done === undefined || scValToNative(done) !== true)
      throw new Error('strict marker not set');
    const again = await expectContractError('second strict_fulfill of the same quote', 4, () =>
      chain.invoke(
        i.keys.depositor,
        'strict_fulfill',
        i.proxy,
        'strict_fulfill',
        proxyArgs(
          'strict_fulfill',
          s,
          strictQuote,
          i.settler,
          i.token,
          i.amount,
          deadline,
          nonce(),
        ),
      ),
    );
    const pastDeadline = BigInt(await chain.ledgerTimeSecs()) - 60n;
    const late = await expectContractError('strict_fulfill past its deadline', 3, () =>
      chain.invoke(
        i.keys.depositor,
        'strict_fulfill',
        i.proxy,
        'strict_fulfill',
        proxyArgs(
          'strict_fulfill',
          s,
          rnd(32),
          i.settler,
          i.token,
          i.amount,
          pastDeadline,
          nonce(),
        ),
      ),
    );
    await chain.invoke(
      i.keys.depositor,
      'authorize_fulfillment',
      i.proxy,
      'authorize_fulfillment',
      proxyArgs('authorize_fulfillment', s, rnd(32), rnd(32)),
    );
    return `fulfill ok; strict ok; replay ${again}; late ${late}; authorize ok`;
  });

  return results;
}
