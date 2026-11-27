// Settler raw-payload policy set: EIP-712 typed data only (identity sentinel domain and EIP-3009
// TransferWithAuthorization on configured EVM tokens), plus the raw-signing, 7702 and batch denies.

import {
  EIP712_RAW_PAYLOAD_CONDITION,
  buildAllowSettlerIdentityTypedDataPolicy,
  buildAllowSignRawPayloadPolicy,
  buildAllowStellarRawPayloadPolicy,
  type PolicyDefinition,
} from './policies';
import {
  assertEvmAddress,
  evmNumericChainId,
  typedDataOnlyRawSigningDenies,
  type ChainEntry,
} from './sender-policies';

/** The EIP-3009 struct the settler signs for the originator fulfill. */
const TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE = 'TransferWithAuthorization';

export interface SettlerRawPayloadContext {
  readonly chains: readonly ChainEntry[];
  /** Per EVM chain key, the token contracts the settler signs EIP-3009 authorizations for. */
  readonly transferWithAuthorizationTokens: Readonly<Record<string, readonly string[]>>;
  /** The settler's EVM EOA, the only `from` an authorization may name. */
  readonly evmAddress: string;
  /**
   * The settler's Stellar account(s) per Stellar chain key, `G...` strkeys. REQUIRED for every
   * Stellar chain in `chains`: the Stellar raw allow is scoped to them.
   */
  readonly stellarSigners?: Readonly<Record<string, readonly string[]>>;
  /** A second API user on the settler's wallet that may sign CoW Swap orders and nothing else. */
  readonly cowswapHook?: CowswapHookConfig;
}

/**
 * GPv2Settlement, the verifying contract of every CoW Protocol order, at the same address on every
 * chain CoW supports. Lowercase, as ethers sends it.
 */
export const GPV2_SETTLEMENT_VERIFYING_CONTRACT = '0x9008d19f58aabd9ed0d60971565aa8510560ab41';

/** A non-root API user on the settler's wallet: the agent, or a fenced CoW order signer. */
export interface SettlerApiUser {
  readonly userId: string;
  readonly userName: string;
}

/** A fenced API user on the settler's wallet: the CoW Swap hook service, or another order signer. */
export type CowswapHookUser = SettlerApiUser;

/** One sell token to buy token direction a fenced user may order. Lowercase 0x hex. */
export interface CowswapHookPair {
  readonly sell: string;
  readonly buy: string;
}

export interface CowswapHookChain {
  readonly chain: ChainEntry;
  readonly pairs: readonly CowswapHookPair[];
}

/** The fenced users, and per EVM chain the token pairs every one of them may order. */
export interface CowswapHookConfig {
  readonly users: readonly CowswapHookUser[];
  readonly chains: readonly CowswapHookChain[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An API user name as the config spells it. Apply checks it against the live user. */
export const SETTLER_USER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Turnkey's condition size limit is unverified, so the pair group per chain stays small. */
export const MAX_COWSWAP_HOOK_PAIRS_PER_CHAIN = 16;

function plainMap(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`\`${path}\` must be a map with ${keys.map((k) => `\`${k}\``).join(' and ')}.`);
  }
  const map = value as Record<string, unknown>;
  const unknownKeys = Object.keys(map).filter((k) => !keys.includes(k));
  if (unknownKeys.length > 0) {
    throw new Error(`\`${path}\` has unknown keys: ${unknownKeys.join(', ')}.`);
  }
  return map;
}

function parseCowswapHookUsers(value: unknown): CowswapHookUser[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('`cowswapHook.users` must be a non-empty list of { userId, userName }.');
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  return value.map((entry, i) => {
    const { userId, userName } = plainMap(entry, `cowswapHook.users[${i}]`, ['userId', 'userName']);
    if (typeof userId !== 'string' || !UUID.test(userId)) {
      throw new Error(`\`cowswapHook.users[${i}].userId\` must be a Turnkey user id (a UUID).`);
    }
    if (typeof userName !== 'string' || !SETTLER_USER_NAME_PATTERN.test(userName)) {
      throw new Error(
        `\`cowswapHook.users[${i}].userName\` must match ${SETTLER_USER_NAME_PATTERN} (for example cowswap-hook).`,
      );
    }
    const id = userId.toLowerCase();
    if (ids.has(id)) throw new Error(`\`cowswapHook.users\` lists user ${id} twice.`);
    if (names.has(userName)) throw new Error(`\`cowswapHook.users\` lists the name "${userName}" twice.`);
    ids.add(id);
    names.add(userName);
    return { userId: id, userName };
  });
}

