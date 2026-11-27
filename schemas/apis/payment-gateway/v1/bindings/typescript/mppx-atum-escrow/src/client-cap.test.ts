/**
 * The payer's bound on what a challenge may charge.
 *
 * A challenge names both the amount the payer deposits on the source chain (`source.amount`) and
 * the amount the payee receives on the destination chain (`extra.fulfillmentAmount`); the
 * difference is the merchant's markup, and nothing on chain limits it. Once the role addresses
 * are known to be trusted, the remaining attack is a challenge that is honest about WHERE the
 * money goes and dishonest about HOW MUCH: a deposit of 100 for a fulfillment of 10 settles
 * exactly as signed.
 *
 * So before signing, the client prices both legs in units it trusts: each asset must be a token
 * the trust source vouches for on its chain (which supplies its decimals), the two tokens must be
 * comparable (the same symbol, or pegged to the same thing), and the deposit may exceed the
 * fulfillment by at most `maxMarkupBps` once both are scaled to a common precision. Comparing raw
 * atomic amounts would be meaningless across tokens of different decimals — an 18-decimal deposit
 * against a 6-decimal fulfillment looks like a 10^12 markup and the reverse looks like a discount.
 *
 * Every refusal also asserts that the signer was never called: the signature is the irreversible
 * step.
 */
import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import { getAddress, hexlify } from 'ethers';
import {
  registerClient,
  AtumEscrowTrustError,
  DEFAULT_MAX_MARKUP_BPS,
  DEFAULT_PEG_GROUPS,
  type TrustedRoles,
} from './client.js';
import type { AtumEscrowChallenge } from './index.js';
import {
  PRIVATE_KEY,
  PAYER,
  now,
  corridor,
  challenge,
  tronChallenge,
  tronCorridor,
  solanaChallenge,
  solanaCorridor,
  evmToTronAddress,
  fixtureTrustTable,
  attemptAgainst,
  priced,
  trustFailure,
  trustTable,
  type AttemptConfig,
} from './test-helpers.js';

const BASE = corridor.sources[0]!.network;
const ARBITRUM = corridor.destination.network;
const TRON = tronCorridor.sources[0]!.network;
const SOLANA = solanaCorridor.sources[0]!.network;
const ATTACKER = '0xBcd4042DE499D14e55001CcbB24a551F3b954096';

// Tokens the trust sources vouch for. The 18-decimal stablecoins are fictional and exist so the
// decimals scaling can be exercised with the SAME symbol on both legs, isolating it from pegging.
const SRC_USDC = fixtureTrustTable[BASE]!.tokens[0]!;
const SRC_USDC_18 = {
  symbol: 'USDC',
  address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  decimals: 18,
};
const DST_USDC = fixtureTrustTable[ARBITRUM]!.tokens[0]!;
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

const capTable: Record<string, TrustedRoles> = {
  ...fixtureTrustTable,
  [BASE]: { ...fixtureTrustTable[BASE]!, tokens: [SRC_USDC, SRC_USDC_18] },
  [ARBITRUM]: {
    ...fixtureTrustTable[ARBITRUM]!,
    tokens: [DST_USDC, DST_USDC_18, DST_WETH, DST_PATHUSD, DST_RUSD, DST_USDT0, DST_EURC],
  },
};

const attempt = attemptAgainst(capTable);

/** Assert the credential is built and signed exactly once. */
async function expectSigned(chg: AtumEscrowChallenge, config?: AttemptConfig) {
  const { result, sign } = attempt(chg, config);
  await expect(result).resolves.toBeTypeOf('string');
  expect(sign).toHaveBeenCalledTimes(1);
}

/** Assert the credential is refused with a trust error before any signing, and return the error. */
async function expectRefused(
  chg: AtumEscrowChallenge,
  config?: AttemptConfig,
): Promise<AtumEscrowTrustError> {
  const { result, sign } = attempt(chg, config);
  const err = await trustFailure(result);
  expect(sign).not.toHaveBeenCalled();
  return err;
}

