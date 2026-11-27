import { describe, expect, it, vi } from 'vitest';

import { approveActivity, approvedVoterIds, getRootQuorum, listPendingActivities } from './activities';
import type { TurnkeyClient } from '../client';
import type { TurnkeyActivity } from '../types';

function fakeClient(over: { query?: ReturnType<typeof vi.fn> }): TurnkeyClient {
  return { query: over.query ?? vi.fn(), executeActivity: vi.fn() } as unknown as TurnkeyClient;
}

describe('approvedVoterIds', () => {
  // The flag this replaces is not trustworthy: for one submitter on one activity, canApprove comes
  // back false on the submit response and true from get_activity and list_activities.
  it('counts distinct approvers and ignores canApprove entirely', () => {
    const activity: TurnkeyActivity = {
      id: 'a1',
      status: 'ACTIVITY_STATUS_CONSENSUS_NEEDED',
      canApprove: true,
      votes: [
        { userId: 'u1', selection: 'VOTE_SELECTION_APPROVED' },
        { userId: 'u1', selection: 'VOTE_SELECTION_APPROVED' },
      ],
    };
    const ids = approvedVoterIds(activity);
    expect(ids.size).toBe(1);
    expect(ids.has('u1')).toBe(true);
  });

  it('excludes rejections, so a reject never reads as progress toward the threshold', () => {
    const activity: TurnkeyActivity = {
      id: 'a1',
      status: 'ACTIVITY_STATUS_CONSENSUS_NEEDED',
      votes: [
        { userId: 'u1', selection: 'VOTE_SELECTION_APPROVED' },
        { userId: 'u2', selection: 'VOTE_SELECTION_REJECTED' },
      ],
    };
    expect([...approvedVoterIds(activity)]).toEqual(['u1']);
  });

  it('handles an activity with no votes', () => {
    expect(approvedVoterIds({ id: 'a1', status: 'x' }).size).toBe(0);
  });
});

describe('approveActivity', () => {
  it('submits the fingerprint and returns the voted-on activity verbatim', async () => {
    const query = vi.fn().mockResolvedValue({
      activity: { id: 'a1', status: 'ACTIVITY_STATUS_CONSENSUS_NEEDED' },
    });
    const out = await approveActivity(fakeClient({ query }), 'org-1', 'sha256:abc');

    expect(query).toHaveBeenCalledWith('/public/v1/submit/approve_activity', {
      type: 'ACTIVITY_TYPE_APPROVE_ACTIVITY',
      timestampMs: expect.any(String),
      organizationId: 'org-1',
      parameters: { fingerprint: 'sha256:abc' },
    });
    // A vote that counts but does not reach the threshold still reads CONSENSUS_NEEDED. Routing this
    // through executeActivity would throw on a vote that in fact succeeded.
    expect(out.status).toBe('ACTIVITY_STATUS_CONSENSUS_NEEDED');
  });

  it('throws when the response carries no activity', async () => {
    const query = vi.fn().mockResolvedValue({});
    await expect(approveActivity(fakeClient({ query }), 'org-1', 'sha256:abc')).rejects.toThrow(
      /no activity/,
    );
  });
});

describe('getRootQuorum', () => {
  it('reads threshold and members from organizationData', async () => {
    const query = vi.fn().mockResolvedValue({
      organizationData: { rootQuorum: { threshold: 2, userIds: ['u1', 'u2'] } },
    });
    const q = await getRootQuorum(fakeClient({ query }), 'org-1');
    expect(q).toEqual({ threshold: 2, userIds: ['u1', 'u2'] });
  });

  it('throws rather than assuming a threshold when the shape is missing', async () => {
    const query = vi.fn().mockResolvedValue({ organizationData: {} });
    await expect(getRootQuorum(fakeClient({ query }), 'org-1')).rejects.toThrow(/rootQuorum.threshold/);
  });
});

describe('listPendingActivities', () => {
  it('filters server-side on CONSENSUS_NEEDED', async () => {
    const query = vi.fn().mockResolvedValue({ activities: [{ id: 'a1', status: 'x' }] });
    const out = await listPendingActivities(fakeClient({ query }), 'org-1');
    expect(query).toHaveBeenCalledWith('/public/v1/query/list_activities', {
      organizationId: 'org-1',
      filterByStatus: ['ACTIVITY_STATUS_CONSENSUS_NEEDED'],
    });
    expect(out).toHaveLength(1);
  });

  it('returns empty when the org reports none', async () => {
    expect(await listPendingActivities(fakeClient({ query: vi.fn().mockResolvedValue({}) }), 'o')).toEqual([]);
  });
});
