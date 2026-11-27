const CANONICAL_POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/**
 * True only for a plain base-10 positive integer string. The typeof check comes first because
 * RegExp.test would otherwise coerce a number, array or object to a string and accept it.
 */
export function isCanonicalPositiveInteger(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_POSITIVE_INTEGER.test(value);
}

/** Formats a rejected value without coercing it, so a Symbol or a numeric string reads truthfully. */
export function describeValue(value: unknown): string {
  if (typeof value === 'number') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  return typeof value === 'string' ? JSON.stringify(value) : typeof value;
}

/** The corridor a cap belongs to, named in the error so the caller knows which units it is in. */
export interface CapCorridor {
  sourceAsset: string;
  destinationAsset: string;
}

/**
 * Validate a caller-supplied `max_source_amount` (source token smallest units) without ever
 * deriving one: the SDK knows neither token's decimals nor their price, so any value it invented
 * would be a guess signed or sent as the payer's spend ceiling.
 *
 * In `optional` mode an omitted cap resolves to `undefined`, meaning the caller set no cap. In
 * `required` mode it is refused, because the cap is about to become a signed spend authorization.
 */
export function resolveMaxSourceAmount(value: unknown, mode: 'optional'): string | undefined;
export function resolveMaxSourceAmount(
  value: unknown,
  mode: 'required',
  corridor: CapCorridor,
): string;
export function resolveMaxSourceAmount(
  value: unknown,
  mode: 'optional' | 'required',
  corridor?: CapCorridor,
): string | undefined {
  if (value === undefined) {
    if (mode === 'optional') {
      return undefined;
    }
    throw new Error(
      `payment-gateway-client: maxSourceAmount is required to pay from ${corridor?.sourceAsset} to ` +
        `${corridor?.destinationAsset}. It is the most the payer authorizes the escrow to take, in ` +
        `the source token's smallest units, and the SDK cannot derive it: that needs both tokens' ` +
        `decimals and a price. Derive it from a settler quote with capFromQuote(sourceAmount, ` +
        `slippageBps), or state it explicitly.`,
    );
  }
  if (!isCanonicalPositiveInteger(value)) {
    throw new Error(
      `payment-gateway-client: maxSourceAmount must be a positive base-10 integer in the source ` +
        `token's smallest units, got ${describeValue(value)}`,
    );
  }
  return value;
}
