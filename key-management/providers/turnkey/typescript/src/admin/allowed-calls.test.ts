import { describe, expect, it } from 'vitest';

import type { SigningPolicy } from '@atum-labs/km-core';

import {
  buildDenyApproveToNonAllowedSpenderEvm,
  buildDenyApproveToNonAllowedSpenderTron,
  derivePoliciesFromAllowlist,
  selectorAllowedFor,
  type PolicyDefinition,
  type TurnkeyAllowlistPolicy,
} from './policies';

const BASE: SigningPolicy = { requireChainIdMatch: true, maxNativeValue: '0' };
const SELF = '0xe85c89453dd46c95909a0a15e265f9b84a6378d6';

const ESCROW = '0x0f875601504c9179562506afa34b2d084268869b';
const PROXY = '0x1f1f8fa642bc5f530ba37f1db3a656e9eb8bafeb';
const TOKEN = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const TOKEN_MIXED = '0x1C7D4B196Cb0C7B01d743Fbc6116a902379C7238';

const T_ESCROW = 'TNW6knfy7gD5W8meUAj9cdqpjFZVHN4vUw';
const T_PROXY = 'TH88i2DKyLwjtH8hMzXTqSzGLr7U6eprbZ';
const T_TOKEN = 'TG3XXyExBkPp9nzdajDZsozEu4BkaSJozs';

const APPROVE = '0x095ea7b3';
const INCREASE_ALLOWANCE = '0x39509351';
const INCREASE_APPROVAL = '0xd73dd623';
const APPROVE_AND_CALL = '0xcae9ca51';
const DECREASE_ALLOWANCE = '0xa457c2d7';
const TRANSFER = '0xa9059cbb';
const FULFILL = '0xf0630329';
const DEPOSIT = '0xf2eb65e0';

const evm = (p: Partial<TurnkeyAllowlistPolicy>) =>
  derivePoliciesFromAllowlist({ ...BASE, ...p } as TurnkeyAllowlistPolicy, 'evm', {
    chainId: 'eip155:11155111',
    selfAddress: SELF,
  });
const tron = (p: Partial<TurnkeyAllowlistPolicy>) =>
  derivePoliciesFromAllowlist({ ...BASE, ...p } as TurnkeyAllowlistPolicy, 'tron', {
    chainId: 'tron:shasta',
  });
const named = (out: PolicyDefinition[], prefix: string) =>
  out.filter((p) => p.policyName.startsWith(prefix));
const txAllows = (out: PolicyDefinition[]) =>
  out.filter(
    (p) => p.effect === 'EFFECT_ALLOW' && p.condition.includes('ACTIVITY_TYPE_SIGN_TRANSACTION_V2'),
  );

describe('derivePoliciesFromAllowlist without allowedSelectorsByTo', () => {
  // Every live settler config has no selector map, so its output must not move.
  it('emits the EVM allowedTo condition byte for byte as before', () => {
    const out = evm({ allowedTo: [ESCROW, TOKEN_MIXED] });
    expect(named(out, 'allowedTo')).toEqual([
      {
        policyName: 'allowedTo (eip155:11155111)',
        effect: 'EFFECT_ALLOW',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == 11155111 && (eth.tx.to == '${ESCROW}' || eth.tx.to == '${TOKEN}')`,
        notes: 'Mirrors SigningPolicy.allowedTo for this chain.',
      },
    ]);
  });

  it('emits the Tron allowedTo condition byte for byte as before', () => {
    const out = tron({ allowedTo: [T_ESCROW, T_PROXY] });
    expect(named(out, 'allowedTo')).toEqual([
      {
        policyName: 'allowedTo (tron:shasta)',
        effect: 'EFFECT_ALLOW',
        condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && tron.tx.contract.all(c, c.contract_address in ['${T_ESCROW}', '${T_PROXY}'])`,
        notes: 'Tron allowedTo — every contract in the tx must be in the allowlist.',
      },
    ]);
  });
});

