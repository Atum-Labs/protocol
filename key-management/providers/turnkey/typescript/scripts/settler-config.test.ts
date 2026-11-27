import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { derivePoliciesFromAllowlist } from '../src/admin';
import { assertAllowanceGrantsFenced, toSigningPolicy } from './settler-config';

/** What the settler signs (settler-agent `defaultAllowedSelectors`). Tron has no reserve or authorizeFulfillment. */
const EVM_ESCROW = ['0xf2eb65e0', '0x63d478ca', '0xb4b6913b', '0xdf851fad', '0x269b634d', '0xeeb69408', '0x165b3f36'];
const EVM_PROXY = ['0xf0630329', '0x7905fbfa', '0xda00124e', '0x15922c85'];
const TRON_ESCROW = EVM_ESCROW.filter((s) => s !== '0xb4b6913b');
const TRON_PROXY = EVM_PROXY.filter((s) => s !== '0x15922c85');
const TOKEN = ['0x095ea7b3'];

const dir = path.join(__dirname, 'config');
const settlerExample = () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.example.yaml'));
  const cfgs = files.map((f) => parseYaml(fs.readFileSync(path.join(dir, f), 'utf8')));
  const settler = cfgs.find((c) => c?.type === 'settler');
  expect(settler).toBeDefined();
  return settler;
};

describe('the settler example config through toSigningPolicy and the generator', () => {
  const cfg = settlerExample();
  const chains = Object.entries<{ allowedTo: string[]; allowedSelectorsByTo: Record<string, string[]> }>(
    cfg.allowlists,
  ).filter(([key]) => ['evm', 'tron'].includes(cfg.chains[key]?.kind));

  it('covers every EVM and Tron chain the example lists', () => {
    expect(chains.map(([key]) => cfg.chains[key].kind)).toContain('tron');
    expect(chains.length).toBeGreaterThanOrEqual(10);
  });

  it.each(chains.map(([key]) => [key]))('%s: allowedTo binds every address to its selectors', (key) => {
    const allow = cfg.allowlists[key];
    const kind = cfg.chains[key].kind as 'evm' | 'tron';
    const allowedTo = derivePoliciesFromAllowlist(toSigningPolicy(allow), kind, { chainId: cfg.chains[key].chainId })
      .filter((p) => p.policyName.startsWith('allowedTo'));
    expect(allowedTo).toHaveLength(1);
    const target = (to: string) => (kind === 'evm' ? `eth.tx.to == '${to.toLowerCase()}'` : `c.contract_address == '${to}'`);
    const field = kind === 'evm' ? 'eth.tx.data[0..10] ==' : 'c.data[0..8] ==';
    for (const to of allow.allowedTo) expect(allowedTo[0]!.condition).toContain(`(${target(to)} && (${field}`);
  });

  // The example's testnet contracts; any other address is a settlement token.
  const ROLE_BY_ADDRESS: Record<string, string[]> = {
    '0x0f875601504c9179562506afa34b2d084268869b': EVM_ESCROW,
    '0x1f1f8fa642bc5f530ba37f1db3a656e9eb8bafeb': EVM_PROXY,
    '0x3f2f4fa9ea195028f534851ddfd26994e4e3700c': EVM_PROXY,
    '0xd1254ef0f2bc75ad577fe48fc5cc9c3ec13b0144': EVM_PROXY,
    TNW6knfy7gD5W8meUAj9cdqpjFZVHN4vUw: TRON_ESCROW,
    TH88i2DKyLwjtH8hMzXTqSzGLr7U6eprbZ: TRON_PROXY,
  };

  it.each(chains.map(([key]) => [key]))('%s: each address carries exactly its settler role list', (key) => {
    const map = cfg.allowlists[key].allowedSelectorsByTo as Record<string, string[]>;
    for (const [to, list] of Object.entries(map)) {
      const role = ROLE_BY_ADDRESS[cfg.chains[key].kind === 'evm' ? to.toLowerCase() : to] ?? TOKEN;
      expect(list.map((s) => s.toLowerCase()), `${key} ${to}`).toEqual(role);
    }
  });

  it('fences every token it lets the settler approve', () => {
    expect(() => assertAllowanceGrantsFenced(cfg)).not.toThrow();
  });
});

