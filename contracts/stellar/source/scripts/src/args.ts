/** Command-line parsing for deploy.ts. Pure: takes argv, returns a validated structure. */
import { parseArgs } from 'node:util';
import { StrKey } from '@stellar/stellar-sdk';
import { resolveNetwork, type NetworkConfig } from './networks.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface TokenSpec {
  readonly contract: string;
  readonly decimals: number;
  /** 1_000_000 = 1%, max 100_000_000 */
  readonly feePercentage6: number;
  readonly minFee6: bigint;
  readonly maxFee6: bigint;
}

export type Command = 'deploy' | 'extend-ttl';

export interface DeployArgs {
  readonly command: Command;
  readonly network: NetworkConfig;
  readonly rpcUrl: string;
  readonly escrowWasm?: string;
  readonly proxyWasm?: string;
  readonly dryRun: boolean;
  readonly iKnowThisIsMainnet: boolean;
  readonly environment?: string;
  readonly secretEnv?: string;
  readonly keychainItem?: string;
  /** Public address to simulate as in --dry-run when no secret is available */
  readonly deployerAddress?: string;
  /** Role holders. Undefined means "the deployer", resolved once the key is known. */
  readonly admin?: string;
  readonly pauser?: string;
  readonly treasurer?: string;
  readonly tokenConfig?: string;
  readonly proxyAdmin?: string;
  readonly proxyPauser?: string;
  readonly adminDelaySecs: number;
  readonly proxyDelaySecs: number;
  readonly tokens: readonly TokenSpec[];
  readonly saltTag: string;
  /** Ledgers to extend code and instance TTL to; undefined = the network maximum */
  readonly extendTo?: number;
  readonly deploymentsFile?: string;
}

export const USAGE = `usage: deploy.ts <deploy|extend-ttl> --network <testnet|mainnet|local> [options]

  --escrow-wasm <path>        compiled escrow wasm (required to deploy; no build step is assumed)
  --proxy-wasm <path>         compiled fulfillment_proxy wasm
  --dry-run                   build + simulate + print every transaction; submit nothing
  --rpc-url <url>             Soroban RPC (testnet defaults to the SDF public endpoint; mainnet has no default)
  --secret-env <NAME>         env var holding the deployer S... secret (default STELLAR_DEPLOYER_SECRET; refused on mainnet)
  --keychain-item <service>   macOS Keychain generic-password item holding the deployer secret
  --deployer-address <G...>   dry-run only: simulate as this account without any secret
  --admin / --pauser / --treasurer / --token-config <G...>   escrow role holders (default: deployer; mainnet needs all six elsewhere)
  --proxy-admin / --proxy-pauser <G...>                      proxy role holders (default: deployer)
  --admin-delay-secs <n>      escrow default-admin transfer delay (default 1; mainnet needs at least 86400)
  --proxy-delay-secs <n>      proxy default-admin transfer delay (default 1; mainnet needs at least 86400)
  --token <C..>:<decimals>:<feePct6>[:<min6>[:<max6>]]   allow a token and set fees (repeatable)
  --salt-tag <tag>            deterministic-address tag (default v1; new tag = new addresses)
  --extend-to <ledgers>       TTL target for code and instances (default: network max entry TTL - 1)
  --deployments-file <path>   output file (default contracts/stellar/deploy/deployments-<network>.json)
  --environment <name>        mainnet only: staging-mainnet | production-mainnet
  --i-know-this-is-mainnet    mainnet only, together with ATUM_STELLAR_MAINNET_ALLOWLIST
`;

function intOption(raw: string | undefined, name: string, dflt: number, max: number): number {
  if (raw === undefined) return dflt;
  if (!/^\d+$/.test(raw)) throw new UsageError(`${name} must be a non-negative integer`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n > max) throw new UsageError(`${name} is out of range`);
  return n;
}

function accountOption(raw: string | undefined, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (!StrKey.isValidEd25519PublicKey(raw))
    throw new UsageError(`${name} must be a G... account address`);
  return raw;
}

const FEE_PERCENTAGE_SCALE = 100_000_000;
const MAX_TOKEN_DECIMALS = 18;
const U64_MAX = (1n << 64n) - 1n;

