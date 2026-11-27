/**
 * Apply Turnkey server-side policies to an EXISTING sub-organization from a single self-contained
 * YAML config. The policy set is assembled from the shared admin emitters, so the server-side
 * rules mirror exactly what the client-side `PolicyCheckedSigner` enforces (defense in depth).
 *
 * The config's `type` selects the whole assembly:
 *   type: settler  → per-chain allowlist policies (derivePoliciesFromAllowlist) + the
 *                    raw-payload set (buildSettlerRawPayloadPolicies) + approve-spender denies +
 *                    recipient/cap extras.
 *   type: sender   → the Permit2-bounded sender policy set (buildSenderPolicies).
 *   type: verifier → the escrow-witness-bounded verifier policy set (buildVerifierPolicies).
 *
 * Idempotent by policy name with content-drift detection: a policy whose name exists with the
 * SAME effect+condition is skipped; a drifted one FAILS the run unless `--update` is passed, in
 * which case it is replaced through a temporary copy so it is never absent. Always dry-run first.
 *
 * Reconciliation runs both ways. A live policy the emitted set no longer contains FAILS the run
 * unless `--prune` is passed. That matters because a policy set is only as tight as its widest
 * ALLOW: a renamed or retired broad allow left live keeps granting what it always granted, so a
 * narrower replacement silently does not take effect.
 *
 * Auth: the SUB-ORG root key (TURNKEY_SUBORG_ROOT_API_PUBLIC_KEY / _PRIVATE_KEY) by default; override the
 * env var names with --api-public-key-env / --api-private-key-env.
 *
 * Settler self-address: the self-send nonce-burn carve-out is always from the settler's own EVM
 * EOA, so apply-policies resolves it from the sub-org's Turnkey wallet (listWallets then
 * listWalletAccounts, picking the ADDRESS_FORMAT_ETHEREUM account). Use --wallet-id to disambiguate
 * a multi-wallet sub-org. Because resolution reads Turnkey, even a settler dry-run needs the
 * sub-org credentials.
 *
 * Usage:
 *   pnpm turnkey:apply-policies -- \
 *     --config ./config/settler-testnet.yaml \
 *     --sub-org <sub-org-uuid> \
 *     [--dry-run] [--update] [--prune] \
 *     [--wallet-id <wallet-uuid>] \
 *     [--api-public-key-env NAME --api-private-key-env NAME] \
 *     [--api-url https://api.turnkey.com]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  applyPolicies,
  assertCowswapHookFencesPrunable,
  listPolicies,
  planPolicyChanges,
  buildDenyApproveToNonAllowedSpenderEvm,
  buildDenyApproveToNonAllowedSpenderTron,
  buildExtrasPolicies,
  buildSenderPolicies,
  buildSettlerRawPayloadPolicies,
  buildVerifierPolicies,
  derivePoliciesFromAllowlist,
  parseCowswapHook,
  parseAgentUser,
  prepareSettlerUsers,
  parseTransferWithAuthorizationTokens,
  TURNKEY_MAX_POLICIES,
} from '../src/admin';
import type {
  ChainEntry,
  CowswapHookConfig,
  PolicyDefinition,
  SenderExtras,
  TurnkeyPolicyExtras,
  VerifierExtras,
} from '../src/admin';
import {
  DEFAULT_API_URL,
  argParser,
  loadScriptEnv,
  makeClient,
  readEnv,
  subOrgCreds,
} from './_shared';
import type { TurnkeyClient } from '../src/client';
import { assertNoRetiredContracts } from './retired-contracts';
import { composeSenderExtras } from './sender-config';
import { assertAllowanceGrantsFenced, toSigningPolicy } from './settler-config';
import type { AllowlistCfg, ApproveDenyCfg } from './settler-config';
import type { ChainCfg, SenderConfig } from './sender-config';

interface SettlerConfig {
  type: 'settler';
  chains: Record<string, ChainCfg>;
  /** Per-chain allow rules. A chain in `chains` may be omitted here to get extras/approveDeny
   * only (no allowedTo/denyNoOpHash/maxNativeValue derived for it). */
  allowlists: Record<string, AllowlistCfg>;
  /** Optional spender denies on approve() and the other allowance grants, per chain key. */
  approveDeny?: ApproveDenyCfg;
  /** Optional recipient allowlists + gas/fee caps (buildExtrasPolicies). */
  extras?: TurnkeyPolicyExtras;
  /**
   * Required per Stellar chain key: the settler's Stellar account(s), `G...` strkeys. The Stellar
   * raw allow is scoped to them. Turnkey cannot parse Stellar transactions, so a Stellar chain has
   * no `allowlists` fields to enforce server-side (see derivePoliciesFromAllowlist).
   */
  stellarSigners?: Record<string, string[]>;
  /** Required when extras.allowedSplRecipients is set — per Solana chain key, the asset mints. */
  solanaMints?: Record<string, string[]>;
  /** Required. Per EVM chain key, the EIP-3009 token contracts; `{}` means no EIP-3009. */
  transferWithAuthorizationTokens: Record<string, string[]>;
  /**
   * Required. The agent's API user. Apply refuses any other non-root user that `cowswapHook.users`
   * does not list, since it would hold every settler ALLOW.
   */
  agentUser: { userId: string; userName: string };
  /**
   * Optional. Fenced API users on this wallet (the CoW Swap hook, a swap CLI) that sign CoW orders
   * and nothing else, and per EVM chain the token pairs they may order.
   */
  cowswapHook?: {
    users: Array<{ userId: string; userName: string }>;
    chains: Record<string, { pairs: Array<{ sell: string; buy: string }> }>;
  };
}

