// Token metadata on the merchant corridor: every destination and source token declares its symbol
// and decimals, and validateCorridor refuses a corridor whose source tokens are not the same money
// as the destination token (same symbol, or both in one peg group). Refusals are typed so a
// merchant can branch on `code` rather than parse a message.

import { describe, it, expect } from 'vitest';
import {
  buildChargeRequest,
  validateCorridor,
  corridorFromDefaults,
  AtumEscrowConfigError,
  type AtumEscrowAsset,
  type AtumEscrowConfigErrorCode,
  type AtumEscrowCorridor,
} from './server.js';
import { AtumEscrowConfigError as RootAtumEscrowConfigError } from './index.js';

const BASE = 'eip155:8453';
const OPTIMISM = 'eip155:10';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDT_BASE = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDC_OP = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const USDT_OP = '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58';

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
// The Permit2 lookup's own wording for an unmapped Tron network, which the corridor refusal keeps.
const TRON_NILE_MESSAGE = "sender_auth: no Permit2 address known for Tron network 'tron:nile'";

const usdc = (address: string): AtumEscrowAsset => ({ address, symbol: 'USDC', decimals: 6 });
const usdt = (address: string): AtumEscrowAsset => ({ address, symbol: 'USDT', decimals: 6 });

// Built here rather than imported from the shared fixtures, so these tests construct nothing at
// module load and each one fails or passes on its own.
const BASE_SOURCE = {
  network: BASE,
  assets: [usdc(USDC_BASE)],
  escrow: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
  reserver: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  releaser: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  fulfillmentVerifierEndpoint: 'https://verifier.example.com',
};
const corridor: AtumEscrowCorridor = {
  destination: {
    network: 'eip155:42161',
    asset: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    account: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    symbol: 'USDC',
    decimals: 6,
  },
  fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  markupBps: 300,
  quoteDeadlineSeconds: 20,
  fulfillmentDeadlineSeconds: 300,
  sources: [BASE_SOURCE],
};

/** A USDC destination fed by one source on Base listing `assets`. */
function oneSource(assets: AtumEscrowAsset[], extra: Partial<AtumEscrowCorridor> = {}) {
  const c: AtumEscrowCorridor = {
    ...corridor,
    destination: { ...corridor.destination, symbol: 'USDC', decimals: 6 },
    sources: [{ ...BASE_SOURCE, network: BASE, assets }],
    ...extra,
  };
  return c;
}

/**
 * Two sources, the second listing two assets, so a test that breaks `sources[1].assets[1]` can
 * tell a correct index report from one that always says `[0]`.
 */
function twoSources(): AtumEscrowCorridor {
  return {
    ...corridor,
    destination: { ...corridor.destination, symbol: 'USDC', decimals: 6 },
    sources: [
      { ...BASE_SOURCE, network: BASE, assets: [usdc(USDC_BASE)] },
      { ...BASE_SOURCE, network: OPTIMISM, assets: [usdc(USDC_OP), usdt(USDT_OP)] },
    ],
  };
}

/** Run `fn`, require it to throw a typed config error, and hand that error back. */
function configError(fn: () => unknown): AtumEscrowConfigError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected a config error, but nothing was thrown').toBeDefined();
  expect(caught).toBeInstanceOf(AtumEscrowConfigError);
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).name).toBe('AtumEscrowConfigError');
  return caught as AtumEscrowConfigError;
}

/** Validation must refuse with INVALID_CONFIG and a message naming `path`. */
function expectInvalid(c: unknown, path: string): void {
  const err = configError(() => validateCorridor(c as AtumEscrowCorridor));
  const code: AtumEscrowConfigErrorCode = err.code;
  expect(code).toBe('INVALID_CONFIG');
  expect(err.message).toContain(path);
}

