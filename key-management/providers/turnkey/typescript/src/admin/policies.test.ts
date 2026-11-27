import { describe, expect, it } from 'vitest';

import type { SigningPolicy } from '@atum-labs/km-core';

import {
  applyPolicies,
  derivePoliciesFromAllowlist,
  type PolicyDefinition,
  planPolicyChanges,
  TURNKEY_MAX_POLICIES,
} from './policies';

const BASE: SigningPolicy = { requireChainIdMatch: true, maxNativeValue: '0' };
const SELF = '0xE85c89453dd46c95909a0a15e265f9b84A6378D6';

function selfSend(policies: PolicyDefinition[]) {
  return policies.find((p) => p.policyName.startsWith('allowSelfSendNonceBurn'));
}

describe('derivePoliciesFromAllowlist — self-send nonce-burn ALLOW', () => {
  it('emits the ALLOW for EVM when selfAddress is set', () => {
    const out = derivePoliciesFromAllowlist(BASE, 'evm', {
      chainId: 'eip155:42161',
      selfAddress: SELF,
    });
    const p = selfSend(out);
    expect(p).toBeDefined();
    expect(p!.policyName).toBe('allowSelfSendNonceBurn (eip155:42161)');
    expect(p!.effect).toBe('EFFECT_ALLOW');
    expect(p!.condition).toContain("activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2'");
    expect(p!.condition).toContain('eth.tx.chain_id == 42161');
    expect(p!.condition).toContain("eth.tx.type == 'TYPE_2'");
    expect(p!.condition).toContain('eth.tx.value == 0');
    expect(p!.condition).toContain('eth.tx.gas == 21000');
  });

  it('lowercases the self address in the condition', () => {
    const out = derivePoliciesFromAllowlist(BASE, 'evm', {
      chainId: 'eip155:1',
      selfAddress: SELF,
    });
    expect(selfSend(out)!.condition).toContain(`eth.tx.to == '${SELF.toLowerCase()}'`);
    expect(selfSend(out)!.condition).not.toContain(SELF); // not the mixed-case form
  });

  it('omits the ALLOW for EVM when selfAddress is absent', () => {
    const out = derivePoliciesFromAllowlist(BASE, 'evm', { chainId: 'eip155:1' });
    expect(selfSend(out)).toBeUndefined();
  });

  it('never emits the ALLOW for non-EVM chains even with selfAddress', () => {
    for (const chain of ['tron', 'solana'] as const) {
      const out = derivePoliciesFromAllowlist(BASE, chain, {
        chainId: chain === 'tron' ? 'tron:mainnet' : 'solana:mainnet',
        selfAddress: SELF,
      });
      expect(selfSend(out)).toBeUndefined();
    }
  });

  it('is additive — existing EVM policies are unchanged when the ALLOW is present', () => {
    const policy: SigningPolicy = {
      requireChainIdMatch: true,
      maxNativeValue: '0',
      allowedTo: ['0x000000000022d473030f116ddee9f6b43ac78ba3'],
    };
    const withSelf = derivePoliciesFromAllowlist(policy, 'evm', {
      chainId: 'eip155:1',
      selfAddress: SELF,
    });
    const withoutSelf = derivePoliciesFromAllowlist(policy, 'evm', { chainId: 'eip155:1' });
    // Every policy from the no-self run is present verbatim in the with-self run.
    for (const base of withoutSelf) {
      expect(withSelf).toContainEqual(base);
    }
    // The with-self run adds exactly one policy: the self-send ALLOW.
    expect(withSelf.length).toBe(withoutSelf.length + 1);
    expect(selfSend(withSelf)).toBeDefined();
  });
});

