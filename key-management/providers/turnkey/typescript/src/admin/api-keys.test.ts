import { describe, expect, it, vi } from 'vitest';

import {
  addApiKeys,
  deleteApiKeys,
  findApiKeyByPublicKey,
  getUser,
  isDurableApiKey,
  isExpiredApiKey,
  listUsers,
  planRevocation,
  type TurnkeyUserSummary,
} from './api-keys';
import type { TurnkeyClient } from '../client';

const PUB_OLD = '02aaaaBBBBccccdddd1111222233334444555566667777888899990000aaaabbbb';
const PUB_NEW = '03ffffeeeeddddcccc9999888877776666555544443333222211110000ffffeeee';

function fakeClient(overrides: {
  executeActivity?: ReturnType<typeof vi.fn>;
  query?: ReturnType<typeof vi.fn>;
}): TurnkeyClient {
  return {
    executeActivity: overrides.executeActivity ?? vi.fn(),
    query: overrides.query ?? vi.fn(),
  } as unknown as TurnkeyClient;
}

const USER: TurnkeyUserSummary = {
  userId: 'user-1',
  userName: 'settler-agent',
  apiKeys: [
    { apiKeyId: 'key-old', apiKeyName: 'primary', credential: { publicKey: PUB_OLD } },
    { apiKeyId: 'key-new', apiKeyName: 'settler-agent-20260804', credential: { publicKey: PUB_NEW } },
  ],
  authenticators: [],
};

describe('addApiKeys', () => {
  it('submits CREATE_API_KEYS_V2 with a default P-256 curve and no expiry', async () => {
    const executeActivity = vi.fn().mockResolvedValue({
      createApiKeysResult: { apiKeyIds: ['key-new'] },
    });
    const ids = await addApiKeys(fakeClient({ executeActivity }), {
      userId: 'user-1',
      apiKeys: [{ apiKeyName: 'settler-agent-20260804', publicKey: PUB_NEW }],
    });

    expect(ids).toEqual(['key-new']);
    expect(executeActivity).toHaveBeenCalledWith(
      'ACTIVITY_TYPE_CREATE_API_KEYS_V2',
      'create_api_keys',
      {
        userId: 'user-1',
        apiKeys: [
          {
            apiKeyName: 'settler-agent-20260804',
            publicKey: PUB_NEW,
            curveType: 'API_KEY_CURVE_P256',
          },
        ],
      },
    );
  });

  it('passes expirationSeconds through only when given', async () => {
    const executeActivity = vi.fn().mockResolvedValue({
      createApiKeysResult: { apiKeyIds: ['key-tmp'] },
    });
    await addApiKeys(fakeClient({ executeActivity }), {
      userId: 'user-1',
      apiKeys: [{ apiKeyName: 'standby', publicKey: PUB_NEW, expirationSeconds: '7776000' }],
    });
    const params = executeActivity.mock.calls[0]![2] as { apiKeys: Array<Record<string, unknown>> };
    expect(params.apiKeys[0]!.expirationSeconds).toBe('7776000');
  });

  it('throws when Turnkey completes without returning an apiKeyId', async () => {
    const executeActivity = vi.fn().mockResolvedValue({ createApiKeysResult: {} });
    await expect(
      addApiKeys(fakeClient({ executeActivity }), {
        userId: 'user-1',
        apiKeys: [{ apiKeyName: 'x', publicKey: PUB_NEW }],
      }),
    ).rejects.toThrow(/no apiKeyIds/);
  });

  it('refuses an empty key list rather than submitting a no-op activity', async () => {
    const executeActivity = vi.fn();
    await expect(
      addApiKeys(fakeClient({ executeActivity }), { userId: 'user-1', apiKeys: [] }),
    ).rejects.toThrow(/no keys/);
    expect(executeActivity).not.toHaveBeenCalled();
  });
});