interface VerifierConfig {
  type: 'verifier';
  chains: Record<string, ChainCfg>;
  verifierExtras: VerifierExtras;
}

type Config = SettlerConfig | SenderConfig | VerifierConfig;

function chainEntries(chains: Record<string, ChainCfg>): ChainEntry[] {
  return Object.entries(chains).map(([key, c]) => ({ key, kind: c.kind, chainId: c.chainId }));
}

/**
 * Collapse within-batch duplicates before handing the set to `applyPolicies`, which keys existing
 * policies by name but does NOT guard against the SAME name appearing twice in one input batch.
 * That happens on the settler path when a chain's gas/fee cap is set in BOTH `allowlists` and
 * `extras` (derivePoliciesFromAllowlist and buildExtrasPolicies emit the same policyName). Exact
 * duplicates (same effect+condition) collapse silently; a same-name/different-condition clash is a
 * config error, so we fail closed with a clear message rather than silently create two rules.
 */
function dedupePolicies(policies: PolicyDefinition[]): PolicyDefinition[] {
  const byName = new Map<string, PolicyDefinition>();
  for (const p of policies) {
    const prev = byName.get(p.policyName);
    if (!prev) {
      byName.set(p.policyName, p);
      continue;
    }
    if (prev.effect !== p.effect || prev.condition !== p.condition) {
      throw new Error(
        `Config produces two different policies named "${p.policyName}". This usually means a ` +
          `gas/fee cap is set in both "allowlists" and "extras" for the same chain — keep it in ` +
          `one place. Conflicting conditions:\n  A: ${prev.condition}\n  B: ${p.condition}`,
      );
    }
    // identical duplicate — drop
  }
  return [...byName.values()];
}

async function buildSettlerPolicies(
  cfg: SettlerConfig,
  settlerEvmSelfAddress: string,
  cowswapHook: CowswapHookConfig | undefined,
): Promise<PolicyDefinition[]> {
  const out: PolicyDefinition[] = [];
  // Non-transaction signing: identity and EIP-3009 typed data, Solana ed25519 raw signing, the
  // KECCAK256 / NO_OP / SHA256, EIP-7702 and batch denies, and the CoW Swap hook user's fence.
  out.push(
    ...buildSettlerRawPayloadPolicies({
      chains: chainEntries(cfg.chains),
      transferWithAuthorizationTokens: cfg.transferWithAuthorizationTokens,
      evmAddress: settlerEvmSelfAddress,
      ...(cfg.stellarSigners ? { stellarSigners: cfg.stellarSigners } : {}),
      ...(cowswapHook ? { cowswapHook } : {}),
    }),
  );

  for (const [key, chain] of Object.entries(cfg.chains)) {
    const allow = cfg.allowlists[key];
    // A chain may be listed with NO allowlist entry when you only want extras/approveDeny on it
    // (e.g. Tron with just a fee cap + TRC-20 recipient allowlist). Skip the derived allow/deny
    // set for it; it still resolves its chainId for the extras/approveDeny blocks below.
    if (!allow) {
      console.log(`(chain "${key}" has no allowlists entry — emitting extras/approveDeny only)`);
      continue;
    }
    // The self-send nonce-burn is always from the settler's own EOA, so every EVM chain uses the
    // one address resolved from the sub-org's Turnkey wallet. Non-EVM chains never use it.
    const selfAddress = chain.kind === 'evm' ? settlerEvmSelfAddress : undefined;
    out.push(
      ...derivePoliciesFromAllowlist(toSigningPolicy(allow), chain.kind, {
        chainId: chain.chainId,
        ...(selfAddress ? { selfAddress } : {}),
      }),
    );
  }

  for (const [key, ad] of Object.entries(cfg.approveDeny?.evm ?? {})) {
    const chain = cfg.chains[key];
    if (!chain) throw new Error(`approveDeny.evm references unknown chain key "${key}".`);
    out.push(
      buildDenyApproveToNonAllowedSpenderEvm({
        chainId: chain.chainId,
        tokenContractsHex: ad.tokenContractsHex,
        allowedSpendersHex: ad.allowedSpendersHex,
      }),
    );
  }
  for (const [key, ad] of Object.entries(cfg.approveDeny?.tron ?? {})) {
    const chain = cfg.chains[key];
    if (!chain) throw new Error(`approveDeny.tron references unknown chain key "${key}".`);
    out.push(
      buildDenyApproveToNonAllowedSpenderTron({
        chainId: chain.chainId,
        tokenContractsBase58: ad.tokenContractsBase58,
        allowedSpendersHex: ad.allowedSpendersHex,
      }),
    );
  }

  if (cfg.extras) {
    const chainKeyToChainId: Record<string, string> = {};
    for (const [key, c] of Object.entries(cfg.chains)) chainKeyToChainId[key] = c.chainId;
    out.push(
      ...(await buildExtrasPolicies(cfg.extras, {
        chainKeyToChainId,
        solanaMintsByChainKey: cfg.solanaMints ?? {},
      })),
    );
  }

  return out;
}