describe('planPolicyChanges', () => {
  const live = (policyName: string, condition = 'a == 1', effect = 'EFFECT_ALLOW') =>
    ({ policyId: `id-${policyName}`, policyName, effect, condition, notes: '' }) as never;
  const emit = (policyName: string, condition = 'a == 1', effect = 'EFFECT_ALLOW') =>
    ({ policyName, effect, condition }) as never;

  it('reports nothing when the live set already matches', () => {
    const plan = planPolicyChanges([live('allowX')], [emit('allowX')]);
    expect(plan.drifted).toEqual([]);
    expect(plan.stale).toEqual([]);
  });

  it('reports a live policy the emitted set no longer contains', () => {
    // The case the reconciliation exists for: a retired broad ALLOW keeps granting what it always
    // granted, so a narrower replacement does not take effect until it is gone.
    const plan = planPolicyChanges(
      [live('allowSignRawPayload'), live('allowPermit2DepositTypedData (eip155:8453)')],
      [emit('allowPermit2DepositTypedData (eip155:8453)')],
    );
    expect(plan.stale.map((p) => p.policyName)).toEqual(['allowSignRawPayload']);
    expect(plan.drifted).toEqual([]);
  });

  it('reports a same-named policy whose condition changed, and does not call it stale', () => {
    const plan = planPolicyChanges([live('allowX', 'a == 1')], [emit('allowX', 'a == 2')]);
    expect(plan.drifted.map((d) => d.name)).toEqual(['allowX']);
    expect(plan.stale).toEqual([]);
  });

  it('treats an effect flip as drift, since an ALLOW turned DENY keeps its name', () => {
    const plan = planPolicyChanges(
      [live('guard', 'a == 1', 'EFFECT_ALLOW')],
      [emit('guard', 'a == 1', 'EFFECT_DENY')],
    );
    expect(plan.drifted.map((d) => d.name)).toEqual(['guard']);
  });

  it('counts a renamed policy as both a creation and a stale one', () => {
    // A rename is indistinguishable from retire-plus-add by name alone, which is why the stale
    // side has to be reported rather than silently ignored.
    const plan = planPolicyChanges([live('oldName')], [emit('newName')]);
    expect(plan.stale.map((p) => p.policyName)).toEqual(['oldName']);
    expect(plan.drifted).toEqual([]);
  });

  it('reports a temporary copy of any emitted policy as a leftover, not as stale', () => {
    const plan = planPolicyChanges(
      [
        live('denyX [replacing]', 'a == 1', 'EFFECT_DENY'),
        live('allowX [replacing]'),
        live('allowGone [replacing]'),
      ],
      [emit('denyX', 'a == 1', 'EFFECT_DENY'), emit('allowX')],
    );
    expect(plan.leftovers.map((p) => p.policyName)).toEqual(['denyX [replacing]', 'allowX [replacing]']);
    // A temporary copy whose policy is no longer emitted is just stale.
    expect(plan.stale.map((p) => p.policyName)).toEqual(['allowGone [replacing]']);
  });

  it('is pure, so a dry run can call it without writing', () => {
    const existing = [live('allowX')];
    const emitted = [emit('allowY')];
    const before = JSON.stringify({ existing, emitted });
    planPolicyChanges(existing, emitted);
    expect(JSON.stringify({ existing, emitted })).toBe(before);
  });
});

describe('applyPolicies refuses before it writes', () => {
  // The regression this guards: the refusals used to happen AFTER the create loop, and with
  // `prune` after the delete loop too, so a run that ended in an error had already changed the
  // sub-org in both directions. planPolicyChanges alone cannot pin that — only the call order can.
  const summary = (policyName: string, condition = 'a == 1') => ({
    policyId: `id-${policyName}`,
    policyName,
    effect: 'EFFECT_ALLOW',
    condition,
    notes: '',
  });

  const fakeClient = (existing: ReturnType<typeof summary>[]) => {
    const calls: string[] = [];
    return {
      calls,
      client: {
        query: async () => ({ policies: existing }),
        executeActivity: async (activityType: string, _endpoint: string, params: never) => {
          calls.push(activityType);
          const p = params as { policyName?: string };
          return { createPolicyResult: { policyId: `new-${p.policyName ?? 'x'}` } };
        },
      } as never,
    };
  };

  const emitted = [
    { policyName: 'allowNew', effect: 'EFFECT_ALLOW', condition: 'b == 2' } as never,
  ];

  it('creates nothing when a live policy is absent from the emitted set and prune is off', async () => {
    const { calls, client } = fakeClient([summary('allowRetiredBroad')]);
    await expect(
      applyPolicies(client, emitted, { organizationId: 'org' }),
    ).rejects.toThrow(/absent from the emitted set/);
    expect(calls).toEqual([]);
  });

  it('creates nothing when a policy drifted and update is off', async () => {
    const { calls, client } = fakeClient([summary('allowNew', 'a == 999')]);
    await expect(
      applyPolicies(client, emitted, { organizationId: 'org' }),
    ).rejects.toThrow(/Content drift detected/);
    expect(calls).toEqual([]);
  });

  it('deletes nothing when prune is set but a drifted policy still blocks the run', async () => {
    // The worst of the old order: prune deleted live policies and only then threw on drift.
    const { calls, client } = fakeClient([
      summary('allowNew', 'a == 999'),
      summary('allowRetiredBroad'),
    ]);
    await expect(
      applyPolicies(client, emitted, { organizationId: 'org', prune: true }),
    ).rejects.toThrow(/Content drift detected/);
    expect(calls).toEqual([]);
  });

  it('on a clean prune run, creates before it deletes so the narrow allow is live first', async () => {
    const { calls, client } = fakeClient([summary('allowRetiredBroad')]);
    const res = await applyPolicies(client, emitted, { organizationId: 'org', prune: true });
    expect(calls).toEqual(['ACTIVITY_TYPE_CREATE_POLICY_V3', 'ACTIVITY_TYPE_DELETE_POLICY']);
    expect(res.pruned.map((p) => p.name)).toEqual(['allowRetiredBroad']);
  });
});

