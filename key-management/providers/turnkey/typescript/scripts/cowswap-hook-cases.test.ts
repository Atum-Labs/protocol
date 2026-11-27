import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

import type { TurnkeyClient } from '../src/client';
import { assertAuthenticatedAs, type CowswapHookCase, cowswapHookCases, fencedUserFor } from './cowswap-hook-cases';

// The CowSwap hook wallet may sign exactly one thing: a GPv2 buy or sell order paying itself, on a
// chain the settler has the hook enabled for. These cases are the live matrix that proves the policy
// draws that line, so the tests pin both the ALLOW shape and that each DENY differs from the first
// (buy) ALLOW in exactly one binding — otherwise a denial cannot be attributed to the binding it targets.

const GPV2_SETTLEMENT = '0x9008D19f58AAbD9eD0D60971565AA8510560ab41';
const IDENTITY_SENTINEL = '0x1238944d14f50709cc27101b2746fdefce08b37e';
const EIP712 = 'PAYLOAD_ENCODING_EIP712';
const NOT_APPLICABLE = 'HASH_FUNCTION_NOT_APPLICABLE';

const ORDER_FIELDS = [
  { name: 'sellToken', type: 'address' },
  { name: 'buyToken', type: 'address' },
  { name: 'receiver', type: 'address' },
  { name: 'sellAmount', type: 'uint256' },
  { name: 'buyAmount', type: 'uint256' },
  { name: 'validTo', type: 'uint32' },
  { name: 'appData', type: 'bytes32' },
  { name: 'feeAmount', type: 'uint256' },
  { name: 'kind', type: 'string' },
  { name: 'partiallyFillable', type: 'bool' },
  { name: 'sellTokenBalance', type: 'string' },
  { name: 'buyTokenBalance', type: 'string' },
];

// Mixed case on purpose: the policy compares lowercase, so the cases must not leak checksum casing
// in a way that changes meaning.
const WALLET = '0xC0FFEE254729296a45a3885639AC7E10F9d54979';
const HOOK_CHAINS = [11155111, 42161] as const;
const UNLISTED = 8453;
const SOLANA = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
// Mixed case on purpose, as an operator writes them; the payload carries them lower-cased.
const TA = '0x' + 'aA'.repeat(20);
const TB = '0x' + 'bB'.repeat(20);
const TC = '0x' + 'cC'.repeat(20);
const TD = '0x' + 'dD'.repeat(20);
type Pair = { sell: string; buy: string };
const ONE_PAIR: Pair[] = [{ sell: TA, buy: TB }];
// Every chain gets the same pairs unless a test gives a per-chain map.
const chainsOf = (ids: readonly number[], pairs: Pair[] | Record<number, Pair[]> = ONE_PAIR) =>
  ids.map((chainId) => ({ chainId, pairs: Array.isArray(pairs) ? pairs : pairs[chainId]! }));
// Settler config `chains` maps as the script reads them; only a 'solana' kind entry means the
// settler set emits the ed25519 ALLOW the hook user inherits.
const EVM_ONLY_CHAINS = {
  'eip155:11155111': { kind: 'evm' },
  'eip155:42161': { kind: 'evm' },
} as const;
const EVM_TRON_CHAINS = { ...EVM_ONLY_CHAINS, 'tron:0x2b6653dc': { kind: 'tron' } } as const;
const WITH_SOLANA_CHAINS = {
  ...EVM_ONLY_CHAINS,
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': { kind: 'solana' },
} as const;

type Method = 'signRawPayload' | 'signTransaction' | 'executeActivity';
interface Recorded {
  c: CowswapHookCase;
  method: Method;
  args: unknown[];
}
interface Decoded {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: Record<string, unknown>;
  message: Record<string, unknown>;
}

function fakeClient() {
  return {
    signRawPayload: vi.fn().mockResolvedValue({}),
    signTransaction: vi.fn().mockResolvedValue({}),
    executeActivity: vi.fn().mockResolvedValue({}),
  };
}

