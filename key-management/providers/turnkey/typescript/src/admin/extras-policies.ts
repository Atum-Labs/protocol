// Operator policy "extras" — recipient allowlists and gas/fee DoS caps that sit ON TOP of the
// auto-derived per-chain policies (`derivePoliciesFromAllowlist`). These are deployment-specific
// values an operator supplies (which addresses inventory may move to, how high a legit tx's gas
// or fee can go) rather than anything derivable from the chain/contract registry, so they live
// in their own input rather than the `SigningPolicy` allowlist.
//
// Pure emitters — no Turnkey calls and no file I/O. A consumer (settler-agent / atum-core apply
// script) parses its own YAML into `TurnkeyPolicyExtras`, resolves the chain-key → chainId map
// and the Solana mints, then feeds both to `buildExtrasPolicies`. The result is concatenated
// with the derived policies and pushed via `applyPolicies`.
//
// `@solana/web3.js` is loaded lazily inside the SPL branch so an EVM-only consumer of the admin
// barrel never has to install the Solana SDK (it is an optional peer dependency).

import type { PolicyDefinition } from './policies';
import { tronBase58ToEvmHex } from './sender-policies';

// Associated-token-account derivation constants (classic SPL Token program; matches the
// destination ATA Turnkey exposes as `solana.tx.spl_transfers[*].to`).
const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export interface TurnkeyPolicyExtras {
  /** Per-chain ERC-20 transfer/transferFrom recipient allowlist (20-byte hex, `0x`-prefixed). */
  allowedErc20Recipients?: Record<string, string[]>;
  /** Per-chain TRC-20 transfer/transferFrom recipient allowlist (Tron base58). */
  allowedTrc20Recipients?: Record<string, string[]>;
  /** Per-chain SPL transfer recipient WALLETS (base58). ATAs are derived per (wallet × mint). */
  allowedSplRecipients?: Record<string, string[]>;
  /** Per-EVM-chain caps for eth.tx.gas and eth.tx.max_fee_per_gas (also gas_price for legacy). */
  evmCaps?: Record<string, { maxGasLimit?: number; maxFeePerGasWei?: string }>;
  /** Per-Tron-chain cap for tron.tx.fee_limit (in SUN). */
  tronCaps?: Record<string, { maxFeeLimitSun?: string }>;
}

/** Context for `buildExtrasPolicies`. `chainKeyToChainId` mirrors the profile `chains:` map;
 * `solanaMintsByChainKey` carries each Solana chain's configured asset mint addresses. */