describe('validateCorridor — token metadata accepted', () => {
  it.each([0, 6, 18, 77])(
    'accepts a corridor whose every token declares a symbol and %i decimals',
    (decimals) => {
      const c = twoSources();
      const withDecimals: AtumEscrowCorridor = {
        ...c,
        destination: { ...c.destination, decimals },
        sources: c.sources.map((s) => ({
          ...s,
          assets: s.assets.map((a) => ({ ...a, decimals })),
        })),
      };
      expect(() => validateCorridor(withDecimals)).not.toThrow();
    },
  );
});

describe('validateCorridor — destination metadata refused', () => {
  const dest = () => twoSources();

  it.each<[string, (d: Record<string, unknown>) => void]>([
    ['missing', (d) => delete d.symbol],
    ['empty', (d) => (d.symbol = '')],
    ['not a string', (d) => (d.symbol = 42)],
  ])('refuses a destination symbol that is %s', (_label, mutate) => {
    const c = dest();
    const d = { ...c.destination } as Record<string, unknown>;
    mutate(d);
    expectInvalid({ ...c, destination: d }, 'destination.symbol');
  });

  it.each<[string, (d: Record<string, unknown>) => void]>([
    ['missing', (d) => delete d.decimals],
    ['negative', (d) => (d.decimals = -1)],
    ['fractional', (d) => (d.decimals = 1.5)],
    ['78, past the largest uint256 exponent', (d) => (d.decimals = 78)],
    ['NaN', (d) => (d.decimals = Number.NaN)],
    ['a numeric string', (d) => (d.decimals = '6')],
  ])('refuses destination decimals that are %s', (_label, mutate) => {
    const c = dest();
    const d = { ...c.destination } as Record<string, unknown>;
    mutate(d);
    expectInvalid({ ...c, destination: d }, 'destination.decimals');
  });
});

describe('validateCorridor — source asset metadata refused', () => {
  // Two sources of two valid assets each. The faulty asset sits where the source and asset
  // indices differ, in both orientations, so a path that swaps them names the wrong position.
  const POSITIONS: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [0, 1],
  ];

  /** Two two-asset sources with only `sources[si].assets[ai]` rewritten by `mutate`. */
  function breakAssetAt(
    si: number,
    ai: number,
    mutate: (a: Record<string, unknown>) => void,
  ): unknown {
    const c: AtumEscrowCorridor = {
      ...twoSources(),
      sources: [
        { ...BASE_SOURCE, network: BASE, assets: [usdc(USDC_BASE), usdt(USDT_BASE)] },
        { ...BASE_SOURCE, network: OPTIMISM, assets: [usdc(USDC_OP), usdt(USDT_OP)] },
      ],
    };
    return {
      ...c,
      sources: c.sources.map((s, i) =>
        i !== si
          ? s
          : {
              ...s,
              assets: s.assets.map((a, j) => {
                if (j !== ai) return a;
                const broken = { ...a } as Record<string, unknown>;
                mutate(broken);
                return broken;
              }),
            },
      ),
    };
  }

  it.each(POSITIONS)(
    'accepts the two-source baseline with sources[%i].assets[%i] intact',
    (si, ai) => {
      expect(() =>
        validateCorridor(breakAssetAt(si, ai, () => {}) as AtumEscrowCorridor),
      ).not.toThrow();
    },
  );

  const symbolCases: ReadonlyArray<[string, (a: Record<string, unknown>) => void]> = [
    ['missing', (a) => delete a.symbol],
    ['empty', (a) => (a.symbol = '')],
    ['not a string', (a) => (a.symbol = 42)],
  ];
  const decimalsCases: ReadonlyArray<[string, (a: Record<string, unknown>) => void]> = [
    ['missing', (a) => delete a.decimals],
    ['negative', (a) => (a.decimals = -1)],
    ['fractional', (a) => (a.decimals = 1.5)],
    ['78, past the largest uint256 exponent', (a) => (a.decimals = 78)],
    ['NaN', (a) => (a.decimals = Number.NaN)],
    ['a numeric string', (a) => (a.decimals = '6')],
  ];

  it.each(
    POSITIONS.flatMap(([si, ai]) => symbolCases.map(([label, m]) => [label, si, ai, m] as const)),
  )(
    'refuses an asset symbol that is %s at sources[%i].assets[%i], naming that path',
    (_label, si, ai, mutate) => {
      expectInvalid(breakAssetAt(si, ai, mutate), `sources[${si}].assets[${ai}].symbol`);
    },
  );

  it.each(
    POSITIONS.flatMap(([si, ai]) => decimalsCases.map(([label, m]) => [label, si, ai, m] as const)),
  )(
    'refuses asset decimals that are %s at sources[%i].assets[%i], naming that path',
    (_label, si, ai, mutate) => {
      expectInvalid(breakAssetAt(si, ai, mutate), `sources[${si}].assets[${ai}].decimals`);
    },
  );
});

