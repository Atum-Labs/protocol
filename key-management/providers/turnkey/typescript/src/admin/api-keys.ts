// API-key lifecycle for a user that already exists. Credentials in Turnkey hang off a user, and
// a user holds up to 10 API keys, so rotation is add-then-revoke against a stable userId: register
// the new key, prove it works, delete the old one. Adding and revoking are separate activities on
// purpose, so the user is never left without a working credential.
//
// This matters most for the sub-org ROOT user. A parent organization has read-only visibility into
// its sub-orgs and cannot add users, add keys, or change the root quorum inside one, so there is no
// break-glass path from above: lose every root credential and the sub-org is unreachable. Never
// revoke before the replacement has been used successfully.
//
// Rotating key material does not touch the root quorum, which is defined by userIds rather than by
// keys, so no UPDATE_ROOT_QUORUM is involved. Replacing the root *user* is a different operation.

import type { TurnkeyClient } from '../client';

export type ApiKeyCurve =
  | 'API_KEY_CURVE_P256'
  | 'API_KEY_CURVE_SECP256K1'
  | 'API_KEY_CURVE_ED25519';

/** Subset of Turnkey's API-key object we read. The key material is nested under `credential`. */
export interface TurnkeyApiKeySummary {
  readonly apiKeyId: string;
  readonly apiKeyName: string;
  readonly credential?: { readonly publicKey?: string; readonly type?: string };
  /** Present only on expiring keys. */
  readonly expirationSeconds?: string;
  readonly createdAt?: { readonly seconds?: string };
}

/** Subset of Turnkey's user object we read. `authenticators` matters for the lockout check: a user
 * with a passkey still has a way in after its last API key is revoked. */
export interface TurnkeyUserSummary {
  readonly userId: string;
  readonly userName: string;
  readonly apiKeys: readonly TurnkeyApiKeySummary[];
  readonly authenticators: readonly { readonly authenticatorId: string; readonly authenticatorName: string }[];
}

/** Turnkey's documented cap on API keys per user. Hitting it makes `addApiKeys` fail, so callers
 * check before minting a key they would then have to throw away. */
export const MAX_API_KEYS_PER_USER = 10;

/** Read one user with its credentials. `organizationId` is required because Turnkey's query
 * endpoints take it in the body; the client doesn't auto-inject it for queries. */
export async function getUser(
  client: TurnkeyClient,
  organizationId: string,
  userId: string,
): Promise<TurnkeyUserSummary> {
  const r = await client.query<{ user?: TurnkeyUserSummary }>('/public/v1/query/get_user', {
    organizationId,
    userId,
  });
  if (!r.user?.userId) {
    throw new Error(`get_user returned no user for ${userId} in ${organizationId}`);
  }
  return normalizeUser(r.user);
}

/** List every user in the org, used to resolve a user by name. */
export async function listUsers(
  client: TurnkeyClient,
  organizationId: string,
): Promise<TurnkeyUserSummary[]> {
  const r = await client.query<{ users?: TurnkeyUserSummary[] }>('/public/v1/query/list_users', {
    organizationId,
  });
  return (r.users ?? []).map(normalizeUser);
}

export interface AddApiKeysInput {
  readonly userId: string;
  readonly apiKeys: ReadonlyArray<{
    readonly apiKeyName: string;
    readonly publicKey: string;
    /** Defaults to P-256, the curve `generateApiKeyPair` produces. */
    readonly curveType?: ApiKeyCurve;
    /** Optional TTL. Omit for a long-lived key. */
    readonly expirationSeconds?: string;
  }>;
}

/**
 * Register additional API keys on an existing user, leaving its current keys untouched. Returns the
 * new `apiKeyId`s. The caller must be authorized inside the org: the sub-org root quorum, or the
 * user itself when a policy permits it (our policy sets do not, so root does this).
 */