function parseCowswapHookPairs(value: unknown, chain: ChainEntry): CowswapHookPair[] {
  const path = `cowswapHook.chains.${chain.key}.pairs`;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`\`${path}\` must be a non-empty list of { sell, buy } token addresses.`);
  }
  if (value.length > MAX_COWSWAP_HOOK_PAIRS_PER_CHAIN) {
    throw new Error(`\`${path}\` lists ${value.length} pairs; the limit is ${MAX_COWSWAP_HOOK_PAIRS_PER_CHAIN}.`);
  }
  const seen = new Set<string>();
  return value.map((entry, i) => {
    const { sell, buy } = plainMap(entry, `${path}[${i}]`, ['sell', 'buy']);
    if (typeof sell !== 'string' || typeof buy !== 'string') {
      throw new Error(`\`${path}[${i}]\` needs \`sell\` and \`buy\` token addresses.`);
    }
    const pair = {
      sell: assertEvmAddress(sell, chain.key, 'cowswapHook').toLowerCase(),
      buy: assertEvmAddress(buy, chain.key, 'cowswapHook').toLowerCase(),
    };
    if (pair.sell === pair.buy) throw new Error(`\`${path}[${i}]\` sells and buys the same token.`);
    const key = `${pair.sell}>${pair.buy}`;
    if (seen.has(key)) throw new Error(`\`${path}\` lists ${pair.sell} -> ${pair.buy} twice.`);
    seen.add(key);
    return pair;
  });
}

/**
 * Validate the settler config's required `agentUser`: the one non-root user that holds every settler
 * ALLOW unfenced. Apply refuses any other non-root user that `cowswapHook.users` does not list.
 */
export function parseAgentUser(value: unknown): SettlerApiUser {
  if (value === undefined || value === null) {
    throw new Error(
      '`agentUser` is required: the agent\'s API user as `{ userId, userName }` (turnkey:create-api-key ' +
        'prints the id). Apply refuses every other non-root user that `cowswapHook.users` does not list.',
    );
  }
  const { userId, userName } = plainMap(value, 'agentUser', ['userId', 'userName']);
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    throw new Error('`agentUser.userId` must be a Turnkey user id (a UUID).');
  }
  if (typeof userName !== 'string' || !SETTLER_USER_NAME_PATTERN.test(userName)) {
    throw new Error(`\`agentUser.userName\` must match ${SETTLER_USER_NAME_PATTERN}.`);
  }
  return { userId: userId.toLowerCase(), userName };
}

/**
 * Validate the settler config's optional `cowswapHook` block. Absent means no fenced user. A
 * malformed block fails the run rather than emitting a set that scopes the denies to nobody or
 * admits any token; that includes an empty `cowswapHook:` key, which YAML reads as null. User ids
 * and token addresses are lower-cased, the forms Turnkey reports and ethers sends.
 */
export function parseCowswapHook(
  value: unknown,
  chains: readonly ChainEntry[],
): CowswapHookConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    throw new Error(
      '`cowswapHook` is empty. Give it `users` and `chains`, or remove the key for no fenced user.',
    );
  }
  if (typeof value === 'object' && !Array.isArray(value) && 'userId' in value) {
    throw new Error(
      '`cowswapHook.userId` is the old shape. List fenced users under `users: [{ userId, userName }]` ' +
        'and token pairs under `chains: { <chain>: { pairs: [{ sell, buy }] } }`.',
    );
  }
  const block = plainMap(value, 'cowswapHook', ['users', 'chains']);
  const users = parseCowswapHookUsers(block.users);
  const byKey = new Map(chains.map((c) => [c.key, c]));
  const chainMap = block.chains;
  if (
    chainMap === null ||
    typeof chainMap !== 'object' ||
    Array.isArray(chainMap) ||
    Object.keys(chainMap).length === 0
  ) {
    throw new Error('`cowswapHook.chains` must be a non-empty map of EVM chain key to { pairs }.');
  }
  const resolved = Object.entries(chainMap as Record<string, unknown>).map(([key, entry]) => {
    const chain = byKey.get(key);
    if (!chain) {
      throw new Error(`\`cowswapHook.chains\` references unknown chain key "${key}".`);
    }
    if (chain.kind !== 'evm') {
      throw new Error(
        `\`cowswapHook.chains\`: "${key}" is a ${chain.kind} chain. CoW orders are EVM only.`,
      );
    }
    const { pairs } = plainMap(entry, `cowswapHook.chains.${key}`, ['pairs']);
    return { chain, pairs: parseCowswapHookPairs(pairs, chain) };
  });
  return { users, chains: resolved };
}

