import { describe, expect, it, vi } from 'vitest';

import { assertCowswapHookFencesPrunable, assertSettlerUsers, prepareSettlerUsers } from './users';
import type { TurnkeyClient } from '../client';
import type { ChainEntry } from './sender-policies';

const ORG = 'org-1';
const HOOK_USER = '3f2b8c1e-9a4d-4e7f-b1c2-0d9e8f7a6b5c';
const ROOT_USER = 'a1b2c3d4-0000-4000-8000-000000000001';
const AGENT_USER = 'b2c3d4e5-1111-4111-8111-000000000002';

const user = (userId: string, userName?: string) =>
  userName === undefined
    ? { userId, apiKeys: [], authenticators: [] }
    : { userId, userName, apiKeys: [], authenticators: [] };

// The org as provisioned: a root operator, the agent's machine user, and the hook's own user.
const DEFAULT_USERS = [user(ROOT_USER, 'root'), user(AGENT_USER, 'settler-agent'), user(HOOK_USER, 'cowswap-hook')];

function fakeClient(over: {
  rootUserIds?: string[];
  users?: unknown[];
  listUsers?: () => Promise<unknown>;
}): { client: TurnkeyClient; query: ReturnType<typeof vi.fn> } {
  const users = (over.users ?? DEFAULT_USERS) as { userId: string }[];
  const query = vi.fn(async (path: string, body: { userId?: string }) => {
    if (path === '/public/v1/query/get_organization') {
      return {
        organizationData: {
          rootQuorum: { threshold: 1, userIds: over.rootUserIds ?? [ROOT_USER] },
        },
      };
    }
    if (path === '/public/v1/query/list_users') {
      if (over.listUsers) return over.listUsers();
      return { users };
    }
    // Answered consistently with list_users so these tests stay neutral on whether it is called.
    if (path === '/public/v1/query/get_user') {
      return { user: users.find((u) => u.userId === body.userId) };
    }
    throw new Error(`unexpected path ${path}`);
  });
  return { client: { query, executeActivity: vi.fn() } as unknown as TurnkeyClient, query };
}

// The shape the Turnkey client throws for any non-2xx answer.
const listUsersHttpError = (status: number, body: string) =>
  new Error(`Turnkey /public/v1/query/list_users → HTTP ${status}: ${body}`);

const rejection = async (p: Promise<unknown>): Promise<Error> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
};

const HOOK = { userId: HOOK_USER, userName: 'cowswap-hook' };
const CLI_USER = 'd4e5f6a7-2222-4222-8222-000000000003';
const CLI = { userId: CLI_USER, userName: 'cowswap-swap-cli' };

const AGENT = { userId: AGENT_USER, userName: 'settler-agent' };

