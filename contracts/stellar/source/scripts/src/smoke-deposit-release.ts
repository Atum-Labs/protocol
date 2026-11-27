#!/usr/bin/env tsx
/**
 * Smoke test for a deployed Stellar escrow: create_delegate + SEP-41 approve, delegate-signed
 * deposit with reserver-signed reserve, release by the releaser witness, then a second deposit that
 * ends in refund.
 *
 * Executed against a local Protocol 30 network (README, "Local run") and on Stellar testnet (2026-11-10). Testnet and local only:
 * mainnet is refused outright, since this moves tokens.
 *
 * Keys: one S... secret per role, from env STELLAR_SMOKE_<ROLE>_SECRET or, with --keychain-prefix P,
 * from Keychain item "<P><role>" (roles: depositor, delegate, reserver, releaser, submitter).
 * Never on argv, never from a file in the repo.
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Keypair } from '@stellar/stellar-sdk';
import { StrKey, rpc } from '@stellar/stellar-sdk';
import { UsageError } from './args.js';
import { loadKeypair } from './keys.js';
import { NetworkGuardError, assertRpcMatchesNetwork, resolveNetwork } from './networks.js';
import { TxRunner, type SorobanRpc } from './runner.js';
import { runSmoke, type SmokeChain, type SmokeKeys } from './smoke-lib.js';

type SmokeRole = 'depositor' | 'delegate' | 'reserver' | 'releaser' | 'submitter';

export interface SmokeArgs {
  readonly network: ReturnType<typeof resolveNetwork>;
  readonly rpcUrl: string;
  readonly escrow: string;
  /** Present only when parsed with `proxy: true` */
  readonly proxy?: string;
  readonly token: string;
  readonly settler?: string;
  readonly amount: bigint;
  readonly keychainPrefix?: string;
}

export interface SmokeArgsOptions {
  /** Also accept and require `--proxy <C...>` (smoke-scenarios) */
  readonly proxy?: boolean;
  /** Require `--settler <G...>` instead of defaulting to the submitter */
  readonly settlerRequired?: boolean;
  /** Name used in the mainnet refusal */
  readonly script?: string;
}

export function parseSmokeArgs(argv: readonly string[], opts: SmokeArgsOptions = {}): SmokeArgs {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        network: { type: 'string' },
        'rpc-url': { type: 'string' },
        escrow: { type: 'string' },
        ...(opts.proxy === true ? { proxy: { type: 'string' as const } } : {}),
        token: { type: 'string' },
        settler: { type: 'string' },
        amount: { type: 'string' },
        'keychain-prefix': { type: 'string' },
      },
    }));
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const network = resolveNetwork(values.network);
  if (network.mainnet)
    throw new NetworkGuardError(
      `${opts.script ?? 'smoke-deposit-release'} refuses mainnet (it moves tokens)`,
    );
  const rpcUrl = values['rpc-url'] ?? network.defaultRpcUrl;
  if (rpcUrl === undefined)
    throw new UsageError(`--rpc-url is required for --network ${network.name}`);
  const escrow = values.escrow ?? '';
  const token = values.token ?? '';
  if (!StrKey.isValidContract(escrow)) throw new UsageError('--escrow must be a C... contract id');
  if (!StrKey.isValidContract(token)) throw new UsageError('--token must be a C... contract id');
  let proxy: string | undefined;
  if (opts.proxy === true) {
    proxy = (values as { proxy?: string }).proxy ?? '';
    if (!StrKey.isValidContract(proxy)) throw new UsageError('--proxy must be a C... contract id');
  }
  const settler = values.settler;
  if (opts.settlerRequired === true && settler === undefined) {
    throw new UsageError('--settler must be a G... account address');
  }
  if (settler !== undefined && !StrKey.isValidEd25519PublicKey(settler)) {
    throw new UsageError('--settler must be a G... account address');
  }
  const rawAmount = values.amount ?? '10000000';
  if (!/^[1-9]\d*$/.test(rawAmount))
    throw new UsageError('--amount must be a positive integer of atoms');
  return {
    network,
    rpcUrl,
    escrow,
    proxy,
    token,
    settler,
    amount: BigInt(rawAmount),
    keychainPrefix: values['keychain-prefix'],
  };
}

export function loadSmokeKeys(
  keychainPrefix: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  security?: Parameters<typeof loadKeypair>[2],
): SmokeKeys {
  const get = (role: SmokeRole): Keypair =>
    loadKeypair(
      keychainPrefix === undefined
        ? { secretEnv: `STELLAR_SMOKE_${role.toUpperCase()}_SECRET` }
        : { keychainItem: `${keychainPrefix}${role}` },
      env,
      security,
    );
  return {
    depositor: get('depositor'),
    delegate: get('delegate'),
    reserver: get('reserver'),
    releaser: get('releaser'),
    submitter: get('submitter'),
  };
}

/** Close time (unix seconds) of the latest ledger from the RPC; the contract's `now` is ledger time. */
export async function ledgerCloseTime(server: {
  getLatestLedger(): Promise<{ closeTime: string | number }>;
}): Promise<number> {
  const t = Number((await server.getLatestLedger()).closeTime);
  if (!Number.isSafeInteger(t) || t <= 0) throw new Error('RPC returned no ledger close time');
  return t;
}

export function makeRpcChain(
  server: SorobanRpc,
  passphrase: string,
  keys: SmokeKeys,
  log: (l: string) => void,
): SmokeChain {
  const runners = new Map<string, TxRunner>();
  const runnerFor = (kp: Keypair) => {
    let r = runners.get(kp.publicKey());
    if (r === undefined) {
      r = new TxRunner({
        rpc: server,
        networkPassphrase: passphrase,
        signer: { publicKey: kp.publicKey(), keypair: kp },
        dryRun: false,
        log,
      });
      runners.set(kp.publicKey(), r);
    }
    return r;
  };
  const reader = runnerFor(keys.submitter);
  return {
    async invoke(source, label, contractId, fn, args) {
      return (await runnerFor(source).invoke(label, contractId, fn, args)).returnValue;
    },
    read: (contractId, fn, args = []) => reader.read(contractId, fn, args),
    ledgerTimeSecs: () => ledgerCloseTime(server),
    async latestLedger() {
      return (await server.getLatestLedger()).sequence;
    },
    async accountExists(address) {
      try {
        await server.getAccount(address);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (l: string) => void,
): Promise<void> {
  const args = parseSmokeArgs(argv);
  const keys = loadSmokeKeys(args.keychainPrefix, env);
  const server = new rpc.Server(args.rpcUrl, { allowHttp: args.network.name === 'local' });
  assertRpcMatchesNetwork(args.network, (await server.getNetwork()).passphrase);
  const chain = makeRpcChain(server as unknown as SorobanRpc, args.network.passphrase, keys, log);
  await runSmoke(
    {
      networkPassphrase: args.network.passphrase,
      escrow: args.escrow,
      token: args.token,
      settler: args.settler ?? keys.submitter.publicKey(),
      keys,
      amount: args.amount,
      log,
    },
    chain,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env, (l) => console.log(l)).catch((e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = e instanceof UsageError || e instanceof NetworkGuardError ? 2 : 1;
  });
}