/**
 * Validate the settler config's `transferWithAuthorizationTokens`. The key is required: an explicit
 * `{}` means the settler signs no EIP-3009, so omitting it cannot silently drop the allow.
 */
export function parseTransferWithAuthorizationTokens(
  value: unknown,
  chains: readonly ChainEntry[],
): Record<string, string[]> {
  if (value === undefined || value === null) {
    throw new Error(
      'Settler config is missing `transferWithAuthorizationTokens`. It lists, per EVM chain key, ' +
        'the token contracts the settler signs EIP-3009 TransferWithAuthorization for (originator ' +
        'fulfill). Without it that signature is denied by Turnkey. Set `{}` explicitly if the ' +
        'settler does no EIP-3009.',
    );
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('`transferWithAuthorizationTokens` must be a map of chain key to token list.');
  }
  const byKey = new Map(chains.map((c) => [c.key, c]));
  const out: Record<string, string[]> = {};
  for (const [key, tokens] of Object.entries(value as Record<string, unknown>)) {
    const chain = byKey.get(key);
    if (!chain) {
      throw new Error(`transferWithAuthorizationTokens references unknown chain key "${key}".`);
    }
    if (chain.kind !== 'evm') {
      throw new Error(
        `transferWithAuthorizationTokens.${key} is a ${chain.kind} chain. The settler signs ` +
          'EIP-3009 on EVM chains only; remove it.',
      );
    }
    if (!Array.isArray(tokens) || tokens.some((t) => typeof t !== 'string')) {
      throw new Error(`transferWithAuthorizationTokens.${key} must be a list of token addresses.`);
    }
    normalizeTransferWithAuthorizationTokens(chain, tokens as string[]);
    evmChainId(chain);
    out[key] = tokens as string[];
  }
  return out;
}

/**
 * Emit the settler's raw-payload policy set. Pure function; no Turnkey calls.
 */
export function buildSettlerRawPayloadPolicies(ctx: SettlerRawPayloadContext): PolicyDefinition[] {
  // Every fenced user's denies come first so a fresh apply, which creates in this order, puts the
  // fences up before any ALLOW those users would inherit.
  const policies: PolicyDefinition[] = ctx.cowswapHook
    ? ctx.cowswapHook.users.flatMap((u) => buildCowswapHookDenies(u.userId))
    : [];
  if (ctx.chains.some((c) => c.kind === 'solana')) {
    policies.push(buildAllowSignRawPayloadPolicy());
  }
  const stellarChains = ctx.chains.filter((c) => c.kind === 'stellar');
  if (stellarChains.length > 0) {
    for (const c of stellarChains) {
      if ((ctx.stellarSigners?.[c.key] ?? []).length === 0) {
        throw new Error(`Settler config: Stellar chain "${c.key}" has no stellarSigners.`);
      }
    }
    policies.push(
      buildAllowStellarRawPayloadPolicy({
        role: 'Settler',
        signers: stellarChains.flatMap((c) => ctx.stellarSigners?.[c.key] ?? []),
        // The gateway handshake is text; transaction hashes and release witnesses are binary.
        encodings: ['PAYLOAD_ENCODING_HEXADECIMAL', 'PAYLOAD_ENCODING_TEXT_UTF8'],
      }),
    );
  }
  policies.push(buildAllowSettlerIdentityTypedDataPolicy());

  const byKey = new Map(ctx.chains.map((c) => [c.key, c]));
  for (const [key, tokens] of Object.entries(ctx.transferWithAuthorizationTokens)) {
    const chain = byKey.get(key);
    if (!chain) {
      throw new Error(`transferWithAuthorizationTokens references unknown chain key "${key}".`);
    }
    policies.push(
      buildAllowTransferWithAuthorizationPolicy({ chain, tokens, from: ctx.evmAddress }),
    );
  }

  policies.push(...typedDataOnlyRawSigningDenies('settler'));
  if (ctx.cowswapHook) {
    policies.push(...buildCowswapHookAllows(ctx.cowswapHook, ctx.evmAddress));
  }
  return policies;
}