/**
 * Resolve the sub-org's own EVM EOA from Turnkey. The settler wallet is one seed with a single
 * Ethereum-format account shared across every EVM chain, so one lookup yields the address the
 * self-send nonce-burn carve-out needs. Pass --wallet-id if the sub-org holds more than one wallet.
 */
async function resolveEvmSelfAddress(
  client: TurnkeyClient,
  walletIdFilter?: string,
): Promise<string> {
  const wallets = await client.listWallets();
  const candidates = walletIdFilter ? wallets.filter((w) => w.walletId === walletIdFilter) : wallets;
  if (candidates.length === 0) {
    throw new Error(
      walletIdFilter
        ? `No wallet "${walletIdFilter}" in this sub-org.`
        : 'Sub-org has no wallets; cannot resolve the settler EVM self-address.',
    );
  }
  const evm = new Set<string>();
  for (const w of candidates) {
    for (const acct of await client.listWalletAccounts(w.walletId)) {
      if (acct.addressFormat === 'ADDRESS_FORMAT_ETHEREUM' && acct.address) evm.add(acct.address);
    }
  }
  const addrs = [...evm];
  if (addrs.length === 0) throw new Error('No ADDRESS_FORMAT_ETHEREUM account in the sub-org wallet(s).');
  if (addrs.length > 1) {
    throw new Error(
      `Sub-org exposes multiple EVM addresses (${addrs.join(', ')}); pass --wallet-id to select one.`,
    );
  }
  return addrs[0];
}



/**
 * Whether the credentials this run would use are present in the environment. A dry run uses them
 * only to READ the live policy set for the preview, so their absence must degrade the preview
 * rather than fail the run.
 */
function hasSubOrgCreds(args: ReturnType<typeof argParser>): boolean {
  const pubEnv = args.get('api-public-key-env') ?? 'TURNKEY_SUBORG_ROOT_API_PUBLIC_KEY';
  const privEnv = args.get('api-private-key-env') ?? 'TURNKEY_SUBORG_ROOT_API_PRIVATE_KEY';
  return Boolean(process.env[pubEnv]) && Boolean(process.env[privEnv]);
}