describe('applyPolicies replaces a drifted policy without a window', () => {
  // Turnkey has no in-place update, so a drifted policy is a delete plus a create. Deleting a DENY
  // first leaves a window in which nothing forbids what it fenced. Deleting an ALLOW first refuses
  // live signatures, and the settler treats a refused signature as terminal. So every effect keeps a
  // copy live at every step.
  const summary = (policyName: string, effect: string, condition: string) => ({
    policyId: `id-${policyName}`,
    policyName,
    effect,
    condition,
    notes: '',
  });

  const fakeClient = (existing: ReturnType<typeof summary>[]) => {
    const calls: Array<{ activityType: string; params: Record<string, unknown> }> = [];
    return {
      calls,
      client: {
        query: async () => ({ policies: existing }),
        executeActivity: async (activityType: string, _endpoint: string, params: never) => {
          calls.push({ activityType, params: params as Record<string, unknown> });
          const p = params as { policyName?: string };
          return { createPolicyResult: { policyId: `new-${p.policyName ?? 'x'}` } };
        },
      } as never,
    };
  };

  // Turnkey requires unique policy names, so the new copy cannot go live under the old one's name
  // while the old one exists: it goes live under a temporary name first.
  it('keeps a copy of a drifted DENY live at every step, through a temporary name', async () => {
    const { calls, client } = fakeClient([summary('denyX', 'EFFECT_DENY', 'a == 1')]);
    const res = await applyPolicies(
      client,
      [{ policyName: 'denyX', effect: 'EFFECT_DENY', condition: 'a == 2' } as never],
      { organizationId: 'org', update: true },
    );
    expect(calls.map((c) => c.activityType)).toEqual([
      'ACTIVITY_TYPE_CREATE_POLICY_V3',
      'ACTIVITY_TYPE_DELETE_POLICY',
      'ACTIVITY_TYPE_CREATE_POLICY_V3',
      'ACTIVITY_TYPE_DELETE_POLICY',
    ]);
    expect(calls[0]!.params).toMatchObject({
      policyName: 'denyX [replacing]',
      effect: 'EFFECT_DENY',
      condition: 'a == 2',
    });
    expect(calls[1]!.params).toEqual({ policyId: 'id-denyX' });
    expect(calls[2]!.params).toMatchObject({ policyName: 'denyX', effect: 'EFFECT_DENY', condition: 'a == 2' });
    expect(calls[3]!.params).toEqual({ policyId: 'new-denyX [replacing]' });
    expect(res.replaced).toEqual([{ name: 'denyX', oldPolicyId: 'id-denyX', newPolicyId: 'new-denyX' }]);
  });

  // An interrupted replacement stops in one of three states. Each must recover through apply alone,
  // with some copy of the DENY live at every step.
  const emittedDenyX = [{ policyName: 'denyX', effect: 'EFFECT_DENY', condition: 'a == 2' } as never];

  it('stopped after the temporary create: deletes that copy while the old one is live, then replaces', async () => {
    const { calls, client } = fakeClient([
      summary('denyX', 'EFFECT_DENY', 'a == 1'),
      summary('denyX [replacing]', 'EFFECT_DENY', 'a == 2'),
    ]);
    const res = await applyPolicies(client, emittedDenyX, { organizationId: 'org', update: true });
    expect(calls.map((c) => [c.activityType, c.params.policyId ?? c.params.policyName])).toEqual([
      ['ACTIVITY_TYPE_DELETE_POLICY', 'id-denyX [replacing]'],
      ['ACTIVITY_TYPE_CREATE_POLICY_V3', 'denyX [replacing]'],
      ['ACTIVITY_TYPE_DELETE_POLICY', 'id-denyX'],
      ['ACTIVITY_TYPE_CREATE_POLICY_V3', 'denyX'],
      ['ACTIVITY_TYPE_DELETE_POLICY', 'new-denyX [replacing]'],
    ]);
    expect(res.clearedLeftovers).toEqual([{ name: 'denyX [replacing]', policyId: 'id-denyX [replacing]' }]);
  });

  it('stopped after deleting the old copy: creates the real copy before deleting the temporary one', async () => {
    const { calls, client } = fakeClient([summary('denyX [replacing]', 'EFFECT_DENY', 'a == 2')]);
    // No --prune and no --update: the temporary copy is not stale, and nothing drifted.
    const res = await applyPolicies(client, emittedDenyX, { organizationId: 'org' });
    expect(calls.map((c) => [c.activityType, c.params.policyId ?? c.params.policyName])).toEqual([
      ['ACTIVITY_TYPE_CREATE_POLICY_V3', 'denyX'],
      ['ACTIVITY_TYPE_DELETE_POLICY', 'id-denyX [replacing]'],
    ]);
    expect(res.pruned).toEqual([]);
    expect(res.clearedLeftovers).toEqual([{ name: 'denyX [replacing]', policyId: 'id-denyX [replacing]' }]);
  });

  it('stopped after creating the real copy: deletes only the temporary one', async () => {
    const { calls, client } = fakeClient([
      summary('denyX', 'EFFECT_DENY', 'a == 2'),
      summary('denyX [replacing]', 'EFFECT_DENY', 'a == 2'),
    ]);
    const res = await applyPolicies(client, emittedDenyX, { organizationId: 'org' });
    expect(calls.map((c) => [c.activityType, c.params.policyId ?? c.params.policyName])).toEqual([
      ['ACTIVITY_TYPE_DELETE_POLICY', 'id-denyX [replacing]'],
    ]);
    expect(res.skippedUnchanged).toEqual(['denyX']);
  });

  it('treats a temporary copy whose DENY is no longer emitted as stale', async () => {
    const { calls, client } = fakeClient([summary('denyGone [replacing]', 'EFFECT_DENY', 'a == 1')]);
    await expect(applyPolicies(client, emittedDenyX, { organizationId: 'org' })).rejects.toThrow(
      /absent from the emitted set/,
    );
    expect(calls).toEqual([]);
  });

  it('keeps a copy of a drifted ALLOW live at every step, through a temporary name', async () => {
    const { calls, client } = fakeClient([summary('allowX', 'EFFECT_ALLOW', 'a == 1')]);
    const res = await applyPolicies(
      client,
      [{ policyName: 'allowX', effect: 'EFFECT_ALLOW', condition: 'a == 2' } as never],
      { organizationId: 'org', update: true },
    );
    expect(calls.map((c) => [c.activityType, c.params.policyId ?? c.params.policyName])).toEqual([
      ['ACTIVITY_TYPE_CREATE_POLICY_V3', 'allowX [replacing]'],
      ['ACTIVITY_TYPE_DELETE_POLICY', 'id-allowX'],
      ['ACTIVITY_TYPE_CREATE_POLICY_V3', 'allowX'],
      ['ACTIVITY_TYPE_DELETE_POLICY', 'new-allowX [replacing]'],
    ]);
    expect(calls[0]!.params).toMatchObject({ effect: 'EFFECT_ALLOW', condition: 'a == 2' });
    expect(res.replaced).toEqual([{ name: 'allowX', oldPolicyId: 'id-allowX', newPolicyId: 'new-allowX' }]);
  });

  it('recovers an interrupted ALLOW replacement without a flag, keeping an ALLOW live', async () => {
    const { calls, client } = fakeClient([summary('allowX [replacing]', 'EFFECT_ALLOW', 'a == 2')]);
    const res = await applyPolicies(
      client,
      [{ policyName: 'allowX', effect: 'EFFECT_ALLOW', condition: 'a == 2' } as never],
      { organizationId: 'org' },
    );
    expect(calls.map((c) => [c.activityType, c.params.policyId ?? c.params.policyName])).toEqual([
      ['ACTIVITY_TYPE_CREATE_POLICY_V3', 'allowX'],
      ['ACTIVITY_TYPE_DELETE_POLICY', 'id-allowX [replacing]'],
    ]);
    expect(res.clearedLeftovers).toEqual([{ name: 'allowX [replacing]', policyId: 'id-allowX [replacing]' }]);
  });
});