describe('validateCorridor — comparable assets', () => {
  it('refuses a source token that is not the same money as the destination token', () => {
    const err = configError(() =>
      validateCorridor(oneSource([{ address: WETH_BASE, symbol: 'WETH', decimals: 18 }])),
    );
    expect(err.code).toBe('ASSETS_NOT_COMPARABLE');
    expect(err.network).toBe(BASE);
    expect(err.message).toContain('USDC');
    expect(err.message).toContain('WETH');
  });

  it('names the offending source when only the second of two is incomparable', () => {
    const c = twoSources();
    const s1 = c.sources[1]!;
    const bad: AtumEscrowCorridor = {
      ...c,
      sources: [
        c.sources[0]!,
        { ...s1, assets: [s1.assets[0]!, { address: USDT_OP, symbol: 'WETH', decimals: 18 }] },
      ],
    };
    const err = configError(() => validateCorridor(bad));
    expect(err.code).toBe('ASSETS_NOT_COMPARABLE');
    expect(err.network).toBe(OPTIMISM);
  });

  it('accepts USDC to USDT, which share the default peg group', () => {
    expect(() => validateCorridor(oneSource([usdt(USDT_BASE)]))).not.toThrow();
  });

  it('accepts equal symbols that belong to no peg group', () => {
    const c = oneSource([{ address: WETH_BASE, symbol: 'WETH', decimals: 18 }]);
    const weth: AtumEscrowCorridor = {
      ...c,
      destination: { ...c.destination, symbol: 'WETH', decimals: 18 },
    };
    expect(() => validateCorridor(weth)).not.toThrow();
  });

  const testTokens = (pegGroups?: ReadonlyArray<ReadonlyArray<string>>): AtumEscrowCorridor => {
    const c = oneSource([{ address: USDT_BASE, symbol: 'TUSDT', decimals: 6 }]);
    return {
      ...c,
      destination: { ...c.destination, symbol: 'TUSDC' },
      ...(pegGroups !== undefined && { pegGroups }),
    };
  };

  it('accepts symbols a merchant-declared peg group joins', () => {
    expect(() => validateCorridor(testTokens([['TUSDC', 'TUSDT']]))).not.toThrow();
  });

  it('refuses the same symbols when no peg group joins them', () => {
    const err = configError(() => validateCorridor(testTokens()));
    expect(err.code).toBe('ASSETS_NOT_COMPARABLE');
    expect(err.network).toBe(BASE);
  });

  it('treats merchant peg groups as replacing the default, not extending it', () => {
    const err = configError(() =>
      validateCorridor(oneSource([usdt(USDT_BASE)], { pegGroups: [['FOO', 'BAR']] })),
    );
    expect(err.code).toBe('ASSETS_NOT_COMPARABLE');
    expect(err.network).toBe(BASE);
  });
});

