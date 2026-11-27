/**
 * TTL keeping for contract code and instances.
 *
 * The instance bump inside the contracts also extends the code, but only when a call crosses its
 * threshold (storage.rs, TTL POLICY), so operations must keep both alive. The escrow's balance entry
 * inside each allowlisted token is kept alive here too: the token extends it only when the escrow's own
 * balance is read or written, and the escrow's keep-alive (`extend_deposit_ttl`) does not touch it. The
 * caller passes the tokens read from the escrow at run time (`runExtendTtl`), not a recorded list.
 * ExtendFootprintTtl takes the entries as a read-only footprint and a single `extendTo`, and skips
 * entries that already live longer, so repeating it is harmless.
 */
import { Operation, SorobanDataBuilder, type xdr } from '@stellar/stellar-sdk';
import {
  contractCodeKey,
  contractInstanceKey,
  stateArchivalConfigKey,
  tokenBalanceKey,
} from './ids.js';
import type { SorobanRpc, TxRunner } from './runner.js';

export interface TtlTarget {
  readonly wasmHash: Uint8Array;
  readonly contractId: string;
}

/** A holder's balance entry in a Stellar Asset Contract: here the escrow's, one per allowlisted token. */
export interface BalanceTarget {
  readonly token: string;
  readonly holder: string;
}

export interface TtlResult {
  readonly extendTo: number;
  /** Lowest liveUntilLedgerSeq across the extended entries; undefined in dry-run */
  readonly liveUntilLedgerSeq?: number;
  readonly observedAtLedger: number;
}

/** The network's maximum entry TTL, read from the ledger's state-archival setting (never hard-coded). */
export async function readMaxEntryTtl(rpc: SorobanRpc): Promise<number> {
  const res = await rpc.getLedgerEntries(stateArchivalConfigKey());
  const entry = res.entries[0];
  if (entry === undefined) throw new Error('state-archival config setting not returned by the RPC');
  const data = entry.val;
  if (data.type !== 'configSetting' || data.configSetting.type !== 'configSettingStateArchival') {
    throw new Error('unexpected ledger entry type for the state-archival config setting');
  }
  return data.configSetting.stateArchivalSettings.maxEntryTtl;
}

export function footprintKeys(targets: readonly TtlTarget[]): xdr.LedgerKey[] {
  return targets.flatMap((t) => [contractCodeKey(t.wasmHash), contractInstanceKey(t.contractId)]);
}

/**
 * The balance entries the RPC can return. A holder with no entry in a token (nothing deposited yet, or
 * not a Stellar Asset Contract layout) is left out, because an extension cannot name an entry that is
 * not there, and reported through `log`.
 */
export async function liveBalanceKeys(
  rpc: SorobanRpc,
  balances: readonly BalanceTarget[],
  log: (line: string) => void,
): Promise<xdr.LedgerKey[]> {
  if (balances.length === 0) return [];
  const keys = balances.map((b) => tokenBalanceKey(b.token, b.holder));
  const found = new Set(
    (await rpc.getLedgerEntries(...keys)).entries.map((e) => e.key.toXDR('base64')),
  );
  const live: xdr.LedgerKey[] = [];
  const extended: string[] = [];
  keys.forEach((k, i) => {
    if (found.has(k.toXDR('base64'))) {
      live.push(k);
      extended.push(`${balances[i]?.token}`);
    } else
      log(
        `no balance entry of ${balances[i]?.holder} in token ${balances[i]?.token}: not extended`,
      );
  });
  log(
    `extending ${live.length} of ${balances.length} token balance entr${balances.length === 1 ? 'y' : 'ies'}` +
      (live.length > 0 ? `: balance of ${balances[0]?.holder} in ${extended.join(', ')}` : ''),
  );
  return live;
}

export async function extendCodeAndInstances(
  runner: TxRunner,
  rpc: SorobanRpc,
  targets: readonly TtlTarget[],
  requestedExtendTo: number | undefined,
  balances: readonly BalanceTarget[] = [],
): Promise<TtlResult> {
  const max = await readMaxEntryTtl(rpc);
  // The operation must stay strictly below the network maximum; confirm the exact bound on testnet
  const extendTo = requestedExtendTo ?? max - 1;
  if (extendTo >= max) {
    throw new Error(`--extend-to ${extendTo} must be below the network max entry TTL (${max})`);
  }
  const keys = [...footprintKeys(targets), ...(await liveBalanceKeys(rpc, balances, runner.log))];
  const data = new SorobanDataBuilder().setReadOnly(keys).build();
  await runner.execute(
    'extend TTL of code and instances',
    Operation.extendFootprintTtl({ extendTo }),
    data,
  );
  const after = await rpc.getLedgerEntries(...keys);
  if (runner.dryRun) return { extendTo, observedAtLedger: after.latestLedger };

  const lives = after.entries.map((e) => e.liveUntilLedgerSeq ?? 0);
  if (lives.length !== keys.length) throw new Error('RPC did not return every extended entry');
  const liveUntil = Math.min(...lives);
  // Slack for ledgers closed between submission and this read
  if (liveUntil < after.latestLedger + extendTo - 50) {
    throw new Error(
      `TTL extension not observed: lowest liveUntilLedgerSeq ${liveUntil}, wanted about ${after.latestLedger + extendTo}`,
    );
  }
  return { extendTo, liveUntilLedgerSeq: liveUntil, observedAtLedger: after.latestLedger };
}