describe('derivePoliciesFromAllowlist binds each contract to its selectors (EVM)', () => {
  const map = {
    [ESCROW]: [DEPOSIT],
    [PROXY]: 'any' as const,
    [TOKEN_MIXED]: [APPROVE.toUpperCase().replace('0X', '0x')],
  };
  const out = evm({ allowedTo: [ESCROW, PROXY, TOKEN], allowedSelectorsByTo: map });

  it('emits one allowedTo ALLOW whose clauses bind each address to its own selectors', () => {
    expect(named(out, 'allowedTo')).toHaveLength(1);
    expect(named(out, 'allowedTo')[0]!.condition).toBe(
      `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == 11155111 && (` +
        `(eth.tx.to == '${ESCROW}' && (eth.tx.data[0..10] == '${DEPOSIT}')) || ` +
        `eth.tx.to == '${PROXY}' || ` +
        `(eth.tx.to == '${TOKEN}' && (eth.tx.data[0..10] == '${APPROVE}')))`,
    );
  });

  it('matches the selector on raw calldata, never on the ABI-decoded function_signature', () => {
    // Turnkey fills function_signature only for an uploaded ABI, and an ALLOW that errors refuses.
    expect(named(out, 'allowedTo')[0]!.condition).not.toContain('function_signature');
  });

  it('leaves no SIGN_TRANSACTION ALLOW that admits the token without its selector', () => {
    // The ticket case: transfer() on an allowlisted token whose list holds only approve().
    expect(
      selectorAllowedFor({ ...BASE, allowedTo: [ESCROW, PROXY, TOKEN], allowedSelectorsByTo: map }, 'evm', TOKEN, TRANSFER),
    ).toBe(false);
    for (const p of txAllows(out)) {
      if (p.policyName.startsWith('allowSelfSendNonceBurn')) {
        expect(p.condition).not.toContain(TOKEN);
        continue;
      }
      expect(p.condition).not.toContain(`eth.tx.to == '${TOKEN}' ||`);
      expect(p.condition).not.toContain(`eth.tx.to == '${TOKEN}')`);
      expect(p.condition).not.toContain(TRANSFER);
    }
    expect(named(out, 'allowedSelectors')).toEqual([]);
  });

  it('ORs several selectors with == only (no `in`)', () => {
    const two = evm({
      allowedTo: [TOKEN],
      allowedSelectorsByTo: { [TOKEN]: [APPROVE, APPROVE, INCREASE_ALLOWANCE] },
    });
    expect(named(two, 'allowedTo')[0]!.condition).toContain(
      `(eth.tx.to == '${TOKEN}' && (eth.tx.data[0..10] == '${APPROVE}' || eth.tx.data[0..10] == '${INCREASE_ALLOWANCE}'))`,
    );
    expect(named(two, 'allowedTo')[0]!.condition).not.toContain(' in [');
  });

  it('leaves the self-send nonce-burn ALLOW untouched', () => {
    const without = evm({ allowedTo: [TOKEN] });
    expect(named(out, 'allowSelfSendNonceBurn')).toEqual(named(without, 'allowSelfSendNonceBurn'));
  });
});

describe('derivePoliciesFromAllowlist binds each contract to its selectors (Tron)', () => {
  it('binds inside contract.all so every contract in a multi-contract tx is checked', () => {
    const out = tron({
      allowedTo: [T_ESCROW, T_PROXY, T_TOKEN],
      allowedSelectorsByTo: {
        [T_ESCROW]: [DEPOSIT],
        [T_PROXY]: 'any',
        [T_TOKEN]: ['0x095EA7B3'],
      },
    });
    expect(named(out, 'allowedTo')[0]!.condition).toBe(
      `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && tron.tx.contract.all(c, ` +
        `(c.contract_address == '${T_ESCROW}' && (c.data[0..8] == 'f2eb65e0')) || ` +
        `c.contract_address == '${T_PROXY}' || ` +
        `(c.contract_address == '${T_TOKEN}' && (c.data[0..8] == '095ea7b3')))`,
    );
    expect(named(out, 'allowedSelectors')).toEqual([]);
  });
});