describe('validateCorridor — existing refusals are typed', () => {
  // Each message is exactly what the untyped refusal says today, so typing the error must not
  // change what a merchant reads.
  it.each<[string, () => AtumEscrowCorridor, string]>([
    [
      'an empty sources list',
      () => ({ ...twoSources(), sources: [] }),
      'atum-escrow: corridor must configure at least one source',
    ],
    [
      'out-of-order deadline budgets',
      () => ({ ...twoSources(), quoteDeadlineSeconds: 300, fulfillmentDeadlineSeconds: 20 }),
      'atum-escrow: quoteDeadlineSeconds must be strictly less than fulfillmentDeadlineSeconds',
    ],
    [
      'a negative markup',
      () => ({ ...twoSources(), markupBps: -1 }),
      'atum-escrow: markupBps must be a non-negative number of basis points',
    ],
    [
      'an asset with an empty address',
      () => oneSource([{ address: '', symbol: 'USDC', decimals: 6 }]),
      "atum-escrow: source eip155:8453 must list at least one non-empty asset in 'assets'",
    ],
  ])('refuses %s with INVALID_CONFIG', (_label, build, message) => {
    const err = configError(() => validateCorridor(build()));
    expect(err.code).toBe('INVALID_CONFIG');
    expect(err.message).toBe(message);
  });

  /** `oneSource` with its single source rewritten by `mutate` (which may delete fields). */
  const withSource = (mutate: (s: Record<string, unknown>) => void): AtumEscrowCorridor => {
    const c = oneSource([usdc(USDC_BASE)]);
    const s = { ...c.sources[0]! } as Record<string, unknown>;
    mutate(s);
    return { ...c, sources: [s as unknown as AtumEscrowCorridor['sources'][number]] };
  };

  // A Solana source that validates on its own, so each case below fails on the one field it
  // breaks. The budget stays inside the Solana replay window unless a case says otherwise.
  const solana = (
    mutate: (s: Record<string, unknown>) => void = () => {},
    fulfillmentDeadlineSeconds = 100,
  ): AtumEscrowCorridor => {
    const s: Record<string, unknown> = {
      ...BASE_SOURCE,
      network: SOLANA,
      assets: [usdc('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')],
      escrow: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      reserver: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
      releaser: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
      svmSignatureClusterId: 'mainnet',
      svmSignatureDomainVersion: 5,
    };
    mutate(s);
    return {
      ...corridor,
      fulfillmentDeadlineSeconds,
      sources: [s as unknown as AtumEscrowCorridor['sources'][number]],
    };
  };

  it('accepts the Solana baseline the refusals below each break once', () => {
    expect(() => validateCorridor(solana())).not.toThrow();
  });

  // Every refusal validateCorridor makes is typed, with the message a merchant reads today.
  it.each<[string, () => AtumEscrowCorridor, string]>([
    [
      'a zero quoteDeadlineSeconds',
      () => ({ ...corridor, quoteDeadlineSeconds: 0 }),
      'atum-escrow: quoteDeadlineSeconds must be a positive number of seconds',
    ],
    [
      'a negative quoteDeadlineSeconds',
      () => ({ ...corridor, quoteDeadlineSeconds: -1 }),
      'atum-escrow: quoteDeadlineSeconds must be a positive number of seconds',
    ],
    [
      'an infinite quoteDeadlineSeconds',
      () => ({ ...corridor, quoteDeadlineSeconds: Number.POSITIVE_INFINITY }),
      'atum-escrow: quoteDeadlineSeconds must be a positive number of seconds',
    ],
    [
      'a NaN quoteDeadlineSeconds',
      () => ({ ...corridor, quoteDeadlineSeconds: Number.NaN }),
      'atum-escrow: quoteDeadlineSeconds must be a positive number of seconds',
    ],
    [
      'a zero fulfillmentDeadlineSeconds',
      () => ({ ...corridor, fulfillmentDeadlineSeconds: 0 }),
      'atum-escrow: fulfillmentDeadlineSeconds must be a positive number of seconds',
    ],
    [
      'an infinite fulfillmentDeadlineSeconds',
      () => ({ ...corridor, fulfillmentDeadlineSeconds: Number.POSITIVE_INFINITY }),
      'atum-escrow: fulfillmentDeadlineSeconds must be a positive number of seconds',
    ],
    [
      'a NaN fulfillmentDeadlineSeconds',
      () => ({ ...corridor, fulfillmentDeadlineSeconds: Number.NaN }),
      'atum-escrow: fulfillmentDeadlineSeconds must be a positive number of seconds',
    ],
    [
      'a source missing escrow',
      () => withSource((s) => delete s.escrow),
      "atum-escrow: source eip155:8453 is missing 'escrow'",
    ],
    [
      'a source missing reserver',
      () => withSource((s) => delete s.reserver),
      "atum-escrow: source eip155:8453 is missing 'reserver'",
    ],
    [
      'a source missing releaser',
      () => withSource((s) => delete s.releaser),
      "atum-escrow: source eip155:8453 is missing 'releaser'",
    ],
    [
      'a source missing fulfillmentVerifierEndpoint',
      () => withSource((s) => delete s.fulfillmentVerifierEndpoint),
      "atum-escrow: source eip155:8453 is missing 'fulfillmentVerifierEndpoint'",
    ],
    [
      'an empty depositRequestHashVersions',
      () => withSource((s) => (s.depositRequestHashVersions = [])),
      'atum-escrow: source eip155:8453 depositRequestHashVersions must list distinct positive integers',
    ],
    [
      'a duplicate in depositRequestHashVersions',
      () => withSource((s) => (s.depositRequestHashVersions = [1, 1])),
      'atum-escrow: source eip155:8453 depositRequestHashVersions must list distinct positive integers',
    ],
    [
      'a zero in depositRequestHashVersions',
      () => withSource((s) => (s.depositRequestHashVersions = [0])),
      'atum-escrow: source eip155:8453 depositRequestHashVersions must list distinct positive integers',
    ],
    [
      'a negative entry in depositRequestHashVersions',
      () => withSource((s) => (s.depositRequestHashVersions = [-1])),
      'atum-escrow: source eip155:8453 depositRequestHashVersions must list distinct positive integers',
    ],
    [
      'a fractional entry in depositRequestHashVersions',
      () => withSource((s) => (s.depositRequestHashVersions = [1.5])),
      'atum-escrow: source eip155:8453 depositRequestHashVersions must list distinct positive integers',
    ],
    [
      'a source listing no assets',
      () => withSource((s) => (s.assets = [])),
      "atum-escrow: source eip155:8453 must list at least one non-empty asset in 'assets'",
    ],
    [
      'a source with no assets field',
      () => withSource((s) => delete s.assets),
      "atum-escrow: source eip155:8453 must list at least one non-empty asset in 'assets'",
    ],
    [
      'a source missing network',
      () => withSource((s) => delete s.network),
      "atum-escrow: source ? is missing 'network'",
    ],
    [
      'a Tron source on a network with no known Permit2 address',
      () => withSource((s) => (s.network = 'tron:nile')),
      TRON_NILE_MESSAGE,
    ],
    [
      'a Solana source missing svmSignatureClusterId',
      () => solana((s) => delete s.svmSignatureClusterId),
      `atum-escrow: Solana source ${SOLANA} requires svmSignatureClusterId and svmSignatureDomainVersion`,
    ],
    [
      'a Solana source missing svmSignatureDomainVersion',
      () => solana((s) => delete s.svmSignatureDomainVersion),
      `atum-escrow: Solana source ${SOLANA} requires svmSignatureClusterId and svmSignatureDomainVersion`,
    ],
    [
      'a Solana source with a fulfillment budget past the replay window',
      () => solana(undefined, 300),
      'atum-escrow: a corridor with a Solana source must set fulfillmentDeadlineSeconds <= 118 (Solana deposits expire within the escrow replay window); got 300',
    ],
  ])('refuses %s with INVALID_CONFIG', (_label, build, message) => {
    const err = configError(() => validateCorridor(build()));
    expect(err.code).toBe('INVALID_CONFIG');
    expect(err.message).toBe(message);
  });
});

