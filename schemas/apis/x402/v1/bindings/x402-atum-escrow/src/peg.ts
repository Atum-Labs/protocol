// Which tokens count as the same money. The payer refuses to price a cap in one token against a
// fulfillment in another unless they are comparable here; the merchant server applies the same
// rule to the symbols its operator declares, so a corridor whose declared tokens are not the same
// money never boots.

/**
 * Tokens treated as interchangeable 1:1 by default, by the payer client and the merchant server
 * alike: the US-dollar stablecoins on the network's allowlists. The allowlist records only
 * symbol, address and decimals, so this list is the peg assumption itself. A token outside every
 * group is comparable only with itself.
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

/** Whether two token symbols are the same money: equal, or together in one peg group. */
export function comparable(
  a: string,
  b: string,
  pegGroups: ReadonlyArray<ReadonlyArray<string>>,
): boolean {
  return a === b || pegGroups.some((group) => group.includes(a) && group.includes(b));
}