describe('allowedSelectorsByTo refuses configs that would silently widen or fail', () => {
  const ok = { allowedTo: [ESCROW, TOKEN], allowedSelectorsByTo: { [ESCROW]: [DEPOSIT], [TOKEN]: [APPROVE] } };
  it.each<[string, Partial<TurnkeyAllowlistPolicy> & Record<string, unknown>, RegExp]>([
    ['key not in allowedTo', { ...ok, allowedSelectorsByTo: { ...ok.allowedSelectorsByTo, [PROXY]: [FULFILL] } }, /not in allowedTo/],
    ['allowedTo entry with no key', { ...ok, allowedTo: [ESCROW, TOKEN, PROXY] }, /has no allowedSelectorsByTo entry/],
    ['EVM keys colliding after lowercasing', { allowedTo: [TOKEN], allowedSelectorsByTo: { [TOKEN]: [APPROVE], [TOKEN_MIXED]: [APPROVE] } }, /more than once/],
    ['empty list', { ...ok, allowedSelectorsByTo: { ...ok.allowedSelectorsByTo, [TOKEN]: [] } }, /Remove the address from allowedTo/],
    ['null value (bare YAML key)', { ...ok, allowedSelectorsByTo: { ...ok.allowedSelectorsByTo, [TOKEN]: null } }, /non-empty list/],
    ['single string value', { ...ok, allowedSelectorsByTo: { ...ok.allowedSelectorsByTo, [TOKEN]: APPROVE } }, /non-empty list/],
    ['unquoted selector parsed as a number', { ...ok, allowedSelectorsByTo: { ...ok.allowedSelectorsByTo, [TOKEN]: [0x095ea7b3] } }, /quoted 0x-prefixed/],
    ['selector without 0x', { ...ok, allowedSelectorsByTo: { ...ok.allowedSelectorsByTo, [TOKEN]: ['095ea7b3'] } }, /quoted 0x-prefixed/],
    ['selector too long', { ...ok, allowedSelectorsByTo: { ...ok.allowedSelectorsByTo, [TOKEN]: ['0x095ea7b300'] } }, /quoted 0x-prefixed/],
    ['empty-string selector', { ...ok, allowedSelectorsByTo: { ...ok.allowedSelectorsByTo, [TOKEN]: [''] } }, /quoted 0x-prefixed/],
    ['map is a list', { ...ok, allowedSelectorsByTo: [APPROVE] }, /must be a map/],
    ['allowedTo is any', { ...ok, allowedTo: 'any' }, /non-empty allowedTo list/],
    ['allowedTo missing', { allowedSelectorsByTo: ok.allowedSelectorsByTo }, /non-empty allowedTo list/],
    ['global allowedSelectors as well', { ...ok, allowedSelectors: [APPROVE] }, /not both/],
  ])('EVM: %s', (_label, p, re) => {
    expect(() => evm(p as Partial<TurnkeyAllowlistPolicy>)).toThrow(re);
  });

  it('Tron matches base58 exactly, so a key differing only in case is refused', () => {
    expect(() =>
      tron({ allowedTo: [T_TOKEN], allowedSelectorsByTo: { [T_TOKEN.toLowerCase()]: [APPROVE] } }),
    ).toThrow(/not in allowedTo/);
  });

  it('refuses the map on Solana, which binds programs through allowedAnchorDiscriminators', () => {
    expect(() =>
      derivePoliciesFromAllowlist(
        { ...BASE, allowedPrograms: ['11111111111111111111111111111111'], allowedSelectorsByTo: {} } as TurnkeyAllowlistPolicy,
        'solana',
        { chainId: 'solana:devnet' },
      ),
    ).toThrow(/allowedAnchorDiscriminators/);
  });
});

