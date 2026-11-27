// Agent user provisioning. The unattended settlement agent authenticates with a P-256 API key
// owned by a user inside the sub-org: auto-sign with the agent's API key, a single API key per
// sub-org with an overlap rotation pair.

import type { TurnkeyClient } from '../client';
import { getRootQuorum } from './activities';
import { listUsers } from './api-keys';
import type { ChainEntry } from './sender-policies';
import {
  COWSWAP_HOOK_FENCE_NAME,
  parseAgentUser,
  parseCowswapHook,
  type CowswapHookConfig,
  type CowswapHookUser,
  type SettlerApiUser,
} from './settler-policies';

/**
 * Parse the settler config's `agentUser` and `cowswapHook` block and check the sub-org's users
 * against them, so the set is never built for users its fences would not restrict. Runs even with no
 * block: every non-root user other than the agent must be fenced, since it inherits every settler
 * ALLOW.
 */
export async function prepareSettlerUsers(
  client: TurnkeyClient,
  organizationId: string,
  value: { readonly agentUser?: unknown; readonly cowswapHook?: unknown },
  chains: readonly ChainEntry[],
): Promise<{ agentUser: SettlerApiUser; cowswapHook: CowswapHookConfig | undefined }> {
  const agentUser = parseAgentUser(value.agentUser);
  const cowswapHook = parseCowswapHook(value.cowswapHook, chains);
  await assertSettlerUsers(client, organizationId, agentUser, cowswapHook?.users ?? []);
  return { agentUser, cowswapHook };
}

/**
 * Refuse to prune a hook user's denies while that user may still exist. Removing a
 * user from `cowswapHook.users`, or replacing one, leaves the old user's denies stale; deleting them
 * would leave that user, and its API key, with every settler ALLOW. A lookup that fails proves
 * nothing, so it refuses too.
 */
export async function assertCowswapHookFencesPrunable(
  client: TurnkeyClient,
  organizationId: string,
  stale: ReadonlyArray<{ policyName: string }>,
): Promise<void> {
  const fenced = new Set(
    stale.flatMap((p) => {
      const m = COWSWAP_HOOK_FENCE_NAME.exec(p.policyName);
      return m ? [m[1]!] : [];
    }),
  );
  if (fenced.size === 0) return;
  // Absence is read from the user list, never inferred from an error: a failed lookup keeps the
  // fence, and only a successful list without the id proves the user is gone.
  let listed: Set<string>;
  try {
    listed = new Set((await listUsers(client, organizationId)).map((u) => u.userId.toLowerCase()));
  } catch (err) {
    throw new Error(
      `Cannot confirm that CoW Swap hook user(s) ${[...fenced].join(', ')} are gone ` +
        `(${(err as Error).message}), so their denies stay. Delete the user first, then prune.`,
    );
  }
  for (const userId of fenced) {
    if (listed.has(userId.toLowerCase())) {
      throw new Error(
        `CoW Swap hook user ${userId} still exists; pruning its denies would give it every settler ` +
          'ALLOW. Delete the user (and its API key) first, then prune.',
      );
    }
  }
}

/**
 * Refuse a sub-org whose non-root users the settler set would not hold to their role. The agent and
 * every fenced user must exist, not be root, carry the configured name, and be the only user with
 * that name. Every other non-root user holds every settler ALLOW unfenced, so any such user is
 * refused whatever its name. One lookup of each kind; a failed lookup refuses.
 */
