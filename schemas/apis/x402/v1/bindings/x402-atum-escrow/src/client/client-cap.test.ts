/**
 * The payer's bound on what a 402 may charge.
 *
 * A 402 names both the amount the payer deposits on the source chain and the amount the payee
 * receives on the destination chain; the difference is the merchant's markup, and nothing on
 * chain limits it. Once the role addresses are known to be trusted, the remaining attack is a
 * 402 that is honest about WHERE the money goes and dishonest about HOW MUCH: a deposit of 100
 * for a fulfillment of 10 settles exactly as signed.
 *
 * So before signing, the client prices both legs in units it trusts: each asset must be a token
 * the trust source vouches for on its chain (which supplies its decimals), the two tokens must be
 * comparable (the same symbol, or pegged to the same thing), and the deposit may exceed the
 * fulfillment by at most `maxMarkupBps` once both are scaled to a common precision. Comparing raw
 * atomic amounts would be meaningless across tokens of different decimals — an 18-decimal deposit
 * against a 6-decimal fulfillment looks like a 10^12 markup and the reverse looks like a discount.
 *
 * Every refusal also asserts that the signer was never called, for the same reason as the
 * address checks: the signature is the irreversible step.
 */
import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { Network, PaymentRequirements } from '@x402/core/types';
import {
  AtumEscrowClientScheme,
  AtumEscrowTrustError,
  DEFAULT_MAX_MARKUP_BPS,
  DEFAULT_PEG_GROUPS,
  type AtumEscrowClientConfig,
  type EscrowSigner,
  type SolanaSigner,
  type TrustResolver,
  type TrustedRoles,
} from './index';
import { PAYMENT_IDENTIFIER } from '../payment-identifier';

// Well-known anvil account #0 — a throwaway dev key, safe to commit.
const wallet = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const NOW = () => Date.parse('2026-07-08T12:00:00Z');
const named = {
  extensions: { [PAYMENT_IDENTIFIER]: { info: { required: true, id: 'pay_order_test_0001' } } },
};

const SOURCE: Network = 'eip155:8453';
const DEST: Network = 'eip155:42161';
const ESCROW = '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33';
const RESERVER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const RELEASER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const FULFILLMENT_PROXY = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const ATTACKER = '0xBcd4042DE499D14e55001CcbB24a551F3b954096';

// Tokens the trust sources vouch for. The 18-decimal stablecoins are fictional and exist so the
// decimals scaling can be exercised with the SAME symbol on both legs, isolating it from pegging.
const SRC_USDC = {
  symbol: 'USDC',
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  decimals: 6,
};
const SRC_USDC_18 = {
  symbol: 'USDC',
  address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  decimals: 18,
};
const DST_USDC = {
  symbol: 'USDC',
  address: '0x52e52f345139e57b87d288c9ea794bb3fbe591c3',
  decimals: 6,
};
const DST_USDC_18 = {
  symbol: 'USDC',
  address: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
  decimals: 18,
};
const DST_WETH = {
  symbol: 'WETH',
  address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
  decimals: 18,
};
const DST_PATHUSD = {
  symbol: 'pathUSD',
  address: '0x20c0000000000000000000000000000000000000',
  decimals: 6,
};
const DST_RUSD = {
  symbol: 'rUSD',
  address: '0x09d4214c03d01f49544c0448dbe3a27f768f2b34',
  decimals: 6,
};
const DST_USDT0 = {
  symbol: 'USDT0',
  address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
  decimals: 6,
};
// Fictional: a stablecoin pegged to something other than the US dollar, so in no default group.
const DST_EURC = {
  symbol: 'EURC',
  address: '0x3e1b7a0c8f2d5946a1c3b8e7d6f5a4c3b2a19087',
  decimals: 6,
};
// An ERC-20 address neither trust source lists.
const UNLISTED_TOKEN = '0xdac17f958d2ee523a2206206994597c13d831ec7';

