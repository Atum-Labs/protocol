// Stellar policy emission across the four emitters. Turnkey documents no Stellar transaction
// parsing, so everything here is a raw-payload fence: encoding, hash function and wallet account.
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import type { SigningPolicy } from '@atum-labs/km-core';

import { buildAllowStellarRawPayloadPolicy, derivePoliciesFromAllowlist } from './policies';
import { buildSenderPolicies } from './sender-policies';
import type { ChainEntry } from './sender-policies';
import { buildSettlerRawPayloadPolicies } from './settler-policies';
import { buildVerifierPolicies } from './verifier-policies';

const G1 = Keypair.random().publicKey();
const G2 = Keypair.random().publicKey();
const ZERO = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));
const STELLAR: ChainEntry = { key: 'Stellar', kind: 'stellar', chainId: 'stellar:testnet' };
const SOLANA: ChainEntry = {
  key: 'Solana',
  kind: 'solana',
  chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};
const BASE: SigningPolicy = { requireChainIdMatch: true, maxNativeValue: '0' };
const ALLOW = 'allowStellarEd25519RawPayload';

describe('buildAllowStellarRawPayloadPolicy', () => {
  const both = ['PAYLOAD_ENCODING_HEXADECIMAL', 'PAYLOAD_ENCODING_TEXT_UTF8'] as const;

  it('scopes the allow to the listed accounts, NOT_APPLICABLE and the signing activity only', () => {
    const p = buildAllowStellarRawPayloadPolicy({ role: 'Settler', signers: [G1], encodings: both });
    expect(p.policyName).toBe(ALLOW);
    expect(p.effect).toBe('EFFECT_ALLOW');
    expect(p.condition).toBe(
      `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && ` +
        `activity.params.encoding in ['PAYLOAD_ENCODING_HEXADECIMAL', 'PAYLOAD_ENCODING_TEXT_UTF8'] && ` +
        `activity.params.hash_function == 'HASH_FUNCTION_NOT_APPLICABLE' && ` +
        `wallet_account.address in ['${G1}']`,
    );
  });

  it('uses an equality test for a single encoding', () => {
    const p = buildAllowStellarRawPayloadPolicy({
      role: 'Verifier',
      signers: [G1],
      encodings: ['PAYLOAD_ENCODING_HEXADECIMAL'],
    });
    expect(p.condition).toContain("activity.params.encoding == 'PAYLOAD_ENCODING_HEXADECIMAL'");
    expect(p.condition).not.toContain('TEXT_UTF8');
  });

  it('is deterministic: duplicates collapse and order does not change the condition', () => {
    const a = buildAllowStellarRawPayloadPolicy({ role: 'x', signers: [G1, G2, G1], encodings: both });
    const b = buildAllowStellarRawPayloadPolicy({ role: 'x', signers: [G2, G1], encodings: [...both].reverse() });
    expect(a.condition).toBe(b.condition);
  });

  it('refuses no signers, a placeholder, a bad checksum and a non-Stellar address, naming the role', () => {
    const mk = (signers: string[]) => () =>
      buildAllowStellarRawPayloadPolicy({ role: 'Sender extras', signers, encodings: both });
    expect(mk([])).toThrow(/Sender extras: a Stellar chain needs/);
    expect(mk([ZERO])).toThrow(/Sender extras: .* not a usable Stellar account id/);
    expect(mk([G1.slice(0, -1) + (G1.endsWith('A') ? 'B' : 'A')])).toThrow(/not a usable/);
    expect(mk(['0x' + '11'.repeat(20)])).toThrow(/not a usable/);
    expect(mk([G1, "G' || true"])).toThrow(/not a usable/);
  });
});