/** `C...:decimals:feePct6[:min6[:max6]]`, validated the way the contract's validate_fee_config does. */
export function parseTokenSpec(raw: string): TokenSpec {
  const parts = raw.split(':');
  if (parts.length < 3 || parts.length > 5) {
    throw new UsageError(`--token "${raw}": expected C...:decimals:feePct6[:min6[:max6]]`);
  }
  const [contract = '', dec = '', pct = '', min = '0', max = '0'] = parts;
  if (!StrKey.isValidContract(contract))
    throw new UsageError(`--token "${raw}": not a C... contract id`);
  if (![dec, pct, min, max].every((p) => /^\d+$/.test(p))) {
    throw new UsageError(`--token "${raw}": decimals and fees must be non-negative integers`);
  }
  const decimals = Number(dec);
  if (decimals === 0 || decimals > MAX_TOKEN_DECIMALS) {
    throw new UsageError(`--token "${raw}": decimals must be 1..${MAX_TOKEN_DECIMALS}`);
  }
  const feePercentage6 = Number(pct);
  if (feePercentage6 > FEE_PERCENTAGE_SCALE) {
    throw new UsageError(`--token "${raw}": feePct6 exceeds ${FEE_PERCENTAGE_SCALE} (100%)`);
  }
  const minFee6 = BigInt(min);
  const maxFee6 = BigInt(max);
  if (minFee6 > U64_MAX || maxFee6 > U64_MAX)
    throw new UsageError(`--token "${raw}": fee bound exceeds u64`);
  if (minFee6 > 0n && maxFee6 > 0n && minFee6 > maxFee6) {
    throw new UsageError(`--token "${raw}": min fee is above max fee`);
  }
  if (maxFee6 > 0n && feePercentage6 === 0) {
    throw new UsageError(`--token "${raw}": a max fee needs a non-zero percentage`);
  }
  return { contract, decimals, feePercentage6, minFee6, maxFee6 };
}

export function parseDeployArgs(argv: readonly string[]): DeployArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        network: { type: 'string' },
        'rpc-url': { type: 'string' },
        'escrow-wasm': { type: 'string' },
        'proxy-wasm': { type: 'string' },
        'dry-run': { type: 'boolean' },
        'i-know-this-is-mainnet': { type: 'boolean' },
        environment: { type: 'string' },
        'secret-env': { type: 'string' },
        'keychain-item': { type: 'string' },
        'deployer-address': { type: 'string' },
        admin: { type: 'string' },
        pauser: { type: 'string' },
        treasurer: { type: 'string' },
        'token-config': { type: 'string' },
        'proxy-admin': { type: 'string' },
        'proxy-pauser': { type: 'string' },
        'admin-delay-secs': { type: 'string' },
        'proxy-delay-secs': { type: 'string' },
        token: { type: 'string', multiple: true },
        'salt-tag': { type: 'string' },
        'extend-to': { type: 'string' },
        'deployments-file': { type: 'string' },
      },
    });
  } catch (e) {
    // parseArgs names the offending flag; secrets are never accepted as flags, so nothing sensitive is echoed
    throw new UsageError((e as Error).message);
  }
  const { values, positionals } = parsed;

  const command = positionals[0] ?? 'deploy';
  if (positionals.length > 1 || (command !== 'deploy' && command !== 'extend-ttl')) {
    throw new UsageError('expected one command: deploy | extend-ttl');
  }

  const network = resolveNetwork(values.network);
  const rpcUrl = values['rpc-url'] ?? network.defaultRpcUrl;
  if (rpcUrl === undefined)
    throw new UsageError(`--rpc-url is required for --network ${network.name}`);
  if (!/^https?:\/\//.test(rpcUrl)) throw new UsageError('--rpc-url must be an http(s) URL');

  const dryRun = values['dry-run'] ?? false;
  const deployerAddress = accountOption(values['deployer-address'], '--deployer-address');
  if (deployerAddress !== undefined && !dryRun) {
    throw new UsageError(
      '--deployer-address is only valid with --dry-run (a real run needs the secret)',
    );
  }
  if (values['secret-env'] !== undefined && values['keychain-item'] !== undefined) {
    throw new UsageError('pass only one of --secret-env and --keychain-item');
  }

  const escrowWasm = values['escrow-wasm'];
  const proxyWasm = values['proxy-wasm'];
  if (command === 'deploy' && (escrowWasm === undefined || proxyWasm === undefined)) {
    throw new UsageError('deploy needs --escrow-wasm and --proxy-wasm (there is no build step)');
  }

  const extendTo =
    values['extend-to'] === undefined
      ? undefined
      : intOption(values['extend-to'], '--extend-to', 0, 0xffffffff);
  if (extendTo === 0) throw new UsageError('--extend-to must be positive');

  return {
    command,
    network,
    rpcUrl,
    escrowWasm,
    proxyWasm,
    dryRun,
    iKnowThisIsMainnet: values['i-know-this-is-mainnet'] ?? false,
    environment: values.environment,
    secretEnv: values['secret-env'],
    keychainItem: values['keychain-item'],
    deployerAddress,
    admin: accountOption(values.admin, '--admin'),
    pauser: accountOption(values.pauser, '--pauser'),
    treasurer: accountOption(values.treasurer, '--treasurer'),
    tokenConfig: accountOption(values['token-config'], '--token-config'),
    proxyAdmin: accountOption(values['proxy-admin'], '--proxy-admin'),
    proxyPauser: accountOption(values['proxy-pauser'], '--proxy-pauser'),
    adminDelaySecs: intOption(values['admin-delay-secs'], '--admin-delay-secs', 1, 0xffffffff),
    proxyDelaySecs: intOption(values['proxy-delay-secs'], '--proxy-delay-secs', 1, 0xffffffff),
    tokens: (values.token ?? []).map(parseTokenSpec),
    saltTag: values['salt-tag'] ?? 'v1',
    extendTo,
    deploymentsFile: values['deployments-file'],
  };
}