const sourceRoles: TrustedRoles = {
  escrowContract: ESCROW,
  quoteSelector: RESERVER,
  fulfillmentVerifierAccount: RELEASER,
  fulfillmentProxy: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  tokens: [SRC_USDC, SRC_USDC_18],
};
const destRoles: TrustedRoles = {
  escrowContract: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  quoteSelector: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  fulfillmentVerifierAccount: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
  fulfillmentProxy: FULFILLMENT_PROXY,
  tokens: [DST_USDC, DST_USDC_18, DST_WETH, DST_PATHUSD, DST_RUSD, DST_USDT0, DST_EURC],
};

function trustTable(table: Record<string, TrustedRoles>) {
  return vi.fn<TrustResolver>(async (network: string) => {
    const roles = table[network];
    if (roles === undefined) throw new Error(`test trust table has no entry for ${network}`);
    return roles;
  });
}

/** A 402 whose role addresses are all trusted; only the pricing terms vary. */
function corridor(terms: {
  amount: string;
  fulfillmentAmount?: string;
  asset?: string;
  destAsset?: string;
  reserver?: string;
}): PaymentRequirements {
  return {
    scheme: 'atum-escrow',
    network: SOURCE,
    asset: terms.asset ?? SRC_USDC.address,
    amount: terms.amount,
    payTo: ESCROW,
    maxTimeoutSeconds: 60,
    extra: {
      atumResource: 'GET /paid',
      atum: {
        destination: {
          network: DEST,
          asset: terms.destAsset ?? DST_USDC.address,
          address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        },
        fulfillmentAmount: terms.fulfillmentAmount ?? '10000000',
        escrow: ESCROW,
        fulfillmentProxy: FULFILLMENT_PROXY,
        reserver: terms.reserver ?? RESERVER,
        releaser: RELEASER,
        fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
        quoteDeadlineSeconds: 20,
        fulfillmentDeadlineSeconds: 300,
      },
    },
  };
}

/**
 * Build a payment with a signer that records whether it was asked to sign. `config` carries the
 * bound's knobs; the trust source defaults to the table above.
 */
function attempt(
  requirement: PaymentRequirements,
  config: Partial<Pick<AtumEscrowClientConfig, 'maxMarkupBps' | 'pegGroups' | 'trust'>> = {},
) {
  const signTypedData = vi.fn<EscrowSigner['signTypedData']>((domain, types, message) =>
    wallet.signTypedData(domain, types, message),
  );
  const signer: EscrowSigner = { getAddress: async () => wallet.address, signTypedData };
  const scheme = new AtumEscrowClientScheme({
    signer,
    now: NOW,
    trust: trustTable({ [SOURCE]: sourceRoles, [DEST]: destRoles }),
    ...config,
  });
  return { result: scheme.createPaymentPayload(2, requirement, named), signTypedData };
}

/** Assert the payment is built and signed exactly once. */
async function expectSigned(
  requirement: PaymentRequirements,
  config?: Parameters<typeof attempt>[1],
) {
  const { result, signTypedData } = attempt(requirement, config);
  await expect(result).resolves.toBeDefined();
  expect(signTypedData).toHaveBeenCalledTimes(1);
}

