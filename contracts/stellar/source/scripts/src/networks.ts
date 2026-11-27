/**
 * Network selection and the mainnet guard.
 *
 * Nothing here talks to the network. The guard is a pure function of its inputs so it can be tested
 * without a key, an RPC, or a clock.
 */

import { PASSPHRASE_PUBLIC, PASSPHRASE_TESTNET } from '@atum-labs/stellar-escrow-encoding';

export type NetworkName = 'testnet' | 'mainnet' | 'local';

export interface NetworkConfig {
  readonly name: NetworkName;
  /** CAIP-2 style reference, used as the key in deployments-<network>.json */
  readonly caip2: string;
  readonly displayName: string;
  readonly passphrase: string;
  readonly mainnet: boolean;
  /** Absent when no public endpoint is endorsed: the operator must pass --rpc-url */
  readonly defaultRpcUrl?: string;
  /** Informational: the scripts never call Friendbot; operators fund accounts themselves */
  readonly friendbotUrl?: string;
}

/** TESTNET and PUBLIC come from the encoding package; the standalone passphrase is local-only. */
export const PASSPHRASE_STANDALONE = 'Standalone Network ; February 2017';

export const NETWORKS: Readonly<Record<NetworkName, NetworkConfig>> = {
  testnet: {
    name: 'testnet',
    caip2: 'stellar:testnet',
    displayName: 'Stellar Testnet',
    passphrase: PASSPHRASE_TESTNET,
    mainnet: false,
    defaultRpcUrl: 'https://soroban-testnet.stellar.org',
  },
  mainnet: {
    name: 'mainnet',
    caip2: 'stellar:pubnet',
    displayName: 'Stellar Mainnet',
    passphrase: PASSPHRASE_PUBLIC,
    mainnet: true,
    // No default: SDF does not run a public mainnet RPC, so the operator names one explicitly.
  },
  local: {
    name: 'local',
    caip2: 'stellar:standalone',
    displayName: 'Stellar standalone (local quickstart)',
    passphrase: PASSPHRASE_STANDALONE,
    mainnet: false,
    defaultRpcUrl: 'http://localhost:8000/rpc',
    friendbotUrl: 'http://localhost:8000/friendbot',
  },
};

/** Environments a mainnet run may name. Anything else is refused even with every flag set. */
export const MAINNET_ENVIRONMENTS: readonly string[] = ['staging-mainnet', 'production-mainnet'];

/** Env var holding the comma-separated allowlist of mainnet environments this shell may touch. */
export const MAINNET_ALLOWLIST_ENV = 'ATUM_STELLAR_MAINNET_ALLOWLIST';

export class NetworkGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkGuardError';
  }
}

export function resolveNetwork(name: string | undefined): NetworkConfig {
  if (name === undefined || name === '') {
    throw new NetworkGuardError('--network is required (testnet | mainnet | local)');
  }
  if (name === 'testnet' || name === 'mainnet' || name === 'local') return NETWORKS[name];
  throw new NetworkGuardError(`unknown network "${name}" (expected testnet | mainnet | local)`);
}

