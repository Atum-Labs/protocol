/**
 * The payer's bound on the spend cap.
 *
 * The cap (`amount`) is the most the escrow may ever pull from the payer. An honest auction
 * charges less, but a thin auction, a compromised quote selector or a bug can charge up to the cap,
 * so the payer refuses a cap further above the price than it allows. The price is
 * `fulfillmentAmount`, in the destination token; the cap is in the source token, so both are
 * compared in one unit, and only between tokens the payer treats as the same money.
 */

import { caipEqual } from '../internal';
import { comparable } from '../peg';
import { MAX_TOKEN_DECIMALS, isTokenDecimals, maxSourceAmount } from '../source-cap';
import { AtumEscrowTrustError, type TrustedToken } from './trust';

/**
 * The markup over `fulfillmentAmount`, in basis points, the client accepts when the payer sets
 * none: room above the 3% the merchant SDK documents, while bounding the payer's extra exposure.
 *
 * @public
 */
export const DEFAULT_MAX_MARKUP_BPS = 500;

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
}

/**
 * Refuse a cap the payer does not accept: either token unknown to the trust source, tokens that
 * are not the same money, or an amount above `fulfillmentAmount` plus the allowed markup.
 */
export function assertCapWithinBound(check: CapCheck): void {
  const source = findToken(check.sourceTokens, check.sourceNetwork, check.sourceAsset);
  const destination = findToken(
    check.destinationTokens,
    check.destinationNetwork,
    check.destinationAsset,
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
      field: 'amount',
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
): TrustedToken {
  const token = tokens.find((t) => caipEqual(network, t.address, asset));
  if (!token) {
    throw new AtumEscrowTrustError({
      code: 'UNTRUSTED_ASSET',
      network,
      field: 'asset',
      actual: asset,
      message: `atum-escrow: asset ${asset} is not a token the trust source vouches for on ${network}`,
    });
  }
  // A payer-supplied resolver's answer is not parsed the way a gateway's is, so its decimals are
  // checked here: a count the arithmetic cannot use prices nothing, and is refused like an unknown
  // token rather than escaping as some other error. They are read once, and the copy returned is
  // the one checked, so a value that changes between reads cannot price the cap.
  const decimals: unknown = token.decimals;
  if (!isTokenDecimals(decimals)) {
    // Describing the value must not throw: an object without a usable toString would replace the
    // refusal with a TypeError.
    const described = typeof decimals === 'number' ? String(decimals) : `a ${typeof decimals}`;
    throw new AtumEscrowTrustError({
      code: 'UNTRUSTED_ASSET',
      network,
      field: 'asset',
      actual: asset,
      message: `atum-escrow: the trust source lists asset ${asset} on ${network} with decimals ${described}, not an integer from 0 to ${MAX_TOKEN_DECIMALS}`,
    });
  }
  return { symbol: token.symbol, address: token.address, decimals };
}
