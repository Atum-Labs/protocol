/**
 * Deployer key loading. A secret is never accepted on argv (visible in `ps`) and never read from a
 * file in the repo or a .env. It comes from an environment variable the operator exports for the
 * session, or from a macOS Keychain generic-password item read at run time.
 *
 * Nothing here logs or returns a secret except to the caller that asked for the Keypair.
 */
import { execFileSync } from 'node:child_process';
import { Keypair } from '@stellar/stellar-sdk';

export type SecurityRunner = (args: readonly string[]) => string;

const defaultSecurity: SecurityRunner = (args) =>
  execFileSync('/usr/bin/security', [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export interface KeySource {
  /** Name of an environment variable holding an S... secret */
  readonly secretEnv?: string;
  /** Keychain service name of a generic-password item holding an S... secret */
  readonly keychainItem?: string;
}

export const DEFAULT_SECRET_ENV = 'STELLAR_DEPLOYER_SECRET';

export class KeyLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyLoadError';
  }
}

function parseSecret(raw: string, origin: string): Keypair {
  const secret = raw.trim();
  try {
    return Keypair.fromSecret(secret);
  } catch {
    // Deliberately no echo of the value or the library message (which may quote it)
    throw new KeyLoadError(`${origin} does not hold a valid Stellar secret (S...)`);
  }
}

export function loadKeypair(
  source: KeySource,
  env: Readonly<Record<string, string | undefined>>,
  security: SecurityRunner = defaultSecurity,
): Keypair {
  if (source.keychainItem !== undefined && source.secretEnv !== undefined) {
    throw new KeyLoadError('pass only one of --secret-env and --keychain-item');
  }
  if (source.keychainItem !== undefined) {
    let out: string;
    try {
      out = security(['find-generic-password', '-s', source.keychainItem, '-w']);
    } catch {
      throw new KeyLoadError(`Keychain item "${source.keychainItem}" could not be read`);
    }
    return parseSecret(out, `Keychain item "${source.keychainItem}"`);
  }
  const name = source.secretEnv ?? DEFAULT_SECRET_ENV;
  const value = env[name];
  if (value === undefined || value === '') {
    throw new KeyLoadError(
      `environment variable ${name} is not set (and no --keychain-item given)`,
    );
  }
  return parseSecret(value, `environment variable ${name}`);
}