export async function addApiKeys(
  client: TurnkeyClient,
  input: AddApiKeysInput,
): Promise<readonly string[]> {
  if (input.apiKeys.length === 0) throw new Error('addApiKeys called with no keys');
  const result = await client.executeActivity<{ createApiKeysResult?: { apiKeyIds?: string[] } }>(
    'ACTIVITY_TYPE_CREATE_API_KEYS_V2',
    'create_api_keys',
    {
      userId: input.userId,
      apiKeys: input.apiKeys.map((k) => ({
        apiKeyName: k.apiKeyName,
        publicKey: k.publicKey,
        curveType: k.curveType ?? 'API_KEY_CURVE_P256',
        ...(k.expirationSeconds ? { expirationSeconds: k.expirationSeconds } : {}),
      })),
    },
  );
  const ids = result.createApiKeysResult?.apiKeyIds;
  if (!ids?.length) {
    throw new Error(
      `CREATE_API_KEYS_V2 returned no apiKeyIds for user ${input.userId}: ${JSON.stringify(result)}`,
    );
  }
  return ids;
}

export interface DeleteApiKeysInput {
  readonly userId: string;
  readonly apiKeyIds: readonly string[];
}

/** Delete API keys from a user. Irreversible: the private half cannot be re-registered later
 * because Turnkey identifies a key by its id, so a revoked key is gone for good. */
export async function deleteApiKeys(
  client: TurnkeyClient,
  input: DeleteApiKeysInput,
): Promise<readonly string[]> {
  if (input.apiKeyIds.length === 0) throw new Error('deleteApiKeys called with no apiKeyIds');
  const result = await client.executeActivity<{ deleteApiKeysResult?: { apiKeyIds?: string[] } }>(
    'ACTIVITY_TYPE_DELETE_API_KEYS',
    'delete_api_keys',
    { userId: input.userId, apiKeyIds: [...input.apiKeyIds] },
  );
  return result.deleteApiKeysResult?.apiKeyIds ?? [];
}

/**
 * True when a key has no TTL, so it keeps working until someone deletes it. This is the property
 * that matters when deciding whether a user still has a way in: `expirationSeconds` is a window
 * measured from creation, so an expiring key is a credential with a deadline on it, and for a
 * sub-org root user that deadline is a scheduled lockout.
 */
export function isDurableApiKey(key: TurnkeyApiKeySummary): boolean {
  return !key.expirationSeconds;
}

/**
 * True when a key's TTL has already elapsed. Expired keys stay in the API response, so anything
 * counting "how many credentials are left" has to exclude them. A key whose `createdAt` Turnkey
 * did not return is treated as unexpired, since guessing the other way would delete real access.
 */
export function isExpiredApiKey(key: TurnkeyApiKeySummary, nowSeconds: number): boolean {
  if (!key.expirationSeconds) return false;
  const created = Number(key.createdAt?.seconds);
  const ttl = Number(key.expirationSeconds);
  if (!Number.isFinite(created) || !Number.isFinite(ttl)) return false;
  return created + ttl <= nowSeconds;
}

export interface PlanRevocationInput {
  readonly user: TurnkeyUserSummary;
  /** Compressed hex public key of the credential authorizing the revoke. */
  readonly stampingPublicKey: string;
  /**
   * Whether the authorizing credential belongs to `user`, established independently of the key list
   * (from `whoami`). It must NOT be derived from `stampingPublicKey` being present in `user.apiKeys`:
   * the point of having both is that disagreement between them proves the public-key comparison every
   * other guard relies on is broken.
   */
  readonly selfRotation: boolean;
  /**
   * Exact keys to revoke. Required and never inferred: which key dies must be stated, not derived
   * from which credential happens to be in the environment.
   */
  readonly explicitIds: readonly string[];
  /** Optional extra assertion: this public key must be registered on the user and must not be in the
   * revoke set. Cheap way to double-check that the replacement survives. */
  readonly verifyPublicKey?: string;
  /** Bypass the two judgement guards (newer-than-stamping, all-survivors-expiring). Never bypasses
   * the guards that would delete the authorizing key or leave nothing working. */
  readonly force?: boolean;
  readonly nowSeconds: number;
}

