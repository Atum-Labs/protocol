// The merchant's spend cap across token decimals: `source.amount` is the fulfillment price converted
// from destination-token units into source-token units, plus the markup, rounded down. A cap that
// rounding leaves worth less than the price is refused: no settler would fill the merchant at a
// loss, so every payment against that cap would fail.
// Expected values are computed here from the stated rule with BigInt, not read from the code.

import { describe, it, expect } from 'vitest';
import {
  buildChargeRequest,
  buildChargeChallenge,
  validateCorridor,
  AtumEscrowConfigError,
  type AtumEscrowConfigErrorCode,
  type AtumEscrowCorridor,
} from './server.js';
import { assertCapWithinBound, DEFAULT_MAX_MARKUP_BPS, DEFAULT_PEG_GROUPS } from './cap.js';
import { AtumEscrowTrustError } from './trust.js';

const SOURCE_NETWORK = 'eip155:8453';
const DEST_NETWORK = 'eip155:42161';
const SOURCE_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DEST_ASSET = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';

interface Pair {
  label: string;
  dest: { symbol: string; decimals: number };
  source: { symbol: string; decimals: number };
}

// Every pair is in the default peg group, so comparability never decides an outcome here.
const SAME_6: Pair = {
  label: '6/6',
  dest: { symbol: 'USDC', decimals: 6 },
  source: { symbol: 'USDT', decimals: 6 },
};
const DOWN_18_TO_6: Pair = {
  label: '18→6',
  dest: { symbol: 'USDT', decimals: 18 },
  source: { symbol: 'USDC', decimals: 6 },
};
const UP_6_TO_18: Pair = {
  label: '6→18',
  dest: { symbol: 'USDC', decimals: 6 },
  source: { symbol: 'USDT', decimals: 18 },
};

function corridorFor(pair: Pair, markupBps: number): AtumEscrowCorridor {
  return {
    destination: {
      network: DEST_NETWORK,
      asset: DEST_ASSET,
      account: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      ...pair.dest,
    },
    fulfillmentProxy: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    markupBps,
    quoteDeadlineSeconds: 20,
    fulfillmentDeadlineSeconds: 300,
    sources: [
      {
        network: SOURCE_NETWORK,
        assets: [{ address: SOURCE_ASSET, ...pair.source }],
        escrow: '0x938deF3968f2227dD44Dbd270C491F6CAC1F2e33',
        reserver: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
        releaser: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
        fulfillmentVerifierEndpoint: 'https://verifier.example.com',
      },
    ],
  };
}

const SELECT = { network: SOURCE_NETWORK, asset: SOURCE_ASSET };

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** floor(F × (10000 + bps) × 10^s / (10000 × 10^d)). */
function expectedCap(f: bigint, bps: number, pair: Pair): bigint {
  return (
    (f * (10000n + BigInt(bps)) * pow10(pair.source.decimals)) /
    (10000n * pow10(pair.dest.decimals))
  );
}

/** Refused when the rounded cap is worth less than the price: cap × 10^d < F × 10^s. */
function capBelowPrice(f: bigint, bps: number, pair: Pair): boolean {
  return expectedCap(f, bps, pair) * pow10(pair.dest.decimals) < f * pow10(pair.source.decimals);
}

function charge(pair: Pair, markupBps: number, f: string) {
  return buildChargeRequest(corridorFor(pair, markupBps), SELECT, f);
}

/** Run `fn`, require a typed config error with `code`, and hand it back. */
function configError(fn: () => unknown, code: AtumEscrowConfigErrorCode): AtumEscrowConfigError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected a config error, but nothing was thrown').toBeDefined();
  expect(caught).toBeInstanceOf(AtumEscrowConfigError);
  expect(caught).toBeInstanceOf(Error);
  const err = caught as AtumEscrowConfigError;
  expect(err.code).toBe(code);
  return err;
}

