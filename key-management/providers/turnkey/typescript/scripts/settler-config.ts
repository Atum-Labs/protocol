/**
 * Settler allowlist shapes and their checks, kept out of `apply-policies.ts` so they can be
 * imported and tested without running the CLI (that file runs `main()` on import).
 */
import { ALLOWANCE_GRANT_SELECTORS } from '../src/admin';
import type { TurnkeyAllowlistPolicy } from '../src/admin';
import type { ChainCfg } from './sender-config';

/** One chain's allowlist. Maps 1:1 to km-core `SigningPolicy` plus the Turnkey-only allowedSelectorsByTo. */
export interface AllowlistCfg {
  allowedTo?: string[] | 'any';
  allowedSelectors?: string[] | 'any';
  /** EVM/Tron: per allowedTo address, the selectors it may be called with, or 'any'. Once set,
   * every allowedTo entry needs a key. Turnkey-side only; the settler's client policy is unchanged. */
  allowedSelectorsByTo?: Record<string, string[] | 'any'>;
  allowedPrograms?: string[] | 'any';
  allowedAnchorDiscriminators?: Record<string, string[] | 'any'>;
  maxNativeValue?: string;
  maxGasLimit?: number;
  maxFeePerGasWei?: string;
  maxFeeLimitSun?: string;
}

/** Optional spender denies on approve() and the other allowance grants, per chain key. */
export interface ApproveDenyCfg {
  evm?: Record<string, { tokenContractsHex: string[]; allowedSpendersHex: string[] }>;
  tron?: Record<string, { tokenContractsBase58: string[]; allowedSpendersHex: string[] }>;
}

export function toSigningPolicy(a: AllowlistCfg): TurnkeyAllowlistPolicy {
  // Provide the fields derivePoliciesFromAllowlist reads. maxNativeValue/requireChainIdMatch carry
  // km-core's defaults; selfAddress is passed via context, not the policy object.
  return {
    ...(a.allowedTo !== undefined ? { allowedTo: a.allowedTo } : {}),
    ...(a.allowedSelectors !== undefined ? { allowedSelectors: a.allowedSelectors } : {}),
    ...(a.allowedSelectorsByTo !== undefined ? { allowedSelectorsByTo: a.allowedSelectorsByTo } : {}),
    ...(a.allowedPrograms !== undefined ? { allowedPrograms: a.allowedPrograms } : {}),
    ...(a.allowedAnchorDiscriminators !== undefined
      ? { allowedAnchorDiscriminators: a.allowedAnchorDiscriminators }
      : {}),
    maxNativeValue: a.maxNativeValue ?? '0',
    ...(a.maxGasLimit !== undefined ? { maxGasLimit: a.maxGasLimit } : {}),
    ...(a.maxFeePerGasWei !== undefined ? { maxFeePerGasWei: a.maxFeePerGasWei } : {}),
    ...(a.maxFeeLimitSun !== undefined ? { maxFeeLimitSun: a.maxFeeLimitSun } : {}),
    requireChainIdMatch: true,
  } as TurnkeyAllowlistPolicy;
}

const GRANTS = new Set<string>(ALLOWANCE_GRANT_SELECTORS);

/**
 * Refuse a selector map that lets the settler grant an allowance (approve and friends, or 'any')
 * on an address with no approveDeny entry for that chain: the grant would then reach any spender.
 */
export function assertAllowanceGrantsFenced(cfg: {
  chains: Record<string, ChainCfg>;
  allowlists: Record<string, AllowlistCfg>;
  approveDeny?: ApproveDenyCfg;
}): void {
  const offences: string[] = [];
  for (const [key, allow] of Object.entries(cfg.allowlists ?? {})) {
    const kind = cfg.chains[key]?.kind;
    if ((kind !== 'evm' && kind !== 'tron') || !allow?.allowedSelectorsByTo) continue;
    // Tokens as the deny emits them: Turnkey reports eth.tx.to lowercase, so a mixed-case token
    // would never match and is refused here as unfenced.
    const fenced =
      kind === 'evm'
        ? new Set((cfg.approveDeny?.evm?.[key]?.tokenContractsHex ?? []).map((t) => `0x${t}`))
        : new Set(cfg.approveDeny?.tron?.[key]?.tokenContractsBase58 ?? []);
    for (const [to, selectors] of Object.entries(allow.allowedSelectorsByTo)) {
      const grants =
        selectors === 'any' ||
        (Array.isArray(selectors) && selectors.some((s) => GRANTS.has(String(s).toLowerCase())));
      if (grants && !fenced.has(kind === 'evm' ? to.toLowerCase() : to)) offences.push(`  - ${key}: ${to}`);
    }
  }
  if (offences.length > 0) {
    throw new Error(
      `allowedSelectorsByTo lets the settler grant an allowance on ${offences.length} address(es) ` +
        `with no approveDeny entry for that chain, so the grant could name any spender:\n` +
        `${offences.join('\n')}\n\nAdd each token to approveDeny.<evm|tron>.<chain> with the ` +
        `trusted spenders, or drop the allowance selectors from its list.`,
    );
  }
}
