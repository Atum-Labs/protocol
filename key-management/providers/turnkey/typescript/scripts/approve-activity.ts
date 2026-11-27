/**
 * Approve a Turnkey activity that is waiting on root-quorum consensus, or list what is waiting.
 *
 * When a sub-org's root quorum threshold is above 1, an activity submitted by one root user comes
 * back ACTIVITY_STATUS_CONSENSUS_NEEDED with a single vote. The submitting script exits 2 rather than
 * failing, and the activity sits there until threshold-1 other root users approve it. This is how
 * they approve, which matters because a sub-org whose root users are API keys with no passkey cannot
 * approve through the Turnkey console at all: those users cannot log in.
 *
 * Which operations are gated, verified live against a 2-of-2 sub-org:
 *   - a user changing its OWN credentials completes on one vote at any threshold, so root self
 *     rotation (`rotate-api-key --target root`) never needs this;
 *   - changing ANOTHER user's credentials is gated, so `rotate-api-key --target agent`, create-api-key,
 *     apply-policies, delete-policies and delete-sub-org all can be.
 *
 * Approval takes the intent FINGERPRINT, not the activity id. The fingerprint is a digest of the
 * exact submitted request, so approving cannot ratify something other than what was submitted. Pass
 * `--activity <id>` and this resolves the fingerprint for you, and prints the intent so you can read
 * what you are about to approve.
 *
 * Stamp with a root key that has NOT already voted. Whether a key has voted is read from the
 * activity's votes, not from its `canApprove` flag: for one submitter on one activity that flag comes
 * back false on the submit response but true from get_activity and list_activities.
 *
 * Usage:
 *   # what is waiting?
 *   pnpm turnkey:approve-activity -- --sub-org <uuid> --list
 *
 *   # approve, resolving the fingerprint from the activity id (prints the intent first)
 *   pnpm turnkey:approve-activity -- --sub-org <uuid> --activity <activity-id> [--dry-run]
 *
 *   # approve a fingerprint directly
 *   pnpm turnkey:approve-activity -- --sub-org <uuid> --fingerprint sha256:<hex>
 *
 * Credentials default to TURNKEY_SUBORG_ROOT_API_* ; override the var names with
 * --api-public-key-env / --api-private-key-env when the approver is a different root user.
 */
import {
  approveActivity,
  approvedVoterIds,
  getActivity,
  getRootQuorum,
  listPendingActivities,
} from '../src/admin';
import {
  DEFAULT_API_URL,
  argParser,
  loadScriptEnv,
  makeClient,
  readEnv,
  subOrgCreds,
} from './_shared';