describe('derivePoliciesFromAllowlist for stellar', () => {
  it('emits nothing: Turnkey cannot enforce anything per Stellar transaction', () => {
    expect(derivePoliciesFromAllowlist(BASE, 'stellar', { chainId: STELLAR.chainId })).toEqual([]);
  });

  it.each([
    ['allowedTo', { allowedTo: ['CABC'] }],
    ['allowedSelectors', { allowedSelectors: ['fulfill'] }],
    ['allowedSelectorsByTo', { allowedSelectorsByTo: { CABC: 'any' as const } }],
    ['allowedPrograms', { allowedPrograms: ['CABC'] }],
    ['allowedAnchorDiscriminators', { allowedAnchorDiscriminators: { CABC: 'any' as const } }],
  ])('refuses %s rather than letting an operator believe it is a server-side fence', (field, extra) => {
    expect(() =>
      derivePoliciesFromAllowlist({ ...BASE, ...extra } as SigningPolicy, 'stellar', {
        chainId: STELLAR.chainId,
      }),
    ).toThrow(new RegExp(`${field} cannot be enforced by Turnkey`));
  });
});

describe('settler policy set with a Stellar chain', () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    chains: [STELLAR],
    transferWithAuthorizationTokens: {},
    evmAddress: '0x551DfeD720649704E79f4aa6ee6a227ce0139796',
    stellarSigners: { Stellar: [G1] },
    ...over,
  });

  it('emits the scoped Stellar allow, with text and hex, ahead of the shared denies', () => {
    const out = buildSettlerRawPayloadPolicies(ctx());
    const names = out.map((p) => p.policyName);
    expect(names).toContain(ALLOW);
    expect(names.indexOf(ALLOW)).toBeLessThan(names.indexOf('denyNonTypedDataHashFunctions'));
    const allow = out.find((p) => p.policyName === ALLOW)!;
    expect(allow.condition).toContain('PAYLOAD_ENCODING_TEXT_UTF8');
    expect(allow.condition).toContain(`wallet_account.address in ['${G1}']`);
    // No Stellar chain, no Solana chain: the unscoped ed25519 allow must not appear.
    expect(names).not.toContain('allowEd25519RawPayload');
  });

  it('emits nothing Stellar when no Stellar chain is listed (existing sub-orgs are unchanged)', () => {
    const out = buildSettlerRawPayloadPolicies(ctx({ chains: [SOLANA], stellarSigners: undefined }));
    expect(out.map((p) => p.policyName)).not.toContain(ALLOW);
    expect(out.map((p) => p.policyName)).toContain('allowEd25519RawPayload');
  });

  it('refuses a Stellar chain with no stellarSigners instead of emitting an unscoped allow', () => {
    expect(() => buildSettlerRawPayloadPolicies(ctx({ stellarSigners: undefined }))).toThrow(
      /Stellar chain "Stellar" has no stellarSigners/,
    );
    expect(() => buildSettlerRawPayloadPolicies(ctx({ stellarSigners: { Stellar: [] } }))).toThrow(
      /no stellarSigners/,
    );
  });

  it('keeps the digest-signing denies in force', () => {
    const names = buildSettlerRawPayloadPolicies(ctx()).map((p) => p.policyName);
    expect(names).toEqual(
      expect.arrayContaining([
        'denyNonTypedDataHashFunctions',
        'denyAccountDelegationEncoding',
        'denyBatchRawPayloads',
      ]),
    );
  });
});

describe('sender policy set with a Stellar chain', () => {
  const extras = (over: Record<string, unknown> = {}) =>
    ({ network: 'testnet', allowedTokens: {}, stellarSigners: { Stellar: [G1] }, ...over }) as never;

  it('emits the scoped Stellar allow and nothing for the chain beyond it', () => {
    const out = buildSenderPolicies(extras(), [STELLAR]);
    expect(out.map((p) => p.policyName)).toContain(ALLOW);
    expect(out.some((p) => p.policyName.includes(STELLAR.chainId))).toBe(false);
  });

  it('refuses a Stellar chain with no stellarSigners', () => {
    expect(() => buildSenderPolicies(extras({ stellarSigners: undefined }), [STELLAR])).toThrow(
      /needs its signing account|no stellarSigners/,
    );
  });
});