describe('buildChargeRequest — cap across decimals', () => {
  it('converts an 18-decimal price into a 6-decimal cap', () => {
    const r = charge(DOWN_18_TO_6, 300, '10000000000000000000');
    expect(r.source.amount).toBe('10300000');
    expect(r.extra.fulfillmentAmount).toBe('10000000000000000000');
  });

  it('converts a 6-decimal price into an 18-decimal cap', () => {
    const r = charge(UP_6_TO_18, 300, '10000000');
    expect(r.source.amount).toBe('10300000000000000000');
    expect(r.extra.fulfillmentAmount).toBe('10000000');
  });

  it.each<[string, number]>([
    ['10000000', 0],
    ['10000000', 300],
    ['10000000', 500],
    // 333 × 10300 / 10000 = 342.99, so the cap rounds down to 342.
    ['333', 300],
    ['1', 1],
    [(2n ** 130n + 12345n).toString(), 300],
  ])('keeps equal-decimals caps at floor(F × (10000 + bps) / 10000): F=%s, bps=%i', (f, bps) => {
    const r = charge(SAME_6, bps, f);
    expect(r.source.amount).toBe(((BigInt(f) * (10000n + BigInt(bps))) / 10000n).toString());
    expect(r.extra.fulfillmentAmount).toBe(f);
  });

  it('rounds the fractional equal-decimals case down', () => {
    expect(charge(SAME_6, 300, '333').source.amount).toBe('342');
  });
});

describe('buildChargeRequest — the payer accepts every cap within its markup bound', () => {
  /** The payer's own guard, fed the same symbol and decimals the corridor declares. */
  function payerCheck(pair: Pair, amount: string, fulfillmentAmount: string): void {
    assertCapWithinBound({
      sourceNetwork: SOURCE_NETWORK,
      sourceAsset: SOURCE_ASSET,
      sourceTokens: [{ address: SOURCE_ASSET, ...pair.source }],
      destinationNetwork: DEST_NETWORK,
      destinationAsset: DEST_ASSET,
      destinationTokens: [{ address: DEST_ASSET, ...pair.dest }],
      amount,
      fulfillmentAmount,
      maxMarkupBps: DEFAULT_MAX_MARKUP_BPS,
      pegGroups: DEFAULT_PEG_GROUPS,
      fields: {
        amount: 'amount',
        sourceAsset: 'sourceAsset',
        destinationAsset: 'destinationAsset',
      },
    });
  }

  // One whole destination token for each pair, large enough that a 1 bps excess survives rounding.
  const cases: ReadonlyArray<[Pair, string]> = [
    [SAME_6, '10000000'],
    [DOWN_18_TO_6, '10000000000000000000'],
    [UP_6_TO_18, '10000000'],
  ];

  it.each(
    cases.flatMap(([pair, f]) => [0, 300, 500].map((bps) => [pair.label, bps, pair, f] as const)),
  )('%s at %i bps passes the payer bound', (_label, bps, pair, f) => {
    const r = charge(pair, bps, f);
    expect(() => payerCheck(pair, r.source.amount, f)).not.toThrow();
  });

  it.each(cases.map(([pair, f]) => [pair.label, pair, f] as const))(
    '%s at 501 bps exceeds the default payer bound',
    (_label, pair, f) => {
      // Discriminator: 501 bps must produce a cap above the 500 bps one, or this proves nothing.
      expect(expectedCap(BigInt(f), 501, pair)).toBeGreaterThan(expectedCap(BigInt(f), 500, pair));
      const r = charge(pair, 501, f);
      let caught: unknown;
      try {
        payerCheck(pair, r.source.amount, f);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AtumEscrowTrustError);
      expect((caught as AtumEscrowTrustError).code).toBe('MARKUP_EXCEEDED');
    },
  );
});

