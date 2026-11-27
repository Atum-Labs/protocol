// Consensus handling for a sub-org whose root quorum threshold is above 1. An activity submitted by
// one root user comes back ACTIVITY_STATUS_CONSENSUS_NEEDED with a single vote, and stays that way
// until enough other root users approve it.
//
// The rule that decides whether any of this applies, verified live against a 2-of-2 sub-org:
//
//   - a user changing its OWN credentials (add or delete its own API keys) completes on one vote,
//     with no quorum approval at any threshold;
//   - changing ANOTHER user's credentials needs threshold-1 further approvals.
//
// So root self-rotation is quorum-independent, while rotating the agent's key (root editing a
// different user) is gated. Approving is NOT done with the activity id: APPROVE_ACTIVITY takes the
// intent `fingerprint`, which is a digest of the exact request, so an approver cannot be tricked
// into ratifying something other than what was submitted.

import type { TurnkeyClient } from '../client';
import type { TurnkeyActivity } from '../types';

export interface RootQuorum {
  readonly threshold: number;
  readonly userIds: readonly string[];
}

/**
 * Read the org's root quorum. Useful before a cross-user credential change, so tooling can say up
 * front how many approvals the operator is about to need.
 */
export async function getRootQuorum(
  client: TurnkeyClient,
  organizationId: string,
): Promise<RootQuorum> {
  const r = await client.query<{
    organizationData?: { rootQuorum?: { threshold?: number; userIds?: string[] } };
  }>('/public/v1/query/get_organization', { organizationId });
  const q = r.organizationData?.rootQuorum;
  if (typeof q?.threshold !== 'number') {
    throw new Error(
      `get_organization on ${organizationId} returned no rootQuorum.threshold: ${JSON.stringify(r).slice(0, 200)}`,
    );
  }
  return { threshold: q.threshold, userIds: q.userIds ?? [] };
}

export async function getActivity(
  client: TurnkeyClient,
  organizationId: string,
  activityId: string,
): Promise<TurnkeyActivity> {
  const r = await client.query<{ activity?: TurnkeyActivity }>('/public/v1/query/get_activity', {
    organizationId,
    activityId,
  });
  if (!r.activity?.id) {
    throw new Error(`get_activity returned no activity for ${activityId} in ${organizationId}`);
  }
  return r.activity;
}

/** Activities waiting on more approvals. Reading this before submitting avoids queueing a duplicate
 * of something already pending, which a `get_user` read cannot reveal: pending activities have not
 * applied yet, so the user still looks untouched. */
export async function listPendingActivities(
  client: TurnkeyClient,
  organizationId: string,
): Promise<readonly TurnkeyActivity[]> {
  const r = await client.query<{ activities?: TurnkeyActivity[] }>(
    '/public/v1/query/list_activities',
    { organizationId, filterByStatus: ['ACTIVITY_STATUS_CONSENSUS_NEEDED'] },
  );
  return r.activities ?? [];
}

/**
 * Users who have already cast an APPROVED vote. This is the reliable way to tell whether a given key
 * can still move an activity forward.
 *
 * Do NOT use the activity's `canApprove` for that: for one submitter on one activity it comes back
 * `false` on the submit response but `true` from both `get_activity` and `list_activities`, so a
 * query-side read of it says a duplicate vote is allowed when it is not.
 */
export function approvedVoterIds(activity: TurnkeyActivity): ReadonlySet<string> {
  const ids = (activity.votes ?? [])
    .filter((v) => v.selection === 'VOTE_SELECTION_APPROVED')
    .map((v) => v.userId)
    .filter((id): id is string => Boolean(id));
  return new Set(ids);
}

/**
 * Cast an approving vote on a pending activity. `fingerprint` comes from the pending activity
 * (`activity.fingerprint`, a `sha256:…` digest of the intent), NOT from its id. Must be stamped by a
 * root user that has not already voted.
 *
 * Deliberately NOT routed through `executeActivity`, which treats anything other than COMPLETED as a
 * failure. The response here carries the status of the activity being voted on, so on a threshold
 * above 2 an approval that legitimately counts but does not yet reach quorum still reads
 * CONSENSUS_NEEDED, and `executeActivity` would throw on a vote that in fact succeeded. The caller
 * inspects the returned status instead.
 */
export async function approveActivity(
  client: TurnkeyClient,
  organizationId: string,
  fingerprint: string,
): Promise<TurnkeyActivity> {
  const r = await client.query<{ activity?: TurnkeyActivity }>(
    '/public/v1/submit/approve_activity',
    {
      type: 'ACTIVITY_TYPE_APPROVE_ACTIVITY',
      timestampMs: String(Date.now()),
      organizationId,
      parameters: { fingerprint },
    },
  );
  if (!r.activity) {
    throw new Error(`approve_activity returned no activity for ${fingerprint}`);
  }
  return r.activity;
}
