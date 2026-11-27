import { capFromQuote } from './index';

/** The thrown value itself, so a case can assert both its class and its exact message prefix. */
function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the call to be refused');
}

describe('capFromQuote', () => {
  describe('cap arithmetic', () => {
    // Each row is ceil(amount * (10000 + bps) / 10000); the cap may only ever round up, since a cap
    // one unit short of the quote plus tolerance would refuse a fill the caller agreed to.
    it.each([
      ['exact division', '100010000', 50, '100510050'],
      ['a fractional result, rounded up', '333', 2, '334'],
      ['zero slippage', '100000', 0, '100000'],
      ['the inclusive upper bound of slippage', '100000', 10000, '200000'],
      ['the smallest amount, rounded up by exactly one unit', '1', 1, '2'],
    ])('computes the cap for %s', (_label, amount, bps, expected) => {
      const result = capFromQuote(amount, bps);

      expect(typeof result).toBe('string');
      expect(result).toBe(expected);
    });

    it('treats a bigint amount the same as its string form', () => {
      const result = capFromQuote(100010000n, 50);

      expect(typeof result).toBe('string');
      expect(result).toBe('100510050');
    });

    // Token amounts in smallest units routinely exceed 2^53, where a float path silently rounds.
    it.each([
      ['1000000000000000001', 0, '1000000000000000001'],
      ['1000000000000000000', 2, '1000200000000000000'],
    ])('stays exact past Number.MAX_SAFE_INTEGER for %s at %d bps', (amount, bps, expected) => {
      expect(capFromQuote(amount, bps)).toBe(expected);
    });
  });

  describe('source amount validation', () => {
    // Only a canonical positive base-10 integer is a quote; anything a lenient parser would coerce
    // (whitespace, exponent, hex, leading zeros) must be refused rather than reinterpreted.
    it.each(['', '0', '01', '1.5', '-5', ' 5', '5 ', '1e6', '0x10', 'abc'])(
      'refuses the string amount %j',
      (amount) => {
        const err = errorOf(() => capFromQuote(amount, 50));

        expect(err).toBeInstanceOf(Error);
        expect(err.message.startsWith('payment-gateway-client:')).toBe(true);
      },
    );

    it.each([0n, -5n])('refuses the bigint amount %p', (amount) => {
      const err = errorOf(() => capFromQuote(amount, 50));

      expect(err).toBeInstanceOf(Error);
      expect(err.message.startsWith('payment-gateway-client:')).toBe(true);
    });
  });

  describe('slippage validation', () => {
    // Slippage is whole basis points in [0, 10000]; a fraction, a non-finite value or anything out
    // of range would make the cap meaningless.
    it.each([-1, 10001, 0.5, NaN, Infinity, -Infinity])('refuses slippage %p', (bps) => {
      const err = errorOf(() => capFromQuote('100000', bps));

      expect(err).toBeInstanceOf(Error);
      expect(err.message.startsWith('payment-gateway-client:')).toBe(true);
    });
  });

  describe('runtime type validation', () => {
    // Declared types are erased at runtime, so a plain-JavaScript caller can pass anything; the
    // widened alias lets these cases reach the function while the file still type-checks.
    const capFromQuoteUntyped = capFromQuote as unknown as (
      sourceAmount: unknown,
      slippageBps: unknown,
    ) => string;

    // Coercing any of these would turn a malformed input into a plausible-looking cap: a number
    // past 2^53 has already lost precision, and objects/arrays stringify to whatever they choose.
    // A label column keeps the test titles readable regardless of the raw value's formatting.
    it.each<[string, unknown, number]>([
      // eslint-disable-next-line no-loss-of-precision -- deliberately imprecise, to prove a pre-rounded number is refused
      ['an imprecise number past 2^53', 9007199254740993, 50],
      ['a small number', 5, 50],
      ['a small number at zero slippage', 5, 0],
      ['an array holding a numeric string', ['5'], 50],
      ['an object with a numeric toString', { toString: () => '7' }, 50],
      ['a Symbol', Symbol('x'), 50],
    ])('refuses a source amount that is %s', (_label, amount, bps) => {
      const err = errorOf(() => capFromQuoteUntyped(amount, bps));

      expect(err).toBeInstanceOf(Error);
      expect(err.message.startsWith('payment-gateway-client:')).toBe(true);
    });

    it.each<[string, unknown]>([
      ['a Symbol', Symbol('s')],
      ['a numeric string', '50'],
    ])('refuses slippage that is %s', (_label, bps) => {
      const err = errorOf(() => capFromQuoteUntyped('100000', bps));

      expect(err).toBeInstanceOf(Error);
      expect(err.message.startsWith('payment-gateway-client:')).toBe(true);
    });
  });
});
