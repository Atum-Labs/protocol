/**
 * Wiring helper for the atum-escrow client scheme.
 *
 * The client scheme is corridor-agnostic — it reads every corridor detail from
 * `extra.atum` at payment time and checks the addresses against its trust source — so
 * one instance is registered under the `eip155:*` wildcard by default (matching the
 * stock `exact` client), answering a 402 on any EVM source network it is offered. Pass explicit `networks` to restrict the source
 * chains this payer will fund from.
 */

import type { Network, SchemeNetworkClient } from '@x402/core/types';
import { AtumEscrowClientScheme, type AtumEscrowClientConfig } from './index';

/** All EVM (eip155) networks — the default registration key, mirroring `exact`. */
const EVM_WILDCARD = 'eip155:*' as Network;

/**
 * The subset of `x402Client` this helper drives. Structural (not the concrete
 * class) so callers stay decoupled and tests can pass a recorder; the chainable
 * `T`-returning `register` matches the real API.
 *
 * @public
 */
export interface AtumEscrowClientRegistrar {
  register(network: Network, client: SchemeNetworkClient): AtumEscrowClientRegistrar;
}

/**
 * Registration input: the client scheme config plus optional source networks.
 *
 * @public
 */
export interface AtumEscrowClientRegistration extends AtumEscrowClientConfig {
  /** Source CAIP-2 networks to answer for; defaults to the `eip155:*` wildcard. */
  networks?: Network[];
}

/**
 * Register the atum-escrow scheme onto an `x402Client`.
 *
 * One shared, corridor-agnostic scheme instance is registered under each network —
 * the `eip155:*` wildcard by default, or the explicit `networks` if given.
 *
 * @param client - the client to register onto (returned for chaining)
 * @param registration - the signer/clock config plus optional `networks`
 * @returns the same `client`, for chaining
 *
 * @example
 * ```ts
 * import { ethers } from "ethers";
 * import { x402Client } from "@x402/core/client";
 * import { registerAtumEscrowScheme } from "@atumlabs/x402-atum-escrow/client";
 *
 * const client = new x402Client();
 * registerAtumEscrowScheme(client, { signer: new ethers.Wallet(PRIVATE_KEY) });
 * ```
 *
 * @public
 */
export function registerAtumEscrowScheme<T extends AtumEscrowClientRegistrar>(
  client: T,
  registration: AtumEscrowClientRegistration,
): T {
  const { networks = [EVM_WILDCARD], ...config } = registration;
  const scheme = new AtumEscrowClientScheme(config);
  for (const network of networks) {
    client.register(network, scheme);
  }
  return client;
}
