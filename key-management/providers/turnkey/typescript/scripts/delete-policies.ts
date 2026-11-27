/**
 * DESTRUCTIVE: delete policies from a sub-organization — all of them, or only those matching
 * --grep. Use it to wipe a wrong policy set (e.g. sender policies applied to a settler sub-org)
 * before re-running apply-policies with the correct config.
 *
 * Signs with the sub-org's own root key (TURNKEY_SUBORG_ROOT_API_*), the same identity apply-policies
 * uses. Override the var names with --api-public-key-env / --api-private-key-env.
 *
 * Safety: --confirm <sub-org-id> must equal --sub-org. Always --dry-run first to see the list.
 *
 * While no policies exist the agent default-denies everything (fail-safe), so it is fine to delete
 * then re-apply. Do NOT leave a production sub-org policy-less longer than the re-apply takes.
 *
 * Usage:
 *   pnpm turnkey:delete-policies -- --sub-org <uuid> --confirm <uuid> [--grep <substr>] [--dry-run]
 */
import { deletePolicy, listPolicies } from '../src/admin';
import {
  DEFAULT_API_URL,
  activityIdFromError,
  argParser,
  isConsensusNeeded,
  loadScriptEnv,
  makeClient,
  readEnv,
  subOrgCreds,
} from './_shared';

async function main() {
  loadScriptEnv();
  const args = argParser();
  const subOrg = args.required('sub-org');
  const confirm = args.required('confirm');
  if (confirm !== subOrg) {
    throw new Error(`--confirm (${confirm}) must exactly equal --sub-org (${subOrg}). Refusing.`);
  }
  const grep = args.get('grep')?.toLowerCase();
  const dryRun = args.flag('dry-run');
  const apiUrl = args.get('api-url') ?? DEFAULT_API_URL;

  const pubEnv = args.get('api-public-key-env');
  const privEnv = args.get('api-private-key-env');
  const creds =
    pubEnv && privEnv
      ? { apiPublicKey: readEnv(pubEnv), apiPrivateKey: readEnv(privEnv) }
      : subOrgCreds();
  const client = makeClient({ organizationId: subOrg, apiUrl, ...creds });

  const all = await listPolicies(client, subOrg);
  const targets = all.filter(
    (p) => !grep || `${p.policyName} ${p.condition}`.toLowerCase().includes(grep),
  );

  console.log(
    `\n${all.length} policies on ${subOrg}; ${targets.length} to delete` +
      (grep ? ` (matching "${grep}")` : '') +
      ':',
  );
  for (const p of targets) console.log(`  [${p.effect}] ${p.policyName}  (${p.policyId})`);

  if (dryRun) {
    console.log('\nDry run — nothing deleted. Re-run without --dry-run to delete the above.');
    return;
  }

  let deleted = 0;
  for (const p of targets) {
    try {
      await deletePolicy(client, p.policyId);
      deleted++;
      console.log(`deleted [${p.effect}] ${p.policyName}`);
    } catch (err) {
      if (isConsensusNeeded(err)) {
        console.error(
          `\nPENDING APPROVAL while deleting "${p.policyName}" (activity ${activityIdFromError(err)}). ` +
            `Approve it, or lower the sub-org root quorum to 1, then re-run. Deleted ${deleted} so far.`,
        );
        process.exit(2);
      }
      throw err;
    }
  }
  console.log(`\nDeleted ${deleted}/${targets.length} policies. Now run apply-policies with the correct config.`);
}

main().catch((err) => {
  console.error('delete-policies failed:', err);
  process.exit(1);
});