describe('validateCorridor — sparse sources', () => {
  it('refuses a sources array with a hole at startup rather than at the first charge', () => {
    // Index 0 is a hole: array methods that skip holes would pass it, and the first charge to
    // reach that index would then fail. Only the refusal is pinned here, not its class.
    const sources: AtumEscrowCorridor['sources'][number][] = [];
    sources.length = 1;
    sources.push({ ...BASE_SOURCE, network: BASE, assets: [usdc(USDC_BASE)] });
    expect(() => validateCorridor({ ...corridor, sources })).toThrow();
  });
});

describe('validateCorridor — pegGroups shape', () => {
  const withPegGroups = (pegGroups: unknown, assets: AtumEscrowAsset[] = [usdt(USDT_BASE)]) =>
    oneSource(assets, { pegGroups: pegGroups as AtumEscrowCorridor['pegGroups'] });

  it.each<[string, unknown]>([
    ['a string', 'USDC,USDT'],
    ['an array containing null', [null]],
    ['a group containing an empty symbol', [['USDC', '']]],
    ['a group containing a number', [['USDC', 5]]],
  ])('refuses pegGroups that is %s', (_label, pegGroups) => {
    expectInvalid(withPegGroups(pegGroups), 'pegGroups');
  });

  it('refuses a flat array of symbols rather than reading it as substrings', () => {
    // Read as groups, ['USDC.e'] would be one "group" that is the string 'USDC.e', and a
    // substring test on it would join 'USDC' and 'USD'. A flat array is a shape error instead.
    const c = withPegGroups(['USDC.e'], [{ address: USDT_BASE, symbol: 'USD', decimals: 6 }]);
    expectInvalid(c, 'pegGroups');
  });

  it('accepts an empty group, which joins nothing', () => {
    expect(() => validateCorridor(withPegGroups([[]], [usdc(USDC_BASE)]))).not.toThrow();
  });

  it('applies an empty group as replacing the default, so USDC to USDT is incomparable', () => {
    const err = configError(() => validateCorridor(withPegGroups([[]])));
    expect(err.code).toBe('ASSETS_NOT_COMPARABLE');
  });
});