export async function assertSettlerUsers(
  client: TurnkeyClient,
  organizationId: string,
  agent: SettlerApiUser,
  fenced: readonly CowswapHookUser[],
): Promise<void> {
  const agentId = agent.userId.toLowerCase();
  if (fenced.some((u) => u.userId.toLowerCase() === agentId)) {
    throw new Error(
      `agentUser ${agentId} is also listed under cowswapHook.users. Fence a separate user, never the agent.`,
    );
  }
  const quorum = await getRootQuorum(client, organizationId);
  const rootIds = new Set(quorum.userIds.map((id) => id.toLowerCase()));
  const users = await listUsers(client, organizationId);
  const expected = [
    { ...agent, userId: agentId, path: 'agentUser' },
    ...fenced.map((u) => ({ ...u, userId: u.userId.toLowerCase(), path: 'cowswapHook user' })),
  ];
  for (const { userId, userName, path } of expected) {
    if (rootIds.has(userId)) {
      throw new Error(
        `${path} ${userId} is in the root quorum of ${organizationId}. Root users bypass every ` +
          'policy; give it a non-root API user (turnkey:create-api-key).',
      );
    }
    const user = users.find((u) => u.userId.toLowerCase() === userId);
    if (!user) {
      throw new Error(`${path} ${userId} names no user in ${organizationId}.`);
    }
    if (user.userName !== userName) {
      throw new Error(
        `${path} ${userId} is the user "${user.userName ?? ''}", not "${userName}". Fix the config ` +
          'to name the user it means.',
      );
    }
    // Turnkey does not enforce unique user names: a re-run create can leave a second user holding
    // the key the signer actually runs with.
    const namesakes = users.filter((u) => u.userName === userName);
    if (namesakes.length > 1) {
      throw new Error(
        `${namesakes.length} users in ${organizationId} are named "${userName}" ` +
          `(${namesakes.map((u) => u.userId).join(', ')}). Delete the extra users so the configured ` +
          'one is the only one.',
      );
    }
  }
  const known = new Set(expected.map((u) => u.userId));
  const unknown = users.filter(
    (u) => !rootIds.has(u.userId.toLowerCase()) && !known.has(u.userId.toLowerCase()),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${organizationId} has non-root user(s) ${unknown.map((u) => `"${u.userName ?? ''}" (${u.userId})`).join(', ')} ` +
        'that are neither agentUser nor listed under cowswapHook.users. No deny fences them, so each ' +
        'holds every settler ALLOW. Delete the user, or list it under cowswapHook.users, then apply.',
    );
  }
}

export interface ProvisionAgentUserInput {
  readonly subOrganizationId: string;
  readonly userName: string;
  readonly apiPublicKey: string;
  readonly apiKeyName?: string;
  /** Optional secondary public key for overlap rotation. */
  readonly standbyApiPublicKey?: string;
  readonly standbyApiKeyName?: string;
  /** Expiry (Unix seconds) for the standby key. Defaults to ~90 days. */
  readonly standbyExpirationSeconds?: number;
}

export interface ProvisionAgentUserResult {
  readonly userId: string;
  readonly apiKeyIds: readonly string[];
}

const DEFAULT_STANDBY_EXPIRATION_SECONDS = 90 * 24 * 60 * 60;

/**
 * Provision the agent's user inside the sub-organization with one primary API key and an
 * optional standby key for overlap rotation. The API public keys must already exist
 * client-side; this function just registers them with Turnkey.
 */
export async function provisionAgentUser(
  client: TurnkeyClient,
  input: ProvisionAgentUserInput,
): Promise<ProvisionAgentUserResult> {
  const apiKeys: Array<{ apiKeyName: string; publicKey: string; expirationSeconds?: string }> = [
    {
      apiKeyName: input.apiKeyName ?? 'primary',
      publicKey: input.apiPublicKey,
    },
  ];
  if (input.standbyApiPublicKey) {
    apiKeys.push({
      apiKeyName: input.standbyApiKeyName ?? 'standby',
      publicKey: input.standbyApiPublicKey,
      expirationSeconds: String(
        input.standbyExpirationSeconds ?? DEFAULT_STANDBY_EXPIRATION_SECONDS,
      ),
    });
  }

  // Turnkey wraps activity results in `createUsersResult`.
  const result = await client.executeActivity<{
    createUsersResult: { userIds: string[]; apiKeyIds?: string[] };
  }>('ACTIVITY_TYPE_CREATE_USERS_V2', 'create_users', {
    users: [
      {
        userName: input.userName,
        apiKeys,
        authenticators: [],
        oauthProviders: [],
        // Required by CREATE_USERS_V2 even when empty; omitting it 400s with "missing field userTags".
        userTags: [],
      },
    ],
  });
  const inner = result.createUsersResult;
  const userId = inner?.userIds?.[0];
  if (!userId) {
    throw new Error(
      `Turnkey CREATE_USERS_V2 returned no userIds for ${input.userName}: ${JSON.stringify(result)}`,
    );
  }
  return { userId, apiKeyIds: inner.apiKeyIds ?? [] };
}