/**
 * Matches the hook's DENY names, including a `[replacing]` copy an interrupted `--update` left, and
 * captures the user each one fences. Such a copy is stale only once that user is unlisted, and the
 * prune guard then covers it too.
 */
export const COWSWAP_HOOK_FENCE_NAME =
  /^denyCowswapHook\w+ \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)( \[replacing\])?$/;

/**
 * The hook user shares the settler's wallet and so inherits every settler ALLOW, none of which is
 * scoped to a user. These DENYs, scoped to the hook user, take all of that away except EIP-712
 * typed data under GPv2Settlement.
 *
 * Three DENYs rather than one negated condition: each is anchored on fields that exist for every
 * request it can match (`activity.type` always; the raw-payload params for a raw-payload request;
 * the typed-data domain for EIP-712), so none depends on how Turnkey evaluates a field the request
 * lacks. Each name carries the user id, so a new hook user adds a fence instead of re-scoping the
 * old one, and the old user's fence goes stale where the prune guard can see it.
 */
export function buildCowswapHookDenies(userId: string): PolicyDefinition[] {
  const consensus = `approvers.any(user, user.id == '${userId}')`;
  return [
    {
      policyName: `denyCowswapHookActivity (${userId})`,
      effect: 'EFFECT_DENY',
      consensus,
      condition: `activity.type != 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'`,
      notes:
        'The CoW Swap hook user signs one raw payload at a time and does nothing else: no ' +
        'transaction, batch, credential, policy or activity management.',
    },
    {
      policyName: `denyCowswapHookPayloadEncoding (${userId})`,
      effect: 'EFFECT_DENY',
      consensus,
      condition:
        `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && ` +
        `(activity.params.encoding != 'PAYLOAD_ENCODING_EIP712' || ` +
        `activity.params.hash_function != 'HASH_FUNCTION_NOT_APPLICABLE')`,
      notes: 'The CoW Swap hook user signs unhashed EIP-712 typed data only.',
    },
    {
      policyName: `denyCowswapHookTypedDataDomain (${userId})`,
      effect: 'EFFECT_DENY',
      consensus,
      condition:
        `${EIP712_RAW_PAYLOAD_CONDITION} && ` +
        `eth.eip_712.domain.verifying_contract != '${GPV2_SETTLEMENT_VERIFYING_CONTRACT}'`,
      notes: 'The CoW Swap hook user signs typed data for GPv2Settlement only.',
    },
  ];
}

/**
 * Per hook chain, admit a fill-or-kill, zero-fee CoW buy or sell order paying the settler wallet on
 * one of the chain's configured token pairs. Every message-field selector is here, in an ALLOW, so
 * one that does not evaluate as written denies the order rather than admitting more. No consensus: a
 * consensus on an ALLOW can leave another user's request pending, and this set never leaves a
 * request pending. So the pairs are shared by every fenced user, and the settler gains only the
 * power to sign such an order.
 */