/** Assert a MARKUP_EXCEEDED refusal naming the largest amount that would have passed. */
async function expectMarkupExceeded(
  chg: AtumEscrowChallenge,
  maxAllowed: string,
  config?: AttemptConfig,
) {
  const err = await expectRefused(chg, config);
  expect(err.code).toBe('MARKUP_EXCEEDED');
  expect(err.field).toBe('source.amount');
  expect(err.network).toBe(chg.request.source.network);
  expect(err.expected).toBe(maxAllowed);
  expect(err.actual).toBe(chg.request.source.amount);
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

describe('createCredential — markup bound', () => {
  it('signs an amount exactly at the default bound and refuses one atomic unit over', async () => {
    await expectSigned(priced({ amount: '10500000' }));
    await expectMarkupExceeded(priced({ amount: '10500001' }), '10500000');
  });

  it("signs the fixture corridor's 300 bps markup under the default bound", async () => {
    await expectSigned(challenge);
  });

  it('floors the bound to a whole atomic unit when it is fractional', async () => {
    // 10000001 x 1.05 = 10500001.05: the largest payable integer is 10500001.
    await expectSigned(priced({ amount: '10500001', fulfillmentAmount: '10000001' }));
    await expectMarkupExceeded(
      priced({ amount: '10500002', fulfillmentAmount: '10000001' }),
      '10500001',
    );
  });

  it('honours a tighter custom maxMarkupBps', async () => {
    await expectMarkupExceeded(priced({ amount: '10300000' }), '10100000', { maxMarkupBps: 100 });
    await expectSigned(priced({ amount: '10100000' }), { maxMarkupBps: 100 });
    await expectMarkupExceeded(priced({ amount: '10100001' }), '10100000', { maxMarkupBps: 100 });
  });

  it('honours a looser custom maxMarkupBps', async () => {
    // Above the default, so a client ignoring the option would refuse what it should sign.
    await expectSigned(priced({ amount: '11000000' }), { maxMarkupBps: 1_000 });
    await expectMarkupExceeded(priced({ amount: '11000001' }), '11000000', { maxMarkupBps: 1_000 });
  });

  it('with maxMarkupBps 0 admits only an amount at or below the fulfillment', async () => {
    await expectSigned(priced({ amount: '10000000' }), { maxMarkupBps: 0 });
    await expectSigned(priced({ amount: '9999999' }), { maxMarkupBps: 0 });
    await expectMarkupExceeded(priced({ amount: '10000001' }), '10000000', { maxMarkupBps: 0 });
  });

  it('scales by decimals: an 18-decimal source against a 6-decimal destination', async () => {
    // 10 USDC delivered allows 10.5 USDC deposited, which is 10.5 x 10^18 atomic units.
    const terms = { asset: SRC_USDC_18.address, fulfillmentAmount: '10000000' };
    await expectSigned(priced({ ...terms, amount: '10500000000000000000' }));
    await expectMarkupExceeded(
      priced({ ...terms, amount: '10500000000000000001' }),
      '10500000000000000000',
    );
  });

  it('scales by decimals: a 6-decimal source against an 18-decimal destination', async () => {
    const terms = { destAsset: DST_USDC_18.address, fulfillmentAmount: '10000000000000000000' };
    await expectSigned(priced({ ...terms, amount: '10500000' }));
    await expectMarkupExceeded(priced({ ...terms, amount: '10500001' }), '10500000');
  });

  it('scales by decimals under a custom maxMarkupBps', async () => {
    const terms = { asset: SRC_USDC_18.address, fulfillmentAmount: '10000000' };
    await expectSigned(priced({ ...terms, amount: '10200000000000000000' }), { maxMarkupBps: 200 });
    await expectMarkupExceeded(
      priced({ ...terms, amount: '10200000000000000001' }),
      '10200000000000000000',
      { maxMarkupBps: 200 },
    );
  });

  it('floors a fractional bound across differing decimals', async () => {
    // 18-decimal fulfillment of 10000000000000000001 at 6 decimals x 1.05 = 10.50000000000000000105
    // USDC; at 6 decimals the largest payable integer is 10500000.
    const terms = { destAsset: DST_USDC_18.address, fulfillmentAmount: '10000000000000000001' };
    await expectSigned(priced({ ...terms, amount: '10500000' }));
    await expectMarkupExceeded(priced({ ...terms, amount: '10500001' }), '10500000');
  });
});

describe('createCredential — same-chain corridor', () => {
  // One chain is both legs, so both tokens come from that chain's single trusted token list.
  const SAME_CHAIN_USDC = {
    symbol: 'USDC',
    address: '0x50c5725949a6f0c72e6c4a641f24049a917db0cb',
    decimals: 6,
  };
  const trust = trustTable({
    [BASE]: { ...fixtureTrustTable[BASE]!, tokens: [SRC_USDC, SAME_CHAIN_USDC] },
  });
  const sameChain = (amount: string) =>
    priced({
      amount,
      extra: {
        destination: {
          network: BASE,
          asset: SAME_CHAIN_USDC.address,
          address: corridor.destination.account,
        },
        fulfillmentProxy: fixtureTrustTable[BASE]!.fulfillmentProxy,
      },
    });

  it('signs at the default bound and refuses one atomic unit over', async () => {
    await expectSigned(sameChain('10500000'), { trust });
    await expectMarkupExceeded(sameChain('10500001'), '10500000', { trust });
  });
});

describe('registerClient — maxMarkupBps validation', () => {
  // A malformed bound must fail loudly at construction: NaN compares false against everything,
  // so a NaN bound that reached the comparison would silently admit any markup.
  const construct = (maxMarkupBps: number) =>
    registerClient({
      signer: { privateKey: PRIVATE_KEY },
      account: PAYER,
      now,
      trust: trustTable(capTable),
      maxMarkupBps,
    });

  for (const bad of [-1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`throws synchronously for maxMarkupBps ${bad}`, () => {
      expect(() => construct(bad)).toThrow(Error);
    });
  }

  it('accepts maxMarkupBps 0 and a positive integer', () => {
    expect(() => construct(0)).not.toThrow();
    expect(() => construct(750)).not.toThrow();
  });
});

describe('createCredential — vouched assets', () => {
  it('refuses a source asset the source chain does not vouch for', async () => {
    const err = await expectRefused(priced({ amount: '10300000', asset: UNLISTED_TOKEN }));
    expect(err.code).toBe('UNTRUSTED_ASSET');
    expect(err.field).toBe('source.asset');
    expect(err.network).toBe(BASE);
    expect(err.actual).toBe(UNLISTED_TOKEN);
  });

  it('refuses a destination asset the destination chain does not vouch for', async () => {
    const err = await expectRefused(priced({ amount: '10300000', destAsset: UNLISTED_TOKEN }));
    expect(err.code).toBe('UNTRUSTED_ASSET');
    expect(err.field).toBe('extra.destination.asset');
    expect(err.network).toBe(ARBITRUM);
    expect(err.actual).toBe(UNLISTED_TOKEN);
  });

  it("looks the destination asset up on the DESTINATION chain's list, not the source's", async () => {
    // SRC_USDC_18 is vouched for only on the source chain.
    const err = await expectRefused(priced({ amount: '10300000', destAsset: SRC_USDC_18.address }));
    expect(err.code).toBe('UNTRUSTED_ASSET');
    expect(err.field).toBe('extra.destination.asset');
    expect(err.network).toBe(ARBITRUM);
    expect(err.actual).toBe(SRC_USDC_18.address);
  });

  it('matches an EVM asset whose address differs only in letter case', async () => {
    await expectSigned(
      priced({
        amount: '10300000',
        asset: SRC_USDC.address.toLowerCase(),
        destAsset: getAddress(DST_USDC.address),
      }),
    );
  });

  it('matches a Tron source asset given in hex against a trusted base58 token', async () => {
    const raw = bs58.decode(tronCorridor.sources[0]!.assets[0]!.address);
    const hexAsset = hexlify(raw.slice(1, 21));
    expect(evmToTronAddress(hexAsset)).toBe(tronCorridor.sources[0]!.assets[0]!.address);
    await expectSigned(priced({ amount: '10300000', asset: hexAsset }, tronChallenge));
  });

  it('refuses a Tron source asset that decodes to a different token', async () => {
    const stranger = evmToTronAddress('0x000000000000000000000000000000000000bEEF');
    const err = await expectRefused(priced({ amount: '10300000', asset: stranger }, tronChallenge));
    expect(err.code).toBe('UNTRUSTED_ASSET');
    expect(err.field).toBe('source.asset');
    expect(err.network).toBe(TRON);
    expect(err.actual).toBe(stranger);
  });
});

describe('createCredential — Solana mints are compared case-sensitively', () => {
  const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  /** The same Solana address with one letter's case flipped, still a well-formed 32-byte key. */
  function caseFlipped(address: string): string {
    for (let i = address.length - 1; i >= 0; i--) {
      const c = address[i]!;
      const f = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
      if (f === c || !BASE58_ALPHABET.includes(f)) continue;
      const flipped = address.slice(0, i) + f + address.slice(i + 1);
      if (bs58.decode(flipped).length !== 32) continue;
      expect(flipped.toLowerCase()).toBe(address.toLowerCase());
      return flipped;
    }
    throw new Error(`no case-flippable base58 letter in ${address}`);
  }
  const SOLANA_MINT = solanaCorridor.sources[0]!.assets[0]!.address;

  it('signs a Solana-source payment in the trusted mint', async () => {
    // Discriminator for the refusal below: the fixture itself is payable.
    await expectSigned(solanaChallenge);
  });

  it('refuses a source mint differing from the trusted one only in letter case, without signing', async () => {
    const nearMiss = caseFlipped(SOLANA_MINT);
    const err = await expectRefused(
      priced({ amount: '10300000', asset: nearMiss }, solanaChallenge),
    );
    expect(err.code).toBe('UNTRUSTED_ASSET');
    expect(err.field).toBe('source.asset');
    expect(err.network).toBe(SOLANA);
    expect(err.actual).toBe(nearMiss);
  });
});

describe('createCredential — comparable assets', () => {
  it('refuses to price USDC against WETH', async () => {
    const err = await expectRefused(priced({ amount: '10300000', destAsset: DST_WETH.address }));
    expect(err.code).toBe('ASSETS_NOT_COMPARABLE');
  });

  it('prices USDC against pathUSD through the default peg group', async () => {
    await expectSigned(priced({ amount: '10300000', destAsset: DST_PATHUSD.address }));
  });

  it('prices USDC against USDT0 through the default peg group', async () => {
    await expectSigned(priced({ amount: '10300000', destAsset: DST_USDT0.address }));
  });

  it('prices the Tron fixture USDT against USDC through the default peg group', async () => {
    await expectSigned(tronChallenge);
  });

  it('refuses USDC against EURC, which no default peg group includes', async () => {
    const err = await expectRefused(priced({ amount: '10300000', destAsset: DST_EURC.address }));
    expect(err.code).toBe('ASSETS_NOT_COMPARABLE');
  });

  it('makes two symbols comparable through a custom pegGroups', async () => {
    await expectSigned(priced({ amount: '10300000', destAsset: DST_EURC.address }), {
      pegGroups: [['USDC', 'EURC']],
    });
  });

  it('applies the bound across a custom peg group', async () => {
    const chg = (amount: string) => priced({ amount, destAsset: DST_EURC.address });
    const pegGroups = [['USDC', 'EURC']];
    await expectSigned(chg('10500000'), { pegGroups });
    await expectMarkupExceeded(chg('10500001'), '10500000', { pegGroups });
  });

  it('replaces the default peg groups entirely when pegGroups is given', async () => {
    const pegGroups = [['USDC', 'rUSD']];
    await expectSigned(priced({ amount: '10300000', destAsset: DST_RUSD.address }), { pegGroups });
    const err = await expectRefused(
      priced({ amount: '10300000', destAsset: DST_PATHUSD.address }),
      { pegGroups },
    );
    expect(err.code).toBe('ASSETS_NOT_COMPARABLE');
  });

  it('treats identical symbols as comparable even with no peg groups', async () => {
    await expectSigned(priced({ amount: '10300000' }), { pegGroups: [] });
  });
});

describe('createCredential — check order', () => {
  it('reports an untrusted role before an over-bound amount', async () => {
    // The address checks answer "is this the operator I trust at all"; pricing only means
    // something once that holds, so the role refusal is the one the payer sees.
    const err = await expectRefused(priced({ amount: '99900000', extra: { reserver: ATTACKER } }));
    expect(err.code).toBe('UNTRUSTED_RESERVER');
  });
});
