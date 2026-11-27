/**
 * The source-side cap: the most a payer can be charged in source-token atomic units for a given
 * destination fulfillment amount plus markup.
 *
 * The cap is the floor of an exact rational, computed in integer arithmetic. Rounding down matters:
 * rounding up would authorise one atomic unit more than the quoted markup allows, and floating-point
 * arithmetic would silently lose precision on 18-decimal amounts. The same cap is enforced by the
 * x402 binding, so the two must agree on every input, including which inputs they refuse.
 */
import { describe, it, expect } from 'vitest';
import { maxSourceAmount, isTokenDecimals, MAX_TOKEN_DECIMALS } from './source-cap.js';

type Input = Parameters<typeof maxSourceAmount>[0];

/** Numerator and denominator of the exact value, computed independently of the unit under test. */
function exact(input: Input): { n: bigint; d: bigint } {
  const n =
    BigInt(input.fulfillmentAmount) *
    (10000n + BigInt(input.markupBps)) *
    10n ** BigInt(input.sourceDecimals);
  const d = 10000n * 10n ** BigInt(input.destinationDecimals);
  return { n, d };
}

/**
 * Asserts both the error class and that the message names the offending parameter, so a caller
 * surfacing the error can tell which field of the challenge was malformed.
 */
function expectRangeErrorNaming(fn: () => unknown, parameter: string, label: string): void {
  expect(fn, label).toThrow(RangeError);
  expect(fn, label).toThrow(new RegExp(`\\b${parameter}\\b`));
}

const VALID: Input = {
  fulfillmentAmount: '10000000',
  markupBps: 300,
  sourceDecimals: 6,
  destinationDecimals: 6,
};

/** Larger than 2^128, so any narrowing through a 64-bit or float path would corrupt it. */
const HUGE = '340282366920938463463374607431768211457';

describe('source cap — decimals bound', () => {
  it('caps token decimals at 77', () => {
    expect(MAX_TOKEN_DECIMALS).toBe(77);
  });

  it('recognises integers 0 through 77 inclusive as token decimals', () => {
    for (const value of [0, 6, 18, 77]) {
      expect(isTokenDecimals(value), String(value)).toBe(true);
    }
  });

  it('refuses out-of-range, fractional, non-finite and non-number values', () => {
    for (const value of [-1, 78, 1.5, Number.NaN, '6', null, undefined]) {
      expect(isTokenDecimals(value), String(value)).toBe(false);
    }
  });
});

describe('source cap — equal decimals', () => {
  it('applies the markup to a whole amount', () => {
    expect(maxSourceAmount(VALID)).toBe(10300000n);
  });

  it('rounds a fractional result down, never up', () => {
    // Exact value is 10500001.05; one unit more would exceed the quoted markup.
    expect(maxSourceAmount({ ...VALID, fulfillmentAmount: '10000001', markupBps: 500 })).toBe(
      10500001n,
    );
  });

  it('equals floor(F × (10000 + bps) / 10000)', () => {
    for (const [f, bps] of [
      ['1', 1],
      ['9999', 1],
      ['3', 3333],
      ['123456789', 47],
      [HUGE, 300],
    ] as const) {
      const expected = (BigInt(f) * (10000n + BigInt(bps))) / 10000n;
      expect(maxSourceAmount({ ...VALID, fulfillmentAmount: f, markupBps: bps })).toBe(expected);
    }
  });

  it('returns the fulfillment amount unchanged when there is no markup', () => {
    for (const f of ['0', '1', '10000000', '18446744073709551617', HUGE]) {
      expect(maxSourceAmount({ ...VALID, fulfillmentAmount: f, markupBps: 0 })).toBe(BigInt(f));
    }
  });

  it('returns zero for a zero fulfillment amount whatever the markup', () => {
    expect(maxSourceAmount({ ...VALID, fulfillmentAmount: '0' })).toBe(0n);
  });
});

describe('source cap — differing decimals', () => {
  it('scales an 18-decimal destination down to a 6-decimal source', () => {
    expect(
      maxSourceAmount({
        fulfillmentAmount: '10000000000000000000',
        markupBps: 300,
        sourceDecimals: 6,
        destinationDecimals: 18,
      }),
    ).toBe(10300000n);
  });

  it('scales a 6-decimal destination up to an 18-decimal source', () => {
    expect(
      maxSourceAmount({
        fulfillmentAmount: '10000000',
        markupBps: 300,
        sourceDecimals: 18,
        destinationDecimals: 6,
      }),
    ).toBe(10300000000000000000n);
  });
});