export function buildCowswapHookAllows(
  hook: CowswapHookConfig,
  settlerEvmAddress: string,
): PolicyDefinition[] {
  return hook.chains.map(({ chain, pairs }) => {
    const receiver = assertEvmAddress(settlerEvmAddress, chain.key, 'cowswapHook').toLowerCase();
    const chainId = evmNumericChainId(chain.chainId, 'cowswapHook');
    return {
      policyName: `allowCowswapHookGpv2Order (${chain.chainId})`,
      effect: 'EFFECT_ALLOW' as const,
      // Message-field selectors are not live-verified: run the PROVISIONING.md hook matrix
      // before handing the hook its credential.
      condition: [
        EIP712_RAW_PAYLOAD_CONDITION,
        `eth.eip_712.domain.verifying_contract == '${GPV2_SETTLEMENT_VERIFYING_CONTRACT}'`,
        `eth.eip_712.domain.name == 'Gnosis Protocol'`,
        `eth.eip_712.domain.version == 'v2'`,
        `eth.eip_712.domain.chain_id == ${chainId}`,
        `eth.eip_712.primary_type == 'Order'`,
        `eth.eip_712.message['receiver'] == '${receiver}'`,
        `eth.eip_712.message['kind'] in ['buy', 'sell']`,
        `eth.eip_712.message['partiallyFillable'] == false`,
        `eth.eip_712.message['sellTokenBalance'] == 'erc20'`,
        `eth.eip_712.message['buyTokenBalance'] == 'erc20'`,
        // uint256 fields arrive as decimal strings (ethers getPayload), so the literal is a string.
        `eth.eip_712.message['feeAmount'] == '0'`,
        cowswapHookPairCondition(pairs),
      ].join(' && '),
      notes:
        'A fill-or-kill, zero-fee CoW buy or sell order paying the settler wallet on a configured ' +
        'token pair. Amounts, validTo and appData are not bound by this policy.',
    };
  });
}

/**
 * The pairs as ONE parenthesised group. Joined into the ALLOW's `&&` chain without the outer
 * parentheses, `&&` binding tighter than `||` would let every pair after the first skip the rest of
 * the condition.
 */
export function cowswapHookPairCondition(pairs: readonly CowswapHookPair[]): string {
  const alternatives = pairs.map(
    (p) =>
      `(eth.eip_712.message['sellToken'] == '${p.sell}' && ` +
      `eth.eip_712.message['buyToken'] == '${p.buy}')`,
  );
  return `(${alternatives.join(' || ')})`;
}

/** Non-empty list of 20-byte 0x hex token addresses, lowercased to match what ethers sends. */
function normalizeTransferWithAuthorizationTokens(
  chain: ChainEntry,
  tokens: readonly string[],
): string[] {
  if (tokens.length === 0) {
    throw new Error(
      `transferWithAuthorizationTokens.${chain.key} is empty. List the token contracts the ` +
        'settler signs EIP-3009 authorizations for, or remove the chain.',
    );
  }
  return tokens.map((address) => evmAddressLower(chain, address));
}

function evmAddressLower(chain: ChainEntry, address: string): string {
  return assertEvmAddress(address, chain.key, 'transferWithAuthorizationTokens').toLowerCase();
}

/**
 * Per EVM chain EIP-3009 allow: domain is a configured token on this chain, primary type is
 * TransferWithAuthorization and `from` is the settler.
 */
export function buildAllowTransferWithAuthorizationPolicy(args: {
  readonly chain: ChainEntry;
  readonly tokens: readonly string[];
  readonly from: string;
}): PolicyDefinition {
  const { chain } = args;
  if (chain.kind !== 'evm') {
    throw new Error(
      `transferWithAuthorizationTokens.${chain.key}: the settler signs EIP-3009 on EVM chains only.`,
    );
  }
  const chainIdValue = evmChainId(chain);
  const tokens = normalizeTransferWithAuthorizationTokens(chain, args.tokens)
    .map((t) => `'${t}'`)
    .join(', ');

  return {
    policyName: `allowTransferWithAuthorizationTypedData (${chain.chainId})`,
    effect: 'EFFECT_ALLOW',
    // primary_type and message['from'] are not live-verified selectors on this shape: run the
    // PROVISIONING.md probes before applying this policy.
    condition:
      `${EIP712_RAW_PAYLOAD_CONDITION} && ` +
      `eth.eip_712.primary_type == '${TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE}' && ` +
      `eth.eip_712.domain.verifying_contract in [${tokens}] && ` +
      `eth.eip_712.domain.chain_id == ${chainIdValue} && ` +
      `eth.eip_712.message['from'] == '${evmAddressLower(chain, args.from)}'`,
    notes:
      'Settler originator fulfill: an EIP-3009 TransferWithAuthorization from the settler on an ' +
      'allowlisted token. Recipient and amount are not bound by this policy.',
  };
}

function evmChainId(chain: ChainEntry): number {
  return evmNumericChainId(chain.chainId, 'transferWithAuthorizationTokens');
}