describe('validateCorridor — destination shape', () => {
  it.each<[string, (c: Record<string, unknown>) => void]>([
    ['missing', (c) => delete c.destination],
    ['null', (c) => (c.destination = null)],
    ['a string', (c) => (c.destination = 'eip155:42161')],
  ])('refuses a destination that is %s as a config error, not a TypeError', (_label, mutate) => {
    const c = { ...twoSources() } as Record<string, unknown>;
    mutate(c);
    expectInvalid(c, 'destination');
  });

  const networkCases: ReadonlyArray<[string, (d: Record<string, unknown>) => void]> = [
    ['missing', (d) => delete d.network],
    ['empty', (d) => (d.network = '')],
    ['not a string', (d) => (d.network = 42161)],
  ];
  /** `twoSources()` with only `destination.network` rewritten by `mutate`. */
  const withDestNetwork = (mutate: (d: Record<string, unknown>) => void): AtumEscrowCorridor => {
    const c = twoSources();
    const d = { ...c.destination } as Record<string, unknown>;
    mutate(d);
    return { ...c, destination: d as unknown as AtumEscrowCorridor['destination'] };
  };

  it('accepts the destination the network cases below each break once', () => {
    expect(() => validateCorridor(withDestNetwork(() => {}))).not.toThrow();
  });

  it.each(networkCases)('refuses a destination network that is %s', (_label, mutate) => {
    expectInvalid(withDestNetwork(mutate), 'destination.network');
  });

  // Building a charge reads the destination network's namespace, so an unchecked value would
  // surface there as a raw TypeError instead of a config error.
  it.each(networkCases)(
    'refuses a destination network that is %s when building a charge',
    (_label, mutate) => {
      const err = configError(() =>
        buildChargeRequest(
          withDestNetwork(mutate),
          { network: BASE, asset: USDC_BASE },
          '10000000',
        ),
      );
      expect(err.code).toBe('INVALID_CONFIG');
      expect(err.message).toContain('destination.network');
    },
  );
});