describe('deleteApiKeys', () => {
  it('submits DELETE_API_KEYS with the ids to remove', async () => {
    const executeActivity = vi.fn().mockResolvedValue({
      deleteApiKeysResult: { apiKeyIds: ['key-old'] },
    });
    const deleted = await deleteApiKeys(fakeClient({ executeActivity }), {
      userId: 'user-1',
      apiKeyIds: ['key-old'],
    });

    expect(deleted).toEqual(['key-old']);
    expect(executeActivity).toHaveBeenCalledWith(
      'ACTIVITY_TYPE_DELETE_API_KEYS',
      'delete_api_keys',
      { userId: 'user-1', apiKeyIds: ['key-old'] },
    );
  });

  it('refuses an empty id list, so a mis-built revoke set cannot silently succeed', async () => {
    const executeActivity = vi.fn();
    await expect(
      deleteApiKeys(fakeClient({ executeActivity }), { userId: 'user-1', apiKeyIds: [] }),
    ).rejects.toThrow(/no apiKeyIds/);
    expect(executeActivity).not.toHaveBeenCalled();
  });
});

describe('getUser / listUsers', () => {
  it('queries get_user with the org in the body and defaults missing arrays', async () => {
    const query = vi.fn().mockResolvedValue({ user: { userId: 'user-1', userName: 'ops' } });
    const user = await getUser(fakeClient({ query }), 'org-1', 'user-1');

    expect(query).toHaveBeenCalledWith('/public/v1/query/get_user', {
      organizationId: 'org-1',
      userId: 'user-1',
    });
    expect(user.apiKeys).toEqual([]);
    expect(user.authenticators).toEqual([]);
  });

  it('throws when the user is missing, rather than returning a shapeless object', async () => {
    const query = vi.fn().mockResolvedValue({});
    await expect(getUser(fakeClient({ query }), 'org-1', 'nope')).rejects.toThrow(/no user/);
  });

  it('returns an empty list when the org reports no users', async () => {
    const query = vi.fn().mockResolvedValue({});
    expect(await listUsers(fakeClient({ query }), 'org-1')).toEqual([]);
  });
});

describe('isDurableApiKey / isExpiredApiKey', () => {
  const NOW = 1_800_000_000;

  it('treats a key with no TTL as durable and never expired', () => {
    const k = { apiKeyId: 'k', apiKeyName: 'primary' };
    expect(isDurableApiKey(k)).toBe(true);
    expect(isExpiredApiKey(k, NOW)).toBe(false);
  });

  it('treats any TTL as non-durable, even one still far from lapsing', () => {
    const k = {
      apiKeyId: 'k',
      apiKeyName: 'standby',
      expirationSeconds: '7776000',
      createdAt: { seconds: String(NOW) },
    };
    expect(isDurableApiKey(k)).toBe(false);
    expect(isExpiredApiKey(k, NOW)).toBe(false);
  });

  it('reports expired once createdAt + ttl has passed', () => {
    const k = {
      apiKeyId: 'k',
      apiKeyName: 'standby',
      expirationSeconds: '3600',
      createdAt: { seconds: String(NOW - 3600) },
    };
    expect(isExpiredApiKey(k, NOW)).toBe(true);
    expect(isExpiredApiKey(k, NOW - 1)).toBe(false);
  });

  it('assumes unexpired when createdAt is missing, so a revoke never deletes real access on a guess', () => {
    const k = { apiKeyId: 'k', apiKeyName: 'standby', expirationSeconds: '3600' };
    expect(isExpiredApiKey(k, NOW)).toBe(false);
  });
});

