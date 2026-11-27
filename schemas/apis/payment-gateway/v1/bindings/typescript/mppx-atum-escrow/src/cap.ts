/**
 * The payer's bound on the spend cap.
 *
 * The cap (`source.amount`) is the most the escrow may ever pull from the payer. An honest auction
 * charges less, but a thin auction, a compromised quote selector or a bug can charge up to the cap,
 * so the payer refuses a cap further above the price than it allows. The price is
 * `fulfillmentAmount`, in the destination token; the cap is in the source token, so both are
 * compared in one unit, and only between tokens the payer treats as the same money.
 */

import { caipEqual } from './internal.js';
import { maxSourceAmount } from './source-cap.js';
import { AtumEscrowTrustError, type TrustedToken } from './trust.js';

/**
 * The markup over `fulfillmentAmount`, in basis points, the client accepts when the payer sets
 * none: room above the 3% the merchant SDK documents, while bounding the payer's extra exposure.
 *
 * @public
 */
export const DEFAULT_MAX_MARKUP_BPS = 500;

/**
 * Tokens the client treats as interchangeable 1:1 when the payer sets none: the US-dollar
 * stablecoins on the network's allowlists. The allowlist records only symbol, address and
 * decimals, so this list is the peg assumption itself. A token outside every group is comparable
 * only with itself.
 *
 * @public
 */
export const DEFAULT_PEG_GROUPS: ReadonlyArray<ReadonlyArray<string>> = Object.freeze([
  Object.freeze([
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
  ]),
]);

export interface CapCheck {
  sourceNetwork: string;
  sourceAsset: string;
  sourceTokens: ReadonlyArray<TrustedToken>;
  destinationNetwork: string;
  destinationAsset: string;
  destinationTokens: ReadonlyArray<TrustedToken>;
  amount: string;
  fulfillmentAmount: string;
  maxMarkupBps: number;
  pegGroups: ReadonlyArray<ReadonlyArray<string>>;
  /**
   * The challenge members the amount and the two tokens came from, reported as a refusal's
   * `field` so the error names what the caller wrote rather than this module's parameter.
   */
  fields: { amount: string; sourceAsset: string; destinationAsset: string };
}

/**
 * Refuse a cap the payer does not accept: either token unknown to the trust source, tokens that
 * are not the same money, or an amount above `fulfillmentAmount` plus the allowed markup.
 */
export function assertCapWithinBound(check: CapCheck): void {
  const source = findToken(
    check.sourceTokens,
    check.sourceNetwork,
    check.sourceAsset,
    check.fields.sourceAsset,
  );
  const destination = findToken(
    check.destinationTokens,
    check.destinationNetwork,
    check.destinationAsset,
    check.fields.destinationAsset,
  );
  if (!comparable(source.symbol, destination.symbol, check.pegGroups)) {
    throw new AtumEscrowTrustError({
      code: 'ASSETS_NOT_COMPARABLE',
      network: check.sourceNetwork,
      message: `atum-escrow: ${source.symbol} on ${check.sourceNetwork} cannot be priced against ${destination.symbol} on ${check.destinationNetwork}`,
    });
  }

  // The bound is floored, which loses nothing: a whole-unit amount exceeds the exact bound exactly
  // when it exceeds its floor.
  const max = maxSourceAmount({
    fulfillmentAmount: check.fulfillmentAmount,
    markupBps: check.maxMarkupBps,
    sourceDecimals: source.decimals,
    destinationDecimals: destination.decimals,
  });
  if (BigInt(check.amount) > max) {
    throw new AtumEscrowTrustError({
      code: 'MARKUP_EXCEEDED',
      network: check.sourceNetwork,
      field: check.fields.amount,
      expected: max.toString(),
      actual: check.amount,
      message: `atum-escrow: amount ${check.amount} exceeds the ${check.maxMarkupBps} bps the payer allows over fulfillmentAmount (max ${max})`,
    });
  }
}

function findToken(
  tokens: ReadonlyArray<TrustedToken>,
  network: string,
  asset: string,
  field: string,
): TrustedToken {
  const token = tokens.find((t) => caipEqual(network, t.address, asset));
  if (!token) {
    throw new AtumEscrowTrustError({
      code: 'UNTRUSTED_ASSET',
      network,
      field,
      actual: asset,
      message: `atum-escrow: asset ${asset} is not a token the trust source vouches for on ${network}`,
    });
  }
  return token;
}

export function comparable(
  a: string,
  b: string,
  pegGroups: ReadonlyArray<ReadonlyArray<string>>,
): boolean {
  return a === b || pegGroups.some((group) => group.includes(a) && group.includes(b));
}