async function main() {
  loadScriptEnv();
  const args = argParser();

  const configPath = path.resolve(args.required('config'));
  const subOrg = args.required('sub-org');
  const dryRun = args.flag('dry-run');
  const update = args.flag('update');
  const prune = args.flag('prune');
  const apiUrl = args.get('api-url') ?? DEFAULT_API_URL;
  const walletId = args.get('wallet-id');

  const cfg = parseYaml(fs.readFileSync(configPath, 'utf8')) as Config;
  if (cfg.type !== 'settler' && cfg.type !== 'sender' && cfg.type !== 'verifier') {
    throw new Error(`config.type must be "settler", "sender" or "verifier"; got ${JSON.stringify((cfg as { type?: unknown }).type)}`);
  }
  // Only a settler config carries `allowlists`, which is the sole thing this guard reads, so the
  // call is scoped to that arm. Passing the union does not compile: `AllowlistBearing` is an
  // all-optional type, and `SenderConfig` shares no property with it, which trips TypeScript's
  // weak-type check.
  //
  // NOTE: a sender config's `senderExtras.solanaEscrowProgramId` is therefore still unchecked, and
  // the three sender configs currently pin a program id that IS on the retired list. Closing that
  // is a change to what the guard covers rather than to whether it compiles, so it is left to the
  // owner of the check. Scoping here does not create the gap, since the guard only ever read
  // `allowlists` and so iterated nothing for a sender.
  let cowswapHook: CowswapHookConfig | undefined;
  if (cfg.type === 'settler') {
    assertNoRetiredContracts(cfg);
    assertAllowanceGrantsFenced(cfg);
    cfg.transferWithAuthorizationTokens = parseTransferWithAuthorizationTokens(
      cfg.transferWithAuthorizationTokens,
      chainEntries(cfg.chains),
    );
    parseAgentUser(cfg.agentUser);
    cowswapHook = parseCowswapHook(cfg.cowswapHook, chainEntries(cfg.chains));
  }

  // The settler self-send nonce-burn is always from the settler's own EOA, so for a settler config
  // we always resolve that address from the sub-org's Turnkey wallet. That read needs a client, so
  // a settler run always builds one.
  //
  // A dry run builds one too WHEN CREDENTIALS ARE AVAILABLE, because the preview below reads the
  // live set to show what has drifted and what `--prune` would delete. Credentials are optional
  // here on purpose: the preview is the only way to see a destructive flag's effect before using
  // it, but a dry run must still work for someone who only wants to eyeball the emitted set.
  let client: TurnkeyClient | undefined;
  const credsUnavailable = hasSubOrgCreds(args)
    ? undefined
    : 'TURNKEY_SUBORG_ROOT_API_PUBLIC_KEY / _PRIVATE_KEY unset';
  if (cfg.type === 'settler' || !dryRun || hasSubOrgCreds(args)) {
    // Credentials: the sub-org root key by default, or override the env var names via the *-env flags.
    const pubEnv = args.get('api-public-key-env');
    const privEnv = args.get('api-private-key-env');
    const apiPublicKey = pubEnv ? readEnv(pubEnv) : subOrgCreds().apiPublicKey;
    const apiPrivateKey = privEnv ? readEnv(privEnv) : subOrgCreds().apiPrivateKey;
    client = makeClient({ organizationId: subOrg, apiUrl, apiPublicKey, apiPrivateKey });
  }

  let policies: PolicyDefinition[];
  if (cfg.type === 'sender') {
    policies = dedupePolicies(buildSenderPolicies(composeSenderExtras(cfg), chainEntries(cfg.chains)));
  } else if (cfg.type === 'verifier') {
    policies = dedupePolicies(buildVerifierPolicies(cfg.verifierExtras, chainEntries(cfg.chains)));
  } else {
    const evmSelfAddress = await resolveEvmSelfAddress(client!, walletId);
    console.log(`Settler EVM self-address (resolved from Turnkey wallet): ${evmSelfAddress}`);
    const settlerUsers = await prepareSettlerUsers(client!, subOrg, cfg, chainEntries(cfg.chains));
    cowswapHook = settlerUsers.cowswapHook;
    const { agentUser } = settlerUsers;
    console.log(`Agent user ${agentUser.userName} (${agentUser.userId}): exists, not root, name unique`);
    for (const u of cowswapHook?.users ?? []) {
      console.log(`CoW Swap fenced user ${u.userName} (${u.userId}): exists, not root, name unique`);
    }
    console.log('No other non-root user in the sub-org.');
    policies = dedupePolicies(await buildSettlerPolicies(cfg, evmSelfAddress, cowswapHook));
  }

  console.log(`\n=== ${cfg.type} policies to apply (${policies.length}) → sub-org ${subOrg} ===`);
  for (const p of policies) {
    console.log(`- [${p.effect}] ${p.policyName}`);
    console.log(`    ${p.condition}`);
  }
  console.log('='.repeat(60));

  if (dryRun) {
    // Show the OTHER direction too when we can read the sub-org. Printing only what we would
    // write leaves the operator unable to see what `--prune` is about to delete, which is the
    // one question a dry run most needs to answer before a destructive flag is used.
    if (client) {
      const live = await listPolicies(client, subOrg);
      const { drifted, stale, leftovers, duplicateNames, peakCount } = planPolicyChanges(live, policies);
      console.log(
        `\nLive policies: ${live.length}. Most live at once during this run: ${peakCount} of ` +
          `Turnkey's ${TURNKEY_MAX_POLICIES}.`,
      );
      if (peakCount > TURNKEY_MAX_POLICIES) {
        console.log(
          `The run would be REFUSED: free ${peakCount - TURNKEY_MAX_POLICIES} slot(s) first by ` +
            'deleting policies the sub-org no longer needs (turnkey:delete-policies).',
        );
      }
      // The real run refuses an emitted name with several live copies, and --prune deletes every
      // copy of a stale one; the preview says which.
      const emittedNames = new Set(policies.map((p) => p.policyName));
      const shadowed = duplicateNames.filter((n) => emittedNames.has(n));
      const staleDuplicates = duplicateNames.filter((n) => !emittedNames.has(n));
      if (shadowed.length > 0) {
        console.log(
          `\nThe run would be REFUSED: ${shadowed.length} emitted policy name(s) are held by more ` +
            `than one live policy. Delete the extra copies first: ${shadowed.join(', ')}`,
        );
      }
      if (staleDuplicates.length > 0) {
        console.log(
          `\n${staleDuplicates.length} stale policy name(s) are held by more than one live policy; ` +
            `--prune deletes every copy: ${staleDuplicates.join(', ')}`,
        );
      }
      if (leftovers.length > 0) {
        console.log(
          `\n${leftovers.length} temporary copy(ies) from an interrupted replacement are live; a run ` +
            'that is not refused deletes them once the real copy is live:',
        );
        for (const p of leftovers) console.log(`  - ${p.policyName} (${p.policyId})`);
      }
      if (drifted.length > 0) {
        console.log(`\nWould need --update, ${drifted.length} live policy(ies) drifted:`);
        for (const d of drifted) console.log(`  - ${d.name}`);
      }
      if (stale.length > 0) {
        // The real run checks this before pruning, so the preview does too: a refused prune
        // deletes nothing, and listing deletions would contradict it.
        let pruneRefusal: string | undefined;
        try {
          await assertCowswapHookFencesPrunable(client, subOrg, stale);
        } catch (err) {
          pruneRefusal = (err as Error).message;
        }
        if (pruneRefusal !== undefined) {
          console.log(
            `\n${stale.length} live policy(ies) are absent from this set, and --prune would be ` +
              `REFUSED, deleting nothing: ${pruneRefusal}`,
          );
        } else {
          console.log(
            `\nWould need --prune, ${stale.length} live policy(ies) absent from this set ` +
              `(--prune DELETES these):`,
          );
          for (const p of stale) console.log(`  - [${p.effect}] ${p.policyName} (${p.policyId})`);
        }
      }
      if (
        drifted.length === 0 &&
        stale.length === 0 &&
        leftovers.length === 0 &&
        duplicateNames.length === 0
      ) {
        console.log('\nLive set reconciles with this config: nothing drifted, nothing stale.');
      }
    } else {
      console.log(
        `\nSub-org credentials are not set (${credsUnavailable ?? 'no credentials'}), so the live ` +
          'set was not read and this preview cannot show drifted or stale policies. Set them to ' +
          'see what --prune would delete before you pass it.',
      );
    }
    console.log('\nDry run — nothing pushed to Turnkey. Re-run without --dry-run to apply.');
    return;
  }

  if (prune) {
    const { stale } = planPolicyChanges(await listPolicies(client!, subOrg), policies);
    await assertCowswapHookFencesPrunable(client!, subOrg, stale);
  }
  const res = await applyPolicies(client!, policies, { organizationId: subOrg, update, prune });

  console.log(`\nCreated ${res.created.length} policy(ies).`);
  if (res.skippedUnchanged.length) {
    console.log(`Skipped ${res.skippedUnchanged.length} unchanged: ${res.skippedUnchanged.join(', ')}`);
  }
  if (res.replaced.length) {
    console.log(`Replaced ${res.replaced.length} drifted:`);
    for (const r of res.replaced) console.log(`  ${r.name}: ${r.oldPolicyId} → ${r.newPolicyId}`);
  }
  if (res.clearedLeftovers.length) {
    console.log(`Deleted ${res.clearedLeftovers.length} temporary copy(ies) an interrupted replacement left:`);
    for (const r of res.clearedLeftovers) console.log(`  ${r.name} (${r.policyId})`);
  }
  if (res.pruned.length) {
    console.log(`Pruned ${res.pruned.length} policy(ies) absent from the emitted set:`);
    for (const r of res.pruned) console.log(`  ${r.name} (${r.policyId})`);
  }
}

main().catch((err) => {
  console.error('apply-policies failed:', err);
  process.exit(1);
});
