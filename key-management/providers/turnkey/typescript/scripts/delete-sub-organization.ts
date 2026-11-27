/**
 * Delete a Turnkey sub-organization. DESTRUCTIVE and normally irreversible.
 *
 * Runs with the SUB-ORG's OWN root credentials (TURNKEY_SUBORG_ROOT_API_*). Turnkey requires the
 * signer (voters) to be a root user inside the org being deleted — the parent key has no membership
 * in an independent sub-org and gets "organization mismatch". The activity operates on the org named
 * by `organizationId`, so the client is scoped to the sub-org being deleted (there is no target-id
 * parameter). Put the target sub-org's root key in TURNKEY_SUBORG_ROOT_API_* before running.
 *
 * By default `deleteWithoutExport` is FALSE, so Turnkey refuses if any wallet or private key in the
 * sub-org has not been exported (prevents silent key/fund loss). Pass `--force` to delete anyway —
 * with `--force`, the wallet keys are gone for good, so sweep any funds first.
 *
 * A typed confirmation is required: `--confirm <sub-org-id>` must equal `--sub-org`.
 *
 * Usage:
 *   pnpm turnkey:delete-sub-org -- \
 *     --sub-org <sub-org-uuid> \
 *     --confirm <sub-org-uuid> \
 *     [--force] \
 *     [--parent-org <uuid>] [--api-url https://api.turnkey.com]
 */
import { deleteSubOrganization } from '../src/admin';
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
    throw new Error(
      `--confirm (${confirm}) must exactly equal --sub-org (${subOrg}). Refusing to delete.`,
    );
  }
  const force = args.flag('force');
  const apiUrl = args.get('api-url') ?? DEFAULT_API_URL;

  // Scope the client to the sub-org being deleted and sign with ITS OWN root key. Turnkey requires
  // the voter to be a member of the target org; the parent key cannot delete an independent sub-org.
  // The env-name override matters right after a root-key rotation, when the canonical vars still hold
  // the revoked key.
  const pubEnv = args.get('api-public-key-env');
  const privEnv = args.get('api-private-key-env');
  if (Boolean(pubEnv) !== Boolean(privEnv)) {
    throw new Error('--api-public-key-env and --api-private-key-env must be given together.');
  }
  const creds =
    pubEnv && privEnv
      ? { apiPublicKey: readEnv(pubEnv), apiPrivateKey: readEnv(privEnv) }
      : subOrgCreds();
  const client = makeClient({ organizationId: subOrg, apiUrl, ...creds });

  console.log(
    `Deleting sub-organization ${subOrg} (deleteWithoutExport=${force})…` +
      (force ? ' FORCE: unexported wallet keys will be permanently lost.' : ''),
  );
  try {
    await deleteSubOrganization(client, { deleteWithoutExport: force });
  } catch (err) {
    if (!isConsensusNeeded(err)) throw err;
    const activityId = activityIdFromError(err);
    console.error('\nPENDING APPROVAL — the delete was accepted, not failed.');
    console.error("The parent org's root quorum needs more approvers before the sub-org is deleted.");
    if (activityId) console.error(`  activity to approve: ${activityId}`);
    console.error('Approve it in the Turnkey dashboard, or lower the parent root quorum to 1.');
    process.exit(2);
  }

  console.log(`\nDeleted sub-organization ${subOrg}.`);
}

main().catch((err) => {
  // If Turnkey refused because wallets were not exported, this is where it surfaces — re-run with
  // --force only after confirming the sub-org holds nothing you need.
  console.error('delete-sub-organization failed:', err);
  process.exit(1);
});
