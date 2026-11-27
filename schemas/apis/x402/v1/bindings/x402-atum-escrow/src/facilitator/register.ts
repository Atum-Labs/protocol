/**
 * Wiring helper for the atum-escrow facilitator scheme — the third of the trio
 * (client, server, facilitator all export `registerAtumEscrowScheme` from their
 * subpath). One keyless scheme instance is registered under the `eip155:*` wildcard
 * by default; pass explicit networks to pin it.
 */

import type { Network, SchemeNetworkFacilitator } from '@x402/core/types';
import { AtumEscrowFacilitatorScheme, type AtumEscrowFacilitatorConfig } from './index';

/** All EVM (eip155) networks — the default registration key. */
const EVM_WILDCARD = 'eip155:*' as Network;

/**
 * The subset of `x402Facilitator` this helper drives. Structural so callers stay
 * decoupled and tests can pass a recorder; the chainable `T`-returning `register`
 * (with `Network | Network[]`) matches the real API.
 *
 * @public
 */
export interface AtumEscrowFacilitatorRegistrar {
  register(
    networks: Network | Network[],
    facilitator: SchemeNetworkFacilitator,
  ): AtumEscrowFacilitatorRegistrar;
}

/**
 * Register the atum-escrow scheme onto an `x402Facilitator`.
 *
 * @param facilitator - the facilitator to register onto (returned for chaining)
 * @param config - the facilitator scheme config (the gateway submitter + optional clock)
 * @param networks - networks to register under; defaults to the `eip155:*` wildcard
 * @returns the same `facilitator`, for chaining
 *
 * @example
 * ```ts
 * import { x402Facilitator } from "@x402/core/facilitator";
 * import { registerAtumEscrowScheme } from "@atumlabs/x402-atum-escrow/facilitator";
 *
 * const facilitator = new x402Facilitator();
 * registerAtumEscrowScheme(facilitator, { submitter });
 * ```
 *
 * @public
 */
export function registerAtumEscrowScheme<T extends AtumEscrowFacilitatorRegistrar>(
  facilitator: T,
  config: AtumEscrowFacilitatorConfig,
  networks: Network | Network[] = EVM_WILDCARD,
): T {
  facilitator.register(networks, new AtumEscrowFacilitatorScheme(config));
  return facilitator;
}