export interface ExtrasBuildContext {
  readonly chainKeyToChainId: Record<string, string>;
  readonly solanaMintsByChainKey: Record<string, string[]>;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

// The only keys validateExtras accepts. `satisfies` pins every entry to a real interface field
// so this list cannot drift from TurnkeyPolicyExtras. Anything else is almost always a typo.
const ALLOWED_EXTRAS_KEYS = [
  'allowedErc20Recipients',
  'allowedTrc20Recipients',
  'allowedSplRecipients',
  'evmCaps',
  'tronCaps',
] as const satisfies readonly (keyof TurnkeyPolicyExtras)[];

/**
 * Validate a parsed extras object. Throws on the first malformed entry so operator misconfig
 * surfaces before anything is pushed to Turnkey. `source` is only used in error messages.
 */
export function validateExtras(data: unknown, source = 'extras'): asserts data is TurnkeyPolicyExtras {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${source}: top-level must be an object/map.`);
  }
  const obj = data as Record<string, unknown>;
  // Fail closed on unknown top-level keys: a typo like `evmCap` would otherwise be silently
  // dropped, emitting no policy while the operator believes a cap/allowlist is in force.
  for (const key of Object.keys(obj)) {
    if (!(ALLOWED_EXTRAS_KEYS as readonly string[]).includes(key)) {
      throw new Error(`${source}: unknown key "${key}" (allowed: ${ALLOWED_EXTRAS_KEYS.join(', ')}).`);
    }
  }
  if (obj.allowedErc20Recipients != null) {
    validateAddressMap(obj.allowedErc20Recipients, 'allowedErc20Recipients', EVM_ADDRESS, source);
  }
  if (obj.allowedTrc20Recipients != null) {
    validateAddressMap(obj.allowedTrc20Recipients, 'allowedTrc20Recipients', TRON_ADDRESS, source);
  }
  if (obj.allowedSplRecipients != null) {
    // Solana base58 is variable-length (~32-44). A loose base58 shape check keeps this module
    // free of a hard `@solana/web3.js` dependency at validation time; the ATA derivation in
    // buildExtrasPolicies parses it strictly via PublicKey and throws on a bad address.
    // An EMPTY list is allowed here and means "deny ALL top-level SPL transfers on this chain".
    validateAddressMap(
      obj.allowedSplRecipients,
      'allowedSplRecipients',
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
      source,
      true,
    );
  }
  if (obj.evmCaps != null) {
    validateCapMap(obj.evmCaps, 'evmCaps', ['maxGasLimit', 'maxFeePerGasWei'], source);
  }
  if (obj.tronCaps != null) {
    validateCapMap(obj.tronCaps, 'tronCaps', ['maxFeeLimitSun'], source);
  }
}

function validateCapMap(map: unknown, field: string, allowedKeys: string[], source: string): void {
  if (typeof map !== 'object' || map == null || Array.isArray(map)) {
    throw new Error(`${source}: ${field} must be a map keyed by chain name.`);
  }
  for (const [chainKey, entry] of Object.entries(map as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry == null || Array.isArray(entry)) {
      throw new Error(`${source}: ${field}.${chainKey} must be an object.`);
    }
    for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
      if (!allowedKeys.includes(k)) {
        throw new Error(
          `${source}: ${field}.${chainKey} has unknown key "${k}" (allowed: ${allowedKeys.join(', ')}).`,
        );
      }
      if (k === 'maxGasLimit') {
        if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
          throw new Error(
            `${source}: ${field}.${chainKey}.${k} must be a positive integer; got ${JSON.stringify(v)}.`,
          );
        }
      } else if (typeof v !== 'string' || !/^\d+$/.test(v)) {
        throw new Error(
          `${source}: ${field}.${chainKey}.${k} must be a decimal-string integer; got ${JSON.stringify(v)}.`,
        );
      }
    }
  }
}

function validateAddressMap(
  map: unknown,
  field: string,
  pattern: RegExp,
  source: string,
  allowEmpty = false,
): void {
  if (typeof map !== 'object' || map == null || Array.isArray(map)) {
    throw new Error(`${source}: ${field} must be a map keyed by chain name.`);
  }
  for (const [chainKey, list] of Object.entries(map as Record<string, unknown>)) {
    if (!Array.isArray(list) || (!allowEmpty && list.length === 0)) {
      throw new Error(`${source}: ${field}.${chainKey} must be a non-empty list of addresses.`);
    }
    for (const addr of list) {
      if (typeof addr !== 'string' || !pattern.test(addr)) {
        throw new Error(
          `${source}: ${field}.${chainKey} contains an invalid address: ${JSON.stringify(addr)}`,
        );
      }
    }
  }
}

/**
 * Emit the extras policy set. Async because the Solana SPL branch lazily imports
 * `@solana/web3.js` to derive destination ATAs without forcing the SDK on EVM-only consumers.
 */
export async function buildExtrasPolicies(
  extras: TurnkeyPolicyExtras,
  ctx: ExtrasBuildContext,
): Promise<PolicyDefinition[]> {
  validateExtras(extras);
  const out: PolicyDefinition[] = [];

  const resolveChainId = (field: string, chainKey: string, prefix: string): string => {
    const chainId = ctx.chainKeyToChainId[chainKey];
    if (!chainId) {
      throw new Error(
        `${field} references chain key "${chainKey}", not in the chains: map. Available: ${Object.keys(ctx.chainKeyToChainId).join(', ')}`,
      );
    }
    if (!chainId.startsWith(prefix)) {
      throw new Error(`${field} only applies to ${prefix}* chains; got "${chainKey}" = "${chainId}".`);
    }
    return chainId;
  };

  // ── EVM ERC-20 recipient allowlist ──────────────────────────────────────
  if (extras.allowedErc20Recipients) {
    for (const [chainKey, recipients] of Object.entries(extras.allowedErc20Recipients)) {
      const chainId = resolveChainId('allowedErc20Recipients', chainKey, 'eip155:');
      out.push(...buildErc20RecipientPolicies(chainId, recipients));
    }
  }

  // ── Tron TRC-20 recipient allowlist ─────────────────────────────────────
  if (extras.allowedTrc20Recipients) {
    for (const [chainKey, recipients] of Object.entries(extras.allowedTrc20Recipients)) {
      const chainId = resolveChainId('allowedTrc20Recipients', chainKey, 'tron:');
      // Tron base58 → 40-char lowercase hex. TRC-20 ABI uses 20-byte EVM-style addresses
      // without the `41` network byte, which is exactly what tronBase58ToEvmHex returns.
      const hexRecipients = recipients.map((b58) => tronBase58ToEvmHex(b58).toLowerCase());
      out.push(...buildTrc20RecipientPolicies(chainId, hexRecipients));
    }
  }

  // ── EVM gas / fee caps ──────────────────────────────────────────────────
  if (extras.evmCaps) {
    for (const [chainKey, caps] of Object.entries(extras.evmCaps)) {
      const chainId = resolveChainId('evmCaps', chainKey, 'eip155:');
      const numericChainId = chainId.split(':')[1] ?? chainId;
      if (caps.maxGasLimit != null) {
        out.push({
          policyName: `maxGasLimit (${chainId})`,
          effect: 'EFFECT_DENY',
          condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == ${numericChainId} && eth.tx.gas > ${caps.maxGasLimit}`,
          notes: 'Caps eth.tx.gas — operator-supplied via extras YAML.',
        });
      }
      if (caps.maxFeePerGasWei != null) {
        out.push({
          policyName: `maxFeePerGasWei (${chainId})`,
          effect: 'EFFECT_DENY',
          condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == ${numericChainId} && (eth.tx.max_fee_per_gas > ${caps.maxFeePerGasWei} || eth.tx.gas_price > ${caps.maxFeePerGasWei})`,
          notes: 'Caps per-gas fee for both EIP-1559 and legacy tx types — operator-supplied.',
        });
      }
    }
  }

  // ── Tron fee_limit cap ──────────────────────────────────────────────────
  if (extras.tronCaps) {
    for (const [chainKey, caps] of Object.entries(extras.tronCaps)) {
      const chainId = resolveChainId('tronCaps', chainKey, 'tron:');
      if (caps.maxFeeLimitSun != null) {
        out.push({
          policyName: `maxFeeLimitSun (${chainId})`,
          effect: 'EFFECT_DENY',
          condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && tron.tx.fee_limit > ${caps.maxFeeLimitSun}`,
          notes: 'Caps tron.tx.fee_limit (SUN) — operator-supplied via extras YAML.',
        });
      }
    }
  }

  // ── Solana SPL recipient allowlist ──────────────────────────────────────
  // Resolve + guard every SPL chain first (needs no SDK) so chain/mint misconfig throws even
  // where `@solana/web3.js` is absent; only then lazy-import it for the actual ATA derivation.
  if (extras.allowedSplRecipients) {
    const jobs: Array<{ chainId: string; recipients: string[]; mints: string[] }> = [];
    for (const [chainKey, recipients] of Object.entries(extras.allowedSplRecipients)) {
      const chainId = resolveChainId('allowedSplRecipients', chainKey, 'solana:');
      // Empty list = deny ALL top-level SPL transfers on this chain. Nothing is allowlisted, so
      // there is no recipient to derive an ATA for and no mint is required — emit the deny now.
      if (recipients.length === 0) {
        out.push(buildSplRecipientPolicy(chainId, []));
        continue;
      }
      const mints = ctx.solanaMintsByChainKey[chainKey] ?? [];
      if (mints.length === 0) {
        throw new Error(
          `allowedSplRecipients.${chainKey} requires the Solana chain "${chainKey}" to expose at least one asset mint; got 0.`,
        );
      }
      jobs.push({ chainId, recipients, mints });
    }
    if (jobs.length > 0) {
      const { PublicKey } = await import('@solana/web3.js');
      const tokenProgram = new PublicKey(SPL_TOKEN_PROGRAM_ID);
      const ataProgram = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
      for (const { chainId, recipients, mints } of jobs) {
        const atas: string[] = [];
        for (const recipient of recipients) {
          const owner = new PublicKey(recipient);
          for (const mintB58 of mints) {
            const mint = new PublicKey(mintB58);
            // Standard ATA derivation (classic SPL Token program), equivalent to
            // getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve=true).
            const [ata] = PublicKey.findProgramAddressSync(
              [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
              ataProgram,
            );
            atas.push(ata.toBase58());
          }
        }
        out.push(buildSplRecipientPolicy(chainId, atas));
      }
    }
  }

  return out;
}