describe('validateCorridor — asset shape', () => {
  /** `twoSources()` with `sources[1].assets[0]` replaced by `asset`. */
  const firstOfSecond = (asset: unknown): unknown => {
    const c = twoSources();
    const s1 = c.sources[1]!;
    return { ...c, sources: [c.sources[0]!, { ...s1, assets: [asset, s1.assets[1]!] }] };
  };

  it.each<[string, unknown]>([
    ['a plain address string', USDC_OP],
    ['null', null],
  ])('refuses an asset that is %s, naming its path and the expected shape', (_label, asset) => {
    const err = configError(() => validateCorridor(firstOfSecond(asset) as AtumEscrowCorridor));
    expect(err.code).toBe('INVALID_CONFIG');
    expect(err.message).toContain('sources[1].assets[0]');
    expect(err.message).toContain('{ address, symbol, decimals }');
  });

  it.each<[string, (a: Record<string, unknown>) => void]>([
    ['empty', (a) => (a.address = '')],
    ['missing', (a) => delete a.address],
    ['a number', (a) => (a.address = 5)],
  ])('refuses an asset whose address is %s with the existing message', (_label, mutate) => {
    const a = { ...usdc(USDC_OP) } as Record<string, unknown>;
    mutate(a);
    const err = configError(() => validateCorridor(firstOfSecond(a) as AtumEscrowCorridor));
    expect(err.code).toBe('INVALID_CONFIG');
    expect(err.message).toBe(
      `atum-escrow: source ${OPTIMISM} must list at least one non-empty asset in 'assets'`,
    );
  });
});

describe('validateCorridor — decimals message', () => {
  // The offending value is rendered typed, so a string '6' cannot be mistaken for the number 6.
  it.each<[unknown, string]>([
    ['6', 'got "6"'],
    [78, 'got 78'],
    // A non-string is not JSON-rendered: JSON would print NaN as `null`.
    [Number.NaN, 'got NaN'],
  ])('renders destination decimals %o as %s', (decimals, rendered) => {
    const c = twoSources();
    const err = configError(() =>
      validateCorridor({
        ...c,
        destination: { ...c.destination, decimals: decimals as number },
      }),
    );
    expect(err.code).toBe('INVALID_CONFIG');
    expect(err.message).toContain(rendered);
  });
});

describe('AtumEscrowConfigError', () => {
  it('keeps the underlying error as its cause, without changing its message', () => {
    const c = oneSource([usdc(USDC_BASE)]);
    const err = configError(() =>
      validateCorridor({ ...c, sources: [{ ...c.sources[0]!, network: 'tron:nile' }] }),
    );
    expect(err.code).toBe('INVALID_CONFIG');
    expect(err.message).toBe(TRON_NILE_MESSAGE);
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain('no Permit2 address known');
  });

  it('is the same class from the root entry point as from the server entry point', () => {
    // Two copies of the class would make `instanceof` fail for a merchant importing from root.
    expect(RootAtumEscrowConfigError).toBe(AtumEscrowConfigError);
  });
});