export interface RevocationPlan {
  readonly targets: readonly TurnkeyApiKeySummary[];
  readonly survivors: readonly TurnkeyApiKeySummary[];
  /** Survivors that are neither expired nor expiring. */
  readonly durableSurvivors: readonly TurnkeyApiKeySummary[];
}

/** Thrown when a revoke would be unsafe. `code` lets callers and tests assert on the reason without
 * matching prose. */
export class UnsafeRevocationError extends Error {
  constructor(
    readonly code:
      | 'NO_KEY_ID'
      | 'UNKNOWN_KEY_ID'
      | 'DELETES_AUTHORIZING_KEY'
      | 'STAMPING_KEY_NOT_ON_USER'
      | 'SURVIVOR_NOT_REGISTERED'
      | 'SURVIVOR_IN_REVOKE_SET'
      | 'DELETES_NEWER_KEY'
      | 'NO_WORKING_CREDENTIAL'
      | 'ALL_SURVIVORS_EXPIRING',
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeRevocationError';
  }
}

/**
 * Decide which keys a revoke should delete, and refuse the shapes that are unsafe. Pure so the
 * refusals are testable: every one of them exists because the alternative is either a locked-out
 * user or a rotation that reports success while leaving the old key live.
 */
export function planRevocation(input: PlanRevocationInput): RevocationPlan {
  const { user, nowSeconds } = input;
  const stampingPub = input.stampingPublicKey.toLowerCase();
  const verifyPub = input.verifyPublicKey?.toLowerCase();
  const explicitIds = input.explicitIds;

  // Every key to delete is named outright. There is deliberately no inferred target set: any rule of
  // the form "everything except X" makes the victim depend on which credential the environment
  // happens to hold, so the same command deletes the old key or the new one depending on the state of
  // a .env file. Naming ids means a wrong command fails instead of deleting the wrong key.
  if (explicitIds.length === 0) {
    throw new UnsafeRevocationError(
      'NO_KEY_ID',
      `No key ids given. Name every key to revoke from "${user.userName}" explicitly, so which key ` +
        'dies never depends on which credential is in the environment.',
    );
  }
  const byId = new Map(user.apiKeys.map((k) => [k.apiKeyId, k]));
  const unknown = explicitIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new UnsafeRevocationError(
      'UNKNOWN_KEY_ID',
      `--key-id names keys that are not on user "${user.userName}": ${unknown.join(', ')}. ` +
        'They may belong to another user, or already be revoked.',
    );
  }
  const targets = [...new Set(explicitIds)].map((id) => byId.get(id)!);

  const revokedIds = new Set(targets.map((k) => k.apiKeyId));
  const survivors = user.apiKeys.filter((k) => !revokedIds.has(k.apiKeyId));
  const live = survivors.filter((k) => !isExpiredApiKey(k, nowSeconds));
  const durableSurvivors = live.filter(isDurableApiKey);
  const hasPasskey = user.authenticators.length > 0;

  // Checked first, because every guard below identifies the stamping key by matching hex. On a self
  // rotation that key must be present, so an empty match means the comparison is broken rather than
  // the key being absent, and everything built on it is silently inert.
  const stampingKey = user.apiKeys.find((k) => k.credential?.publicKey?.toLowerCase() === stampingPub);
  if (input.selfRotation && !stampingKey) {
    throw new UnsafeRevocationError(
      'STAMPING_KEY_NOT_ON_USER',
      `The public key stamping this request is not among "${user.userName}"'s registered keys, yet ` +
        'Turnkey resolved it to that user. Nothing that protects the surviving key can be trusted ' +
        'in that state. Re-check the credential env vars before revoking anything.',
    );
  }

  // Never delete the credential this call depends on. On the self-rotation path this is what makes a
  // lockout unreachable, including under --force.
  const suicidal = targets.find((k) => k.credential?.publicKey?.toLowerCase() === stampingPub);
  if (suicidal) {
    throw new UnsafeRevocationError(
      'DELETES_AUTHORIZING_KEY',
      `${suicidal.apiKeyId} ("${suicidal.apiKeyName}") is the key stamping this request. Stamp with ` +
        'the key that should survive, or name the old key with --key-id.',
    );
  }

  if (verifyPub) {
    const survivor = user.apiKeys.find((k) => k.credential?.publicKey?.toLowerCase() === verifyPub);
    if (!survivor) {
      throw new UnsafeRevocationError(
        'SURVIVOR_NOT_REGISTERED',
        `--verify-public-key is not registered on "${user.userName}". Run --add first, or check you ` +
          'pasted the public key of the right user.',
      );
    }
    if (revokedIds.has(survivor.apiKeyId)) {
      throw new UnsafeRevocationError(
        'SURVIVOR_IN_REVOKE_SET',
        `--verify-public-key resolves to ${survivor.apiKeyId} ("${survivor.apiKeyName}"), which is ` +
          'in the revoke set. That would delete the key you just deployed.',
      );
    }
  }

  // A revoke that deletes a key NEWER than the one authorizing it is backwards: it kills the
  // replacement and keeps the key being replaced. No survivor check catches this, because the
  // outcome is a working credential, so the run reports success while the old key stays live. That
  // is the worst shape for a rotation prompted by a compromise. Keys Turnkey did not timestamp are
  // skipped rather than guessed at, in either direction.
  const stampedAt = Number(stampingKey?.createdAt?.seconds);
  if (!input.force && Number.isFinite(stampedAt)) {
    const newer = targets.filter((k) => {
      const created = Number(k.createdAt?.seconds);
      return Number.isFinite(created) && created > stampedAt;
    });
    if (newer.length > 0) {
      const list = newer.map((k) => `${k.apiKeyId} ("${k.apiKeyName}")`).join(', ');
      throw new UnsafeRevocationError(
        'DELETES_NEWER_KEY',
        `${list} was created AFTER the key stamping this request, so this would delete the ` +
          'replacement and keep the key being replaced. Stamp with the NEW key instead (that is ' +
          'what proves it works), or pass --force if deleting the newer key is really the intent.',
      );
    }
  }

  // Deliberately NOT force-gated. Leaving a user with nothing that works is unrecoverable for a root
  // user, so there is no flag for it: add a working key first, or delete the whole sub-org on purpose
  // with delete-sub-organization.
  if (live.length === 0 && !hasPasskey) {
    const expiredNote = survivors.length > 0 ? ' (the remaining key(s) have already expired)' : '';
    throw new UnsafeRevocationError(
      'NO_WORKING_CREDENTIAL',
      `This would leave "${user.userName}" with no working API key and no authenticator${expiredNote}, ` +
        'which is unrecoverable — a parent org cannot add credentials inside a sub-org. Run --add ' +
        'first. There is no --force for this.',
    );
  }
  if (durableSurvivors.length === 0 && !hasPasskey && !input.force) {
    const deadlines = live
      .map((k) => `${k.apiKeyId} ("${k.apiKeyName}") expires ${k.expirationSeconds}s after creation`)
      .join('; ');
    throw new UnsafeRevocationError(
      'ALL_SURVIVORS_EXPIRING',
      `Every key that would survive on "${user.userName}" has a TTL, so this schedules a lockout ` +
        `rather than causing one now: ${deadlines}. Add a key with no --expiration-seconds first, ` +
        'or pass --force if the expiry is intended.',
    );
  }

  return { targets, survivors, durableSurvivors };
}

/** Find the API key a given public key belongs to. Turnkey returns compressed P-256 hex whose case
 * is not guaranteed, so compare case-insensitively. */
export function findApiKeyByPublicKey(
  user: TurnkeyUserSummary,
  publicKey: string,
): TurnkeyApiKeySummary | undefined {
  const want = publicKey.toLowerCase();
  return user.apiKeys.find((k) => k.credential?.publicKey?.toLowerCase() === want);
}

/** Turnkey marks `apiKeys` / `authenticators` as always present, but a defensive default keeps
 * every caller from having to null-check the arrays. */
function normalizeUser(user: TurnkeyUserSummary): TurnkeyUserSummary {
  return { ...user, apiKeys: user.apiKeys ?? [], authenticators: user.authenticators ?? [] };
}
