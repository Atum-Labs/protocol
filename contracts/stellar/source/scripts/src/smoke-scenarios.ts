#!/usr/bin/env tsx
/**
 * Extra on-chain scenarios (over-cap deposit, expired delegate, pause, proxy fulfil calls).
 * Local/testnet only (run on testnet on 2026-11-11, see deploy/README.md, Status). Keys as in
 * smoke-deposit-release.ts, plus the deployer (escrow Pauser):
 * env STELLAR_SMOKE_ADMIN_SECRET or Keychain item "<prefix>admin".
 */
import { pathToFileURL } from 'node:url';
import { rpc } from '@stellar/stellar-sdk';
import { UsageError } from './args.js';
import { loadKeypair } from './keys.js';
import { NetworkGuardError, assertRpcMatchesNetwork } from './networks.js';
import { runScenarios } from './scenarios-lib.js';
import type { SorobanRpc } from './runner.js';
import { loadSmokeKeys, makeRpcChain, parseSmokeArgs } from './smoke-deposit-release.js';

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (l: string) => void,
): Promise<boolean> {
  const args = parseSmokeArgs(argv, {
    proxy: true,
    settlerRequired: true,
    script: 'smoke-scenarios',
  });
  const { network, rpcUrl } = args;
  const prefix = args.keychainPrefix;
  const keys = loadSmokeKeys(prefix, env);
  const admin = loadKeypair(
    prefix === undefined
      ? { secretEnv: 'STELLAR_SMOKE_ADMIN_SECRET' }
      : { keychainItem: `${prefix}admin` },
    env,
  );
  const server = new rpc.Server(rpcUrl, { allowHttp: network.name === 'local' });
  assertRpcMatchesNetwork(network, (await server.getNetwork()).passphrase);
  const chain = makeRpcChain(server as unknown as SorobanRpc, network.passphrase, keys, log);
  const results = await runScenarios(
    {
      networkPassphrase: network.passphrase,
      escrow: args.escrow,
      proxy: args.proxy as string,
      token: args.token,
      settler: args.settler as string,
      keys,
      admin,
      amount: args.amount,
      log,
    },
    chain,
  );
  return results.every((r) => r.passed);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env, (l) => console.log(l))
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((e: unknown) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = e instanceof UsageError || e instanceof NetworkGuardError ? 2 : 1;
    });
}