describe('assertSettlerUsers', () => {
  it('resolves for the agent plus one fenced user, with one lookup of each kind', async () => {
    const { client, query } = fakeClient({});
    await expect(assertSettlerUsers(client, ORG, AGENT, [HOOK])).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith('/public/v1/query/get_organization', { organizationId: ORG });
    expect(query).toHaveBeenCalledWith('/public/v1/query/list_users', { organizationId: ORG });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('resolves for two fenced users in the same sub-org, still one lookup of each kind', async () => {
    const { client, query } = fakeClient({ users: [...DEFAULT_USERS, user(CLI_USER, 'cowswap-swap-cli')] });
    await expect(assertSettlerUsers(client, ORG, AGENT, [HOOK, CLI])).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('resolves with nothing fenced when the agent is the only non-root user, whatever its name', async () => {
    const { client } = fakeClient({ users: [user(ROOT_USER, 'root'), user(AGENT_USER, 'settler-user')] });
    await expect(
      assertSettlerUsers(client, ORG, { userId: AGENT_USER, userName: 'settler-user' }, []),
    ).resolves.toBeUndefined();
  });

  // Root quorum members are evaluated outside the policy engine, so a DENY scoped to a root user
  // would never fire and its key could sign anything.
  it('rejects a fenced user who is in the root quorum', async () => {
    const { client } = fakeClient({ rootUserIds: [ROOT_USER, HOOK_USER] });
    await expect(assertSettlerUsers(client, ORG, AGENT, [HOOK])).rejects.toThrow(HOOK_USER);
  });

  it('rejects a root user even when Turnkey reports the quorum id in upper case', async () => {
    const { client } = fakeClient({ rootUserIds: [ROOT_USER, HOOK_USER.toUpperCase()] });
    await expect(assertSettlerUsers(client, ORG, AGENT, [HOOK])).rejects.toThrow(HOOK_USER);
  });

  it('rejects an agentUser that is root', async () => {
    const { client } = fakeClient({ rootUserIds: [ROOT_USER, AGENT_USER] });
    await expect(assertSettlerUsers(client, ORG, AGENT, [HOOK])).rejects.toThrow(AGENT_USER);
  });

  it('rejects the agent listed as a fenced user too, before any lookup', async () => {
    const { client, query } = fakeClient({});
    await expect(
      assertSettlerUsers(client, ORG, AGENT, [{ userId: AGENT_USER.toUpperCase(), userName: 'settler-agent' }]),
    ).rejects.toThrow(AGENT_USER);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects when no user has the configured id, for the agent or a fenced user', async () => {
    const { client } = fakeClient({ users: [user(ROOT_USER, 'root'), user(AGENT_USER, 'settler-agent')] });
    await expect(assertSettlerUsers(client, ORG, AGENT, [HOOK])).rejects.toThrow(HOOK_USER);
    const { client: noAgent } = fakeClient({ users: [user(ROOT_USER, 'root'), user(HOOK_USER, 'cowswap-hook')] });
    await expect(assertSettlerUsers(noAgent, ORG, AGENT, [HOOK])).rejects.toThrow(AGENT_USER);
  });

  it('rejects when listing the users fails, even with no fenced user configured', async () => {
    for (const fenced of [[HOOK], []]) {
      const { client } = fakeClient({
        listUsers: () => Promise.reject(listUsersHttpError(500, '{"message":"internal error"}')),
      });
      await expect(assertSettlerUsers(client, ORG, AGENT, fenced)).rejects.toThrow();
    }
  });

  // Any other name means the configured id points at a different principal, whose key would then be
  // fenced, or trusted, in its place.
  it('rejects a user whose name is not exactly the configured one, naming id, actual and expected names', async () => {
    const { client } = fakeClient({
      users: [user(ROOT_USER, 'root'), user(AGENT_USER, 'settler-agent'), user(HOOK_USER, 'swap-cli')],
    });
    const { message } = await rejection(assertSettlerUsers(client, ORG, AGENT, [HOOK]));
    expect(message).toContain(HOOK_USER);
    expect(message).toContain('swap-cli');
    expect(message).toContain('cowswap-hook');
  });

  it('rejects a user name that only resembles the configured one', async () => {
    for (const userName of ['cowswap-hook-old', 'Cowswap-Hook', ' cowswap-hook', 'hook']) {
      const { client } = fakeClient({
        users: [user(ROOT_USER, 'root'), user(AGENT_USER, 'settler-agent'), user(HOOK_USER, userName)],
      });
      await expect(assertSettlerUsers(client, ORG, AGENT, [HOOK]), userName).rejects.toThrow(HOOK_USER);
    }
  });

  it('rejects a user that carries no user name', async () => {
    const { client } = fakeClient({ users: [user(ROOT_USER, 'root'), user(AGENT_USER, 'settler-agent'), user(HOOK_USER)] });
    await expect(assertSettlerUsers(client, ORG, AGENT, [HOOK])).rejects.toThrow(HOOK_USER);
  });

  // Two users sharing a configured name means the operator cannot tell which one holds the key the
  // signer runs with.
  it('rejects when another user also has a configured name, naming both ids', async () => {
    const twin = 'c3d4e5f6-1111-4111-8111-000000000009';
    for (const name of ['cowswap-hook', 'settler-agent']) {
      const { client } = fakeClient({ users: [...DEFAULT_USERS, user(twin, name)] });
      const { message } = await rejection(assertSettlerUsers(client, ORG, AGENT, [HOOK]));
      expect(message, name).toContain(twin);
    }
  });

  // Every non-root user holds every settler ALLOW unless a deny fences it, so the name says nothing.
  it('rejects any other non-root user, whatever its name, naming it', async () => {
    for (const name of ['swap-cli', 'cowswap-swap-cli', 'ops', undefined]) {
      const { client } = fakeClient({ users: [...DEFAULT_USERS, user(CLI_USER, name)] });
      const { message } = await rejection(assertSettlerUsers(client, ORG, AGENT, [HOOK]));
      expect(message, String(name)).toContain(CLI_USER);
    }
  });

  it('rejects a fenced-looking user when nothing is fenced', async () => {
    const { client } = fakeClient({});
    await expect(assertSettlerUsers(client, ORG, AGENT, [])).rejects.toThrow(HOOK_USER);
  });

  it('ignores root users, whatever their name', async () => {
    const OTHER_ROOT = 'e5f6a7b8-3333-4333-8333-000000000004';
    const { client } = fakeClient({
      rootUserIds: [ROOT_USER, OTHER_ROOT.toUpperCase()],
      users: [...DEFAULT_USERS, user(OTHER_ROOT, 'cowswap-root')],
    });
    await expect(assertSettlerUsers(client, ORG, AGENT, [HOOK])).resolves.toBeUndefined();
  });
});

const CHAINS: ChainEntry[] = [
  { key: 'Base', kind: 'evm', chainId: 'eip155:84532' },
  { key: 'Arbitrum', kind: 'evm', chainId: 'eip155:421614' },
  { key: 'Tron', kind: 'tron', chainId: 'tron:shasta' },
];
const USDC = '0x' + 'aA'.repeat(20);
const USDT = '0x' + 'bB'.repeat(20);
const block = (userId: string, chains: Record<string, unknown> = { Base: { pairs: [{ sell: USDC, buy: USDT }] } }) => ({
  users: [{ userId, userName: 'cowswap-hook' }],
  chains,
});

describe('prepareSettlerUsers', () => {
  const cfg = (cowswapHook: unknown, agentUser: unknown = AGENT) => ({ agentUser, cowswapHook });

  it('resolves no hook with no block, after checking every non-root user', async () => {
    const { client, query } = fakeClient({ users: [user(ROOT_USER, 'root'), user(AGENT_USER, 'settler-agent')] });
    await expect(prepareSettlerUsers(client, ORG, cfg(undefined), CHAINS)).resolves.toEqual({
      agentUser: AGENT,
      cowswapHook: undefined,
    });
    expect(query).toHaveBeenCalledWith('/public/v1/query/list_users', { organizationId: ORG });
  });

  it('rejects no block while the sub-org holds another non-root user', async () => {
    const { client } = fakeClient({});
    await expect(prepareSettlerUsers(client, ORG, cfg(undefined), CHAINS)).rejects.toThrow(HOOK_USER);
  });

  it('rejects a missing or malformed agentUser or block before any lookup', async () => {
    const { client, query } = fakeClient({});
    const bad = [
      { cowswapHook: undefined },
      cfg(undefined, null),
      cfg(undefined, { userId: 'not-a-uuid', userName: 'settler-agent' }),
      cfg(undefined, { userId: AGENT_USER, userName: 'settler agent' }),
      cfg(undefined, { userId: AGENT_USER, userName: 'settler-agent', extra: 1 }),
      cfg(null),
      cfg({ userId: HOOK_USER, chains: ['Base'] }),
      cfg(block('not-a-uuid')),
      cfg(block(HOOK_USER, { Tron: { pairs: [{ sell: USDC, buy: USDT }] } })),
      cfg(block(HOOK_USER, { Base: { pairs: [] } })),
    ];
    for (const value of bad) {
      await expect(prepareSettlerUsers(client, ORG, value, CHAINS), JSON.stringify(value)).rejects.toThrow();
    }
    expect(query).not.toHaveBeenCalled();
  });

  // Listed ids are lower-case, so matching the operator's casing against them would miss the user.
  it('resolves the parsed config after verifying the users, matched by lower-cased ids', async () => {
    const { client, query } = fakeClient({});
    await expect(
      prepareSettlerUsers(
        client,
        ORG,
        cfg(block(HOOK_USER.toUpperCase()), { userId: AGENT_USER.toUpperCase(), userName: 'settler-agent' }),
        CHAINS,
      ),
    ).resolves.toEqual({
      agentUser: AGENT,
      cowswapHook: {
        users: [{ userId: HOOK_USER, userName: 'cowswap-hook' }],
        chains: [{ chain: CHAINS[0], pairs: [{ sell: USDC.toLowerCase(), buy: USDT.toLowerCase() }] }],
      },
    });
    expect(query).toHaveBeenCalledWith('/public/v1/query/get_organization', { organizationId: ORG });
    expect(query).toHaveBeenCalledWith('/public/v1/query/list_users', { organizationId: ORG });
  });

  // Turnkey reports ids lower-case; comparing the operator's casing against the quorum would let a
  // root user through by writing its id in upper case.
  it('rejects a root user even when the config spells its id in upper case', async () => {
    const { client } = fakeClient({ rootUserIds: [ROOT_USER, HOOK_USER] });
    await expect(prepareSettlerUsers(client, ORG, cfg(block(HOOK_USER.toUpperCase())), CHAINS)).rejects.toThrow(
      HOOK_USER,
    );
  });

  it('rejects when the configured user does not exist', async () => {
    const { client } = fakeClient({ users: [user(ROOT_USER, 'root'), user(AGENT_USER, 'settler-agent')] });
    await expect(prepareSettlerUsers(client, ORG, cfg(block(HOOK_USER)), CHAINS)).rejects.toThrow(HOOK_USER);
  });
});

describe('assertCowswapHookFencesPrunable', () => {
  const OTHER_HOOK = '7c9d0e1f-2a3b-4c5d-8e6f-a7b8c9d0e1f2';
  const fence = (word: string, id: string) => ({ policyName: `denyCowswapHook${word} (${id})` });
  const ORG_WITHOUT_HOOKS = [user(ROOT_USER, 'root'), user(AGENT_USER, 'settler-agent')];

  it('resolves without lookups when no stale policy is a hook fence', async () => {
    const { client, query } = fakeClient({});
    await expect(
      assertCowswapHookFencesPrunable(client, ORG, [
        { policyName: 'allowedTo (eip155:1)' },
        { policyName: 'allowCowswapHookGpv2Order (eip155:1)' },
      ]),
    ).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  // A `[replacing]` copy is stale only once its user's fences are no longer emitted. Pruning it while
  // the user exists would drop that user's last fence.
  it('refuses to prune a [replacing] copy of a fence while its user still exists', async () => {
    const { client } = fakeClient({});
    await expect(
      assertCowswapHookFencesPrunable(client, ORG, [
        { policyName: `denyCowswapHookActivity (${HOOK_USER}) [replacing]` },
      ]),
    ).rejects.toThrow(HOOK_USER);
  });

  it('resolves when no fenced user is listed, listing the right org', async () => {
    const { client, query } = fakeClient({ users: ORG_WITHOUT_HOOKS });
    await expect(
      assertCowswapHookFencesPrunable(client, ORG, [
        fence('Activity', HOOK_USER),
        { policyName: 'allowedTo (eip155:1)' },
        fence('TypedDataDomain', OTHER_HOOK),
      ]),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith('/public/v1/query/list_users', { organizationId: ORG });
  });

  // Pruning the fence of a user who still exists would leave that user's API key able to sign
  // anything the settler set allows.
  it('rejects when a fenced user is still listed', async () => {
    const { client } = fakeClient({});
    await expect(
      assertCowswapHookFencesPrunable(client, ORG, [fence('PayloadEncoding', HOOK_USER)]),
    ).rejects.toThrow(HOOK_USER);
  });

  // Existence is decided by the listing alone, never by the name, so a renamed user still counts.
  it('rejects when a fenced user is listed under another name', async () => {
    const { client } = fakeClient({ users: [...ORG_WITHOUT_HOOKS, user(HOOK_USER, 'renamed')] });
    await expect(
      assertCowswapHookFencesPrunable(client, ORG, [fence('Activity', HOOK_USER)]),
    ).rejects.toThrow(HOOK_USER);
  });

  // One user being gone must not license pruning the fence of another who still exists.
  it('rejects naming the listed user when one fenced user is gone and another is listed', async () => {
    const { client } = fakeClient({ users: [...ORG_WITHOUT_HOOKS, user(OTHER_HOOK, 'cowswap-hook')] });
    await expect(
      assertCowswapHookFencesPrunable(client, ORG, [
        fence('Activity', HOOK_USER),
        fence('Activity', OTHER_HOOK),
      ]),
    ).rejects.toThrow(OTHER_HOOK);
  });

  // A failed listing never proves absence: whatever the error says, the fence stays. Error text is
  // not parsed because a status or "not found" inside it may describe some other hop or resource.
  describe('when listing the users fails', () => {
    // The org itself holds no hook user, so the failed listing is the only reason left to refuse.
    const prune = (err: unknown) => {
      const { client } = fakeClient({ users: ORG_WITHOUT_HOOKS, listUsers: () => Promise.reject(err) });
      return assertCowswapHookFencesPrunable(client, ORG, [fence('Activity', HOOK_USER)]);
    };

    it('rejects on HTTP 404', async () => {
      await expect(prune(listUsersHttpError(404, '{"message":"no such user"}'))).rejects.toThrow(HOOK_USER);
    });

    it('rejects on HTTP 500', async () => {
      await expect(prune(listUsersHttpError(500, '{"message":"internal error"}'))).rejects.toThrow(HOOK_USER);
    });

    it('rejects when the body says the user was not found', async () => {
      await expect(
        prune(listUsersHttpError(400, `{"code":5,"message":"user ${HOOK_USER} not found"}`)),
      ).rejects.toThrow(HOOK_USER);
    });

    it('rejects a retried 502 whose message embeds an inner HTTP 404', async () => {
      await expect(
        prune(new Error('Turnkey /public/v1/query/list_users → HTTP 502 after 4 attempts: proxy → HTTP 404: gone')),
      ).rejects.toThrow(HOOK_USER);
    });

    it('rejects when the request fails before any HTTP answer', async () => {
      await expect(prune(new TypeError('fetch failed'))).rejects.toThrow(HOOK_USER);
    });
  });
});