describe('selectorAllowedFor mirrors what the emitted set grants', () => {
  const mapped = { ...BASE, allowedTo: [ESCROW, TOKEN], allowedSelectorsByTo: { [ESCROW]: 'any', [TOKEN]: [APPROVE] } } as TurnkeyAllowlistPolicy;
  it.each<[string, TurnkeyAllowlistPolicy, 'evm' | 'tron', string, string | undefined, boolean]>([
    ['listed selector', mapped, 'evm', TOKEN_MIXED, '0x095EA7B3', true],
    ['unlisted selector', mapped, 'evm', TOKEN, TRANSFER, false],
    ['empty calldata on a bound token', mapped, 'evm', TOKEN, undefined, false],
    ["'any' address, any selector", mapped, 'evm', ESCROW, TRANSFER, true],
    ['address outside allowedTo', mapped, 'evm', PROXY, APPROVE, false],
    ['no map: any selector on an allowlisted address', { ...BASE, allowedTo: [TOKEN] }, 'evm', TOKEN, TRANSFER, true],
    ['no map: global selector reaches any address', { ...BASE, allowedTo: [TOKEN], allowedSelectors: [FULFILL] }, 'evm', PROXY, FULFILL, true],
    ['tron listed selector', { ...BASE, allowedTo: [T_TOKEN], allowedSelectorsByTo: { [T_TOKEN]: [APPROVE] } } as TurnkeyAllowlistPolicy, 'tron', T_TOKEN, APPROVE, true],
    ['tron unlisted selector', { ...BASE, allowedTo: [T_TOKEN], allowedSelectorsByTo: { [T_TOKEN]: [APPROVE] } } as TurnkeyAllowlistPolicy, 'tron', T_TOKEN, INCREASE_ALLOWANCE, false],
  ])('%s', (_label, policy, chain, to, selector, expected) => {
    expect(selectorAllowedFor(policy, chain, to, selector)).toBe(expected);
  });
});

describe('approve deny also covers increaseAllowance', () => {
  const SPENDER = PROXY.slice(2);
  const evmDeny = buildDenyApproveToNonAllowedSpenderEvm({
    chainId: 'eip155:11155111',
    tokenContractsHex: [TOKEN.slice(2)],
    allowedSpendersHex: [SPENDER],
  });
  const tronDeny = buildDenyApproveToNonAllowedSpenderTron({
    chainId: 'tron:shasta',
    tokenContractsBase58: [T_TOKEN],
    allowedSpendersHex: [SPENDER],
  });

  it('keeps the policy names, so a live apply replaces them in place', () => {
    expect(evmDeny.policyName).toBe('denyApproveToNonAllowedSpender (eip155:11155111)');
    expect(tronDeny.policyName).toBe('denyApproveToNonAllowedSpender (tron:shasta)');
  });

  it('EVM: denies every allowance grant whose spender is outside the list', () => {
    const sig = (s: string) => `eth.tx.data[0..10] == '${s}'`;
    expect(evmDeny.condition).toBe(
      `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && eth.tx.chain_id == 11155111 && ` +
        `(${sig(APPROVE)} || ${sig(INCREASE_ALLOWANCE)} || ${sig(INCREASE_APPROVAL)} || ${sig(APPROVE_AND_CALL)}) && ` +
        `eth.tx.to in ['${TOKEN}'] && !(eth.tx.data[34..74] in ['${SPENDER}'])`,
    );
    expect(evmDeny.condition).not.toContain(DECREASE_ALLOWANCE);
  });

  it('Tron: denies every allowance grant whose spender is outside the list', () => {
    expect(tronDeny.condition).toBe(
      `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && tron.tx.contract.any(c, ` +
        `c.type == 'TriggerSmartContract' && c.contract_address in ['${T_TOKEN}'] && ` +
        `(c.data[0..8] == '095ea7b3' || c.data[0..8] == '39509351' || ` +
        `c.data[0..8] == 'd73dd623' || c.data[0..8] == 'cae9ca51') && ` +
        `!(c.data[32..72] in ['${SPENDER}']))`,
    );
    expect(tronDeny.condition).not.toContain(DECREASE_ALLOWANCE.slice(2));
  });

  it('still refuses empty token or spender lists', () => {
    expect(() =>
      buildDenyApproveToNonAllowedSpenderEvm({ chainId: 'eip155:1', tokenContractsHex: [], allowedSpendersHex: [SPENDER] }),
    ).toThrow(/non-empty/);
    expect(() =>
      buildDenyApproveToNonAllowedSpenderTron({ chainId: 'tron:shasta', tokenContractsBase58: [T_TOKEN], allowedSpendersHex: [] }),
    ).toThrow(/non-empty/);
  });
});
