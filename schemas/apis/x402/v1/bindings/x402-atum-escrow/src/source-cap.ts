/**
 * The most a payer may authorize on the source chain for a given fulfillment.
 *
 * Not part of the published surface. The payer's bound is computed here, once, so any cap that must
 * agree with it can be derived by the same arithmetic. The result never decreases as the markup
 * grows, so a cap derived under a markup no larger than the payer's allowed one is never above
 * what the payer accepts.
 */

const AMOUNT = /^[0-9]+$/;

// A uint256 amount has at most 78 digits, so a token cannot use more than 77 decimals and still
// represent one whole unit.
export const MAX_TOKEN_DECIMALS = 77;

export interface SourceCapInput {
  /** Exact amount the merchant receives, in atomic units of the destination token. */
  fulfillmentAmount: string;
  /** Markup over `fulfillmentAmount`, in basis points. */
  markupBps: number;
  sourceDecimals: number;
  destinationDecimals: number;
}

/**
 * `fulfillmentAmount × (1 + markupBps/10000)`, converted from destination to source atomic units
 * and rounded down to a whole unit.
 *
 * Rounding down is exact for the comparison callers make: an integer amount exceeds the true
 * value exactly when it exceeds its floor.
 *
 * @throws RangeError on an amount that is not a plain non-negative integer, a negative or
 *   fractional markup, or decimals outside 0–77.
 */
export function maxSourceAmount(input: SourceCapInput): bigint {
  const { fulfillmentAmount, markupBps, sourceDecimals, destinationDecimals } = input;
  if (!AMOUNT.test(fulfillmentAmount)) {
    throw new RangeError(
      `atum-escrow: fulfillmentAmount must be a non-negative integer, got '${fulfillmentAmount}'`,
    );
  }
  if (!Number.isInteger(markupBps) || markupBps < 0) {
    throw new RangeError(
      `atum-escrow: markupBps must be a non-negative integer, got ${String(markupBps)}`,
    );
  }
  assertDecimals('sourceDecimals', sourceDecimals);
  assertDecimals('destinationDecimals', destinationDecimals);

  // The markup becomes a bigint before the 10000 is added: as Numbers, the sum above 2^53 rounds
  // to the nearest double, which can land above the true bound.
  const exact =
    BigInt(fulfillmentAmount) * (10_000n + BigInt(markupBps)) * 10n ** BigInt(sourceDecimals);
  return exact / (10_000n * 10n ** BigInt(destinationDecimals));
}

/** Whether `value` is a token decimals count the cap arithmetic can use: an integer from 0 to 77. */
export function isTokenDecimals(value: unknown): value is number {
  return (
    Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_TOKEN_DECIMALS
  );
}

function assertDecimals(name: string, decimals: number): void {
  if (!isTokenDecimals(decimals)) {
    throw new RangeError(
      `atum-escrow: ${name} must be an integer from 0 to ${MAX_TOKEN_DECIMALS}, got ${String(decimals)}`,
    );
  }
}