describe('source cap — tightness', () => {
  // Pins the floor exactly: the result never exceeds the exact value, and adding one unit would.
  const table: Input[] = [
    { fulfillmentAmount: '0', markupBps: 0, sourceDecimals: 0, destinationDecimals: 0 },
    { fulfillmentAmount: '1', markupBps: 1, sourceDecimals: 0, destinationDecimals: 0 },
    { fulfillmentAmount: '7', markupBps: 9999, sourceDecimals: 6, destinationDecimals: 18 },
    { fulfillmentAmount: '10000001', markupBps: 500, sourceDecimals: 6, destinationDecimals: 6 },
    {
      fulfillmentAmount: '999999999999',
      markupBps: 300,
      sourceDecimals: 9,
      destinationDecimals: 6,
    },
    {
      fulfillmentAmount: '123456789012345678901',
      markupBps: 10000,
      sourceDecimals: 6,
      destinationDecimals: 18,
    },
    { fulfillmentAmount: '1', markupBps: 25000, sourceDecimals: 18, destinationDecimals: 0 },
    { fulfillmentAmount: HUGE, markupBps: 1, sourceDecimals: 77, destinationDecimals: 0 },
    { fulfillmentAmount: HUGE, markupBps: 9999, sourceDecimals: 0, destinationDecimals: 77 },
    { fulfillmentAmount: '33333333333', markupBps: 333, sourceDecimals: 9, destinationDecimals: 9 },
    { fulfillmentAmount: '5', markupBps: 500, sourceDecimals: 0, destinationDecimals: 6 },
    {
      fulfillmentAmount: '1000000000000000001',
      markupBps: 0,
      sourceDecimals: 6,
      destinationDecimals: 18,
    },
  ];

  it('returns the largest integer not exceeding the exact value', () => {
    for (const input of table) {
      const { n, d } = exact(input);
      const result = maxSourceAmount(input);
      expect(result * d <= n, JSON.stringify(input)).toBe(true);
      expect((result + 1n) * d > n, JSON.stringify(input)).toBe(true);
    }
  });
});

describe('source cap — markups beyond the safe-integer range', () => {
  // Number.isInteger accepts these, but adding 10000 to them as Numbers rounds to the nearest
  // representable double (spacing 2^(e-52)), so the 10000 can be partly or wholly absorbed. The
  // markup must reach integer arithmetic before the 10000 is added.
  const LARGE_BPS_EXPONENTS = [53, 60, 66, 70];

  for (const exponent of LARGE_BPS_EXPONENTS) {
    it(`computes the exact floor at equal decimals for markupBps = 2^${exponent}`, () => {
      const markupBps = 2 ** exponent;
      const expected = (10000n * (10000n + BigInt(markupBps))) / 10000n;
      expect(maxSourceAmount({ ...VALID, fulfillmentAmount: '10000', markupBps })).toBe(expected);
    });
  }

  it('computes the exact floor across decimals (18 source, 6 destination) for markupBps = 2^66', () => {
    const input: Input = {
      fulfillmentAmount: '10000',
      markupBps: 2 ** 66,
      sourceDecimals: 18,
      destinationDecimals: 6,
    };
    const { n, d } = exact(input);
    const result = maxSourceAmount(input);
    expect(result * d <= n, JSON.stringify(input)).toBe(true);
    expect((result + 1n) * d > n, JSON.stringify(input)).toBe(true);
  });
});

describe('source cap — monotone in markup', () => {
  it('never decreases as the markup grows', () => {
    const bpsSequence = [0, 1, 2, 299, 300, 500, 9999, 10000, 10001, 50000];
    const combos: Array<Omit<Input, 'markupBps'>> = [
      { fulfillmentAmount: '10000001', sourceDecimals: 6, destinationDecimals: 6 },
      { fulfillmentAmount: '7', sourceDecimals: 6, destinationDecimals: 18 },
      { fulfillmentAmount: '123456789', sourceDecimals: 18, destinationDecimals: 6 },
      { fulfillmentAmount: HUGE, sourceDecimals: 0, destinationDecimals: 9 },
    ];
    for (const combo of combos) {
      const results = bpsSequence.map((markupBps) => maxSourceAmount({ ...combo, markupBps }));
      for (let i = 1; i < results.length; i++) {
        expect(results[i] >= results[i - 1], JSON.stringify(combo)).toBe(true);
      }
    }
  });
});

describe('source cap — input validation', () => {
  it('rejects a fulfillment amount that is not a plain non-negative decimal integer', () => {
    // Only plain decimal digits are allowed. The table mixes forms BigInt() would silently accept
    // ('' as 0, surrounding whitespace, hex, a leading sign) with forms it rejects (a fraction,
    // exponent notation); every one must be refused so the amount the cap is computed over is
    // exactly the one a reader of the payload would see.
    for (const fulfillmentAmount of ['', '-1', '1.5', ' 1', '1 ', '0x10', '1e3', '+1']) {
      expectRangeErrorNaming(
        () => maxSourceAmount({ ...VALID, fulfillmentAmount }),
        'fulfillmentAmount',
        JSON.stringify(fulfillmentAmount),
      );
    }
  });

  it('rejects a markup that is negative, fractional or not finite', () => {
    for (const markupBps of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectRangeErrorNaming(
        () => maxSourceAmount({ ...VALID, markupBps }),
        'markupBps',
        String(markupBps),
      );
    }
  });

  it('rejects source or destination decimals that are negative, fractional, NaN or above 77', () => {
    for (const decimals of [-1, 6.5, Number.NaN, 78]) {
      expectRangeErrorNaming(
        () => maxSourceAmount({ ...VALID, sourceDecimals: decimals }),
        'sourceDecimals',
        `source ${decimals}`,
      );
      expectRangeErrorNaming(
        () => maxSourceAmount({ ...VALID, destinationDecimals: decimals }),
        'destinationDecimals',
        `destination ${decimals}`,
      );
    }
  });

  it('accepts decimals 0 and 77 on either side and a zero markup', () => {
    for (const sourceDecimals of [0, 77]) {
      for (const destinationDecimals of [0, 77]) {
        const input: Input = { ...VALID, markupBps: 0, sourceDecimals, destinationDecimals };
        const { n, d } = exact(input);
        expect(maxSourceAmount(input), JSON.stringify(input)).toBe(n / d);
      }
    }
  });
});
