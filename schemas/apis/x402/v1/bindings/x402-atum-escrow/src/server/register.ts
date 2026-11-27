/**
 * Wiring helper for the atum-escrow server scheme.
 *
 * A single {@link AtumEscrowServerScheme} instance is network-agnostic per request
 * (it derives everything from the network argument and its config), so one instance
 * is registered under the `eip155:*` wildcard by default — matching how the stock
 * `exact` scheme registers. Registering under the wildcard is safe: the scheme's own
 * `parsePrice`/`enhancePaymentRequirements` reject any network absent from
 * `config.sources`, so the wildcard never widens what the merchant actually offers
 * (that menu is the `accepts[]` the resource server advertises). Pass explicit
 * `networks` to pin the registration to specific chains instead.
 */

import type { Network, SchemeNetworkServer } from '@x402/core/types';
import { AtumEscrowServerScheme, type AtumEscrowServerConfig } from './index';

/** All EVM (eip155) networks — the default registration key, mirroring `exact`. */
const EVM_WILDCARD = 'eip155:*' as Network;

/**
 * The subset of `x402ResourceServer` this helper drives. Kept structural (rather
 * than importing the concrete class) so callers stay decoupled and tests can pass a
 * lightweight recorder. The chainable `T`-returning `register` matches the real API.
 *
 * @public
 */
export interface AtumEscrowServerRegistrar {
  register(network: Network, server: SchemeNetworkServer): AtumEscrowServerRegistrar;
}

/**
 * Register the atum-escrow scheme onto an `x402ResourceServer`.
 *
 * Construction validates the corridor config (fail-loud at startup), then one shared
 * scheme instance is registered under each network — the `eip155:*` wildcard by
 * default, or the explicit `networks` if given.
 *
 * @param server - the resource server to register onto (returned for chaining)
 * @param config - the corridor config (receive-side, markup, contracts, sources)
 * @param networks - networks to register under; defaults to the `eip155:*` wildcard
 * @returns the same `server`, for chaining
 * @throws {@link AtumEscrowConfigError} if `config` cannot serve payers: `INVALID_CONFIG`
 *   (malformed), `ASSETS_NOT_COMPARABLE` (a source is not the destination's money) or
 *   `CAP_BELOW_PRICE` (a source's cap would be worth less than the fulfillment)
 *
 * @example
 * ```ts
 * import { x402ResourceServer } from "@x402/core/server";
 * import { registerAtumEscrowScheme } from "@atumlabs/x402-atum-escrow/server";
 *
 * const server = new x402ResourceServer(facilitatorClient);
 * registerAtumEscrowScheme(server, {
 *   destination: {
 *     network: "eip155:42161",
 *     asset: "0x…USDC",
 *     address: "0x…merchant",
 *     symbol: "USDC",
 *     decimals: 6,
 *   },
 *   fulfillmentAmount: "10000000",
 *   markupBps: 300,
 *   fulfillmentProxy: "0x…proxy",
 *   reserver: "0x…reserver",
 *   releaser: "0x…releaser",
 *   quoteDeadlineSeconds: 3,
 *   fulfillmentDeadlineSeconds: 300,
 *   sources: {
 *     "eip155:8453": { asset: "0x…baseUSDC", escrow: "0x…baseEscrow", symbol: "USDC", decimals: 6 },
 *   },
 * });
 * ```
 *
 * @public
 */
export function registerAtumEscrowScheme<T extends AtumEscrowServerRegistrar>(
  server: T,
  config: AtumEscrowServerConfig,
  networks: Network[] = [EVM_WILDCARD],
): T {
  const scheme = new AtumEscrowServerScheme(config);
  for (const network of networks) {
    server.register(network, scheme);
  }
  return server;
}
