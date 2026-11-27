import {
  Keypair,
  StrKey,
  nativeToScVal,
  scValToNative,
  xdr,
  type xdr as X,
} from '@stellar/stellar-sdk';
import { PASSPHRASE_TESTNET } from '@atum-labs/stellar-escrow-encoding';
import { describe, expect, it } from 'vitest';
import { contractErrorCode, runScenarios } from './scenarios-lib.js';
import type { SmokeChain, SmokeKeys } from './smoke-lib.js';

const kp = (n: number) => Keypair.fromRawEd25519Seed(Buffer.alloc(32, n));
const keys: SmokeKeys = {
  depositor: kp(1),
  delegate: kp(2),
  reserver: kp(3),
  releaser: kp(4),
  submitter: kp(5),
};
const C = (n: number) => StrKey.encodeContract(Buffer.alloc(32, n));
const err = (n: number) => new Error(`simulation failed: HostError: Error(Contract, #${n})`);

/** Scripted chain: deposits fail with the given codes in order, then succeed; strict_fulfill replays fail #4 then #3 */
function chain(depositCodes: (number | undefined)[], strictCodes: (number | undefined)[]) {
  const calls: string[] = [];
  const d = [...depositCodes];
  const st = [...strictCodes];
  let epoch = 0n; // the contract bumps it per created record; 0 means no record
  let live = false;
  const c: SmokeChain = {
    async invoke(_s, _l, _c, fn) {
      calls.push(fn);
      if (fn === 'create_delegate') {
        epoch += 1n;
        live = true;
      }
      if (fn === 'revoke_delegate') live = false;
      if (fn === 'deposit') {
        const code = d.shift();
        if (code !== undefined) throw err(code);
      }
      if (fn === 'strict_fulfill') {
        const code = st.shift();
        if (code !== undefined) throw err(code);
      }
      return undefined;
    },
    async read(_c, fn): Promise<X.ScVal> {
      if (fn === 'is_strictly_fulfilled') return xdr.ScVal.scvBool(true);
      if (fn === 'get_delegate' && live) {
        return nativeToScVal({ epoch }, { type: { epoch: ['symbol', 'u64'] } });
      }
      return xdr.ScVal.scvVoid();
    },
    ledgerTimeSecs: async () => 1_800_000_000,
    latestLedger: async () => 100,
    accountExists: async () => true,
  };
  return { c, calls };
}

const inputs = (over = {}) => ({
  networkPassphrase: PASSPHRASE_TESTNET,
  escrow: C(1),
  proxy: C(2),
  token: C(3),
  settler: kp(9).publicKey(),
  keys,
  admin: kp(6),
  amount: 10n,
  log: () => undefined,
  sleep: async () => undefined,
  ...over,
});

describe('scenarios', () => {
  it('parses contract error codes', () => {
    expect(contractErrorCode('HostError: Error(Contract, #75)')).toBe(75);
    expect(contractErrorCode('HostError: Error(Storage, MissingValue)')).toBeUndefined();
  });

  it('passes when every call fails with the expected code and always unpauses', async () => {
    // deposits: over-cap #75, expired #73, paused #10, then the post-unpause deposit succeeds
    // strict_fulfill: first ok, replay #4, past deadline #3
    const { c, calls } = chain([75, 73, 10, undefined], [undefined, 4, 3]);
    const r = await runScenarios(inputs(), c);
    expect(r.map((x) => x.passed)).toEqual([true, true, true, true]);
    expect(calls.indexOf('pause')).toBeLessThan(calls.indexOf('unpause'));
    expect(scValToNative(xdr.ScVal.scvBool(true))).toBe(true);
  });

  it('fails a scenario that should have been rejected but succeeded', async () => {
    const { c } = chain([undefined, 73, 10, undefined], [undefined, 4, 3]);
    const r = await runScenarios(inputs(), c);
    expect(r[0]?.passed).toBe(false);
    expect(r[0]?.detail).toMatch(/succeeded but must fail with #75/);
  });

  it('fails a scenario rejected with the wrong code, and still unpauses', async () => {
    const { c, calls } = chain([75, 73, 99, undefined], [undefined, 4, 3]);
    const r = await runScenarios(inputs(), c);
    expect(r[2]?.passed).toBe(false);
    expect(r[2]?.detail).toMatch(/expected contract error #10/);
    expect(calls).toContain('unpause');
  });
});