describe('assertAllowanceGrantsFenced', () => {
  const EVM_TOKEN = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
  const T_TOKEN = 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';
  const chains = { E: { kind: 'evm', chainId: 'eip155:1' }, T: { kind: 'tron', chainId: 'tron:shasta' } } as const;
  const evmDeny = (token = EVM_TOKEN.slice(2)) => ({ E: { tokenContractsHex: [token], allowedSpendersHex: ['ab'.repeat(20)] } });
  const tronDeny = (token = T_TOKEN) => ({ T: { tokenContractsBase58: [token], allowedSpendersHex: ['ab'.repeat(20)] } });
  const check = (allowlists: Record<string, unknown>, approveDeny?: Record<string, unknown>) => () =>
    assertAllowanceGrantsFenced({ chains, allowlists, approveDeny } as never);
  const evmMap = (sels: string[] | 'any', to = EVM_TOKEN) => ({ E: { allowedTo: [to], allowedSelectorsByTo: { [to]: sels } } });
  const tronMap = (sels: string[] | 'any', to = T_TOKEN) => ({ T: { allowedTo: [to], allowedSelectorsByTo: { [to]: sels } } });

  it.each([
    ['approve with no approveDeny block', evmMap(['0x095ea7b3']), undefined],
    ['approve with another chain fenced', evmMap(['0x095ea7b3']), { tron: tronDeny() }],
    ['approve with another token fenced', evmMap(['0x095ea7b3']), { evm: evmDeny('cd'.repeat(20)) }],
    ['increaseAllowance alone', evmMap(['0x39509351']), undefined],
    ['increaseApproval alone', evmMap(['0xd73dd623']), undefined],
    ['approveAndCall alone', evmMap(['0xcae9ca51']), undefined],
    ['an upper-case selector', evmMap(['0X095EA7B3']), undefined],
    ["'any'", evmMap('any'), undefined],
    ['Tron approve with no entry', tronMap(['0x095ea7b3']), { evm: evmDeny() }],
    ['Tron token fenced under another case', tronMap(['0x095ea7b3']), { tron: tronDeny(T_TOKEN.toLowerCase()) }],
    // The deny emits the token as written and Turnkey reports eth.tx.to lowercase, so it never matches.
    ['an EVM token fenced only in checksum case', evmMap(['0x095ea7b3']), { evm: evmDeny('1C7D4B196Cb0C7B01d743Fbc6116a902379C7238') }],
  ])('refuses %s', (_name, allowlists, approveDeny) => {
    expect(check(allowlists, approveDeny)).toThrow(/grant an allowance on 1 address/);
  });

  it.each([
    ['approve on a fenced EVM token', evmMap(['0x095ea7b3']), { evm: evmDeny() }],
    ['a fenced EVM token under mixed case', evmMap(['0x095ea7b3'], '0x1C7D4B196Cb0C7B01d743Fbc6116a902379C7238'), { evm: evmDeny() }],
    ['approve on a fenced Tron token', tronMap(['0x095ea7b3']), { tron: tronDeny() }],
    ['a list without allowance grants', evmMap(['0xa457c2d7', '0xf2eb65e0']), undefined],
    ['a chain without the map', { E: { allowedTo: [EVM_TOKEN] } }, undefined],
    ['a chain missing from chains', { X: evmMap(['0x095ea7b3']).E }, undefined],
  ])('accepts %s', (_name, allowlists, approveDeny) => {
    expect(check(allowlists, approveDeny)).not.toThrow();
  });

  it('names every offending address, across chains and within one chain', () => {
    const other = '0x' + 'cd'.repeat(20);
    const allowlists = {
      E: { allowedTo: [EVM_TOKEN, other], allowedSelectorsByTo: { [EVM_TOKEN]: ['0x095ea7b3'], [other]: 'any' } },
      ...tronMap('any'),
    };
    expect(check(allowlists)).toThrow(/3 address\(es\)[\s\S]*E: 0x1c7d[\s\S]*E: 0xcdcd[\s\S]*T: TG3X/);
  });

  it('refuses a 0x-prefixed deny token, which the deny would emit as 0x0x and never match', () => {
    expect(check(evmMap(['0x095ea7b3']), { evm: evmDeny(EVM_TOKEN) })).toThrow(/1 address/);
  });
});