async function main() {
  loadScriptEnv();
  const args = argParser();

  const subOrg = args.required('sub-org');
  const list = args.flag('list');
  const activityId = args.get('activity');
  const fingerprintArg = args.get('fingerprint');
  const dryRun = args.flag('dry-run');
  const apiUrl = args.get('api-url') ?? DEFAULT_API_URL;

  if (!list && !activityId && !fingerprintArg) {
    throw new Error('Pass --list, or --activity <id>, or --fingerprint sha256:<hex>.');
  }
  if (activityId && fingerprintArg) {
    throw new Error('Pass --activity or --fingerprint, not both.');
  }

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

  const me = await client.whoami();
  const quorum = await getRootQuorum(client, subOrg);
  console.log(
    `\nsub-org ${subOrg}\nroot quorum ${quorum.threshold}-of-${quorum.userIds.length}` +
      `\napproving as ${me.userId}${quorum.userIds.includes(me.userId ?? '') ? '' : ' (NOT a root quorum member — a vote from this user will not count)'}`,
  );

  if (list) {
    const pending = await listPendingActivities(client, subOrg);
    if (pending.length === 0) {
      console.log('\nNothing waiting on consensus.');
      return;
    }
    console.log(`\n${pending.length} activity(ies) waiting on consensus:`);
    for (const a of pending) {
      // Unique approving users, not raw vote count: the threshold counts distinct approvers, and a
      // user that votes twice inflates `votes.length` without moving the activity forward.
      const approvers = approvedVoterIds(a);
      const names = (a.votes ?? [])
        .map((v) => `${v.user?.userName ?? v.userId}=${v.selection?.replace('VOTE_SELECTION_', '')}`)
        .join(', ');
      console.log(`\n  ${a.id}  ${a.type ?? '(unknown type)'}`);
      console.log(`    fingerprint: ${a.fingerprint ?? '(none)'}`);
      console.log(`    approvals: ${approvers.size}/${quorum.threshold}  (${names || 'none'})`);
      console.log(
        `    this key has already voted: ${me.userId && approvers.has(me.userId) ? 'yes' : 'no'}`,
      );
    }
    console.log('\nApprove one with:  --activity <id>');
    return;
  }

  let fingerprint = fingerprintArg;
  if (activityId) {
    const activity = await getActivity(client, subOrg, activityId);
    const approvers = approvedVoterIds(activity);
    console.log(`\nactivity ${activity.id}\n  type:   ${activity.type ?? '(unknown)'}`);
    console.log(`  status: ${activity.status}`);
    console.log(`  approvals: ${approvers.size}/${quorum.threshold}`);
    // Print the intent verbatim. Approving is ratifying THIS, so it should be readable first.
    console.log(`  intent: ${JSON.stringify((activity as { intent?: unknown }).intent ?? {}, null, 2)}`);

    if (activity.status !== 'ACTIVITY_STATUS_CONSENSUS_NEEDED') {
      throw new Error(
        `Refusing: activity ${activity.id} is ${activity.status}, not CONSENSUS_NEEDED. There is ` +
          'nothing to approve — it already completed, failed, or was rejected.',
      );
    }
    // Checked against the votes, not against `canApprove`: that field reads false on the submit
    // response and true from get_activity / list_activities for the same submitter, so trusting it
    // would let a duplicate vote through and burn a round trip on a no-op.
    if (me.userId && approvers.has(me.userId)) {
      throw new Error(
        `Refusing: this key (${me.userId}) has already approved ${activity.id}. A second vote from ` +
          'the same user does not move the activity forward, so stamp with a DIFFERENT root user via ' +
          '--api-public-key-env / --api-private-key-env.',
      );
    }
    if (!activity.fingerprint) {
      throw new Error(`Activity ${activity.id} carries no fingerprint, so it cannot be approved.`);
    }
    fingerprint = activity.fingerprint;
  }

  if (dryRun) {
    console.log(`\nDry run — nothing approved. Would approve fingerprint ${fingerprint}.`);
    return;
  }

  console.log(`\nApproving ${fingerprint}…`);
  const voted = await approveActivity(client, subOrg, fingerprint!);

  // A vote that counts but does not yet reach the threshold still leaves the activity
  // CONSENSUS_NEEDED, so the returned status is progress information, not success or failure.
  //
  // The re-read is best-effort: approving a DELETE_SUB_ORGANIZATION destroys the org this client is
  // scoped to, so the follow-up query 400s on an org that no longer exists. That is the approval
  // having worked, and it must not be reported as a failure.
  let after = voted;
  if (activityId) {
    try {
      after = await getActivity(client, subOrg, activityId);
    } catch (err) {
      console.log(
        `\nVote cast on ${activityId}. Could not re-read it afterwards, which is expected when the ` +
          'approved activity deletes the organization itself.',
      );
      console.log(`  (${err instanceof Error ? err.message.slice(0, 120) : err})`);
      return;
    }
  }
  const approvedBy = approvedVoterIds(after);
  console.log(
    `\nactivity ${after.id} is now ${after.status} (${approvedBy.size}/${quorum.threshold} approvals).`,
  );
  if (after.status === 'ACTIVITY_STATUS_CONSENSUS_NEEDED') {
    console.log(
      `Your vote counted but the threshold is not met. ${quorum.threshold - approvedBy.size} more ` +
        'root user(s) must approve, each with their own key.',
    );
  }
}

main().catch((err) => {
  console.error('approve-activity failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
