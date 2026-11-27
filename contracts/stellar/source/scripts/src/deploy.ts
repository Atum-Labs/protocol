#!/usr/bin/env tsx
/**
 * Deploy the Stellar escrow and fulfillment proxy.
 *
 * Executed against a local Protocol 30 network and on Stellar testnet (Protocol 30, 2026-11-10; record in
 * deploy/deployments-testnet.json). Not yet run on mainnet. The wasm is an input (--escrow-wasm /
 * --proxy-wasm); this script never builds. See contracts/stellar/deploy/README.md.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Keypair } from '@stellar/stellar-sdk';
import { rpc } from '@stellar/stellar-sdk';
import { UsageError, USAGE, parseDeployArgs, type DeployArgs } from './args.js';
import { runDeploy, runExtendTtl } from './deploy-lib.js';
import { readDeployments, upsertDeployment } from './deployments.js';
import { loadKeypair } from './keys.js';
import {
  NetworkGuardError,
  assertMainnetCustody,
  assertMainnetKeySource,
  assertNetworkAllowed,
  assertRpcMatchesNetwork,
} from './networks.js';
import { TxRunner, type Signer, type SorobanRpc } from './runner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DEPLOY_DIR = resolve(HERE, '../../../deploy');

export interface MainDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log: (line: string) => void;
  /** Builds the RPC client; replaced by a fake in tests */
  readonly makeRpc: (url: string, allowHttp: boolean) => SorobanRpc;
  readonly readFile: (path: string) => Uint8Array;
  readonly loadKey: (a: DeployArgs, env: Readonly<Record<string, string | undefined>>) => Keypair;
}

export const realDeps = (): MainDeps => ({
  env: process.env,
  log: (l) => console.log(l),
  makeRpc: (url, allowHttp) => new rpc.Server(url, { allowHttp }) as unknown as SorobanRpc,
  readFile: (p) => readFileSync(p),
  loadKey: (a, env) => loadKeypair({ secretEnv: a.secretEnv, keychainItem: a.keychainItem }, env),
});

export async function main(argv: readonly string[], deps: MainDeps): Promise<void> {
  const args = parseDeployArgs(argv);
  // Guard before any key is read or any socket is opened
  assertNetworkAllowed({
    network: args.network,
    iKnowThisIsMainnet: args.iKnowThisIsMainnet,
    environment: args.environment,
    env: deps.env,
  });

  assertMainnetKeySource(args.network, args);

  let signer: Signer;
  if (args.deployerAddress !== undefined) {
    signer = { publicKey: args.deployerAddress };
  } else {
    const keypair = deps.loadKey(args, deps.env);
    signer = { publicKey: keypair.publicKey(), keypair };
  }

  const server = deps.makeRpc(args.rpcUrl, args.network.name === 'local');
  const live = await server.getNetwork();
  assertRpcMatchesNetwork(args.network, live.passphrase);
  deps.log(
    `network ${args.network.name} (protocol ${live.protocolVersion ?? 'unknown'}), deployer ${signer.publicKey}${args.dryRun ? ', DRY RUN' : ''}`,
  );

  const runner = new TxRunner({
    rpc: server,
    networkPassphrase: args.network.passphrase,
    signer,
    dryRun: args.dryRun,
    log: deps.log,
  });
  const deploymentsFile =
    args.deploymentsFile ?? resolve(DEFAULT_DEPLOY_DIR, `deployments-${args.network.name}.json`);

  if (args.command === 'extend-ttl') {
    const entry = readDeployments(deploymentsFile)[args.network.caip2];
    if (entry === undefined)
      throw new UsageError(`${deploymentsFile} has no ${args.network.caip2} entry`);
    const next = await runExtendTtl(entry, runner, server, args.extendTo);
    if (!args.dryRun) upsertDeployment(deploymentsFile, args.network.caip2, next);
    return;
  }

  const deployer = signer.publicKey;
  // Omitted flags keep the holders recorded by an earlier run of the same deployment, so a re-run
  // after a handoff does not reset them to the deployer
  const earlier = readDeployments(deploymentsFile)[args.network.caip2];
  const prev =
    earlier !== undefined && earlier.deployer === deployer && earlier.saltTag === args.saltTag
      ? earlier.roles
      : undefined;
  const roles = {
    admin: args.admin ?? prev?.Escrow.defaultAdmin ?? deployer,
    pauser: args.pauser ?? prev?.Escrow.Pauser.holder ?? deployer,
    treasurer: args.treasurer ?? prev?.Escrow.Treasurer.holder ?? deployer,
    tokenConfig: args.tokenConfig ?? prev?.Escrow.TokenConfig.holder ?? deployer,
    proxyAdmin: args.proxyAdmin ?? prev?.FulfillmentProxy.defaultAdmin ?? deployer,
    proxyPauser: args.proxyPauser ?? prev?.FulfillmentProxy.pauser ?? deployer,
  };
  assertMainnetCustody({
    network: args.network,
    deployer,
    roles,
    adminDelaySecs: args.adminDelaySecs,
    proxyDelaySecs: args.proxyDelaySecs,
  });
  const outcome = await runDeploy(
    {
      network: args.network,
      deployer,
      escrowWasm: deps.readFile(args.escrowWasm as string),
      proxyWasm: deps.readFile(args.proxyWasm as string),
      ...roles,
      adminDelaySecs: args.adminDelaySecs,
      proxyDelaySecs: args.proxyDelaySecs,
      tokens: args.tokens,
      saltTag: args.saltTag,
      extendTo: args.extendTo,
      deploymentsFile,
    },
    runner,
    server,
    deps.log,
  );
  deps.log(
    `done: ${outcome.performed.length} step(s) ${args.dryRun ? 'planned' : 'performed'}, ${outcome.skipped.length} already done`,
  );
  if (outcome.entry.pendingAdminSteps.length > 0) {
    deps.log('NOT applied (needs the role holder to sign):');
    for (const s of outcome.entry.pendingAdminSteps) deps.log(`  - ${s}`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), realDeps()).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`error: ${msg}`);
    if (e instanceof UsageError) console.error(USAGE);
    process.exitCode = e instanceof UsageError || e instanceof NetworkGuardError ? 2 : 1;
  });
}
