import { getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  EIP712_RAW_PAYLOAD_CONDITION,
  SETTLER_IDENTITY_VERIFYING_CONTRACT,
  buildAllowSettlerIdentityTypedDataPolicy,
  buildAllowSignRawPayloadPolicy,
} from './policies';
import { buildSenderPolicies } from './sender-policies';
import {
  GPV2_SETTLEMENT_VERIFYING_CONTRACT,
  buildSettlerRawPayloadPolicies,
  cowswapHookPairCondition,
  parseCowswapHook,
  parseTransferWithAuthorizationTokens,
} from './settler-policies';
import type { ChainEntry } from './sender-policies';
import type { CowswapHookConfig } from './settler-policies';

const SETTLER_EVM = '0x551DfeD720649704E79f4aa6ee6a227ce0139796';
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const CHAINS: ChainEntry[] = [
  { key: 'Base', kind: 'evm', chainId: 'eip155:84532' },
  { key: 'Tron', kind: 'tron', chainId: 'tron:shasta' },
  { key: 'Solana', kind: 'solana', chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
];

const settlerSet = (over: Partial<Parameters<typeof buildSettlerRawPayloadPolicies>[0]> = {}) =>
  buildSettlerRawPayloadPolicies({
    chains: CHAINS,
    transferWithAuthorizationTokens: { Base: [BASE_USDC] },
    evmAddress: SETTLER_EVM,
    ...over,
  });
const byName = (name: string) => settlerSet().find((p) => p.policyName === name)!;

describe('settler raw-payload policy set', () => {
  it('allows no KECCAK256 raw signing and denies it explicitly', () => {
    const set = settlerSet();
    for (const p of set.filter((x) => x.effect === 'EFFECT_ALLOW')) {
      expect(p.condition).not.toContain('KECCAK256');
    }
    const deny = byName('denyNonTypedDataHashFunctions');
    expect(deny.effect).toBe('EFFECT_DENY');
    expect(deny.condition).toContain('HASH_FUNCTION_KECCAK256');
    expect(deny.condition).toContain('HASH_FUNCTION_NO_OP');
    expect(set.find((p) => p.policyName === 'allowSignRawPayload')).toBeUndefined();
  });

  it('emits the 7702 and batch denies', () => {
    expect(byName('denyAccountDelegationEncoding').condition).toContain(
      "activity.params.encoding == 'PAYLOAD_ENCODING_EIP7702_AUTHORIZATION'",
    );
    expect(byName('denyBatchRawPayloads').condition).toBe(
      "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOADS'",
    );
  });

  it('emits the same raw-signing deny and ed25519 allow conditions as the sender set', () => {
    const sender = buildSenderPolicies(
      {
        network: 'testnet',
        allowedTokens: {},
        escrows: {},
        allowedDestinations: {},
        solanaEscrowProgramId: 'X',
      },
      [CHAINS[2]!],
    );
    for (const name of [
      'allowEd25519RawPayload',
      'denyNonTypedDataHashFunctions',
      'denyAccountDelegationEncoding',
      'denyBatchRawPayloads',
    ]) {
      const theirs = sender.find((p) => p.policyName === name)!;
      expect(byName(name)).toMatchObject({ effect: theirs.effect, condition: theirs.condition });
    }
  });

  it('allows ed25519 raw signing only with NOT_APPLICABLE and HEX or TEXT_UTF8', () => {
    const p = buildAllowSignRawPayloadPolicy();
    expect(p.condition).toContain("activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'");
    expect(p.condition).toContain(
      "activity.params.encoding in ['PAYLOAD_ENCODING_HEXADECIMAL', 'PAYLOAD_ENCODING_TEXT_UTF8']",
    );
    expect(p.condition).toContain(
      "activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE'",
    );
  });

  it('emits the ed25519 allow only when a Solana chain is configured', () => {
    const noSolana = settlerSet({ chains: CHAINS.slice(0, 2) });
    expect(noSolana.find((p) => p.policyName === 'allowEd25519RawPayload')).toBeUndefined();
  });
});

describe('allowSettlerIdentityTypedData', () => {
  it('pins the keccak-derived sentinel verifying contract', () => {
    const derived = getAddress(
      '0x' + keccak256(toUtf8Bytes('atum.settler.identity.v1')).slice(-40),
    );
    expect(SETTLER_IDENTITY_VERIFYING_CONTRACT).toBe(derived.toLowerCase());
    const p = buildAllowSettlerIdentityTypedDataPolicy();
    expect(p.effect).toBe('EFFECT_ALLOW');
    expect(p.condition).toContain("activity.params.encoding == 'PAYLOAD_ENCODING_EIP712'");
    expect(p.condition).toContain(
      "activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE'",
    );
    expect(p.condition).toContain(
      `eth.eip_712.domain.verifying_contract == '${SETTLER_IDENTITY_VERIFYING_CONTRACT}'`,
    );
    expect(p.condition).not.toContain('chain_id');
  });
});

describe('allowTransferWithAuthorizationTypedData', () => {
  it('binds the EVM token, chain id, primary type and settler from (lowercased)', () => {
    const p = byName('allowTransferWithAuthorizationTypedData (eip155:84532)');
    expect(p.condition).toContain("eth.eip_712.primary_type == 'TransferWithAuthorization'");
    expect(p.condition).toContain(
      `eth.eip_712.domain.verifying_contract in ['${BASE_USDC.toLowerCase()}']`,
    );
    expect(p.condition).toContain('eth.eip_712.domain.chain_id == 84532');
    expect(p.condition).toContain(`eth.eip_712.message['from'] == '${SETTLER_EVM.toLowerCase()}'`);
  });

  it('emits nothing for a chain without tokens', () => {
    const set = settlerSet({ transferWithAuthorizationTokens: {} });
    expect(set.some((p) => p.policyName.startsWith('allowTransferWithAuthorization'))).toBe(false);
  });

  it('fails closed on misconfiguration', () => {
    expect(() => settlerSet({ transferWithAuthorizationTokens: { Nope: [BASE_USDC] } })).toThrow(
      /unknown chain key/,
    );
    expect(() => settlerSet({ transferWithAuthorizationTokens: { Tron: ['x'] } })).toThrow(
      /EVM chains only/,
    );
    expect(() => settlerSet({ transferWithAuthorizationTokens: { Base: [] } })).toThrow(/is empty/);
    expect(() => settlerSet({ transferWithAuthorizationTokens: { Base: ['0x1234'] } })).toThrow(
      /20-byte 0x hex/,
    );
  });
});

describe('parseTransferWithAuthorizationTokens', () => {
  it('requires the key and names the explicit empty map', () => {
    expect(() => parseTransferWithAuthorizationTokens(undefined, CHAINS)).toThrow(
      /missing `transferWithAuthorizationTokens`[\s\S]*Set `\{\}`/,
    );
  });

  it('accepts an explicit empty map and EVM token lists', () => {
    expect(parseTransferWithAuthorizationTokens({}, CHAINS)).toEqual({});
    expect(parseTransferWithAuthorizationTokens({ Base: [BASE_USDC] }, CHAINS)).toEqual({
      Base: [BASE_USDC],
    });
  });

  it('rejects non-EVM chains, unknown keys and malformed values', () => {
    expect(() => parseTransferWithAuthorizationTokens({ Tron: ['T'] }, CHAINS)).toThrow(
      /tron chain.*EVM chains only/,
    );
    expect(() => parseTransferWithAuthorizationTokens({ Solana: ['x'] }, CHAINS)).toThrow(
      /solana chain/,
    );
    expect(() => parseTransferWithAuthorizationTokens({ Nope: [] }, CHAINS)).toThrow(
      /unknown chain key/,
    );
    expect(() => parseTransferWithAuthorizationTokens([BASE_USDC], CHAINS)).toThrow(
      /must be a map/,
    );
    expect(() => parseTransferWithAuthorizationTokens({ Base: BASE_USDC }, CHAINS)).toThrow(
      /must be a list/,
    );
    expect(() => parseTransferWithAuthorizationTokens({ Base: [] }, CHAINS)).toThrow(/is empty/);
    expect(() => parseTransferWithAuthorizationTokens({ Base: ['0x1234'] }, CHAINS)).toThrow(
      /not a 20-byte 0x hex address/,
    );
  });
});

const HOOK_USER = '3f2b8c1e-9a4d-4e7f-b1c2-0d9e8f7a6b5c';
const CLI_USER = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const HOOK_CHAINS: ChainEntry[] = [
  { key: 'Base', kind: 'evm', chainId: 'eip155:84532' },
  { key: 'Arbitrum', kind: 'evm', chainId: 'eip155:421614' },
  { key: 'Tron', kind: 'tron', chainId: 'tron:shasta' },
  { key: 'Solana', kind: 'solana', chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
];
const GPV2 = '0x9008d19f58aabd9ed0d60971565aa8510560ab41';
const E = EIP712_RAW_PAYLOAD_CONDITION;
// Checksummed in the config, lowercase in the parsed form and the conditions.
const USDC = '0x' + 'aA'.repeat(20);
const USDT = '0x' + 'bB'.repeat(20);
const PYUSD = '0x' + 'cC'.repeat(20);
const low = (a: string) => a.toLowerCase();
const HOOK_USERS = [{ userId: HOOK_USER, userName: 'cowswap-hook' }];
const BLOCK = {
  users: HOOK_USERS,
  chains: { Base: { pairs: [{ sell: USDC, buy: USDT }] } },
};
// Each rejection test first parses a valid block, so a throw is attributable to the input under
// test rather than to the parser being absent or throwing on everything.
const expectValidControl = () =>
  expect(parseCowswapHook(BLOCK, HOOK_CHAINS)).toEqual({
    users: HOOK_USERS,
    chains: [{ chain: HOOK_CHAINS[0], pairs: [{ sell: low(USDC), buy: low(USDT) }] }],
  });
const withUsers = (users: unknown) => ({ ...BLOCK, users });
const withChains = (chains: unknown) => ({ ...BLOCK, chains });

describe('parseCowswapHook', () => {
  it('treats an absent block as no hook', () => {
    expect(parseCowswapHook(undefined, HOOK_CHAINS)).toBeUndefined();
  });

  // A bare `cowswapHook:` key parses to null; reading that as "no hook" would silently drop the
  // fence an operator meant to configure.
  it('rejects a null block as a config error', () => {
    expectValidControl();
    expect(() => parseCowswapHook(null, HOOK_CHAINS)).toThrow();
  });

  it('rejects a value that is not a plain object', () => {
    expectValidControl();
    expect(() => parseCowswapHook('x', HOOK_CHAINS)).toThrow();
    expect(() => parseCowswapHook(42, HOOK_CHAINS)).toThrow();
    expect(() => parseCowswapHook([HOOK_USER, ['Base']], HOOK_CHAINS)).toThrow();
  });

  // The old shape bound no tokens, so it cannot be carried over without meaning "any token".
  it('rejects the old single-user shape with a pointer to the new one', () => {
    expectValidControl();
    expect(() => parseCowswapHook({ userId: HOOK_USER, chains: ['Base'] }, HOOK_CHAINS)).toThrow(
      /old shape/,
    );
  });

  // An unrecognised key is most likely a typo for a scoping field; silently ignoring it would
  // widen what the hook user may sign.
  it('rejects unknown keys at every level', () => {
    expectValidControl();
    expect(() => parseCowswapHook({ ...BLOCK, extra: true }, HOOK_CHAINS)).toThrow();
    expect(() =>
      parseCowswapHook(withUsers([{ ...HOOK_USERS[0], role: 'x' }]), HOOK_CHAINS),
    ).toThrow();
    expect(() =>
      parseCowswapHook(withChains({ Base: { pairs: [{ sell: USDC, buy: USDT }], x: 1 } }), HOOK_CHAINS),
    ).toThrow();
    expect(() =>
      parseCowswapHook(withChains({ Base: { pairs: [{ sell: USDC, buy: USDT, fee: 0 }] } }), HOOK_CHAINS),
    ).toThrow();
  });

  it('requires a non-empty users list of UUID ids', () => {
    expectValidControl();
    for (const users of [
      undefined,
      [],
      {},
      [{ userName: 'cowswap-hook' }],
      [{ userId: 7, userName: 'cowswap-hook' }],
      [{ userId: 'not-a-uuid', userName: 'cowswap-hook' }],
      [{ userId: `${HOOK_USER}0`, userName: 'cowswap-hook' }],
      [{ userId: HOOK_USER.replace(/-/g, ''), userName: 'cowswap-hook' }],
    ]) {
      expect(() => parseCowswapHook(withUsers(users), HOOK_CHAINS), JSON.stringify(users)).toThrow();
    }
  });

  // Names carry no security meaning (apply checks ids and refuses any unlisted user), only shape.
  it('requires every user name to be a plain identifier', () => {
    expectValidControl();
    for (const userName of [undefined, '', ' cowswap-hook', 'cowswap hook', '-hook', 'hook\n']) {
      expect(
        () => parseCowswapHook(withUsers([{ userId: HOOK_USER, userName }]), HOOK_CHAINS),
        String(userName),
      ).toThrow();
    }
  });

  it('rejects the same user id, in any case, or the same name twice', () => {
    expectValidControl();
    expect(() =>
      parseCowswapHook(
        withUsers([
          { userId: HOOK_USER, userName: 'cowswap-hook' },
          { userId: HOOK_USER.toUpperCase(), userName: 'cowswap-cli' },
        ]),
        HOOK_CHAINS,
      ),
    ).toThrow(/twice/);
    expect(() =>
      parseCowswapHook(
        withUsers([
          { userId: HOOK_USER, userName: 'cowswap-hook' },
          { userId: CLI_USER, userName: 'cowswap-hook' },
        ]),
        HOOK_CHAINS,
      ),
    ).toThrow(/twice/);
  });

  // The id is interpolated into a case-sensitive CEL equality, so the parser canonicalises it to
  // the lower-case form Turnkey reports rather than trusting the operator's casing.
  it('accepts several users and returns ids lower-cased', () => {
    const parsed = parseCowswapHook(
      withUsers([
        { userId: HOOK_USER.toUpperCase(), userName: 'cowswap-hook' },
        { userId: CLI_USER, userName: 'cowswap-swap-cli' },
      ]),
      HOOK_CHAINS,
    );
    expect(parsed!.users).toEqual([
      { userId: HOOK_USER, userName: 'cowswap-hook' },
      { userId: CLI_USER, userName: 'cowswap-swap-cli' },
    ]);
  });

  it('rejects a missing, empty or malformed chains map', () => {
    expectValidControl();
    const pairs = [{ sell: USDC, buy: USDT }];
    for (const chains of [
      undefined,
      'Base',
      ['Base'],
      {},
      { Base: true },
      { Base: {} },
      { Nope: { pairs } },
      { Tron: { pairs } },
      { Solana: { pairs } },
    ]) {
      expect(() => parseCowswapHook(withChains(chains), HOOK_CHAINS), JSON.stringify(chains)).toThrow();
    }
  });

  // An absent or empty pair list must never mean "any token".
  it('rejects missing, empty, malformed, same-token, duplicate or too many pairs', () => {
    expectValidControl();
    const many = Array.from({ length: 17 }, (_, i) => ({
      sell: USDC,
      buy: '0x' + (i + 1).toString(16).padStart(40, '0'),
    }));
    for (const pairs of [
      undefined,
      [],
      'x',
      [{ sell: USDC }],
      [{ buy: USDT }],
      [{ sell: 'not-an-address', buy: USDT }],
      [{ sell: USDC, buy: 7 }],
      [{ sell: USDC, buy: low(USDC) }],
      [
        { sell: USDC, buy: USDT },
        { sell: low(USDC), buy: low(USDT) },
      ],
      many,
    ]) {
      expect(
        () => parseCowswapHook(withChains({ Base: { pairs } }), HOOK_CHAINS),
        JSON.stringify(pairs)?.slice(0, 80),
      ).toThrow();
    }
    expect(
      parseCowswapHook(withChains({ Base: { pairs: many.slice(0, 16) } }), HOOK_CHAINS)!.chains[0]!
        .pairs,
    ).toHaveLength(16);
  });

  it('returns each chain with its own lower-cased pairs, in the order given', () => {
    const parsed = parseCowswapHook(
      withChains({
        Arbitrum: { pairs: [{ sell: USDT, buy: USDC }] },
        Base: { pairs: [{ sell: USDC, buy: USDT }, { sell: USDC, buy: PYUSD }] },
      }),
      HOOK_CHAINS,
    );
    expect(parsed!.chains).toEqual([
      { chain: HOOK_CHAINS[1], pairs: [{ sell: low(USDT), buy: low(USDC) }] },
      {
        chain: HOOK_CHAINS[0],
        pairs: [
          { sell: low(USDC), buy: low(USDT) },
          { sell: low(USDC), buy: low(PYUSD) },
        ],
      },
    ]);
    expect(parsed!.chains[0]!.chain).toBe(HOOK_CHAINS[1]);
  });
});

describe('cowswapHookPairCondition', () => {
  const pair = (s: string, b: string) =>
    `(eth.eip_712.message['sellToken'] == '${s}' && eth.eip_712.message['buyToken'] == '${b}')`;

  it('wraps a single pair in one outer group', () => {
    expect(cowswapHookPairCondition([{ sell: 'a', buy: 'b' }])).toBe(`(${pair('a', 'b')})`);
  });

  // Without the outer group, `x && (p1) || (p2) && y` parses as `(x && p1) || (p2 && y)`, which
  // lets the second pair skip every other binding.
  it('joins several pairs with || inside one outer group', () => {
    expect(
      cowswapHookPairCondition([
        { sell: 'a', buy: 'b' },
        { sell: 'c', buy: 'd' },
      ]),
    ).toBe(`(${pair('a', 'b')} || ${pair('c', 'd')})`);
  });
});

describe('settler raw-payload policy set with a CoW Swap hook user', () => {
  const ctx = {
    chains: HOOK_CHAINS,
    transferWithAuthorizationTokens: { Base: [BASE_USDC] },
    evmAddress: SETTLER_EVM,
  };
  const BASE_PAIRS = [
    { sell: low(USDC), buy: low(USDT) },
    { sell: low(USDT), buy: low(USDC) },
  ];
  const ARB_PAIRS = [{ sell: low(USDC), buy: low(PYUSD) }];
  const hook: CowswapHookConfig = {
    users: HOOK_USERS,
    chains: [
      { chain: HOOK_CHAINS[0]!, pairs: BASE_PAIRS },
      { chain: HOOK_CHAINS[1]!, pairs: ARB_PAIRS },
    ],
  };
  const base = () => buildSettlerRawPayloadPolicies(ctx);
  const withHook = (h: CowswapHookConfig = hook) =>
    buildSettlerRawPayloadPolicies({ ...ctx, cowswapHook: h });
  const scope = (id: string) => `approvers.any(user, user.id == '${id}')`;
  const denyNames = (id: string) => [
    `denyCowswapHookActivity (${id})`,
    `denyCowswapHookPayloadEncoding (${id})`,
    `denyCowswapHookTypedDataDomain (${id})`,
  ];
  const DENY_NAMES = denyNames(HOOK_USER);
  const pairGroup = (pairs: ReadonlyArray<{ sell: string; buy: string }>) =>
    '(' +
    pairs
      .map(
        (p) =>
          `(eth.eip_712.message['sellToken'] == '${p.sell}' && eth.eip_712.message['buyToken'] == '${p.buy}')`,
      )
      .join(' || ') +
    ')';
  const allowCondition = (numeric: number, pairs: ReadonlyArray<{ sell: string; buy: string }>) =>
    [
      E,
      `eth.eip_712.domain.verifying_contract == '${GPV2}'`,
      "eth.eip_712.domain.name == 'Gnosis Protocol'",
      "eth.eip_712.domain.version == 'v2'",
      `eth.eip_712.domain.chain_id == ${numeric}`,
      "eth.eip_712.primary_type == 'Order'",
      `eth.eip_712.message['receiver'] == '${SETTLER_EVM.toLowerCase()}'`,
      "eth.eip_712.message['kind'] in ['buy', 'sell']",
      "eth.eip_712.message['partiallyFillable'] == false",
      "eth.eip_712.message['sellTokenBalance'] == 'erc20'",
      "eth.eip_712.message['buyTokenBalance'] == 'erc20'",
      "eth.eip_712.message['feeAmount'] == '0'",
      pairGroup(pairs),
    ].join(' && ');

  it('pins the GPv2Settlement verifying contract', () => {
    expect(GPV2_SETTLEMENT_VERIFYING_CONTRACT).toBe(GPV2);
  });

  it('is unchanged when no hook is configured', () => {
    const none = base();
    expect(buildSettlerRawPayloadPolicies({ ...ctx, cowswapHook: undefined })).toEqual(none);
    expect(none.some((p) => p.policyName.includes('CowswapHook'))).toBe(false);
  });

  // An apply creates in emitted order, so the denies lead: on a fresh sub-org the fence exists
  // before any allow the hook user could exercise.
  it('wraps the untouched existing set between the hook denies and the per-chain allows', () => {
    const none = base();
    const set = withHook();
    expect(set).toHaveLength(none.length + 5);
    expect(set.slice(0, 3).map((p) => p.policyName)).toEqual(DENY_NAMES);
    expect(set.slice(3, 3 + none.length)).toEqual(none);
    expect(set.slice(3 + none.length).map((p) => p.policyName)).toEqual([
      'allowCowswapHookGpv2Order (eip155:84532)',
      'allowCowswapHookGpv2Order (eip155:421614)',
    ]);
  });

  it('fences every listed user with its own three denies, all before any allow', () => {
    const set = withHook({
      ...hook,
      users: [...HOOK_USERS, { userId: CLI_USER, userName: 'cowswap-swap-cli' }],
    });
    expect(set.slice(0, 6).map((p) => p.policyName)).toEqual([
      ...denyNames(HOOK_USER),
      ...denyNames(CLI_USER),
    ]);
    for (const p of set.slice(0, 6)) {
      expect(p.effect).toBe('EFFECT_DENY');
    }
    expect(set.slice(3, 6).every((p) => p.consensus === scope(CLI_USER))).toBe(true);
    expect(set.filter((p) => p.policyName.startsWith('allowCowswapHookGpv2Order'))).toHaveLength(2);
  });

  // The hook user's API key lives with the hook service, so it is fenced off from every activity
  // but an EIP-712 raw payload for GPv2Settlement; the consensus scope keeps each deny off the
  // settler itself. Three narrow denies replace one negated conjunction so each layer is legible.
  it('denies the hook user any activity other than a raw-payload signature', () => {
    const deny = withHook().find((p) => p.policyName === DENY_NAMES[0])!;
    expect(deny).toBeDefined();
    expect(deny).toMatchObject({
      effect: 'EFFECT_DENY',
      consensus: scope(HOOK_USER),
      condition: "activity.type != 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'",
    });
  });

  it('denies the hook user a raw payload that is not unhashed EIP-712', () => {
    const deny = withHook().find((p) => p.policyName === DENY_NAMES[1])!;
    expect(deny).toBeDefined();
    expect(deny).toMatchObject({
      effect: 'EFFECT_DENY',
      consensus: scope(HOOK_USER),
      condition:
        "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && (activity.params.encoding != 'PAYLOAD_ENCODING_EIP712' || activity.params.hash_function != 'HASH_FUNCTION_NOT_APPLICABLE')",
    });
  });

  it('denies the hook user typed data for any contract but GPv2Settlement', () => {
    const deny = withHook().find((p) => p.policyName === DENY_NAMES[2])!;
    expect(deny).toBeDefined();
    expect(deny).toMatchObject({
      effect: 'EFFECT_DENY',
      consensus: scope(HOOK_USER),
      condition: `${E} && eth.eip_712.domain.verifying_contract != '${GPV2}'`,
    });
  });

  it("allows per chain only a fill-or-kill, zero-fee ERC-20 buy or sell order paying the settler on that chain's pairs", () => {
    const set = withHook();
    for (const [chainId, numeric, pairs] of [
      ['eip155:84532', 84532, BASE_PAIRS],
      ['eip155:421614', 421614, ARB_PAIRS],
    ] as const) {
      const allow = set.find((p) => p.policyName === `allowCowswapHookGpv2Order (${chainId})`)!;
      expect(allow).toBeDefined();
      expect(allow.effect).toBe('EFFECT_ALLOW');
      expect('consensus' in allow).toBe(false);
      expect(allow.condition).toBe(allowCondition(numeric, pairs));
    }
  });

  // `in [...]` keeps the two kinds one clause, so no `||` can escape the allow's `&&` chain.
  it('admits exactly the buy and sell kinds in one clause', () => {
    const hookAllows = withHook().filter((p) =>
      p.policyName.startsWith('allowCowswapHookGpv2Order'),
    );
    expect(hookAllows).toHaveLength(2);
    for (const allow of hookAllows) {
      const kind = allow.condition.split(' && ').filter((c) => c.includes("message['kind']"));
      expect(kind).toEqual(["eth.eip_712.message['kind'] in ['buy', 'sell']"]);
    }
  });

  it('scopes no policy but the hook denies to a consensus', () => {
    const scoped = withHook().filter((p) => p.consensus !== undefined);
    expect(scoped.map((p) => p.policyName)).toEqual(DENY_NAMES);
  });

  it('emits exactly one allow for a hook given a single chain', () => {
    const only = withHook({ users: HOOK_USERS, chains: [{ chain: HOOK_CHAINS[1]!, pairs: ARB_PAIRS }] });
    const allows = only.filter((p) => p.policyName.startsWith('allowCowswapHookGpv2Order'));
    expect(allows.map((p) => p.policyName)).toEqual(['allowCowswapHookGpv2Order (eip155:421614)']);
    expect(allows[0]!.condition).toBe(allowCondition(421614, ARB_PAIRS));
  });
});

// The hook's field bindings (receiver, kind, chain, ...) hold only because its own GPv2 allow is the
// sole policy that can admit a GPv2Settlement order; any other allow reaching that domain would let
// the hook user sign orders outside those bindings under Turnkey's allow-any semantics.
describe('settler raw-payload policy set admits GPv2Settlement only through the hook allow', () => {
  const ctx = {
    chains: HOOK_CHAINS,
    transferWithAuthorizationTokens: { Base: [BASE_USDC] },
    evmAddress: SETTLER_EVM,
  };
  const allows = (set: ReturnType<typeof buildSettlerRawPayloadPolicies>) =>
    set.filter((p) => p.effect === 'EFFECT_ALLOW');
  const pinned = (condition: string) =>
    condition.includes('eth.eip_712.domain.verifying_contract ==') ||
    condition.includes('eth.eip_712.domain.verifying_contract in');

  it('names every allow that mentions GPv2Settlement as a hook allow, and pins every other EIP-712 allow', () => {
    const set = buildSettlerRawPayloadPolicies({
      ...ctx,
      cowswapHook: {
        users: HOOK_USERS,
        chains: [
          { chain: HOOK_CHAINS[0]!, pairs: [{ sell: low(USDC), buy: low(USDT) }] },
          { chain: HOOK_CHAINS[1]!, pairs: [{ sell: low(USDC), buy: low(USDT) }] },
        ],
      },
    });
    const gpv2Allows = allows(set).filter((p) => p.condition.toLowerCase().includes(GPV2));
    // Control: the guard below is vacuous if the hook allows are not in the set at all.
    expect(gpv2Allows.map((p) => p.policyName)).toEqual([
      'allowCowswapHookGpv2Order (eip155:84532)',
      'allowCowswapHookGpv2Order (eip155:421614)',
    ]);
    for (const p of gpv2Allows) {
      expect(p.policyName).toMatch(/^allowCowswapHookGpv2Order \(.+\)$/);
    }
    const otherEip712 = allows(set).filter(
      (p) =>
        !p.condition.toLowerCase().includes(GPV2) && p.condition.includes('PAYLOAD_ENCODING_EIP712'),
    );
    expect(otherEip712.length).toBeGreaterThan(0);
    for (const p of otherEip712) {
      expect(pinned(p.condition), p.policyName).toBe(true);
    }
  });

  it('has no allow mentioning GPv2Settlement, and pins every EIP-712 allow, without a hook', () => {
    const set = buildSettlerRawPayloadPolicies(ctx);
    expect(allows(set).filter((p) => p.condition.toLowerCase().includes(GPV2))).toEqual([]);
    const eip712 = allows(set).filter((p) => p.condition.includes('PAYLOAD_ENCODING_EIP712'));
    expect(eip712.length).toBeGreaterThan(0);
    for (const p of eip712) {
      expect(pinned(p.condition), p.policyName).toBe(true);
    }
  });
});
