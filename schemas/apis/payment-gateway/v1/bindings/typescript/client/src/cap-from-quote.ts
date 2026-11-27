import { describeValue, isCanonicalPositiveInteger } from './max-source-amount';

const BPS_DENOMINATOR = 10_000n;
const MAX_SLIPPAGE_BPS = 10_000;

/**
 * Derive a `max_source_amount` from a settler's quoted `source_amount` plus a slippage
 * tolerance in basis points.
 *
 * Input and output are both in the SOURCE token's smallest units: the exchange rate is already
 * inside the quote, so no decimals or price are needed and none are guessed. The result rounds
 * up, because a cap one unit below quote-plus-tolerance would refuse the fill the caller agreed to.
 *
 * @param sourceAmount The quoted `source_amount`, a positive integer in source smallest units.
 * @param slippageBps Headroom above the quote, whole basis points in [0, 10000].
 * @returns The cap as a canonical base-10 integer string.
 */
export function capFromQuote(sourceAmount: string | bigint, slippageBps: number): string {
  const amount = parseSourceAmount(sourceAmount);
  if (!Number.isSafeInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(
      `payment-gateway-client: slippageBps must be a whole number of basis points between 0 and ` +
        `${MAX_SLIPPAGE_BPS}, got ${describeValue(slippageBps)}`,
    );
  }

  const scaled = amount * (BPS_DENOMINATOR + BigInt(slippageBps));
  return ((scaled + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR).toString();
}

function parseSourceAmount(sourceAmount: string | bigint): bigint {
  if (typeof sourceAmount === 'bigint') {
    if (sourceAmount <= 0n) {
      throw new Error(
        `payment-gateway-client: sourceAmount must be a positive integer, got ${sourceAmount}`,
      );
    }
    return sourceAmount;
  }
  // Declared types are erased at runtime. RegExp.test and BigInt() would both coerce a number,
  // array or object, and a number past 2^53 has already lost precision before it arrives.
  if (typeof sourceAmount !== 'string') {
    throw new Error(
      `payment-gateway-client: sourceAmount must be a string or bigint, got ${typeof sourceAmount}`,
    );
  }
  // BigInt() alone would accept "01", " 5" and "0x10"; a quote is only ever a plain base-10
  // integer, so anything else is refused rather than reinterpreted.
  if (!isCanonicalPositiveInteger(sourceAmount)) {
    throw new Error(
      `payment-gateway-client: sourceAmount must be a positive base-10 integer in the source ` +
        `token's smallest units, got ${JSON.stringify(sourceAmount)}`,
    );
  }
  return BigInt(sourceAmount);
}
