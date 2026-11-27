// Public entry for the Turnkey admin module. These operations are NOT used in the agent's
// hot signing path — they run from operator-driven scripts (e.g., scripts/turnkey-bootstrap-
// testnet.ts) and from periodic rotation tooling. The hot path only consumes the resulting
// (orgId, walletId, addresses) tuple via the resolved provider config.
//
// Admin operations are deliberately kept out of `client.ts` so the runtime signing client
// stays narrow. Sub-org lifecycle (create/list/delete) and policy authoring live here.

export { createSubOrganization } from './sub-organizations';
export { listSubOrganizations } from './sub-organizations';
export { deleteSubOrganization } from './sub-organizations';
export type { CreateSubOrgInput, CreateSubOrgResult, SubOrgSummary } from './sub-organizations';

export {
  assertCowswapHookFencesPrunable,
  assertSettlerUsers,
  prepareSettlerUsers,
  provisionAgentUser,
} from './users';
export type { ProvisionAgentUserInput, ProvisionAgentUserResult } from './users';

export {
  approveActivity,
  approvedVoterIds,
  getActivity,
  getRootQuorum,
  listPendingActivities,
} from './activities';
export type { RootQuorum } from './activities';

export {
  MAX_API_KEYS_PER_USER,
  UnsafeRevocationError,
  addApiKeys,
  deleteApiKeys,
  findApiKeyByPublicKey,
  getUser,
  isDurableApiKey,
  isExpiredApiKey,
  listUsers,
  planRevocation,
} from './api-keys';
export type {
  AddApiKeysInput,
  ApiKeyCurve,
  DeleteApiKeysInput,
  PlanRevocationInput,
  RevocationPlan,
  TurnkeyApiKeySummary,
  TurnkeyUserSummary,
} from './api-keys';

export { createWalletWithChainAccounts, STELLAR_WALLET_ACCOUNT } from './wallets';
export type { CreateWalletInput, CreateWalletResult } from './wallets';

export {
  ALLOWANCE_GRANT_SELECTORS,
  applyPolicies,
  buildAllowSettlerIdentityTypedDataPolicy,
  buildAllowSignRawPayloadPolicy,
  buildAllowStellarRawPayloadPolicy,
  buildDenyApproveToNonAllowedSpenderEvm,
  buildDenyApproveToNonAllowedSpenderTron,
  deletePolicy,
  derivePoliciesFromAllowlist,
  listPolicies,
  planPolicyChanges,
  selectorAllowedFor,
  SETTLER_IDENTITY_VERIFYING_CONTRACT,
  TURNKEY_MAX_POLICIES,
} from './policies';
export type {
  AllowedSelectorsByTo,
  ApplyPoliciesOptions,
  ApplyPoliciesResult,
  PolicyDefinition,
  PolicyPlan,
  TurnkeyAllowlistPolicy,
  TurnkeyPolicySummary,
} from './policies';

export { isStellarAccountId } from './stellar-address';

export {
  assertEvmAddress,
  buildSenderPolicies,
  evmNumericChainId,
  typedDataOnlyRawSigningDenies,
  EVM_PERMIT2,
  TRON_PERMIT2,
  toTronEvmHex,
  tronBase58ToEvmHex,
  tronTip712ChainId,
} from './sender-policies';
export type { ChainEntry, SenderExtras } from './sender-policies';

export {
  buildAllowTransferWithAuthorizationPolicy,
  COWSWAP_HOOK_FENCE_NAME,
  SETTLER_USER_NAME_PATTERN,
  parseAgentUser,
  type SettlerApiUser,
  GPV2_SETTLEMENT_VERIFYING_CONTRACT,
  MAX_COWSWAP_HOOK_PAIRS_PER_CHAIN,
  buildCowswapHookAllows,
  buildCowswapHookDenies,
  buildSettlerRawPayloadPolicies,
  cowswapHookPairCondition,
  parseCowswapHook,
  parseTransferWithAuthorizationTokens,
} from './settler-policies';
export type {
  CowswapHookChain,
  CowswapHookConfig,
  CowswapHookPair,
  CowswapHookUser,
  SettlerRawPayloadContext,
} from './settler-policies';
export {
  buildVerifierPolicies,
  ESCROW_DOMAIN_NAME,
  ESCROW_DOMAIN_VERSION,
  VERDICT_DOMAIN_NAME,
  VERDICT_DOMAIN_VERSION,
  VERIFIER_VERDICTS,
  VERIFIER_WITNESSES,
} from './verifier-policies';
export type { VerifierExtras } from './verifier-policies';

export { buildExtrasPolicies, validateExtras } from './extras-policies';
export type { ExtrasBuildContext, TurnkeyPolicyExtras } from './extras-policies';