export interface GuardInput {
  readonly network: NetworkConfig;
  readonly iKnowThisIsMainnet: boolean;
  readonly environment?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Refuse mainnet unless BOTH the explicit flag and the environment allowlist pass. The flag alone is
 * a typo away from a mistake; the allowlist lives in the operator's shell, so a copied command line
 * cannot satisfy it on another machine.
 */
export function assertNetworkAllowed(input: GuardInput): void {
  const { network, iKnowThisIsMainnet, environment, env } = input;
  if (!network.mainnet) {
    if (iKnowThisIsMainnet) {
      throw new NetworkGuardError(
        `--i-know-this-is-mainnet was passed with --network ${network.name}; refusing the contradiction`,
      );
    }
    return;
  }
  if (!iKnowThisIsMainnet) {
    throw new NetworkGuardError(
      'refusing mainnet: pass --i-know-this-is-mainnet AND an allowlisted --environment ' +
        `(${MAINNET_ENVIRONMENTS.join(' | ')}) listed in ${MAINNET_ALLOWLIST_ENV}`,
    );
  }
  if (environment === undefined || !MAINNET_ENVIRONMENTS.includes(environment)) {
    throw new NetworkGuardError(
      `refusing mainnet: --environment must be one of ${MAINNET_ENVIRONMENTS.join(', ')}`,
    );
  }
  const allowed = (env[MAINNET_ALLOWLIST_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (!allowed.includes(environment)) {
    throw new NetworkGuardError(
      `refusing mainnet: ${MAINNET_ALLOWLIST_ENV} does not list "${environment}"`,
    );
  }
}

/** The RPC's own passphrase must match the chosen network, or a mislabelled endpoint signs for the wrong chain. */
export function assertRpcMatchesNetwork(network: NetworkConfig, rpcPassphrase: string): void {
  if (rpcPassphrase !== network.passphrase) {
    throw new NetworkGuardError(
      `RPC reports passphrase "${rpcPassphrase}" but --network ${network.name} expects "${network.passphrase}"`,
    );
  }
}

/** The admin-transfer delay `deploy.ts` uses when no flag is given. */
export const DEFAULT_ADMIN_DELAY_SECS = 1;

/**
 * The shortest admin-transfer delay a mainnet deploy may set, one day. The EVM contracts are deployed with
 * one second so the deployer can hand over at once and raise the delay afterwards, so their value is no floor
 * for a live admin; one day is the shortest delay that leaves a monitor and a multisig time to see a
 * pending transfer. A value of 2 passed the earlier check against the default and is not a guard.
 */
export const MIN_MAINNET_ADMIN_DELAY_SECS = 24 * 60 * 60;

/**
 * Mainnet must not sign with an environment-held secret. An explicit `--secret-env` and the default
 * variable are both refused; a Keychain item, or a public key in a dry run, passes. Runs before any
 * key is read.
 */
export function assertMainnetKeySource(
  network: NetworkConfig,
  source: {
    readonly keychainItem?: string | undefined;
    readonly deployerAddress?: string | undefined;
  },
): void {
  if (!network.mainnet) return;
  if (source.keychainItem === undefined && source.deployerAddress === undefined) {
    throw new NetworkGuardError(
      'refusing mainnet: the signing secret may not come from an environment variable; ' +
        'pass --keychain-item (or --deployer-address with --dry-run)',
    );
  }
}

export interface MainnetCustodyInput {
  readonly network: NetworkConfig;
  readonly deployer: string;
  /** Resolved holders, after flags and any earlier run's record */
  readonly roles: Readonly<Record<string, string>>;
  readonly adminDelaySecs: number;
  readonly proxyDelaySecs: number;
}

/**
 * Refuse a mainnet deploy that leaves any role on the deployer, or sets an admin delay below
 * `MIN_MAINNET_ADMIN_DELAY_SECS`, on either contract.
 * The deployer key signs the run; it must not also be the authority over the live contracts.
 */
export function assertMainnetCustody(input: MainnetCustodyInput): void {
  if (!input.network.mainnet) return;
  const onDeployer = Object.entries(input.roles)
    .filter(([, holder]) => holder === input.deployer)
    .map(([role]) => role);
  if (onDeployer.length > 0) {
    throw new NetworkGuardError(
      `refusing mainnet: ${onDeployer.join(', ')} would be held by the deployer; ` +
        'pass --admin, --pauser, --treasurer, --token-config, --proxy-admin and --proxy-pauser as other addresses',
    );
  }
  for (const [flag, secs] of [
    ['--admin-delay-secs', input.adminDelaySecs],
    ['--proxy-delay-secs', input.proxyDelaySecs],
  ] as const) {
    if (secs < MIN_MAINNET_ADMIN_DELAY_SECS) {
      throw new NetworkGuardError(
        `refusing mainnet: ${flag} is ${secs}, below the mainnet minimum of ` +
          `${MIN_MAINNET_ADMIN_DELAY_SECS} seconds (one day); pass ${MIN_MAINNET_ADMIN_DELAY_SECS} or more`,
      );
    }
  }
}