describe('buildChargeRequest — INVALID_AMOUNT', () => {
  it.each<[string, unknown]>([
    ['hex', '0x10'],
    ['leading space', ' 1'],
    ['trailing space', '1 '],
    ['a plus sign', '+1'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['exponent', '1e3'],
    ['empty', ''],
    ['a number', 10],
    ['undefined', undefined],
  ])('refuses a fulfillmentAmount that is %s', (_label, f) => {
    // Discriminator: the same corridor and select build a request for a valid amount.
    expect(() => charge(SAME_6, 300, '10')).not.toThrow();
    const err = configError(() => charge(SAME_6, 300, f as string), 'INVALID_AMOUNT');
    expect(err.message).toContain('fulfillmentAmount');
  });
});

describe('buildChargeRequest — CAP_BELOW_PRICE', () => {
  const pair = DOWN_18_TO_6;
  const bps = 300;

  /**
   * The largest refused price, derived from the rule. For cap k the prices form the band
   * [ceil(k·B), ceil((k+1)·B) − 1] with B = 10^(d−s+4) / (10000 + bps); within it the price is
   * refused above k·10^(d−s). Past F·bps/10000 ≥ 10^(d−s) the markup covers a whole unit of
   * rounding, so no band beyond that can hold a refusal and the search stops there.
   */
  function largestRefused(): bigint {
    const unit = pow10(pair.dest.decimals - pair.source.decimals);
    const num = 10000n * unit;
    const den = 10000n + BigInt(bps);
    const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
    const limit = ceilDiv(10000n * unit, BigInt(bps));
    let best = -1n;
    for (let k = 0n; ceilDiv(k * num, den) <= limit; k++) {
      const bandEnd = ceilDiv((k + 1n) * num, den) - 1n;
      if (bandEnd > k * unit) best = bandEnd;
    }
    return best;
  }

  const refusedF = largestRefused();
  const acceptedF = refusedF + 1n;

  it('derives a boundary the rule itself refuses on one side and accepts on the other', () => {
    expect(refusedF).toBeGreaterThan(0n);
    expect(capBelowPrice(refusedF, bps, pair)).toBe(true);
    expect(capBelowPrice(acceptedF, bps, pair)).toBe(false);
  });

  it('refuses the largest price whose rounded cap is worth less than it', () => {
    const err = configError(() => charge(pair, bps, refusedF.toString()), 'CAP_BELOW_PRICE');
    expect(err.network).toBe(SOURCE_NETWORK);
  });

  it('accepts the next price up, at the formula cap', () => {
    const r = charge(pair, bps, acceptedF.toString());
    expect(r.source.amount).toBe(expectedCap(acceptedF, bps, pair).toString());
  });

  it('accepts 10^12 at no markup with a cap of 1', () => {
    expect(charge(pair, 0, '1000000000000').source.amount).toBe('1');
  });

  it('refuses 10^12 + 1 at no markup', () => {
    const err = configError(() => charge(pair, 0, '1000000000001'), 'CAP_BELOW_PRICE');
    expect(err.network).toBe(SOURCE_NETWORK);
  });

  it('accepts a zero price with a zero cap', () => {
    expect(charge(pair, bps, '0').source.amount).toBe('0');
  });

  it.each([SAME_6, UP_6_TO_18].map((p) => [p.label, p] as const))(
    'never refuses %s, where the source has as many or more decimals',
    (_label, p) => {
      expect(charge(p, 0, '1').source.amount).toBe(expectedCap(1n, 0, p).toString());
    },
  );
});

describe('validateCorridor — whole-number markup', () => {
  it('refuses a fractional markupBps', () => {
    const err = configError(() => validateCorridor(corridorFor(SAME_6, 300.5)), 'INVALID_CONFIG');
    expect(err.message).toContain('markupBps');
    expect(err.message).toContain('whole number');
  });
});

describe('buildChargeChallenge — inherits the cap rules', () => {
  const challengeFor = (pair: Pair, bps: number, f: string) =>
    buildChargeChallenge(corridorFor(pair, bps), SELECT, f, { intentId: 'order-1' });

  it('refuses an invalid amount with INVALID_AMOUNT', () => {
    configError(() => challengeFor(SAME_6, 300, '1.5'), 'INVALID_AMOUNT');
  });

  it('refuses a cap below the price with CAP_BELOW_PRICE', () => {
    configError(() => challengeFor(DOWN_18_TO_6, 0, '1000000000001'), 'CAP_BELOW_PRICE');
  });

  it('carries the formula cap', () => {
    const c = challengeFor(DOWN_18_TO_6, 300, '10000000000000000000');
    expect(c.request.source.amount).toBe(expectedCap(10n ** 19n, 300, DOWN_18_TO_6).toString());
  });
});