// Each case runs against its own fresh fake so the one call it makes is attributable to it.
async function recordAll(
  hookChainIds: readonly number[] = HOOK_CHAINS,
  unlistedChainId = UNLISTED,
  solanaAddress?: string,
  pairs: Pair[] | Record<number, Pair[]> = ONE_PAIR,
): Promise<Recorded[]> {
  let current = fakeClient();
  const cases = cowswapHookCases({
    hookChains: chainsOf(hookChainIds, pairs),
    unlistedChainId,
    wallet: WALLET,
    configChains: solanaAddress === undefined ? EVM_ONLY_CHAINS : WITH_SOLANA_CHAINS,
    ...(solanaAddress === undefined ? {} : { solanaAddress }),
    client: () => current as unknown as TurnkeyClient,
  });
  const out: Recorded[] = [];
  for (const c of cases) {
    current = fakeClient();
    await c.run();
    const calls = (['signRawPayload', 'signTransaction', 'executeActivity'] as const).flatMap(
      (method) => current[method].mock.calls.map((args) => ({ method, args })),
    );
    expect(calls, `case "${c.name}" must make exactly one client call`).toHaveLength(1);
    out.push({ c, method: calls[0]!.method, args: calls[0]!.args });
  }
  return out;
}

function rawInput(r: Recorded): Record<string, unknown> {
  return r.args[0] as Record<string, unknown>;
}

function isEip712(r: Recorded): boolean {
  return r.method === 'signRawPayload' && rawInput(r).encoding === EIP712;
}

function decode(r: Recorded): Decoded {
  return JSON.parse(rawInput(r).payload as string) as Decoded;
}

function kindOf(r: Recorded): unknown {
  return decode(r).message.kind;
}

function sameWallet(v: unknown): boolean {
  return typeof v === 'string' && v.toLowerCase() === WALLET.toLowerCase();
}

// Hex leaves compare case-insensitively so an address differing only in casing is not a "change".
function leafEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string' && /^0x[0-9a-f]*$/i.test(a)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function flatten(v: unknown, prefix: string, out: Map<string, unknown>): Map<string, unknown> {
  if (v !== null && typeof v === 'object') {
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      flatten(child, prefix ? `${prefix}.${k}` : k, out);
    }
  } else {
    out.set(prefix, v);
  }
  return out;
}

// Paths whose leaf value differs (or exists on only one side) between two decoded payloads.
function diffPaths(a: Decoded, b: Decoded): string[] {
  const fa = flatten(
    { types: a.types, primaryType: a.primaryType, domain: a.domain, message: a.message },
    '',
    new Map(),
  );
  const fb = flatten(
    { types: b.types, primaryType: b.primaryType, domain: b.domain, message: b.message },
    '',
    new Map(),
  );
  const keys = new Set([...fa.keys(), ...fb.keys()]);
  return [...keys].filter((k) => !(fa.has(k) && fb.has(k) && leafEqual(fa.get(k), fb.get(k))));
}

function expectedOrderPayload(chainId: number, message: Record<string, unknown>) {
  return ethers.TypedDataEncoder.getPayload(
    { name: 'Gnosis Protocol', version: 'v2', chainId, verifyingContract: GPV2_SETTLEMENT },
    { Order: ORDER_FIELDS },
    message,
  );
}