/** Assert the payment is refused with a trust error before any signing, and return the error. */
async function expectRefused(
  requirement: PaymentRequirements,
  config?: Parameters<typeof attempt>[1],
): Promise<AtumEscrowTrustError> {
  const { result, signTypedData } = attempt(requirement, config);
  const err = await result.then(
    () => {
      throw new Error('expected the payment to be refused, but it was built');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AtumEscrowTrustError);
  expect(signTypedData).not.toHaveBeenCalled();
  return err as AtumEscrowTrustError;
}

/** Assert a MARKUP_EXCEEDED refusal naming the largest amount that would have passed. */
async function expectMarkupExceeded(
  requirement: PaymentRequirements,
  maxAllowed: string,
  config?: Parameters<typeof attempt>[1],
) {
  const err = await expectRefused(requirement, config);
  expect(err.code).toBe('MARKUP_EXCEEDED');
  expect(err.network).toBe(SOURCE);
  expect(err.field).toMatch(/amount/i);
  expect(err.expected).toBe(maxAllowed);
  expect(err.actual).toBe(requirement.amount);
}

describe('client cap defaults', () => {
  it('bounds the markup at 500 bps by default', () => {
    expect(DEFAULT_MAX_MARKUP_BPS).toBe(500);
  });

  it('pegs exactly the USD stablecoin group by default', () => {
    expect(DEFAULT_PEG_GROUPS).toEqual([
      [
        'USDC',
        'USDC.e',
        'USDT',
        'USDT0',
        'PYUSD',
        'pathUSD',
        'rUSD',
        'SBC',
        'alphaUSD',
        'betaUSD',
        'thetaUSD',
      ],
    ]);
  });
});

describe('AtumEscrowClientScheme — markup bound', () => {
  it('signs an amount exactly at the default bound and refuses one atomic unit over', async () => {
    await expectSigned(corridor({ amount: '10500000' }));
    await expectMarkupExceeded(corridor({ amount: '10500001' }), '10500000');
  });

  it("signs the merchant SDK's 300 bps example under the default bound", async () => {
    await expectSigned(corridor({ amount: '10300000' }));
  });

  it('floors the bound to a whole atomic unit when it is fractional', async () => {
    // 10000001 x 1.05 = 10500001.05: the largest payable integer is 10500001.
    await expectSigned(corridor({ amount: '10500001', fulfillmentAmount: '10000001' }));
    await expectMarkupExceeded(
      corridor({ amount: '10500002', fulfillmentAmount: '10000001' }),
      '10500001',
    );
  });

  it('honours a tighter maxMarkupBps', async () => {
    await expectMarkupExceeded(corridor({ amount: '10300000' }), '10100000', { maxMarkupBps: 100 });
    await expectSigned(corridor({ amount: '10100000' }), { maxMarkupBps: 100 });
  });

  it('with maxMarkupBps 0 admits only an amount at or below the fulfillment', async () => {
    await expectSigned(corridor({ amount: '10000000' }), { maxMarkupBps: 0 });
    await expectSigned(corridor({ amount: '9999999' }), { maxMarkupBps: 0 });
    await expectMarkupExceeded(corridor({ amount: '10000001' }), '10000000', { maxMarkupBps: 0 });
  });

  it('scales by decimals: an 18-decimal source against a 6-decimal destination', async () => {
    // 10 USDC delivered allows 10.5 USDC deposited, which is 10.5 x 10^18 atomic units.
    const terms = { asset: SRC_USDC_18.address, fulfillmentAmount: '10000000' };
    await expectSigned(corridor({ ...terms, amount: '10500000000000000000' }));
    await expectMarkupExceeded(
      corridor({ ...terms, amount: '10500000000000000001' }),
      '10500000000000000000',
    );
  });

  it('scales by decimals: a 6-decimal source against an 18-decimal destination', async () => {
    const terms = { destAsset: DST_USDC_18.address, fulfillmentAmount: '10000000000000000000' };
    await expectSigned(corridor({ ...terms, amount: '10500000' }));
    await expectMarkupExceeded(corridor({ ...terms, amount: '10500001' }), '10500000');
  });
});

describe('AtumEscrowClientScheme — maxMarkupBps validation', () => {
  // A malformed bound must fail loudly at construction: NaN compares false against everything,
  // so a NaN bound that reached the comparison would silently admit any markup.
  const construct = (maxMarkupBps: number) =>
    new AtumEscrowClientScheme({
      signer: wallet,
      now: NOW,
      trust: trustTable({ [SOURCE]: sourceRoles, [DEST]: destRoles }),
      maxMarkupBps,
    });

  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`throws synchronously for maxMarkupBps ${bad}`, () => {
      expect(() => construct(bad)).toThrow(Error);
    });
  }

  it('accepts maxMarkupBps 0', () => {
    expect(() => construct(0)).not.toThrow();
  });
});

