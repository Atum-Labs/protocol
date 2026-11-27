/**
 * Sender config shapes and the destination composition step, kept out of `apply-policies.ts` so
 * they can be imported and tested without running the CLI. That file executes `main()` on import
 * and exits the process on any error, so importing it from a test aborts the test run.
 */
import { buildEscrowDestination } from '@atum-labs/payment-request-sender-auth';

import type { SenderExtras } from '../src/admin';

export type ChainKind = 'evm' | 'tron' | 'solana' | 'stellar';

export interface ChainCfg {
  kind: ChainKind;
  chainId: string; // CAIP-2, e.g. eip155:11155111, tron:shasta, solana:<genesis>
}

/**
 * One allowlisted payee, as its two CAIP components rather than a pre-composed string.
 *
 * Splitting them is the point. The escrow stores only `keccak256(bytes(destination))`, so it
 * cannot tell a formatting disagreement from a wrong payee, and the casing rule is per-segment
 * (eip155 hex folds, base58 does not). A hand-written string that gets one segment wrong matches
 * nothing and silently denies every payment on that chain, so the operator supplies the parts and
 * `buildEscrowDestination` — the same function the payer signs through — joins them.
 */
export interface DestinationCfg {
  /** CAIP-19 asset identifier, e.g. eip155:8453/erc20:0x833589fc… */
  asset: string;
  /** Account in its namespace's native form: hex for eip155, base58 for solana. */
  account: string;
}

export interface SenderConfig {
  type: 'sender';
  chains: Record<string, ChainCfg>;
  senderExtras: Omit<SenderExtras, 'allowedDestinations'> & {
    allowedDestinations?: Record<string, DestinationCfg[]>;
  };
}

/**
 * Compose every configured destination through the shared builder, so no config path ever formats
 * a destination itself. Throws with the chain key and index attached, since a bad entry is
 * otherwise only visible as a chain that quietly stops signing.
 */
export function composeSenderExtras(cfg: SenderConfig): SenderExtras {
  const composed: Record<string, string[]> = {};
  for (const [chainKey, entries] of Object.entries(cfg.senderExtras.allowedDestinations ?? {})) {
    composed[chainKey] = (entries ?? []).map((d, i) => {
      if (typeof d?.asset !== 'string' || typeof d?.account !== 'string') {
        throw new Error(
          `senderExtras.allowedDestinations["${chainKey}"][${i}] must be { asset, account } — ` +
            `a pre-composed string is not accepted, so the casing rule cannot be got wrong by hand.`,
        );
      }
      try {
        return buildEscrowDestination(d.asset, d.account);
      } catch (err) {
        // The builder validates the CAIP-19 shape but knows nothing about this config, so its
        // message alone leaves the operator hunting through every chain's list for the bad entry.
        throw new Error(
          `senderExtras.allowedDestinations["${chainKey}"][${i}] is not a valid destination: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    });
  }
  return { ...cfg.senderExtras, allowedDestinations: composed };
}