describe('cowswapHookCases', () => {
  it('makes no client call while building the list', () => {
    const client = vi.fn();
    const cases = cowswapHookCases({
      hookChains: chainsOf(HOOK_CHAINS),
      unlistedChainId: UNLISTED,
      wallet: WALLET,
      configChains: EVM_ONLY_CHAINS,
      client: client as unknown as () => TurnkeyClient,
    });
    expect(cases.length).toBeGreaterThan(0);
    expect(client).not.toHaveBeenCalled();
  });

  it('gives every case a unique name and a known verdict', () => {
    const cases = cowswapHookCases({
      hookChains: chainsOf(HOOK_CHAINS),
      unlistedChainId: UNLISTED,
      wallet: WALLET,
      configChains: EVM_ONLY_CHAINS,
      client: () => fakeClient() as unknown as TurnkeyClient,
    });
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of cases) expect(['DENY', 'ALLOW', 'REJECTED', 'REFUSED']).toContain(c.expect);
  });

  it('emits a buy then a sell ALLOW per hook chain with one pair each, in config order, and no other ALLOW', async () => {
    const recs = await recordAll();
    const allows = recs.filter((r) => r.c.expect === 'ALLOW');
    expect(allows).toHaveLength(2 * HOOK_CHAINS.length);
    allows.forEach((r, i) => {
      const chainId = HOOK_CHAINS[Math.floor(i / 2)]!;
      const kind = i % 2 === 0 ? 'buy' : 'sell';
      expect(r.c.name).toContain(`eip155:${chainId}`);
      expect(r.c.name).toContain(`GPv2 ${kind} order`);
      expect(isEip712(r)).toBe(true);
      expect(decode(r).domain.chainId).toBe(ethers.toQuantity(chainId));
      expect(kindOf(r)).toBe(kind);
    });
  });

  it('signs each ALLOW as the canonical GPv2 buy or sell order paying the wallet, in getPayload form', async () => {
    const allows = (await recordAll()).filter((r) => r.c.expect === 'ALLOW');
    allows.forEach((r, i) => {
      const input = rawInput(r);
      expect(Object.keys(input).sort()).toEqual(
        ['encoding', 'hashFunction', 'payload', 'signWith'].sort(),
      );
      expect(sameWallet(input.signWith)).toBe(true);
      expect(input.encoding).toBe(EIP712);
      expect(input.hashFunction).toBe(NOT_APPLICABLE);

      const d = decode(r);
      expect(d.primaryType).toBe('Order');
      expect(d.types.Order).toEqual(ORDER_FIELDS);
      expect(Object.keys(d.types).sort()).toEqual(['EIP712Domain', 'Order']);
      expect(sameWallet(d.message.receiver)).toBe(true);
      expect(d.message.kind).toBe(i % 2 === 0 ? 'buy' : 'sell');
      expect(d.message.partiallyFillable).toBe(false);
      expect(d.message.sellTokenBalance).toBe('erc20');
      expect(d.message.buyTokenBalance).toBe('erc20');
      expect(d.message.feeAmount).toBe('0');
      // The first configured pair, in the lower-cased form the policy compares against.
      expect(d.message.sellToken).toBe(TA.toLowerCase());
      expect(d.message.buyToken).toBe(TB.toLowerCase());
      // An expired order can never be settled, so a mis-scoped ALLOW in the live matrix cannot
      // yield a fillable order even if the signature leaks.
      expect(Number(d.message.validTo)).toBeLessThan(1_700_000_000);

      // Byte-for-byte the string km-core's Turnkey signer sends: a policy matched against any
      // other serialisation proves nothing about production traffic.
      const expected = expectedOrderPayload(HOOK_CHAINS[Math.floor(i / 2)]!, d.message);
      expect(input.payload).toBe(JSON.stringify(expected));
    });
  });

  it('uses the same order on every hook chain, so the chain id is the only per-chain difference', async () => {
    const allows = (await recordAll()).filter((r) => r.c.expect === 'ALLOW');
    const buys = allows.filter((r) => kindOf(r) === 'buy');
    const sells = allows.filter((r) => kindOf(r) === 'sell');
    expect(diffPaths(decode(buys[0]!), decode(buys[1]!))).toEqual(['domain.chainId']);
    expect(diffPaths(decode(sells[0]!), decode(sells[1]!))).toEqual(['domain.chainId']);
  });

  it('makes the sell control the buy control with only the kind changed', async () => {
    const allows = (await recordAll()).filter((r) => r.c.expect === 'ALLOW');
    expect(diffPaths(decode(allows[0]!), decode(allows[1]!))).toEqual(['message.kind']);
  });

  // The DENY variants are attributed against the first ALLOW, so it must stay the buy order.
  it('emits the buy order as the first ALLOW', async () => {
    const first = (await recordAll()).find((r) => r.c.expect === 'ALLOW')!;
    expect(kindOf(first)).toBe('buy');
  });

  describe('single-binding DENY variants of the first hook chain order', () => {
    async function variants(hookChainIds: readonly number[] = HOOK_CHAINS) {
      const recs = await recordAll(hookChainIds);
      const base = decode(recs.find((r) => r.c.expect === 'ALLOW')!);
      const denies = recs.filter((r) => r.c.expect === 'DENY' && isEip712(r));
      return { base, denies };
    }

    function findOneLeafVariant(
      base: Decoded,
      denies: Recorded[],
      path: string,
      check: (v: unknown) => boolean,
    ): Recorded {
      const hits = denies.filter((r) => {
        const d = diffPaths(base, decode(r));
        return d.length === 1 && d[0] === path && check(flatten(decode(r), '', new Map()).get(path));
      });
      expect(hits, `expected one DENY differing only at ${path}`).toHaveLength(1);
      const input = rawInput(hits[0]!);
      expect(sameWallet(input.signWith)).toBe(true);
      expect(input.hashFunction).toBe(NOT_APPLICABLE);
      return hits[0]!;
    }

    it.each([
      ['message.receiver', (v: unknown) => typeof v === 'string' && !sameWallet(v)],
      ['message.kind', (v: unknown) => v === 'swap'],
      ['message.partiallyFillable', (v: unknown) => v === true],
      ['message.sellTokenBalance', (v: unknown) => v === 'external'],
      ['message.buyTokenBalance', (v: unknown) => v === 'internal'],
      ['domain.chainId', (v: unknown) => v === ethers.toQuantity(UNLISTED)],
      [
        'domain.verifyingContract',
        (v: unknown) =>
          typeof v === 'string' &&
          ethers.isAddress(v) &&
          v.toLowerCase() !== GPV2_SETTLEMENT.toLowerCase(),
      ],
      ['domain.name', (v: unknown) => typeof v === 'string' && v !== 'Gnosis Protocol'],
      ['domain.version', (v: unknown) => v === 'v3'],
      ['message.sellToken', (v: unknown) => typeof v === 'string' && ethers.isAddress(v) && v !== TA.toLowerCase()],
      ['message.buyToken', (v: unknown) => typeof v === 'string' && ethers.isAddress(v) && v !== TB.toLowerCase()],
      ['message.feeAmount', (v: unknown) => v === '1'],
    ] as const)('denies an order differing only at %s', async (path, check) => {
      const { base, denies } = await variants();
      findOneLeafVariant(base, denies, path, check);
    });

    // The sell kind is admitted, so a sell order must still be held to every other binding.
    it('denies a sell order with another receiver', async () => {
      const { base, denies } = await variants();
      const hits = denies.filter((r) => {
        const d = decode(r);
        const changed = diffPaths(base, d).sort();
        return (
          JSON.stringify(changed) === JSON.stringify(['message.kind', 'message.receiver']) &&
          d.message.kind === 'sell' &&
          !sameWallet(d.message.receiver)
        );
      });
      expect(hits).toHaveLength(1);
      expect(sameWallet(rawInput(hits[0]!).signWith)).toBe(true);
    });

    it('denies an order whose only change is the primary struct name', async () => {
      const { base, denies } = await variants();
      const hits = denies.filter((r) => {
        const d = decode(r);
        if (d.primaryType === 'Order' || d.types.Order !== undefined) return false;
        const { [d.primaryType]: renamed, ...rest } = d.types;
        const { Order: _order, ...baseRest } = base.types;
        return (
          JSON.stringify(renamed) === JSON.stringify(base.types.Order) &&
          diffPaths(
            { ...base, types: baseRest, primaryType: '' },
            { ...d, types: rest, primaryType: '' },
          ).length === 0
        );
      });
      expect(hits).toHaveLength(1);
      expect(sameWallet(rawInput(hits[0]!).signWith)).toBe(true);
      expect(rawInput(hits[0]!).hashFunction).toBe(NOT_APPLICABLE);
    });

    it('bases the variants on the first configured hook chain, not a fixed one', async () => {
      const { base, denies } = await variants([42161, 11155111]);
      expect(base.domain.chainId).toBe(ethers.toQuantity(42161));
      findOneLeafVariant(base, denies, 'message.kind', (v) => v === 'swap');
    });
  });

  it('denies an EIP-712 signature over the settler identity domain', async () => {
    const recs = await recordAll();
    const hits = recs.filter((r) => {
      if (r.c.expect !== 'DENY' || !isEip712(r)) return false;
      const dom = decode(r).domain;
      return (
        Object.keys(dom).sort().join() === 'name,verifyingContract,version' &&
        dom.name === 'Atum Settler Identity' &&
        dom.version === '1' &&
        String(dom.verifyingContract).toLowerCase() === IDENTITY_SENTINEL
      );
    });
    expect(hits).toHaveLength(1);
    expect(sameWallet(rawInput(hits[0]!).signWith)).toBe(true);
    expect(rawInput(hits[0]!).hashFunction).toBe(NOT_APPLICABLE);
  });

  // NOT_APPLICABLE over hex is the ed25519 raw path, which Turnkey refuses for a secp256k1 key
  // before any policy is evaluated — so that row cannot be a policy DENY.
  it.each([
    ['HASH_FUNCTION_KECCAK256', 'DENY'],
    ['HASH_FUNCTION_NO_OP', 'DENY'],
    ['HASH_FUNCTION_NOT_APPLICABLE', 'REFUSED'],
  ] as const)(
    'expects a wallet raw hex payload hashed with %s to be %s',
    async (hashFunction, verdict) => {
      const recs = await recordAll();
      const hits = recs.filter(
        (r) =>
          r.method === 'signRawPayload' &&
          sameWallet(rawInput(r).signWith) &&
          rawInput(r).encoding === 'PAYLOAD_ENCODING_HEXADECIMAL' &&
          rawInput(r).hashFunction === hashFunction,
      );
      expect(hits).toHaveLength(1);
      expect(hits[0]!.c.expect).toBe(verdict);
      expect(rawInput(hits[0]!).payload).toMatch(/^(0x)?([0-9a-fA-F]{2})+$/);
    },
  );

  // A self-send nonce burn is admitted by the settler policy the hook wallet inherits, so only
  // the hook fence can deny it; any other transaction shape would be denied regardless.
  it('denies a self-send nonce-burn transaction on the first hook chain', async () => {
    const recs = await recordAll();
    const hits = recs.filter((r) => r.c.expect === 'DENY' && r.method === 'signTransaction');
    expect(hits).toHaveLength(1);
    const input = rawInput(hits[0]!);
    expect(sameWallet(input.signWith)).toBe(true);
    expect(input.type).toBe('TRANSACTION_TYPE_ETHEREUM');
    const hex = String(input.unsignedTransaction);
    const tx = ethers.Transaction.from(hex.startsWith('0x') ? hex : `0x${hex}`);
    expect(tx.chainId).toBe(BigInt(HOOK_CHAINS[0]));
    expect(tx.signature).toBeNull();
    expect(tx.type).toBe(2);
    expect(sameWallet(tx.to)).toBe(true);
    expect(tx.value).toBe(0n);
    expect(tx.gasLimit).toBe(21000n);
    expect(tx.data).toBe('0x');
  });

  it.each([
    ['ACTIVITY_TYPE_CREATE_API_KEYS_V2', 'DENY'],
    ['ACTIVITY_TYPE_CREATE_POLICY_V3', 'DENY'],
    ['ACTIVITY_TYPE_APPROVE_ACTIVITY', 'REFUSED'],
  ] as const)('expects the management activity %s to be %s', async (activityType, verdict) => {
    const recs = await recordAll();
    const hits = recs.filter(
      (r) => r.method === 'executeActivity' && r.args[0] === activityType,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.c.expect).toBe(verdict);
    expect(typeof hits[0]!.args[1]).toBe('string');
    expect(hits[0]!.args[2]).toBeTypeOf('object');
  });

  // If the fence ever fails open on this row, the live run creates a real policy; it must be one
  // that can never match anything.
  it('makes the CREATE_POLICY_V3 probe an inert policy', async () => {
    const recs = await recordAll();
    const hit = recs.find(
      (r) => r.method === 'executeActivity' && r.args[0] === 'ACTIVITY_TYPE_CREATE_POLICY_V3',
    )!;
    const params = hit.args[2] as Record<string, unknown>;
    expect(params.effect).toBe('EFFECT_DENY');
    expect(params.condition).toBe('false');
  });

  it('adds exactly two DENY Solana rows when a Solana address is given', async () => {
    const without = await recordAll();
    const recs = await recordAll(HOOK_CHAINS, UNLISTED, SOLANA);
    expect(recs).toHaveLength(without.length + 2);
    const sol = recs.filter(
      (r) => r.method === 'signRawPayload' && rawInput(r).signWith === SOLANA,
    );
    expect(sol).toHaveLength(2);
    for (const r of sol) {
      expect(r.c.expect).toBe('DENY');
      expect(rawInput(r).hashFunction).toBe(NOT_APPLICABLE);
    }
    expect(sol.map((r) => rawInput(r).encoding).sort()).toEqual(
      ['PAYLOAD_ENCODING_HEXADECIMAL', 'PAYLOAD_ENCODING_TEXT_UTF8'].sort(),
    );
    const hex = sol.find((r) => rawInput(r).encoding === 'PAYLOAD_ENCODING_HEXADECIMAL')!;
    expect(rawInput(hex).payload).toMatch(/^(0x)?([0-9a-fA-F]{2})+$/);
    const text = sol.find((r) => rawInput(r).encoding === 'PAYLOAD_ENCODING_TEXT_UTF8')!;
    expect(typeof rawInput(text).payload).toBe('string');
    expect((rawInput(text).payload as string).length).toBeGreaterThan(0);
    expect(recs.filter((r) => r.c.expect === 'ALLOW')).toHaveLength(2 * HOOK_CHAINS.length);
  });

  it('signs with nothing but the wallet when no Solana address is given', async () => {
    const recs = await recordAll();
    for (const r of recs.filter((x) => x.method !== 'executeActivity')) {
      expect(sameWallet(rawInput(r).signWith), r.c.name).toBe(true);
    }
  });

  it('emits exactly one buy and one sell ALLOW for a single-chain hook config', async () => {
    const recs = await recordAll([42161]);
    const allows = recs.filter((r) => r.c.expect === 'ALLOW');
    expect(allows.map(kindOf)).toEqual(['buy', 'sell']);
    for (const r of allows) {
      expect(r.c.name).toContain('eip155:42161');
      expect(decode(r).domain.chainId).toBe(ethers.toQuantity(42161));
    }
  });
  describe('token pair rows', () => {
    const [C1, C2] = HOOK_CHAINS;
    const low = (a: string) => a.toLowerCase();
    const tokens = (r: Recorded) => {
      const d = decode(r);
      return { sell: d.message.sellToken, buy: d.message.buyToken, receiver: d.message.receiver, chainId: d.domain.chainId };
    };
    const row = (recs: Recorded[], fragment: string) => {
      const hits = recs.filter((r) => r.c.name.includes(fragment));
      expect(hits, fragment).toHaveLength(1);
      expect(hits[0]!.c.expect).toBe('DENY');
      return tokens(hits[0]!);
    };
    const build = (hookChains: ReturnType<typeof chainsOf>, onSkip?: (r: string) => void) =>
      cowswapHookCases({
        hookChains,
        unlistedChainId: UNLISTED,
        wallet: WALLET,
        configChains: EVM_ONLY_CHAINS,
        client: () => fakeClient() as unknown as TurnkeyClient,
        ...(onSkip ? { onSkip } : {}),
      });

    it('builds the reversed, crossed, last-pair and other-chain rows when the config leaves them out', async () => {
      const recs = await recordAll(HOOK_CHAINS, UNLISTED, undefined, {
        [C1]: [
          { sell: TA, buy: TB },
          { sell: TC, buy: TD },
        ],
        [C2]: [{ sell: TB, buy: TA }],
      });
      expect(row(recs, 'the first pair reversed')).toMatchObject({
        sell: low(TB),
        buy: low(TA),
        chainId: ethers.toQuantity(C1),
      });
      expect(row(recs, "another pair's buy token")).toMatchObject({
        sell: low(TA),
        buy: low(TD),
        chainId: ethers.toQuantity(C1),
      });
      const last = row(recs, 'the last pair and another receiver');
      expect(last).toMatchObject({ sell: low(TC), buy: low(TD), chainId: ethers.toQuantity(C1) });
      expect(sameWallet(last.receiver)).toBe(false);
      expect(row(recs, 'which this chain does not list')).toMatchObject({
        sell: low(TA),
        buy: low(TB),
        chainId: ethers.toQuantity(C2),
      });
    });

    // A row the config allows would be a false failure; it is skipped with a reason instead.
    it('skips, never flips, every pair row the config allows', () => {
      const reasons: string[] = [];
      const symmetric = [
        { sell: TA, buy: TB },
        { sell: TB, buy: TA },
      ];
      const names = build(chainsOf(HOOK_CHAINS, symmetric), (r) => reasons.push(r)).map((c) => c.name);
      expect(names.some((n) => n.includes('reversed'))).toBe(false);
      expect(names.some((n) => n.includes("another pair's buy token"))).toBe(false);
      expect(names.some((n) => n.includes('does not list'))).toBe(false);
      expect(names.filter((n) => n.includes('the last pair and another receiver'))).toHaveLength(1);
      expect(reasons).toHaveLength(3);
    });

    it('skips the last-pair row for a single pair and the other-chain row for a single chain', () => {
      const reasons: string[] = [];
      build(chainsOf([C1!]), (r) => reasons.push(r));
      expect(reasons.some((r) => r.startsWith('last pair'))).toBe(true);
      expect(reasons.some((r) => r.startsWith('pair on another chain'))).toBe(true);
    });

    // A mistyped later pair must fail the matrix, so every listed pair is a positive control.
    it('emits a buy and a sell ALLOW per listed pair, in config order, each on its own chain', async () => {
      const recs = await recordAll(HOOK_CHAINS, UNLISTED, undefined, {
        [C1]: [
          { sell: TA, buy: TB },
          { sell: TA, buy: TC },
          { sell: TB, buy: TD },
        ],
        [C2]: [{ sell: TC, buy: TD }],
      });
      const allows = recs.filter((r) => r.c.expect === 'ALLOW');
      expect(allows.map(kindOf)).toEqual(
        Array.from({ length: 8 }, (_, i) => (i % 2 ? 'sell' : 'buy')),
      );
      for (const kind of ['buy', 'sell']) {
        const ofKind = allows.filter((r) => kindOf(r) === kind);
        expect(ofKind.map(tokens)).toEqual([
          expect.objectContaining({ sell: low(TA), buy: low(TB) }),
          expect.objectContaining({ sell: low(TA), buy: low(TC) }),
          expect.objectContaining({ sell: low(TB), buy: low(TD) }),
          expect.objectContaining({ sell: low(TC), buy: low(TD) }),
        ]);
        expect(ofKind.map((r) => decode(r).domain.chainId)).toEqual(
          [C1, C1, C1, C2].map((id) => ethers.toQuantity(id!)),
        );
      }
    });

    it("signs every control on its own chain's pair", async () => {
      const recs = await recordAll(HOOK_CHAINS, UNLISTED, undefined, {
        [C1]: [{ sell: TA, buy: TB }],
        [C2]: [{ sell: TC, buy: TD }],
      });
      expect(recs.filter((r) => r.c.expect === 'ALLOW').map(tokens)).toEqual([
        expect.objectContaining({ sell: low(TA), buy: low(TB) }),
        expect.objectContaining({ sell: low(TA), buy: low(TB) }),
        expect.objectContaining({ sell: low(TC), buy: low(TD) }),
        expect.objectContaining({ sell: low(TC), buy: low(TD) }),
      ]);
    });

    it('refuses a chain with no pairs', () => {
      expect(() => build([{ chainId: C1!, pairs: [] }])).toThrow(/no token pairs/);
    });
  });

  // A settler config that lists a Solana chain makes the settler set emit an ed25519 ALLOW the hook
  // user inherits. The ed25519 rows are the only proof that the hook fence denies that encoding, so
  // a Solana-configured run without a Solana address must refuse to build rather than quietly
  // produce a matrix that passes without that proof. The function derives "Solana configured" from
  // the chains map itself, so these tests drive it through that map rather than a precomputed flag.
  describe('Solana coverage tied to the settler config chains', () => {
    function build(configChains: Readonly<Record<string, { kind: string }>>, solanaAddress?: string) {
      return cowswapHookCases({
        hookChains: chainsOf(HOOK_CHAINS),
        unlistedChainId: UNLISTED,
        wallet: WALLET,
        configChains,
        ...(solanaAddress === undefined ? {} : { solanaAddress }),
        client: () => fakeClient() as unknown as TurnkeyClient,
      });
    }

    it('throws synchronously, naming --solana-address, when the chains map has a solana entry but no address is given', () => {
      const client = vi.fn();
      expect(() =>
        cowswapHookCases({
          hookChains: chainsOf(HOOK_CHAINS),
          unlistedChainId: UNLISTED,
          wallet: WALLET,
          configChains: WITH_SOLANA_CHAINS,
          client: client as unknown as () => TurnkeyClient,
        }),
      ).toThrow(/--solana-address/);
      expect(client).not.toHaveBeenCalled();
    });

    // Detection keys off the entry's kind, not the map key, so a Solana chain is recognised however
    // the config names it.
    it('derives Solana from an entry kind regardless of the map key', () => {
      expect(() => build({ ...EVM_ONLY_CHAINS, 'settler-sol': { kind: 'solana' } })).toThrow(
        /--solana-address/,
      );
    });

    it.each([
      ['evm-only', EVM_ONLY_CHAINS],
      ['evm and tron', EVM_TRON_CHAINS],
    ] as const)(
      'builds without throwing and emits no ed25519 row for an %s chains map',
      (_label, chains) => {
        let cases: CowswapHookCase[] = [];
        expect(() => {
          cases = build(chains);
        }).not.toThrow();
        expect(cases.length).toBeGreaterThan(0);
        expect(cases.filter((c) => c.name.includes('ed25519')).map((c) => c.name)).toEqual([]);
      },
    );

    it('treats an empty chains map as no Solana and builds without throwing', () => {
      let cases: CowswapHookCase[] = [];
      expect(() => {
        cases = build({});
      }).not.toThrow();
      expect(cases.length).toBeGreaterThan(0);
      expect(cases.filter((c) => c.name.includes('ed25519')).map((c) => c.name)).toEqual([]);
    });

    it('emits the two ed25519 DENY rows signing with the Solana address when the chains map has a solana entry', async () => {
      const recs = await recordAll(HOOK_CHAINS, UNLISTED, SOLANA);
      const ed = recs.filter((r) => r.c.name.includes('ed25519'));
      expect(ed).toHaveLength(2);
      for (const r of ed) {
        expect(r.c.expect, r.c.name).toBe('DENY');
        expect(r.method, r.c.name).toBe('signRawPayload');
        expect(rawInput(r).signWith, r.c.name).toBe(SOLANA);
      }
    });
  });
});