/**
 * EVM ERC-20 recipient allowlist. Slices the recipient out of `eth.tx.data` (a Turnkey-side ABI
 * decode via `contract_call_args` does not reliably fire — a deny clause that errors falls
 * through to Allow, so we slice the raw calldata instead).
 *
 * `eth.tx.data` is `0x`-prefixed lowercase hex:
 *   transfer(address,uint256)             — recipient = data[34..74]
 *   transferFrom(address,address,uint256) — recipient = data[98..138]
 * Allowlist entries are 40-char lowercase hex, no `0x` prefix.
 */
function buildErc20RecipientPolicies(chainId: string, recipients: string[]): PolicyDefinition[] {
  const numericChainId = chainId.split(':')[1] ?? chainId;
  const list = recipients.map((a) => `'${a.toLowerCase().replace(/^0x/, '')}'`).join(', ');
  return [
    {
      policyName: `allowedErc20Recipients/transfer (${chainId})`,
      effect: 'EFFECT_DENY',
      condition:
        `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
        `eth.tx.chain_id == ${numericChainId} && ` +
        `eth.tx.function_signature == '0xa9059cbb' && ` +
        `!(eth.tx.data[34..74] in [${list}])`,
      notes: 'Denies ERC-20 transfer to a recipient outside the allowlist (slices data[34..74]).',
    },
    {
      policyName: `allowedErc20Recipients/transferFrom (${chainId})`,
      effect: 'EFFECT_DENY',
      condition:
        `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
        `eth.tx.chain_id == ${numericChainId} && ` +
        `eth.tx.function_signature == '0x23b872dd' && ` +
        `!(eth.tx.data[98..138] in [${list}])`,
      notes:
        'Denies ERC-20 transferFrom to a recipient outside the allowlist (slices data[98..138]).',
    },
  ];
}