describe('applyPolicies refuses a live set holding duplicate names', () => {
  // A live set can hold two copies of one name. Keying the live set by name silently drops one
  // copy; whichever survives decides whether the run sees drift, and the other — possibly a stale
  // DENY or a broad ALLOW — is never reconciled. An emitted name is the run's responsibility, so it must refuse
  // before writing anything rather than guess which copy is authoritative.
  const live = (policyId: string, policyName: string, effect: string, condition: string) => ({
    policyId,
    policyName,
    effect,
    condition,
    notes: '',
  });

  const fakeClient = (existing: ReturnType<typeof live>[]) => {
    const calls: Array<{ activityType: string; params: Record<string, unknown> }> = [];
    return {
      calls,
      client: {
        query: async () => ({ policies: existing }),
        executeActivity: async (activityType: string, _endpoint: string, params: never) => {
          calls.push({ activityType, params: params as Record<string, unknown> });
          const p = params as { policyName?: string };
          return { createPolicyResult: { policyId: `new-${p.policyName ?? 'x'}` } };
        },
      } as never,
    };
  };

  const emittedDeny = [
    { policyName: 'denyX', effect: 'EFFECT_DENY', condition: 'a == 2', notes: '' } as never,
  ];

  const rejection = async (p: Promise<unknown>): Promise<Error> => {
    const outcome = await p.then(
      () => ({ ok: true as const }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.e).toBeInstanceOf(Error);
    return outcome.e as Error;
  };

  const options = [
    { label: 'no flags', opts: {} },
    { label: 'update', opts: { update: true } },
    { label: 'prune', opts: { prune: true } },
    { label: 'update and prune', opts: { update: true, prune: true } },
  ];

  for (const { label, opts } of options) {
    it(`refuses before any write when an emitted name has two live copies (${label})`, async () => {
      const { calls, client } = fakeClient([
        live('id-deny-old', 'denyX', 'EFFECT_DENY', 'a == 1'),
        live('id-deny-new', 'denyX', 'EFFECT_DENY', 'a == 3'),
      ]);
      const err = await rejection(
        applyPolicies(client, emittedDeny, { organizationId: 'org', ...opts }),
      );
      expect(err.message).toContain('denyX');
      expect(err.message).toContain('id-deny-old');
      expect(err.message).toContain('id-deny-new');
      expect(calls).toEqual([]);
    });

    it(`refuses even when one live copy matches the emitted definition exactly (${label})`, async () => {
      // Listed last so a last-wins by-name lookup keeps the matching copy, reports "in sync", and
      // never sees the stray one.
      const { calls, client } = fakeClient([
        live('id-deny-stray', 'denyX', 'EFFECT_DENY', 'a == 1'),
        live('id-deny-match', 'denyX', 'EFFECT_DENY', 'a == 2'),
      ]);
      const err = await rejection(
        applyPolicies(client, emittedDeny, { organizationId: 'org', ...opts }),
      );
      expect(err.message).toContain('denyX');
      expect(err.message).toContain('id-deny-match');
      expect(err.message).toContain('id-deny-stray');
      expect(calls).toEqual([]);
    });
  }

  it('prunes both copies of a duplicated name the emitted set no longer emits', async () => {
    // A stale name is going away regardless, so duplicates there are not ambiguous: delete both.
    const { calls, client } = fakeClient([
      live('id-stale-a', 'allowRetiredBroad', 'EFFECT_ALLOW', 'a == 1'),
      live('id-stale-b', 'allowRetiredBroad', 'EFFECT_ALLOW', 'a == 1'),
    ]);
    const res = await applyPolicies(
      client,
      [{ policyName: 'allowNew', effect: 'EFFECT_ALLOW', condition: 'b == 2' } as never],
      { organizationId: 'org', prune: true },
    );
    expect(calls.map((c) => c.activityType)).toEqual([
      'ACTIVITY_TYPE_CREATE_POLICY_V3',
      'ACTIVITY_TYPE_DELETE_POLICY',
      'ACTIVITY_TYPE_DELETE_POLICY',
    ]);
    expect(calls.slice(1).map((c) => c.params.policyId).sort()).toEqual(['id-stale-a', 'id-stale-b']);
    expect(res.pruned.map((p) => p.name)).toEqual(['allowRetiredBroad', 'allowRetiredBroad']);
  });

  it('without prune, duplicated stale names still hit the ordinary stale refusal before any write', async () => {
    const { calls, client } = fakeClient([
      live('id-stale-a', 'allowRetiredBroad', 'EFFECT_ALLOW', 'a == 1'),
      live('id-stale-b', 'allowRetiredBroad', 'EFFECT_ALLOW', 'a == 1'),
    ]);
    await expect(
      applyPolicies(
        client,
        [{ policyName: 'allowNew', effect: 'EFFECT_ALLOW', condition: 'b == 2' } as never],
        { organizationId: 'org' },
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('policy count ceiling', () => {
  const live = (policyName: string, condition = 'a == 1') =>
    ({ policyId: `id-${policyName}`, policyName, effect: 'EFFECT_ALLOW', condition, notes: '' }) as never;
  const emit = (policyName: string, condition = 'a == 1') =>
    ({ policyName, effect: 'EFFECT_ALLOW', condition }) as never;
  const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

  // A client whose live set tracks creates and deletes, recording the most policies ever live.
  const countingClient = (existing: ReturnType<typeof live>[]) => {
    let size = (existing as unknown[]).length;
    const state = { max: size, writes: 0 };
    const client = {
      query: async () => ({ policies: existing }),
      executeActivity: async (activityType: string, _e: string, params: { policyName?: string }) => {
        state.writes++;
        size += activityType === 'ACTIVITY_TYPE_DELETE_POLICY' ? -1 : 1;
        state.max = Math.max(state.max, size);
        return { createPolicyResult: { policyId: `new-${params.policyName ?? 'x'}` } };
      },
    } as never;
    return { client, state };
  };

  it.each([
    ['nothing to write', [live('a'), live('b')], [emit('a'), emit('b')], 2],
    ['two creates', [live('a')], [emit('a'), emit('n1'), emit('n2')], 3],
    ['one replacement holds its temporary copy', [live('a')], [emit('a', 'a == 2')], 2],
    ['a replacement clears its own leftover first', [live('a'), live('a [replacing]')], [emit('a', 'a == 2')], 2],
    ['an unrelated leftover stays until the end', [live('a'), live('b [replacing]')], [emit('a', 'a == 2'), emit('b')], 3],
    ['stale policies are deleted last, so they count', [live('old'), live('a')], [emit('n'), emit('a', 'a == 2')], 4],
    ['an orphan leftover of a new name stays until the end', [live('x [replacing]')], [emit('x')], 2],
    ['creates before a replacement raise its peak', [live('z')], [emit('n'), emit('z', 'a == 2')], 3],
  ])('%s', async (_name, existing, emitted, peak) => {
    expect(planPolicyChanges(existing, emitted).peakCount).toBe(peak);
    // The computed peak is the real one: replay the apply against a counting client.
    const { client, state } = countingClient(existing);
    await applyPolicies(client, emitted, { organizationId: 'org', update: true, prune: true });
    expect(state.max).toBe(peak);
  });

  it('refuses before writing anything when the run would pass the limit', async () => {
    const existing = many(TURNKEY_MAX_POLICIES - 1, 'p').map((n) => live(n));
    // The create lands first, so the first replacement's temporary copy is the 101st policy.
    const emitted = [emit('new'), ...many(TURNKEY_MAX_POLICIES - 1, 'p').map((n) => emit(n, 'a == 2'))];
    const { client, state } = countingClient(existing);
    await expect(applyPolicies(client, emitted, { organizationId: 'org', update: true })).rejects.toThrow(
      /up to 101 policies at once \(99 live now\).*Free 1 slot/s,
    );
    expect(state.writes).toBe(0);
  });

  it('allows a run that peaks exactly at the limit', async () => {
    const existing = many(TURNKEY_MAX_POLICIES - 1, 'p').map((n) => live(n));
    const emitted = [...many(TURNKEY_MAX_POLICIES - 1, 'p').map((n) => emit(n)), emit('new')];
    const { client, state } = countingClient(existing);
    await applyPolicies(client, emitted, { organizationId: 'org' });
    expect(state.max).toBe(TURNKEY_MAX_POLICIES);
  });
});