// `--as` must pin the run to the named user's id, never to whichever user is listed first.
describe('fencedUserFor and assertAuthenticatedAs', () => {
  const USERS = [
    { userId: '11111111-1111-4111-8111-111111111111', userName: 'cowswap-hook' },
    { userId: '22222222-2222-4222-8222-222222222222', userName: 'cowswap-swap-cli' },
  ];

  it('returns the user the name picks, including one that is not listed first', () => {
    expect(fencedUserFor(USERS, 'cowswap-swap-cli')).toBe(USERS[1]);
    expect(fencedUserFor(USERS, 'cowswap-hook')).toBe(USERS[0]);
  });

  it('refuses a name no listed user has, naming the listed ones', () => {
    expect(() => fencedUserFor(USERS, 'Cowswap-Hook')).toThrow(/cowswap-hook, cowswap-swap-cli/);
  });

  it("refuses credentials of another listed user, and accepts the named user's in any case", () => {
    const picked = fencedUserFor(USERS, 'cowswap-swap-cli');
    expect(() => assertAuthenticatedAs(USERS[0]!.userId, picked.userId, 'cowswap-swap-cli')).toThrow(USERS[0]!.userId);
    expect(() => assertAuthenticatedAs(undefined, picked.userId, 'cowswap-swap-cli')).toThrow(/unknown user/);
    expect(() => assertAuthenticatedAs(picked.userId.toUpperCase(), picked.userId, 'cowswap-swap-cli')).not.toThrow();
  });
});