describe('AtumEscrowClientScheme — same-chain corridor', () => {
  // One chain is both legs, so both tokens come from that chain's single trusted token list.
  const SAME_CHAIN_USDC = {
    symbol: 'USDC',
    address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
    decimals: 6,
  };
  const trust = trustTable({
    [SOURCE]: {
      ...sourceRoles,
      fulfillmentProxy: FULFILLMENT_PROXY,
      tokens: [SRC_USDC, SAME_CHAIN_USDC],
    },
  });
  function sameChain(amount: string): PaymentRequirements {
    const base = corridor({ amount });
    const atum = (base.extra as { atum: Record<string, unknown> }).atum;
    return {
      ...base,
      extra: {
        atumResource: 'GET /paid',
        atum: {
          ...atum,
          destination: {
            network: SOURCE,
            asset: SAME_CHAIN_USDC.address,
            address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
          },
        },
      },
    };
  }

  it('signs at the default bound and refuses one atomic unit over', async () => {
    await expectSigned(sameChain('10500000'), { trust });
    await expectMarkupExceeded(sameChain('10500001'), '10500000', { trust });
  });
});

describe('AtumEscrowClientScheme — vouched assets', () => {
  it('refuses a source asset the source chain does not vouch for', async () => {
    const err = await expectRefused(corridor({ amount: '10300000', asset: UNLISTED_TOKEN }));
    expect(err.code).toBe('UNTRUSTED_ASSET');
    expect(err.network).toBe(SOURCE);
    expect(err.actual).toBe(UNLISTED_TOKEN);
  });

  it('refuses a destination asset the destination chain does not vouch for', async () => {
    const err = await expectRefused(corridor({ amount: '10300000', destAsset: UNLISTED_TOKEN }));
    expect(err.code).toBe('UNTRUSTED_ASSET');
    expect(err.network).toBe(DEST);
  });

  it('matches an EVM asset whose address differs only in letter case', async () => {
    await expectSigned(
      corridor({
        amount: '10300000',
        asset: SRC_USDC.address.toLowerCase(),
        destAsset: ethers.getAddress(DST_USDC.address),
      }),
    );
  });
});

describe('AtumEscrowClientScheme — comparable assets', () => {
  it('refuses to price USDC against WETH', async () => {
    const err = await expectRefused(corridor({ amount: '10300000', destAsset: DST_WETH.address }));
    expect(err.code).toBe('ASSETS_NOT_COMPARABLE');
  });

  it('prices USDC against pathUSD through the default peg group', async () => {
    await expectSigned(corridor({ amount: '10300000', destAsset: DST_PATHUSD.address }));
  });

  it('prices USDC against USDT0 through the default peg group', async () => {
    await expectSigned(corridor({ amount: '10300000', destAsset: DST_USDT0.address }));
  });

  it('prices USDC against rUSD through the default peg group', async () => {
    await expectSigned(corridor({ amount: '10300000', destAsset: DST_RUSD.address }));
  });

  it('refuses USDC against EURC, which no default peg group includes', async () => {
    const err = await expectRefused(corridor({ amount: '10300000', destAsset: DST_EURC.address }));
    expect(err.code).toBe('ASSETS_NOT_COMPARABLE');
  });

  it('replaces the default peg groups entirely when pegGroups is given', async () => {
    const pegGroups = [['USDC', 'rUSD']];
    await expectSigned(corridor({ amount: '10300000', destAsset: DST_RUSD.address }), {
      pegGroups,
    });
    const err = await expectRefused(
      corridor({ amount: '10300000', destAsset: DST_PATHUSD.address }),
      {
        pegGroups,
      },
    );
    expect(err.code).toBe('ASSETS_NOT_COMPARABLE');
  });

  it('treats identical symbols as comparable even with no peg groups', async () => {
    await expectSigned(corridor({ amount: '10300000' }), { pegGroups: [] });
  });
});