/**
 * Tron TRC-20 recipient allowlist. Slices the recipient out of `tron.tx.contract[*].data`
 * (no `contract_call_args` on Tron). Tron `data` has no `0x` prefix.
 *   transfer(address,uint256)              — recipient = data[32..72]
 *   transferFrom(address,address,uint256)  — recipient = data[96..136]
 */
function buildTrc20RecipientPolicies(chainId: string, hexRecipients: string[]): PolicyDefinition[] {
  const list = hexRecipients.map((a) => `'${a}'`).join(', ');
  return [
    {
      policyName: `allowedTrc20Recipients/transfer (${chainId})`,
      effect: 'EFFECT_DENY',
      condition:
        `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
        `tron.tx.contract.any(c, c.type == 'TriggerSmartContract' && c.data[0..8] == 'a9059cbb' && !(c.data[32..72] in [${list}]))`,
      notes:
        'Denies TRC-20 transfer to a recipient outside the allowlist (multi-contract resilient).',
    },
    {
      policyName: `allowedTrc20Recipients/transferFrom (${chainId})`,
      effect: 'EFFECT_DENY',
      condition:
        `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
        `tron.tx.contract.any(c, c.type == 'TriggerSmartContract' && c.data[0..8] == '23b872dd' && !(c.data[96..136] in [${list}]))`,
      notes:
        'Denies TRC-20 transferFrom to a recipient outside the allowlist (multi-contract resilient).',
    },
  ];
}

/** Solana SPL recipient allowlist. Operator supplies wallets; ATAs (per recipient × mint) are
 * pre-derived because Turnkey's `spl_transfers[*].to` field is the destination ATA. */
function buildSplRecipientPolicy(chainId: string, allowedAtas: string[]): PolicyDefinition {
  const list = allowedAtas.map((a) => `'${a}'`).join(', ');
  return {
    policyName: `allowedSplRecipients (${chainId})`,
    effect: 'EFFECT_DENY',
    condition:
      `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && ` +
      `solana.tx.spl_transfers.any(t, !(t.to in [${list}]))`,
    notes:
      allowedAtas.length === 0
        ? 'Denies ALL top-level SPL transfers (empty allowlist — no destination is permitted).'
        : 'Denies any top-level SPL transfer to a destination ATA outside the allowlist.',
  };
}
