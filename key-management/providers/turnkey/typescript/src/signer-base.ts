import { setTimeout as sleep } from 'node:timers/promises';

import {
  SignerErrorCode,
  signerRetryable,
  signerTerminal,
} from '@atum-labs/km-core';

import type { TurnkeyClient } from './client';
import { TURNKEY_RETRY_BACKOFF_MS } from './constants';
import type { Logger } from './logger';
import type { TurnkeyAccount } from './types';

/**
 * Shared behaviour for the three Turnkey chain signers — boot-time wallet discovery, address
 * extraction by Turnkey `addressFormat`, optional pinned-address verification, and the
 * retry-with-backoff envelope around discovery so a flaky Turnkey response at startup doesn't
 * fail the agent boot outright.
 *
 * Each chain shim subclasses (composition-style) this base and supplies the `addressFormat` it
 * expects.
 */

export interface TurnkeySignerCommonDeps {
  readonly client: TurnkeyClient;
  readonly walletId: string;
  readonly log: Logger;
  /** Wall-clock budget (ms) for boot-time discovery including all retries. */
  readonly discoveryTimeoutMs: number;
  /** Optional pinned chain-native address. When present, must match the address Turnkey returns. */
  readonly pinnedAddress?: string;
}

const DISCOVERY_BACKOFF_MS = TURNKEY_RETRY_BACKOFF_MS;

/**
 * Resolve the chain-native address for a given Turnkey wallet account format.
 *
 * Retry policy: up to 3 attempts (500ms / 2s / 8s) against the configured discovery budget.
 * If every retry fails, throws TURNKEY_NETWORK so the caller can decide whether to abort
 * the boot or apply a higher-level fallback.
 */
export async function resolveTurnkeyAccountAddress(
  deps: TurnkeySignerCommonDeps,
  addressFormat: string,
): Promise<string> {
  const deadline = Date.now() + deps.discoveryTimeoutMs;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= DISCOVERY_BACKOFF_MS.length; attempt++) {
    if (Date.now() > deadline) break;
    try {
      const accounts = await deps.client.listWalletAccounts(deps.walletId);
      const account = pickAccount(accounts, addressFormat);
      if (!account) {
        // Missing account is terminal — not a transient condition.
        throw signerTerminal(
          SignerErrorCode.SIGNER_NOT_INITIALIZED,
          `Turnkey wallet ${deps.walletId} has no account with format ${addressFormat}; provision it via admin tooling`,
        );
      }
      if (
        deps.pinnedAddress &&
        !addressesEqual(addressFormat, deps.pinnedAddress, account.address)
      ) {
        throw signerTerminal(
          SignerErrorCode.SIGNER_ADDRESS_DRIFT,
          `Pinned ${addressFormat} address ${deps.pinnedAddress} does not match Turnkey's ${account.address}`,
        );
      }
      return account.address;
    } catch (err) {
      lastErr = err;
      // Terminal errors do not get retried — surface immediately.
      if (isTerminalError(err)) throw err;
      if (attempt < DISCOVERY_BACKOFF_MS.length) {
        const delay = DISCOVERY_BACKOFF_MS[attempt] ?? 0;
        const budgetLeft = deadline - Date.now();
        if (budgetLeft <= 0) break;
        const sleepFor = Math.min(delay, budgetLeft);
        deps.log.warn(
          { attempt, sleepFor, err: err instanceof Error ? err.message : err },
          'Turnkey wallet discovery retry',
        );
        await sleep(sleepFor);
      }
    }
  }
  throw signerRetryable(
    SignerErrorCode.TURNKEY_NETWORK,
    `Turnkey wallet discovery failed within ${deps.discoveryTimeoutMs}ms; last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    lastErr instanceof Error ? lastErr : undefined,
  );
}

function pickAccount(
  accounts: readonly TurnkeyAccount[],
  format: string,
): TurnkeyAccount | undefined {
  return accounts.find((a) => a.addressFormat === format);
}

function addressesEqual(format: string, a: string, b: string): boolean {
  // EVM addresses are case-insensitive in equality (mixed-case checksums encode the same address);
  // Tron and Solana are base58 and case-sensitive.
  if (format === 'ADDRESS_FORMAT_ETHEREUM') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function isTerminalError(err: unknown): boolean {
  // Classify on the stable `name`, not `instanceof`, so it survives duplicate copies of the
  // error package (version skew, or submodule plus workspace) that would break an instanceof check.
  return err instanceof Error && err.name === 'NonRetryableError';
}
