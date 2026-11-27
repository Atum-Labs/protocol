// Sub-organization lifecycle. Each environment (testnet,
// prod, …) lives in its own sub-organization with an independent root quorum, wallet, and
// policy namespace. These functions run from the parent organization's credentials.

import type { TurnkeyClient } from '../client';

export interface SubOrgSummary {
  readonly subOrganizationId: string;
  readonly subOrganizationName?: string;
}

export interface CreateSubOrgInput {
  readonly subOrganizationName: string;
  /** Initial root user(s) — humans with hardware authenticators. At least one is required by
   * Turnkey; multiple gives N-of-M quorum. */
  readonly rootUsers: readonly RootUserSpec[];
  /** Quorum threshold; must be ≤ rootUsers.length. */
  readonly rootQuorumThreshold: number;
  /**
   * Optional wallet to provision atomically with the sub-org. Inlining the wallet at
   * sub-org-creation time is the correct path: the parent API key has no membership inside
   * the new sub-org, so a follow-up `CREATE_WALLET` activity against the new sub-org with
   * parent credentials would fail TURNKEY_AUTH. Turnkey supports inline wallet creation as
   * part of the V7 schema specifically to close this chicken-and-egg.
   */
  readonly wallet?: {
    readonly walletName: string;
    readonly accounts: ReadonlyArray<{
      readonly curve: 'CURVE_SECP256K1' | 'CURVE_ED25519';
      readonly pathFormat: 'PATH_FORMAT_BIP32';
      readonly path: string;
      readonly addressFormat:
        | 'ADDRESS_FORMAT_ETHEREUM'
        | 'ADDRESS_FORMAT_TRON'
        | 'ADDRESS_FORMAT_SOLANA'
        | 'ADDRESS_FORMAT_XLM';
    }>;
  };
}

export interface RootUserSpec {
  readonly userName: string;
  readonly userEmail?: string;
  readonly apiKeys?: ReadonlyArray<{
    apiKeyName: string;
    publicKey: string;
    /** API key curve. Defaults to P-256 (the curve `generateP256KeyPair` produces). */
    curveType?: 'API_KEY_CURVE_P256' | 'API_KEY_CURVE_SECP256K1' | 'API_KEY_CURVE_ED25519';
  }>;
  readonly authenticators?: ReadonlyArray<{
    authenticatorName: string;
    challenge: string;
    attestation: {
      credentialId: string;
      clientDataJson: string;
      attestationObject: string;
      transports: readonly string[];
    };
  }>;
}

export interface CreateSubOrgResult {
  readonly subOrganizationId: string;
  /** Present when `input.wallet` was specified. Addresses are in the account-creation order. */
  readonly wallet?: {
    readonly walletId: string;
    readonly addresses: readonly string[];
  };
}

/**
 * Provision a new sub-organization under the parent. Returns the new sub-org's ID, which then
 * becomes the `organizationId` field in the agent's signer config.
 *
 * The caller must run this with credentials authorized in the parent organization.
 */
export async function createSubOrganization(
  client: TurnkeyClient,
  input: CreateSubOrgInput,
): Promise<CreateSubOrgResult> {
  // Turnkey's CREATE_SUB_ORGANIZATION_V7 activity is the current schema. We expose only the
  // fields the agent operator actually uses; the underlying schema supports more (passkey-
  // bootstrapped end-user flows) but those don't apply to a backend signer setup.
  // CREATE_SUB_ORGANIZATION_V7 (v1RootUserParamsV4) requires every root user to carry
  // `authenticators` and `oauthProviders` arrays (empty is fine) and every API key to carry a
  // `curveType`. The client uses raw `executeActivity`, so TS can't enforce this — inject the
  // required fields here rather than have each caller repeat them. Omitting any of the three
  // makes Turnkey reject the activity with a missing-field 400.
  const rootUsers = input.rootUsers.map((u) => ({
    userName: u.userName,
    ...(u.userEmail ? { userEmail: u.userEmail } : {}),
    apiKeys: (u.apiKeys ?? []).map((k) => ({
      apiKeyName: k.apiKeyName,
      publicKey: k.publicKey,
      curveType: k.curveType ?? 'API_KEY_CURVE_P256',
    })),
    authenticators: u.authenticators ?? [],
    oauthProviders: [],
  }));
  const params: Record<string, unknown> = {
    subOrganizationName: input.subOrganizationName,
    rootUsers,
    rootQuorumThreshold: input.rootQuorumThreshold,
    wallet: input.wallet
      ? {
          walletName: input.wallet.walletName,
          accounts: input.wallet.accounts,
        }
      : null,
  };
  // Turnkey wraps activity results in `createSubOrganizationResultV7`.
  const result = await client.executeActivity<{
    createSubOrganizationResultV7: {
      subOrganizationId: string;
      wallet?: { walletId: string; addresses: string[] };
    };
  }>('ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V7', 'create_sub_organization', params);
  const inner = result.createSubOrganizationResultV7;
  if (!inner?.subOrganizationId) {
    throw new Error(
      `CREATE_SUB_ORGANIZATION_V7 response missing createSubOrganizationResultV7.subOrganizationId: ${JSON.stringify(result)}`,
    );
  }
  return {
    subOrganizationId: inner.subOrganizationId,
    ...(inner.wallet ? { wallet: inner.wallet } : {}),
  };
}

export async function listSubOrganizations(client: TurnkeyClient): Promise<SubOrgSummary[]> {
  // Turnkey returns `organizationIds`, not `subOrganizationIds`, even on the list_suborgs
  // endpoint — the parent and its children are both "organizations" in the data model.
  const out = await client.query<{ organizationIds: string[] }>('/public/v1/query/list_suborgs');
  return (out.organizationIds ?? []).map((id) => ({ subOrganizationId: id }));
}

/**
 * Delete a sub-organization. The DELETE_SUB_ORGANIZATION intent takes only `deleteWithoutExport`
 * and operates on the org named by the request's `organizationId`, so the CLIENT must be scoped to
 * the sub-org being deleted, authenticated as one of ITS root users. Do NOT pass a client scoped to
 * the parent org: there is no target-id parameter to redirect it, and a parent org has read-only
 * visibility into its sub-orgs, so it cannot delete one without the sub-org's own participation.
 *
 * `deleteWithoutExport` defaults to false: Turnkey then refuses if any wallet/private key has not
 * been exported, guarding against silent fund loss. Pass true only to force-delete regardless.
 */
export async function deleteSubOrganization(
  client: TurnkeyClient,
  opts: { deleteWithoutExport?: boolean } = {},
): Promise<void> {
  await client.executeActivity<unknown>(
    'ACTIVITY_TYPE_DELETE_SUB_ORGANIZATION',
    'delete_sub_organization',
    { deleteWithoutExport: opts.deleteWithoutExport ?? false },
  );
}