describe('AtumEscrowClientScheme — check order', () => {
  it('reports an untrusted role before an over-bound amount', async () => {
    // The address checks answer "is this the operator I trust at all"; pricing only means
    // something once that holds, so the role refusal is the one the payer sees.
    const err = await expectRefused(corridor({ amount: '99900000', reserver: ATTACKER }));
    expect(err.code).toBe('UNTRUSTED_RESERVER');
  });
});

// ── Solana mints: base58 letter case is identity ─────────────────────────────
const SOLANA: Network = 'solana:localnet';
const SOLANA_MINT = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8';
const SOLANA_ESCROW = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR';
const SOLANA_RESERVER = 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq';
const SOLANA_RELEASER = 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY';
const SOLANA_FULFILLMENT_PROXY = bs58.encode(
  nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).publicKey,
);
const SOL_USDC = { symbol: 'USDC', address: SOLANA_MINT, decimals: 6 };
const solanaRoles: TrustedRoles = {
  escrowContract: SOLANA_ESCROW,
  quoteSelector: SOLANA_RESERVER,
  fulfillmentVerifierAccount: SOLANA_RELEASER,
  fulfillmentProxy: SOLANA_FULFILLMENT_PROXY,
  tokens: [SOL_USDC],
};
const solKeypair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * The same Solana address with the case of one letter flipped. Base58 is case-sensitive, so this
 * is a different, well-formed 32-byte account that a case-folding comparison would wrongly accept.
 * The last flippable letter is used, and the result is checked to still decode to 32 bytes, so a
 * refusal of it can only be due to case, never to a malformed mint.
 */
function caseFlipped(address: string): string {
  for (let i = address.length - 1; i >= 0; i--) {
    const c = address[i]!;
    const f = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
    if (f === c || !BASE58_ALPHABET.includes(f)) continue;
    const flipped = address.slice(0, i) + f + address.slice(i + 1);
    expect(flipped).not.toBe(address);
    expect(flipped.toLowerCase()).toBe(address.toLowerCase());
    expect(bs58.decode(flipped).length).toBe(32);
    return flipped;
  }
  throw new Error(`no case-flippable base58 letter in ${address}`);
}

/** A Solana-source 402 into the EVM destination whose roles are all trusted. */
function solanaSourced(asset: string): PaymentRequirements {
  return {
    scheme: 'atum-escrow',
    network: SOLANA,
    asset,
    amount: '10300000',
    payTo: SOLANA_ESCROW,
    maxTimeoutSeconds: 60,
    extra: {
      atumResource: 'GET /paid',
      atum: {
        destination: {
          network: DEST,
          asset: DST_USDC.address,
          address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        },
        fulfillmentAmount: '10000000',
        escrow: SOLANA_ESCROW,
        fulfillmentProxy: FULFILLMENT_PROXY,
        reserver: SOLANA_RESERVER,
        releaser: SOLANA_RELEASER,
        fulfillmentVerifierEndpoint: 'http://veri-fill:8088',
        quoteDeadlineSeconds: 20,
        fulfillmentDeadlineSeconds: 300,
        svmSignatureClusterId: 'localnet',
        svmSignatureDomainVersion: 5,
      },
    },
  };
}

/** An EVM-source 402 delivering into a Solana mint. */
function solanaBound(destAsset: string): PaymentRequirements {
  const base = corridor({ amount: '10300000' });
  const atum = (base.extra as { atum: Record<string, unknown> }).atum;
  return {
    ...base,
    extra: {
      atumResource: 'GET /paid',
      atum: {
        ...atum,
        destination: { network: SOLANA, asset: destAsset, address: SOLANA_RELEASER },
        fulfillmentProxy: SOLANA_FULFILLMENT_PROXY,
      },
    },
  };
}