describe('planRevocation', () => {
  const NOW = 1_800_000_000;
  const ROOT_PUB = '02rootrootroot';
  const key = (
    id: string,
    pub: string,
    opts: { createdAt?: number; ttl?: string } = {},
  ) => ({
    apiKeyId: id,
    apiKeyName: id,
    credential: { publicKey: pub },
    ...(opts.ttl ? { expirationSeconds: opts.ttl } : {}),
    ...(opts.createdAt ? { createdAt: { seconds: String(opts.createdAt) } } : {}),
  });
  const userWith = (keys: any[], authenticators: any[] = []): TurnkeyUserSummary => ({
    userId: 'u1',
    userName: 'settler-agent',
    apiKeys: keys,
    authenticators,
  });
  const plan = (over: Partial<Parameters<typeof import('./api-keys').planRevocation>[0]>) =>
    planRevocation({
      user: userWith([]),
      stampingPublicKey: ROOT_PUB,
      selfRotation: false,
      explicitIds: [],
      nowSeconds: NOW,
      ...(over as any),
    });

  // The victim is never inferred: any "everything except X" rule resolves it from the environment
  // rather than the command, so the same call deletes the old key or the replacement depending on
  // which credential is loaded.
  it('refuses when no key ids are given, rather than inferring a target set', () => {
    const old = key('key-old', PUB_OLD, { createdAt: NOW - 100 });
    const fresh = key('key-new', PUB_NEW, { createdAt: NOW - 10 });
    try {
      plan({ user: userWith([old, fresh]), stampingPublicKey: PUB_NEW, selfRotation: true });
      throw new Error('should have refused');
    } catch (err: any) {
      expect(err.code).toBe('NO_KEY_ID');
    }
  });

  it('revokes exactly the named ids and nothing else', () => {
    const old = key('key-old', PUB_OLD, { createdAt: NOW - 100 });
    const stale = key('key-stale', '02stale', { createdAt: NOW - 200 });
    const fresh = key('key-new', PUB_NEW, { createdAt: NOW - 10 });
    const out = plan({
      user: userWith([old, stale, fresh]),
      stampingPublicKey: PUB_NEW,
      selfRotation: true,
      explicitIds: ['key-old'],
    });
    expect(out.targets.map((k) => k.apiKeyId)).toEqual(['key-old']);
    expect(out.survivors.map((k) => k.apiKeyId)).toEqual(['key-stale', 'key-new']);
  });

  it('de-duplicates a repeated id so the delete call cannot name one key twice', () => {
    const old = key('key-old', PUB_OLD, { createdAt: NOW - 100 });
    const fresh = key('key-new', PUB_NEW, { createdAt: NOW - 10 });
    const out = plan({
      user: userWith([old, fresh]),
      stampingPublicKey: PUB_NEW,
      selfRotation: true,
      explicitIds: ['key-old', 'key-old'],
    });
    expect(out.targets).toHaveLength(1);
  });

  // Regression: stamping with the old key deleted the replacement and reported success.
  it('refuses to delete a key newer than the one authorizing the call', () => {
    const old = key('key-old', PUB_OLD, { createdAt: NOW - 100 });
    const fresh = key('key-new', PUB_NEW, { createdAt: NOW - 10 });
    try {
      plan({ user: userWith([old, fresh]), stampingPublicKey: PUB_OLD, explicitIds: ['key-new'] });
      throw new Error('should have refused');
    } catch (err: any) {
      expect(err.code).toBe('DELETES_NEWER_KEY');
    }
  });

  it('allows the backwards revoke under --force', () => {
    const old = key('key-old', PUB_OLD, { createdAt: NOW - 100 });
    const fresh = key('key-new', PUB_NEW, { createdAt: NOW - 10 });
    const out = plan({
      user: userWith([old, fresh]),
      stampingPublicKey: PUB_OLD,
      explicitIds: ['key-new'],
      force: true,
    });
    expect(out.targets.map((k) => k.apiKeyId)).toEqual(['key-new']);
  });

  it('accepts the correct self rotation: stamp with the new key, revoke the old', () => {
    const old = key('key-old', PUB_OLD, { createdAt: NOW - 100 });
    const fresh = key('key-new', PUB_NEW, { createdAt: NOW - 10 });
    const out = plan({
      user: userWith([old, fresh]),
      stampingPublicKey: PUB_NEW,
      selfRotation: true,
      explicitIds: ['key-old'],
    });
    expect(out.targets.map((k) => k.apiKeyId)).toEqual(['key-old']);
    expect(out.durableSurvivors.map((k) => k.apiKeyId)).toEqual(['key-new']);
  });

  // The strongest guarantee in the module: --force must not be able to reach a lockout.
  it('never leaves a user without a working credential, even under --force', () => {
    const only = key('key-only', PUB_OLD, { createdAt: NOW - 100 });
    const other = key('key-other', '02otherother', { createdAt: NOW - 90 });
    try {
      plan({
        user: userWith([only, other]),
        stampingPublicKey: PUB_NEW, // a key on some other user, so nothing here is the caller's
        selfRotation: false,
        explicitIds: ['key-only', 'key-other'],
        force: true,
      });
      throw new Error('should have refused');
    } catch (err: any) {
      expect(err.code).toBe('NO_WORKING_CREDENTIAL');
    }
  });

  it('never deletes the authorizing key, even under --force', () => {
    const only = key('key-only', PUB_NEW, { createdAt: NOW - 10 });
    try {
      plan({ user: userWith([only]), stampingPublicKey: PUB_NEW, explicitIds: ['key-only'], force: true });
      throw new Error('should have refused');
    } catch (err: any) {
      expect(err.code).toBe('DELETES_AUTHORIZING_KEY');
    }
  });

  it('refuses when every survivor has a TTL, and allows it under --force', () => {
    const old = key('key-old', PUB_OLD, { createdAt: NOW - 100 });
    const ttl = key('key-ttl', PUB_NEW, { createdAt: NOW - 10, ttl: '3600' });
    const user = userWith([old, ttl]);
    try {
      plan({ user, stampingPublicKey: PUB_NEW, selfRotation: true, explicitIds: ['key-old'] });
      throw new Error('should have refused');
    } catch (err: any) {
      expect(err.code).toBe('ALL_SURVIVORS_EXPIRING');
    }
    expect(
      plan({ user, stampingPublicKey: PUB_NEW, selfRotation: true, explicitIds: ['key-old'], force: true })
        .targets,
    ).toHaveLength(1);
  });

  it('refuses when the only survivor has already expired', () => {
    // The expiring key must be the NEWER one, otherwise DELETES_NEWER_KEY fires first.
    const old = key('key-old', PUB_OLD, { createdAt: NOW - 500 });
    const dead = key('key-dead', PUB_NEW, { createdAt: NOW - 90, ttl: '60' });
    try {
      plan({
        user: userWith([old, dead]),
        stampingPublicKey: PUB_NEW,
        selfRotation: true,
        explicitIds: ['key-old'],
      });
      throw new Error('should have refused');
    } catch (err: any) {
      expect(err.code).toBe('NO_WORKING_CREDENTIAL');
    }
  });

  it('lets a passkey stand in for a surviving API key', () => {
    const only = key('key-old', PUB_OLD, { createdAt: NOW - 100 });
    const user = userWith([only], [{ authenticatorId: 'a1', authenticatorName: 'passkey' }]);
    const out = plan({ user, explicitIds: ['key-old'] });
    expect(out.targets).toHaveLength(1);
    expect(out.survivors).toHaveLength(0);
  });

  it('rejects an unknown --key-id instead of silently revoking nothing', () => {
    try {
      plan({ user: userWith([key('key-old', PUB_OLD)]), explicitIds: ['nope'] });
      throw new Error('should have refused');
    } catch (err: any) {
      expect(err.code).toBe('UNKNOWN_KEY_ID');
    }
  });

  // Regression: deriving selfRotation from the key list instead of taking it as an independent
  // signal made this guard vacuous, since the two things it compares became the same thing.
  it('refuses a self rotation whose stamping key is missing from the user', () => {
    // whoami resolved the credential to this user, yet its public key is nowhere in the key list, so
    // the comparison every other guard is built on is broken.
    const old = key('key-old', PUB_OLD, { createdAt: NOW - 100 });
    const other = key('key-other', '02somethingelse', { createdAt: NOW - 50 });
    try {
      plan({
        user: userWith([old, other]),
        stampingPublicKey: PUB_NEW,
        selfRotation: true,
        explicitIds: ['key-old'],
      });
      throw new Error('should have refused');
    } catch (err: any) {
      expect(err.code).toBe('STAMPING_KEY_NOT_ON_USER');
    }
  });

  it('does not fire that guard when the caller is genuinely a different user', () => {
    const old = key('key-old', PUB_OLD, { createdAt: NOW - 100 });
    const fresh = key('key-new', PUB_NEW, { createdAt: NOW - 10 });
    const out = plan({
      user: userWith([old, fresh]),
      verifyPublicKey: PUB_NEW,
      selfRotation: false,
      explicitIds: ['key-old'],
    });
    expect(out.targets.map((k) => k.apiKeyId)).toEqual(['key-old']);
  });
});

describe('findApiKeyByPublicKey', () => {
  it('matches regardless of hex case, since Turnkey does not guarantee it', () => {
    expect(findApiKeyByPublicKey(USER, PUB_OLD.toUpperCase())?.apiKeyId).toBe('key-old');
    expect(findApiKeyByPublicKey(USER, PUB_NEW.toLowerCase())?.apiKeyId).toBe('key-new');
  });

  it('returns undefined for a key that is not on the user', () => {
    expect(findApiKeyByPublicKey(USER, '02deadbeef')).toBeUndefined();
  });
});