describe('buildChargeRequest — corridor metadata', () => {
  it('validates the corridor, refusing an incomparable one', () => {
    const c = oneSource([{ address: WETH_BASE, symbol: 'WETH', decimals: 18 }]);
    const err = configError(() =>
      buildChargeRequest(c, { network: BASE, asset: WETH_BASE }, '10000000'),
    );
    expect(err.code).toBe('ASSETS_NOT_COMPARABLE');
  });

  it('selects an asset by address and puts its configured address string on the wire', () => {
    const c = oneSource([usdc(USDC_BASE), usdt(USDT_BASE)]);
    // EVM addresses select case-insensitively; the wire keeps the merchant's configured spelling.
    const r = buildChargeRequest(c, { network: BASE, asset: USDT_BASE.toLowerCase() }, '10000000');
    expect(typeof r.source.asset).toBe('string');
    expect(r.source.asset).toBe(USDT_BASE);
    expect(r.extra.destination.asset).toBe(c.destination.asset);
    expect(typeof r.extra.destination.asset).toBe('string');
  });

  it.each([
    [300, '10300000'],
    [0, '10000000'],
  ])('caps a same-decimals source at fulfillment plus %i bps markup', (markupBps, expectedCap) => {
    const c = oneSource([usdt(USDT_BASE)], { markupBps });
    const r = buildChargeRequest(c, { network: BASE, asset: USDT_BASE }, '10000000');
    expect(r.source.amount).toBe(expectedCap);
  });
});

describe('corridorFromDefaults — corridor metadata', () => {
  const defaults = {
    fetchChainDefaults: async (chainId: string) => ({
      escrowContract: `escrow-${chainId}`,
      quoteSelector: `reserver-${chainId}`,
      fulfillmentVerifierAccount: `releaser-${chainId}`,
      fulfillmentVerifierEndpoint: `https://verifier/${chainId}`,
      fulfillmentProxy: `proxy-${chainId}`,
    }),
  };
  const destination = { ...corridor.destination, symbol: 'USDC', decimals: 6 };
  // An 18-decimal USDC.e beside 6-decimal tokens, and USDT listed before USDC, so a builder that
  // re-sorts the assets or defaults their metadata cannot reproduce the input by accident.
  const sources = [
    { network: BASE, assets: [usdt(USDT_BASE), usdc(USDC_BASE)] },
    { network: OPTIMISM, assets: [{ address: USDC_OP, symbol: 'USDC.e', decimals: 18 }] },
  ];
  const params = {
    destination,
    sources,
    markupBps: 300,
    quoteDeadlineSeconds: 20,
    fulfillmentDeadlineSeconds: 300,
  };

  it('carries the declared token metadata through unchanged', async () => {
    const built = await corridorFromDefaults(defaults, params);
    expect(built.destination).toEqual(destination);
    expect(built.sources.map((s) => s.network)).toEqual([BASE, OPTIMISM]);
    expect(built.sources[0]!.assets).toEqual(sources[0]!.assets);
    expect(built.sources[1]!.assets).toEqual(sources[1]!.assets);
    // The role addresses still come from the defaults source, not from the params.
    expect(built.sources[1]!.escrow).toBe(`escrow-${OPTIMISM}`);
  });

  it('carries merchant peg groups when given', async () => {
    const pegGroups = [['USDC', 'USDC.e', 'USDT']];
    const built = await corridorFromDefaults(defaults, { ...params, pegGroups });
    expect(built.pegGroups).toEqual(pegGroups);
  });

  it('accepts readonly assets and peg groups', async () => {
    // A merchant declaring its tokens `as const` must not need a cast; this is a compile-time check
    // as much as a runtime one.
    const assets = [{ address: USDC_BASE, symbol: 'USDC', decimals: 6 }] as const;
    const pegGroups = [['USDC', 'USDT']] as const;
    const built = await corridorFromDefaults(defaults, {
      ...params,
      sources: [{ network: BASE, assets }],
      pegGroups,
    });
    expect(built.sources[0]!.assets).toEqual([{ address: USDC_BASE, symbol: 'USDC', decimals: 6 }]);
    expect(built.pegGroups).toEqual([['USDC', 'USDT']]);
  });

  it('leaves peg groups unset when none are given', async () => {
    const built = await corridorFromDefaults(defaults, params);
    expect(built.pegGroups).toBeUndefined();
  });
});