/** Build a Solana-source payment with an Ed25519 signer that records whether it was asked to. */
function attemptSolana(requirement: PaymentRequirements) {
  const sign = vi.fn<SolanaSigner['sign']>(async (message: Uint8Array) =>
    nacl.sign.detached(message, solKeypair.secretKey),
  );
  const signer: SolanaSigner = { publicKey: bs58.encode(solKeypair.publicKey), sign };
  const scheme = new AtumEscrowClientScheme({
    signer,
    now: NOW,
    trust: trustTable({ [SOLANA]: solanaRoles, [DEST]: destRoles }),
    // Pinned cluster clock so the build never depends on the local wall clock.
    solanaClockReader: async () => 1_899_999_999n,
  });
  return { result: scheme.createPaymentPayload(2, requirement, named), sign };
}

describe('AtumEscrowClientScheme — Solana mints are compared case-sensitively', () => {
  const solanaDestTrust = () => trustTable({ [SOURCE]: sourceRoles, [SOLANA]: solanaRoles });

  it('signs a Solana-source payment in the trusted mint', async () => {
    // Discriminator for the refusal below: the fixture itself is payable.
    const { result, sign } = attemptSolana(solanaSourced(SOLANA_MINT));
    await expect(result).resolves.toBeDefined();
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('refuses a source mint differing from the trusted one only in letter case, without signing', async () => {
    const nearMiss = caseFlipped(SOLANA_MINT);
    const { result, sign } = attemptSolana(solanaSourced(nearMiss));
    const err = await result.then(
      () => {
        throw new Error('expected the payment to be refused, but it was built');
      },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AtumEscrowTrustError);
    expect((err as AtumEscrowTrustError).code).toBe('UNTRUSTED_ASSET');
    expect((err as AtumEscrowTrustError).network).toBe(SOLANA);
    expect((err as AtumEscrowTrustError).actual).toBe(nearMiss);
    expect(sign).toHaveBeenCalledTimes(0);
  });

  it('signs an EVM-to-Solana payment into the trusted mint', async () => {
    // Discriminator for the refusal below.
    await expectSigned(solanaBound(SOLANA_MINT), { trust: solanaDestTrust() });
  });

  it('refuses a destination mint differing from the trusted one only in letter case', async () => {
    const nearMiss = caseFlipped(SOLANA_MINT);
    const err = await expectRefused(solanaBound(nearMiss), { trust: solanaDestTrust() });

    expect(err.code).toBe('UNTRUSTED_ASSET');
    expect(err.network).toBe(SOLANA);
    expect(err.actual).toBe(nearMiss);
  });
});

describe('AtumEscrowClientScheme — trusted token decimals', () => {
  // A payer-supplied trust source is not parsed the way a gateway answer is, so its decimals reach
  // the cap arithmetic as written. A token whose decimals cannot express a uint256 amount (outside
  // 0..77, fractional, or not a number at all) prices nothing meaningfully, so the client refuses
  // it as an untrusted asset: every such refusal is an AtumEscrowTrustError the payer can act on.
  const BAD_DECIMALS: ReadonlyArray<[label: string, decimals: number]> = [
    ['78', 78],
    ['-1', -1],
    ['1.5', 1.5],
    ["the string '6'", '6' as unknown as number],
    ['NaN', Number.NaN],
    // Objects that cannot even be rendered as a string: describing the bad value must not itself
    // throw and replace the trust error with a TypeError.
    ['a null-prototype object', Object.create(null) as unknown as number],
    [
      'an object whose toString throws',
      {
        toString(): string {
          throw new Error('toString must not decide the refusal');
        },
      } as unknown as number,
    ],
  ];

  it.each(BAD_DECIMALS)(
    'refuses a source token listed with decimals %s, without signing',
    async (_label, decimals) => {
      const trust = trustTable({
        [SOURCE]: { ...sourceRoles, tokens: [{ ...SRC_USDC, decimals }] },
        [DEST]: destRoles,
      });
      const err = await expectRefused(corridor({ amount: '10300000' }), { trust });

      expect(err.name).toBe('AtumEscrowTrustError');
      expect(err.code).toBe('UNTRUSTED_ASSET');
      expect(err.network).toBe(SOURCE);
      expect(err.field).toBe('asset');
      expect(err.actual).toBe(SRC_USDC.address);
    },
  );

  it.each(BAD_DECIMALS)(
    'refuses a destination token listed with decimals %s, without signing',
    async (_label, decimals) => {
      const trust = trustTable({
        [SOURCE]: sourceRoles,
        [DEST]: { ...destRoles, tokens: [{ ...DST_USDC, decimals }] },
      });
      const err = await expectRefused(corridor({ amount: '10300000' }), { trust });

      expect(err.name).toBe('AtumEscrowTrustError');
      expect(err.code).toBe('UNTRUSTED_ASSET');
      expect(err.network).toBe(DEST);
      expect(err.field).toBe('asset');
      expect(err.actual).toBe(DST_USDC.address);
    },
  );

  it('signs a payment whose source token has 0 decimals', async () => {
    // 10 USDC delivered allows 10.5 whole source units; with no fractional digits that floors to 10.
    const trust = trustTable({
      [SOURCE]: { ...sourceRoles, tokens: [{ ...SRC_USDC, decimals: 0 }] },
      [DEST]: destRoles,
    });
    await expectSigned(corridor({ amount: '10', fulfillmentAmount: '10000000' }), { trust });
  });

  it('signs a payment whose source token has 77 decimals', async () => {
    // One atomic unit of a 6-decimal USDC delivered allows 1.05 x 10^71 atomic units at 77
    // decimals; 10^71 sits under that bound and well inside uint256.
    const trust = trustTable({
      [SOURCE]: { ...sourceRoles, tokens: [{ ...SRC_USDC, decimals: 77 }] },
      [DEST]: destRoles,
    });
    await expectSigned(corridor({ amount: `1${'0'.repeat(71)}`, fulfillmentAmount: '1' }), {
      trust,
    });
  });

  it('signs a payment whose destination token has 0 decimals', async () => {
    // One whole destination unit delivered allows 1.05 USDC deposited, i.e. 1050000 at 6 decimals;
    // 1000000 sits under that bound.
    const trust = trustTable({
      [SOURCE]: sourceRoles,
      [DEST]: { ...destRoles, tokens: [{ ...DST_USDC, decimals: 0 }] },
    });
    await expectSigned(corridor({ amount: '1000000', fulfillmentAmount: '1' }), { trust });
  });

  it('signs a payment whose destination token has 77 decimals', async () => {
    // 10^71 atomic units at 77 decimals is 10^-6 of a whole token, so the bound is
    // floor(10^71 x 1.05 x 10^6 / 10^77) = 1 atomic unit of the 6-decimal source.
    const trust = trustTable({
      [SOURCE]: sourceRoles,
      [DEST]: { ...destRoles, tokens: [{ ...DST_USDC, decimals: 77 }] },
    });
    await expectSigned(corridor({ amount: '1', fulfillmentAmount: `1${'0'.repeat(71)}` }), {
      trust,
    });
  });

  it('prices with the decimals it validated, even if the token reports different ones later', async () => {
    // A payer-supplied token object can expose decimals through a getter. Validating one read and
    // pricing with another would let the validated value differ from the one that sets the bound.
    // At 6 decimals the bound is 10500000, so 10500001 is over it; at 18 decimals the bound is
    // 10500000 x 10^12, which would admit it.
    let reads = 0;
    const shiftingToken = {
      symbol: SRC_USDC.symbol,
      address: SRC_USDC.address,
      get decimals(): number {
        reads += 1;
        return reads === 1 ? 6 : 18;
      },
    };
    const trust = trustTable({
      [SOURCE]: { ...sourceRoles, tokens: [shiftingToken] },
      [DEST]: destRoles,
    });

    await expectMarkupExceeded(corridor({ amount: '10500001' }), '10500000', { trust });
    // Discriminator: the same amount is within the 18-decimal bound, so a refusal above can only
    // come from pricing at 6 decimals.
    await expectSigned(corridor({ amount: '10500001' }), {
      trust: trustTable({
        [SOURCE]: { ...sourceRoles, tokens: [{ ...SRC_USDC, decimals: 18 }] },
        [DEST]: destRoles,
      }),
    });
  });
});