describe('verifier policy set with a Stellar chain', () => {
  const extras = (over: Record<string, unknown> = {}) =>
    ({ escrows: {}, releasers: {}, stellarSigners: { Stellar: [G1] }, ...over }) as never;

  it('allows hex only: the verifier signs binary witness digests, never the text handshake', () => {
    const p = buildVerifierPolicies(extras(), [STELLAR]).find((x) => x.policyName === ALLOW)!;
    expect(p.condition).toContain("activity.params.encoding == 'PAYLOAD_ENCODING_HEXADECIMAL'");
    expect(p.condition).not.toContain('TEXT_UTF8');
    expect(p.condition).toContain(`wallet_account.address in ['${G1}']`);
  });

  it('still refuses to sign any transaction, which is what keeps a Stellar tx off this key', () => {
    const out = buildVerifierPolicies(extras(), [STELLAR]);
    expect(out.find((x) => x.policyName === 'denySignTransaction')?.effect).toBe('EFFECT_DENY');
  });

  it('refuses a Stellar chain with no stellarSigners', () => {
    expect(() => buildVerifierPolicies(extras({ stellarSigners: {} }), [STELLAR])).toThrow(
      /Stellar chain "Stellar" has no stellarSigners/,
    );
  });

  it('emits no Stellar allow without a Stellar chain', () => {
    const out = buildVerifierPolicies(extras(), []);
    expect(out.map((x) => x.policyName)).not.toContain(ALLOW);
  });
});

// Evaluates a policy condition of `field == 'v'` / `field in ['a', ...]` clauses joined by `&&`
// against one activity. A clause it cannot read counts as `unknown` (true for a deny, false for an
// allow), so the check below can only err toward failing.
function matches(condition: string, activity: Record<string, string>, unknown: boolean): boolean {
  return condition.split(' && ').every((clause) => {
    const eq = /^([\w.]+) == '([^']*)'$/.exec(clause.trim());
    if (eq && eq[1]! in activity) return activity[eq[1]!] === eq[2];
    const inList = /^([\w.]+) in \[(.*)\]$/.exec(clause.trim());
    if (inList && inList[1]! in activity) {
      return inList[2]!
        .split(',')
        .map((s) => s.trim().replace(/^'|'$/g, ''))
        .includes(activity[inList[1]!]!);
    }
    return unknown;
  });
}

describe('Stellar hex signing with a Solana chain in the same set', () => {
  const hexSign = {
    'activity.type': 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2',
    'activity.resource': 'WALLET',
    'activity.params.encoding': 'PAYLOAD_ENCODING_HEXADECIMAL',
    'activity.params.hash_function': 'HASH_FUNCTION_NOT_APPLICABLE',
    'wallet_account.address': G1,
  };
  const sets = {
    settler: () =>
      buildSettlerRawPayloadPolicies({
        chains: [STELLAR, SOLANA],
        transferWithAuthorizationTokens: {},
        evmAddress: '0x551DfeD720649704E79f4aa6ee6a227ce0139796',
        stellarSigners: { Stellar: [G1] },
      }),
    sender: () =>
      buildSenderPolicies(
        {
          network: 'testnet',
          allowedTokens: {},
          escrows: {},
          allowedDestinations: {},
          solanaEscrowProgramId: 'X',
          stellarSigners: { Stellar: [G1] },
        } as never,
        [STELLAR, SOLANA],
      ),
    verifier: () =>
      buildVerifierPolicies(
        {
          escrows: {},
          releasers: {},
          stellarSigners: { Stellar: [G1] },
          solanaSigners: { Solana: ['4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS'] },
        } as never,
        [STELLAR, SOLANA],
      ),
  };

  for (const [role, build] of Object.entries(sets)) {
    it(`${role}: the Stellar allow admits HEXADECIMAL + NOT_APPLICABLE and no deny overrides it`, () => {
      const out = build();
      const allow = out.find((p) => p.policyName === ALLOW)!;
      expect(matches(allow.condition, hexSign, false)).toBe(true);
      const overriding = out.filter(
        (p) => p.effect === 'EFFECT_DENY' && matches(p.condition, hexSign, true),
      );
      expect(overriding.map((p) => p.policyName)).toEqual([]);
    });
  }
});
